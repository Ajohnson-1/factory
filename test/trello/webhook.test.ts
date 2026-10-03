/**
 * The inbound Trello trigger (phase 2.4).
 *
 * Payloads below are modelled on Atlassian's documented webhook envelope —
 * https://developer.atlassian.com/cloud/trello/guides/rest-api/webhooks/ ,
 * "Example Webhook Response": the body carries exactly three top-level fields
 * (`action`, `model`, `webhook`), the first two of which are OBJECTS, the verb is
 * `action.type` and the card is `action.data.card.id`.
 *
 * They are still not a capture from a live delivery. Nothing in this repo has
 * seen one, which is precisely how the previous fixture got away with
 * `model: "card"` / `action: "updateCard"` as strings plus a top-level `card` —
 * a shape Trello cannot send, asserted against by a handler that then returned
 * `false` for every real delivery while 618 tests stayed green. `TRELLO_WEBHOOK_DEBUG_FILE`
 * records real deliveries so the next session works from `plan/2.4-trello-
 * trigger.md`'s captured payload instead of from a plausible invention.
 *
 * Note that none of the fixtures below decide the destination list. Where a card
 * is comes from `getCard`, on purpose: the docs do not pin down which field a
 * move's destination travels in (`listAfter`, `list`, or nothing at all for an
 * update that moved nothing), and a trigger that guesses is what broke here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrelloCard } from "../../src/trello/client.js";
import {
  captureDelivery,
  handleTrelloWebhook,
  handleTrelloWebhookRequest,
  json,
  readBody,
  trelloSignature,
  verifyTrelloSignature,
  type TrelloWebhookEvent,
} from "../../src/trello/webhook.js";
import { createStore, type Store } from "../../src/state/store.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

const READY = "list-ready";
const REVIEW = "list-review";
const CALLBACK = "https://vps.example/webhook/trello";
const SECRET = "app-secret";

/** A delivery body in the documented envelope. */
function envelope(
  overrides: Partial<TrelloWebhookEvent> & { action?: Record<string, unknown> } = {}
): TrelloWebhookEvent {
  return {
    action: {
      id: "6510a1b2c3d4e5f60718293a",
      type: "updateCard",
      date: "2026-09-29T10:00:00.000Z",
      data: {
        // `listAfter` is what a move is generally reported to carry, but it is
        // NOT in Atlassian's example (which shows only `data.old.idList`, the list
        // the card left). It is here so the handler is exercised against the shape
        // it is expected to see — and so a future reader can see that nothing
        // reads it. The capture question is about the wire, not about this file.
        card: { id: "card-1", name: "Build the thing", idShort: 1458 },
        listAfter: { id: READY, name: "Ready" },
        board: { id: "board-1", name: "Factory" },
      },
      memberCreator: { id: "member-1", username: "andrew", fullName: "Andrew J" },
    },
    model: { id: "board-1", name: "Factory", closed: false },
    webhook: { id: "wh-1", idModel: "board-1", callbackURL: CALLBACK },
    ...overrides,
  } as TrelloWebhookEvent;
}

