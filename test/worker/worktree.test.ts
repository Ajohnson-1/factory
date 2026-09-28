import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  branchFor,
  commonGitDir,
  commitWork,
  createWorktree,
  pushBranch,
  removeWorktree,
  worktreeDir,
  type Worktree,
} from "../../src/worker/worktree.js";
import {
  makeGitRepo,
  log,
  remoteBranches,
  type GitRepoFixture,
} from "../helpers/git.js";

const CARD = "card-1";

let fixture: GitRepoFixture;

/** git without a shell, for assertions only. */
function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  fixture = makeGitRepo();
});

afterEach(() => {
  fixture.cleanup();
});

describe("createWorktree", () => {
  it("creates the worktree next to the repo on a factory/<id> branch", () => {
    const wt = createWorktree(CARD, fixture.repoPath);

    expect(wt.branch).toBe(`factory/${CARD}`);
    expect(wt.dir).toBe(path.join(fixture.root, `wt-${CARD}`));
    expect(fs.existsSync(wt.dir)).toBe(true);
    // it is a real worktree of the clone, checked out on the card branch
    expect(gitOut(wt.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`factory/${CARD}`);
  });

  it("starts the worktree at origin/main", () => {
    const wt = createWorktree(CARD, fixture.repoPath);

    expect(gitOut(wt.dir, "rev-parse", "HEAD")).toBe(
      gitOut(fixture.repoPath, "rev-parse", "origin/main")
    );
    expect(log(wt.dir)).toContain("init");
  });

  it("can be created again for the same card after the worktree was removed", () => {
    const first = createWorktree(CARD, fixture.repoPath);
    // the agent's leftovers: a modified tracked file + an untracked file
    fs.writeFileSync(path.join(first.dir, "README.md"), "# vandalised\n");
    fs.writeFileSync(path.join(first.dir, "scratch.txt"), "agent scratch\n");
    removeWorktree(CARD, fixture.repoPath);

    const second = createWorktree(CARD, fixture.repoPath);

    expect(second.dir).toBe(first.dir);
    expect(fs.existsSync(path.join(second.dir, "scratch.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(second.dir, "README.md"), "utf8")).toBe(
      "# fixture\n"
    );
    expect(gitOut(second.dir, "rev-parse", "HEAD")).toBe(
      gitOut(fixture.repoPath, "rev-parse", "origin/main")
    );
  });

  it("resets a stale branch left behind by an interrupted run", () => {
    const first = createWorktree(CARD, fixture.repoPath);
    // what a killed run leaves behind: a committed-but-never-PR'd change on the
    // card branch, plus an untracked file in the worktree
    fs.writeFileSync(path.join(first.dir, "README.md"), "# half done\n");
    fs.writeFileSync(path.join(first.dir, "scratch.txt"), "agent scratch\n");
    gitOut(first.dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    gitOut(first.dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "half done");
    const staleSha = gitOut(first.dir, "rev-parse", "HEAD");

    const second = createWorktree(CARD, fixture.repoPath);

    expect(second.dir).toBe(first.dir);
    expect(staleSha).not.toBe(gitOut(fixture.repoPath, "rev-parse", "origin/main"));
    // the card re-triggers from a clean base instead of failing on a taken branch name
    expect(gitOut(second.dir, "rev-parse", "HEAD")).toBe(
      gitOut(fixture.repoPath, "rev-parse", "origin/main")
    );
    expect(fs.readFileSync(path.join(second.dir, "README.md"), "utf8")).toBe(
      "# fixture\n"
    );
    expect(fs.existsSync(path.join(second.dir, "scratch.txt"))).toBe(false);
  });

  it("recreates a worktree over a stale directory git does not know about", () => {
    const dir = worktreeDir(CARD, fixture.repoPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "leftover.txt"), "not a worktree\n");

    const wt = createWorktree(CARD, fixture.repoPath);

    expect(wt.dir).toBe(dir);
    expect(fs.existsSync(path.join(wt.dir, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(wt.dir, "leftover.txt"))).toBe(false);
    expect(gitOut(wt.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`factory/${CARD}`);
  });
});

describe("removeWorktree", () => {
  it("deletes the worktree directory and the local branch", () => {
    const wt = createWorktree(CARD, fixture.repoPath);
    expect(fs.existsSync(wt.dir)).toBe(true);

    removeWorktree(CARD, fixture.repoPath);

    expect(fs.existsSync(wt.dir)).toBe(false);
    expect(gitOut(fixture.repoPath, "branch", "--list", `factory/${CARD}`)).toBe("");
  });

  it("is a no-op when there is no worktree for the card", () => {
    expect(() => removeWorktree("never-created", fixture.repoPath)).not.toThrow();
  });
});

describe("pushBranch", () => {
  it("pushes the card branch to the origin remote", () => {
    const wt = createWorktree(CARD, fixture.repoPath);

    pushBranch(wt.dir, wt.branch);

    expect(remoteBranches(fixture)).toContain(`refs/heads/factory/${CARD}`);
  });
});

describe("commonGitDir", () => {
  it("resolves a linked worktree to the repo's shared .git", () => {
    const wt = createWorktree(CARD, fixture.repoPath);

    // absolute, and inside the repo — this is the path the agent container
    // mounts read-only so `git log` works at all
    const dir = commonGitDir(wt.dir);
    expect(path.isAbsolute(dir)).toBe(true);
    expect(fs.realpathSync(dir)).toBe(fs.realpathSync(path.join(fixture.repoPath, ".git")));
  });

  it("resolves the plain .git of the main clone itself", () => {
    expect(fs.realpathSync(commonGitDir(fixture.repoPath))).toBe(
      fs.realpathSync(path.join(fixture.repoPath, ".git"))
    );
  });
});

describe("commitWork", () => {
  it("commits what the agent left in the working tree", () => {
    const wt = createWorktree(CARD, fixture.repoPath);
    fs.writeFileSync(path.join(wt.dir, "src", "greet.js"), "module.exports = () => 1;\n");
    fs.appendFileSync(path.join(wt.dir, "README.md"), "\nchanged\n");

    expect(commitWork(wt.dir, `factory: ${CARD}`)).toBe(true);

    expect(gitOut(wt.dir, "log", "-1", "--pretty=%s")).toBe(`factory: ${CARD}`);
    expect(gitOut(wt.dir, "status", "--porcelain")).toBe("");
    expect(gitOut(wt.dir, "show", "--name-only", "--pretty=").split("\n").sort()).toEqual([
      "README.md",
      "src/greet.js",
    ]);
  });

  it("reports nothing to ship when the agent changed nothing", () => {
    const wt = createWorktree(CARD, fixture.repoPath);

    expect(commitWork(wt.dir, "factory: nope")).toBe(false);
    // still sitting on the untouched origin/main commit
    expect(gitOut(wt.dir, "status", "--porcelain")).toBe("");
  });

  it("never stages a .env the agent created", () => {
    const wt = createWorktree(CARD, fixture.repoPath);
    fs.writeFileSync(path.join(wt.dir, "real.js"), "// work\n");
    fs.writeFileSync(path.join(wt.dir, ".env"), "TRELLO_API_KEY=oops\n");
    fs.writeFileSync(path.join(wt.dir, ".env.local"), "TOKEN=oops\n");

    expect(commitWork(wt.dir, `factory: ${CARD}`)).toBe(true);

    const files = gitOut(wt.dir, "show", "--name-only", "--pretty=");
    expect(files).toContain("real.js");
    expect(files).not.toContain(".env");
    expect(gitOut(wt.dir, "ls-files")).not.toContain(".env");
    expect(gitOut(wt.dir, "ls-files")).not.toContain(".env.local");
    // and it is still on disk, just not in the commit
    expect(fs.existsSync(path.join(wt.dir, ".env"))).toBe(true);
  });

  it("pushes what it committed, end to end", () => {
    const wt = createWorktree(CARD, fixture.repoPath);
    fs.writeFileSync(path.join(wt.dir, "feature.js"), "// feature\n");

    commitWork(wt.dir, `factory: ${CARD}`);
    pushBranch(wt.dir, wt.branch);

    expect(remoteBranches(fixture)).toContain(`refs/heads/factory/${CARD}`);
    expect(gitOut(fixture.originPath, "log", "-1", "--pretty=%s", `factory/${CARD}`)).toBe(
      `factory: ${CARD}`
    );
  });
});

describe("security: card ids are never handed to a shell", () => {
  // Regression guard. The old implementation used execSync with an interpolated
  // command string, so a Trello card id could run arbitrary commands. The proof
  // is a sentinel file: `$(touch pwned)` only appears if a shell evaluated it.
  const SENTINEL = "pwned";

  function sentinelExists(): boolean {
    return (
      fs.existsSync(path.join(fixture.root, SENTINEL)) ||
      fs.existsSync(path.resolve(process.cwd(), SENTINEL))
    );
  }

  it("does not run a command substitution in a card id", () => {
    let wt: Worktree | undefined;
    try {
      wt = createWorktree(`x$(touch ${SENTINEL})`, fixture.repoPath);
    } catch {
      // git rejects the refname (space/`$` are not valid): an honest failure
    }

    expect(sentinelExists()).toBe(false);
    if (wt) expect(wt.branch).toBe(`factory/x$(touch ${SENTINEL})`);
  });

  it("does not treat a semicolon in a card id as a command separator", () => {
    let wt: Worktree | undefined;
    try {
      wt = createWorktree("a;b", fixture.repoPath);
    } catch {
      // also acceptable
    }

    expect(sentinelExists()).toBe(false);
    if (wt) {
      // `;` is a legal git refname character: the id is used literally
      expect(wt.branch).toBe("factory/a;b");
      expect(wt.dir).toBe(path.join(fixture.root, "wt-a;b"));
    }
  });

  it("does not let a card id delete files through removeWorktree", () => {
    const canary = path.join(fixture.root, "canary.txt");
    fs.writeFileSync(canary, "keep me\n");

    try {
      createWorktree(`x;rm -rf ${fixture.root}`, fixture.repoPath);
    } catch {
      // git rejects the refname
    }
    removeWorktree(`x;rm -rf ${fixture.root}`, fixture.repoPath);

    expect(fs.existsSync(canary)).toBe(true);
    expect(sentinelExists()).toBe(false);
  });
});

describe("branchFor", () => {
  it("namespaces the card id under factory/", () => {
    expect(branchFor("abc")).toBe("factory/abc");
  });
});
