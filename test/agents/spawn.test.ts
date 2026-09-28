/**
 * Host-side child orchestration (phase 2.2 step 2, `src/agents/spawn.ts`).
 *
 * Everything below runs against a real temp git fixture and the real
 * `src/worker/worktree.js`; only the container boundary is a fake, so `npm test`
 * never execs docker. The store is a real SQLite file per test, closed in
 * `afterEach`.
 *
 * ---------------------------------------------------------------------
 * BUG-1 — found by scripts/graph-smoke.ts, fixed in src/agents/spawn.ts
 *
 * `land()` used to measure a child's work with
 * `changedFiles(dir, baseHead)` = `git diff --name-only <baseHead>...HEAD`, a
 * commit-to-commit range, taken *before* the host committed anything. But the
 * only work a child can ever leave is uncommitted — its container has `.git`
 * mounted read-only — and a child worktree's HEAD is its fork point, exactly
 * `baseHead`, so the range was always empty and every successful child was
 * reported as "changed no files" and thrown away.
 *
 * The unit suite stayed green through all of that because `committingFake`
 * committed half of its own work to make the host path reachable, which modelled
 * a child that cannot exist. Worth remembering as the shape of a bad fake: it did
 * not just hide the bug, it made the green tests evidence that the bug was absent.
 *
 * `land()` now commits on the host before measuring, so every fake here writes
 * files and leaves them uncommitted — the only thing a real child can do. The
 * two tests at the end of "detached coder" pin the regression directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  IPC_ENV,
  createAgentSpawner,
  type AgentEvent,
  type AgentSpawner,
  type ChildRunOptions,
  type RunChild,
} from "../../src/agents/spawn.js";
import {
  childBranchFor,
  commonGitDir,
  createWorktree,
  headCommit,
} from "../../src/worker/worktree.js";
import { createStore, type Store } from "../../src/state/store.js";
import { makeGitRepo, type GitRepoFixture } from "../helpers/git.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

const CARD = "card-1";

let fixture: GitRepoFixture;
let dbDir: string;
let store: Store;
let baseDir: string;
let gitDir: string;

/** git without a shell, for assertions only. */
function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** Absolute path of a per-worktree git file (`MERGE_HEAD` lives there). */
function gitPath(dir: string, name: string): string {
  return path.resolve(dir, gitOut(dir, "rev-parse", "--git-path", name));
}

/** The SHAs of a commit: itself plus each parent. */
function parentsOf(dir: string, ref = "HEAD"): string[] {
  return gitOut(dir, "rev-list", "--parents", "-n", "1", ref).split(" ");
}

