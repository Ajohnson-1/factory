import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import path from "node:path";
import type { EmbedBuilder } from "discord.js";

// runner.ts imports both agent runtimes, so neither may load for real here: the
// pi SDK is stubbed at the module boundary and the container module is mocked,
// which also lets these tests assert exactly what the host handed the container.
const container = vi.hoisted(() => ({
  runAgentInContainer: vi.fn(
    async (_opts: {
      dir: string;
      gitDir?: string;
      prompt: string;
      onTool?: (toolName: string) => void;
      image?: string;
    }): Promise<{ ok: boolean; text: string }> => ({
      ok: true,
      text: "agent finished",
    })
  ),
}));

vi.mock("../../src/agent/container.js", () => ({
  runAgentInContainer: container.runAgentInContainer,
}));

// A working fake: the in-process runtime is exercised in test/agent/in-process.test.ts,
// here it only has to not explode when AGENT_RUNTIME=process is selected.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: vi.fn(async () => ({ id: "runtime" })) },
  SessionManager: { inMemory: vi.fn(() => ({ id: "smgr" })) },
  createAgentSession: vi.fn(async () => ({
    session: {
      prompt: vi.fn(async (_prompt: string) => {}),
      subscribe: vi.fn(),
      dispose: vi.fn(),
    },
  })),
}));

import {
  buildAgentPrompt,
  runAgentContainer,
  runCard,
  selectAgentRuntime,
  type AgentRunOptions,
  type RunCardDeps,
  type RunAgent,
} from "../../src/worker/runner.js";
import { runAgentProcess } from "../../src/agent/in-process.js";
import { createStore, type Store } from "../../src/state/store.js";
import type { DiscordBot } from "../../src/discord/bot.js";
import type { TrelloCard } from "../../src/trello/client.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

type TrelloClient = typeof import("../../src/trello/client.js").trello;
type GithubClient = typeof import("../../src/github/client.js").github;

const CARD_ID = "card-1";
const CARD_NAME = "Add a greet function";
const CARD_DESC = "Add greet(name) to src/index.js";
const CARD_URL = "https://trello.com/c/card-1";
const READY = "list-ready";
const REVIEW = "list-review";
const DONE = "list-done";
const PR_URL = "https://github.com/o/r/pull/7";
const WT_DIR = "/tmp/wt-card-1";
const GIT_DIR = "/tmp/repo/.git";
const BRANCH = `factory/${CARD_ID}`;

const CARD: TrelloCard = {
  id: CARD_ID,
  name: CARD_NAME,
  desc: CARD_DESC,
  idList: READY,
  url: CARD_URL,
};

type CiState = "passed" | "failed" | "timeout";

let dir: string;
let store: Store;
let send: Mock<(embed: EmbedBuilder) => Promise<void>>;
let bot: DiscordBot;
let trello: TrelloClient;
let github: GithubClient;
let worktree: NonNullable<RunCardDeps["worktree"]>;
let runAgent: Mock<RunAgent>;
let prompts: string[];
let ciState: CiState;
let committed: { dir: string; message: string }[];

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
    getCard: vi.fn(async (_cardId: string): Promise<TrelloCard> => CARD),
    moveCard: vi.fn(async (_cardId: string, _listId: string): Promise<void> => {}),
    addComment: vi.fn(async (_cardId: string, _text: string): Promise<void> => {}),
    createWebhook: vi.fn(async (_cardId: string, _url: string): Promise<void> => {}),
  };

  ciState = "passed";
  github = {
    createPR: vi.fn(
      async (_branch: string, _title: string, _body: string): Promise<string> => PR_URL
    ),
    ciStatus: vi.fn(
      async (_branch: string): Promise<"pending" | "passed" | "failed"> => "passed"
    ),
    waitForCI: vi.fn(
      async (
        _branch: string,
        _opts?: { timeoutMs?: number; pollMs?: number }
      ): Promise<CiState> => ciState
    ),
  };

  worktree = {
    create: vi.fn((_cardId: string, _repoPath?: string) => ({ dir: WT_DIR, branch: BRANCH })),
    remove: vi.fn((_cardId: string, _repoPath?: string) => {}),
    push: vi.fn((_dir: string, _branch: string) => {}),
    gitDir: vi.fn((_dir: string) => GIT_DIR),
    commit: vi.fn((dir: string, message: string) => {
      committed.push({ dir, message });
      return true;
    }),
  };

  prompts = [];
  committed = [];
  runAgent = vi.fn(async (opts: AgentRunOptions): Promise<void> => {
    prompts.push(opts.prompt);
  });

  container.runAgentInContainer.mockReset().mockResolvedValue({
    ok: true,
    text: "agent finished",
  });
  vi.stubEnv("AGENT_RUNTIME", "container");
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key");
});

