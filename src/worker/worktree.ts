import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface Worktree {
  dir: string;
  branch: string;
}

/** git without a shell: card ids come from Trello and must never be interpolated. */
function git(repoPath: string, args: string[]): void {
  execFileSync("git", ["-C", repoPath, ...args], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

export function branchFor(cardId: string): string {
  return `factory/${cardId}`;
}

/** Worktrees sit next to the repo: `<dirname(repoPath)>/wt-<cardId>`. */
export function worktreeDir(
  cardId: string,
  repoPath: string = config.factory.repoPath()
): string {
  return path.join(path.dirname(repoPath), `wt-${cardId}`);
}

/** Create a git worktree for a card. Returns the worktree dir + branch. */
export function createWorktree(
  cardId: string,
  repoPath: string = config.factory.repoPath()
): Worktree {
  const branch = branchFor(cardId);
  const dir = worktreeDir(cardId, repoPath);

  if (fs.existsSync(dir)) {
    try {
      git(repoPath, ["worktree", "remove", "--force", dir]);
    } catch {
      // Registered worktree is gone (stale dir on disk): drop it and forget the
      // git metadata so `worktree add` can reuse the path.
      fs.rmSync(dir, { recursive: true, force: true });
      git(repoPath, ["worktree", "prune"]);
    }
  }
  git(repoPath, ["fetch", "origin", "main"]);
  // `-B` (not `-b`): a branch left behind by a killed run is reset to origin/main
  // instead of making the re-trigger fail forever.
  git(repoPath, ["worktree", "add", "-B", branch, dir, "origin/main"]);
  return { dir, branch };
}

export function removeWorktree(
  cardId: string,
  repoPath: string = config.factory.repoPath()
): void {
  const dir = worktreeDir(cardId, repoPath);
  try {
    git(repoPath, ["worktree", "remove", "--force", dir]);
    git(repoPath, ["branch", "-D", branchFor(cardId)]);
  } catch {
    // best effort
  }
}

/**
 * Absolute path of the shared `.git` a worktree links back to.
 *
 * A worktree directory holds a `.git` *file* that points into the main repo, so
 * this is what has to accompany the worktree into the agent container — on its
 * own, `git status` inside the container reports "not a git repository".
 */
export function commonGitDir(dir: string): string {
  const out = execFileSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  return path.isAbsolute(out) ? out : path.resolve(dir, out);
}

/**
 * Commit everything the agent changed, from the host. The container mounts
 * `.git` read-only, so committing there is not possible and never will be: the
 * agent edits files, the factory turns that into a commit.
 *
 * `:(exclude)` keeps `.env` out even if a worktree somehow has one — an
 * untracked secret must not ride into a public PR. Returns false when the agent
 * changed nothing (an empty PR is not a result).
 */
export function commitWork(dir: string, message: string): boolean {
  const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], {
    encoding: "utf8",
  });
  if (!status.trim()) return false;
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "add",
      "-A",
      "--",
      ".",
      ":(exclude).env",
      ":(exclude).env.*",
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  execFileSync("git", ["-C", dir, "commit", "-m", message], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return true;
}

/** Push the card branch to origin from inside a worktree. */
export function pushBranch(dir: string, branch: string): void {
  execFileSync("git", ["-C", dir, "push", "-u", "origin", branch], {
    stdio: "inherit",
  });
}
