import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  branchFor,
  childBranchFor,
  childWorktreeId,
  changedFiles,
  createChildWorktree,
  createWorktree,
  deleteBranch,
  headCommit,
  mergeChildIntoBase,
  removeChildWorktree,
  removeWorktree,
  worktreeDir,
  type Worktree,
} from "../../src/worker/worktree.js";
import { makeGitRepo, type GitRepoFixture } from "../helpers/git.js";

const CARD = "card-1";
const RUN = "r1";

let fixture: GitRepoFixture;

/** git without a shell, for assertions only. */
function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** Commit in a worktree as the host does on the agent's behalf. */
function commitIn(dir: string, message: string): string {
  gitOut(dir, "-c", "user.email=t@test.local", "-c", "user.name=t", "add", "-A");
  gitOut(dir, "-c", "user.email=t@test.local", "-c", "user.name=t", "commit", "-m", message);
  return gitOut(dir, "rev-parse", "HEAD");
}

function isAncestor(sha: string, dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", sha, "HEAD"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of a per-worktree git file (`MERGE_HEAD` lives in the worktree git dir). */
function gitPath(dir: string, name: string): string {
  return path.resolve(dir, gitOut(dir, "rev-parse", "--git-path", name));
}

/**
 * Put the base worktree on a detached HEAD and drop the card branch.
 *
 * git stores refs as files, so `factory/<card>` (the card branch the PR ships
 * from) and `factory/<card>/<run>` (a child) cannot both exist. The card branch
 * wins in production; this is how a test reaches the *other* branch, the one
 * taken when nothing occupies the ref path.
 */
function detachBase(base: Worktree, repoPath: string): void {
  gitOut(base.dir, "checkout", "--detach");
  gitOut(repoPath, "branch", "-D", `factory/${CARD}`);
}

beforeEach(() => {
  fixture = makeGitRepo();
  // Linked worktrees share the clone's config, so this is the identity every
  // commit/merge in this fixture gets — the suite must not depend on whatever
  // git config the machine running it happens to have.
  gitOut(fixture.repoPath, "config", "user.email", "factory@test.local");
  gitOut(fixture.repoPath, "config", "user.name", "factory-test");
});

afterEach(() => {
  fixture.cleanup();
});

describe("child naming", () => {
  // Not a style choice: git refs are files, so `factory/<card>` and
  // `factory/<card>/c1` cannot both exist. Asserted directly below so the
  // constraint fails here rather than surfacing as a merge-time "cannot lock ref".
  it("names the child beside the card branch, never underneath it", () => {
    expect(childBranchFor("abc", "c1")).toBe("factory/abc-c1");
  });

  it("git refuses a nested child branch while the card branch exists", () => {
    expect(() => gitOut(fixture.repoPath, "branch", branchFor(CARD), "HEAD")).not.toThrow();
    expect(() =>
      gitOut(fixture.repoPath, "branch", `factory/${CARD}/c1`, "HEAD")
    ).toThrow();
  });

  it("ids a worktree so worktreeDir yields wt-<card>-<run>", () => {
    expect(childWorktreeId("abc", "c1")).toBe("abc-c1");
    expect(worktreeDir(childWorktreeId("abc", "c1"), "/tmp/repo")).toBe("/tmp/wt-abc-c1");
  });
});

describe("createChildWorktree", () => {
  it("forks from the base worktree's current HEAD, not from origin/main", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    // the orchestrator merged an earlier child in before this one started
    fs.writeFileSync(path.join(base.dir, "src", "index.js"), "// advanced\n");
    const advanced = commitIn(base.dir, "orchestrator: advance base");
    expect(advanced).not.toBe(gitOut(fixture.repoPath, "rev-parse", "origin/main"));

    const child = createChildWorktree(CARD, RUN, fixture.repoPath);

    expect(child.dir).toBe(path.join(fixture.root, `wt-${CARD}-${RUN}`));
    expect(fs.existsSync(child.dir)).toBe(true);
    expect(headCommit(child.dir)).toBe(advanced);
    // and the base was only read, never moved
    expect(headCommit(base.dir)).toBe(advanced);
  });

  // Deterministic on purpose. The earlier design picked the name by asking git
  // whether `factory/<card>` existed, which made a run's branch name depend on
  // ref state at that instant — and `removeChildWorktree` then had to recompute
  // it, deleting the wrong branch when the base had already gone.
  it("names the child the same way whether or not the ref path is free", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    detachBase(base, fixture.repoPath); // factory/<card> no longer occupies the path

    const child = createChildWorktree(CARD, RUN, fixture.repoPath);

    expect(child.branch).toBe(childBranchFor(CARD, RUN));
    expect(child.branch).toBe(`factory/${CARD}-${RUN}`);
    expect(gitOut(child.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(child.branch);
  });

  it("takes a sibling branch beside the card branch it can never collide with", () => {
    const base = createWorktree(CARD, fixture.repoPath);

    const child = createChildWorktree(CARD, RUN, fixture.repoPath);

    // git cannot hold `factory/<card>` and `factory/<card>/<run>` at once, and
    // the card branch is the one the PR ships from, so the child takes
    // `factory/<card>-<run>` — a real branch, from the base's current HEAD.
    expect(child.branch).toBe(`factory/${CARD}-${RUN}`);
    expect(gitOut(child.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(child.branch);
    expect(gitOut(fixture.repoPath, "branch", "--list", `factory/${CARD}/${RUN}`)).toBe("");
    expect(headCommit(child.dir)).toBe(headCommit(base.dir));
    expect(child.dir).not.toBe(base.dir);
    // the card branch is untouched
    expect(gitOut(base.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`factory/${CARD}`);
  });

  it("throws when the card has no base worktree", () => {
    expect(() => createChildWorktree("never-created", RUN, fixture.repoPath)).toThrow(
      /no base worktree/
    );
  });

  it("reclaims a stale directory a killed run left behind", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    const dir = worktreeDir(childWorktreeId(CARD, RUN), fixture.repoPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "leftover.txt"), "not a worktree\n");

    const child = createChildWorktree(CARD, RUN, fixture.repoPath);

    expect(child.dir).toBe(dir);
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "leftover.txt"))).toBe(false);
    expect(headCommit(child.dir)).toBe(headCommit(base.dir));
  });

  it("resets a child branch left behind by an interrupted run", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    detachBase(base, fixture.repoPath);
    const first = createChildWorktree(CARD, RUN, fixture.repoPath);
    fs.writeFileSync(path.join(first.dir, "half.js"), "// half done\n");
    commitIn(first.dir, "half done");

    const second = createChildWorktree(CARD, RUN, fixture.repoPath);

    expect(second.dir).toBe(first.dir);
    expect(headCommit(second.dir)).toBe(headCommit(base.dir));
    expect(fs.existsSync(path.join(second.dir, "half.js"))).toBe(false);
  });
});