/** Files in a commit's tree, one per line. */
function treeFiles(dir: string, ref = "HEAD"): string {
  return gitOut(dir, "ls-tree", "-r", "--name-only", ref);
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`);
  }
}

function commitIn(dir: string, message: string): string {
  gitOut(dir, "-c", "user.email=t@test.local", "-c", "user.name=t", "add", "-A");
  gitOut(dir, "-c", "user.email=t@test.local", "-c", "user.name=t", "commit", "-m", message);
  return gitOut(dir, "rev-parse", "HEAD");
}

/** A promise a test opens by hand, to hold a fake container open. */
interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A fake container that writes files and leaves them uncommitted -- the only
 * thing a real child can do.
 */
function writeOnlyFake(files: Record<string, string>, text = "implemented"): RunChild {
  return async (options) => {
    writeFiles(options.dir, files);
    return { ok: true, text };
  };
}

/**
 * A fake that leaves its work uncommitted, exactly like a real child.
 *
 * This used to make its own commit, because `changedFiles` only saw commits and
 * an uncommitted child was wrongly reported as "changed no files" — so the fake
 * had to work around the ordering bug for the host path to be reachable at all.
 * `land()` now commits on the host before measuring, which is what
 * scripts/graph-smoke.ts proved was needed against a real model.
 */
function committingFake(files: Record<string, string>, text = "implemented"): RunChild {
  return writeOnlyFake(files, text);
}

/**
 * A fake writing a different file on every call.
 *
 * Two children that write byte-identical content genuinely change nothing on the
 * second run — the child branches from a base that already has that file — so a
 * test that wants N landed runs needs N distinct changes.
 */
function sequentialFileFake(): RunChild {
  let n = 0;
  return async (options) => {
    n += 1;
    writeFiles(options.dir, { [`src/part${n}.js`]: `export const part${n} = ${n};\n` });
    return { ok: true, text: `wrote src/part${n}.js` };
  };
}

beforeEach(() => {
  fixture = makeGitRepo();
  // `createChildWorktree` / `removeChildWorktree` take `repoPath` as a default
  // argument, so the default ops resolve it from REPO_PATH at call time. The
  // fixture has to be the repo they point at.
  vi.stubEnv("REPO_PATH", fixture.repoPath);
  // Linked worktrees share the clone's config, so this is the identity every
  // commit and merge in this fixture gets.
  gitOut(fixture.repoPath, "config", "user.email", "factory@test.local");
  gitOut(fixture.repoPath, "config", "user.name", "factory-test");
  // The card's base worktree: the `baseDir` the spawner expects to exist.
  baseDir = createWorktree(CARD, fixture.repoPath).dir;
  gitDir = commonGitDir(baseDir);
  dbDir = makeTempDir("factory-spawn-db-");
  store = createStore(path.join(dbDir, "factory.db"));
});

afterEach(() => {
  store.close();
  removeTempDir(dbDir);
  fixture.cleanup();
});

/** A spawner plus a recording fake that must never be reached. */
function unusedRunner(
  limits: { maxParallel: number; maxRuns: number; timeoutMs: number } = {
    maxParallel: 2,
    maxRuns: 4,
    timeoutMs: 1_000,
  }
): { spawner: AgentSpawner; calls: ChildRunOptions[] } {
  const calls: ChildRunOptions[] = [];
  const spawner = createAgentSpawner({
    store,
    cardId: CARD,
    baseDir,
    gitDir,
    runChild: async (options) => {
      calls.push(options);
      return { ok: true, text: "should not have run" };
    },
    limits,
  });
  return { spawner, calls };
}

describe("validation", () => {
  it("rejects an unknown role with the catalogue of roles the orchestrator may spawn, and nothing else happens", async () => {
    const { spawner, calls } = unusedRunner();

    const outcome = await spawner.spawn({ role: "goblin", task: "do something" });

    expect(outcome.status).toBe("rejected");
    expect(outcome.summary).toContain('unknown role "goblin"');
    expect(outcome.summary).toContain("Spawnable roles:");
    for (const id of ["spec-writer", "researcher", "coder", "verifier"]) {
      expect(outcome.summary).toContain(`\`${id}\``);
    }
    // the catalogue offers only what can be spawned
    expect(outcome.summary).not.toContain("`orchestrator`");
    expect(outcome.summary).not.toContain("`reviewer`");

    // no side effects at all: no run row, no container, nothing left running
    expect(store.countRuns(CARD)).toBe(0);
    expect(calls).toEqual([]);
    expect(store.activeRuns()).toEqual([]);
    expect(spawner.started()).toBe(0);
    expect(spawner.inFlight()).toBe(0);
  });

  it("rejects the roles the factory drives itself, and nothing else happens", async () => {
    for (const role of ["orchestrator", "reviewer"]) {
      const { spawner, calls } = unusedRunner();

      const outcome = await spawner.spawn({ role, task: "do something" });

      expect(outcome.status).toBe("rejected");
      expect(outcome.summary).toContain(`role "${role}" cannot be spawned`);
      expect(store.countRuns(CARD)).toBe(0);
      expect(calls).toEqual([]);
      expect(store.activeRuns()).toEqual([]);
    }
  });

  it("rejects a blank task before it burns a run from the budget, and nothing else happens", async () => {
    for (const task of ["", "   \n\t "]) {
      const { spawner, calls } = unusedRunner();

      const outcome = await spawner.spawn({ role: "coder", task });

      expect(outcome.status).toBe("rejected");
      expect(outcome.summary).toContain("task must be a non-empty description");
      expect(store.countRuns(CARD)).toBe(0);
      expect(calls).toEqual([]);
      expect(store.activeRuns()).toEqual([]);
    }
  });
});

