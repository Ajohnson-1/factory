/**
 * The reviewer's disposable checkout (phase 2.3, step 2's git half).
 *
 * Real git in a temp directory, per the house style — `git worktree add --detach`
 * is exactly the kind of thing a fake gets wrong: whether the checkout is
 * detached, whether it sits on the right commit, and whether a leaked directory
 * blocks the next review are all properties of git's own state on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createReviewWorktree,
  fileLineCount,
  headCommit,
  removeReviewWorktree,
  reviewWorktreeId,
  worktreeDir,
} from "../../src/worker/worktree.js";
import { makeGitRepo, type GitRepoFixture } from "../helpers/git.js";

const CARD = "card-1";
const PR = 7;

let fixture: GitRepoFixture;
let baseSha: string;
let headSha: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** `rev-parse --verify` exits 1 on a missing ref, which `execFileSync` throws on. */
function refExists(ref: string, cwd = fixture.repoPath): boolean {
  try {
    git(cwd, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

/** Commit in the clone the way a coder's work reaches the host: files, then a commit. */
function commitIn(dir: string, message: string): string {
  git(dir, "-c", "user.email=t@test.local", "-c", "user.name=t", "add", "-A");
  git(dir, "-c", "user.email=t@test.local", "-c", "user.name=t", "commit", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/**
 * Put a commit on the card's factory branch and push it, which is what opening or
 * updating a PR looks like from here.
 *
 * Advances from the branch's existing tip rather than resetting it: a helper that
 * did `checkout -B` from `main` moved the branch *backwards*, and the second push
 * was a non-fast-forward the bare origin refused. A fixture that cannot push twice
 * cannot test a re-review.
 */
function pushFactoryBranch(
  files: Record<string, string>,
  message = "factory: work",
  remove: string[] = []
): string {
  const branch = `factory/${CARD}`;
  if (refExists(`refs/heads/${branch}`)) {
    git(fixture.repoPath, "checkout", branch);
  } else {
    git(fixture.repoPath, "checkout", "-B", branch, baseSha);
  }
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(fixture.repoPath, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  for (const name of remove) {
    fs.rmSync(path.join(fixture.repoPath, name));
  }
  const sha = commitIn(fixture.repoPath, message);
  git(fixture.repoPath, "push", "-u", "origin", branch);
  git(fixture.repoPath, "checkout", "main");
  return sha;
}

beforeEach(() => {
  fixture = makeGitRepo();
  baseSha = git(fixture.repoPath, "rev-parse", "HEAD");
});

afterEach(() => {
  fixture.cleanup();
});

describe("reviewWorktreeId", () => {
  it("names the checkout after the card and the short SHA, marked as a review", () => {
    expect(reviewWorktreeId(CARD, headSha ?? "a".repeat(40))).toBe(`${CARD}-r${"a".repeat(7)}`);
  });

  /**
   * The id becomes a directory name, and the value it comes from is a field of a
   * webhook payload. Every other guard in `reviewPr` assumes a SHA is a SHA.
   */
  it("refuses anything that is not a commit SHA", () => {
    for (const bad of ["../../evil", "main", "not-a-sha", "abc12", "a".repeat(41), ""]) {
      expect(() => reviewWorktreeId(CARD, bad), bad).toThrow(/not a commit sha/);
    }
  });
});

describe("createReviewWorktree", () => {
  beforeEach(() => {
    headSha = pushFactoryBranch({ "src/greet.js": "export const greet = () => 'hi';\n" });
  });

  it("checks the PR head out, detached, at exactly the requested commit", () => {
    const wt = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    expect(headCommit(wt.dir)).toBe(headSha);
    expect(wt.head).toBe(headSha);
    // `HEAD` rather than a branch name is what detached means, and it is the
    // difference between a disposable checkout and a branch something can merge.
    expect(git(wt.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
  });

  /**
   * A review that lands on the base commit rather than the head would still run,
   * still post, and comment on lines that do not exist yet. Checking out `main`
   * instead of the SHA is the silent version of that.
   */
  it("shows the PR's content, not main's", () => {
    const wt = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    expect(fs.existsSync(path.join(wt.dir, "src/greet.js"))).toBe(true);
    expect(fs.readFileSync(path.join(wt.dir, "src/greet.js"), "utf8")).toContain("greet");
  });

  it("creates no branch, so a review cannot be merged or pushed by accident", () => {
    createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    expect(git(fixture.repoPath, "for-each-ref", "--format=%(refname)", "refs/heads/"))
      .toContain("refs/heads/main");
    // The PR branch exists because it was pushed; the review must not add one.
    const before = git(fixture.repoPath, "for-each-ref", "--format=%(refname)", "refs/heads/")
      .split("\n").length;
    createReviewWorktree(CARD, PR, baseSha, fixture.repoPath);
    const after = git(fixture.repoPath, "for-each-ref", "--format=%(refname)", "refs/heads/")
      .split("\n").length;
    expect(after).toBe(before);
  });

  it("sees the diff the reviewer is here to read", () => {
    const wt = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    const listed = git(wt.dir, "diff", "--name-only", "origin/main...HEAD");

    expect(listed).toContain("src/greet.js");
  });

  it("reuses the path after a leaked checkout instead of failing forever", () => {
    // A killed review leaves the directory *and* git's registration of it. The
    // next review of the same head must not be blocked by the last one's debris.
    const first = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);
    fs.writeFileSync(path.join(first.dir, "uncommitted-debris.txt"), "left behind\n");

    const second = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    expect(headCommit(second.dir)).toBe(headSha);
    expect(fs.existsSync(path.join(second.dir, "uncommitted-debris.txt"))).toBe(false);
  });

  /**
   * The fetch path, end to end, against a clone that genuinely does not have the
   * commit. This is the orchestrator's real situation on a deploy host: the PR head
   * exists on origin under the ref GitHub advertises for every PR, and nowhere
   * local. A test that only checked the "already local" branch would let a broken
   * fetch ship as a working reviewer.
   */
  it("fetches a head that exists only as the PR ref", () => {
    // The clone has to predate the push. Verified the hard way: `git clone` fetches
    // every advertised ref, refs/pull/N/head included, so a clone made *after* the
    // push already holds the object and the test would pass with the fetch code
    // never running.
    const probe = path.join(fixture.root, "probe");
    execFileSync("git", ["clone", fixture.originPath, probe], { stdio: "ignore" });

    // A commit pushed to origin as refs/pull/7/head and to no branch at all.
    git(fixture.repoPath, "checkout", "-B", "pr-only", baseSha);
    fs.writeFileSync(path.join(fixture.repoPath, "src/only-in-pr.js"), "// pr head\n");
    const prSha = commitIn(fixture.repoPath, "factory: the PR head");
    git(fixture.repoPath, "push", "origin", `+${prSha}:refs/pull/${PR}/head`);
    git(fixture.repoPath, "checkout", "-B", "main", baseSha);

    expect(() => git(probe, "cat-file", "-e", `${prSha}^{commit}`)).toThrow();

    const wt = createReviewWorktree(CARD, PR, prSha, probe);

    expect(headCommit(wt.dir)).toBe(prSha);
    expect(fs.existsSync(path.join(wt.dir, "src/only-in-pr.js"))).toBe(true);
  });

  /**
   * A PR opened from a fork, or a head that GitHub has already garbage-collected,
   * leaves the commit nowhere the host can reach. Checking out something *near* the
   * requested SHA would produce a confident review of code that is not on the PR.
   */
  it("refuses to review a commit it cannot obtain", () => {
    const missing = "f".repeat(40);

    expect(() => createReviewWorktree(CARD, PR, missing, fixture.repoPath)).toThrow(
      /is not available locally and did not arrive with PR #7's head/
    );
  });

  /**
   * Both paths at once: a head the reviewer must fetch, on a repo that already has a
   * checkout of it. This is a re-review after a force-push, which is the case where
   * a stale registered worktree would otherwise decide the shape of the next one.
   */
  it("reclaims the path when re-reviewing a head it had already checked out", () => {
    const second = pushFactoryBranch({ "src/greet.js": "export const greet = () => 'yo';\n" });
    createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    const wt = createReviewWorktree(CARD, PR, second, fixture.repoPath);

    expect(headCommit(wt.dir)).toBe(second);
  });
});

describe("removeReviewWorktree", () => {
  beforeEach(() => {
    headSha = pushFactoryBranch({ "src/greet.js": "export const greet = () => 'hi';\n" });
  });

  it("takes the checkout away and leaves git with no worktree entry", () => {
    const wt = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    removeReviewWorktree(CARD, headSha, fixture.repoPath);

    expect(fs.existsSync(wt.dir)).toBe(false);
    expect(git(fixture.repoPath, "worktree", "list")).not.toContain(wt.dir);
  });

  it("keeps uncommitted work out of the repo when it goes", () => {
    const wt = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);
    fs.writeFileSync(path.join(wt.dir, "notes.md"), "# scratch\n");

    removeReviewWorktree(CARD, headSha, fixture.repoPath);

    expect(git(fixture.repoPath, "status", "--porcelain")).toBe("");
  });

  /**
   * Removal runs from a `finally` after a failure. Throwing there would replace the
   * review's real error with a cleanup error, which is how a one-line bug becomes an
   * undebuggable one.
   */
  it("is safe to call when there is nothing to remove", () => {
    expect(() => removeReviewWorktree(CARD, headSha, fixture.repoPath)).not.toThrow();
    expect(() => removeReviewWorktree(CARD, headSha, fixture.repoPath)).not.toThrow();
  });

  it("refuses a non-SHA rather than deleting a path it guessed", () => {
    expect(() => removeReviewWorktree(CARD, "../../elsewhere", fixture.repoPath)).toThrow(
      /not a commit sha/
    );
  });
});

describe("fileLineCount", () => {
  beforeEach(() => {
    headSha = pushFactoryBranch({
      "src/counted.js": "one\ntwo\nthree\n",
      "src/no-eol.js": "one\ntwo",
      "src/empty.js": "",
    });
  });

  /**
   * A review comment is attached to a line of the reviewed commit's version of the
   * file, so this has to read git's object, not the working directory: whatever is
   * on disk may have been edited by anything else sharing the repo.
   */
  it("counts lines as the reviewed commit has them", () => {
    const wt = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    expect(fileLineCount(wt.dir, "src/counted.js")).toBe(3);
  });

  it("does not count a trailing newline as an extra line", () => {
    const wt = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    // "one\ntwo" has two lines and no final newline; "one\ntwo\n" also has two.
    expect(fileLineCount(wt.dir, "src/no-eol.js")).toBe(2);
    expect(fileLineCount(wt.dir, "src/counted.js")).toBe(3);
  });

  it("reports zero for an empty file, so nothing can be pointed at it", () => {
    const wt = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    expect(fileLineCount(wt.dir, "src/empty.js")).toBe(0);
  });

  it("returns null for a path the commit does not have", () => {
    const wt = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    expect(fileLineCount(wt.dir, "src/never-existed.js")).toBeNull();
  });

  /**
   * A deleted file is in the diff, so a reviewer can name it — and there is no new
   * version of it for a `side: RIGHT` comment to attach to. This null is what turns
   * that into a refusal the model can read instead of a 422 from GitHub.
   */
  /**
   * A file the PR *deletes* is in the diff, so a reviewer can name it — and there is
   * no new version of it for a `side: RIGHT` comment to attach to. (A file the PR
   * added and then removed never appears in the diff at all, which is what this test
   * looked for first and is not the interesting case.)
   */
  it("returns null for a file the reviewed commit deleted", () => {
    const afterDelete = pushFactoryBranch({}, "factory: remove a base file", ["src/index.js"]);
    const wt = createReviewWorktree(CARD, PR, afterDelete, fixture.repoPath);

    // Present in the diff, absent from the commit: exactly the confusion.
    expect(git(wt.dir, "diff", "--name-only", "origin/main...HEAD")).toContain("src/index.js");
    expect(fileLineCount(wt.dir, "src/index.js")).toBeNull();
  });

  it("will not resolve a path outside the worktree", () => {
    const wt = createReviewWorktree(CARD, PR, headSha, fixture.repoPath);

    expect(fileLineCount(wt.dir, "../../../etc/passwd")).toBeNull();
  });
});
