import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { store } from "../state/store.js";
import type { AgentRun, Store } from "../state/store.js";
import { agentLabel } from "./embeds.js";
import type { Job } from "../state/store.js";

function defaultDataDir(): string {
  return path.resolve(process.cwd(), "data");
}

/** Turn the worker on/off by writing (or removing) a flag file. */
export function setPaused(paused: boolean, dataDir: string = defaultDataDir()): void {
  const flag = path.join(dataDir, "paused");
  if (paused) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(flag, "1");
  } else {
    fs.rmSync(flag, { force: true });
  }
}

export function isPaused(dataDir: string = defaultDataDir()): boolean {
  return fs.existsSync(path.join(dataDir, "paused"));
}

/** Per-card review totals, as `Store.usageByReviewCard` returns them. */
export interface CardReviewUsage {
  card_id: string;
  reviews: number;
  reported: number;
  input: number;
  output: number;
  cache_read: number;
}

/**
 * Per-card token totals, as `Store.usageByCard` returns them.
 *
 * `reported` is the runs that carried a `usage` event. The totals of a run that
 * reported nothing are NULL, and SQL sums them to 0 — so without this count a
 * card whose runtime never reported usage would read as a card that cost
 * nothing, which is the distinction `setRunDone` deliberately keeps.
 */
export interface CardUsage {
  card_id: string;
  runs: number;
  reported: number;
  input: number;
  output: number;
  cache_read: number;
}

/**
 * Plain-text body of `/factory status`.
 *
 * `runs` are the card's in-flight `agent_runs` (phase 2.2): a card being driven
 * by a graph is otherwise indistinguishable from a single-agent card, which
 * makes a stalled fan-out invisible to whoever is watching the channel.
 *
 * `usage` is the per-card spend (phase 2.2 open issue #6). `MAX_AGENT_RUNS` caps
 * how many runs a card may have; only these numbers make it a *cost* limit
 * rather than a count.
 *
 * `reviewUsage` is the same for phase 2.3's reviewer, which is deliberately not
 * part of `runs`: a card's graph budget and its review budget are two knobs an
 * operator tunes separately, so the numbers stay on separate lines.
 */
export function buildStatusText(
  jobs: Job[],
  runs: AgentRun[] = [],
  usage: CardUsage[] = [],
  reviewUsage: CardReviewUsage[] = []
): string {
  if (jobs.length === 0) return "No jobs yet.";

  const byCard = new Map<string, AgentRun[]>();
  for (const run of runs) {
    const list = byCard.get(run.card_id);
    if (list) list.push(run);
    else byCard.set(run.card_id, [run]);
  }
  const spend = new Map<string, CardUsage>(
    usage.map((u) => [u.card_id, u] as [string, CardUsage])
  );
  const reviewSpend = new Map<string, CardReviewUsage>(
    reviewUsage.map((u) => [u.card_id, u] as [string, CardReviewUsage])
  );

  return jobs
    .map((j) => {
      const head = `${j.status.toUpperCase()} — ${j.card_name}${j.pr_url ? ` (${j.pr_url})` : ""}`;
      const children = (byCard.get(j.card_id) ?? []).map(
        (run) => `  - ${agentLabel(run.role, run.run_id)}: ${run.status}`
      );
      const u = spend.get(j.card_id);
      // Only cards that have run rows get a spend line: `0 in / 0 out` next to a
      // card that has never spent anything is noise that reads like a bug.
      // A card whose runs all failed before reporting is not free, it is
      // unknown, and the line has to be able to say so.
      let total = "";
      if (u) {
        const scope =
          u.reported === u.runs
            ? `(${u.runs} run${u.runs === 1 ? "" : "s"})`
            : `(${u.reported} of ${u.runs} run${u.runs === 1 ? "" : "s"} reported)`;
        total =
          u.reported === 0
            ? `  spend: usage not reported (${u.runs} run${u.runs === 1 ? "" : "s"})`
            : `  spend: ${u.input} in / ${u.output} out / ${u.cache_read} cache read ${scope}`;
      }
      const r = reviewSpend.get(j.card_id);
      // Reviews are on a separate line rather than folded into the total above
      // because they answer different questions: "is this card's graph getting
      // expensive" is the operator's decision about MAX_AGENT_RUNS, and "is the
      // reviewer spending more than the work" is a decision about REVIEW_MAX_RUNS_PER_CARD.
      let reviewLine = "";
      if (r) {
        const scope =
          r.reported === r.reviews
            ? `(${r.reviews} review${r.reviews === 1 ? "" : "s"})`
            : `(${r.reported} of ${r.reviews} review${r.reviews === 1 ? "" : "s"} reported)`;
        reviewLine =
          r.reported === 0
            ? `  review spend: not reported (${r.reviews} review${r.reviews === 1 ? "" : "s"})`
            : `  review spend: ${r.input} in / ${r.output} out / ${r.cache_read} cache read ${scope}`;
      }
      return [head, ...children, ...(total ? [total] : []), ...(reviewLine ? [reviewLine] : [])].join(
        "\n"
      );
    })
    .join("\n");
}