afterEach(() => {
  store.close();
  removeTempDir(dir);
});

function deps(extra: Partial<RunCardDeps> = {}): RunCardDeps {
  return { store, trello, github, worktree, runAgent, ...extra };
}

function queueCard(): void {
  store.enqueue(CARD_ID, CARD_NAME);
}

function embedTitles(): (string | undefined)[] {
  return send.mock.calls.map((call) => call[0].data.title);
}

function fieldOf(index: number, name: string): string | undefined {
  return send.mock.calls[index]?.[0].data.fields?.find((f) => f.name === name)?.value;
}

describe("buildAgentPrompt", () => {
  it("names the task", () => {
    expect(buildAgentPrompt({ name: CARD_NAME, desc: "" })).toContain(
      `Task: ${CARD_NAME}`
    );
  });

  it("includes the card description as details", () => {
    expect(buildAgentPrompt({ name: CARD_NAME, desc: CARD_DESC })).toContain(
      `Details:\n${CARD_DESC}`
    );
  });

  it("omits the details block when the description is empty", () => {
    expect(buildAgentPrompt({ name: CARD_NAME, desc: "" })).not.toContain("Details:");
  });

  it("tells the agent not to commit — the host owns the commit", () => {
    const prompt = buildAgentPrompt({ name: CARD_NAME, desc: "" });

    expect(prompt).toContain("Do not commit or push");
    expect(prompt).not.toContain("commit all changes");
  });
});

