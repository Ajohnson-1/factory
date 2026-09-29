import { store, type Store } from "../state/store.js";
import { isPaused, type DiscordBot } from "../discord/bot.js";
import { runCard } from "./runner.js";

const TICK_MS = 15_000;

/**
 * Close out whatever the previous process left mid-flight.
 *
 * Runs once, before the first tick: at that moment nothing in this process can
 * be live, which is the only point at which a `running` row is provably stale.
 * Called on a timer it would reap the card the worker is running right now.
 */
export function reapOrphans(store: Store, log: (line: string) => void = console.log): void {
  const { runs, jobs } = store.reapStale();
  if (!runs.length && !jobs.length) return;
  // Noisy on purpose: this changes state the operator is watching, and a silent
  // flip from `running` to `failed` looks like the factory made it up.
  const cards = [...new Set([...runs.map((r) => r.card_id), ...jobs.map((j) => j.card_id)])];
  log(
    `[worker] reaped ${runs.length} stale agent run(s), ${jobs.length} running job(s) ` +
      `[cards: ${cards.join(", ")}]`
  );
}

/**
 * Simple single-slot worker: polls the queue, runs one card at a time.
 * One agent at a time keeps costs predictable (MVP scope).
 */
export async function startWorker(bot: DiscordBot): Promise<void> {
  reapOrphans(store);
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
