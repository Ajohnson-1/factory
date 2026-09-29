import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export interface Worktree {
  dir: string;
  /**
   * The branch the worktree is checked out on, and the thing a caller commits
   * to and merges back. A child's branch is always `factory/<card>-<run>`;
   * `childBranchFor` explains why it can never be `factory/<card>/<run>`.
   */
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

  reclaimWorktree(repoPath, dir);
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

/* -------------------------------------------------------------------------- *
 * Phase 2.2 — one worktree per parallel child agent, merged back on the host.
 * -------------------------------------------------------------------------- */

/**
 * Drop a worktree directory that may or may not still be registered with git,
 * so `worktree add` can reuse the path (a killed run leaves both behind).
 */
function reclaimWorktree(repoPath: string, dir: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    git(repoPath, ["worktree", "remove", "--force", dir]);
  } catch {
    // Registered worktree is gone (stale dir on disk): drop it and forget the
    // git metadata so `worktree add` can reuse the path.
    fs.rmSync(dir, { recursive: true, force: true });
    git(repoPath, ["worktree", "prune"]);
  }
}

/**
 * A child agent's branch: `factory/<card>-<runId>`.
 *
 * `plan/2.2-agent-graph.md` specified `factory/<card>/c<n>`, and git cannot do
 * that: refs are files in a directory tree, so `refs/heads/factory/<card>` (the
 * card branch the PR ships from) and `refs/heads/factory/<card>/c1` can never
 * both exist — verified both ways, each is rejected with "cannot lock ref ...
 * exists; cannot create ...". The card branch is the immovable one, so children
 * take a sibling name instead, deliberately the same shape as the worktree
 * directory (`wt-<card>-<runId>`) so one run is recognisable in `git branch`,
 * `docker ps` and the Discord timeline.
 *
 * Ambiguity would need a card id containing a dash (Trello ids are alphanumeric)
 * or a run id that reproduces another card's suffix; run ids are minted here as
 * `c<n>`, so neither can happen while ids stay in that shape.
 */
export function childBranchFor(cardId: string, runId: string): string {
  return `factory/${childWorktreeId(cardId, runId)}`;
}

/** Worktree id that makes `worktreeDir()` yield `wt-<card>-<runId>`. */
export function childWorktreeId(cardId: string, runId: string): string {
  return `${cardId}-${runId}`;
}

/**
 * Fork a child agent's worktree from the base worktree's *current* HEAD — not
 * from origin/main: by the time a child starts, earlier children may already
 * have been merged into the card branch, and a child that forked from main
 * would merge as a conflict on everything they wrote.
 *
 * A missing base worktree throws: there is nothing sensible to fork from and a
 * silent `origin/main` base is exactly the bug this guards against.
 */
export function createChildWorktree(
  cardId: string,
  runId: string,
  repoPath: string = config.factory.repoPath()
): Worktree {
  const baseDir = worktreeDir(cardId, repoPath);
  if (!fs.existsSync(path.join(baseDir, ".git"))) {
    throw new Error(`no base worktree for card ${cardId} at ${baseDir}`);
  }
  const base = headCommit(baseDir);
  const dir = worktreeDir(childWorktreeId(cardId, runId), repoPath);
  const branch = childBranchFor(cardId, runId);

  reclaimWorktree(repoPath, dir);

  // `-B` (not `-b`): a branch left behind by a killed run is reset to the base
  // HEAD instead of making the re-trigger fail forever. The child works on its
  // own branch, which is what the caller commits to and merges back.
  git(repoPath, ["worktree", "add", "-B", branch, dir, base]);
  return { dir, branch };
}

