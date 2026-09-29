import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config.js";
import { store as defaultStore, type Store } from "../state/store.js";
import { trello as defaultTrello } from "../trello/client.js";
import { doneEmbed } from "../discord/embeds.js";
import type { DiscordBot } from "../discord/bot.js";
import { json, readBody } from "../trello/webhook.js";
import { reviewPr as defaultReviewPr } from "../reviewer/reviewer.js";

export interface GitHubPRPayload {
  action: string;
  pull_request: {
    number: number;
    state: string;
    draft: boolean;
    merged: boolean;
    html_url: string;
    head: { ref: string; sha: string };
  };
}

/** The part of the payload both handlers act on, once the branch is known. */
export interface FactoryBranch {
  cardId: string;
}

/** Verify X-Hub-Signature-256 against the raw body. */
export function verifySignature(req: IncomingMessage, rawBody: string): boolean {
  const secret = config.github.webhookSecret();
  if (!secret) return true; // no secret configured (local dev)
  const sig = req.headers["x-hub-signature-256"] as string | undefined;
  if (!sig) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = Buffer.from(sig);
  const want = Buffer.from(expected);
  // timingSafeEqual throws when lengths differ — a malformed signature is a
  // rejection, not a 500.
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

/**
 * Which factory card a PR belongs to, from its head branch.
 *
 * One function for both handlers so the merge path and the review path cannot
 * disagree about what "a factory branch" means — a card whose PR is reviewed but
 * never merged, or merged but never reviewed, is exactly the kind of drift that
 * shows up months later as a missing feature nobody can explain.
 */
export function cardFromBranch(ref: string): string | undefined {
  const match = ref.match(/^factory\/(.+)$/);
  return match?.[1];
}

export interface GitHubWebhookDeps {
  store?: Store;
  trello?: typeof defaultTrello;
  /** The whole reviewer, injected rather than imported, so the webhook can be
   *  tested without starting a container and a container cannot be started by a
   *  webhook test that forgot to mock it. */
  reviewPr?: typeof defaultReviewPr;
}

/** What a handler decided, so the tests can read a verdict instead of a socket. */
export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * `closed` + merged: the card is done. Extracted from the original handler
 * unchanged in behaviour — the only edit is that it returns its verdict.
 */
export async function onPrMerged(
  payload: GitHubPRPayload,
  deps: Required<Pick<GitHubWebhookDeps, "store" | "trello">> & { bot: DiscordBot }
): Promise<WebhookResponse> {
  const { store, trello, bot } = deps;
  const cardId = cardFromBranch(payload.pull_request.head.ref);
  if (!cardId) return { status: 200, body: { ignored: "not a factory branch" } };
  const job = store.get(cardId);
  if (!job) return { status: 200, body: { ignored: "unknown card" } };

  console.log(`[github] PR merged for card ${cardId} (${job.card_name})`);
  store.setDone(cardId);
  try {
    await trello.moveCard(cardId, config.trello.doneListId());
    await trello.addComment(cardId, `Factory: PR merged — ${payload.pull_request.html_url}`);
  } catch (err) {
    console.error("[github] trello update failed:", err);
  }
  try {
    await bot.send(doneEmbed(job.card_name, payload.pull_request.html_url));
  } catch (err) {
    console.error("[github] discord send failed:", err);
  }
  return { status: 200, body: { done: cardId } };
}

/**
 * `opened` or `synchronized`: queue a review, and answer immediately.
 *
 * The review is deliberately *not* awaited. A containerized review runs for
 * minutes; GitHub's webhook timeout is a few seconds, and a handler that misses it
 * gets redelivered — which would either re-run the review or, once the dedupe row
 * exists, get refused by it. Either way the webhook has to be the fastest thing in
 * the flow, so this returns as soon as the decision is made and the review reports
 * its own failures to the log.
 */
export function onPrOpenedOrSynced(
  payload: GitHubPRPayload,
  deps: Pick<GitHubWebhookDeps, "store" | "reviewPr"> & { bot?: DiscordBot } = {}
): WebhookResponse {
  const store = deps.store ?? defaultStore;
  const review = deps.reviewPr ?? defaultReviewPr;
  const pr = payload.pull_request;

  const cardId = cardFromBranch(pr.head.ref);
  if (!cardId) return { status: 200, body: { ignored: "not a factory branch" } };
  // A draft is the author still working. Reviewing it spends a model on a diff that
  // is known to be unfinished, and GitHub sends `opened` for drafts too.
  if (pr.draft) return { status: 200, body: { ignored: "draft", card: cardId } };
  // A PR this handler has no job for did not come from the factory, whatever its
  // branch is called. Same guard the merge path uses, for the same reason: a
  // hand-pushed `factory/*` branch must not start paid work.
  if (!store.get(cardId)) return { status: 200, body: { ignored: "unknown card", card: cardId } };

  void Promise.resolve(
    review(cardId, { number: pr.number, htmlUrl: pr.html_url, headRef: pr.head.ref, headSha: pr.head.sha }, { store, ...(deps.bot ? { bot: deps.bot } : {}) })
  ).catch((err: unknown) => {
    // Never a 500 and never a throw past here: the response is already on its way,
    // and an unhandled rejection would take the process down over a review.
    console.error(`[github] review of ${cardId} #${String(pr.number)} failed:`, err);
  });

  return { status: 200, body: { review: "queued", card: cardId, pr: pr.number } };
}

/**
 * Handle a pull_request webhook.
 *
 * Dispatch is on `action` alone, and the two paths share the signature check
 * above them: `closed`+merged closes out a card, `opened`/`synchronized` starts a
 * review, and anything else is answered and forgotten.
 */
export async function handleGitHubWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  bot: DiscordBot,
  deps: GitHubWebhookDeps = {}
): Promise<void> {
  const store = deps.store ?? defaultStore;
  const trello = deps.trello ?? defaultTrello;
  const event = req.headers["x-github-event"] as string | undefined;
  const rawBody = await readBody(req);

  if (event !== "pull_request") {
    return json(res, 200, { ignored: event ?? "unknown" });
  }
  if (!verifySignature(req, rawBody)) {
    return json(res, 401, { error: "bad signature" });
  }

  let payload: GitHubPRPayload;
  try {
    payload = JSON.parse(rawBody) as GitHubPRPayload;
  } catch {
    // A signed body that is not JSON is a delivery we cannot act on. 200 rather
    // than 4xx: GitHub redelivers on 5xx and there is nothing a retry would fix.
    return json(res, 200, { ignored: "unparsable body" });
  }

  const action = payload.action;
  let verdict: WebhookResponse;
  if (action === "closed" && payload.pull_request?.merged) {
    verdict = await onPrMerged(payload, { store, trello, bot });
  } else if (action === "opened" || action === "synchronized") {
    verdict = onPrOpenedOrSynced(payload, { store, ...(deps.reviewPr ? { reviewPr: deps.reviewPr } : {}), bot });
  } else {
    // `closed` without `merged` lands here: an unmerged factory PR is a human
    // decision, and the card stays where it is.
    verdict = { status: 200, body: { ignored: "not a merge" } };
  }
  json(res, verdict.status, verdict.body);
}
