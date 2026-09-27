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

// The pi SDK must never be loaded for real: fake it at the module boundary so
// importing runner.ts costs nothing and no model is ever contacted.
const sdk = vi.hoisted(() => {
  const session = {
    prompt: vi.fn(async (_prompt: string): Promise<void> => {}),
    subscribe: vi.fn(),
    dispose: vi.fn(),
  };
  return {
    session,
    createRuntime: vi.fn(async (): Promise<{ id: string }> => ({ id: "runtime" })),
    inMemory: vi.fn((_dir: string) => ({ id: "smgr" })),
    createSession: vi.fn(
      async (_opts: { cwd: string; modelRuntime: unknown; sessionManager: unknown }) => ({
        session,
      })
    ),
  };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: sdk.createRuntime },
  SessionManager: { inMemory: sdk.inMemory },
  createAgentSession: sdk.createSession,
}));

import {
  buildAgentPrompt,
  runCard,
  type AgentRunOptions,
  type RunCardDeps,
  type RunAgent,
} from "../../src/worker/runner.js";
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
  };

  prompts = [];
  runAgent = vi.fn(async (opts: AgentRunOptions): Promise<void> => {
    prompts.push(opts.prompt);
  });

  // restoreMocks resets spies between tests; re-arm the hoisted SDK fakes too.
  sdk.session.prompt.mockReset().mockResolvedValue(undefined);
  sdk.session.subscribe.mockReset();
  sdk.session.dispose.mockReset();
  sdk.createRuntime.mockReset().mockResolvedValue({ id: "runtime" });
  sdk.inMemory.mockReset().mockReturnValue({ id: "smgr" });
  sdk.createSession.mockReset().mockResolvedValue({ session: sdk.session });
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

  it("requires the factory commit message prefix", () => {
    expect(buildAgentPrompt({ name: CARD_NAME, desc: "" })).toContain('"factory: "');
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
    expect(prompts[0]).toContain(CARD_NAME);
    expect(prompts[0]).toContain('"factory: "');
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

describe("runCard default agent (pi SDK seam)", () => {
  it("prompts a pi session built in the worktree", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    expect(sdk.createSession).toHaveBeenCalledTimes(1);
    expect(sdk.createSession.mock.calls[0]?.[0]).toMatchObject({ cwd: WT_DIR });
  });

  it("sends the built prompt to the session", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    expect(sdk.session.prompt).toHaveBeenCalledTimes(1);
    expect(sdk.session.prompt.mock.calls[0]?.[0]).toContain(CARD_NAME);
  });

  it("uses an in-memory session manager", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    expect(sdk.inMemory).toHaveBeenCalledWith(WT_DIR);
  });

  it("forwards session tool events to Discord", async () => {
    queueCard();
    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));
    send.mockClear();

    // the handler the runner registered on the session
    const handler = sdk.session.subscribe.mock.calls[0]?.[0];
    expect(typeof handler).toBe("function");
    handler({ type: "tool_execution_start", toolName: "bash" });

    const index = embedTitles().indexOf("⚙️ In progress");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(fieldOf(index, "Activity")).toBe("tool: bash");
  });

  it("ignores session events that are not tool starts", async () => {
    queueCard();
    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));
    send.mockClear();

    const handler = sdk.session.subscribe.mock.calls[0]?.[0];
    handler({ type: "message_update" });
    handler({ type: "tool_execution_end", toolName: "bash" });

    expect(send).not.toHaveBeenCalled();
  });

  it("disposes the session after the run", async () => {
    queueCard();

    await runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    expect(sdk.session.dispose).toHaveBeenCalled();
  });

  // Last in the file: needs a pristine copy of the module so the memo starts
  // empty. `modelRuntime` is module-level in runner.ts, so the count can only be
  // asserted from a fresh import (vi.resetModules keeps the pi mock registered).
  it("reuses one model runtime across two runs", async () => {
    vi.resetModules();
    const fresh = await import("../../src/worker/runner.js");
    queueCard();

    await fresh.runCard(CARD_ID, bot, deps({ runAgent: undefined }));
    await fresh.runCard(CARD_ID, bot, deps({ runAgent: undefined }));

    expect(sdk.createRuntime).toHaveBeenCalledTimes(1);
    expect(sdk.createSession).toHaveBeenCalledTimes(2);
  });
});
