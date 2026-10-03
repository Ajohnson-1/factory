import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config.js";
import { store as defaultStore, type Store } from "../state/store.js";
import { trello as defaultTrello } from "./client.js";

/**
 * A Trello webhook delivery.
 *
 * Shape taken from https://developer.atlassian.com/cloud/trello/guides/rest-api/webhooks/
 * ("Example Webhook Response"): the body has exactly three top-level fields —
 * `action`, `model` and `webhook`. Both `action` and `model` are OBJECTS. The
 * verb is `action.type`; the card is `action.data.card.id`.
 *
 * The previous version of this interface had `model: string`, `action: string`
 * and a top-level `card`, which is nothing Trello has ever sent — so
 * `body.model !== "card"` was true for every real delivery and the trigger never
 * fired once. Every field here is optional because a delivery is untrusted input:
 * reading it must not be able to throw.
 */
export interface TrelloWebhookEvent {
  action?: {
    id?: string;
    type?: string;
    date?: string;
    data?: {
      card?: { id?: string; name?: string; idShort?: number; idList?: string };
      list?: { id?: string; name?: string };
      listBefore?: { id?: string; name?: string };
      listAfter?: { id?: string; name?: string };
      board?: { id?: string; name?: string };
      [key: string]: unknown;
    };
    memberCreator?: { id?: string; username?: string; fullName?: string };
    [key: string]: unknown;
  };
  model?: Record<string, unknown>;
  webhook?: {
    id?: string;
    idModel?: string;
    callbackURL?: string;
    description?: string;
    active?: boolean;
  };
}

export interface TrelloWebhookDeps {
  store?: Store;
  trello?: typeof defaultTrello;
  /** Injected so one card move can be checked against a list that is not the
   *  configured one. Read from config when absent. */
  readyListId?: string;
}

/**
 * What the handler decided, so the route can answer in a way that matches the
 * decision and the operator can read the difference between "nothing arrived",
 * "it arrived and is not ours" and "it arrived and we refused it".
 *
 * `retry: true` is the only case that must not be answered 200: Trello could not
 * be asked where the card is, so the move is worth redelivering. A duplicate
 * delivery costs nothing here — `Store.enqueue` refuses a card that is already
 * queued or running.
 */
export interface TrelloVerdict {
  handled: boolean;
  reason: string;
  retry?: boolean;
  cardId?: string;
  /** The `store.enqueue` verdict: the case that used to be thrown away at the
   *  old line 34, which is why "refused, already running" was indistinguishable
   *  from "no delivery ever came". */
  queue?: "queued" | "requeued" | "refused";
  generation?: number;
}

/**
 * Which serialization of the body Trello actually signed.
 *
 * The docs say the header is an HMAC over "the full request body and the
 * callbackURL", and their Node sample hashes `JSON.stringify(request.body)` —
 * the re-serialized object, not the bytes on the wire. Those are only equal if
 * the key order and spacing survive a parse/stringify round trip. No delivery
 * has been observed here, so both are accepted and the matched form is reported:
 * a signature is a signature either way (forging one still requires the app
 * secret), and the first real delivery tells us in the log which one to keep.
 */
export type SignatureForm = "raw" | "reserialized";

/** Base64 HMAC-SHA1 over `signed + callbackURL`, keyed with the app secret. */
export function trelloSignature(
  signed: string,
  callbackURL: string,
  appSecret: string
): string {
  return crypto
    .createHmac("sha1", appSecret)
    .update(signed + callbackURL)
    .digest("base64");
}

/** Length-guarded constant-time compare — `timingSafeEqual` throws on a length mismatch. */
function digestEquals(a: string, b: string): boolean {
  const given = Buffer.from(b);
  const want = Buffer.from(a);
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(want, given);
}

/**
 * Verify `X-Trello-Webhook`. Returns the form that matched, or null.
 *
 * Fails closed: a missing header, a missing app secret or a missing
 * `TRELLO_WEBHOOK_URL` all mean "not verified". A signed request whose callback
 * URL we do not know cannot be checked, and guessing that silence is harmless is
 * how the route ended up open to the whole internet before.
 */
