/**
 * Ephemeral agent container (phase 2.1 — secret isolation).
 *
 * One `docker run` per agent session. Only two host paths cross into the
 * container — the card's worktree (read-write) and the repo's shared `.git`
 * (read-only, needed because a git worktree is nothing but a pointer into it) —
 * and only `buildAgentEnv()` crosses the env boundary. The orchestrator's
 * `.env`, its Trello/GitHub/Discord clients and the `git push` stay on the host.
 *
 * pi writes newline-delimited session events to stdout in `--mode json`; we map
 * those back onto the same tool callback the in-process session used to give.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { AGENT_CONTAINER_HOME, buildAgentEnv, FACTORY_SECRET_ENV_KEYS } from "./env.js";
import type { AgentRunResult, AgentTokenUsage } from "./types.js";

export const AGENT_IMAGE = "factory-agent";
/** Where the worktree lands inside the container. */
export const CONTAINER_WORKDIR = "/work";

export interface ContainerMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

/**
 * The complete set of host paths the agent can see.
 *
 * `gitDir` is mounted read-only *at its own absolute path* so the `gitdir:`
 * link inside `<worktree>/.git` still resolves. Omit it and the agent has no
 * git at all (git reports "not a git repository"); mount the repo working tree
 * instead and the agent can read the host `.env`.
 *
 * `modelsFile` is the third and last thing that may ever come in here: a pi
 * `models.json`, read-only, so an openai-compatible endpoint (a local model
 * server, for tests) can be selected by name. Never the agent-dir directory
 * itself — that is where `auth.json` lives.
 */
export function buildContainerMounts(
  worktreeDir: string,
  gitDir?: string,
  modelsFile?: string,
  settingsFile?: string
): ContainerMount[] {
  const mounts: ContainerMount[] = [
    { source: worktreeDir, target: CONTAINER_WORKDIR },
  ];
  if (gitDir) mounts.push({ source: gitDir, target: gitDir, readOnly: true });
  if (modelsFile) {
    mounts.push({
      source: modelsFile,
      target: AGENT_MODELS_CONTAINER_PATH,
      readOnly: true,
    });
  }
  if (settingsFile) {
    mounts.push({
      source: settingsFile,
      target: AGENT_SETTINGS_CONTAINER_PATH,
      readOnly: true,
    });
  }
  return mounts;
}

/** `["-v", "src:dst[:ro]", ...]` */
export function buildMountArgs(mounts: ContainerMount[]): string[] {
  return mounts.flatMap((m) => [
    "-v",
    `${m.source}:${m.target}${m.readOnly ? ":ro" : ""}`,
  ]);
}

/** `["-e", "K=V", ...]` for every allowlisted variable. */
export function buildEnvArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

/** Where a mounted pi `models.json` has to land for pi to find it. */
export const AGENT_MODELS_CONTAINER_PATH = `${AGENT_CONTAINER_HOME}/.pi/agent/models.json`;
/** Where a mounted pi `settings.json` has to land. */
export const AGENT_SETTINGS_CONTAINER_PATH = `${AGENT_CONTAINER_HOME}/.pi/agent/settings.json`;

/** Keeps generated container names unique within this process. */
let nameCounter = 0;

export interface DockerArgsOptions {
  image?: string;
  /** Env to pass; defaults to `buildAgentEnv(process.env)`. */
  env?: Record<string, string>;
  /** Read-only mount of the repo's shared `.git` (see `buildContainerMounts`). */
  gitDir?: string;
  /** `--user uid:gid`; defaults to the orchestrator's own ids so host files stay its. */
  user?: string;
  /** `--memory`. Empty/undefined means no limit. */
  memory?: string;
  /** `--cpus`. Undefined/0/negative means no limit. */
  cpus?: number;
  /** `--name`, so a timeout can `docker kill` this exact container. */
  containerName?: string;
  /** Host file mounted read-only as the agent's pi `models.json`. */
  modelsFile?: string;
  /** Host file mounted read-only as the agent's pi `settings.json`. */
  settingsFile?: string;
  /** `--add-host=<spec>`; how the container finds the host's spawn IPC. */
  addHosts?: string[];
  /**
   * Merged over the allowlisted env. Cannot name a factory secret (throws) and
   * cannot move `PATH`/`HOME`, which are container constants by design.
   */
  extraEnv?: Record<string, string>;
  /** Replaces pi's own system prompt (`--system-prompt`). */
  systemPrompt?: string;
  /** `--model <pattern>` / `--provider <name>`. */
  model?: string;
  provider?: string;
  /**
   * `--tools` allowlist. Only ever set for a role with NO custom tool: an
   * allowlist also drops extension-registered tools, so using it for the
   * orchestrator would take `spawn_agent` away (verified: the model then reports
   * only the built-ins and refuses the call — plan/2.2-agent-graph.md "Spike 2").
   */
  tools?: string[];
  /** `--exclude-tools` denylist. */
  excludeTools?: string[];
  /**
   * `-e <path>`: an extension already inside the image (the orchestrator's
   * `spawn_agent`). Paths are never derived from card or agent input — an
   * extension is code that runs with the container's permissions, so the only
   * acceptable source is a constant the image was built with.
   */
  piExtensions?: string[];
}

