/**
 * One card's agent graph (phase 2.2 steps 2–4, host side).
 *
 * The orchestrator runs in a container exactly like every other role — that is
 * the Option A decision in plan/2.2-agent-graph.md. It is read-only and holds no
 * secrets; the only thing it can do beyond reading is call `spawn_agent`, which
 * the in-container extension turns into a request on this channel. Everything
 * with authority (starting children, committing, merging, pushing) stays here.
 *
 * The IPC server's lifetime is the orchestrator's lifetime: the token exists for
 * one run, on one port, and is revoked the moment that run ends.
 */
import { config } from "../config.js";
import { runAgentInContainer } from "../agent/container.js";
import { ROLES, SPAWN_AGENT_TOOL, spawnableRoleIds, type RoleId } from "./roles.js";
import { createIpcServer, createIpcToken, type IpcServer } from "./ipc.js";
import {
  createAgentSpawner,
  DEFAULT_IPC_HOST,
  IPC_ENV,
  SPAWN_AGENT_EXTENSION,
  type AgentEvent,
  type SpawnOutcome,
  type SpawnStatus,
} from "./spawn.js";
import { headCommit, worktreeDir } from "../worker/worktree.js";
import type { AgentTokenUsage } from "../agent/types.js";
import type { Store } from "../state/store.js";

/** A child's report, capped before it goes back into the orchestrator's context. */
export const MAX_CHILD_REPORT_CHARS = 6000;

export interface GraphResult {
  status: SpawnStatus;
  summary: string;
  /** Children this graph started, whether or not they landed. */
  runs: number;
  /**
   * The planner's own spend. Children are recorded as `agent_runs` rows; the
   * orchestrator is not, because a row for it would count against the very
   * budget it exists to be held to. It is reported here instead so the card's
   * total cost is at least visible in the log.
   */
  usage?: AgentTokenUsage;
  /** Base commit when the graph started / when it ended. */
  baseHeadBefore: string;
  baseHeadAfter: string;
}

export interface GraphDeps {
  store: Store;
  cardId: string;
  /** The card's base worktree, already created by the runner. */
  baseDir: string;
  gitDir: string;
  card: { name: string; desc: string };
  /**
   * Attempt of the card this graph is, from `jobs.generation`. Children are
   * budgeted against it, so a re-triggered card gets a fresh `MAX_AGENT_RUNS`.
   */
  attempt?: number;
  /** Streams child activity outward (Discord). Must never throw. */
  onEvent?: (event: AgentEvent) => void;
  /** Overridable so a test can drive a whole graph without docker. */
  runContainer?: typeof runAgentInContainer;
  spawnChild?: (request: {
    role: string;
    task: string;
    context?: string;
  }) => Promise<SpawnOutcome>;
}

/**
 * The orchestrator's opening message: the card, and the rule that it plans by
 * spawning rather than by doing. Its charter is the system prompt; this is the
 * specific job, so the same role can drive any card.
 */
export function buildOrchestratorPrompt(card: {
  name: string;
  desc: string;
  maxRuns: number;
}): string {
  return [
    `Plan and drive this card from our Trello board. You do not write code.`,
    ``,
    `Card: ${card.name}`,
    card.desc ? `Details:\n${card.desc}` : ``,
    ``,
    `You have ${SPAWN_AGENT_TOOL} and nothing else that changes state.`,
    `Your run budget for this card is ${card.maxRuns} child runs total.`,
    ``,
    `Suggested shape, adjusted to the card:`,
    `1. read/grep the repository enough to scope the work honestly.`,
    `2. optionally spawn spec-writer and/or researcher (one at a time — they`,
    `   share this checkout and both write a single file at the repository root).`,
    `3. fan the implementation out to coder children: independent tasks in ONE`,
    `   message so they run in parallel; tasks that touch the same files in`,
    `   separate messages so they serialise.`,
    `4. after the code lands, spawn verifier to run the repo's tests/build.`,
    `5. if a child comes back with a merge conflict, re-spawn that task with the`,
    `   conflicting files in its context instead of retrying it unchanged.`,
    `6. finish with a short summary of what landed and what did not.`,
  ].join("\n");
}

/**
 * How long the orchestrator may run. Each child may itself consume the full
 * per-child timeout, so the planner gets the budget of every run it is allowed
 * to ask for plus one turn of its own — otherwise a card with four slow children
 * would be killed by a timeout meant for one.
 *
 * `capMs` is the honest half of that arithmetic. At the defaults the product is
 * 20 min × 13 = 260 min, and the worker gate is global, so one planner hung on a
 * provider stall holds every other card for four hours and change. The cap is
 * still floored at one child timeout: an orchestrator that cannot outlive its own
 * slowest child would be killed while doing legitimate work, which is a worse bug
 * than the one being capped.
 */
export function orchestratorTimeoutMs(
  childTimeoutMs: number,
  maxRuns: number,
  capMs = Number.POSITIVE_INFINITY
): number {
  const full = childTimeoutMs * (maxRuns + 1);
  return Math.max(childTimeoutMs, Math.min(full, capMs));
}

/** Env that turns the baked-in extension into a client of *this* run's channel. */
export function buildOrchestratorEnv(args: {
  token: string;
  port: number;
  childTimeoutMs: number;
  ipcHost?: string;
  activeTools?: string[];
}): Record<string, string> {
  return {
    [IPC_ENV.host]: args.ipcHost ?? DEFAULT_IPC_HOST,
    [IPC_ENV.port]: String(args.port),
    [IPC_ENV.token]: args.token,
    // The extension waits longer than the host does, so a slow child surfaces as
    // a host-reported timeout rather than a truncated tool call.
    [IPC_ENV.spawnTimeout]: String(args.childTimeoutMs + config.factory.ipcSlackMs),
    [IPC_ENV.activeTools]: (args.activeTools ?? ROLES.orchestrator.activeTools ?? []).join(","),
    [IPC_ENV.spawnable]: spawnableRoleIds().join(","),
  };
}