/** Current commit of a worktree (or clone). */
export function headCommit(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

/** Files a worktree changed since it forked from `baseRef`. Empty when it changed nothing. */
export function changedFiles(dir: string, baseRef: string): string[] {
  const out = execFileSync("git", ["-C", dir, "diff", "--name-only", `${baseRef}...HEAD`], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

/**
 * `git diff --stat baseRef...HEAD` — the human-readable size of a child's work,
 * which is what the orchestrator gets back so it can judge a run by more than
 * "it said it finished".
 */
export function diffStat(dir: string, baseRef: string): string {
  return execFileSync("git", ["-C", dir, "diff", "--stat", `${baseRef}...HEAD`], {
    encoding: "utf8",
  }).trim();
}

/**
 * How many lines a file has *as of this worktree's HEAD*, or null when HEAD has no
 * such file.
 *
 * This exists to answer one question about a review comment: can it go there? A
 * line number past the end of the file, or a comment on a file the reviewed commit
 * deleted, is accepted by GitHub's API and then points at nothing, permanently, in
 * a bot's name — so the only check worth having is against the commit that is
 * actually checked out. Reading it out of git rather than off the disk is what
 * makes that the same content the reviewer saw, not whatever else is in the
 * directory.
 *
 * A trailing newline is not its own line, and an empty file has no lines to point
 * at; both are off-by-one errors a reader would find in the resulting comment.
 */
export function fileLineCount(dir: string, file: string): number | null {
  let content: string;
  try {
    content = execFileSync("git", ["-C", dir, "show", `HEAD:${file}`], {
      encoding: "utf8",
      // A "not in this commit" answer is the expected result for a deleted file, and
      // git prints one to stderr every time. Silencing it keeps a normal review from
      // looking like a failing command in the orchestrator's log.
      stdio: ["ignore", "pipe", "ignore"],
      // A reviewed repo can hold a generated file; the cap is here so one cannot
      // turn a review into an out-of-memory on the orchestrator.
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    // Not in the tree, or a path git will not resolve from inside the worktree.
    return null;
  }
  if (content.length === 0) return 0;
  const parts = content.split(/\r?\n/);
  return content.endsWith("\n") ? parts.length - 1 : parts.length;
}

export type MergeResult =
  | { ok: true; commit: string }
  | { ok: false; conflict: true; files: string[]; output: string };

/** Is a merge in progress in this worktree? (`MERGE_HEAD` is what makes one so.) */
function mergeInProgress(dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "MERGE_HEAD"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Paths git left unmerged by a conflicted merge, read before the abort. */
function conflictedFiles(dir: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["-C", dir, "diff", "--name-only", "--diff-filter=U"],
      { encoding: "utf8" }
    );
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Undo a failed merge completely: the next child has to merge into a base
 * worktree that looks untouched, and a leftover `MERGE_HEAD` would make every
 * later merge fail with "you have not concluded your merge".
 */
function abortMerge(dir: string): void {
  try {
    execFileSync("git", ["-C", dir, "merge", "--abort"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // nothing to abort, or abort itself failed — the guard below covers both
  }
  if (mergeInProgress(dir)) {
    try {
      execFileSync("git", ["-C", dir, "reset", "--hard"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      // best effort
    }
  }
}

/** git's own error message, from either stream. */
function commandOutput(err: unknown): string {
  const e = err as { stdout?: unknown; stderr?: unknown };
  const text = (v: unknown): string =>
    typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : "";
  return [text(e.stderr), text(e.stdout)]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Merge a child's branch into the base worktree, on the host (the child
 * container's `.git` is read-only).
 *
 * A conflict is a *result*, not an exception: the caller is the `spawn_agent`
 * tool, which hands the conflict back to the orchestrator agent to re-plan. The
 * base worktree is left exactly as it was found — clean, original HEAD, no
 * `MERGE_HEAD` — so the next child merges into an untouched base.
 *
 * Callers serialise merges; this holds no state of its own.
 */
export function mergeChildIntoBase(
  baseDir: string,
  childBranch: string,
  message: string
): MergeResult {
  try {
    execFileSync(
      "git",
      ["-C", baseDir, "merge", "--no-ff", "-m", message, childBranch],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    return { ok: true, commit: headCommit(baseDir) };
  } catch (err) {
    // Read the conflict before the abort wipes it.
    const files = conflictedFiles(baseDir);
    const output = commandOutput(err);
    abortMerge(baseDir);
    return { ok: false, conflict: true, files, output };
  }
}

/** Force-delete a local branch. Throws if git refuses; callers that cannot care catch. */
export function deleteBranch(dir: string, branch: string): void {
  git(dir, ["branch", "-D", branch]);
}

/**
 * Clean up after a child agent: worktree and branch go together, because a
 * worktree whose branch is still around is what makes the next run on the same
 * id look half-finished. Best effort, like `removeWorktree` — a killed run must
 * not turn cleanup into a second failure.
 */
export function removeChildWorktree(
  cardId: string,
  runId: string,
  repoPath: string = config.factory.repoPath()
): void {
  const dir = worktreeDir(childWorktreeId(cardId, runId), repoPath);
  try {
    git(repoPath, ["worktree", "remove", "--force", dir]);
  } catch {
    // best effort
  }
  try {
    deleteBranch(repoPath, childBranchFor(cardId, runId));
  } catch {
    // best effort: nothing to delete
  }
}

/** Push the card branch to origin from inside a worktree. */
export function pushBranch(dir: string, branch: string): void {
  execFileSync("git", ["-C", dir, "push", "-u", "origin", branch], {
    stdio: "inherit",
  });
}

/* -------------------------------------------------------------------------- *
 * Phase 2.3 — a detached checkout of a PR head, for the reviewer.
 * -------------------------------------------------------------------------- */

/**
 * A review checkout: a directory and the exact commit it is sitting on.
 *
 * Deliberately not a `Worktree`. That type's `branch` is a required string and a
 * detached checkout has no branch; inventing a sentinel name for it would be a
 * lie that something like `deleteBranch` could later act on. A review owns no
 * ref: the reviewer cannot commit (`.git` is mounted read-only in its container),
 * and nothing is ever merged from here.
 */
export interface ReviewWorktree {
  dir: string;
  head: string;
}

/** A PR head SHA is a sha, and it becomes a path segment, so nothing else will do. */
const SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Shorten a SHA for a name, defensively.
 *
 * Every caller checks the shape first, but this value arrives from a webhook
 * payload and ends up inside a directory name, and a `..` there is not a failure
 * mode worth discovering in production.
 */
function shortSha(headSha: string): string {
  if (!SHA.test(headSha)) throw new Error(`not a commit sha: ${headSha}`);
  return headSha.slice(0, 7);
}

/** Worktree id for a review — `wt-<card>-r<sha7>`, the `r` marking what it is. */
export function reviewWorktreeId(cardId: string, headSha: string): string {
  return `${cardId}-r${shortSha(headSha)}`;
}

/** Is this commit already in the object store? */
function hasCommit(repoPath: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", repoPath, "cat-file", "-e", `${sha}^{commit}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check a PR head out, detached, at exactly `headSha`.
 *
 * The SHA is the one the webhook named and the one the dedupe row is keyed on, so
 * this checks out *that commit* rather than "the PR": an author can push again
 * between the event and the container starting, and a review posted against lines
 * nobody reviewed is worse than no review.
 *
 * `refs/pull/<n>/head` is how a PR head comes in from the base repo even after the
 * head branch is deleted or force-pushed — GitHub advertises it for every PR. A
 * fixture repo has no such ref, so a SHA that is already local (every test, and a
 * re-review of a head) skips the fetch. If the commit is neither local nor
 * fetchable this throws: the alternative is checking out something *near* the
 * requested SHA and labelling the review with a commit it never saw.
 */
export function createReviewWorktree(
  cardId: string,
  prNumber: number,
  headSha: string,
  repoPath: string = config.factory.repoPath()
): ReviewWorktree {
  shortSha(headSha); // validate before any of it reaches a path or an argv
  const dir = worktreeDir(reviewWorktreeId(cardId, headSha), repoPath);

  if (!hasCommit(repoPath, headSha)) {
    try {
      git(repoPath, ["fetch", "origin", `refs/pull/${prNumber}/head`]);
    } catch {
      // A fetch can fail for reasons nothing here can act on; the check below
      // turns it into the precise complaint, so nothing is silently swallowed.
    }
  }
  if (!hasCommit(repoPath, headSha)) {
    throw new Error(
      `commit ${headSha} is not available locally and did not arrive with PR #${prNumber}'s head`
    );
  }

  reclaimWorktree(repoPath, dir);
  git(repoPath, ["worktree", "add", "--detach", dir, headSha]);
  return { dir, head: headSha };
}

/**
 * Drop a review worktree. No branch to delete and nothing to merge: this is the
 * cleanup half of a disposable checkout, and it runs from a `finally`.
 */
export function removeReviewWorktree(
  cardId: string,
  headSha: string,
  repoPath: string = config.factory.repoPath()
): void {
  const dir = worktreeDir(reviewWorktreeId(cardId, headSha), repoPath);
  try {
    git(repoPath, ["worktree", "remove", "--force", dir]);
  } catch {
    // Same best-effort rule as `removeChildWorktree` — a review that failed must
    // not fail a second time on cleanup — but the directory is still removed,
    // because a leaked checkout under the repo root is what an operator trips on.
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      git(repoPath, ["worktree", "prune"]);
    } catch {
      // best effort
    }
  }
}