describe("changedFiles", () => {
  it("lists what a child changed, sorted", () => {
    createWorktree(CARD, fixture.repoPath);
    const child = createChildWorktree(CARD, "r1", fixture.repoPath);
    fs.writeFileSync(path.join(child.dir, "zebra.js"), "// z\n");
    fs.writeFileSync(path.join(child.dir, "apple.js"), "// a\n");
    fs.mkdirSync(path.join(child.dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(child.dir, "src", "beta.js"), "// b\n");
    commitIn(child.dir, "coder: three files");

    expect(changedFiles(child.dir, `factory/${CARD}`)).toEqual([
      "apple.js",
      "src/beta.js",
      "zebra.js",
    ]);
  });

  it("is empty for a child that changed nothing", () => {
    createWorktree(CARD, fixture.repoPath);
    const child = createChildWorktree(CARD, "r1", fixture.repoPath);

    expect(changedFiles(child.dir, `factory/${CARD}`)).toEqual([]);
  });
});

describe("mergeChildIntoBase", () => {
  it("lands a merge commit on the base worktree", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    const child = createChildWorktree(CARD, RUN, fixture.repoPath);
    fs.writeFileSync(path.join(child.dir, "src", "greet.js"), "module.exports = 'hi';\n");
    const childSha = commitIn(child.dir, "coder: greet");

    const result = mergeChildIntoBase(base.dir, child.branch, "factory: merge coder 1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected a clean merge, got ${result.output}`);
    expect(result.commit).toBe(headCommit(base.dir));
    expect(gitOut(base.dir, "log", "-1", "--pretty=%s")).toBe("factory: merge coder 1");
    // two parents: a real merge, not a fast-forward
    expect(gitOut(base.dir, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(
      3
    );
    expect(isAncestor(childSha, base.dir)).toBe(true);
    expect(gitOut(base.dir, "status", "--porcelain")).toBe("");
    // the base branch is what a PR ships from, and it moved
    expect(gitOut(base.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`factory/${CARD}`);
    expect(fs.existsSync(path.join(base.dir, "src", "greet.js"))).toBe(true);
  });

  it("merges a second child alongside the first", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    const first = createChildWorktree(CARD, "r1", fixture.repoPath);
    const second = createChildWorktree(CARD, "r2", fixture.repoPath);
    fs.writeFileSync(path.join(first.dir, "greet.js"), "// greet\n");
    commitIn(first.dir, "coder 1");
    fs.writeFileSync(path.join(second.dir, "bye.js"), "// bye\n");
    commitIn(second.dir, "coder 2");

    expect(mergeChildIntoBase(base.dir, first.branch, "merge 1").ok).toBe(true);
    expect(mergeChildIntoBase(base.dir, second.branch, "merge 2").ok).toBe(true);

    expect(fs.existsSync(path.join(base.dir, "greet.js"))).toBe(true);
    expect(fs.existsSync(path.join(base.dir, "bye.js"))).toBe(true);
    expect(gitOut(base.dir, "status", "--porcelain")).toBe("");
  });

  it("returns a conflict as a result and leaves the base worktree untouched", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    const first = createChildWorktree(CARD, "r1", fixture.repoPath);
    const second = createChildWorktree(CARD, "r2", fixture.repoPath);
    // both rewrite the same line of the same file, from the same base
    fs.writeFileSync(path.join(first.dir, "README.md"), "# child one\n");
    commitIn(first.dir, "coder 1: readme");
    fs.writeFileSync(path.join(second.dir, "README.md"), "# child two\n");
    commitIn(second.dir, "coder 2: readme");

    expect(mergeChildIntoBase(base.dir, first.branch, "merge 1").ok).toBe(true);
    const afterFirst = headCommit(base.dir);

    const result = mergeChildIntoBase(base.dir, second.branch, "merge 2");

    // a conflict is a result, not an exception
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a conflict");
    expect(result.conflict).toBe(true);
    expect(result.files).toEqual(["README.md"]);
    expect(result.output).toContain("CONFLICT");

    // no half-merged state: same HEAD, clean tree, no MERGE_HEAD
    expect(headCommit(base.dir)).toBe(afterFirst);
    expect(gitOut(base.dir, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(gitPath(base.dir, "MERGE_HEAD"))).toBe(false);
    expect(fs.readFileSync(path.join(base.dir, "README.md"), "utf8")).toBe("# child one\n");

    // ...and the base is still a working merge target
    fs.writeFileSync(path.join(base.dir, "after.txt"), "later\n");
    expect(commitIn(base.dir, "after the conflict")).not.toBe(afterFirst);
    expect(gitOut(base.dir, "status", "--porcelain")).toBe("");
  });

  it("reports a failed merge without throwing when the branch does not exist", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    const before = headCommit(base.dir);

    const result = mergeChildIntoBase(base.dir, "factory/nope/gone", "merge nothing");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.files).toEqual([]);
    expect(result.output).not.toBe("");
    expect(headCommit(base.dir)).toBe(before);
    expect(gitOut(base.dir, "status", "--porcelain")).toBe("");
  });
});

describe("removeChildWorktree", () => {
  it("leaves no registered worktree and no branch behind", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    const child = createChildWorktree(CARD, RUN, fixture.repoPath);
    fs.writeFileSync(path.join(child.dir, "scratch.txt"), "agent scratch\n");

    removeChildWorktree(CARD, RUN, fixture.repoPath);

    expect(fs.existsSync(child.dir)).toBe(false);
    expect(gitOut(fixture.repoPath, "worktree", "list")).not.toContain(`wt-${CARD}-${RUN}`);
    expect(gitOut(fixture.repoPath, "branch", "--list", child.branch)).toBe("");
    expect(gitOut(fixture.repoPath, "branch", "--list", `factory/${CARD}/${RUN}`)).toBe("");
    // the base card worktree is not collateral damage
    expect(fs.existsSync(base.dir)).toBe(true);
    expect(gitOut(base.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`factory/${CARD}`);
  });

  // Teardown ordering makes this real: `removeWorktree(cardId)` deletes the card
  // branch, and a child cleaned up afterwards must still find its own name. A
  // branch name derived from "does the parent ref still exist?" silently leaked
  // every child branch in this path.
  it("deletes the child branch after the card branch is already gone", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    const child = createChildWorktree(CARD, RUN, fixture.repoPath);
    removeWorktree(CARD, fixture.repoPath);

    removeChildWorktree(CARD, RUN, fixture.repoPath);

    expect(gitOut(fixture.repoPath, "branch", "--list", child.branch)).toBe("");
  });

  it("deletes a child branch it created", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    detachBase(base, fixture.repoPath);
    const child = createChildWorktree(CARD, RUN, fixture.repoPath);
    expect(gitOut(fixture.repoPath, "branch", "--list", child.branch)).not.toBe("");

    removeChildWorktree(CARD, RUN, fixture.repoPath);

    expect(gitOut(fixture.repoPath, "branch", "--list", child.branch)).toBe("");
  });

  it("is a no-op when the child was never created", () => {
    createWorktree(CARD, fixture.repoPath);
    expect(() => removeChildWorktree("never-created", RUN, fixture.repoPath)).not.toThrow();
  });
});

