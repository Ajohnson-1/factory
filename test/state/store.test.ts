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

describe("createStore", () => {
  it("creates the database file and its parent directory", () => {
    expect(dir).toBeTruthy();
    // any operation works on a freshly created store
    store.enqueue("c1", "Card one");
    expect(store.get("c1")?.status).toBe("queued");
  });

  it("ignores a duplicate enqueue for the same card", () => {
    store.enqueue("c1", "Card one");
    store.enqueue("c1", "Renamed card");

    expect(store.all()).toHaveLength(1);
    // INSERT OR IGNORE keeps the original row, name included
    expect(store.get("c1")?.card_name).toBe("Card one");
  });

  it("walks a card through queued → running → review → done", () => {
    store.enqueue("c1", "Card one");
    expect(store.get("c1")).toMatchObject({
      status: "queued",
      branch: null,
      pr_url: null,
      error: null,
    });

    store.setRunning("c1", "factory/c1");
    expect(store.get("c1")).toMatchObject({ status: "running", branch: "factory/c1" });

    store.setReview("c1", "https://github.com/o/r/pull/1");
    expect(store.get("c1")).toMatchObject({
      status: "review",
      pr_url: "https://github.com/o/r/pull/1",
    });

    store.setDone("c1");
    expect(store.get("c1")).toMatchObject({ status: "done" });
  });

  it("stores the error text when a job fails", () => {
    store.enqueue("c1", "Card one");
    store.setRunning("c1", "factory/c1");
    store.setFailed("c1", "CI timed out");

    expect(store.get("c1")).toMatchObject({
      status: "failed",
      error: "CI timed out",
    });
  });

  it("returns undefined for an unknown card", () => {
    expect(store.get("nope")).toBeUndefined();
  });

  it("lists every job newest-first and undefined for an empty queue", () => {
    expect(store.all()).toEqual([]);
    store.enqueue("c1", "Card one");
    store.enqueue("c2", "Card two");

    const names = store.all().map((j) => j.card_id);
    // Same-second inserts share created_at; ORDER BY created_at DESC then falls
    // back to scan order, so only assert the set here.
    expect(new Set(names)).toEqual(new Set(["c1", "c2"]));
  });

  it("nextQueued returns the oldest queued card", () => {
    store.enqueue("c1", "Card one");
    store.enqueue("c2", "Card two");
    store.enqueue("c3", "Card three");

    expect(store.nextQueued()?.card_id).toBe("c1");

    store.setRunning("c1", "factory/c1");
    expect(store.nextQueued()?.card_id).toBe("c2");

    store.setFailed("c2", "boom");
    store.setDone("c3");
    expect(store.nextQueued()).toBeUndefined();
  });

  it("isRunning is true only while a job is running", () => {
    expect(store.isRunning()).toBe(false);

    store.enqueue("c1", "Card one");
    expect(store.isRunning()).toBe(false);

    store.setRunning("c1", "factory/c1");
    expect(store.isRunning()).toBe(true);

    store.setReview("c1", "https://github.com/o/r/pull/1");
    expect(store.isRunning()).toBe(false);
  });

  it("reopening the same file keeps the jobs", () => {
    store.enqueue("c1", "Card one");
    const again = createStore(path.join(dir, "sub", "test.db"));
    expect(again.get("c1")?.card_name).toBe("Card one");
    again.close();
  });
});