describe("runCard", () => {
  it("does nothing when the card is not in the store", async () => {
    await runCard("unknown-card", bot, deps());

    expect(trello.getCard).not.toHaveBeenCalled();
    expect(worktree.create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("creates the worktree for the queued card", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(worktree.create).toHaveBeenCalledWith(CARD_ID);
  });

  it("runs the agent in the worktree directory with a prompt for the card", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(runAgent.mock.calls[0]?.[0].dir).toBe(WT_DIR);
    expect(runAgent.mock.calls[0]?.[0].gitDir).toBe(GIT_DIR);
    expect(prompts[0]).toContain(CARD_NAME);
    expect(prompts[0]).toContain(CARD_DESC);
  });

  it("commits the agent's work on the host before pushing", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(worktree.commit).toHaveBeenCalledWith(WT_DIR, `factory: ${CARD_NAME}`);
    expect(committed).toHaveLength(1);
  });

  it("pushes only after the commit exists", async () => {
    queueCard();
    const order: string[] = [];
    runAgent.mockImplementation(async () => {
      order.push("agent");
    });
    vi.mocked(worktree.commit).mockImplementation(() => {
      order.push("commit");
      return true;
    });
    vi.mocked(worktree.push).mockImplementation(() => {
      order.push("push");
    });

    await runCard(CARD_ID, bot, deps());

    expect(order).toEqual(["agent", "commit", "push"]);
  });

  it("fails without pushing when the agent changed nothing", async () => {
    queueCard();
    vi.mocked(worktree.commit).mockReturnValue(false);

    await runCard(CARD_ID, bot, deps());

    expect(store.get(CARD_ID)).toMatchObject({
      status: "failed",
      error: "the agent left no changes to ship",
    });
    expect(worktree.push).not.toHaveBeenCalled();
    expect(github.createPR).not.toHaveBeenCalled();
  });

  it("still removes the worktree when there was nothing to ship", async () => {
    queueCard();
    vi.mocked(worktree.commit).mockReturnValue(false);

    await runCard(CARD_ID, bot, deps());

    expect(worktree.remove).toHaveBeenCalledWith(CARD_ID);
  });

  it("pushes the worktree branch", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(worktree.push).toHaveBeenCalledWith(WT_DIR, BRANCH);
  });

  it("opens a PR titled for the factory and linking the card", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(github.createPR).toHaveBeenCalledWith(
      BRANCH,
      `factory: ${CARD_NAME}`,
      expect.stringContaining(CARD_URL)
    );
  });

  it("waits for CI with the configured timeout", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(github.waitForCI).toHaveBeenCalledWith(BRANCH, { timeoutMs: 1000 });
  });

  it("records the card branch on the job", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(store.get(CARD_ID)).toMatchObject({ status: "review", branch: BRANCH });
  });

  it("stores the PR url on the job", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(store.get(CARD_ID)?.pr_url).toBe(PR_URL);
  });

  it("moves the card to the review list", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(trello.moveCard).toHaveBeenCalledWith(CARD_ID, REVIEW);
  });

  it("comments on the card with the PR url", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(trello.addComment).toHaveBeenCalledWith(CARD_ID, expect.stringContaining(PR_URL));
  });

  it("announces the start on Discord before anything else", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(embedTitles()[0]).toBe("🏭 Factory started");
  });

  it("announces the PR as ready for review last", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    const titles = embedTitles();
    expect(titles[titles.length - 1]).toBe("✅ PR ready for review");
  });

  it("always removes the worktree", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps());

    expect(worktree.remove).toHaveBeenCalledWith(CARD_ID);
  });

  it("fails the job with CI failed when the checks are red", async () => {
    queueCard();
    ciState = "failed";

    await runCard(CARD_ID, bot, deps());

    expect(store.get(CARD_ID)).toMatchObject({ status: "failed", error: "CI failed" });
  });

  it("sends the failed embed with the PR url when CI is red", async () => {
    queueCard();
    ciState = "failed";

    await runCard(CARD_ID, bot, deps());

    const titles = embedTitles();
    const last = titles.length - 1;
    expect(titles[last]).toBe("❌ Factory run failed");
    expect(fieldOf(last, "Error")).toContain(PR_URL);
  });

  it("still comments on the card when CI is red", async () => {
    queueCard();
    ciState = "failed";

    await runCard(CARD_ID, bot, deps());

    expect(trello.addComment).toHaveBeenCalledWith(
      CARD_ID,
      expect.stringContaining(PR_URL)
    );
  });

  it("leaves the card in Ready when CI is red", async () => {
    queueCard();
    ciState = "failed";

    await runCard(CARD_ID, bot, deps());

    expect(trello.moveCard).not.toHaveBeenCalled();
  });

  it("removes the worktree even when CI is red", async () => {
    queueCard();
    ciState = "failed";

    await runCard(CARD_ID, bot, deps());

    expect(worktree.remove).toHaveBeenCalledWith(CARD_ID);
  });

  it("fails the job with CI timed out when the gate times out", async () => {
    queueCard();
    ciState = "timeout";

    await runCard(CARD_ID, bot, deps());

    expect(store.get(CARD_ID)).toMatchObject({ status: "failed", error: "CI timed out" });
  });

  it("fails the job with the agent error message", async () => {
    queueCard();
    runAgent.mockRejectedValue(new Error("model exploded"));

    await runCard(CARD_ID, bot, deps());

    expect(store.get(CARD_ID)).toMatchObject({
      status: "failed",
      error: "model exploded",
    });
  });

  it("sends the failed embed when the agent throws", async () => {
    queueCard();
    runAgent.mockRejectedValue(new Error("model exploded"));

    await runCard(CARD_ID, bot, deps());

    expect(embedTitles()).toContain("❌ Factory run failed");
  });

  it("comments on the card when the agent throws", async () => {
    queueCard();
    runAgent.mockRejectedValue(new Error("model exploded"));

    await runCard(CARD_ID, bot, deps());

    expect(trello.addComment).toHaveBeenCalledWith(
      CARD_ID,
      expect.stringContaining("model exploded")
    );
  });

  it("removes the worktree even when the agent throws", async () => {
    queueCard();
    runAgent.mockRejectedValue(new Error("model exploded"));

    await runCard(CARD_ID, bot, deps());

    expect(worktree.remove).toHaveBeenCalledWith(CARD_ID);
  });

  it("does not open a PR when the agent throws", async () => {
    queueCard();
    runAgent.mockRejectedValue(new Error("model exploded"));

    await runCard(CARD_ID, bot, deps());

    expect(github.createPR).not.toHaveBeenCalled();
  });

  it("still resolves when the Trello comment fails", async () => {
    queueCard();
    vi.mocked(trello.addComment).mockRejectedValue(new Error("trello down"));

    await expect(runCard(CARD_ID, bot, deps())).resolves.toBeUndefined();
  });

  it("still removes the worktree when the Trello comment fails", async () => {
    queueCard();
    vi.mocked(trello.addComment).mockRejectedValue(new Error("trello down"));

    await runCard(CARD_ID, bot, deps());

    expect(worktree.remove).toHaveBeenCalledWith(CARD_ID);
  });

  it("keeps a green run in review when the Trello comment fails", async () => {
    queueCard();
    vi.mocked(trello.addComment).mockRejectedValue(new Error("trello down"));

    await runCard(CARD_ID, bot, deps());

    // the PR is open and CI passed: do not downgrade the job to failed
    expect(store.get(CARD_ID)).toMatchObject({ status: "review", pr_url: PR_URL });
    expect(store.get(CARD_ID)?.error).toBeNull();
    expect(embedTitles()).not.toContain("❌ Factory run failed");
    expect(embedTitles()[embedTitles().length - 1]).toBe(
      "✅ PR ready for review"
    );
  });

  it("mirrors tool activity to Discord as a progress embed", async () => {
    queueCard();
    runAgent.mockImplementation(async (opts: AgentRunOptions): Promise<void> => {
      opts.onTool?.("edit");
    });

    await runCard(CARD_ID, bot, deps());

    const index = embedTitles().indexOf("⚙️ In progress");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(fieldOf(index, "Activity")).toBe("tool: edit");
  });
});