/** Values that mean "do not cap this container". */
const UNLIMITED = new Set(["", "0", "none", "off", "unlimited"]);

/** `--memory <v>` / `--cpus <v>`, omitted when unset or asked to be unlimited. */
export function buildResourceArgs(opts: { memory?: string; cpus?: number }): string[] {
  const args: string[] = [];
  const memory = (opts.memory ?? "").trim().toLowerCase();
  if (memory && !UNLIMITED.has(memory)) args.push("--memory", opts.memory!.trim());
  const cpus = opts.cpus;
  if (typeof cpus === "number" && Number.isFinite(cpus) && cpus > 0) {
    args.push("--cpus", String(cpus));
  }
  return args;
}

/**
 * argv for `docker`. Never through a shell: the prompt is a positional
 * argument, so a prompt containing `; rm -rf /` stays text.
 */
/**
 * pi's own argv, i.e. everything after the image name. Split out so a test can
 * assert the role's tool/prompt policy without the docker half.
 *
 * Order matters only in that `--` must come last: it stops pi parsing, so the
 * prompt can never be read as a flag.
 */
export function buildPiArgs(opts: DockerArgsOptions = {}): string[] {
  const args = ["--mode", "json"];
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
  if (opts.model) args.push("--model", opts.model);
  if (opts.provider) args.push("--provider", opts.provider);
  // Comma-separated, per `pi --help` (0.84.4). An empty array means "no
  // built-ins", which `--tools ''` cannot express — skip the flag and let the
  // caller use `excludeTools` instead of inventing a value pi would misread.
  if (opts.tools?.length) args.push("--tools", opts.tools.join(","));
  if (opts.excludeTools?.length) args.push("--exclude-tools", opts.excludeTools.join(","));
  for (const extension of opts.piExtensions ?? []) {
    args.push("-e", extension);
  }
  args.push(
    // Non-interactive modes cannot show the trust prompt, and the card's repo
    // is untrusted input: skip .pi/ extensions, skills, prompts and themes.
    "--no-approve",
    "--"
  );
  return args;
}

/**
 * The env a container actually gets: the allowlisted provider env, then role
 * additions on top.
 *
 * A caller may add variables (the IPC token, the role's active tool set) but may
 * not name a factory secret and may not move `PATH`/`HOME` — those are container
 * constants, and an `extraEnv` that could overwrite them would be a way back
 * around the allowlist this file exists to enforce.
 */
export function mergeAgentEnv(
  base: Record<string, string>,
  extra?: Record<string, string>
): Record<string, string> {
  if (!extra) return base;
  for (const key of Object.keys(extra)) {
    if ((FACTORY_SECRET_ENV_KEYS as readonly string[]).includes(key)) {
      throw new Error(`refusing to pass ${key} into an agent container`);
    }
    if (key === "PATH" || key === "HOME") {
      throw new Error(`refusing to override ${key} in an agent container`);
    }
  }
  return { ...base, ...extra };
}

export function buildDockerArgs(
  worktreeDir: string,
  prompt: string,
  opts: DockerArgsOptions = {}
): string[] {
  return [
    "run",
    "--rm",
    // Named so a timeout can kill *this* container: `docker run` without `-it`
    // does not forward SIGTERM to the payload, so signalling the client would
    // leave the container running and the semaphore slot held.
    ...(opts.containerName ? ["--name", opts.containerName] : []),
    ...(opts.addHosts ?? []).map((spec) => `--add-host=${spec}`),
    ...buildMountArgs(
      buildContainerMounts(
        worktreeDir,
        opts.gitDir,
        opts.modelsFile,
        opts.settingsFile
      )
    ),
    "-w",
    CONTAINER_WORKDIR,
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--init",
    ...buildResourceArgs(opts),
    ...(opts.user ? ["--user", opts.user] : []),
    ...buildEnvArgs(mergeAgentEnv(opts.env ?? buildAgentEnv(), opts.extraEnv)),
    opts.image ?? AGENT_IMAGE,
    ...buildPiArgs(opts),
    prompt,
  ];
}

/**
 * Descriptions of credential-shaped values in a git config — names only, never
 * the values themselves.
 *
 * Mounting `.git` read-only is what lets the agent run `git log`/`git diff`, but
 * it also hands it `remote.*.url` and `http.*.extraHeader`. A remote that
 * embeds a token (`https://user:ghp_…@github.com/…`) would therefore leak the
 * push credential into the container, so `runAgentInContainer` refuses to start.
 */
