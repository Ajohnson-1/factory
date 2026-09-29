import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import type { EmbedBuilder } from "discord.js";
import { runCard, type RunCardDeps } from "../../src/worker/runner.js";
import type { AgentRunOptions } from "../../src/agent/types.js";
import type { DiscordBot } from "../../src/discord/bot.js";
import { createStore, type Store } from "../../src/state/store.js";
import type { GraphDeps, GraphResult } from "../../src/agents/graph.js";
import type { AgentEvent } from "../../src/agents/spawn.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

// Nothing here may touch docker or the network: the whole point of `deps.graph`
// is that a card's graph can be driven from a fake.
vi.mock("../../src/agent/container.js", () => ({
  runAgentInContainer: vi.fn(async () => ({ ok: true, text: "unused" })),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: vi.fn(async () => ({ id: "runtime" })) },
  SessionManager: { inMemory: vi.fn(() => ({ id: "smgr" })) },
  createAgentSession: vi.fn(async () => ({
    session: { prompt: vi.fn(), subscribe: vi.fn(), dispose: vi.fn() },
  })),
}));

const CARD_ID = "card-1";
const CARD_NAME = "Add a greet function";
const READY = "list-ready";
const REVIEW = "list-review";
const DONE = "list-done";
const BRANCH = `factory/${CARD_ID}`;
const PR_URL = "https://github.com/acme/app/pull/7";
const WT_DIR = "/tmp/wt-card-1";
const GIT_DIR = "/tmp/repo/.git";
const CARD = { id: CARD_ID, name: CARD_NAME, desc: "greet(name) returns hi", url: "https://trello.com/c/card-1" };

let store: Store;
let dir: string;
let send: Mock;
let bot: DiscordBot;
let trello: Record<string, ReturnType<typeof vi.fn>>;
let github: Record<string, ReturnType<typeof vi.fn>>;
let worktree: Record<string, ReturnType<typeof vi.fn>>;
let runAgent: ReturnType<typeof vi.fn>;
let committed: Array<{ dir: string; message: string }>;

type Mock = ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("TRELLO_API_KEY", "key");
  vi.stubEnv("TRELLO_TOKEN", "token");
  vi.stubEnv("TRELLO_BOARD_ID", "board");
  vi.stubEnv("READY_LIST_ID", READY);
  vi.stubEnv("REVIEW_LIST_ID", REVIEW);
  vi.stubEnv("DONE_LIST_ID", DONE);
  vi.stubEnv("CI_TIMEOUT_MS", "1000");

  dir = makeTempDir();
  store = createStore(path.join(dir, "test.db"));

  send = vi.fn(async (_embed: EmbedBuilder): Promise<void> => {});
  bot = { send } as unknown as DiscordBot;

  trello = {
    getCard: vi.fn(async () => CARD),
    moveCard: vi.fn(async () => {}),
    addComment: vi.fn(async () => {}),
    createWebhook: vi.fn(async () => {}),
  };
  github = {
    createPR: vi.fn(async () => PR_URL),
    ciStatus: vi.fn(async () => "passed"),
    waitForCI: vi.fn(async () => "passed"),
  };
  committed = [];
  worktree = {
    create: vi.fn(() => ({ dir: WT_DIR, branch: BRANCH })),
    remove: vi.fn(() => {}),
    push: vi.fn(() => {}),
    gitDir: vi.fn(() => GIT_DIR),
    commit: vi.fn((baseDir: string, message: string) => {
      committed.push({ dir: baseDir, message });
      return true;
    }),
  };
  runAgent = vi.fn(async (_opts: AgentRunOptions): Promise<void> => {});
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

function graphResult(overrides: Partial<GraphResult> = {}): GraphResult {
  return {
    status: "ok",
    summary: "two coders landed",
    runs: 2,
    baseHeadBefore: "aaaa111",
    baseHeadAfter: "bbbb222",
    ...overrides,
  };
}

