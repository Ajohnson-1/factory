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
  requeueCard,
  setPaused,
} from "../../src/discord/bot.js";
import { startedEmbed } from "../../src/discord/embeds.js";
import { createStore, type AgentRun, type Job, type Store } from "../../src/state/store.js";
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

/** One in-flight child, as `store.activeRuns()` hands them back. */
function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    run_id: "c1",
    card_id: "c1",
    attempt: 1,
    role: "coder",
    status: "running",
    branch: "factory/c1-c1",
    worktree: "/tmp/wt-c1-c1",
    summary: null,
    started_at: 1,
    ended_at: null,
    usage_in: null,
    usage_out: null,
    usage_cache_read: null,
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
  it("lists a card's running children under it, which is the graph view", () => {
    const text = buildStatusText([job()], [run(), run({ run_id: "c2", role: "verifier" })]);

    expect(text).toBe(
      "RUNNING — Card one\n  - coder-1: running\n  - verifier-2: running"
    );
  });

  // Status is a snapshot: finished children are already in the embed timeline and
  // the git history, and listing them here would make a long card unreadable.
  it("shows only the children handed in, so callers can pass activeRuns()", () => {
    const text = buildStatusText([job()], [
      run(),
      run({ run_id: "c9", role: "coder", status: "ok", ended_at: 123 }),
    ]);

    expect(text).toContain("- coder-1: running");
    expect(text).toContain("- coder-9: ok");
  });

  it("never shows another card's children under this one", () => {
    const text = buildStatusText(
      [job({ card_id: "mine" }), job({ card_id: "other", card_name: "Card two" })],
      [run({ card_id: "other", run_id: "c7" })]
    );

    expect(text).toContain("RUNNING — Card one\nRUNNING — Card two\n  - coder-7: running");
  });

  it("leaves a job without children on its own", () => {
    expect(buildStatusText([job()], [])).toBe("RUNNING — Card one");
  });

  it("defaults to no children at all, keeping the single-agent shape", () => {
    expect(buildStatusText([job({ card_id: "c1" })])).toBe("RUNNING — Card one");
  });

  /**
   * open-issues #6: `MAX_AGENT_RUNS` was only ever a count. With a spend line
   * next to it, "this card has used 9 of 12 runs" also answers "what has it
   * cost", which is the question that actually decides whether to re-trigger.
   */
  it("adds a per-card spend line when the card has run rows", () => {
    const text = buildStatusText([job()], [], [
      { card_id: "c1", runs: 3, reported: 3, input: 12_000, output: 800, cache_read: 40_000 },
    ]);

    expect(text).toBe(
      "RUNNING — Card one\n  spend: 12000 in / 800 out / 40000 cache read (3 runs)"
    );
  });

  it("says run, not runs, for a single-run card", () => {
    const text = buildStatusText([job()], [], [
      { card_id: "c1", runs: 1, reported: 1, input: 5, output: 6, cache_read: 7 },
    ]);

    expect(text).toContain("(1 run)");
  });

  it("leaves a card that has never spent anything without a spend line", () => {
    const text = buildStatusText(
      [job({ card_id: "c1" }), job({ card_id: "other", card_name: "Card two" })],
      [],
      [{ card_id: "other", runs: 2, reported: 2, input: 1, output: 1, cache_read: 0 }]
    );

    expect(text.split("\n")).toHaveLength(3);
    expect(text).not.toMatch(/Card one\n  spend/);
    expect(text).toContain("Card two\n  spend: 1 in");
  });

  /**
   * `usageByCard` COALESCEs a NULL sum to 0, so a card whose runs all died
   * before reporting looks identical to a card that cost nothing. This line is
   * the only place an operator sees the number, so it is where the two have to
   * come apart.
   */
  it("says usage not reported rather than 0 in / 0 out when no run reported", () => {
    const text = buildStatusText([job()], [], [
      { card_id: "c1", runs: 2, reported: 0, input: 0, output: 0, cache_read: 0 },
    ]);

    expect(text).toContain("spend: usage not reported (2 runs)");
    expect(text).not.toContain("0 in / 0 out");
  });

  /**
   * Phase 2.3: the reviewer spends tokens on every push and appears nowhere in
   * `runs`, so without this line its cost is invisible in exactly the view that
   * exists to answer "what has this card cost".
   */
  it("adds a separate review line with its own count and spend", () => {
    const text = buildStatusText([job()], [], [], [
      { card_id: "c1", reviews: 3, reported: 3, input: 300, output: 30, cache_read: 3_000 },
    ]);

    expect(text).toContain("RUNNING — Card one");
    expect(text).toContain("review spend: 300 in / 30 out / 3000 cache read (3 reviews)");
    // Graph spend and review spend stay on separate lines, because they are two
    // different limits an operator would be tuning.
    expect(text).not.toMatch(/^  spend:/m);
  });

  it("says a card had reviews whose cost was never reported", () => {
    const text = buildStatusText([job()], [], [], [
      { card_id: "c1", reviews: 2, reported: 0, input: 0, output: 0, cache_read: 0 },
    ]);

    expect(text).toContain("review spend: not reported (2 reviews)");
    expect(text).not.toContain("0 in / 0 out");
  });

  it("marks a review line partial when only some reviews reported", () => {
    const text = buildStatusText([job()], [], [], [
      { card_id: "c1", reviews: 4, reported: 1, input: 100, output: 10, cache_read: 0 },
    ]);

    expect(text).toContain(
      "review spend: 100 in / 10 out / 0 cache read (1 of 4 reviews reported)"
    );
  });

  it("leaves a card that has never been reviewed without a review line", () => {
    const text = buildStatusText([job()], [], [], []);

    expect(text).not.toMatch(/review spend:/);
  });

  it("names the reporting subset when only some runs carried usage", () => {
    const text = buildStatusText([job()], [], [
      { card_id: "c1", runs: 4, reported: 3, input: 900, output: 30, cache_read: 0 },
    ]);

    expect(text).toContain("spend: 900 in / 30 out / 0 cache read (3 of 4 runs reported)");
  });
});