export async function runCardGraph(deps: GraphDeps): Promise<GraphResult> {
  const runContainer = deps.runContainer ?? runAgentInContainer;
  const limits = {
    maxParallel: config.factory.maxParallelAgents,
    timeoutMs: config.factory.agentTimeoutMs,
    maxRuns: config.factory.maxAgentRuns,
  };
  const attempt = deps.attempt ?? 1;
  const baseHeadBefore = safeHead(deps.baseDir);
  if (!baseHeadBefore) {
    // The runner creates the base worktree before the graph starts, so this only
    // happens when it vanished underneath us. Report it as a failed card rather
    // than letting a raw `git rev-parse` error escape past the IPC setup.
    return {
      status: "failed",
      summary: `the card's base worktree is missing at ${deps.baseDir}`,
      runs: 0,
      baseHeadBefore: "",
      baseHeadAfter: "",
    };
  }

  const spawner = deps.spawnChild
    ? null
    : createAgentSpawner({
        store: deps.store,
        cardId: deps.cardId,
        attempt,
        baseDir: deps.baseDir,
        gitDir: deps.gitDir,
        runChild: (options) => runContainer(options),
        limits,
        onEvent: deps.onEvent,
      });

  // Counted here rather than read off the spawner so the number is still right
  // when a test supplies its own child runner.
  let childRuns = 0;
  const spawnOne = async (request: {
    role: string;
    task: string;
    context?: string;
  }): Promise<SpawnOutcome> => {
    childRuns += 1;
    return spawner ? spawner.spawn(request) : (deps.spawnChild as NonNullable<typeof deps.spawnChild>)(request);
  };

  let server: IpcServer | undefined;
  // Minted here, handed to exactly one container through extraEnv, and revoked
  // when that run ends: the channel is only usable for the life of this graph.
  const token = createIpcToken();
  try {
    server = await createIpcServer({
      token,
      host: config.factory.ipcBind,
      port: config.factory.ipcPort,
      onSpawn: async (request) => {
        const outcome = await spawnOne(request);
        return { status: outcome.status, summary: truncate(outcome.summary, MAX_CHILD_REPORT_CHARS) };
      },
    });
  } catch (err) {
    // A listener that cannot be opened is a bind-address problem, and the bind
    // is the one knob on a Linux host that decides whether any container can
    // reach this channel at all — so say which variable to look at rather than
    // leaving a raw EADDRNOTAVAIL in the card's summary.
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      summary:
        `could not open the spawn channel on ${config.factory.ipcBind}: ${message}. ` +
        `Check FACTORY_IPC_BIND (127.0.0.1 is unreachable from a container on a ` +
        `Linux bridge).`,
      runs: 0,
      baseHeadBefore,
      baseHeadAfter: baseHeadBefore,
    };
  }
  try {
    const result = await runContainer({
      dir: deps.baseDir,
      gitDir: deps.gitDir,
      prompt: buildOrchestratorPrompt({
        name: deps.card.name,
        desc: deps.card.desc,
        maxRuns: limits.maxRuns,
      }),
      // --system-prompt replaces pi's own prompt, so the role charter has to be
      // a complete instruction set on its own.
      systemPrompt: ROLES.orchestrator.systemPrompt,
      model: config.factory.orchestratorModel || undefined,
      piExtensions: [SPAWN_AGENT_EXTENSION],
      extraEnv: buildOrchestratorEnv({
        token,
        port: server.port,
        childTimeoutMs: limits.timeoutMs,
        ipcHost: DEFAULT_IPC_HOST,
        activeTools: ROLES.orchestrator.activeTools,
      }),
      containerName: `factory-${deps.cardId}-orch`,
      timeoutMs: orchestratorTimeoutMs(
        limits.timeoutMs,
        limits.maxRuns,
        config.factory.orchestratorTimeoutMs
      ),
      onTool: (toolName) => {
        deps.onEvent?.({ kind: "tool", role: "orchestrator", runId: "orch", toolName });
      },
    });

    const baseHeadAfter = safeHead(deps.baseDir);
    const advanced = baseHeadAfter !== baseHeadBefore;
    const status: SpawnStatus = !result.ok
      ? /timed out/i.test(result.text)
        ? "timeout"
        : "failed"
      : advanced
        ? "ok"
        : "failed";

    return {
      status,
      summary: !result.ok
        ? `orchestrator failed: ${result.text}`
        : advanced
          ? result.text
          : `the orchestrator finished without landing anything on ${deps.cardId}`,
      runs: childRuns,
      ...(result.usage ? { usage: result.usage } : {}),
      baseHeadBefore,
      baseHeadAfter,
    };
  } finally {
    await server.close();
  }
}

/**
 * The base worktree lives next to the repo, keyed off the card id — the runner
 * owns creating and removing it, the graph only ever works inside it.
 */
export function baseWorktreeFor(cardId: string): string {
  return worktreeDir(cardId);
}

function safeHead(dir: string): string {
  try {
    return headCommit(dir);
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  const value = (text ?? "").trim();
  return value.length <= max ? value : `${value.slice(0, max)}\n… [truncated]`;
}

/** Role id re-exported for callers that type an event without importing roles.js. */
export type { RoleId };
export type { AgentRunResult } from "../agent/types.js";