describe("run budget", () => {
  it("rejects a spawn past MAX_AGENT_RUNS without starting a container", async () => {
    // The budget under test is unusedRunner's maxRuns: 4, so seed it full.
    const { spawner, calls } = unusedRunner();
    for (const [index, status] of ["ok", "failed", "ok", "timeout"].entries()) {
      store.addRun({ runId: `seed-${index}`, cardId: CARD, role: "coder" });
      store.setRunDone(`seed-${index}`, status as "ok" | "failed" | "timeout", "seeded");
    }
    expect(store.countRuns(CARD)).toBe(4);

    const outcome = await spawner.spawn({ role: "coder", task: "one more thing" });

    expect(outcome.status).toBe("rejected");
    expect(outcome.summary).toContain("run budget exhausted");
    expect(outcome.summary).toContain("(4)");
    expect(calls).toEqual([]);
    expect(spawner.started()).toBe(0);
  });

  it("reads the budget from the store, so a fresh spawner for the same card cannot exceed it", async () => {
    const limits = { maxParallel: 2, maxRuns: 2, timeoutMs: 1_000 };
    const first = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: sequentialFileFake(),
      limits,
    });

    expect((await first.spawn({ role: "coder", task: "greet" })).status).toBe("ok");
    expect((await first.spawn({ role: "coder", task: "farewell" })).status).toBe("ok");
    expect(first.started()).toBe(2);
    expect(store.countRuns(CARD)).toBe(2);

    // A second orchestrator session gets a brand new spawner object over the
    // same card: the budget is card state, not per-object memory.
    const { spawner: second, calls } = unusedRunner({
      maxParallel: 2,
      maxRuns: 2,
      timeoutMs: 1_000,
    });
    const outcome = await second.spawn({ role: "coder", task: "one more thing" });

    expect(outcome.status).toBe("rejected");
    expect(outcome.summary).toContain("run budget exhausted");
    expect(calls).toEqual([]);
    expect(second.started()).toBe(0);
    expect(store.countRuns(CARD)).toBe(2);
  });
});

