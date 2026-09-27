import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EmbedBuilder } from "discord.js";
import {
  handleGitHubWebhook,
  verifySignature,
  type GitHubPRPayload,
  type GitHubWebhookDeps,
} from "../../src/github/webhook.js";
import { createStore, type Store } from "../../src/state/store.js";
import type { DiscordBot } from "../../src/discord/bot.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

type MockFn = ReturnType<typeof vi.fn>;
type FakeTrello = NonNullable<GitHubWebhookDeps["trello"]>;

const SECRET = "hook-secret";
const DONE_LIST = "list-done";
const CARD = "card-1";
const CARD_NAME = "Build the thing";
const PR_URL = "https://github.com/acme/widgets/pull/7";

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
      merged: true,
      html_url: PR_URL,
      head: { ref: cardId === null ? "main" : `factory/${cardId}` },
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

  it("ignores a pull request action other than closed", async () => {
    const payload = mergedPayload();
    payload.action = "opened";

    const res = await deliver(payload);

    expectJson(res, 200, { ignored: "not a merge" });
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
