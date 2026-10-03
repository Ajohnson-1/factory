/**
 * The HTTP surface, driven over a real socket on 127.0.0.1.
 *
 * Hermetic by construction: the Trello client is injected, so nothing here
 * reaches api.trello.com. That seam exists because the trigger now verifies a
 * delivery by asking Trello where the card actually is — a test that left that
 * lookup real would be asserting against somebody's live board.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createWebhookServer } from "../src/server.js";
import { createStore, type Store } from "../src/state/store.js";
import { trelloSignature } from "../src/trello/webhook.js";
import type { TrelloCard } from "../src/trello/client.js";
import type { DiscordBot } from "../src/discord/bot.js";
import { makeTempDir, removeTempDir } from "./helpers/tmp.js";

const READY = "list-ready";
const REVIEW = "list-review";
const CALLBACK = "http://127.0.0.1/webhook/trello";
const SECRET = "app-secret";

let dir: string;
let store: Store;
let bot: DiscordBot;
let server: ReturnType<typeof createWebhookServer>;
let base: string;
let getCard: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  dir = makeTempDir();
  store = createStore(path.join(dir, "test.db"));
  bot = { send: vi.fn() } as unknown as DiscordBot;
  getCard = vi.fn(async (id: string): Promise<TrelloCard> => ({
    id,
    name: "Card one",
    desc: "",
    idList: READY,
    url: `https://trello.com/c/${id}`,
  }));
  vi.stubEnv("READY_LIST_ID", READY);
  vi.stubEnv("TRELLO_APP_SECRET", SECRET);
  vi.stubEnv("TRELLO_WEBHOOK_URL", CALLBACK);
  server = createWebhookServer(bot, { store, trello: { getCard } as never });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  store.close();
  removeTempDir(dir);
});

/**
 * One delivery, in the documented envelope: `action` / `model` / `webhook`, all
 * objects, the verb at `action.type` and the card at `action.data.card.id`.
 * Not a live capture — see the header of test/trello/webhook.test.ts for what is
 * modelled here and on what authority.
 */
function readyMove(cardId = "c1") {
  return {
    action: {
      id: "6510a1b2c3d4e5f60718293a",
      type: "updateCard",
      date: "2026-09-29T10:00:00.000Z",
      data: {
        card: { id: cardId, name: "Card one", idShort: 7 },
        listAfter: { id: READY, name: "Ready" },
        board: { id: "board-1", name: "Factory" },
      },
      memberCreator: { id: "member-1", username: "andrew" },
    },
    model: { id: "board-1", name: "Factory", closed: false },
    webhook: { id: "wh-1", idModel: "board-1", callbackURL: CALLBACK },
  };
}