describe("deleteBranch", () => {
  it("force-deletes a local branch", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    gitOut(fixture.repoPath, "branch", "doomed", headCommit(base.dir));

    deleteBranch(fixture.repoPath, "doomed");

    expect(gitOut(fixture.repoPath, "branch", "--list", "doomed")).toBe("");
  });
});

describe("security: child ids are never handed to a shell", () => {
  // Same regression guard as test/worker/worktree.test.ts: every git call here
  // goes through execFileSync, so a run id that looks like a command is either a
  // literal refname or an honest git error. The proof is a sentinel file —
  // `$(touch pwned)` only appears if something evaluated it.
  const SENTINEL = "pwned";

  function sentinelExists(): boolean {
    return (
      fs.existsSync(path.join(fixture.root, SENTINEL)) ||
      fs.existsSync(path.resolve(process.cwd(), SENTINEL))
    );
  }

  it("does not run a command substitution in a run id", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    // free the ref path so the child branch (and git's refname check) is used
    detachBase(base, fixture.repoPath);

    let child: Worktree | undefined;
    try {
      child = createChildWorktree(CARD, `x$(touch ${SENTINEL})`, fixture.repoPath);
    } catch {
      // git rejects the refname (space/`$` are not valid): an honest failure
    }

    expect(sentinelExists()).toBe(false);
    if (child) expect(child.branch).toBe(`factory/${CARD}/x$(touch ${SENTINEL})`);
  });

  it("does not treat a semicolon in a child id as a command separator", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    detachBase(base, fixture.repoPath);

    let child: Worktree | undefined;
    try {
      child = createChildWorktree(CARD, `a; touch ${SENTINEL}`, fixture.repoPath);
    } catch {
      // also acceptable
    }

    expect(sentinelExists()).toBe(false);
    if (child) {
      // `;` is a legal git refname character: the id is used literally
      expect(child.branch).toBe(`factory/${CARD}/a; touch ${SENTINEL}`);
      expect(child.dir).toBe(path.join(fixture.root, `wt-${CARD}-a; touch ${SENTINEL}`));
    }
  });

  it("does not let a child id delete files through removeChildWorktree", () => {
    const canary = path.join(fixture.root, "canary.txt");
    fs.writeFileSync(canary, "keep me\n");
    createWorktree(CARD, fixture.repoPath);

    removeChildWorktree(`x;rm -rf ${fixture.root}`, RUN, fixture.repoPath);
    removeChildWorktree(CARD, `x;rm -rf ${fixture.root}`, fixture.repoPath);

    expect(fs.existsSync(canary)).toBe(true);
    expect(sentinelExists()).toBe(false);
  });

  it("does not run a shell when merging a hostile branch name", () => {
    const base = createWorktree(CARD, fixture.repoPath);
    const before = headCommit(base.dir);

    const result = mergeChildIntoBase(
      base.dir,
      `factory/${CARD}; touch ${SENTINEL}`,
      `merge $(touch ${SENTINEL})`
    );

    expect(result.ok).toBe(false);
    expect(sentinelExists()).toBe(false);
    expect(headCommit(base.dir)).toBe(before);
    expect(gitOut(base.dir, "status", "--porcelain")).toBe("");
  });
});
