import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EmbedBuilder } from "discord.js";
import {
  cardFromBranch,
  handleGitHubWebhook,
  verifySignature,
  type GitHubPRPayload,
  type GitHubWebhookDeps,
} from "../../src/github/webhook.js";
import { createStore, type Store } from "../../src/state/store.js";
import type { ReviewOutcome } from "../../src/reviewer/reviewer.js";
import type { DiscordBot } from "../../src/discord/bot.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

type MockFn = ReturnType<typeof vi.fn>;
type FakeTrello = NonNullable<GitHubWebhookDeps["trello"]>;

const SECRET = "hook-secret";
const DONE_LIST = "list-done";
const CARD = "card-1";
const CARD_NAME = "Build the thing";
const PR_URL = "https://github.com/acme/widgets/pull/7";
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface FakeRes {
  writeHead: MockFn;
  end: MockFn;
}

interface DeliverOptions {
  event?: string;
  body?: string;
  signature?: string;
  deps?: GitHubWebhookDeps;
}

let dir: string;
let store: Store;
let send: MockFn;
let bot: DiscordBot;
let trelloFake: FakeTrello;
let moveCard: MockFn;
let addComment: MockFn;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("TRELLO_API_KEY", "key");
  vi.stubEnv("TRELLO_TOKEN", "token");
  vi.stubEnv("TRELLO_BOARD_ID", "board-1");
  vi.stubEnv("READY_LIST_ID", "list-ready");
  vi.stubEnv("REVIEW_LIST_ID", "list-review");
  vi.stubEnv("DONE_LIST_ID", DONE_LIST);
  dir = makeTempDir();
  store = createStore(path.join(dir, "test.db"));
  send = vi.fn();
  bot = { send } as unknown as DiscordBot;
  moveCard = vi.fn();
  addComment = vi.fn();
  trelloFake = {
    getCard: vi.fn(),
    moveCard,
    addComment,
    createWebhook: vi.fn(),
  } as unknown as FakeTrello;
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

/** Build a webhook request the way GitHub posts one: signed raw body. */
function delivery(
  body: string,
  options: { event?: string; signature?: string } = {}
): { req: IncomingMessage; res: FakeRes } {
  const res: FakeRes = { writeHead: vi.fn(), end: vi.fn() };
  const req = Object.assign(Readable.from([body]), {
    headers: {
      "x-github-event": options.event ?? "pull_request",
      "x-hub-signature-256": options.signature ?? sign(body),
      "content-type": "application/json",
    },
  }) as unknown as IncomingMessage;
  return { req, res };
}

/** A `closed` + `merged` payload for a factory branch (or a non-factory one). */
function mergedPayload(cardId: string | null = CARD): GitHubPRPayload {
  return {
    action: "closed",
    pull_request: {
      number: 7,
      state: "closed",
      draft: false,
      merged: true,
      html_url: PR_URL,
      head: { ref: cardId === null ? "main" : `factory/${cardId}`, sha: SHA },
    },
  };
}

/** An `opened`/`synchronized` payload — the two actions that start a review. */
function prPayload(
  action: "opened" | "synchronized",
  cardId: string | null = CARD,
  overrides: Partial<GitHubPRPayload["pull_request"]> = {}
): GitHubPRPayload {
  return {
    action,
    pull_request: {
      number: 7,
      state: "open",
      draft: false,
      merged: false,
      html_url: PR_URL,
      head: { ref: cardId === null ? "main" : `factory/${cardId}`, sha: SHA },
      ...overrides,
    },
  };
}

async function deliver(
  payload: Partial<GitHubPRPayload>,
  options: DeliverOptions = {}
): Promise<FakeRes> {
  const { req, res } = delivery(options.body ?? JSON.stringify(payload), options);
  await handleGitHubWebhook(
    req,
    res as unknown as ServerResponse,
    bot,
    options.deps ?? { store, trello: trelloFake }
  );
  return res;
}

function expectJson(res: FakeRes, status: number, body: unknown): void {
  expect(res.writeHead).toHaveBeenCalledWith(status, {
    "Content-Type": "application/json",
  });
  expect(res.end).toHaveBeenCalledWith(JSON.stringify(body));
}

describe("verifySignature", () => {
  it("accepts anything when no secret is configured", () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    expect(verifySignature(request({}), "{}")).toBe(true);
  });

  it("rejects a request with no signature header", () => {
    expect(verifySignature(request({}), "{}")).toBe(false);
  });

  it("accepts a matching HMAC signature", () => {
    const body = JSON.stringify({ action: "closed" });
    const req = request({ "x-hub-signature-256": sign(body) });
    expect(verifySignature(req, body)).toBe(true);
  });

  it("rejects a signature computed over a different body", () => {
    const req = request({
      "x-hub-signature-256": sign(JSON.stringify({ action: "closed" })),
    });
    expect(verifySignature(req, JSON.stringify({ action: "opened" }))).toBe(false);
  });

  it("rejects a malformed signature instead of throwing", () => {
    const req = request({ "x-hub-signature-256": "sha256=tooshort" });
    expect(() => verifySignature(req, "{}")).not.toThrow();
    expect(verifySignature(req, "{}")).toBe(false);
  });
});