/** A graph fake that reports what it was handed and resolves `result`. */
function fakeGraph(
  result: GraphResult | Error,
  extra?: (deps: GraphDeps) => Promise<void>
): { graph: (deps: GraphDeps) => Promise<GraphResult>; seen: () => GraphDeps | undefined } {
  let seenDeps: GraphDeps | undefined;
  return {
    seen: () => seenDeps,
    graph: vi.fn(async (deps: GraphDeps) => {
      seenDeps = deps;
      if (extra) await extra(deps);
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function deps(extra: Partial<RunCardDeps> = {}): RunCardDeps {
  return { store, trello, github, worktree, runAgent, ...extra } as unknown as RunCardDeps;
}

function queueCard(): void {
  store.enqueue(CARD_ID, CARD_NAME);
}

function job() {
  return store.get(CARD_ID);
}

function titles(): string[] {
  return (send.mock.calls as unknown as Array<[EmbedBuilder]>).map(
    (call) => String(call[0].data?.title)
  );
}

function activityOf(titleFragment: string): string | undefined {
  for (const call of send.mock.calls) {
    const embed = call[0] as EmbedBuilder;
    if (String(embed.data?.title).includes(titleFragment)) {
      return embed.data?.fields?.find((f) => f.name === "Activity")?.value as
        | string
        | undefined;
    }
  }
  return undefined;
}

describe("runCard on the graph path", () => {
  it("hands the graph the card, the base worktree and the shared .git", async () => {
    queueCard();
    const { graph, seen } = fakeGraph(graphResult());

    await runCard(CARD_ID, bot, deps({ graph }));

    const given = seen();
    expect(given).toBeDefined();
    expect(given?.cardId).toBe(CARD_ID);
    expect(given?.baseDir).toBe(WT_DIR);
    expect(given?.gitDir).toBe(GIT_DIR);
    expect(given?.card).toMatchObject({ name: CARD_NAME, desc: CARD.desc });
    expect(given?.store).toBe(store);
    // A card that has never been re-triggered is on its first attempt.
    expect(given?.attempt).toBe(1);
  });

  /**
   * open-issues #1, the other half: the graph can only budget per attempt if the
   * runner tells it which attempt this is. The generation lives on the job row,
   * which is the one place that knows it.
   */
  it("hands the graph the card's current attempt after a re-trigger", async () => {
    queueCard();
    store.setRunning(CARD_ID, BRANCH);
    store.setFailed(CARD_ID, "run budget exhausted");
    store.enqueue(CARD_ID, CARD_NAME);
    const { graph, seen } = fakeGraph(graphResult());

    await runCard(CARD_ID, bot, deps({ graph }));

    expect(seen()?.attempt).toBe(2);
  });

  it("does not run a single agent once a graph is driving the card", async () => {
    queueCard();
    const { graph } = fakeGraph(graphResult());

    await runCard(CARD_ID, bot, deps({ graph }));

    expect(runAgent).not.toHaveBeenCalled();
  });

  it("pushes, opens the PR and moves the card to Review when the graph landed work", async () => {
    queueCard();
    const { graph } = fakeGraph(graphResult());

    await runCard(CARD_ID, bot, deps({ graph }));

    expect(worktree.push).toHaveBeenCalledWith(WT_DIR, BRANCH);
    expect(github.createPR).toHaveBeenCalled();
    expect(job()?.status).toBe("review");
    expect(job()?.pr_url).toBe(PR_URL);
    expect(trello.moveCard).toHaveBeenCalledWith(CARD_ID, REVIEW);
    expect(titles()).toContain("✅ PR ready for review");
  });

  // The behaviour difference from the MVP path, and the reason the graph gets its
  // own branch in runCard: children committed and merged onto the card branch
  // already, so a clean working tree is the normal outcome, not a failure.
  it("ships even though the working tree is clean because the children already committed", async () => {
    queueCard();
    worktree.commit.mockImplementation(() => false);
    const { graph } = fakeGraph(graphResult());

    await runCard(CARD_ID, bot, deps({ graph }));

    expect(job()?.status).toBe("review");
    expect(worktree.push).toHaveBeenCalled();
  });

  it("still fails a single-agent run that leaves no changes behind", async () => {
    queueCard();
    worktree.commit.mockImplementation(() => false);
    vi.stubEnv("AGENT_GRAPH", "0");

    await runCard(CARD_ID, bot, deps({ graph: undefined }));

    expect(job()?.status).toBe("failed");
    expect(job()?.error).toContain("no changes to ship");
    expect(worktree.push).not.toHaveBeenCalled();
  });

  it("refuses to ship when the graph landed nothing", async () => {
    queueCard();
    const { graph } = fakeGraph(
      graphResult({ status: "failed", summary: "MERGE CONFLICT on src/x.ts" })
    );

    await runCard(CARD_ID, bot, deps({ graph }));

    expect(worktree.push).not.toHaveBeenCalled();
    expect(github.createPR).not.toHaveBeenCalled();
    expect(job()?.status).toBe("failed");
    expect(job()?.error).toContain("MERGE CONFLICT on src/x.ts");
    expect(titles()).toContain("❌ Factory run failed");
  });

  // The invariant behind #2: the worker's gate is `store.isRunning()`, which is
  // global. A hung orchestrator is only survivable because its capped wall clock
  // ends the run and this path always marks the job failed, releasing the gate.
  it("treats an orchestrator that merely timed out as a failed card", async () => {
    queueCard();
    const { graph } = fakeGraph(graphResult({ status: "timeout", summary: "timed out" }));

    await runCard(CARD_ID, bot, deps({ graph }));

    expect(job()?.status).toBe("failed");
    expect(job()?.error).toContain("timed out");
    expect(worktree.remove).toHaveBeenCalledWith(CARD_ID);
    // The gate every other card is waiting on is open again.
    expect(store.isRunning()).toBe(false);
    expect(store.activeRuns(CARD_ID)).toEqual([]);
  });

  it("ships an ok graph whose summary happens to be empty", async () => {
    queueCard();
    const { graph } = fakeGraph(graphResult({ summary: "" }));

    await runCard(CARD_ID, bot, deps({ graph }));

    expect(job()?.status).toBe("review");
  });

  it("fails the card and still cleans up when the graph itself throws", async () => {
    queueCard();
    const { graph } = fakeGraph(new Error("could not open the spawn channel"));

    await runCard(CARD_ID, bot, deps({ graph }));

    expect(job()?.status).toBe("failed");
    expect(job()?.error).toContain("could not open the spawn channel");
    expect(worktree.remove).toHaveBeenCalledWith(CARD_ID);
  });

  it("labels each child on Discord by role and run so a parallel stream reads", async () => {
    queueCard();
    const events: AgentEvent[] = [
      { kind: "started", role: "coder", runId: "c2", task: "add farewell()" },
      { kind: "tool", role: "coder", runId: "c2", toolName: "edit" },
      { kind: "done", role: "coder", runId: "c2", status: "ok" },
    ];
    const { graph } = fakeGraph(graphResult(), async (given) => {
      for (const event of events) given.onEvent?.(event);
    });

    await runCard(CARD_ID, bot, deps({ graph }));

    expect(titles()).toContain("🤖 coder-2 started");
    expect(activityOf("In progress")).toBe("[coder-2] tool: edit");
    expect(titles()).toContain("✅ coder-2 ok");
  });

  it("keeps a working card working when a Discord send for an agent event fails", async () => {
    queueCard();
    send.mockImplementation(async (embed: EmbedBuilder) => {
      if (String(embed.data?.title).includes("coder-1")) throw new Error("discord 429");
    });
    const { graph } = fakeGraph(graphResult(), async (given) => {
      given.onEvent?.({ kind: "started", role: "coder", runId: "c1", task: "greet" });
      await new Promise((resolve) => setImmediate(resolve));
    });

    await runCard(CARD_ID, bot, deps({ graph }));

    expect(job()?.status).toBe("review");
  });
});
