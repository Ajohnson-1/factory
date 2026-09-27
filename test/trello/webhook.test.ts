import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "node:stream";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  checkSecret,
  handleTrelloWebhook,
  json,
  readBody,
  type TrelloWebhookEvent,
} from "../../src/trello/webhook.js";
import { createStore, type Store } from "../../src/state/store.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

const READY = "list-ready";

function readyMove(overrides: Partial<TrelloWebhookEvent> = {}): TrelloWebhookEvent {
  return {
    model: "card",
    action: "updateCard",
    card: { id: "card-1", name: "Build the thing", idList: READY },
    list: { id: READY, name: "Ready" },
    ...overrides,
  } as TrelloWebhookEvent;
}

function req(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

let dir: string;
let store: Store;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  dir = makeTempDir();
  store = createStore(path.join(dir, "test.db"));
  vi.stubEnv("READY_LIST_ID", READY);
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

describe("handleTrelloWebhook", () => {
  it("enqueues a card moved to Ready", async () => {
    const handled = await handleTrelloWebhook(readyMove(), { store });

    expect(handled).toBe(true);
    expect(store.get("card-1")).toMatchObject({
      card_name: "Build the thing",
      status: "queued",
    });
  });

  it("ignores events that are not card updates", async () => {
    expect(
      await handleTrelloWebhook(readyMove({ model: "board" }), { store })
    ).toBe(false);
    expect(
      await handleTrelloWebhook(readyMove({ action: "createCard" }), { store })
    ).toBe(false);
    expect(store.all()).toEqual([]);
  });

  it("ignores a card update without a card payload", async () => {
    const event = { model: "card", action: "updateCard" } as TrelloWebhookEvent;
    expect(await handleTrelloWebhook(event, { store })).toBe(false);
    expect(store.all()).toEqual([]);
  });

  it("ignores moves to a list other than Ready", async () => {
    const event = readyMove({
      list: { id: "list-review", name: "Review" },
    }) as TrelloWebhookEvent;

    expect(await handleTrelloWebhook(event, { store })).toBe(false);
    expect(store.all()).toEqual([]);
  });

  it("ignores a move when the list is missing entirely", async () => {
    const event = readyMove() as TrelloWebhookEvent & { list?: unknown };
    delete event.list;

    expect(await handleTrelloWebhook(event, { store })).toBe(false);
  });
});

describe("checkSecret", () => {
  it("allows everything when no secret is configured", () => {
    vi.stubEnv("WEBHOOK_SECRET", "");
    expect(checkSecret(req({}))).toBe(true);
  });

  it("allows a matching secret header", () => {
    vi.stubEnv("WEBHOOK_SECRET", "s3cret");
    expect(checkSecret(req({ "x-webhook-secret": "s3cret" }))).toBe(true);
  });

  it("rejects a wrong or missing secret", () => {
    vi.stubEnv("WEBHOOK_SECRET", "s3cret");
    expect(checkSecret(req({ "x-webhook-secret": "wrong" }))).toBe(false);
    expect(checkSecret(req({}))).toBe(false);
  });
});

describe("readBody", () => {
  it("collects a stream into a string", async () => {
    const stream = Readable.from(["{\"", "a\":1", "}"]);
    expect(await readBody(stream as unknown as IncomingMessage)).toBe('{"a":1}');
  });

  it("rejects when the stream errors", async () => {
    function* broken(): Generator<string> {
      yield "partial";
      throw new Error("boom");
    }
    const stream = Readable.from(broken());
    await expect(readBody(stream as unknown as IncomingMessage)).rejects.toThrow("boom");
  });
});

describe("json", () => {
  it("writes the status and a JSON body", () => {
    const writeHead = vi.fn();
    const end = vi.fn();
    json({ writeHead, end } as unknown as ServerResponse, 201, { ok: true });

    expect(writeHead).toHaveBeenCalledWith(201, {
      "Content-Type": "application/json",
    });
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });
});
