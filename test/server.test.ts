import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createWebhookServer } from "../src/server.js";
import { createStore, type Store } from "../src/state/store.js";
import type { DiscordBot } from "../src/discord/bot.js";
import { makeTempDir, removeTempDir } from "./helpers/tmp.js";

const READY = "list-ready";

let dir: string;
let store: Store;
let bot: DiscordBot;
let server: ReturnType<typeof createWebhookServer>;
let base: string;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  dir = makeTempDir();
  store = createStore(path.join(dir, "test.db"));
  bot = { send: vi.fn() } as unknown as DiscordBot;
  server = createWebhookServer(bot, { store });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  removeTempDir(dir);
});

function trelloMove(body: unknown, secret?: string) {
  return fetch(`${base}/webhook/trello`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { "x-webhook-secret": secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /webhook/trello", () => {
  it("rejects a wrong webhook secret with 401", async () => {
    vi.stubEnv("WEBHOOK_SECRET", "s3cret");
    vi.stubEnv("READY_LIST_ID", READY);

    const res = await trelloMove(
      { model: "card", action: "updateCard", card: { id: "c1" }, list: { id: READY } },
      "nope"
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "bad secret" });
    expect(store.all()).toEqual([]);
  });

  it("queues a card moved to Ready and reports it handled", async () => {
    vi.stubEnv("WEBHOOK_SECRET", "s3cret");
    vi.stubEnv("READY_LIST_ID", READY);

    const res = await trelloMove(
      {
        model: "card",
        action: "updateCard",
        card: { id: "c1", name: "Card one", idList: READY },
        list: { id: READY, name: "Ready" },
      },
      "s3cret"
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: true });
    expect(store.get("c1")).toMatchObject({ card_name: "Card one", status: "queued" });
  });

  it("answers 400 for a malformed JSON body", async () => {
    const res = await fetch(`${base}/webhook/trello`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/JSON/);
  });
});

describe("POST /webhook/github", () => {
  it("acknowledges events it does not care about", async () => {
    const res = await fetch(`${base}/webhook/github`, {
      method: "POST",
      headers: { "x-github-event": "ping", "Content-Type": "application/json" },
      body: JSON.stringify({ zen: "keep it simple" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: "ping" });
  });
});

describe("unknown routes", () => {
  it("answers 404", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("answers 404 for a POST to a GET-only path", async () => {
    const res = await fetch(`${base}/health`, { method: "POST", body: "" });
    expect(res.status).toBe(404);
  });
});
