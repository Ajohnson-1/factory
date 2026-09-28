/**
 * Host-side child runner (phase 2.2 step 2).
 *
 * The orchestrator asks for a child; everything that follows happens here, on
 * the host, because a child container has a read-only `.git`, no docker socket
 * and no credentials. Creating the worktree, starting the container, committing
 * the agent's work, merging it back and cleaning up are all host operations, and
 * the only thing the container ever sees is the summary string handed back.
 *
 * Three guardrails from the plan, all enforced here rather than trusted to the
 * model: a semaphore for `MAX_PARALLEL_AGENTS`, a wall clock per child that
 * *kills the container* (`AGENT_TIMEOUT_MS`), and a per-card run budget
 * (`MAX_AGENT_RUNS`) so a looping orchestrator cannot spend unbounded tokens.
 */
import fs from "node:fs";
import { config } from "../config.js";
import type { AgentRunResult } from "../agent/types.js";
import { runAgentInContainer } from "../agent/container.js";
import { getRole, roleCatalogue, spawnableRoleIds, type AgentRole } from "./roles.js";
import {
  changedFiles,
  childBranchFor,
  commitWork,
  createChildWorktree,
  diffStat,
  headCommit,
  mergeChildIntoBase,
  removeChildWorktree,
  type MergeResult,
  type Worktree,
} from "../worker/worktree.js";
import type { AgentRunStatus, Store } from "../state/store.js";

/** Baked into the agent image; see deploy/docker/factory-agent.Dockerfile. */
export const SPAWN_AGENT_EXTENSION = "/opt/factory/extensions/spawn-agent.ts";

/** How a container finds the host. These names must match the extension exactly. */
export const IPC_ENV = {
  host: "FACTORY_IPC_HOST",
  port: "FACTORY_IPC_PORT",
  token: "FACTORY_IPC_TOKEN",
  activeTools: "FACTORY_ACTIVE_TOOLS",
  spawnable: "FACTORY_SPAWNABLE_ROLES",
  spawnTimeout: "FACTORY_SPAWN_TIMEOUT_MS",
} as const;

export const DEFAULT_IPC_HOST = "host.docker.internal";

/** Keep a child's prose from crowding out the diff in an orchestrator's context. */
export const MAX_SUMMARY_CHARS = 4000;
/** Cap on a spec/research file handed to a child, in chars. */
export const MAX_CONTEXT_FILE_CHARS = 6000;

export type SpawnStatus = "ok" | "failed" | "timeout" | "rejected";

/** `rejected` has no agent_runs status of its own — it never started a container. */
export function toRunStatus(status: SpawnStatus): AgentRunStatus {
  return status === "ok" ? "ok" : status === "timeout" ? "timeout" : "failed";
}

export interface SpawnRequest {
  role: string;
  task: string;
  context?: string;
}

export interface SpawnOutcome {
  status: SpawnStatus;
  summary: string;
  runId?: string;
  branch?: string;
  diff?: string;
}

/** The container boundary, as a seam: no test of this file may exec docker. */
export interface ChildRunOptions {
  dir: string;
  gitDir?: string;
  prompt: string;
  systemPrompt?: string;
  model?: string;
  excludeTools?: string[];
  extraEnv?: Record<string, string>;
  containerName?: string;
  timeoutMs?: number;
  onTool?: (toolName: string) => void;
}

export type RunChild = (options: ChildRunOptions) => Promise<AgentRunResult>;

/** The git operations a spawn needs, as a seam so tests can watch the order. */
export interface SpawnWorktreeOps {
  createChild(cardId: string, runId: string): Worktree;
  removeChild(cardId: string, runId: string): void;
  head(dir: string): string;
  changedFiles(dir: string, baseRef: string): string[];
  diffStat(dir: string, baseRef: string): string;
  merge(baseDir: string, branch: string, message: string): MergeResult;
  commit(dir: string, message: string): boolean;
}

const defaultWorktreeOps: SpawnWorktreeOps = {
  createChild: createChildWorktree,
  removeChild: removeChildWorktree,
  head: headCommit,
  changedFiles,
  diffStat,
  merge: mergeChildIntoBase,
  commit: commitWork,
};

