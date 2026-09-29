import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildOrchestratorEnv,
  buildOrchestratorPrompt,
  orchestratorTimeoutMs,
  runCardGraph,
  MAX_CHILD_REPORT_CHARS,
  type GraphDeps,
} from "../../src/agents/graph.js";
import { IPC_ENV, SPAWN_AGENT_EXTENSION, type SpawnOutcome } from "../../src/agents/spawn.js";
import { ROLES, SPAWN_AGENT_TOOL, spawnableRoleIds } from "../../src/agents/roles.js";
import { config } from "../../src/config.js";
import { createStore, type Store } from "../../src/state/store.js";
import {
  commonGitDir,
  createWorktree,
  removeWorktree,
  worktreeDir,
} from "../../src/worker/worktree.js";
import { makeGitRepo, type GitRepoFixture } from "../helpers/git.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

/**
 * The graph runner is the piece that turns "read-only agent in a container" into
 * "agent that can actually build something", so these tests check the wiring that
 * matters: what the orchestrator container is handed, and whether a request on
 * the declared port really arrives at the spawner. No docker anywhere — the
 * container is a fake, the socket is real.
 */

const CARD_ID = "card-1";
let fixture: GitRepoFixture;
let store: Store;
let dir: string;
let baseDir: string;
let gitDir: string;

beforeEach(() => {
  fixture = makeGitRepo();
  dir = makeTempDir();
  store = createStore(path.join(dir, "test.db"));
  const created = createWorktree(CARD_ID, fixture.repoPath);
  baseDir = created.dir;
  gitDir = commonGitDir(baseDir);
  vi.stubEnv("MAX_PARALLEL_AGENTS", "3");
  vi.stubEnv("AGENT_TIMEOUT_MS", "60000");
  vi.stubEnv("MAX_AGENT_RUNS", "7");
  vi.stubEnv("FACTORY_IPC_SLACK_MS", "15000");
});

afterEach(() => {
  store.close();
  removeWorktree(CARD_ID, fixture.repoPath);
  fixture.cleanup();
  removeTempDir(dir);
});

function deps(overrides: Partial<GraphDeps> = {}): GraphDeps {
  return {
    store,
    cardId: CARD_ID,
    baseDir,
    gitDir,
    card: { name: "Add greet and farewell", desc: "two small exported helpers" },
    ...overrides,
  } as GraphDeps;
}

type ContainerOptions = Parameters<NonNullable<GraphDeps["runContainer"]>>[0];

describe("buildOrchestratorPrompt", () => {
  it("puts the card in front of the planner", () => {
    const prompt = buildOrchestratorPrompt({ name: "Add greet", desc: "export it", maxRuns: 5 });

    expect(prompt).toContain("Card: Add greet");
    expect(prompt).toContain("export it");
  });

  it("states the run budget, because the host enforces a number the model cannot see", () => {
    const prompt = buildOrchestratorPrompt({ name: "x", desc: "", maxRuns: 12 });

    expect(prompt).toContain("12 child runs");
    expect(prompt).toContain(SPAWN_AGENT_TOOL);
  });

  it("says nothing about details a card does not have", () => {
    const prompt = buildOrchestratorPrompt({ name: "x", desc: "", maxRuns: 4 });

    // An empty description must not turn into the word "undefined" in front of
    // the model, which is how a planner starts inventing requirements.
    expect(prompt).toContain("Card: x");
    expect(prompt).not.toContain("undefined");
  });
});

