import http from "node:http";
import { config } from "./config.js";
import { DiscordBot } from "./discord/bot.js";
import { startWorker } from "./worker/queue.js";
import {
  checkSecret,
  handleTrelloWebhook,
  json,
  readBody,
  type TrelloWebhookEvent,
} from "./trello/webhook.js";
import { handleGitHubWebhook } from "./github/webhook.js";

async function main(): Promise<void> {
  const bot = new DiscordBot();
  await bot.start();
  await startWorker(bot);

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/webhook/trello") {
      if (!checkSecret(req)) return json(res, 401, { error: "bad secret" });
      const raw = await readBody(req);
      try {
        const event = JSON.parse(raw) as TrelloWebhookEvent;
        const handled = await handleTrelloWebhook(event);
        return json(res, 200, { handled });
      } catch (err) {
        return json(res, 400, { error: String(err) });
      }
    }
    if (req.method === "POST" && req.url === "/webhook/github") {
      return await handleGitHubWebhook(req, res, bot);
    }
    json(res, 404, { error: "not found" });
  });

  server.listen(config.factory.webhookPort, () => {
    console.log(`[factory] webhook server on :${config.factory.webhookPort}`);
  });

  console.log("[factory] all systems go");
}

main().catch((err) => {
  console.error("[factory] fatal:", err);
  process.exit(1);
});