export type AgentEvent =
  | { kind: "started"; role: string; runId: string; task: string }
  | { kind: "tool"; role: string; runId: string; toolName: string }
  | { kind: "done"; role: string; runId: string; status: SpawnStatus };

export interface SpawnLimits {
  maxParallel: number;
  timeoutMs: number;
  maxRuns: number;
}

export interface SpawnDeps {
  store: Store;
  cardId: string;
  /** The card's base worktree: the orchestrator and shared roles work in it. */
  baseDir: string;
  /** The shared `.git` every child container needs mounted read-only. */
  gitDir: string;
  runChild: RunChild;
  worktree?: SpawnWorktreeOps;
  limits?: Partial<SpawnLimits>;
  onEvent?: (event: AgentEvent) => void;
  /** Overridable so a test can hand a child a spec file without touching disk. */
  readContextFile?: (dir: string, name: string) => string | undefined;
}

export interface AgentSpawner {
  spawn(request: SpawnRequest): Promise<SpawnOutcome>;
  /** Requests this spawner has accepted past validation. */
  started(): number;
  /** Containers running right now. */
  inFlight(): number;
}

function limitsOf(partial: Partial<SpawnLimits> | undefined): SpawnLimits {
  return {
    maxParallel: partial?.maxParallel ?? config.factory.maxParallelAgents,
    timeoutMs: partial?.timeoutMs ?? config.factory.agentTimeoutMs,
    maxRuns: partial?.maxRuns ?? config.factory.maxAgentRuns,
  };
}

/**
 * Counting semaphore. Excess spawns queue rather than fail, which is what makes
 * "spawn six coders" behave: the orchestrator gets six results, not two results
 * and four errors, and the host still never runs more than `maxParallel`.
 */
export function createSemaphore(limit: number): {
  acquire: () => Promise<() => void>;
  inFlight: () => number;
  waiting: () => number;
} {
  let running = 0;
  const queue: Array<() => void> = [];

  return {
    async acquire(): Promise<() => void> {
      if (running < limit) {
        running += 1;
      } else {
        // Parked: the releasing holder hands its slot over directly, so `running`
        // is never briefly dropped below the real count and a third waiter cannot
        // steal it.
        await new Promise<void>((resolve) => {
          queue.push(resolve);
        });
      }
      let done = false;
      return (): void => {
        if (done) return; // idempotent: a finally plus an early return is one release
        done = true;
        const next = queue.shift();
        if (next) next();
        else running = Math.max(0, running - 1);
      };
    },
    inFlight: () => running,
    waiting: () => queue.length,
  };
}

/**
 * Serialises merges into the base worktree. Children may run in parallel, but
 * two concurrent `git merge`s into one worktree interleave index/HEAD changes
 * and can leave a half-merged tree, so landing is one at a time.
 */
export function createSerialLock(): {
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
} {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn, fn);
      // Keep the chain alive even when a holder rejected, or one bad merge would
      // deadlock every later one.
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
}

