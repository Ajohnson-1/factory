/**
 * The `reviews` table (phase 2.3, step 4).
 *
 * Real SQLite throughout, like the rest of `test/state/`: every assertion here is
 * about what two webhook deliveries actually see when they interleave, and a fake
 * store would assert the shape of the code rather than the behaviour of the
 * database. `better-sqlite3` is synchronous, so "concurrent" deliveries are
 * sequential calls — but the *decision* has to be made atomically, which is what
 * these tests pin.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { createStore, type Store } from "../../src/state/store.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

const PR = 7;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const CARD = "card-1";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = makeTempDir("factory-reviews-db-");
  store = createStore(path.join(dir, "factory.db"));
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

function claim(overrides: Partial<Parameters<Store["startReview"]>[0]> = {}) {
  return store.startReview({
    prNumber: PR,
    cardId: CARD,
    headSha: SHA_A,
    maxPerCard: 5,
    ...overrides,
  });
}

describe("startReview — the de-duplication key", () => {
  it("lets the first claim through and writes a running row before anything happens", () => {
    expect(claim()).toEqual({ begin: true });

    const row = store.reviewFor(PR, SHA_A);
    expect(row).toMatchObject({
      pr_number: PR,
      card_id: CARD,
      head_sha: SHA_A,
      status: "running",
      comments: 0,
      summary_posted: 0,
    });
    expect(row?.started_at).toBeGreaterThan(0);
    expect(row?.posted_at).toBeNull();
  });

  /**
   * The whole reason the row exists. A redelivered `opened` is normal traffic — and
   * with a reviewer that posts as it works, a second run for the same head would
   * put the same finding on the PR twice, under a bot's name, forever.
   */
  it("refuses a second claim for the same head while the first is running", () => {
    claim();

    expect(claim()).toEqual({ begin: false, reason: "duplicate" });
    expect(store.countReviews(CARD)).toBe(1);
  });

  it("refuses a head that is already reviewed", () => {
    claim();
    store.markReview(PR, SHA_A, "posted");

    expect(claim()).toEqual({ begin: false, reason: "duplicate" });
  });

  /**
   * A new push is a new diff, and the point of the reviewer is to look at the new
   * one. Keying on the SHA rather than the PR is what allows this while the
   * duplicate guard above still holds.
   */
  it("allows a different head SHA on the same PR", () => {
    claim();
    store.markReview(PR, SHA_A, "posted");

    expect(claim({ headSha: SHA_B })).toEqual({ begin: true });
    expect(store.countReviews(CARD)).toBe(2);
  });

  it("allows the same head on a different PR", () => {
    claim();
    store.markReview(PR, SHA_A, "posted");

    expect(claim({ prNumber: 8 })).toEqual({ begin: true });
  });

  /**
   * Refusing a retry forever is the failure mode this guards against: a review that
   * died because docker sneezed leaves a `failed` row, and the next push to that
   * same head would then be told "already reviewed" and never looked at. Re-claiming
   * resets the counters, because the new run starts from nothing.
   */
  for (const status of ["failed", "skipped"] as const) {
    it(`re-claims a ${status} review and resets what it had posted`, () => {
      claim();
      store.bumpReviewComment(PR, SHA_A);
      store.claimReviewSummary(PR, SHA_A);
      store.markReview(PR, SHA_A, status, { error: "it went wrong" });

      expect(claim()).toEqual({ begin: true });
      expect(store.reviewFor(PR, SHA_A)).toMatchObject({
        status: "running",
        comments: 0,
        summary_posted: 0,
        error: null,
      });
      // A re-claim is one review of one head, not two: the budget must not move.
      expect(store.countReviews(CARD)).toBe(1);
    });
  }
});

describe("startReview — the per-card review budget", () => {
  it("refuses past the cap, counting distinct heads rather than attempts", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(claim({ headSha: `${i}${SHA_A.slice(1)}` })).toEqual({ begin: true });
      store.markReview(PR, `${i}${SHA_A.slice(1)}`, "posted");
    }

    expect(claim({ headSha: "9".repeat(40), maxPerCard: 3 })).toEqual({
      begin: false,
      reason: "budget",
    });
  });

  /**
   * A zero cap has to mean "off", not "unbounded": `num()` reads an unset
   * `REVIEW_MAX_RUNS_PER_CARD` as a number, and the reviewer's cost is the whole
   * reason the knob exists.
   */
  it("refuses everything at a cap of zero", () => {
    expect(claim({ maxPerCard: 0 })).toEqual({ begin: false, reason: "budget" });
    expect(store.countReviews(CARD)).toBe(0);
  });

  /**
   * Distinct head SHAs, because the key is (pr_number, head_sha): two cards both
   * reviewing the same commit on the same PR number would be one row, not two, and
   * this test would be measuring the de-duplication guard instead of the budget.
   */
  it("keeps one card's budget from spending another's", () => {
    claim({ cardId: "c1", headSha: SHA_A, maxPerCard: 1 });
    store.markReview(PR, SHA_A, "posted");

    expect(claim({ cardId: "c2", headSha: SHA_B, maxPerCard: 1 })).toEqual({ begin: true });
    expect(store.countReviews("c1")).toBe(1);
    expect(store.countReviews("c2")).toBe(1);
  });
});

