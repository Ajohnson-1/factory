import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { EmbedBuilder, Interaction } from "discord.js";
import {
  DiscordBot,
  buildStatusText,
  isPaused,
  setPaused,
} from "../../src/discord/bot.js";
import { startedEmbed } from "../../src/discord/embeds.js";
import type { Job } from "../../src/state/store.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

// Only the gateway Client is faked — constructing the real one would open a
// websocket. EmbedBuilder / REST / Routes stay real.
vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  class FakeClient {
    channels = { fetch: vi.fn() };
    user: { id: string } | null = null;
    on = vi.fn();
    login = vi.fn();
    constructor(_options?: unknown) {}
  }
  return { ...actual, Client: FakeClient };
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    card_id: "c1",
    card_name: "Card one",
    status: "running",
    branch: "factory/c1",
    pr_url: null,
    error: null,
    ...overrides,
  };
}

function makeDir(): string {
  return makeTempDir();
}

function interaction(overrides: Record<string, unknown> = {}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const i = {
    isChatInputCommand: () => true,
    commandName: "factory",
    options: { getSubcommand: () => "status" },
    reply,
    ...overrides,
  } as unknown as Interaction;
  return { i, reply };
}

/** The bot under test, with its faked gateway client exposed for stubbing. */
function makeBot(): {
  bot: DiscordBot;
  client: { channels: { fetch: ReturnType<typeof vi.fn> } };
} {
  vi.stubEnv("DISCORD_CHANNEL_ID", "chan");
  const bot = new DiscordBot();
  const client = (bot as unknown as {
    client: { channels: { fetch: ReturnType<typeof vi.fn> } };
  }).client;
  return { bot, client };
}

describe("setPaused / isPaused", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeDir();
  });

  afterEach(() => {
    removeTempDir(dir);
  });

  it("reports not paused when no flag file exists", () => {
    expect(isPaused(dir)).toBe(false);
  });

  it("creates the flag file and reports paused after setPaused(true)", () => {
    setPaused(true, dir);

    expect(fs.existsSync(path.join(dir, "paused"))).toBe(true);
    expect(isPaused(dir)).toBe(true);
  });

  it("removes the flag file and reports not paused after setPaused(false)", () => {
    setPaused(true, dir);
    setPaused(false, dir);

    expect(fs.existsSync(path.join(dir, "paused"))).toBe(false);
    expect(isPaused(dir)).toBe(false);
  });

  it("is a no-op when unpausing a directory that was never paused", () => {
    expect(() => setPaused(false, dir)).not.toThrow();
    expect(isPaused(dir)).toBe(false);
  });

  it("creates a missing data directory when pausing", () => {
    const nested = path.join(dir, "nested", "deeper");

    setPaused(true, nested);

    expect(isPaused(nested)).toBe(true);
  });

  it("keeps two data directories independent", () => {
    const other = makeDir();
    try {
      setPaused(true, dir);

      expect(isPaused(dir)).toBe(true);
      expect(isPaused(other)).toBe(false);
    } finally {
      removeTempDir(other);
    }
  });
});

describe("buildStatusText", () => {
  it("reports that there is nothing to show for an empty job list", () => {
    expect(buildStatusText([])).toBe("No jobs yet.");
  });

  it("formats one job as an uppercased status and the card name", () => {
    expect(buildStatusText([job()])).toBe("RUNNING — Card one");
  });

  it("appends the PR url when the job has one", () => {
    expect(
      buildStatusText([job({ status: "review", pr_url: "https://x/pull/1" })])
    ).toBe("REVIEW — Card one (https://x/pull/1)");
  });

  it("omits the parenthesis when pr_url is null", () => {
    expect(buildStatusText([job({ pr_url: null })])).not.toContain("(");
  });

  it("joins multiple jobs with newlines", () => {
    const text = buildStatusText([
      job({ card_id: "c1", card_name: "Card one", status: "done" }),
      job({
        card_id: "c2",
        card_name: "Card two",
        status: "failed",
        pr_url: "https://x/pull/2",
      }),
      job({ card_id: "c3", card_name: "Card three", status: "queued" }),
    ]);

    expect(text).toBe(
      "DONE — Card one\nFAILED — Card two (https://x/pull/2)\nQUEUED — Card three"
    );
  });
});

describe("DiscordBot.onInteraction", () => {
  let bot: DiscordBot;

  beforeEach(() => {
    ({ bot } = makeBot());
  });

  it("ignores an interaction that is not a chat input command", async () => {
    const { i, reply } = interaction({ isChatInputCommand: () => false });

    await bot.onInteraction(i);

    expect(reply).not.toHaveBeenCalled();
  });

  it("ignores a chat input command that is not named factory", async () => {
    const { i, reply } = interaction({ commandName: "deploy" });

    await bot.onInteraction(i);

    expect(reply).not.toHaveBeenCalled();
  });

  it("replies with a fenced status block for the status subcommand", async () => {
    const { i, reply } = interaction();

    await bot.onInteraction(i);

    expect(reply).toHaveBeenCalledTimes(1);
    const body = reply.mock.calls[0][0] as { content: string };
    expect(body.content.startsWith("**Factory status**\n```")).toBe(true);
    expect(body.content.endsWith("```")).toBe(true);
  });

  it("writes the pause flag and confirms for the pause subcommand", async () => {
    const dir = makeDir();
    // setPaused() resolves the default data dir from process.cwd() at call time.
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const { i, reply } = interaction({ options: { getSubcommand: () => "pause" } });

    try {
      await bot.onInteraction(i);

      expect(isPaused()).toBe(true);
      expect(reply).toHaveBeenCalledWith("Factory paused.");
    } finally {
      removeTempDir(dir);
    }
  });

  it("removes the pause flag and confirms for the resume subcommand", async () => {
    const dir = makeDir();
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    setPaused(true);
    const { i, reply } = interaction({ options: { getSubcommand: () => "resume" } });

    try {
      await bot.onInteraction(i);

      expect(isPaused()).toBe(false);
      expect(reply).toHaveBeenCalledWith("Factory resumed.");
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("DiscordBot.send", () => {
  it("sends the embed to the configured channel", async () => {
    const { bot, client } = makeBot();
    const send = vi.fn().mockResolvedValue(undefined);
    client.channels.fetch.mockResolvedValue({ send });
    const embed = startedEmbed("Card one", "factory/c1") as EmbedBuilder;

    await bot.send(embed);

    expect(client.channels.fetch).toHaveBeenCalledWith("chan");
    expect(send).toHaveBeenCalledWith({ embeds: [embed] });
  });

  it("does nothing when the channel cannot be fetched", async () => {
    const { bot, client } = makeBot();
    client.channels.fetch.mockResolvedValue(null);

    await expect(
      bot.send(startedEmbed("Card one", "factory/c1"))
    ).resolves.toBeUndefined();
    expect(client.channels.fetch).toHaveBeenCalledTimes(1);
  });
});