describe("detached coder", () => {
  it("lands the child's work as a merge commit on the card branch and cleans the child worktree up", async () => {
    const calls: ChildRunOptions[] = [];
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: async (options) => {
        calls.push(options);
        return committingFake({ "src/greet.js": "export const greet = () => 'hi';\n" })(
          options
        );
      },
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });
    const before = headCommit(baseDir);

    const outcome = await spawner.spawn({ role: "coder", task: "implement greet()" });

    expect(outcome.status).toBe("ok");
    expect(outcome.runId).toBe("c1");
    expect(outcome.branch).toBe(childBranchFor(CARD, "c1"));

    // 1. the container worked in the child's own worktree, not the base
    expect(calls).toHaveLength(1);
    expect(calls[0].dir).toBe(path.join(fixture.root, `wt-${CARD}-c1`));
    expect(calls[0].dir).not.toBe(baseDir);
    expect(calls[0].gitDir).toBe(gitDir);
    expect(calls[0].containerName).toBe(`factory-${CARD}-c1`);
    expect(calls[0].prompt).toContain("implement greet()");
    expect(calls[0].systemPrompt).toContain("You are a coder");

    // 2. the base advanced to a real merge commit whose tree has the child's file
    const head = gitOut(baseDir, "rev-parse", "--verify", "HEAD");
    expect(head).not.toBe(before);
    expect(parentsOf(baseDir)).toHaveLength(3);
    expect(gitOut(baseDir, "log", "-1", "--pretty=%s")).toBe("factory: merge coder c1");
    expect(treeFiles(baseDir)).toContain("src/greet.js");
    expect(fs.readFileSync(path.join(baseDir, "src", "greet.js"), "utf8")).toContain(
      "export const greet"
    );
    expect(gitOut(baseDir, "status", "--porcelain")).toBe("");

    // 3. the orchestrator gets the diff size, not just the child's claim
    expect(outcome.summary).toContain("diff --stat");
    expect(outcome.summary).toContain("src/greet.js");
    expect(outcome.summary).toContain(`merged into the card branch as ${head.slice(0, 8)}`);

    // 4. exactly one run row, closed as ok
    const runs = store.runsFor(CARD);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      run_id: "c1",
      card_id: CARD,
      role: "coder",
      status: "ok",
      branch: childBranchFor(CARD, "c1"),
      worktree: path.join(fixture.root, `wt-${CARD}-c1`),
    });
    expect(store.activeRuns()).toEqual([]);

    // 5. worktree and branch are gone; the base is untouched
    expect(fs.existsSync(path.join(fixture.root, `wt-${CARD}-c1`))).toBe(false);
    expect(gitOut(fixture.repoPath, "worktree", "list")).not.toContain(`wt-${CARD}-c1`);
    expect(gitOut(fixture.repoPath, "branch", "--list", childBranchFor(CARD, "c1"))).toBe("");
    expect(gitOut(baseDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`factory/${CARD}`);
    expect(spawner.inFlight()).toBe(0);
  });

  it("forks a second child from the advanced base, so both files land as two distinct merges", async () => {
    let call = 0;
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: async (options) => {
        call += 1;
        return call === 1
          ? committingFake({ "src/greet.js": "greet\n" })(options)
          : committingFake({ "src/bye.js": "bye\n" })(options);
      },
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });
    const start = headCommit(baseDir);

    const first = await spawner.spawn({ role: "coder", task: "implement greet()" });
    const afterFirst = headCommit(baseDir);
    const second = await spawner.spawn({ role: "coder", task: "implement farewell()" });
    const afterSecond = headCommit(baseDir);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(first.branch).not.toBe(second.branch);
    expect(afterFirst).not.toBe(start);
    expect(afterSecond).not.toBe(afterFirst);

    // the second child forked from the first merge, so that merge is one of its parents
    expect(parentsOf(baseDir)[0]).toBe(afterSecond);
    expect(parentsOf(baseDir)).toContain(afterFirst);

    // both children's work is in the base tree, on two merge commits
    const tree = treeFiles(baseDir);
    expect(tree).toContain("src/greet.js");
    expect(tree).toContain("src/bye.js");
    expect(gitOut(baseDir, "rev-list", "--merges", "--count", "HEAD")).toBe("2");
    expect(gitOut(baseDir, "status", "--porcelain")).toBe("");

    // both children were cleaned up
    const worktrees = gitOut(fixture.repoPath, "worktree", "list");
    expect(worktrees).not.toContain(`wt-${CARD}-c1`);
    expect(worktrees).not.toContain(`wt-${CARD}-c2`);
    expect(gitOut(fixture.repoPath, "branch", "--list", "factory/")).not.toContain(`-c`);
    expect(store.runsFor(CARD).map((run) => run.status)).toEqual(["ok", "ok"]);
  });

  it("hands a second coder's summary back with its own diff, not the first one's", async () => {
    const summaries: string[] = [];
    let call = 0;
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: async (options) => {
        call += 1;
        return call === 1
          ? committingFake({ "src/greet.js": "greet\n" })(options)
          : committingFake({ "src/bye.js": "bye\n" })(options);
      },
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });

    summaries.push((await spawner.spawn({ role: "coder", task: "greet" })).summary);
    summaries.push((await spawner.spawn({ role: "coder", task: "bye" })).summary);

    expect(summaries[0]).toContain("src/greet.js");
    expect(summaries[0]).not.toContain("src/bye.js");
    expect(summaries[1]).toContain("src/bye.js");
    expect(summaries[1]).toContain("diff --stat");
  });

  it("lands a coder's uncommitted work: the host commits it, then merges it", async () => {
    // The behaviour scripts/graph-smoke.ts exposed against a real model: an agent
    // container has a read-only .git, so uncommitted work is the ONLY state a
    // finished child can be in. Measuring it before committing threw the work away.
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: writeOnlyFake({ "src/greet.js": "greet\n" }, "implemented greet()"),
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });
    const before = headCommit(baseDir);

    const outcome = await spawner.spawn({ role: "coder", task: "implement greet()" });

    expect(outcome.status).toBe("ok");
    expect(outcome.summary).toContain("merged into the card branch");
    expect(outcome.summary).toContain("src/greet.js");
    expect(outcome.summary).toContain("diff --stat:");
    expect(outcome.summary).not.toContain("changed no files");

    // the child's file is on the card branch, via a merge commit. (A merge's
    // combined `show --name-only` is empty by design, so ask the tree.)
    expect(headCommit(baseDir)).not.toBe(before);
    expect(treeFiles(baseDir)).toContain("src/greet.js");
    expect(gitOut(baseDir, "rev-list", "--parents", "-1", "HEAD").trim().split(/\s+/).length).toBe(3);
    expect(gitOut(baseDir, "status", "--porcelain")).toBe("");
    expect(store.runsFor(CARD)[0].status).toBe("ok");
    // and the child worktree is gone again
    expect(gitOut(fixture.repoPath, "worktree", "list")).not.toContain(`wt-${CARD}-c1`);
  });

  it("reports a verifier that changed nothing as a success, not an empty run", async () => {
    // The empty-diff guard is for writers. A verifier that runs the suite and
    // changes nothing has done its job; failing it would teach the orchestrator
    // that verification always means something went wrong.
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: async () => ({ ok: true, text: "npm test: 406 passed" }),
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });
    const before = headCommit(baseDir);

    const outcome = await spawner.spawn({ role: "verifier", task: "run the tests" });

    expect(outcome.status).toBe("ok");
    expect(outcome.summary).toContain("report only");
    expect(headCommit(baseDir)).toBe(before);
    expect(store.runsFor(CARD)[0].status).toBe("ok");
  });
});

