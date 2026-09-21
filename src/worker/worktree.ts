import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface Worktree {
  dir: string;
  branch: string;
}

/** Create a git worktree for a card. Returns the worktree dir + branch. */
export function createWorktree(cardId: string): Worktree {
  const repoPath = config.factory.repoPath();
  const branch = `factory/${cardId}`;
  const dir = path.join(path.dirname(repoPath), `wt-${cardId}`);

  if (fs.existsSync(dir)) {
    execSync(`git -C ${repoPath} worktree remove --force ${dir}`);
  }
  execSync(
    `git -C ${repoPath} fetch origin main && ` +
      `git -C ${repoPath} worktree add -b ${branch} ${dir} origin/main`
  );
  return { dir, branch };
}

export function removeWorktree(cardId: string): void {
  const repoPath = config.factory.repoPath();
  const dir = path.join(path.dirname(repoPath), `wt-${cardId}`);
  try {
    execSync(`git -C ${repoPath} worktree remove --force ${dir}`);
    execSync(`git -C ${repoPath} branch -D ${branchFor(cardId)}`);
  } catch {
    // best effort
  }
}

function branchFor(cardId: string): string {
  return `factory/${cardId}`;
}
