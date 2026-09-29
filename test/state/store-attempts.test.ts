/**
 * Attempts, generations, token usage and the boot sweep — plan/open-issues.md
 * #1, #3 and the storage half of #6.
 *
 * All of it is about one column that did not exist before: `agent_runs.attempt`.
 * The budget check that reads it used to read the whole history of a card, which
 * meant a card that failed once could never work again. These tests are the
 * reason it cannot silently go back to that.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { createStore, type Store } from "../../src/state/store.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

let dir: string;
let file: string;
let store: Store;

beforeEach(() => {
  dir = makeTempDir();
  file = path.join(dir, "test.db");
  store = createStore(file);
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

function queue(cardId = "c1", name = "Card one"): void {
  store.enqueue(cardId, name);
}

describe("enqueue as the only re-trigger path", () => {
  it("queues a card it has never seen at generation 1", () => {
    const result = store.enqueue("c1", "Card one");

    expect(result).toEqual({ queued: true, requeued: false, generation: 1 });
    expect(store.attemptFor("c1")).toBe(1);
  });

  it("ignores a duplicate enqueue for a queued card, name included", () => {
    store.enqueue("c1", "Card one");
    const again = store.enqueue("c1", "Renamed card");

    expect(again.queued).toBe(false);
    expect(store.all()).toHaveLength(1);
    expect(store.get("c1")?.card_name).toBe("Card one");
    expect(store.attemptFor("c1")).toBe(1);
  });

  it("re-queues a failed card and moves it to the next attempt", () => {
    queue();
    store.setRunning("c1", "factory/c1");
    store.setFailed("c1", "the merge clashed");

    const result = store.enqueue("c1", "Card one, retyped");

    expect(result).toEqual({ queued: true, requeued: true, generation: 2 });
    expect(store.get("c1")).toMatchObject({
      status: "queued",
      error: null,
      card_name: "Card one, retyped",
    });
    expect(store.attemptFor("c1")).toBe(2);
  });

  /**
   * The other half of #1. A webhook that fires while a card is running — a
   * double drag, a retried delivery — must not put a second graph on top of the
   * first one: they would fight over the same worktree and both spend runs.
   */
  it("refuses to re-queue a card that is running", () => {
    queue();
    store.setRunning("c1", "factory/c1");

    const result = store.enqueue("c1", "Card one");

    expect(result).toEqual({ queued: false, requeued: false, generation: 1 });
    expect(store.get("c1")?.status).toBe("running");
    expect(store.attemptFor("c1")).toBe(1);
  });

  it("treats a card that reached Review or Done as finished, so it can be re-run", () => {
    for (const [index, finish] of [
      (cardId: string) => store.setReview(cardId, "https://x/pull/1"),
      (cardId: string) => store.setDone(cardId),
    ].entries()) {
      const cardId = `c${index}`;
      queue(cardId);
      store.setRunning(cardId, `factory/${cardId}`);
      finish(cardId);

      expect(store.enqueue(cardId, "again").generation).toBe(2);
    }
  });

  it("gives an unknown card attempt 1 rather than throwing", () => {
    expect(store.attemptFor("never-seen")).toBe(1);
  });
});

describe("run budget scoped to one attempt", () => {
  it("does not count an exhausted attempt against the one now running", () => {
    queue();
    for (const runId of ["a", "b", "c"]) {
      store.addRun({ runId, cardId: "c1", role: "coder", attempt: 1 });
      store.setRunDone("c1", runId, "failed", "nope");
    }
    // The card failed, the operator dragged it back, generation is now 2.
    store.setRunning("c1", "factory/c1");
    store.setFailed("c1", "budget");
    store.enqueue("c1", "Card one");

    expect(store.attemptFor("c1")).toBe(2);
    expect(store.countRuns("c1", 2)).toBe(0);
    expect(store.countRuns("c1", 1)).toBe(3);
    // Unscoped still means "everything", which is what a cost question wants.
    expect(store.countRuns("c1")).toBe(3);
  });

  it("keeps runsFor scoped, and returns both attempts when unscoped", () => {
    queue();
    store.addRun({ runId: "a", cardId: "c1", role: "coder", attempt: 1 });
    store.setRunDone("c1", "a", "ok", "landed");
    store.addRun({ runId: "b", cardId: "c1", role: "coder", attempt: 2 });
    store.setRunDone("c1", "b", "ok", "landed again");

    expect(store.runsFor("c1", 1).map((r) => r.run_id)).toEqual(["a"]);
    expect(store.runsFor("c1", 2).map((r) => r.run_id)).toEqual(["b"]);
    expect(store.runsFor("c1").map((r) => r.run_id)).toEqual(["a", "b"]);
  });

  it("defaults a run recorded without an attempt to the first one", () => {
    store.addRun({ runId: "a", cardId: "c1", role: "coder" });

    expect(store.runsFor("c1")[0].attempt).toBe(1);
    expect(store.countRuns("c1", 1)).toBe(1);
  });
});