function truncate(text: string, max: number): string {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n… [truncated ${trimmed.length - max} chars]`;
}

function readBaseFile(dir: string, name: string): string | undefined {
  const file = `${dir}/${name}`;
  try {
    if (!fs.existsSync(file)) return undefined;
    return truncate(fs.readFileSync(file, "utf8"), MAX_CONTEXT_FILE_CHARS);
  } catch {
    // A spec file the agent half-wrote is not worth failing a run over.
    return undefined;
  }
}

/**
 * What a child is told. The role's charter arrives as its system prompt; this is
 * the job, plus whatever the orchestrator passed and whatever the spec and
 * research files hold — the two files the plan makes this repo's shared memory.
 */
export function buildChildPrompt(
  role: AgentRole,
  request: SpawnRequest,
  baseDir: string,
  readContextFile: (dir: string, name: string) => string | undefined = readBaseFile
): string {
  const parts: string[] = [
    `Your role: ${role.id}.`,
    ``,
    `Task (scoped to you alone — do not do more):`,
    request.task.trim(),
  ];
  if (request.context?.trim()) {
    parts.push(``, `Context from the orchestrator:`, request.context.trim());
  }
  for (const name of ["factory-spec.md", "factory-research.md"]) {
    const text = readContextFile(baseDir, name);
    if (text) parts.push(``, `From ${name} in the repository root:`, text);
  }
  parts.push(
    ``,
    `Finish by leaving the change in the working tree. The host commits it and`,
    `merges your branch; you have no write access to git metadata.`
  );
  return parts.join("\n");
}

/** True when a run's failure text is really a wall-clock expiry. */
export function looksLikeTimeout(text: string): boolean {
  return /timed out|terminated by signal|killed/i.test(text ?? "");
}

export function createAgentSpawner(deps: SpawnDeps): AgentSpawner {
  const limits = limitsOf(deps.limits);
  const worktree = deps.worktree ?? defaultWorktreeOps;
  const readContextFile = deps.readContextFile ?? readBaseFile;
  const semaphore = createSemaphore(limits.maxParallel);
  const merges = createSerialLock();
  let sequence = 0;
  let started = 0;

  const rejected = (message: string): SpawnOutcome => ({ status: "rejected", summary: message });

  async function runChild(role: AgentRole, request: SpawnRequest): Promise<SpawnOutcome> {
    const runId = `c${++sequence}`;
    const detached = role.worktree === "detached";
    const release = await semaphore.acquire();
    let child: Worktree | undefined;
    let status: SpawnStatus = "failed";
    let summary = "";

    try {
      const baseHead = worktree.head(deps.baseDir);

      if (detached) {
        try {
          child = worktree.createChild(deps.cardId, runId);
        } catch (err) {
          status = "failed";
          summary = `could not create a worktree for ${role.id}: ${
            err instanceof Error ? err.message : String(err)
          }`;
          deps.store.addRun({ runId, cardId: deps.cardId, role: role.id });
          deps.store.setRunDone(runId, "failed", summary);
          return { status, summary };
        }
      }

      const dir = child ? child.dir : deps.baseDir;
      const branch = detached ? childBranchFor(deps.cardId, runId) : undefined;
      deps.store.addRun({ runId, cardId: deps.cardId, role: role.id, branch, worktree: dir });
      started += 1;
      deps.onEvent?.({ kind: "started", role: role.id, runId, task: request.task });

      const result = await deps.runChild({
        dir,
        gitDir: deps.gitDir,
        prompt: buildChildPrompt(role, request, deps.baseDir, readContextFile),
        systemPrompt: role.systemPrompt,
        model: config.factory.agentModel || undefined,
        excludeTools: role.excludeTools,
        containerName: `factory-${deps.cardId}-${runId}`,
        timeoutMs: limits.timeoutMs,
        onTool: (toolName) => {
          deps.onEvent?.({ kind: "tool", role: role.id, runId, toolName });
        },
      });

      const landed = await land({ role, runId, dir, baseHead, result, detached });
      status = landed.status;
      summary = landed.summary;
      deps.store.setRunDone(runId, toRunStatus(status), summary);
      return { status, summary, runId, branch, diff: landed.diff };
    } catch (err) {
      // A throw here is the container boundary itself failing (docker missing,
      // a refused .git mount). Report it as a failed child, never as a rejection
      // of the orchestrator's plan.
      status = "failed";
      summary = `${role.id} ${runId} could not run: ${
        err instanceof Error ? err.message : String(err)
      }`;
      deps.store.setRunDone(runId, "failed", summary);
      return { status, summary, runId };
    } finally {
      release();
      deps.onEvent?.({ kind: "done", role: role.id, runId, status });
      if (child) worktree.removeChild(deps.cardId, runId);
    }
  }

  /** Commit + merge (or a shared-worktree commit), and the summary of both. */
  async function land(args: {
    role: AgentRole;
    runId: string;
    dir: string;
    baseHead: string;
    result: AgentRunResult;
    detached: boolean;
  }): Promise<{ status: SpawnStatus; summary: string; diff: string }> {
    const { role, runId, dir, baseHead, result, detached } = args;
    const workDir = detached ? dir : deps.baseDir;
    const changed = safe(() => worktree.changedFiles(workDir, baseHead), [] as string[]);
    const diff = safe(() => worktree.diffStat(workDir, baseHead), "");
    let status: SpawnStatus = result.ok ? "ok" : looksLikeTimeout(result.text) ? "timeout" : "failed";
    let landing: string;

    if (status !== "ok") {
      landing = "run did not finish cleanly; nothing was committed or merged";
    } else if (changed.length === 0) {
      // "It said it finished and wrote nothing" is a failure the orchestrator has
      // to be able to see, or an empty child silently becomes a shipped no-op.
      status = "failed";
      landing = "reported success but changed no files";
    } else if (detached && role.mergeBack) {
      landing = await merges.withLock(async () => {
        if (!safe(() => worktree.commit(dir, `factory: ${role.id} ${runId}`), false)) {
          status = "failed";
          return "nothing could be committed from the child worktree";
        }
        const merged = safe(
          () =>
            worktree.merge(
              deps.baseDir,
              childBranchFor(deps.cardId, runId),
              `factory: merge ${role.id} ${runId}`
            ),
          undefined
        );
        if (!merged) {
          status = "failed";
          return "the merge command failed";
        }
        if (merged.ok) {
          return `merged into the card branch as ${merged.commit.slice(0, 8)}`;
        }
        // The plan keeps conflict resolution inside the LLM loop: base is already
        // clean (mergeChildIntoBase aborts), so say what clashed and let the
        // orchestrator re-spawn the task with that in its context.
        status = "failed";
        return (
          `MERGE CONFLICT with the card branch — nothing from this run landed. ` +
          `Conflicting files: ${merged.files.join(", ") || "(unknown)"}. ` +
          `Re-spawn this task with the conflict above as context.`
        );
      });
    } else if (!detached && role.writesWork) {
      // Shared-worktree roles are single writers by design: the host commits
      // straight onto the card branch, there is nothing to merge.
      landing = safe(() => worktree.commit(deps.baseDir, `factory: ${role.id} ${runId}`), false)
        ? "committed to the card branch"
        : "nothing could be committed";
      if (landing !== "committed to the card branch") status = "failed";
    } else {
      landing = "report only — this role's work is not merged";
    }

    const summary = truncate(
      [
        `role=${role.id} run=${runId} status=${status}`,
        `landing: ${landing}`,
        `changed: ${changed.length ? changed.join(", ") : "(nothing)"}`,
        diff ? `diff --stat:\n${diff}` : `diff --stat: (nothing)`,
        `agent report:\n${result.text || "(no text)"}`,
      ].join("\n"),
      MAX_SUMMARY_CHARS
    );
    return { status, summary, diff };
  }

  return {
    async spawn(request: SpawnRequest): Promise<SpawnOutcome> {
      const role = getRole(request.role);
      if (!role) {
        // A clean answer, not a stack: the orchestrator recovers by picking a
        // real role, and the catalogue in the reply tells it which exist.
        return rejected(
          `unknown role "${String(request.role)}". Spawnable roles:\n${roleCatalogue()}`
        );
      }
      if (!spawnableRoleIds().includes(role.id)) {
        return rejected(
          `role "${role.id}" cannot be spawned — it is driven by the factory, not by you`
        );
      }
      if (!request.task?.trim()) {
        return rejected("task must be a non-empty description of one scoped job");
      }
      if (deps.store.countRuns(deps.cardId) >= limits.maxRuns) {
        return rejected(
          `run budget exhausted for this card (${limits.maxRuns}). Summarise what has ` +
            `landed and stop; do not spawn again.`
        );
      }
      return runChild(role, request);
    },
    started: () => started,
    inFlight: () => semaphore.inFlight(),
  };
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Default container runner, exported so the graph can hand it in. */
export const runChildInContainer: RunChild = (options) => runAgentInContainer(options);
