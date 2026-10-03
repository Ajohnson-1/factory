import http from "node:http";
import type { DiscordBot } from "./discord/bot.js";
import { store as defaultStore, type Store } from "./state/store.js";
import { trello as defaultTrello } from "./trello/client.js";
import { handleTrelloWebhookRequest, json } from "./trello/webhook.js";
import { handleGitHubWebhook } from "./github/webhook.js";

export interface WebhookServerDeps {
  store?: Store;
  /**
   * Injected because deciding whether a moved card is *actually* in Ready needs
   * a lookup. Without this seam the route would reach api.trello.com from the
   * test suite, and a trigger test would depend on somebody's live board.
   */
  trello?: typeof defaultTrello;
}

/** The webhook HTTP surface. Tests listen on port 0 and hit it with fetch. */
export function createWebhookServer(
  bot: DiscordBot,
  deps: WebhookServerDeps = {}
): http.Server {
  const store = deps.store ?? defaultStore;
  const trello = deps.trello ?? defaultTrello;

  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true });
    }
    // Trello HEADs a callback URL when the webhook is created and refuses to
    // create it if the answer is not 200. Without this branch `POST /1/webhooks`
    // fails outright, so there is no delivery to debug at all. Matched on this
    // path only: a HEAD that answers 200 anywhere else would advertise routes
    // that do not exist.
    if (req.method === "HEAD" && req.url === "/webhook/trello") {
      res.writeHead(200);
      return res.end();
    }
    if (req.method === "POST" && req.url === "/webhook/trello") {
      return await handleTrelloWebhookRequest(req, res, { store, trello });
    }
    if (req.method === "POST" && req.url === "/webhook/github") {
      return await handleGitHubWebhook(req, res, bot, { store });
    }
    json(res, 404, { error: "not found" });
  });
}
