import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, removeTempDir } from "./tmp.js";

export interface GitRepoFixture {
  /** Temp dir that holds the clone, the bare remote and any worktrees. */
  root: string;
  /** Working clone — the equivalent of `REPO_PATH`. */
  repoPath: string;
  /** Bare `origin` the clone pushes to. */
  originPath: string;
  cleanup(): void;
}

function git(args: string[], cwd?: string): string {
  return execFileSync(
    "git",
    [
      ...(cwd ? ["-C", cwd] : []),
      "-c",
      "user.email=factory@test.local",
      "-c",
      "user.name=factory-test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" }
  );
}

/** `git init -b main` needs git >= 2.28; this works on older clients too. */
function initOnMain(dir: string, bare: boolean): void {
  git(["init", ...(bare ? ["--bare"] : []), dir]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], dir);
}

/**
 * Bare `origin.git` + a clone on `main` with one commit, both in a temp dir.
 * Shared by anything that touches real git (worktree, runner, reviewer).
 */
export function makeGitRepo(): GitRepoFixture {
  const root = makeTempDir("factory-git-");
  const originPath = path.join(root, "origin.git");
  const repoPath = path.join(root, "repo");

  initOnMain(originPath, true);
  initOnMain(repoPath, false);
  git(["config", "receive.denyCurrentBranch", "updateNever"], repoPath);

  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  fs.writeFileSync(path.join(repoPath, "src", "index.js"), "// entry\n");
  git(["add", "-A"], repoPath);
  git(["commit", "-m", "init"], repoPath);
  git(["remote", "add", "origin", originPath], repoPath);
  git(["push", "-u", "origin", "main"], repoPath);

  return { root, repoPath, originPath, cleanup: () => removeTempDir(root) };
}

/** Branch names that exist on the bare remote (used to assert push/branch effects). */
export function remoteBranches(fixture: GitRepoFixture): string[] {
  return git(["ls-remote", "--heads", "origin"], fixture.repoPath)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]?.trim() ?? "")
    .filter(Boolean);
}

/** `git log --oneline` for a directory (worktree or clone). */
export function log(dir: string): string {
  return git(["log", "--oneline"], dir);
}
