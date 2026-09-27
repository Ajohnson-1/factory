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

/** Push the card branch to origin from inside a worktree. */
export function pushBranch(dir: string, branch: string): void {
  execFileSync("git", ["-C", dir, "push", "-u", "origin", branch], {
    stdio: "inherit",
  });
}
