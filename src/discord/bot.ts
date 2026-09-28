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
import type { AgentRun } from "../state/store.js";
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

/**
 * Plain-text body of `/factory status`.
 *
 * `runs` are the card's in-flight `agent_runs` (phase 2.2): a card being driven
 * by a graph is otherwise indistinguishable from a single-agent card, which
 * makes a stalled fan-out invisible to whoever is watching the channel.
 */
export function buildStatusText(jobs: Job[], runs: AgentRun[] = []): string {
  if (jobs.length === 0) return "No jobs yet.";

  const byCard = new Map<string, AgentRun[]>();
  for (const run of runs) {
    const list = byCard.get(run.card_id);
    if (list) list.push(run);
    else byCard.set(run.card_id, [run]);
  }

  return jobs
    .map((j) => {
      const head = `${j.status.toUpperCase()} — ${j.card_name}${j.pr_url ? ` (${j.pr_url})` : ""}`;
      const children = (byCard.get(j.card_id) ?? []).map(
        (run) => `  - ${agentLabel(run.role, run.run_id)}: ${run.status}`
      );
      return [head, ...children].join("\n");
    })
    .join("\n");
}

export class DiscordBot {
  private client: Client;
  private channel: string;

  constructor() {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.channel = config.discord.channelId();
  }

  async start(): Promise<void> {
    const rest = new REST().setToken(config.discord.botToken());
    const commands = [
      {
        name: "factory",
        description: "Factory status and controls",
        options: [
          { name: "status", type: 1, description: "Show all jobs" },
          { name: "pause", type: 1, description: "Stop accepting new cards" },
          { name: "resume", type: 1, description: "Resume accepting cards" },
        ],
      },
    ];
    await rest.put(Routes.applicationCommands(this.client.user?.id ?? ""), {
      body: commands,
    });
    this.client.on("interactionCreate", (i) => this.onInteraction(i));
    await this.client.login(config.discord.botToken());
    console.log("[discord] bot online");
  }

  async onInteraction(i: import("discord.js").Interaction): Promise<void> {
    if (!i.isChatInputCommand()) return;
    if (i.commandName !== "factory") return;
    const sub = i.options.getSubcommand();
    if (sub === "status") {
      const text = buildStatusText(store.all(), store.activeRuns());
      await i.reply({ content: `**Factory status**\n\`\`\`${text}\`\`\`` });
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
