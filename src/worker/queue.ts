import { store } from "../state/store.js";
import { isPaused, type DiscordBot } from "../discord/bot.js";
import { runCard } from "./runner.js";

const TICK_MS = 15_000;

/**
 * Simple single-slot worker: polls the queue, runs one card at a time.
 * One agent at a time keeps costs predictable (MVP scope).
 */
export async function startWorker(bot: DiscordBot): Promise<void> {
  console.log("[worker] started");
  setInterval(async () => {
    try {
      if (isPaused() || store.isRunning()) return;
      const job = store.nextQueued();
      if (!job) return;
      console.log(`[worker] starting card ${job.card_id} (${job.card_name})`);
      await runCard(job.card_id, bot);
    } catch (err) {
      console.error("[worker] tick error:", err);
    }
  }, TICK_MS);
}