describe("merge conflicts", () => {
  it("reports a conflict as a failed run, names the file, and leaves the base clean on the last good merge", async () => {
    const gates: Gate[] = [];
    const runChild: RunChild = async (options) => {
      const first = path.basename(options.dir) === `wt-${CARD}-c1`;
      const held = gate();
      gates.push(held);
      // Both children hold their container open at once, so both forked from the
      // same base HEAD and both add x.md: the plan's conflict case.
      await held.promise;
      return committingFake({ "x.md": first ? "# child one" : "# child two" })(options);
    };
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild,
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });

    const firstRun = spawner.spawn({ role: "coder", task: "write x.md" });
    const secondRun = spawner.spawn({ role: "coder", task: "write x.md differently" });
    await waitFor(() => gates.length === 2, "both child containers to start");
    gates[0].open();
    const first = await firstRun;
    const afterFirst = headCommit(baseDir);
    expect(first.status).toBe("ok");
    gates[1].open();
    const second = await secondRun;

    // a conflict is a failed run carrying the conflict, for the orchestrator to re-plan
    expect(second.status).toBe("failed");
    expect(second.summary).toContain("status=failed");
    expect(second.summary).toContain("MERGE CONFLICT");
    expect(second.summary).toContain("x.md");

    // the base is exactly as the first merge left it: no half-merged state
    expect(headCommit(baseDir)).toBe(afterFirst);
    expect(gitOut(baseDir, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(gitPath(baseDir, "MERGE_HEAD"))).toBe(false);
    expect(fs.readFileSync(path.join(baseDir, "x.md"), "utf8")).toContain("child one");

    // and it is still a working merge target for the next child
    expect(gitOut(baseDir, "rev-list", "--merges", "--count", "HEAD")).toBe("1");
    expect(store.runsFor(CARD).map((run) => run.status)).toEqual(["ok", "failed"]);
    expect(store.activeRuns()).toEqual([]);
  });
});