describe("token usage", () => {
  it("records usage when the run closes", () => {
    store.addRun({ runId: "a", cardId: "c1", role: "coder" });

    store.setRunDone("c1", "a", "ok", "landed", { input: 1200, output: 340, cacheRead: 9000 });

    expect(store.runsFor("c1")[0]).toMatchObject({
      usage_in: 1200,
      usage_out: 340,
      usage_cache_read: 9000,
    });
  });

  /**
   * A run that reported nothing must not read as a run that cost nothing: NULL
   * and 0 are different claims, and only one of them is supportable.
   */
  it("leaves usage NULL when the runtime reported none", () => {
    store.addRun({ runId: "a", cardId: "c1", role: "coder" });

    store.setRunDone("c1", "a", "timeout", "timed out");

    expect(store.runsFor("c1")[0]).toMatchObject({
      usage_in: null,
      usage_out: null,
      usage_cache_read: null,
    });
  });

  it("sums per card across attempts, which is the money view", () => {
    for (const attempt of [1, 2, 3]) {
      store.addRun({ runId: `r${attempt}`, cardId: "c1", role: "coder", attempt });
      store.setRunDone("c1", `r${attempt}`, "ok", "landed", {
        input: 100 * (attempt + 1),
        output: 10,
        cacheRead: 5,
      });
    }
    store.addRun({ runId: "other", cardId: "c2", role: "coder" });
    store.setRunDone("c2", "other", "ok", "landed");

    expect(store.usageByCard()).toEqual([
      { card_id: "c1", runs: 3, reported: 3, input: 900, output: 30, cache_read: 15 },
      // c2's one run reported nothing: the sums are 0 because SQL says so, and
      // `reported: 0` is the only thing that keeps that from reading as free.
      { card_id: "c2", runs: 1, reported: 0, input: 0, output: 0, cache_read: 0 },
    ]);
  });

  it("counts only the runs that reported usage, so a mixed card is readable", () => {
    store.addRun({ runId: "a", cardId: "c1", role: "coder" });
    store.addRun({ runId: "b", cardId: "c1", role: "coder" });
    store.addRun({ runId: "c", cardId: "c1", role: "coder" });
    store.setRunDone("c1", "a", "ok", "landed", { input: 500, output: 50, cacheRead: 0 });
    store.setRunDone("c1", "b", "timeout", "timed out");
    store.setRunDone("c1", "c", "ok", "landed", { input: 500, output: 50, cacheRead: 0 });

    expect(store.usageByCard()).toEqual([
      { card_id: "c1", runs: 3, reported: 2, input: 1000, output: 100, cache_read: 0 },
    ]);
  });
});