function req(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function card(overrides: Partial<TrelloCard> = {}): TrelloCard {
  return {
    id: "card-1",
    name: "Build the thing",
    desc: "",
    idList: READY,
    url: "https://trello.com/c/xxxxxx/build-the-thing",
    ...overrides,
  };
}

/** Collect the JSON a response was ended with. */
function fakeRes(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let status = 0;
  let ended = "";
  const res = {
    writeHead: (code: number) => {
      status = code;
      return res;
    },
    end: (body?: unknown) => {
      ended = body === undefined ? "" : String(body);
      return res;
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    body: () => (ended ? JSON.parse(ended) : undefined),
  };
}

/** A one-shot POST whose body arrives as the given string. */
function postWith(rawBody: string, headers: Record<string, string | undefined> = {}) {
  const stream = Readable.from([rawBody]);
  return Object.assign(stream, { headers }) as unknown as IncomingMessage;
}

function sign(body: string, callbackURL = CALLBACK, secret = SECRET): string {
  return trelloSignature(body, callbackURL, secret);
}

let dir: string;
let store: Store;
let getCard: ReturnType<typeof vi.fn>;
let trello: { getCard: typeof getCard; [key: string]: unknown };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  dir = makeTempDir();
  store = createStore(path.join(dir, "test.db"));
  vi.stubEnv("READY_LIST_ID", READY);
  vi.stubEnv("TRELLO_APP_SECRET", SECRET);
  vi.stubEnv("TRELLO_WEBHOOK_URL", CALLBACK);
  getCard = vi.fn(async (id: string) => card({ id }));
  trello = { getCard };
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

describe("handleTrelloWebhook — what it reacts to", () => {
  it("enqueues a card the API says is in Ready, and reports the verdict", async () => {
    const verdict = await handleTrelloWebhook(envelope(), { store, trello: trello as never });

    expect(verdict).toMatchObject({ handled: true, queue: "queued", generation: 1 });
    expect(store.get("card-1")).toMatchObject({
      card_name: "Build the thing",
      status: "queued",
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('queued card "Build the thing" (card-1)')
    );
  });

  it("ignores every action type that is not updateCard", async () => {
    for (const type of ["commentCard", "createCard", "addMemberToCard", "updateBoard"]) {
      const verdict = await handleTrelloWebhook(
        envelope({ action: { ...envelope().action, type } }),
        { store, trello: trello as never }
      );
      expect(verdict.handled, type).toBe(false);
      expect(verdict.reason, type).toMatch(/not a card update/);
    }
    expect(store.all()).toEqual([]);
    expect(getCard).not.toHaveBeenCalled();
  });

  it("does not enqueue when a comment is added to a card that is sitting in Ready", async () => {
    // A board webhook is sent every action on every card in the board, so the
    // busy case has to be the quiet one: a commented-on Ready card must not get a
    // second run, and must not even be looked up.
    const verdict = await handleTrelloWebhook(
      envelope({ action: { ...envelope().action, type: "commentCard", data: { card: { id: "card-1" } } } }),
      { store, trello: trello as never }
    );

    expect(verdict.handled).toBe(false);
    expect(store.all()).toEqual([]);
    expect(getCard).not.toHaveBeenCalled();
  });

  it("ignores an updateCard whose data carries no card id", async () => {
    const verdict = await handleTrelloWebhook(
      envelope({ action: { ...envelope().action, data: { board: { id: "board-1" } } } }),
      { store, trello: trello as never }
    );

    expect(verdict).toMatchObject({ handled: false, reason: "updateCard without a card id" });
    expect(store.all()).toEqual([]);
  });

  it("reads nothing out of `model` or `action` themselves — they are objects", async () => {
    // The regression this pins: `body.model !== "card"` and
    // `body.action !== "updateCard"` were true for every delivery Trello ever
    // sent, because both are objects. A handler that still compared them as
    // strings fails here instead of in production.
    const verdict = await handleTrelloWebhook(envelope(), { store, trello: trello as never });

    expect(verdict.handled).toBe(true);
    expect(typeof envelope().model).toBe("object");
    expect(typeof envelope().action).toBe("object");
  });
});

describe("handleTrelloWebhook — the destination comes from Trello, not the payload", () => {
  it("ignores a card whose payload claims Ready but the API puts elsewhere", async () => {
    getCard.mockResolvedValue(card({ idList: REVIEW }));

    const verdict = await handleTrelloWebhook(envelope(), { store, trello: trello as never });

    expect(verdict).toMatchObject({ handled: false, reason: expect.stringContaining(REVIEW) });
    expect(store.all()).toEqual([]);
  });

  it("enqueues a card whose payload claims the wrong list but the API puts in Ready", async () => {
    // The other direction matters just as much: a field this handler trusted would
    // have to be right, and it is not documented well enough to bet a trigger on.
    getCard.mockResolvedValue(card({ idList: READY }));
    const body = envelope({
      action: { ...envelope().action, data: { card: { id: "card-1" }, listAfter: { id: REVIEW } } },
    });

    const verdict = await handleTrelloWebhook(body, { store, trello: trello as never });

    expect(verdict).toMatchObject({ handled: true, queue: "queued" });
    expect(getCard).toHaveBeenCalledWith("card-1");
  });

  it("copes with a delivery that carries no list information at all", async () => {
    const body = envelope({
      action: { ...envelope().action, data: { card: { id: "card-1", name: "Build the thing" } } },
    });

    const verdict = await handleTrelloWebhook(body, { store, trello: trello as never });

    expect(verdict).toMatchObject({ handled: true, queue: "queued" });
  });
});

describe("handleTrelloWebhook — the enqueue verdict is never discarded", () => {
  it("refuses a card that is already running, out loud", async () => {
    store.enqueue("card-1", "Build the thing");
    store.setRunning("card-1", "factory/card-1");
    getCard.mockClear();

    const verdict = await handleTrelloWebhook(envelope(), { store, trello: trello as never });

    expect(verdict).toMatchObject({ handled: false, queue: "refused", generation: 1 });
    expect(store.get("card-1")).toMatchObject({ status: "running", generation: 1 });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("refused card"));
  });

  it("refuses a card that is already queued without bumping its generation", async () => {
    store.enqueue("card-1", "Build the thing");

    const verdict = await handleTrelloWebhook(envelope(), { store, trello: trello as never });

    expect(verdict).toMatchObject({ queue: "refused", generation: 1 });
    expect(store.all().filter((j) => j.status === "queued")).toHaveLength(1);
  });

  it("re-queues a finished card at a fresh generation", async () => {
    store.enqueue("card-1", "Build the thing");
    store.setFailed("card-1", "CI timed out");

    const verdict = await handleTrelloWebhook(envelope(), { store, trello: trello as never });

    expect(verdict).toMatchObject({ handled: true, queue: "requeued", generation: 2 });
    expect(store.get("card-1")).toMatchObject({ status: "queued", error: null });
    expect(store.attemptFor("card-1")).toBe(2);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("requeued card"));
  });

  it("takes the card name from the API, not from the delivery", async () => {
    getCard.mockResolvedValue(card({ name: "Renamed by a human" }));
    const body = envelope({
      action: { ...envelope().action, data: { card: { id: "card-1", name: "Old name" } } },
    });

    await handleTrelloWebhook(body, { store, trello: trello as never });

    expect(store.get("card-1")?.card_name).toBe("Renamed by a human");
  });
});

describe("handleTrelloWebhook — a Trello failure is not a card failure", () => {
  it("asks for a redelivery when the card cannot be looked up, touching nothing", async () => {
    getCard.mockRejectedValue(new Error("Trello API 500: boom"));

    const verdict = await handleTrelloWebhook(envelope(), { store, trello: trello as never });

    expect(verdict).toMatchObject({ handled: false, retry: true });
    expect(store.all()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("cannot verify card card-1"),
      expect.anything()
    );
  });
});

describe("verifyTrelloSignature", () => {
  const raw = JSON.stringify(envelope());

  it("accepts a signature over the raw bytes", () => {
    const header = sign(raw);

    expect(
      verifyTrelloSignature({ rawBody: raw, parsed: JSON.parse(raw), header, callbackURL: CALLBACK, appSecret: SECRET })
    ).toBe("raw");
  });

  it("accepts a signature over the re-serialized body, and says so", () => {
    // Trello's own sample hashes `JSON.stringify(request.body)`. Whether the bytes
    // on the wire are identical to that is a question for a real delivery, so both
    // forms are verified and the matched one is reported — either way forging it
    // still requires the app secret.
    const reserialized = JSON.stringify({ webhook: envelope().webhook, model: envelope().model, action: envelope().action });

    expect(
      verifyTrelloSignature({ rawBody: reserialized.replace("Build the thing", "Build  the thing"), parsed: JSON.parse(reserialized), header: sign(reserialized), callbackURL: CALLBACK, appSecret: SECRET })
    ).toBe("reserialized");
  });

  it("rejects a missing header", () => {
    expect(
      verifyTrelloSignature({ rawBody: raw, parsed: JSON.parse(raw), header: undefined, callbackURL: CALLBACK, appSecret: SECRET })
    ).toBeNull();
  });

  it("rejects when the app secret is not configured, instead of leaving the route open", () => {
    // The hole `checkSecret` had: no secret configured meant every request was
    // allowed. Here, no secret means nothing can be verified.
    expect(
      verifyTrelloSignature({ rawBody: raw, parsed: JSON.parse(raw), header: sign(raw), callbackURL: CALLBACK, appSecret: "" })
    ).toBeNull();
  });

  it("rejects when the callback URL is not configured", () => {
    expect(
      verifyTrelloSignature({ rawBody: raw, parsed: JSON.parse(raw), header: sign(raw), callbackURL: "", appSecret: SECRET })
    ).toBeNull();
  });

  it("rejects the right signature sent to the wrong callback URL", () => {
    // The callbackURL is part of the signed content, exactly as registered.
    expect(
      verifyTrelloSignature({ rawBody: raw, parsed: JSON.parse(raw), header: sign(raw), callbackURL: CALLBACK + "/", appSecret: SECRET })
    ).toBeNull();
  });

  it("rejects a signature from someone else's app secret", () => {
    expect(
      verifyTrelloSignature({ rawBody: raw, parsed: JSON.parse(raw), header: sign(raw, CALLBACK, "other-secret"), callbackURL: CALLBACK, appSecret: SECRET })
    ).toBeNull();
  });

  it("rejects a truncated or overlong header without throwing", () => {
    // `timingSafeEqual` throws on a length mismatch — a malformed signature is a
    // rejection, not a 500.
    for (const header of [sign(raw).slice(0, 10), sign(raw) + "AAAA", "!!!!"]) {
      expect(
        verifyTrelloSignature({ rawBody: raw, parsed: JSON.parse(raw), header, callbackURL: CALLBACK, appSecret: SECRET })
      ).toBeNull();
    }
  });

  it("hashes body + callbackURL with HMAC-SHA1, base64, as the docs specify", () => {
    const expected = crypto.createHmac("sha1", SECRET).update(raw + CALLBACK).digest("base64");

    expect(trelloSignature(raw, CALLBACK, SECRET)).toBe(expected);
    expect(expected).toHaveLength(28);
  });
});

describe("handleTrelloWebhookRequest", () => {
  async function deliver(
    rawBody: string,
    headers: Record<string, string | undefined> = {},
    deps = {}
  ) {
    const { res, status, body } = fakeRes();
    await handleTrelloWebhookRequest(postWith(rawBody, headers), res, { store, trello: trello as never, ...deps });
    return { status: status(), body: body() as Record<string, unknown> };
  }

  it("enqueues a properly signed Ready move and answers 200", async () => {
    const raw = JSON.stringify(envelope());

    const out = await deliver(raw, { "x-trello-webhook": sign(raw) });

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ handled: true, queue: "queued", signedForm: expect.any(String) });
    expect(store.get("card-1")).toMatchObject({ status: "queued" });
  });

  it("answers 401 and enqueues nothing when the signature does not verify", async () => {
    const raw = JSON.stringify(envelope());

    const out = await deliver(raw, { "x-trello-webhook": sign(raw, CALLBACK, "wrong-secret") });

    expect(out.status).toBe(401);
    expect(out.body).toMatchObject({ handled: false, reason: "bad signature" });
    expect(store.all()).toEqual([]);
    expect(getCard).not.toHaveBeenCalled();
  });

  it("answers 401 when there is no signature at all", async () => {
    const out = await deliver(JSON.stringify(envelope()));

    expect(out.status).toBe(401);
    expect(store.all()).toEqual([]);
  });

  it("says why it rejected the delivery when the secret is simply not configured", async () => {
    vi.stubEnv("TRELLO_APP_SECRET", "");
    const raw = JSON.stringify(envelope());

    const out = await deliver(raw, { "x-trello-webhook": sign(raw) });

    expect(out.status).toBe(401);
    expect(out.body.reason).toMatch(/TRELLO_APP_SECRET/);
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const raw = "{not json";

    const out = await deliver(raw, { "x-trello-webhook": sign(raw) });

    expect(out.status).toBe(400);
    expect(String(out.body.reason)).toMatch(/unparsable/);
  });

  it("ignores a comment on a board with no Ready list configured, without throwing", async () => {
    // `readyListId()` throws when the operator has not set it. A delivery this
    // handler was never going to act on must not turn that into a 500 that Trello
    // retries and counts toward disabling the webhook.
    vi.stubEnv("READY_LIST_ID", "");
    const raw = JSON.stringify(
      envelope({ action: { ...envelope().action, type: "commentCard" } })
    );

    const out = await deliver(raw, { "x-trello-webhook": sign(raw) });

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ handled: false });
    expect(getCard).not.toHaveBeenCalled();
  });

  it("answers 500 as our fault, not 400, when the handler itself breaks", async () => {
    // A missing config is the factory's problem. Reported as an unparsable body
    // it would send the operator off debugging a payload that arrived fine.
    vi.stubEnv("READY_LIST_ID", "");
    const raw = JSON.stringify(envelope());

    const out = await deliver(raw, { "x-trello-webhook": sign(raw) });

    expect(out.status).toBe(500);
    expect(String(out.body.reason)).toMatch(/handler error/);
    expect(String(out.body.reason)).toMatch(/READY_LIST_ID/);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("handler error"),
      expect.anything()
    );
    expect(store.all()).toEqual([]);
  });

  it("answers 500 when the card location could not be resolved, so Trello retries", async () => {
    getCard.mockRejectedValue(new Error("Trello API 429: API_TOKEN_LIMIT_EXCEEDED"));
    const raw = JSON.stringify(envelope());

    const out = await deliver(raw, { "x-trello-webhook": sign(raw) });

    expect(out.status).toBe(500);
    expect(out.body).toMatchObject({ handled: false, retry: true });
    expect(store.all()).toEqual([]);
  });

  it("answers 200 for a delivery that is signed and simply not ours", async () => {
    // A non-200 on these would burn the retry ladder and the consecutive-failure
    // counters for a board where people work normally.
    const raw = JSON.stringify(envelope({ action: { ...envelope().action, type: "commentCard" } }));

    const out = await deliver(raw, { "x-trello-webhook": sign(raw) });

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ handled: false });
  });
});