describe("orchestratorTimeoutMs", () => {
  it("covers every child the budget allows plus one turn of its own", () => {
    expect(orchestratorTimeoutMs(60_000, 3)).toBe(240_000);
  });

  it("never shorter than a single child", () => {
    expect(orchestratorTimeoutMs(60_000, 0)).toBe(60_000);
  });

  /**
   * open-issues #2. The product of the defaults is 20 min × 13 = 260 min, and
   * `queue.ts` gates on a *global* `store.isRunning()`, so one planner hung on a
   * provider stall kept every other card waiting for four hours and change.
   */
  it("caps the derived wall clock at the ceiling it is given", () => {
    expect(orchestratorTimeoutMs(20 * 60_000, 12, 45 * 60_000)).toBe(45 * 60_000);
  });

  it("holds the cap against an absurd budget", () => {
    expect(orchestratorTimeoutMs(60_000, 1000, 45 * 60_000)).toBe(45 * 60_000);
  });

  it("leaves a budget that is already under the cap alone", () => {
    expect(orchestratorTimeoutMs(60_000, 1, 45 * 60_000)).toBe(120_000);
    expect(orchestratorTimeoutMs(60_000, 0, 45 * 60_000)).toBe(60_000);
  });

  /**
   * The cap floors at one child timeout, and that is not politeness: a planner
   * killed while a legitimate child is still running loses work it was allowed
   * to ask for, which is a worse failure than the one being capped.
   */
  it("will not cap below a single child", () => {
    expect(orchestratorTimeoutMs(20 * 60_000, 12, 1_000)).toBe(20 * 60_000);
    expect(orchestratorTimeoutMs(20 * 60_000, 0, 1_000)).toBe(20 * 60_000);
  });

  it("defaults the cap to nothing when called without one", () => {
    expect(orchestratorTimeoutMs(60_000, 3)).toBe(60_000 * 4);
  });
});

describe("buildOrchestratorEnv", () => {
  it("describes the channel the in-container extension will dial", () => {
    const env = buildOrchestratorEnv({
      token: "tok-abc",
      port: 4321,
      childTimeoutMs: 60_000,
      activeTools: ["read", SPAWN_AGENT_TOOL],
    });

    expect(env[IPC_ENV.host]).toBe("host.docker.internal");
    expect(env[IPC_ENV.port]).toBe("4321");
    expect(env[IPC_ENV.token]).toBe("tok-abc");
    expect(env[IPC_ENV.activeTools]).toBe(`read,${SPAWN_AGENT_TOOL}`);
    // The extension must outlast the host's own per-child timeout, or a slow
    // child looks like a broken tool call instead of a reported timeout.
    expect(env[IPC_ENV.spawnTimeout]).toBe(String(60_000 + config.factory.ipcSlackMs));
  });

  it("offers the orchestrator exactly the roles it may spawn", () => {
    const env = buildOrchestratorEnv({ token: "t", port: 1, childTimeoutMs: 1 });

    expect(env[IPC_ENV.spawnable]).toBe(spawnableRoleIds().join(","));
    expect(env[IPC_ENV.spawnable]).not.toContain("orchestrator");
    expect(env[IPC_ENV.spawnable]).not.toContain("reviewer");
  });

  it("defaults the active tool set to the orchestrator role's own", () => {
    const env = buildOrchestratorEnv({ token: "t", port: 1, childTimeoutMs: 1 });

    expect(env[IPC_ENV.activeTools]).toBe(ROLES.orchestrator.activeTools?.join(","));
  });
});

