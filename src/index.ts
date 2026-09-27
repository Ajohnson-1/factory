import { config } from "./config.js";
import { DiscordBot } from "./discord/bot.js";
import { startWorker } from "./worker/queue.js";
import { createWebhookServer } from "./server.js";

async function main(): Promise<void> {
  const bot = new DiscordBot();
  await bot.start();
  await startWorker(bot);

  const port = config.factory.webhookPort;
  createWebhookServer(bot).listen(port, () => {
    console.log(`[factory] webhook server on :${port}`);
  });

  console.log("[factory] all systems go");
}

main().catch((err) => {
  console.error("[factory] fatal:", err);
  process.exit(1);
});