describe("the two counters a review carries", () => {
  it("counts posted line comments up, and reports the running total", () => {
    claim();

    expect(store.bumpReviewComment(PR, SHA_A)).toBe(1);
    expect(store.bumpReviewComment(PR, SHA_A)).toBe(2);
    expect(store.reviewFor(PR, SHA_A)?.comments).toBe(2);
  });

  /**
   * The summary is the one post that must be exactly-once: two of them read as a
   * reviewer that cannot count to one, and the model is quite capable of calling the
   * tool twice with no path.
   */
  it("gives the summary to the first caller and refuses the rest", () => {
    claim();

    expect(store.claimReviewSummary(PR, SHA_A)).toBe(true);
    expect(store.claimReviewSummary(PR, SHA_A)).toBe(false);
    expect(store.reviewFor(PR, SHA_A)?.summary_posted).toBe(1);
  });

  it("hands the summary back to a re-claimed review", () => {
    claim();
    store.claimReviewSummary(PR, SHA_A);
    store.markReview(PR, SHA_A, "failed", { error: "container died" });
    claim();

    expect(store.claimReviewSummary(PR, SHA_A)).toBe(true);
  });

  it("counts a comment against one head without touching another's", () => {
    claim();
    claim({ headSha: SHA_B });
    store.bumpReviewComment(PR, SHA_A);
    store.bumpReviewComment(PR, SHA_A);

    expect(store.reviewFor(PR, SHA_A)?.comments).toBe(2);
    expect(store.reviewFor(PR, SHA_B)?.comments).toBe(0);
  });
});

describe("markReview", () => {
  it("closes a review with its usage and a posted time", () => {
    claim();

    store.markReview(PR, SHA_A, "posted", {
      usage: { input: 9_000, output: 400, cacheRead: 60_000 },
    });

    expect(store.reviewFor(PR, SHA_A)).toMatchObject({
      status: "posted",
      usage_in: 9_000,
      usage_out: 400,
      usage_cache_read: 60_000,
      error: null,
    });
    expect(store.reviewFor(PR, SHA_A)?.posted_at).toBeGreaterThan(0);
  });

  /**
   * Same NULL-not-zero rule as `agent_runs`. A review that never reached a
   * `message_end` has an unknown cost, and an unknown cost displayed as 0 is how a
   * budget looks like it is working when it is not.
   */
  it("leaves usage NULL when the run reported none", () => {
    claim();

    store.markReview(PR, SHA_A, "failed", { error: "docker refused to start" });

    expect(store.reviewFor(PR, SHA_A)).toMatchObject({
      status: "failed",
      usage_in: null,
      usage_out: null,
      usage_cache_read: null,
      error: "docker refused to start",
    });
  });
});

describe("reviewFor / countReviews", () => {
  /**
   * `startReview` refuses with a bare reason; the row behind it is what turns
   * "already reviewed" into something an operator can act on — which PR, which
   * head, and whether it posted or merely started and died.
   */
  it("reads one review back by the pair that identifies it", () => {
    claim({ headSha: SHA_B });
    store.markReview(PR, SHA_B, "posted");

    const row = store.reviewFor(PR, SHA_B);
    expect(row).toMatchObject({ pr_number: PR, head_sha: SHA_B, status: "posted" });
    expect(store.reviewFor(PR, SHA_A)).toBeUndefined();
  });

  it("counts a card's reviews, and only its own", () => {
    claim({ headSha: SHA_A });
    claim({ headSha: SHA_B });
    claim({ cardId: "other", headSha: "c".repeat(40) });

    expect(store.countReviews(CARD)).toBe(2);
    expect(store.countReviews("other")).toBe(1);
    expect(store.countReviews("nobody")).toBe(0);
  });
});

describe("usageByReviewCard", () => {
  /**
   * Why reviews are not rows in `agent_runs`: they still cost tokens, and a card's
   * money view that silently omits them is a worse lie than one that has no number
   * at all.
   */
  it("sums review spend per card, separately from graph spend", () => {
    claim({ headSha: SHA_A });
    store.markReview(PR, SHA_A, "posted", {
      usage: { input: 100, output: 10, cacheRead: 1_000 },
    });
    claim({ headSha: SHA_B });
    store.markReview(PR, SHA_B, "posted", {
      usage: { input: 200, output: 20, cacheRead: 2_000 },
    });

    expect(store.usageByReviewCard()).toEqual([
      {
        card_id: CARD,
        reviews: 2,
        reported: 2,
        input: 300,
        output: 30,
        cache_read: 3_000,
      },
    ]);
    // And the graph's own total is untouched by any of it.
    expect(store.usageByCard()).toEqual([]);
  });
});

describe("reviews and the boot sweep", () => {
  /**
   * The bug this pin prevents is quiet and permanent: a process killed mid-review
   * leaves a `running` row, and `startReview` refuses a running row forever. Without
   * the sweep, every later delivery for that head is silently skipped and the only
   * fix is deleting a row by hand from a production database.
   */
  it("reaps a running review so its head becomes reviewable again", () => {
    claim();

    const reaped = store.reapStale();

    expect(reaped.reviews).toEqual([{ pr_number: PR, card_id: CARD }]);
    expect(store.reapStale().reviews).toEqual([]);
    expect(store.reviewFor(PR, SHA_A)).toMatchObject({ status: "failed" });
    expect(claim()).toEqual({ begin: true });
  });

  it("never reaps a review that has already posted", () => {
    claim();
    store.markReview(PR, SHA_A, "posted");

    expect(store.reapStale().reviews).toEqual([]);
    expect(store.reviewFor(PR, SHA_A)?.status).toBe("posted");
  });
});