describe("runCardGraph", () => {
  it("runs the orchestrator as a read-only container holding the spawn extension", async () => {
    let handed: ContainerOptions | undefined;
    const runContainer = vi.fn(async (options: ContainerOptions) => {
      handed = options;
      // Something has to land, or "ok" is not the outcome under test here.
      advanceBase(baseDir);
      return { ok: true, text: "planned and landed" };
    });

    const result = await runCardGraph(deps({ runContainer, spawnChild: fakeSpawn() }));

    expect(runContainer).toHaveBeenCalledTimes(1);
    expect(handed?.dir).toBe(baseDir);
    expect(handed?.gitDir).toBe(gitDir);
    expect(handed?.systemPrompt).toBe(ROLES.orchestrator.systemPrompt);
    expect(handed?.piExtensions).toEqual([SPAWN_AGENT_EXTENSION]);
    expect(handed?.containerName).toBe(`factory-${CARD_ID}-orch`);
    // Read-only means no write built-ins, and no `--tools` allowlist either: that
    // flag would take spawn_agent away with it (plan "Spike 2").
    expect(handed?.excludeTools).toBeUndefined();
    expect(handed?.tools).toBeUndefined();
    expect(handed?.timeoutMs).toBe(60_000 * 8);
    expect(result.status).toBe("ok");
  });

  // AGENT_TIMEOUT_MS 60000 × (MAX_AGENT_RUNS 7 + 1) = 480000, which the ceiling
  // above it cuts down to. Without `ORCHESTRATOR_TIMEOUT_MS` the default cap
  // (45 min) leaves this graph's 480000 alone.
  it("hands the orchestrator the capped wall clock, not the derived one", async () => {
    vi.stubEnv("ORCHESTRATOR_TIMEOUT_MS", "120000");
    let handed: ContainerOptions | undefined;
    const runContainer = vi.fn(async (options: ContainerOptions) => {
      handed = options;
      advanceBase(baseDir);
      return { ok: true, text: "planned" };
    });

    await runCardGraph(deps({ runContainer, spawnChild: fakeSpawn() }));

    expect(handed?.timeoutMs).toBe(120_000);
  });

  /**
   * open-issues #1, the plumbing half: the attempt only helps if it reaches the
   * spawner that enforces the budget. This runs the *real* spawner (no
   * `spawnChild`) so the child's row is written by the code that ships.
   */
  it("budgets the real spawner against the attempt the graph was handed", async () => {
    vi.stubEnv("REPO_PATH", fixture.repoPath);
    vi.stubEnv("MAX_AGENT_RUNS", "2");
    // A previous attempt spent its whole budget and landed two children.
    for (const runId of ["spent-1", "spent-2"]) {
      store.addRun({ runId, cardId: CARD_ID, role: "coder", attempt: 7 });
      store.setRunDone(CARD_ID, runId, "ok", "landed in attempt 7");
    }

    const runContainer = vi.fn(async (options: ContainerOptions) => {
      const port = Number(options.extraEnv?.[IPC_ENV.port]);
      if (!port) {
        // The child container: write a file and leave it uncommitted, which is
        // all a real child can do.
        fs.writeFileSync(path.join(options.dir, "greet.js"), "export const greet = 1;\n");
        return { ok: true, text: "wrote greet.js" };
      }
      await dial(port, options.extraEnv?.[IPC_ENV.token], {
        v: 1,
        t: "spawn",
        role: "coder",
        task: "add greet()",
      });
      return { ok: true, text: "planned" };
    });

    const result = await runCardGraph(deps({ runContainer, attempt: 8 }));

    expect(result.status).toBe("ok");
    const children = store.runsFor(CARD_ID, 8);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ role: "coder", status: "ok", attempt: 8 });
    // The exhausted attempt stays exhausted; it just no longer owns the card.
    expect(store.countRuns(CARD_ID, 7)).toBe(2);
    expect(store.countRuns(CARD_ID, 8)).toBe(1);
  });

  /**
   * open-issues #4, the half that is not documentation. On a Linux host the
   * default bind (127.0.0.1) means no container can ever reach this channel, and
   * the operator sees an orchestrator whose every spawn fails for a reason that
   * is not in any log they would think to read. Naming the variable is the fix.
   */
  it("names FACTORY_IPC_BIND when the spawn channel cannot be opened", async () => {
    // TEST-NET-3: not an address this host has, so listen cannot succeed.
    vi.stubEnv("FACTORY_IPC_BIND", "203.0.113.99");
    const runContainer = vi.fn(async () => ({ ok: true, text: "must never start" }));

    const result = await runCardGraph(deps({ runContainer, spawnChild: fakeSpawn() }));

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("could not open the spawn channel");
    expect(result.summary).toContain("FACTORY_IPC_BIND");
    expect(result.summary).toContain("203.0.113.99");
    expect(runContainer).not.toHaveBeenCalled();
  });

  it("defaults a graph started without an attempt to the card's first one", async () => {
    vi.stubEnv("REPO_PATH", fixture.repoPath);
    const runContainer = vi.fn(async (options: ContainerOptions) => {
      const port = Number(options.extraEnv?.[IPC_ENV.port]);
      if (!port) {
        fs.writeFileSync(path.join(options.dir, "greet.js"), "export const greet = 1;\n");
        return { ok: true, text: "wrote" };
      }
      await dial(port, options.extraEnv?.[IPC_ENV.token], {
        v: 1,
        t: "spawn",
        role: "coder",
        task: "add greet()",
      });
      return { ok: true, text: "planned" };
    });

    await runCardGraph(deps({ runContainer }));

    expect(store.runsFor(CARD_ID, 1).map((r) => r.role)).toEqual(["coder"]);
  });

  it("reports the orchestrator's own token spend on the graph result", async () => {
    const runContainer = vi.fn(async (options: ContainerOptions) => {
      advanceBase(baseDir);
      return {
        ok: true,
        text: "planned",
        usage: { input: 4_000, output: 500, cacheRead: 20_000 },
      };
    });

    const result = await runCardGraph(deps({ runContainer, spawnChild: fakeSpawn() }));

    expect(result.usage).toEqual({ input: 4_000, output: 500, cacheRead: 20_000 });
  });

  it("hands the orchestrator a model only when one is configured", async () => {
    const runContainer = vi.fn(async () => ({ ok: true, text: "done" }));

    await runCardGraph(deps({ runContainer, spawnChild: fakeSpawn() }));
    expect(firstOptions(runContainer).model).toBeUndefined();

    vi.stubEnv("ORCHESTRATOR_MODEL", "vmlx/local-model");
    runContainer.mockClear();
    await runCardGraph(deps({ runContainer, spawnChild: fakeSpawn() }));
    expect(firstOptions(runContainer).model).toBe("vmlx/local-model");
  });

  // The load-bearing one: the container is told a port and a token over env, and
  // anything dialling that port must land in the spawner and get an answer back.
  it("serves a spawn request that arrives on the declared port while the run is live", async () => {
    const seen: Array<{ role: string; task: string }> = [];
    const spawnChild = vi.fn(
      async (request: { role: string; task: string }): Promise<SpawnOutcome> => {
        seen.push({ role: request.role, task: request.task });
        return { status: "ok", summary: "role=coder status=ok\nlanding: merged" };
      }
    );
    let replyFromHost = "";

    const runContainer = vi.fn(async (options: ContainerOptions) => {
      const env = options.extraEnv ?? {};
      const port = Number(env[IPC_ENV.port]);
      expect(port).toBeGreaterThan(0);
      replyFromHost = await dial(port, env[IPC_ENV.token], {
        v: 1,
        t: "spawn",
        role: "coder",
        task: "add greet()",
      });
      advanceBase(baseDir);
      return { ok: true, text: "planned" };
    });

    const result = await runCardGraph(deps({ runContainer, spawnChild }));

    expect(seen).toEqual([{ role: "coder", task: "add greet()" }]);
    const parsed = JSON.parse(replyFromHost) as {
      ok: boolean;
      status: string;
      summary: string;
    };
    expect(parsed).toMatchObject({ ok: true, status: "ok" });
    expect(parsed.summary).toContain("merged");
    expect(result.status).toBe("ok");
    expect(result.runs).toBe(1);
  });

  it("reports a rejected child without breaking the channel", async () => {
    const runContainer = vi.fn(async (options: ContainerOptions) => {
      const env = options.extraEnv ?? {};
      lastReply = await dial(Number(env[IPC_ENV.port]), env[IPC_ENV.token], {
        v: 1,
        t: "spawn",
        role: "goblin",
        task: "whatever",
      });
      return { ok: true, text: "x" };
    });
    const spawnChild = vi.fn(
      async (): Promise<SpawnOutcome> => ({ status: "rejected", summary: "unknown role" })
    );

    await runCardGraph(deps({ runContainer, spawnChild }));

    const parsed = JSON.parse(lastReply) as { ok: boolean; status: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("rejected");
  });

  it("refuses a request carrying the wrong token", async () => {
    const spawnChild = vi.fn(
      async (): Promise<SpawnOutcome> => ({ status: "ok", summary: "should not run" })
    );
    let reply = "";

    await runCardGraph(
      deps({
        spawnChild,
        runContainer: vi.fn(async (options: ContainerOptions) => {
          const env = options.extraEnv ?? {};
          reply = await dial(Number(env[IPC_ENV.port]), "stolen-token", {
            v: 1,
            t: "spawn",
            role: "coder",
            task: "x",
          });
          return { ok: true, text: "x" };
        }),
      })
    );

    expect(JSON.parse(reply).ok).toBe(false);
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("revokes the channel the moment the run ends", async () => {
    let port = 0;
    await runCardGraph(
      deps({
        spawnChild: fakeSpawn(),
        runContainer: vi.fn(async (options: ContainerOptions) => {
          port = Number((options.extraEnv ?? {})[IPC_ENV.port]);
          advanceBase(baseDir);
          return { ok: true, text: "done" };
        }),
      })
    );

    // A token that outlives its run would let any other container keep spawning.
    await expect(dialRejected(port)).resolves.toBe(true);
  });

  it("fails the card when the orchestrator changed nothing on the base branch", async () => {
    const result = await runCardGraph(
      deps({
        spawnChild: fakeSpawn(),
        runContainer: vi.fn(async () => ({ ok: true, text: "I decided to do nothing" })),
      })
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("without landing anything");
    expect(result.baseHeadBefore).toBe(result.baseHeadAfter);
  });

  it("surfaces a container failure as a failed graph", async () => {
    const result = await runCardGraph(
      deps({
        spawnChild: fakeSpawn(),
        runContainer: vi.fn(async () => ({ ok: false, text: "No API key found" })),
      })
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("No API key found");
  });

  it("calls a wall-clock expiry a timeout so the worker can tell the two apart", async () => {
    const result = await runCardGraph(
      deps({
        spawnChild: fakeSpawn(),
        runContainer: vi.fn(async () => ({ ok: false, text: "agent run timed out after 1ms" })),
      })
    );

    expect(result.status).toBe("timeout");
  });

  it("reports a base worktree that vanished as a failed run rather than throwing", async () => {
    fs.rmSync(baseDir, { recursive: true, force: true });

    const result = await runCardGraph(
      deps({ spawnChild: fakeSpawn(), runContainer: vi.fn(async () => ({ ok: true, text: "x" })) })
    );

    expect(result.status).toBe("failed");
  });

  it("truncates a child's report before it goes back to the planner", async () => {
    const huge = "x".repeat(MAX_CHILD_REPORT_CHARS + 5000);
    let forwarded = "";
    const runContainer = vi.fn(async (options: ContainerOptions) => {
      const env = options.extraEnv ?? {};
      forwarded = await dial(Number(env[IPC_ENV.port]), env[IPC_ENV.token], {
        v: 1,
        t: "spawn",
        role: "coder",
        task: "x",
      });
      return { ok: true, text: "x" };
    });

    await runCardGraph(
      deps({
        runContainer,
        spawnChild: vi.fn(async (): Promise<SpawnOutcome> => ({ status: "ok", summary: huge })),
      })
    );

    const summary = (JSON.parse(forwarded) as { summary: string }).summary;
    expect(summary.length).toBeLessThan(huge.length);
    expect(summary).toContain("[truncated]");
  });

  it("uses the configured limits for the fan-out it hands the spawner", async () => {
    // MAX_PARALLEL_AGENTS/AGENT_TIMEOUT_MS/MAX_AGENT_RUNS are read by the spawner
    // the graph builds; with spawnChild injected we at least pin the budget the
    // orchestrator is *told*, which has to match what is enforced.
    const prompt: string[] = [];
    await runCardGraph(
      deps({
        spawnChild: fakeSpawn(),
        runContainer: vi.fn(async (options: ContainerOptions) => {
          prompt.push(options.prompt);
          return { ok: true, text: "x" };
        }),
      })
    );

    expect(prompt[0]).toContain(`${config.factory.maxAgentRuns} child runs`);
    expect(prompt[0]).toContain(fixture.root ? "Card:" : "Card:");
  });
});

let lastReply = "";

/** What the container fake was handed on its first call. */
function firstOptions(runContainer: ReturnType<typeof vi.fn>): ContainerOptions {
  return (runContainer.mock.calls as unknown as Array<[ContainerOptions]>)[0]![0];
}

function fakeSpawn(): GraphDeps["spawnChild"] {
  return vi.fn(
    async (): Promise<SpawnOutcome> => ({ status: "ok", summary: "role=coder status=ok" })
  );
}

/** Commit in the base worktree the way a merged child would. */
function advanceBase(dir: string): void {
  fs.writeFileSync(path.join(dir, "landed.js"), "// landed\n");
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("add", "-A");
  git("-c", "user.email=t@t.local", "-c", "user.name=t", "commit", "-m", "factory: land");
}

/** One JSONL request, one reply line — the shape the extension speaks. */
function dial(
  port: number,
  token: string | undefined,
  payload: Record<string, unknown>
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = "";
    socket.setTimeout(5_000, () => reject(new Error("the graph's channel never answered")));
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        resolve(buffer.slice(0, newline));
        socket.end();
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ ...payload, token })}\n`);
    });
  });
}

function dialRejected(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.on("error", () => resolve(true));
    socket.on("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(1_500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