describe("failure classification", () => {
  it("fails a child that reported success but wrote nothing", async () => {
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: async () => ({ ok: true, text: "all done, nothing needed changing" }),
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });
    const before = headCommit(baseDir);

    const outcome = await spawner.spawn({ role: "coder", task: "tidy up" });

    // A coder that wrote nothing is a failure the orchestrator must see, or an
    // empty child becomes a shipped no-op. The verifier test above pins the other
    // half: a role that is not meant to write is not failed for not writing.
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("reported success but changed no files");
    expect(headCommit(baseDir)).toBe(before);
    expect(gitOut(baseDir, "status", "--porcelain")).toBe("");
    expect(store.runsFor(CARD)[0]).toMatchObject({ status: "failed", ended_at: expect.any(Number) });
    expect(gitOut(fixture.repoPath, "worktree", "list")).not.toContain(`wt-${CARD}-c1`);
  });

  it("classifies a wall-clock expiry as a timeout, records it as one, and still cleans up", async () => {
    const calls: ChildRunOptions[] = [];
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: async (options) => {
        calls.push(options);
        return { ok: false, text: `agent run timed out after ${options.timeoutMs}ms` };
      },
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1 },
    });
    const before = headCommit(baseDir);

    const outcome = await spawner.spawn({ role: "coder", task: "a long job" });

    expect(outcome.status).toBe("timeout");
    expect(calls[0].timeoutMs).toBe(1);
    expect(outcome.summary).toContain("status=timeout");
    expect(outcome.summary).toContain("run did not finish cleanly");
    expect(outcome.summary).toContain("agent run timed out after 1ms");

    const [run] = store.runsFor(CARD);
    expect(run.status).toBe("timeout");
    expect(run.summary).toContain("agent run timed out after 1ms");

    // a timeout lands nothing and leaves nothing registered
    expect(headCommit(baseDir)).toBe(before);
    expect(gitOut(baseDir, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(fixture.root, `wt-${CARD}-c1`))).toBe(false);
    expect(gitOut(fixture.repoPath, "worktree", "list")).not.toContain(`wt-${CARD}-c1`);
    expect(gitOut(fixture.repoPath, "branch", "--list", childBranchFor(CARD, "c1"))).toBe("");
  });

  it("treats a throwing container runner as a failed run, cleans up, and keeps the semaphore", async () => {
    let calls = 0;
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: async (options) => {
        calls += 1;
        if (calls === 1) throw new Error("docker: command not found");
        return committingFake({ "src/after.js": "after\n" })(options);
      },
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });

    const outcome = await spawner.spawn({ role: "coder", task: "first attempt" });

    // a broken container boundary is a failed child, never a throw at the tool
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("could not run");
    expect(outcome.summary).toContain("docker: command not found");
    expect(store.runsFor(CARD)[0]).toMatchObject({ status: "failed" });
    expect(store.activeRuns()).toEqual([]);
    expect(gitOut(fixture.repoPath, "worktree", "list")).not.toContain(`wt-${CARD}-c1`);
    expect(spawner.inFlight()).toBe(0);

    // the slot was released, so the next spawn still runs
    const second = await spawner.spawn({ role: "coder", task: "second attempt" });
    expect(second.status).toBe("ok");
    expect(calls).toBe(2);
    expect(spawner.inFlight()).toBe(0);
    expect(treeFiles(baseDir)).toContain("src/after.js");
  });
});