export function verifyTrelloSignature(opts: {
  rawBody: string;
  parsed: unknown;
  header?: string;
  callbackURL: string;
  appSecret: string;
}): SignatureForm | null {
  if (!opts.appSecret || !opts.callbackURL || !opts.header) return null;
  const candidates: [SignatureForm, string][] = [
    ["raw", opts.rawBody],
    ["reserialized", JSON.stringify(opts.parsed)],
  ];
  for (const [form, signed] of candidates) {
    if (digestEquals(trelloSignature(signed, opts.callbackURL, opts.appSecret), opts.header)) {
      return form;
    }
  }
  return null;
}

/** Bodies over this size are not captured — the debug file is opt-in, not a disk quota. */
const MAX_CAPTURE_BYTES = 512 * 1024;

/**
 * Append one delivery to `TRELLO_WEBHOOK_DEBUG_FILE` as a JSON line.
 *
 * This exists because the payload shape was invented once and every test built
 * on that invention. A recorded delivery settles the open questions — which list
 * field a move carries, which form of the body is signed — from evidence instead
 * of from memory. Card content lands in this file, so it is a host path, never
 * Discord, and never copied into the log.
 */
export function captureDelivery(entry: {
  rawBody: string;
  signature?: string;
  outcome: Record<string, unknown>;
}): void {
  const file = config.trello.webhookDebugFile();
  if (!file) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    signaturePresent: entry.signature ? 1 : 0,
    signedForm: entry.outcome.signedForm ?? null,
    outcome: entry.outcome,
    rawBody:
      entry.rawBody.length > MAX_CAPTURE_BYTES
        ? `[truncated: ${String(entry.rawBody.length)} bytes]`
        : entry.rawBody,
  });
  try {
    fs.appendFileSync(file, line + "\n");
  } catch (err) {
    // A capture that cannot be written is not a reason to reject a delivery.
    console.error("[trello-webhook] capture failed:", err);
  }
}

/**
 * Act on one parsed delivery.
 *
 * Reacts to a card moving into the Ready list and nothing else. The destination
 * is never taken from the payload: a board webhook sends every kind of
 * `updateCard` (rename, description, label, due date, a check item ticked), and
 * the only move example Atlassian documents carries `data.old.idList` — the list
 * the card *left*, with no destination field at all. So the card id is read from
 * the payload and then asked of Trello directly. That costs one API call per
 * candidate event, bounded by the deliveries that mention a card, and makes the
 * trigger correct under whatever shape the payload turns out to have — including
 * one this code has not yet seen.
 */
export async function handleTrelloWebhook(
  body: TrelloWebhookEvent,
  deps: TrelloWebhookDeps = {}
): Promise<TrelloVerdict> {
  const store = deps.store ?? defaultStore;
  const trello = deps.trello ?? defaultTrello;

  // `type`, not `action` — the old code compared a string that Trello sends as
  // an object, so this line decided that nothing was ever for us.
  if (body.action?.type !== "updateCard") {
    return { handled: false, reason: `not a card update (${String(body.action?.type)})` };
  }
  const cardId = body.action.data?.card?.id;
  if (!cardId) return { handled: false, reason: "updateCard without a card id" };

  // Resolved here and not at the top: `readyListId()` throws when the operator
  // has not set `READY_LIST_ID`, and a comment on a card must not become a 500
  // over a config problem for a delivery this handler was never going to act on.
  const readyListId = deps.readyListId ?? config.trello.readyListId();

  let card;
  try {
    card = await trello.getCard(cardId);
  } catch (err) {
    console.error(`[trello-webhook] cannot verify card ${cardId}:`, err);
    // Ask for a redelivery rather than dropping the move: the card is in some
    // list and we do not know which. Trello retries at 30/60/120s.
    return { handled: false, reason: "card location unavailable", retry: true };
  }
  if (card.idList !== readyListId) {
    return {
      handled: false,
      reason: `card ${cardId} is in list ${String(card.idList)}, not Ready`,
    };
  }

  const verdict = store.enqueue(cardId, card.name);
  const queue = verdict.queued ? (verdict.requeued ? "requeued" : "queued") : "refused";
  const name = card.name;
  if (queue === "refused") {
    console.log(
      `[trello-webhook] refused card "${name}" (${cardId}): already ` +
        `${store.get(cardId)?.status ?? "queued"}, generation ${String(verdict.generation)}`
    );
  } else {
    console.log(
      `[trello-webhook] ${queue} card "${name}" (${cardId}) at generation ` +
        `${String(verdict.generation)}${queue === "requeued" ? " (fresh run budget)" : ""}`
    );
  }
  return {
    handled: queue !== "refused",
    reason: `Ready: ${queue}`,
    cardId,
    queue,
    generation: verdict.generation,
  };
}

