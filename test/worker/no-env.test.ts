/**
 * The `.env` regression guards for the container boundary (phase 2.1).
 *
 * Two things have to stay true for isolation to mean anything:
 *   1. `git worktree add` must not drag the repo's untracked `.env` along —
 *      untracked files are not part of a worktree. If that ever changes, every
 *      agent gets the orchestrator's secrets for free.
 *   2. The mounts we hand the container must not include the directory that
 *      holds that `.env`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  commonGitDir,
  createWorktree,
  worktreeDir,
  type Worktree,
} from "../../src/worker/worktree.js";
import { buildContainerMounts } from "../../src/agent/container.js";
import { makeGitRepo, type GitRepoFixture } from "../helpers/git.js";

const CARD = "card-1";
const CANARY = "TRELLO_API_KEY=canary-must-not-reach-the-agent";

let fixture: GitRepoFixture;
let envPath: string;
let wt: Worktree;

/** Is `maybeAncestor` a directory containing `target`? */
function contains(maybeAncestor: string, target: string): boolean {
  const rel = path.relative(path.resolve(maybeAncestor), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

beforeEach(() => {
  fixture = makeGitRepo();
  // what an operator actually has sitting in the clone: a gitignored .env
  envPath = path.join(fixture.repoPath, ".env");
  fs.writeFileSync(envPath, `${CANARY}\n`);
  wt = createWorktree(CARD, fixture.repoPath);
});

afterEach(() => {
  fixture.cleanup();
});

describe("worktree creation", () => {
  it("leaves the repo's untracked .env behind", () => {
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.existsSync(path.join(wt.dir, ".env"))).toBe(false);
    expect(fs.readdirSync(wt.dir)).not.toContain(".env");
  });

  it("leaves every other untracked file behind too", () => {
    fs.writeFileSync(path.join(fixture.repoPath, "notes.txt"), "scratch");
    fs.writeFileSync(path.join(fixture.repoPath, ".env.production"), CANARY);

    const second = createWorktree("card-2", fixture.repoPath);

    expect(fs.readdirSync(second.dir)).not.toContain("notes.txt");
    expect(fs.readdirSync(second.dir)).not.toContain(".env.production");
  });

  it("only sees .env in git as an untracked file of the main clone", () => {
    const tracked = execFileSync("git", ["-C", fixture.repoPath, "ls-files"], {
      encoding: "utf8",
    });
    const inWorktree = execFileSync("git", ["-C", wt.dir, "ls-files"], {
      encoding: "utf8",
    });

    expect(tracked).not.toContain(".env");
    expect(inWorktree).not.toContain(".env");
  });

  it("does contain a .env that was committed — repo contents are not the secret", () => {
    // Documented limit: phase 2.1 protects the orchestrator's credentials. A
    // secret committed to the target repo ships with it, in the worktree and in
    // the container, and no mount choice can change that.
    fs.writeFileSync(path.join(fixture.repoPath, "config.env"), "tracked=1\n");
    execFileSync("git", ["-C", fixture.repoPath, "add", "config.env"]);
    execFileSync(
      "git",
      ["-C", fixture.repoPath, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "add config"],
      { encoding: "utf8" }
    );
    execFileSync("git", ["-C", fixture.repoPath, "push", "-q", "origin", "main"]);

    const second = createWorktree("card-3", fixture.repoPath);

    expect(fs.existsSync(path.join(second.dir, "config.env"))).toBe(true);
  });
});

describe("container mounts", () => {
  it("resolves the worktree's git pointer to the shared .git", () => {
    const gitDir = commonGitDir(wt.dir);

    // .git inside a worktree is a file, so the agent needs this to have git at all
    expect(fs.readFileSync(path.join(wt.dir, ".git"), "utf8")).toContain("gitdir:");
    expect(gitDir).toBe(fs.realpathSync(path.join(fixture.repoPath, ".git")));
  });

  it("exposes the worktree and the shared .git, and nothing that holds .env", () => {
    const mounts = buildContainerMounts(wt.dir, commonGitDir(wt.dir));

    expect(mounts.map((m) => m.source)).toEqual([wt.dir, commonGitDir(wt.dir)]);
    for (const mount of mounts) {
      expect(contains(mount.source, envPath)).toBe(false);
      expect(contains(fs.realpathSync(mount.source), fs.realpathSync(envPath))).toBe(false);
    }
  });

  it("mounts the .git read-only so an agent cannot rewrite the repo", () => {
    const mounts = buildContainerMounts(wt.dir, commonGitDir(wt.dir));

    expect(mounts.find((m) => m.source === commonGitDir(wt.dir))?.readOnly).toBe(true);
    expect(mounts.find((m) => m.source === wt.dir)?.readOnly).toBeUndefined();
  });

  it("keeps the worktree next to the repo, not inside it", () => {
    // a worktree inside REPO_PATH would ride along in a parent-directory mount
    expect(wt.dir).toBe(worktreeDir(CARD, fixture.repoPath));
    expect(contains(fixture.repoPath, wt.dir)).toBe(false);
  });
});