export function findGitConfigSecrets(configText: string): string[] {
  const findings: string[] = [];
  let section = "";
  for (const raw of configText.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      section = header[1] ?? "";
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (!value) continue;
    const id = `${section || "?"}.${key}`;
    if (/\.url$/i.test(id)) {
      // scheme://[user[:pass]@]host — userinfo means a baked-in credential
      if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(value)) {
        findings.push(`${id} embeds credentials`);
      }
    } else if (/extraheader|authorization|token|password|apikey|api_key/i.test(key)) {
      findings.push(`${id} looks like a credential`);
    }
  }
  return findings;
}

/** Throw if mounting this `.git` would expose an orchestrator credential. */
export function assertGitDirSafeToMount(gitDir: string): void {
  const file = path.join(gitDir, "config");
  if (!fs.existsSync(file)) return;
  const findings = findGitConfigSecrets(fs.readFileSync(file, "utf8"));
  if (findings.length) {
    throw new Error(
      `refusing to mount ${gitDir}: ${findings.join(", ")}. Move the token out ` +
        `of the remote URL (ssh remote or a git credential helper) — a read-only ` +
        `.git mount is part of the agent's view.`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten an assistant message's text blocks (content may also be a string). */
function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/**
 * Fold pi's `usage` into one run's totals. An all-zero record is treated as "the
 * provider reported nothing" — a run must not look like it was free.
 */
function readUsage(value: unknown): AgentTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const number = (key: string): number =>
    typeof value[key] === "number" && Number.isFinite(value[key]) ? (value[key] as number) : 0;
  const usage = {
    input: number("input"),
    output: number("output"),
    cacheRead: number("cacheRead"),
  };
  return usage.input === 0 && usage.output === 0 && usage.cacheRead === 0
    ? undefined
    : usage;
}

/**
 * Fold JSON-mode session events into a run result.
 *
 * `message_end` is the authoritative final message; `text_delta` is only a live
 * view, used when the stream ended before the final message. Failures come from
 * `stopReason: "error" | "aborted"` — pi JSON mode exits 0 even when the
 * provider request failed, so the exit code alone is not enough.
 */
export function createAgentEventCollector(onTool?: (toolName: string) => void): {
  handle: (record: unknown) => void;
  result: () => AgentRunResult;
} {
  let streamed = "";
  let finalText = "";
  let sawFinalMessage = false;
  let failure: string | undefined;
  let usage: AgentTokenUsage | undefined;

  const fail = (message: unknown, fallback: string): void => {
    failure ??= typeof message === "string" && message ? message : fallback;
  };

  return {
    handle(record: unknown): void {
      if (!isRecord(record)) return;
      switch (record.type) {
        case "tool_execution_start":
          if (typeof record.toolName === "string") onTool?.(record.toolName);
          break;
        case "message_update": {
          const inner = record.assistantMessageEvent;
          if (!isRecord(inner)) break;
          if (inner.type === "text_delta" && typeof inner.delta === "string") {
            streamed += inner.delta;
          }
          if (inner.type === "error" && isRecord(inner.error)) {
            fail(inner.error.errorMessage, `request ${inner.reason ?? "failed"}`);
          }
          break;
        }
        case "message_end": {
          const message = record.message;
          if (!isRecord(message) || message.role !== "assistant") break;
          finalText = assistantText(message.content);
          sawFinalMessage = true;
          // One run is many turns: the request that made the tool call and the
          // request that answered it both bill, so the run's cost is their sum.
          const tokens = readUsage(message.usage);
          if (tokens) {
            usage = usage
              ? {
                  input: usage.input + tokens.input,
                  output: usage.output + tokens.output,
                  cacheRead: usage.cacheRead + tokens.cacheRead,
                }
              : tokens;
          }
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            fail(message.errorMessage, `request ${message.stopReason}`);
          }
          break;
        }
      }
    },
    result(): AgentRunResult {
      const body = sawFinalMessage ? finalText : streamed;
      const spend = usage ? { usage } : {};
      if (!failure) return { ok: true, text: body, ...spend };
      return { ok: false, text: body ? `${failure}\n---\n${body}` : failure, ...spend };
    },
  };
}

/**
 * LF-only JSONL framing. `node:readline` is deliberately not used: it also
 * splits on U+2028/U+2029, which are valid inside JSON strings (pi docs,
 * "Framing and process I/O").
 */
function createJsonlReader(onLine: (line: string) => void): {
  push: (chunk: Buffer) => void;
  end: () => void;
} {
  let pending: Buffer = Buffer.alloc(0);
  const emit = (raw: Buffer): void => {
    const line = raw.toString("utf8").replace(/\r$/, "");
    if (line.trim()) onLine(line);
  };
  return {
    push(chunk: Buffer): void {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let index = pending.indexOf(0x0a);
      while (index !== -1) {
        emit(pending.subarray(0, index));
        pending = pending.subarray(index + 1);
        index = pending.indexOf(0x0a);
      }
    },
    end(): void {
      if (!pending.length) return;
      emit(pending);
      pending = Buffer.alloc(0);
    },
  };
}

export interface RunAgentInContainerOptions extends DockerArgsOptions {
  /** Worktree directory on the host; mounted at /work. */
  dir: string;
  prompt: string;
  onTool?: (toolName: string) => void;
  /**
   * Wall clock for this run. On expiry the container is killed by name and the
   * promise resolves `ok: false` — it never rejects, matching every other
   * failure mode here, so a slow child cannot take the card down with it.
   */
  timeoutMs?: number;
}

/** Docker's own rule: must start alphanumeric, then `_.-` are allowed. */
export function sanitizeContainerName(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 120);
  return (cleaned || "factory-agent").toLowerCase();
}