/**
 * Decide the answer for one verified-or-not delivery. Split out so each status
 * code is one explicit return, and so "the delivery is bad" can never be
 * confused with "we are broken".
 */
async function decideTrelloDelivery(
  rawBody: string,
  signedForm: SignatureForm | null,
  deps: TrelloWebhookDeps
): Promise<{ status: number; verdict: TrelloVerdict }> {
  if (!signedForm) {
    // Unverified input cannot enqueue work: every enqueue here ends in a paid
    // model run against the operator's repository.
    return {
      status: 401,
      verdict: {
        handled: false,
        reason: config.trello.appSecret()
          ? "bad signature"
          : "unconfigured: TRELLO_APP_SECRET and TRELLO_WEBHOOK_URL are both required to verify a delivery",
      },
    };
  }

  let event: TrelloWebhookEvent;
  try {
    event = JSON.parse(rawBody) as TrelloWebhookEvent;
  } catch (err) {
    // A signed body that is not JSON will not become JSON on a retry.
    return { status: 400, verdict: { handled: false, reason: `unparsable body: ${String(err)}` } };
  }

  try {
    const verdict = await handleTrelloWebhook(event, deps);
    // `retry` is the one case a non-200 earns: Trello could not tell us where the
    // card is, and its 30/60/120s ladder is the only thing that will ask again.
    return { status: verdict.retry ? 500 : 200, verdict };
  } catch (err) {
    // Our failure, not the delivery's — a missing `READY_LIST_ID` lands here, and
    // reporting it as bad input would send the operator debugging a payload.
    console.error("[trello-webhook] handler error:", err);
    return { status: 500, verdict: { handled: false, reason: `handler error: ${String(err)}` } };
  }
}

/**
 * The webhook HTTP surface for one delivery: verify, decide, capture, answer.
 *
 * Answers are part of the contract with Trello. Any non-200 counts as a failure
 * and burns the retry ladder (30/60/120s) and the consecutive-failure counters
 * that disable a webhook, so "not our event" is a 200.
 */
export async function handleTrelloWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TrelloWebhookDeps = {}
): Promise<void> {
  const rawBody = await readBody(req);
  const header = req.headers["x-trello-webhook"] as string | undefined;
  const signedForm = verifyTrelloSignature({
    rawBody,
    parsed: safeParse(rawBody),
    header,
    callbackURL: config.trello.webhookUrl(),
    appSecret: config.trello.appSecret(),
  });

  const { status, verdict } = await decideTrelloDelivery(rawBody, signedForm, deps);
  const body = { ...verdict, signedForm };
  captureDelivery({ rawBody, signature: header, outcome: { status, ...body } });
  json(res, status, body);
}

/** Parse once for the signature, without throwing on garbage. */
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Collect a request body.
 *
 * Buffers are concatenated and decoded once, at the end. The previous version
 * appended each chunk to a string, which re-decodes every chunk separately and
 * destroys any multi-byte character that straddles a chunk boundary — a card
 * named with an emoji is a routine delivery. That corruption is invisible in the
 * text but fatal to `X-Trello-Webhook`, which hashes the body bytes.
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) =>
      chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer))
    );
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function json(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