describe("handleGitHubWebhook", () => {
  it("ignores an event that is not a pull_request", async () => {
    const res = await deliver({}, { event: "ping" });

    expectJson(res, 200, { ignored: "ping" });
    expect(store.all()).toEqual([]);
  });

  it("ignores a delivery with no event header", async () => {
    const res: FakeRes = { writeHead: vi.fn(), end: vi.fn() };
    const req = Object.assign(Readable.from(["{}"]), {
      headers: {},
    }) as unknown as IncomingMessage;

    await handleGitHubWebhook(
      req,
      res as unknown as ServerResponse,
      bot,
      { store, trello: trelloFake }
    );

    expectJson(res, 200, { ignored: "unknown" });
  });

  it("rejects a delivery whose signature covers a different body", async () => {
    const res = await deliver(mergedPayload(), {
      signature: sign(JSON.stringify({ action: "closed" })),
    });

    expectJson(res, 401, { error: "bad signature" });
    expect(store.all()).toEqual([]);
  });

  it("ignores a closed pull request that was not merged", async () => {
    const payload = mergedPayload();
    payload.pull_request.merged = false;

    const res = await deliver(payload);

    expectJson(res, 200, { ignored: "not a merge" });
    expect(store.all()).toEqual([]);
  });

  /**
   * This assertion used to read `{ignored: "not a merge"}` for `opened`, which was
   * correct until 2.3 gave that action a job. Kept as the pin it was — the merge
   * path must not fire on `opened` — expressed as what actually proves it.
   */
  it("does not treat an opened pull request as a merge", async () => {
    store.enqueue(CARD, CARD_NAME);
    const reviewPr = vi.fn();
    const payload = mergedPayload();
    payload.action = "opened";

    const res = await deliver(payload, { deps: { store, trello: trelloFake, reviewPr } });

    expectJson(res, 200, { review: "queued", card: CARD, pr: 7 });
    expect(store.get(CARD)?.status).not.toBe("done");
    expect(moveCard).not.toHaveBeenCalled();
  });

  it("ignores a merged pull request on a branch outside factory/", async () => {
    const res = await deliver(mergedPayload(null));

    expectJson(res, 200, { ignored: "not a factory branch" });
  });

  it("ignores a merged factory branch with no matching job", async () => {
    const res = await deliver(mergedPayload("card-missing"));

    expectJson(res, 200, { ignored: "unknown card" });
  });
});

describe("handleGitHubWebhook on a merged factory PR", () => {
  beforeEach(() => {
    store.enqueue(CARD, CARD_NAME);
    store.setRunning(CARD, `factory/${CARD}`);
    store.setReview(CARD, PR_URL);
  });

  it("marks the job done", async () => {
    await deliver(mergedPayload());

    expect(store.get(CARD)).toMatchObject({ status: "done" });
  });

  it("moves the Trello card to the done list", async () => {
    await deliver(mergedPayload());

    expect(moveCard).toHaveBeenCalledWith(CARD, DONE_LIST);
  });

  it("comments on the card with the pull request url", async () => {
    await deliver(mergedPayload());

    expect(addComment).toHaveBeenCalledWith(
      CARD,
      expect.stringContaining(PR_URL)
    );
  });

  it("sends the done embed to Discord", async () => {
    await deliver(mergedPayload());

    expect(send).toHaveBeenCalledTimes(1);
    const embed = send.mock.calls[0][0] as EmbedBuilder;
    expect(embed.data.title).toBe("🎉 Merged — card done");
    expect(JSON.stringify(embed.data.fields)).toContain(PR_URL);
  });

  it("answers with the card id", async () => {
    const res = await deliver(mergedPayload());

    expectJson(res, 200, { done: CARD });
  });

  it("still finishes the job when the Trello update fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    moveCard.mockRejectedValue(new Error("trello down"));

    const res = await deliver(mergedPayload());

    expect(store.get(CARD)).toMatchObject({ status: "done" });
    expectJson(res, 200, { done: CARD });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("still answers when Discord is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockRejectedValue(new Error("discord down"));

    const res = await deliver(mergedPayload());

    // silence here means no response, a GitHub timeout and a redelivered embed
    expect(store.get(CARD)).toMatchObject({ status: "done" });
    expectJson(res, 200, { done: CARD });
  });
});

