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
import { buildAgentEnv } from "./env.js";
import type { AgentRunResult } from "./types.js";

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
 */
export function buildContainerMounts(worktreeDir: string, gitDir?: string): ContainerMount[] {
  const mounts: ContainerMount[] = [
    { source: worktreeDir, target: CONTAINER_WORKDIR },
  ];
  if (gitDir) mounts.push({ source: gitDir, target: gitDir, readOnly: true });
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

export interface DockerArgsOptions {
  image?: string;
  /** Env to pass; defaults to `buildAgentEnv(process.env)`. */
  env?: Record<string, string>;
  /** Read-only mount of the repo's shared `.git` (see `buildContainerMounts`). */
  gitDir?: string;
  /** `--user uid:gid`; defaults to the orchestrator's own ids so host files stay its. */
  user?: string;
}

/**
 * argv for `docker`. Never through a shell: the prompt is a positional
 * argument, so a prompt containing `; rm -rf /` stays text.
 */
export function buildDockerArgs(
  worktreeDir: string,
  prompt: string,
  opts: DockerArgsOptions = {}
): string[] {
  return [
    "run",
    "--rm",
    ...buildMountArgs(buildContainerMounts(worktreeDir, opts.gitDir)),
    "-w",
    CONTAINER_WORKDIR,
    "--cap-drop=ALL",
    "--security-opt",
    "no-new-privileges",
    "--init",
    ...(opts.user ? ["--user", opts.user] : []),
    ...buildEnvArgs(opts.env ?? buildAgentEnv()),
    opts.image ?? AGENT_IMAGE,
    "--mode",
    "json",
    // Non-interactive modes cannot show the trust prompt, and the card's repo
    // is untrusted input: skip .pi/ extensions, skills, prompts and themes.
    "--no-approve",
    // stop pi's option parsing so a prompt can never look like a flag
    "--",
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
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            fail(message.errorMessage, `request ${message.stopReason}`);
          }
          break;
        }
      }
    },
    result(): AgentRunResult {
      const body = sawFinalMessage ? finalText : streamed;
      if (!failure) return { ok: true, text: body };
      return { ok: false, text: body ? `${failure}\n---\n${body}` : failure };
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

  const args = buildDockerArgs(opts.dir, opts.prompt, {
    ...opts,
    user: opts.user ?? currentUserId(),
  });
  const collector = createAgentEventCollector(opts.onTool);

  return new Promise<AgentRunResult>((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let spawnError: string | undefined;
    let settled = false;

    const finish = (extra?: string): void => {
      if (settled) return;
      settled = true;
      const result = collector.result();
      resolve({
        ok: result.ok && !extra,
        text: extra ? `${result.text}\n${extra}`.trim() : result.text,
      });
    };

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