describe("reapStale — the boot sweep", () => {
  it("fails every row the previous process left mid-flight", () => {
    queue();
    store.setRunning("c1", "factory/c1");
    store.addRun({ runId: "a", cardId: "c1", role: "coder" });
    store.addRun({ runId: "b", cardId: "c1", role: "verifier" });

    const reaped = store.reapStale();

    expect(reaped.runs.map((r) => r.run_id)).toEqual(["a", "b"]);
    expect(reaped.jobs.map((j) => j.card_id)).toEqual(["c1"]);
    expect(store.runsFor("c1").map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(store.runsFor("c1")[0].summary).toContain("reaped");
    expect(typeof store.runsFor("c1")[0].ended_at).toBe("number");
    expect(store.get("c1")).toMatchObject({ status: "failed", error: /reaped/ });
    // The gate in queue.ts is what #2 is about; a reaped card releases it.
    expect(store.isRunning()).toBe(false);
    expect(store.activeRuns()).toEqual([]);
  });

  it("does nothing, and reports nothing, on a clean database", () => {
    queue();
    store.setRunning("c1", "factory/c1");
    store.addRun({ runId: "a", cardId: "c1", role: "coder" });
    store.setRunDone("c1", "a", "ok", "landed");
    // The card finished cleanly, so nothing in here is mid-flight any more.
    store.setReview("c1", "https://x/pull/1");

    expect(store.reapStale()).toEqual({ runs: [], jobs: [] });
    expect(store.runsFor("c1")[0].status).toBe("ok");
    expect(store.get("c1")?.status).toBe("review");
  });

  it("is idempotent — a second sweep reaps what the first one already closed", () => {
    queue();
    store.setRunning("c1", "factory/c1");
    store.addRun({ runId: "a", cardId: "c1", role: "coder" });

    store.reapStale();
    const second = store.reapStale();

    expect(second).toEqual({ runs: [], jobs: [] });
  });

  /**
   * Reaped rows still count against the attempt they belonged to — they spent
   * real tokens. What makes #1 survivable is that they no longer count against
   * the *next* attempt.
   */
  it("leaves a reaped attempt's rows counted, while the next attempt starts clean", () => {
    queue();
    store.setRunning("c1", "factory/c1");
    store.addRun({ runId: "a", cardId: "c1", role: "coder", attempt: 1 });

    store.reapStale();
    store.enqueue("c1", "Card one");

    expect(store.countRuns("c1", 1)).toBe(1);
    expect(store.countRuns("c1", store.attemptFor("c1"))).toBe(0);
  });
});

describe("migration — CREATE TABLE IF NOT EXISTS does not add a column", () => {
  /** A database exactly as phase 2.2 wrote it: no `attempt`, no `generation`. */
  function buildOldDatabase(at: string): void {
    const db = new Database(at);
    db.exec(`
      CREATE TABLE jobs (
        card_id TEXT PRIMARY KEY,
        card_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        branch TEXT,
        pr_url TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE agent_runs (
        run_id     TEXT PRIMARY KEY,
        card_id    TEXT NOT NULL,
        role       TEXT NOT NULL,
        status     TEXT NOT NULL,
        branch     TEXT,
        worktree   TEXT,
        summary    TEXT,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER
      );
      CREATE INDEX agent_runs_card_id ON agent_runs(card_id);
    `);
    db.prepare(
      `INSERT INTO jobs (card_id, card_name, status) VALUES ('old-1', 'Legacy card', 'running')`
    ).run();
    db.prepare(
      `INSERT INTO agent_runs (run_id, card_id, role, status, started_at)
         VALUES ('old-run', 'old-1', 'coder', 'ok', 1000)`
    ).run();
    db.close();
  }

  it("adds the missing columns to a live database instead of failing on them", () => {
    const at = path.join(dir, "old.db");
    buildOldDatabase(at);

    const reopened = createStore(at);
    const db = new Database(at);
    const of = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(of("jobs")).toContain("generation");
    expect(of("agent_runs")).toEqual(
      expect.arrayContaining(["attempt", "usage_in", "usage_out", "usage_cache_read"])
    );
    db.close();

    // Old rows read back as the card's first attempt, which is the only honest
    // default: they predate the concept.
    expect(reopened.runsFor("old-1")[0].attempt).toBe(1);
    expect(reopened.countRuns("old-1", 1)).toBe(1);
    expect(reopened.attemptFor("old-1")).toBe(1);
    expect(reopened.get("old-1")?.status).toBe("running");
    // Rows written before the usage columns existed are NULL rather than 0,
    // which is the whole point of `reported`: a migrated database has spent an
    // unknown amount, and `0 in / 0 out` would be the wrong kind of certain.
    expect(reopened.usageByCard()).toEqual([
      { card_id: "old-1", runs: 1, reported: 0, input: 0, output: 0, cache_read: 0 },
    ]);

    reopened.close();
  });

  it("gains the index the scoped count needs, so an old database is not left scanning", () => {
    const at = path.join(dir, "old2.db");
    buildOldDatabase(at);
    const reopened = createStore(at);
    const db = new Database(at);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_runs'`)
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain("agent_runs_card_attempt");
    db.close();
    reopened.close();
  });

  /**
   * The key is part of the migration, not a nice-to-have: the old table was keyed
 * on `run_id` alone while every spawner numbers its children from `c1`, so a
 * live database had exactly one card's worth of run ids left in it.
   */
  it("re-keys an old table so a second card can record its first child", () => {
    const at = path.join(dir, "old4.db");
    buildOldDatabase(at);

    const reopened = createStore(at);

    // The one row the old table had, read back through the new key.
    expect(reopened.countRuns("old-1")).toBe(1);
    expect(() =>
      reopened.addRun({ runId: "old-run", cardId: "old-1", role: "coder" })
    ).toThrow();
    // And the collision that used to be fatal: same id, different card.
    expect(() =>
      reopened.addRun({ runId: "old-run", cardId: "another-card", role: "coder" })
    ).not.toThrow();
    expect(reopened.countRuns("another-card")).toBe(1);
    expect(reopened.countRuns("old-1")).toBe(1);

    // Closing one must not close the other, which is why `setRunDone` now takes
    // the card as well as the run.
    reopened.setRunDone("another-card", "old-run", "failed", "only this card's row");
    expect(reopened.runsFor("another-card")[0]).toMatchObject({
      status: "failed",
      summary: "only this card's row",
    });
    expect(reopened.runsFor("old-1")[0]).toMatchObject({ status: "ok", summary: null });
    reopened.close();
  });

  it("does not disturb a database that is already current", () => {
    queue();
    store.addRun({ runId: "a", cardId: "c1", role: "coder", attempt: 4 });
    store.setRunDone("c1", "a", "ok", "landed", { input: 7, output: 8, cacheRead: 9 });
    store.close();

    const reopened = createStore(file);

    expect(reopened.runsFor("c1")[0]).toMatchObject({
      attempt: 4,
      usage_in: 7,
      usage_out: 8,
      usage_cache_read: 9,
    });
    expect(reopened.countRuns("c1", 4)).toBe(1);
    // afterEach closes it; closing it here would make that a double close.
    store = reopened;
  });
});