describe("handleGitHubWebhook with no injected store", () => {
  it("reports an unknown card instead of throwing", async () => {
    const res = await deliver(mergedPayload("card-elsewhere"), {
      deps: { trello: trelloFake },
    });

    expectJson(res, 200, { ignored: "unknown card" });
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * 2.3 — the review half of the dispatcher.
 *
 * `reviewPr` is injected rather than mocked at the module because the webhook
 * already has a deps seam and the review path's whole contract is "call this
 * function and answer immediately". A `vi.mock` would hide the one thing worth
 * asserting here: the arguments the reviewer is handed.
 */
type ReviewFn = NonNullable<GitHubWebhookDeps["reviewPr"]>;

function reviewSpy(implementation?: ReviewFn): MockFn {
  return vi.fn(
    implementation ??
      (async (): Promise<ReviewOutcome> => ({
        status: "posted",
        comments: 1,
        summaryPosted: true,
      }))
  );
}

describe("cardFromBranch", () => {
  it("reads a card id out of a factory branch", () => {
    expect(cardFromBranch("factory/card-1")).toBe("card-1");
  });

  it("keeps a slash-containing id whole, which is what the merge path matches on", () => {
    expect(cardFromBranch("factory/a/b")).toBe("a/b");
  });

  it("returns nothing for main, a feature branch, or a near miss", () => {
    expect(cardFromBranch("main")).toBeUndefined();
    expect(cardFromBranch("feature/card-1")).toBeUndefined();
    expect(cardFromBranch("factory/")).toBeUndefined();
    expect(cardFromBranch("notfactory/card-1")).toBeUndefined();
  });
});

describe("handleGitHubWebhook review path", () => {
  let reviewPr: MockFn;

  beforeEach(() => {
    reviewPr = reviewSpy();
    store.enqueue(CARD, CARD_NAME);
  });

  function deliverReview(payload: GitHubPRPayload, review: MockFn | ReviewFn = reviewPr) {
    return deliver(payload, {
      deps: { store, trello: trelloFake, reviewPr: review as ReviewFn },
    });
  }

  it("queues a review on `opened` for a factory PR and says so", async () => {
    const res = await deliverReview(prPayload("opened"));

    expectJson(res, 200, { review: "queued", card: CARD, pr: 7 });
    expect(reviewPr).toHaveBeenCalledTimes(1);
    expect(reviewPr.mock.calls[0][0]).toBe(CARD);
    expect(reviewPr.mock.calls[0][1]).toEqual({
      number: 7,
      htmlUrl: PR_URL,
      headRef: `factory/${CARD}`,
      headSha: SHA,
    });
  });

  it("hands the review the same store and bot the webhook is using", async () => {
    await deliverReview(prPayload("opened"));

    const deps = reviewPr.mock.calls[0][2] as { store: Store; bot: DiscordBot };
    expect(deps.store).toBe(store);
    expect(deps.bot).toBe(bot);
  });

  it("queues a review again on `synchronized`, because a new head is a new diff", async () => {
    const res = await deliverReview(prPayload("synchronized"));

    expectJson(res, 200, { review: "queued", card: CARD, pr: 7 });
    expect(reviewPr).toHaveBeenCalledTimes(1);
  });

  it("does not review a PR outside factory/", async () => {
    const res = await deliverReview(prPayload("opened", null));

    expectJson(res, 200, { ignored: "not a factory branch" });
    expect(reviewPr).not.toHaveBeenCalled();
  });

  it("does not review a factory branch the factory has no job for", async () => {
    const res = await deliverReview(prPayload("opened", "card-nobody-queued"));

    expectJson(res, 200, { ignored: "unknown card", card: "card-nobody-queued" });
    expect(reviewPr).not.toHaveBeenCalled();
  });

  /**
   * GitHub sends `opened` for a draft too, and a draft is an author who has said
   * out loud that the diff is not finished. Reviewing one spends a model on work
   * in progress and posts findings on it.
   */
  it("does not review a draft", async () => {
    const res = await deliverReview(prPayload("opened", CARD, { draft: true }));

    expectJson(res, 200, { ignored: "draft", card: CARD });
    expect(reviewPr).not.toHaveBeenCalled();
  });

  /**
   * The definition-of-done line: no review may block the webhook. Answered before
   * the review is even started, which is only observable if the review is left
   * pending — so this test resolves nothing until after the assertion.
   */
  it("answers while the review is still running", async () => {
    let finishReview!: (outcome: ReviewOutcome) => void;
    const pending = new Promise<ReviewOutcome>((resolve) => {
      finishReview = resolve;
    });
    const res = await deliverReview(prPayload("opened"), vi.fn(() => pending));

    expectJson(res, 200, { review: "queued", card: CARD, pr: 7 });
    // Still unanswered: had the handler awaited it, `deliver` would never have
    // returned and this line would be unreachable.
    expect(res.writeHead).toHaveBeenCalledTimes(1);
    finishReview({ status: "posted", comments: 0, summaryPosted: false });
    await pending;
  });

  it("still answers 200 when the review throws, and logs it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await deliverReview(
      prPayload("opened"),
      vi.fn(async () => {
        throw new Error("container exploded");
      })
    );

    expectJson(res, 200, { review: "queued", card: CARD, pr: 7 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("leaves the merge path alone on `closed`", async () => {
    const res = await deliverReview(mergedPayload());

    expectJson(res, 200, { done: CARD });
    expect(reviewPr).not.toHaveBeenCalled();
    expect(store.get(CARD)?.status).toBe("done");
  });
});