describe("agent runtime selection", () => {
  // These are the MVP's single-agent handoff tests: they assert exactly what one
  // container is handed. Phase 2.2 made the graph the default path for a card
  // with no injected agent, so this block opts out of it explicitly rather than
  // quietly testing something else — the graph path has its own tests in
  // test/worker/runner-graph.test.ts.
  beforeEach(() => {
    vi.stubEnv("AGENT_GRAPH", "0");
  });

  it("defaults to the container runtime", () => {
    vi.stubEnv("AGENT_RUNTIME", "container");

    expect(selectAgentRuntime()).toBe(runAgentContainer);
  });

  it("falls back to the container runtime for anything that is not `process`", () => {
    for (const value of ["", "docker", "typo", "Process "]) {
      vi.stubEnv("AGENT_RUNTIME", value);
      expect(selectAgentRuntime(), `AGENT_RUNTIME=${value}`).toBe(runAgentContainer);
    }
  });

  it("uses the in-process runtime only when it is asked for", () => {
    vi.stubEnv("AGENT_RUNTIME", "process");

    expect(selectAgentRuntime()).toBe(runAgentProcess);
  });

  it("runs the container runtime when no agent is injected", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    expect(container.runAgentInContainer).toHaveBeenCalledTimes(1);
  });

  it("hands the container the worktree, the shared .git and the built prompt", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    const opts = container.runAgentInContainer.mock.calls[0]?.[0];
    expect(opts).toMatchObject({
      dir: WT_DIR,
      gitDir: GIT_DIR,
      image: "factory-agent",
    });
    expect(opts?.prompt).toContain(CARD_NAME);
    expect(typeof opts?.onTool).toBe("function");
  });

  it("takes the image name from config", async () => {
    queueCard();
    vi.stubEnv("AGENT_IMAGE", "registry/factory-agent:2.0.0");

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    expect(container.runAgentInContainer.mock.calls[0]?.[0].image).toBe(
      "registry/factory-agent:2.0.0"
    );
  });

  it("maps container tool events onto Discord progress embeds", async () => {
    queueCard();
    container.runAgentInContainer.mockImplementation(async (o) => {
      o.onTool?.("edit");
      return { ok: true, text: "" };
    });

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    const index = embedTitles().indexOf("⚙️ In progress");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(fieldOf(index, "Activity")).toBe("tool: edit");
  });

  it("fails the job when the container reports a failed run", async () => {
    queueCard();
    container.runAgentInContainer.mockResolvedValue({ ok: false, text: "429 rate limited" });

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    expect(store.get(CARD_ID)).toMatchObject({
      status: "failed",
      error: "429 rate limited",
    });
    expect(embedTitles()).toContain("❌ Factory run failed");
    expect(worktree.push).not.toHaveBeenCalled();
  });

  it("fails the job when pi exits 0 having produced nothing", async () => {
    queueCard();
    container.runAgentInContainer.mockResolvedValue({ ok: false, text: "  " });

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    expect(store.get(CARD_ID)?.error).toBe("agent run failed");
  });

  it("removes the worktree when the container fails", async () => {
    queueCard();
    container.runAgentInContainer.mockResolvedValue({ ok: false, text: "docker gone" });

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    expect(worktree.remove).toHaveBeenCalledWith(CARD_ID);
  });

  it("rejects from runAgentContainer so the caller sees a failure", async () => {
    container.runAgentInContainer.mockResolvedValue({ ok: false, text: "boom" });

    await expect(runAgentContainer({ dir: WT_DIR, prompt: "p" })).rejects.toThrow("boom");
  });

  it("resolves from runAgentContainer on a clean run", async () => {
    await expect(
      runAgentContainer({ dir: WT_DIR, gitDir: GIT_DIR, prompt: "p" })
    ).resolves.toBeUndefined();
  });

  it("starts no container when AGENT_RUNTIME=process", async () => {
    queueCard();
    vi.stubEnv("AGENT_RUNTIME", "process");

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    expect(container.runAgentInContainer).not.toHaveBeenCalled();
  });
});