describe("requeueCard", () => {
  let dbDir: string;
  let cards: Store;

  beforeEach(() => {
    dbDir = makeDir();
    cards = createStore(path.join(dbDir, "retry.db"));
  });

  afterEach(() => {
    cards.close();
    removeTempDir(dbDir);
  });

  it("re-queues a failed card with a fresh attempt", () => {
    cards.enqueue("c1", "Card one");
    cards.setRunning("c1", "factory/c1");
    cards.setFailed("c1", "run budget exhausted");

    const result = requeueCard(cards, "c1");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("attempt 2");
    expect(cards.get("c1")?.status).toBe("queued");
    // The point of the whole exercise: the next graph budgets against attempt 2,
    // so the 12 runs attempt 1 spent are not on the new attempt's bill.
    expect(cards.attemptFor("c1")).toBe(2);
    expect(cards.countRuns("c1", 2)).toBe(0);
  });

  it("refuses a card that is running, rather than starting a second graph over it", () => {
    cards.enqueue("c1", "Card one");
    cards.setRunning("c1", "factory/c1");

    const result = requeueCard(cards, "c1");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("is running");
    expect(cards.get("c1")?.status).toBe("running");
    expect(cards.attemptFor("c1")).toBe(1);
  });

  it("says a card that is already queued is already queued", () => {
    cards.enqueue("c1", "Card one");

    const result = requeueCard(cards, "c1");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("already queued");
  });

  it("refuses a card the factory has never picked up", () => {
    const result = requeueCard(cards, "nope");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("No job for card nope");
    expect(cards.get("nope")).toBeUndefined();
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

  it("replies with the outcome of a retry, asking for the card by id", async () => {
    const getString = vi.fn(() => "card-9");
    const { i, reply } = interaction({
      options: { getSubcommand: () => "retry", getString },
    });

    await bot.onInteraction(i);

    expect(getString).toHaveBeenCalledWith("card", true);
    expect(reply).toHaveBeenCalledTimes(1);
    const body = reply.mock.calls[0][0] as { content: string };
    // The default store has never seen `card-9`, so the honest answer is the
    // refusal — which is also the only thing this test can assert without
    // reaching into the module-level store.
    expect(body.content).toContain("No job for card card-9");
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