/** `docker kill <name>`, best effort — the run is already being failed. */
export function killContainer(name: string): void {
  try {
    const killer = spawn("docker", ["kill", name], { stdio: "ignore" });
    killer.on("error", () => {});
  } catch {
    // Nothing to do: the caller has already resolved the run as failed.
  }
}

/** `uid:gid` of the orchestrator process, or undefined where there is none. */
function currentUserId(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return `${process.getuid()}:${process.getgid()}`;
}

/**
 * Run one agent session in a fresh container and stream its events.
 *
 * Resolves when `docker` exits; it never rejects on a bad run. A provider error
 * surfaces as `ok: false` (pi exits 0 for those), as does a container that
 * could not start or was killed — with the exit status appended to `text`.
 * A `.git` that would leak a credential throws synchronously before spawning.
 */
export function runAgentInContainer(
  opts: RunAgentInContainerOptions
): Promise<AgentRunResult> {
  const gitDir = opts.gitDir;
  if (gitDir) assertGitDirSafeToMount(gitDir);

  const containerName = sanitizeContainerName(
    opts.containerName ?? `factory-agent-${process.pid}-${++nameCounter}`
  );
  const args = buildDockerArgs(opts.dir, opts.prompt, {
    ...opts,
    user: opts.user ?? currentUserId(),
    // Resource limits are resolved here rather than at each call site: phase 2.2
    // starts N containers per card, and a child that forgot to pass them would
    // be the one that takes the host down. Explicit opts always win.
    memory: opts.memory ?? config.factory.agentMemory,
    cpus: opts.cpus ?? config.factory.agentCpus,
    containerName,
    modelsFile: opts.modelsFile ?? config.factory.agentModelsFile,
    settingsFile: opts.settingsFile ?? config.factory.agentSettingsFile,
  });
  const collector = createAgentEventCollector(opts.onTool);

  return new Promise<AgentRunResult>((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let spawnError: string | undefined;
    let settled = false;

    const finish = (extra?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const result = collector.result();
      resolve({
        ok: result.ok && !extra,
        text: extra ? `${result.text}\n${extra}`.trim() : result.text,
        // Keep the spend even when the run failed: a timeout that burned 40k
        // input tokens before dying is not a free run.
        ...(result.usage ? { usage: result.usage } : {}),
      });
    };

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        // Fail the run first, then stop the container: the semaphore slot in
        // src/agents/spawn.ts is released when this promise resolves, so waiting
        // for the kill to be confirmed would hold it for an unknown duration.
        finish(`agent run timed out after ${opts.timeoutMs}ms`);
        killContainer(containerName);
        child.kill("SIGKILL");
      }, opts.timeoutMs);
      // A pending timeout must not keep the process alive on its own.
      timer.unref?.();
    }

    const reader = createJsonlReader((line) => {
      try {
        collector.handle(JSON.parse(line));
      } catch {
        // Something else in the container wrote to stdout. Surface it for the
        // log; a malformed record must not fail an otherwise good run.
        process.stderr.write(`[agent] non-JSON stdout: ${line}\n`);
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => reader.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[agent] ${chunk}`));
    child.on("error", (err) => {
      spawnError = err.message;
      // 'close' is not guaranteed after a failed spawn: resolve here rather than
      // leave the worker slot parked on a container that never existed.
      finish(`failed to start the agent container: ${spawnError}`);
    });
    child.on("close", (code, signal) => {
      reader.end();
      if (spawnError) return;
      if (signal) finish(`agent container terminated by signal ${signal}`);
      else if (code !== 0) finish(`agent container exited with code ${code}`);
      else finish();
    });
  });
}