/**
 * Re-queue a card — the one re-trigger path, shared by `/factory retry` and
 * (through `Store.enqueue`) the Trello webhook.
 *
 * Refuses a card that is already running: a second graph over the first would
 * fight it for the same worktree and double the spend.
 */
export function requeueCard(
  store: Store,
  cardId: string
): { ok: boolean; message: string } {
  const job = store.get(cardId);
  if (!job) {
    return {
      ok: false,
      message: `No job for card ${cardId} — it has never been picked up.`,
    };
  }
  const result = store.enqueue(cardId, job.card_name);
  if (result.queued) {
    return {
      ok: true,
      message: result.requeued
        ? `Re-queued "${job.card_name}" as attempt ${result.generation}.`
        : `Queued "${job.card_name}".`,
    };
  }
  return {
    ok: false,
    message:
      job.status === "running"
        ? `"${job.card_name}" is running — not starting a second graph over it.`
        : `"${job.card_name}" is already queued (attempt ${result.generation}).`,
  };
}

export class DiscordBot {
  private client: Client;
  private channel: string;

  constructor() {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.channel = config.discord.channelId();
  }

  /**
   * Log in FIRST, then register slash commands.
   *
   * `client.user` is populated by `login()` — it is the gateway's READY payload
   * that tells the library who it is. Registering before login therefore had no
   * application id to use, and the old `?? ""` fallback turned that into
   * `PUT /applications//commands`, which Discord answers 400 `50035 Invalid Form
   * Body, application_id`. The effect was total: `index.ts` awaits `start()`
   * before it listens, so the process died on every boot and never got as far as
   * serving `/webhook/trello`. Observed live on the 2026-10-05 deploy:
   * `journalctl -u factory` showed exactly that URL and that 400, and
   * `Restart=always` had already put the service on restart #975 against
   * Discord's API.
   *
   * No empty-string fallback this time: an unresolvable application id is now a
   * thrown sentence naming what is missing, not a malformed URL halfway across
   * the network.
   */
  async start(): Promise<void> {
    const token = config.discord.botToken();
    this.client.on("interactionCreate", (i) => this.onInteraction(i));
    await this.client.login(token);
    const applicationId = this.client.user?.id;
    if (!applicationId) {
      throw new Error(
        "[discord] logged in but client.user.id is still unset — " +
          "cannot register /factory slash commands without an application id"
      );
    }
    const rest = new REST().setToken(token);
    const commands = [
      {
        name: "factory",
        description: "Factory status and controls",
        options: [
          { name: "status", type: 1, description: "Show all jobs" },
          { name: "pause", type: 1, description: "Stop accepting new cards" },
          { name: "resume", type: 1, description: "Resume accepting cards" },
          {
            name: "retry",
            type: 1,
            description: "Re-queue a finished card with a fresh run budget",
            options: [
              {
                name: "card",
                type: 3,
                description: "Trello card id",
                required: true,
              },
            ],
          },
        ],
      },
    ];
    await rest.put(Routes.applicationCommands(applicationId), {
      body: commands,
    });
    console.log("[discord] bot online");
  }

  async onInteraction(i: import("discord.js").Interaction): Promise<void> {
    if (!i.isChatInputCommand()) return;
    if (i.commandName !== "factory") return;
    const sub = i.options.getSubcommand();
    if (sub === "status") {
      const text = buildStatusText(
        store.all(),
        store.activeRuns(),
        store.usageByCard(),
        store.usageByReviewCard()
      );
      await i.reply({ content: `**Factory status**\n\`\`\`${text}\`\`\`` });
    } else if (sub === "retry") {
      const cardId = i.options.getString("card", true);
      const result = requeueCard(store, cardId);
      await i.reply({ content: result.message });
    } else if (sub === "pause" || sub === "resume") {
      setPaused(sub === "pause");
      await i.reply(`Factory ${sub === "pause" ? "paused" : "resumed"}.`);
    }
  }

  async send(embed: import("discord.js").EmbedBuilder): Promise<void> {
    const ch = (await this.client.channels.fetch(this.channel)) as
      | import("discord.js").TextChannel
      | null;
    if (ch) await ch.send({ embeds: [embed] });
  }
}
