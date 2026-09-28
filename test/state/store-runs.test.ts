import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { createStore, type Store } from "../../src/state/store.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = makeTempDir();
  store = createStore(path.join(dir, "sub", "test.db"));
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

describe("agent runs", () => {
  it("records a new run as running", () => {
    store.addRun({
      runId: "r1",
      cardId: "c1",
      role: "implementer",
      branch: "factory/c1",
      worktree: "/tmp/wt/c1",
    });

    const [run] = store.runsFor("c1");
    expect(run).toMatchObject({
      run_id: "r1",
      card_id: "c1",
      role: "implementer",
      status: "running",
      branch: "factory/c1",
      worktree: "/tmp/wt/c1",
      summary: null,
      ended_at: null,
    });
    expect(typeof run.started_at).toBe("number");
  });

  it("defaults branch and worktree to null", () => {
    store.addRun({ runId: "r1", cardId: "c1", role: "reviewer" });

    expect(store.runsFor("c1")[0]).toMatchObject({
      branch: null,
      worktree: null,
    });
  });

  it("setRunDone writes status, summary and ended_at", () => {
    store.addRun({ runId: "r1", cardId: "c1", role: "implementer" });
    store.setRunDone("r1", "ok", "opened PR 12");

    const run = store.runsFor("c1")[0];
    expect(run.status).toBe("ok");
    expect(run.summary).toBe("opened PR 12");
    expect(run.ended_at).not.toBeNull();
    expect(run.ended_at as number).toBeGreaterThanOrEqual(run.started_at);
  });

  it("preserves an existing summary when called without one", () => {
    store.addRun({ runId: "r1", cardId: "c1", role: "implementer" });
    store.setRunDone("r1", "failed", "CI timed out");
    store.setRunDone("r1", "timeout");

    expect(store.runsFor("c1")[0]).toMatchObject({
      status: "timeout",
      summary: "CI timed out",
    });
  });

  it("orders runsFor by started_at, then run_id", () => {
    store.addRun({ runId: "r3", cardId: "c1", role: "reviewer" });
    store.addRun({ runId: "r1", cardId: "c1", role: "implementer" });
    store.addRun({ runId: "r2", cardId: "c1", role: "implementer" });

    // Same-millisecond inserts fall back to run_id order; otherwise the
    // started_at order wins. Both cases are satisfied by sorting the ids
    // when the clock does not advance.
    const ids = store.runsFor("c1").map((r) => r.run_id);
    const starts = store.runsFor("c1").map((r) => r.started_at);
    if (new Set(starts).size === 1) {
      expect(ids).toEqual(["r1", "r2", "r3"]);
    } else {
      const sorted = [...store.runsFor("c1")].sort(
        (a, b) => a.started_at - b.started_at || a.run_id.localeCompare(b.run_id)
      );
      expect(ids).toEqual(sorted.map((r) => r.run_id));
    }
    expect(new Set(ids)).toEqual(new Set(["r1", "r2", "r3"]));
  });

  it("countRuns counts every run for the card", () => {
    expect(store.countRuns("c1")).toBe(0);

    store.addRun({ runId: "r1", cardId: "c1", role: "implementer" });
    store.addRun({ runId: "r2", cardId: "c1", role: "reviewer" });
    expect(store.countRuns("c1")).toBe(2);

    store.setRunDone("r1", "ok", "done");
    // the budget counts history, not just live runs
    expect(store.countRuns("c1")).toBe(2);
  });

  it("activeRuns scopes to one card or spans all cards", () => {
    store.addRun({ runId: "r1", cardId: "c1", role: "implementer" });
    store.addRun({ runId: "r2", cardId: "c1", role: "reviewer" });
    store.addRun({ runId: "r3", cardId: "c2", role: "implementer" });

    expect(store.activeRuns("c1").map((r) => r.run_id).sort()).toEqual([
      "r1",
      "r2",
    ]);
    expect(store.activeRuns("c2").map((r) => r.run_id)).toEqual(["r3"]);
    expect(store.activeRuns().map((r) => r.run_id).sort()).toEqual([
      "r1",
      "r2",
      "r3",
    ]);

    store.setRunDone("r2", "ok", "done");
    expect(store.activeRuns("c1").map((r) => r.run_id)).toEqual(["r1"]);
    expect(store.activeRuns().map((r) => r.run_id).sort()).toEqual([
      "r1",
      "r3",
    ]);
  });

  it("throws on a duplicate run_id", () => {
    store.addRun({ runId: "r1", cardId: "c1", role: "implementer" });

    expect(() =>
      store.addRun({ runId: "r1", cardId: "c1", role: "reviewer" })
    ).toThrow();
    // the original row is untouched, not upserted
    expect(store.runsFor("c1")[0].role).toBe("implementer");
    expect(store.countRuns("c1")).toBe(1);
  });

  it("setRunDone on an unknown run is a harmless no-op", () => {
    expect(() => store.setRunDone("nope", "ok", "nothing")).not.toThrow();

    expect(store.runsFor("c1")).toEqual([]);
    expect(store.countRuns("c1")).toBe(0);
    expect(store.activeRuns()).toEqual([]);
  });

  it("keeps runs isolated per card", () => {
    store.addRun({ runId: "a1", cardId: "cardA", role: "implementer" });
    store.addRun({ runId: "b1", cardId: "cardB", role: "implementer" });

    expect(store.runsFor("cardA").map((r) => r.run_id)).toEqual(["a1"]);
    expect(store.runsFor("cardB").map((r) => r.run_id)).toEqual(["b1"]);
    expect(store.countRuns("cardA")).toBe(1);
    expect(store.countRuns("cardB")).toBe(1);

    store.setRunDone("a1", "ok", "done");
    expect(store.runsFor("cardB")[0].status).toBe("running");
  });

  it("reopening the same file keeps the agent runs", () => {
    store.addRun({ runId: "r1", cardId: "c1", role: "implementer" });
    const again = createStore(path.join(dir, "sub", "test.db"));
    expect(again.countRuns("c1")).toBe(1);
    expect(again.activeRuns("c1")[0].run_id).toBe("r1");
    again.close();
  });
});
