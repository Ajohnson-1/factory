import http from "node:http";
import { config } from "./config.js";
import type { DiscordBot } from "./discord/bot.js";
import { store as defaultStore, type Store } from "./state/store.js";
import {
  checkSecret,
  handleTrelloWebhook,
  json,
  readBody,
  type TrelloWebhookEvent,
} from "./trello/webhook.js";
import { handleGitHubWebhook } from "./github/webhook.js";

export interface WebhookServerDeps {
  store?: Store;
}

/** The webhook HTTP surface. Tests listen on port 0 and hit it with fetch. */
export function createWebhookServer(
  bot: DiscordBot,
  deps: WebhookServerDeps = {}
): http.Server {
  const store = deps.store ?? defaultStore;

  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/webhook/trello") {
      if (!checkSecret(req)) return json(res, 401, { error: "bad secret" });
      const raw = await readBody(req);
      try {
        const event = JSON.parse(raw) as TrelloWebhookEvent;
        const handled = await handleTrelloWebhook(event, { store });
        return json(res, 200, { handled });
      } catch (err) {
        return json(res, 400, { error: String(err) });
      }
    }
    if (req.method === "POST" && req.url === "/webhook/github") {
      return await handleGitHubWebhook(req, res, bot, { store });
    }
    json(res, 404, { error: "not found" });
  });
}
