import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config.js";
import { store } from "../state/store.js";
import { trello } from "../trello/client.js";
import { doneEmbed } from "../discord/embeds.js";
import type { DiscordBot } from "../discord/bot.js";
import { json, readBody } from "../trello/webhook.js";

export interface GitHubPRPayload {
  action: string;
  pull_request: {
    merged: boolean;
    html_url: string;
    head: { ref: string };
  };
}

/** Verify X-Hub-Signature-256 against the raw body. */
export function verifySignature(
  req: IncomingMessage,
  rawBody: string
): boolean {
  const secret = config.github.webhookSecret();
  if (!secret) return true; // no secret configured (local dev)
  const sig = req.headers["x-hub-signature-256"] as string | undefined;
  if (!sig) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/**
 * Handle a pull_request webhook. On merge of a factory branch:
 * mark job done, move Trello card to Done, post Discord embed.
 */
export async function handleGitHubWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  bot: DiscordBot
): Promise<void> {
  const event = req.headers["x-github-event"] as string | undefined;
  const rawBody = await readBody(req);

  if (event !== "pull_request") {
    return json(res, 200, { ignored: event ?? "unknown" });
  }
  if (!verifySignature(req, rawBody)) {
    return json(res, 401, { error: "bad signature" });
  }

  const payload = JSON.parse(rawBody) as GitHubPRPayload;
  if (payload.action !== "closed" || !payload.pull_request.merged) {
    return json(res, 200, { ignored: "not a merge" });
  }

  const branch = payload.pull_request.head.ref;
  const match = branch.match(/^factory\/(.+)$/);
  if (!match) {
    return json(res, 200, { ignored: "not a factory branch" });
  }
  const cardId = match[1];
  const job = store.get(cardId);
  if (!job) {
    return json(res, 200, { ignored: "unknown card" });
  }

  console.log(`[github] PR merged for card ${cardId} (${job.card_name})`);
  store.setDone(cardId);
  try {
    await trello.moveCard(cardId, config.trello.doneListId());
    await trello.addComment(
      cardId,
      `Factory: PR merged — ${payload.pull_request.html_url}`
    );
  } catch (err) {
    console.error("[github] trello update failed:", err);
  }
  await bot.send(doneEmbed(job.card_name, payload.pull_request.html_url));
  json(res, 200, { done: cardId });
}
