/**
 * Worker boot (`src/worker/queue.ts`) — open-issues #3.
 *
 * Nothing in the factory ever closed an `agent_runs` row that a killed process
 * left `running`, so `/factory status` listed children that would never finish
 * and those rows counted against the card's budget forever. The sweep fixes it,
 * but only because of *when* it runs: at boot, nothing in this process can be
 * live, which is the only moment a `running` row is provably stale. These tests
 * pin that ordering, because a sweep on a timer would reap the card the worker
 * is running right now.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Store } from "../../src/state/store.js";
import type { DiscordBot } from "../../src/discord/bot.js";

// The queue's two collaborators, both of which would reach the outside world:
// the default SQLite file and a real `runCard`.
const fakeStore = {
  isRunning: vi.fn((): boolean => false),
  nextQueued: vi.fn((): { card_id: string; card_name: string } | undefined => undefined),
  reapStale: vi.fn(() => ({ runs: [], jobs: [], reviews: [] })),
};
const runCard = vi.fn(async () => {});
// `isPaused()` reads `data/paused` off the disk. Left real, this file would pass
// on a clean checkout and fail on a dev box that has ever run `/factory pause` —
// so the tick's other gate is stubbed to "not paused" and pinned here.
const isPaused = vi.fn((): boolean => false);

vi.mock("../../src/state/store.js", () => ({ store: fakeStore }));
vi.mock("../../src/worker/runner.js", () => ({ runCard }));
vi.mock("../../src/discord/bot.js", () => ({ isPaused }));

beforeEach(() => {
  fakeStore.isRunning.mockClear();
  fakeStore.nextQueued.mockClear();
  fakeStore.reapStale.mockClear();
  runCard.mockClear();
  isPaused.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reapOrphans", () => {
  it("logs what it reaped, by card, because operators are watching", async () => {
    const { reapOrphans } = await import("../../src/worker/queue.js");
    const store = {
      reapStale: () => ({
        runs: [
          { run_id: "c1", card_id: "card-a", role: "coder" },
          { run_id: "c2", card_id: "card-a", role: "verifier" },
          { run_id: "c1", card_id: "card-b", role: "coder" },
        ],
        jobs: [{ card_id: "card-a", card_name: "Card A" }],
        reviews: [{ pr_number: 7, card_id: "card-a" }],
      }),
    } as unknown as Store;
    const lines: string[] = [];

    reapOrphans(store, (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reaped 3 stale agent run(s), 1 running job(s), 1 stale review(s)");
    // Card ids, deduplicated: three dead children is one dead card's mess.
    expect(lines[0]).toContain("card-a, card-b");
  });

  /**
   * The review half is not decoration. A `running` review row makes its head SHA
   * permanently unreviewable, so a boot sweep that logs runs and jobs but not
   * reviews would leave an operator looking at a card that silently never gets
   * reviewed again.
   */
  it("reports a card whose only orphan was a review", async () => {
    const { reapOrphans } = await import("../../src/worker/queue.js");
    const store = {
      reapStale: () => ({
        runs: [],
        jobs: [],
        reviews: [{ pr_number: 7, card_id: "card-c" }],
      }),
    } as unknown as Store;
    const lines: string[] = [];

    reapOrphans(store, (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 stale review(s)");
    expect(lines[0]).toContain("card-c");
  });

  it("says nothing when nothing was mid-flight", async () => {
    const { reapOrphans } = await import("../../src/worker/queue.js");
    const store = {
      reapStale: () => ({ runs: [], jobs: [], reviews: [] }),
    } as unknown as Store;
    const lines: string[] = [];

    reapOrphans(store, (line) => lines.push(line));

    expect(lines).toEqual([]);
  });

  it("reaps through the store, which is the only place that knows what is running", async () => {
    const { reapOrphans } = await import("../../src/worker/queue.js");
    const reapStale = vi.fn(() => ({ runs: [], jobs: [], reviews: [] }));

    reapOrphans({ reapStale } as unknown as Store, () => {});

    expect(reapStale).toHaveBeenCalledTimes(1);
  });
});

describe("startWorker boot", () => {
  it("sweeps before the first tick, exactly once, and never on the timer", async () => {
    const { startWorker } = await import("../../src/worker/queue.js");

    await startWorker({} as DiscordBot);

    // Before any timer has advanced: the sweep is already done, and no card has
    // been started. This ordering is the whole reason the sweep is safe.
    expect(fakeStore.reapStale).toHaveBeenCalledTimes(1);
    expect(runCard).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15_000 * 5);
    await Promise.resolve();

    expect(fakeStore.reapStale).toHaveBeenCalledTimes(1);
  });

  it("still starts its normal poll after sweeping", async () => {
    const { startWorker } = await import("../../src/worker/queue.js");
    fakeStore.nextQueued.mockReturnValue({ card_id: "card-1", card_name: "Card one" });

    await startWorker({} as DiscordBot);
    vi.advanceTimersByTime(15_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(fakeStore.isRunning).toHaveBeenCalled();
    expect(runCard).toHaveBeenCalledWith("card-1", expect.anything());
  });
});
