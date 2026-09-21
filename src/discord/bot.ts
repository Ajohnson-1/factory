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

const PAUSE_FLAG = path.resolve(process.cwd(), "data", "paused");

export function isPaused(): boolean {
  return fs.existsSync(PAUSE_FLAG);
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

  private async onInteraction(i: import("discord.js").Interaction): Promise<void> {
    if (!i.isChatInputCommand()) return;
    if (i.commandName !== "factory") return;
    const sub = i.options.getSubcommand();
    if (sub === "status") {
      const jobs = store.all();
      const text =
        jobs.length === 0
          ? "No jobs yet."
          : jobs
              .map(
                (j) =>
                  `${j.status.toUpperCase()} — ${j.card_name}${j.pr_url ? ` (${j.pr_url})` : ""}`
              )
              .join("\n");
      await i.reply({ content: `**Factory status**\n\`\`\`${text}\`\`\`` });
    } else if (sub === "pause" || sub === "resume") {
      if (sub === "pause") {
        fs.mkdirSync(path.dirname(PAUSE_FLAG), { recursive: true });
        fs.writeFileSync(PAUSE_FLAG, "1");
      } else {
        fs.rmSync(PAUSE_FLAG, { force: true });
      }
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