/** POST a body the way Trello does: signed with the app secret over body + URL. */
async function deliver(
  body: unknown,
  opts: { secret?: string; callbackURL?: string; omitHeader?: boolean; raw?: string } = {}
) {
  const raw = opts.raw ?? JSON.stringify(body);
  const header =
    opts.secret === "" || opts.omitHeader
      ? undefined
      : trelloSignature(raw, opts.callbackURL ?? CALLBACK, opts.secret ?? SECRET);
  return fetch(`${base}/webhook/trello`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(header ? { "x-trello-webhook": header } : {}),
    },
    body: raw,
  });
}

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("HEAD /webhook/trello", () => {
  // Trello HEADs a callback URL when a webhook is created and refuses to create
  // it unless the answer is 200. Without this branch there is no webhook, so no
  // delivery to debug — this is the route that made registration possible at all.
  it("answers 200 with no body", async () => {
    const res = await fetch(`${base}/webhook/trello`, { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("answers 200 with no body even when the store is doing nothing", async () => {
    // A HEAD must not be able to enqueue work.
    const res = await fetch(`${base}/webhook/trello`, { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(store.all()).toEqual([]);
    expect(getCard).not.toHaveBeenCalled();
  });

  it("does not answer 200 to HEAD on any other path", async () => {
    // A blanket HEAD-200 would advertise routes that do not exist.
    for (const url of ["/health", "/webhook/github", "/nope", "/webhook/trello/extra"]) {
      const res = await fetch(`${base}${url}`, { method: "HEAD" });
      expect(res.status, url).toBe(404);
    }
  });
});

describe("POST /webhook/trello — authentication", () => {
  it("rejects an unsigned delivery and enqueues nothing", async () => {
    const res = await deliver(readyMove(), { omitHeader: true });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ handled: false, reason: "bad signature" });
    expect(store.all()).toEqual([]);
    expect(getCard).not.toHaveBeenCalled();
  });

  it("rejects a delivery signed with the wrong app secret", async () => {
    const res = await deliver(readyMove(), { secret: "not-the-secret" });

    expect(res.status).toBe(401);
    expect(store.all()).toEqual([]);
  });

  it("rejects a signature computed over a different callback URL", async () => {
    // The callbackURL is part of the signed content, exactly as registered — a
    // trailing slash is a mismatch, not a typo.
    const res = await deliver(readyMove(), { callbackURL: CALLBACK + "/" });

    expect(res.status).toBe(401);
    expect(store.all()).toEqual([]);
  });

  it("rejects every delivery when no app secret is configured", async () => {
    // The hole this replaces: `WEBHOOK_SECRET` unset made the route open to
    // anyone who could reach it, and set made it unreachable for Trello, which
    // cannot send custom headers.
    vi.stubEnv("TRELLO_APP_SECRET", "");

    const res = await deliver(readyMove(), { secret: "" });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ handled: false });
    expect(String(body.reason)).toMatch(/TRELLO_APP_SECRET/);
    expect(store.all()).toEqual([]);
  });

  it("rejects a forged body that carries a real card id", async () => {
    // The point of the signature: anyone able to POST this route could enqueue a
    // paid model run on any card id they liked.
    const res = await fetch(`${base}/webhook/trello`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-trello-webhook": trelloSignature(JSON.stringify(readyMove("victim1")), CALLBACK, "guessed"),
      },
      body: JSON.stringify(readyMove("victim1")),
    });

    expect(res.status).toBe(401);
    expect(store.get("victim1")).toBeUndefined();
  });
});

describe("POST /webhook/trello — the decision", () => {
  it("queues a card the API places in Ready", async () => {
    const res = await deliver(readyMove("c1"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handled: true, queue: "queued", generation: 1 });
    expect(store.get("c1")).toMatchObject({ card_name: "Card one", status: "queued" });
    expect(getCard).toHaveBeenCalledWith("c1");
  });

  it("ignores a card the API places somewhere else, whatever the payload claimed", async () => {
    getCard.mockResolvedValue({ id: "c2", name: "Card two", desc: "", idList: REVIEW, url: "" });

    const res = await deliver(readyMove("c2"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handled: false });
    expect(store.all()).toEqual([]);
  });

  it("ignores an action that is not a card update", async () => {
    const body = readyMove("c3");
    body.action.type = "commentCard";

    const res = await deliver(body);

    expect(res.status).toBe(200);
    expect(store.all()).toEqual([]);
    expect(getCard).not.toHaveBeenCalled();
  });

  it("reports a refused duplicate as a refusal, not as silence", async () => {
    // The verdict `store.enqueue` already returned and the old handler threw
    // away: "refused, already running" is the message an operator needs.
    store.enqueue("c4", "Card four");
    store.setRunning("c4", "factory/c4");

    const res = await deliver(readyMove("c4"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handled: false, queue: "refused", generation: 1 });
    expect(store.get("c4")).toMatchObject({ status: "running" });
  });

  it("answers 500 when the card lookup fails, so Trello redelivers", async () => {
    // A 200 here would drop the move on the floor: Trello retries a non-200 at
    // 30/60/120s, and `enqueue` makes the retry harmless.
    getCard.mockRejectedValue(new Error("Trello API 429: API_TOKEN_LIMIT_EXCEEDED"));

    const res = await deliver(readyMove("c5"));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ handled: false, retry: true });
    expect(store.all()).toEqual([]);
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const res = await deliver(undefined, { raw: "{not json" });

    expect(res.status).toBe(400);
    expect(String((await res.json()).reason)).toMatch(/unparsable/);
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