describe("captureDelivery", () => {
  let file: string;

  beforeEach(() => {
    file = path.join(dir, "captures.jsonl");
    vi.stubEnv("TRELLO_WEBHOOK_DEBUG_FILE", file);
  });

  it("records the raw body so a real delivery settles the open questions", () => {
    captureDelivery({ rawBody: '{"a":1}', signature: "sig", outcome: { status: 200, handled: false } });

    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ rawBody: '{"a":1}', signaturePresent: 1, outcome: { status: 200 } });
    expect(lines[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("appends, so several deliveries stay readable as a capture log", () => {
    captureDelivery({ rawBody: "one", outcome: {} });
    captureDelivery({ rawBody: "two", outcome: {} });

    expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("writes nothing when no file is configured", () => {
    vi.stubEnv("TRELLO_WEBHOOK_DEBUG_FILE", "");

    captureDelivery({ rawBody: "secret card text", outcome: {} });

    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))).toEqual([]);
  });

  it("does not put a megabyte of card content on disk", () => {
    captureDelivery({ rawBody: "x".repeat(600 * 1024), outcome: {} });

    expect(fs.readFileSync(file, "utf8")).toContain("[truncated: 614400 bytes]");
  });

  it("survives a capture it cannot write, rather than rejecting the delivery", () => {
    vi.stubEnv("TRELLO_WEBHOOK_DEBUG_FILE", dir);

    expect(() => captureDelivery({ rawBody: "a", outcome: {} })).not.toThrow();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("capture failed"), expect.anything());
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

    await expect(
      readBody(Readable.from(broken()) as unknown as IncomingMessage)
    ).rejects.toThrow("boom");
  });

  it("keeps a multi-byte character that straddles a chunk boundary intact", async () => {
    // Card names carry emoji. Decoding each chunk on its own — the old
    // `data += chunk` — replaces the split character with U+FFFD, which is
    // invisible in the text but changes the bytes the signature was computed over.
    const bytes = Buffer.from('{"name":"🏭 plant"}', "utf8");
    const split = bytes.indexOf(0x8f) + 1; // inside the emoji's 4-byte sequence
    const stream = Readable.from([bytes.subarray(0, split), bytes.subarray(split)]);

    const body = await readBody(stream as unknown as IncomingMessage);

    expect(body).toBe('{"name":"🏭 plant"}');
    expect(body).not.toContain("\uFFFD");
  });
});

describe("json", () => {
  it("writes the status and a JSON body", () => {
    const { res, status, body } = fakeRes();

    json(res, 201, { ok: true });

    expect(status()).toBe(201);
    expect(body()).toEqual({ ok: true });
  });
});

/** The three top-level fields are the documented envelope, and the only three a
 *  real delivery carries. Pinned so a future fixture cannot drift back to the
 *  invented flat shape that hid the bug. */
describe("envelope sanity", () => {
  it("matches the documented three top-level fields", () => {
    expect(Object.keys(envelope()).sort()).toEqual(["action", "model", "webhook"]);
  });
});