describe("shared-worktree roles", () => {
  it("runs spec-writer in the card's base worktree and commits straight onto the card branch", async () => {
    const calls: ChildRunOptions[] = [];
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: async (options) => {
        calls.push(options);
        return committingFake({ "factory-spec.md": "# goal\n" }, "spec written")(options);
      },
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });
    const before = headCommit(baseDir);

    const outcome = await spawner.spawn({ role: "spec-writer", task: "write the spec" });

    expect(outcome.status).toBe("ok");

    // the container worked in the base worktree, and no child worktree was made
    expect(calls).toHaveLength(1);
    expect(calls[0].dir).toBe(baseDir);
    expect(calls[0].systemPrompt).toContain("You are the spec-writer");
    expect(calls[0].excludeTools).toEqual(["bash"]);
    expect(fs.existsSync(path.join(fixture.root, `wt-${CARD}-c1`))).toBe(false);
    expect(gitOut(fixture.repoPath, "worktree", "list")).not.toContain(`wt-${CARD}-c1`);
    expect(outcome.branch).toBeUndefined();

    // a normal commit on the card branch, not a merge
    const head = gitOut(baseDir, "rev-parse", "HEAD");
    expect(head).not.toBe(before);
    expect(parentsOf(baseDir)).toHaveLength(2);
    expect(gitOut(baseDir, "log", "-1", "--pretty=%s")).toBe("factory: spec-writer c1");
    expect(treeFiles(baseDir)).toContain("factory-spec.md");
    expect(gitOut(baseDir, "status", "--porcelain")).toBe("");
    expect(gitOut(baseDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`factory/${CARD}`);
    expect(outcome.summary).toContain("committed to the card branch");
    expect(outcome.summary).toContain("diff --stat");

    // there is no child branch to record
    const [run] = store.runsFor(CARD);
    expect(run.branch).toBeNull();
    expect(run.worktree).toBe(baseDir);
    expect(run.status).toBe("ok");
  });
});

describe("detached but not merged: the verifier", () => {
  it("gives the verifier a throwaway worktree and never merges it back", async () => {
    const calls: ChildRunOptions[] = [];
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: async (options) => {
        calls.push(options);
        return committingFake({ "test-report.txt": "suite: green\n" }, "tests passed")(options);
      },
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });
    const before = headCommit(baseDir);

    const outcome = await spawner.spawn({ role: "verifier", task: "run the suite" });

    expect(outcome.status).toBe("ok");
    // detached, but with no write tools and no merge
    expect(calls).toHaveLength(1);
    expect(calls[0].dir).toBe(path.join(fixture.root, `wt-${CARD}-c1`));
    expect(calls[0].dir).not.toBe(baseDir);
    expect(calls[0].excludeTools).toEqual(["edit", "write"]);
    expect(outcome.summary).toContain("report only");

    // the base did not move and got none of the verifier's work
    expect(headCommit(baseDir)).toBe(before);
    expect(gitOut(baseDir, "status", "--porcelain")).toBe("");
    expect(treeFiles(baseDir)).not.toContain("test-report.txt");

    // the throwaway worktree and its branch are gone
    expect(fs.existsSync(path.join(fixture.root, `wt-${CARD}-c1`))).toBe(false);
    expect(gitOut(fixture.repoPath, "worktree", "list")).not.toContain(`wt-${CARD}-c1`);
    expect(gitOut(fixture.repoPath, "branch", "--list", childBranchFor(CARD, "c1"))).toBe("");
  });
});

describe("concurrency cap", () => {
  it("never runs more child containers at once than the cap allows, and queues the rest", async () => {
    const gates: Gate[] = [];
    let current = 0;
    let peak = 0;
    const runChild: RunChild = async () => {
      current += 1;
      peak = Math.max(peak, current);
      const held = gate();
      gates.push(held);
      try {
        await held.promise;
      } finally {
        current -= 1;
      }
      return { ok: false, text: "nothing to report" };
    };
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild,
      limits: { maxParallel: 2, maxRuns: 20, timeoutMs: 1_000 },
    });

    const pending = Array.from({ length: 6 }, (_, i) =>
      spawner.spawn({ role: "coder", task: `independent task ${i + 1}` })
    );

    // Release them one at a time: the cap is what is being measured, and only
    // two may ever be inside the fake at once.
    let opened = 0;
    while (opened < 6) {
      await waitFor(() => gates.length > opened, `child container ${opened + 1} to start`);
      gates[opened].open();
      opened += 1;
    }
    const outcomes = await Promise.all(pending);

    expect(peak).toBe(2);
    expect(outcomes).toHaveLength(6);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("failed");
      expect(outcome.runId).toBeTruthy();
    }
    expect(spawner.started()).toBe(6);
    expect(spawner.inFlight()).toBe(0);
    expect(store.runsFor(CARD)).toHaveLength(6);
    expect(store.activeRuns()).toEqual([]);
    // every child worktree was released again
    const worktrees = gitOut(fixture.repoPath, "worktree", "list");
    for (let run = 1; run <= 6; run += 1) {
      expect(worktrees).not.toContain(`wt-${CARD}-c${run}`);
    }
  });
});

describe("events", () => {
  it("emits started before done for a run", async () => {
    const events: AgentEvent[] = [];
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: committingFake({ "src/greet.js": "greet\n" }),
      onEvent: (event) => events.push(event),
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });

    const outcome = await spawner.spawn({ role: "coder", task: "implement greet()" });

    expect(outcome.status).toBe("ok");
    expect(events).toEqual([
      { kind: "started", role: "coder", runId: "c1", task: "implement greet()" },
      { kind: "done", role: "coder", runId: "c1", status: "ok" },
    ]);
    expect(events.findIndex((e) => e.kind === "started")).toBeLessThan(
      events.findIndex((e) => e.kind === "done")
    );
  });

  it("turns the container's tool callbacks into tool events", async () => {
    const events: AgentEvent[] = [];
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: async (options) => {
        options.onTool?.("read");
        options.onTool?.("edit");
        return committingFake({ "src/greet.js": "greet\n" })(options);
      },
      onEvent: (event) => events.push(event),
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });

    await spawner.spawn({ role: "coder", task: "implement greet()" });

    expect(events).toEqual([
      { kind: "started", role: "coder", runId: "c1", task: "implement greet()" },
      { kind: "tool", role: "coder", runId: "c1", toolName: "read" },
      { kind: "tool", role: "coder", runId: "c1", toolName: "edit" },
      { kind: "done", role: "coder", runId: "c1", status: "ok" },
    ]);
  });
});

describe("security: the orchestrator's IPC env never reaches a child", () => {
  it("hands runChild no extraEnv and no spawn token", async () => {
    vi.stubEnv("FACTORY_IPC_TOKEN", "spawn-token-must-not-leak");
    vi.stubEnv("FACTORY_IPC_HOST", "host.docker.internal");
    const calls: ChildRunOptions[] = [];
    const spawner = createAgentSpawner({
      store,
      cardId: CARD,
      baseDir,
      gitDir,
      runChild: async (options) => {
        calls.push(options);
        return committingFake({ "src/greet.js": "greet\n" })(options);
      },
      limits: { maxParallel: 2, maxRuns: 4, timeoutMs: 1_000 },
    });

    // the orchestrator process really is holding the token a child must not see
    expect(process.env[IPC_ENV.token]).toBe("spawn-token-must-not-leak");

    const outcome = await spawner.spawn({ role: "coder", task: "implement greet()" });
    expect(outcome.status).toBe("ok");
    expect(calls).toHaveLength(1);

    // the orchestrator's own IPC is the one channel a child must not be able
    // to call back in on: it would be a token for "start another container".
    expect(calls[0].extraEnv).toBeUndefined();
    expect("extraEnv" in calls[0]).toBe(false);
    const serialized = JSON.stringify(calls[0]);
    expect(serialized).not.toContain("spawn-token-must-not-leak");
    for (const name of Object.values(IPC_ENV)) {
      expect(serialized).not.toContain(`${name}=`);
    }
  });
});
