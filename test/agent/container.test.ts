import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  AGENT_IMAGE,
  CONTAINER_WORKDIR,
  assertGitDirSafeToMount,
  buildContainerMounts,
  buildDockerArgs,
  buildEnvArgs,
  buildMountArgs,
  createAgentEventCollector,
  findGitConfigSecrets,
  runAgentInContainer,
} from "../../src/agent/container.js";
import { FACTORY_SECRET_ENV_KEYS } from "../../src/agent/env.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";

// Nothing here may exec a real docker binary — the unit suite stays hermetic.
// The real container is exercised by test/integration/container.test.ts.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);

const WT = "/home/pi/repos/wt-card-1";
const GIT_DIR = "/home/pi/repos/origin/.git";
const PROMPT = "add a greet function";

/** Secret values that must never show up anywhere in the docker argv. */
const SECRET_VALUES: Record<string, string> = Object.fromEntries(
  FACTORY_SECRET_ENV_KEYS.map((name, i) => [name, `super-secret-${i}-${name}`])
);

beforeEach(() => {
  for (const [name, value] of Object.entries(SECRET_VALUES)) vi.stubEnv(name, value);
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-provider-key");
  spawnMock.mockReset();
  // the container's stderr passthrough must not spray over the test report
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
}

interface DriveClose {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

/**
 * Push a canned byte stream through the spawner, then settle the child.
 *
 * `stdout` is written as raw strings so a test can cut a record in half, or
 * hand it something that is not JSON at all.
 */
async function drive(
  lines: string[],
  opts: Parameters<typeof runAgentInContainer>[0],
  close: DriveClose = {},
  stderrLines: string[] = []
) {
  const child = new FakeChild();
  spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const tools: string[] = [];
  const promise = runAgentInContainer({ onTool: (t) => tools.push(t), ...opts });

  for (const line of lines) child.stdout.write(line);
  for (const line of stderrLines) child.stderr.write(line);
  child.stdout.end();
  child.stderr.end();
  // 'end' fires after every 'data' listener, so the reader has seen all of it
  await Promise.all([
    new Promise<void>((resolve) => child.stdout.once("end", () => resolve())),
    new Promise<void>((resolve) => child.stderr.once("end", () => resolve())),
  ]);
  if (close.error) child.emit("error", close.error);
  child.emit("close", close.code === undefined ? 0 : close.code, close.signal ?? null);

  return { result: await promise, tools };
}

const json = (record: unknown): string => `${JSON.stringify(record)}\n`;

/** An assistant `message_end` — the authoritative final message in JSON mode. */
function assistantEnd(text: string, stopReason = "stop"): unknown {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason },
  };
}

function delta(text: string): unknown {
  return {
    type: "message_update",
    usage: {},
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  };
}

describe("buildContainerMounts", () => {
  it("mounts the worktree read-write at /work", () => {
    expect(buildContainerMounts(WT)).toEqual([
      { source: WT, target: CONTAINER_WORKDIR },
    ]);
  });

  it("adds the shared .git read-only, at its own host path", () => {
    expect(buildContainerMounts(WT, GIT_DIR)).toHaveLength(2);
    expect(buildContainerMounts(WT, GIT_DIR)[1]).toEqual({
      source: GIT_DIR,
      target: GIT_DIR,
      readOnly: true,
    });
  });

  it("never mounts the repo working tree or a home directory", () => {
    const sources = buildContainerMounts(WT, GIT_DIR).map((m) => m.source);

    // the .git *directory* is required; its parent — which holds the host .env — is not
    expect(sources).not.toContain(path.dirname(GIT_DIR));
    expect(sources).not.toContain("/home/pi");
    expect(sources).not.toContain("/home/pi/.pi");
  });
});

describe("buildMountArgs / buildEnvArgs", () => {
  it("renders -v src:dst with :ro on read-only mounts only", () => {
    expect(buildMountArgs(buildContainerMounts(WT, GIT_DIR))).toEqual([
      "-v",
      `${WT}:/work`,
      "-v",
      `${GIT_DIR}:${GIT_DIR}:ro`,
    ]);
  });

  it("renders -e KEY=VALUE pairs", () => {
    expect(buildEnvArgs({})).toEqual([]);
    expect(buildEnvArgs({ PATH: "/bin", ANTHROPIC_API_KEY: "k" })).toEqual([
      "-e",
      "PATH=/bin",
      "-e",
      "ANTHROPIC_API_KEY=k",
    ]);
  });
});

describe("buildDockerArgs", () => {
  function args(): string[] {
    return buildDockerArgs(WT, PROMPT, { gitDir: GIT_DIR, user: "1000:1000" });
  }

  it("runs a throwaway, unprivileged container", () => {
    const a = args();

    expect(a[0]).toBe("run");
    for (const flag of ["--rm", "--cap-drop=ALL", "--init", "--user"]) {
      expect(a, flag).toContain(flag);
    }
    expect(a[a.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(a[a.indexOf("--user") + 1]).toBe("1000:1000");
  });

  it("has exactly two mounts: the worktree and the read-only .git", () => {
    const a = args();
    const mounts = a.reduce<string[]>(
      (acc, arg, i) => (arg === "-v" ? [...acc, a[i + 1] ?? ""] : acc),
      []
    );

    expect(mounts).toEqual([`${WT}:/work`, `${GIT_DIR}:${GIT_DIR}:ro`]);
  });

  it("works inside /work", () => {
    expect(args()[args().indexOf("-w") + 1]).toBe(CONTAINER_WORKDIR);
  });

  it("passes only allowlisted env into the container", () => {
    const a = buildDockerArgs(WT, PROMPT, { env: { PATH: "/bin", HOME: "/home/agent" } });
    const names = a.reduce<string[]>(
      (acc, arg, i) => (arg === "-e" ? [...acc, (a[i + 1] ?? "").split("=")[0] ?? ""] : acc),
      []
    );

    expect(names.sort()).toEqual(["HOME", "PATH"]);
  });

  // The strongest single assertion here: with every factory secret set in the
  // orchestrator env, neither its name nor its value appears anywhere in argv.
  // No `env` option is passed — this is the default path production takes.
  it("leaks no factory secret anywhere in argv", () => {
    const flat = buildDockerArgs(WT, PROMPT, { gitDir: GIT_DIR }).join("\n");

    for (const [name, value] of Object.entries(SECRET_VALUES)) {
      expect(flat, name).not.toContain(name);
      expect(flat, name).not.toContain(value);
    }
    expect(flat).toContain("sk-ant-provider-key");
    expect(flat).toContain("--cap-drop=ALL");
  });

  it("keeps the prompt positional, never a shell string", () => {
    const a = args();
    const imageAt = a.indexOf(AGENT_IMAGE);

    expect(imageAt).toBeGreaterThan(-1);
    expect(a.slice(imageAt)).toEqual([
      AGENT_IMAGE,
      "--mode",
      "json",
      "--no-approve",
      "--",
      PROMPT,
    ]);
    expect(a).not.toContain("-c");
    expect(a).not.toContain("--entrypoint");
    expect(a).not.toContain("-it");
  });

  it("stops pi option parsing so a flag-shaped prompt stays a prompt", () => {
    const a = buildDockerArgs(WT, "--printenv");

    expect(a[a.indexOf("--") + 1]).toBe("--printenv");
  });

  it("uses the configured image, defaulting to factory-agent", () => {
    expect(buildDockerArgs(WT, PROMPT)).toContain(AGENT_IMAGE);
    expect(buildDockerArgs(WT, PROMPT, { image: "registry/factory-agent:1.2.3" })).toContain(
      "registry/factory-agent:1.2.3"
    );
  });

  it("omits --user when the caller has no uid (and does not invent one)", () => {
    expect(buildDockerArgs(WT, PROMPT)).not.toContain("--user");
  });

  it("spawns the docker binary with piped stdio, no shell", async () => {
    await drive([], { dir: WT, prompt: PROMPT, gitDir: GIT_DIR });

    const call = spawnMock.mock.calls[0];
    expect(call?.[0]).toBe("docker");
    expect(call?.[2]).toMatchObject({ stdio: ["ignore", "pipe", "pipe"] });
    expect(call?.[1]).toEqual(
      buildDockerArgs(WT, PROMPT, { gitDir: GIT_DIR, user: hostUser() })
    );
  });
});

/** uid:gid the spawner will default to on this machine, or undefined. */
function hostUser(): string | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    return undefined;
  }
  return `${process.getuid()}:${process.getgid()}`;
}

describe("createAgentEventCollector", () => {
  it("reports the tool calls it sees, in order", () => {
    const tools: string[] = [];
    const c = createAgentEventCollector((t) => tools.push(t));

    c.handle({ type: "agent_start" });
    c.handle({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} });
    c.handle({ type: "tool_execution_end", toolCallId: "1", toolName: "bash", isError: false });
    c.handle({ type: "tool_execution_start", toolName: "edit" });

    expect(tools).toEqual(["bash", "edit"]);
  });

  it("prefers the authoritative message_end over streamed deltas", () => {
    const c = createAgentEventCollector();

    c.handle(delta("partial "));
    c.handle(assistantEnd("final answer"));

    expect(c.result()).toEqual({ ok: true, text: "final answer" });
  });

  it("falls back to streamed deltas when the stream never completed", () => {
    const c = createAgentEventCollector();

    c.handle(delta("cut off"));

    expect(c.result()).toEqual({ ok: true, text: "cut off" });
  });

  it("ignores user and tool results when picking the final text", () => {
    const c = createAgentEventCollector();

    c.handle({ type: "message_end", message: { role: "user", content: PROMPT } });
    c.handle({
      type: "message_end",
      message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
    });
    c.handle(assistantEnd("the real answer"));

    expect(c.result().text).toBe("the real answer");
  });

  it("joins the text blocks of one assistant message, skipping thinking and tool calls", () => {
    const c = createAgentEventCollector();

    c.handle({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "a" },
          { type: "toolCall", id: "1", name: "bash", arguments: {} },
          { type: "text", text: "b" },
        ],
        stopReason: "toolUse",
      },
    });

    expect(c.result().text).toBe("ab");
  });

  it("fails on an error stop reason even though pi exits 0", () => {
    const c = createAgentEventCollector();

    c.handle({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "429 rate limited",
      },
    });

    expect(c.result()).toEqual({ ok: false, text: "429 rate limited" });
  });

  it("names the stop reason when an aborted request carries no message", () => {
    const c = createAgentEventCollector();

    c.handle(assistantEnd("", "aborted"));

    expect(c.result()).toEqual({ ok: false, text: "request aborted" });
  });

  it("keeps the partial output after the failure reason", () => {
    const c = createAgentEventCollector();

    c.handle({
      type: "message_update",
      usage: {},
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { errorMessage: "boom" },
      },
    });
    c.handle(assistantEnd("half an answer", "error"));

    const { ok, text } = c.result();
    expect(ok).toBe(false);
    expect(text).toContain("boom");
    expect(text).toContain("half an answer");
  });

  it("reports the first failure only, so a retry does not overwrite the cause", () => {
    const c = createAgentEventCollector();

    c.handle({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "first" },
    });
    c.handle({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "aborted", errorMessage: "second" },
    });

    expect(c.result().text).toBe("first");
  });

  it("tolerates malformed records", () => {
    const c = createAgentEventCollector();

    expect(() => {
      c.handle(null);
      c.handle("nope");
      c.handle(42);
      c.handle([]);
      c.handle({ type: "message_end" });
      c.handle({ type: "message_end", message: { role: "assistant" } });
      c.handle({ type: "message_update", assistantMessageEvent: null });
    }).not.toThrow();
    expect(c.result()).toEqual({ ok: true, text: "" });
  });
});

describe("runAgentInContainer (fake docker)", () => {
  it("assembles a successful run and forwards tool events", async () => {
    const { result, tools } = await drive(
      [
        json({ type: "session", version: 3, id: "u", timestamp: "t", cwd: "/work" }),
        json({ type: "agent_start" }),
        json({ type: "turn_start" }),
        json({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} }),
        json({ type: "tool_execution_end", toolCallId: "1", toolName: "bash", isError: false }),
        json(delta("done ")),
        json(assistantEnd("done — added greet()")),
        json({ type: "turn_end", message: {}, toolResults: [] }),
        json({ type: "agent_end", messages: [], willRetry: false }),
        json({ type: "agent_settled" }),
      ],
      { dir: WT, prompt: PROMPT, gitDir: GIT_DIR }
    );

    expect(tools).toEqual(["bash"]);
    expect(result).toEqual({ ok: true, text: "done — added greet()" });
  });

  it("reassembles a record split across two read chunks", async () => {
    const line = json(assistantEnd("split across chunks"));
    const half = Math.floor(line.length / 2);

    const { result } = await drive([line.slice(0, half), line.slice(half)], {
      dir: WT,
      prompt: PROMPT,
    });

    expect(result).toEqual({ ok: true, text: "split across chunks" });
  });

  it("reads a final record that has no trailing newline", async () => {
    const { result } = await drive([JSON.stringify(assistantEnd("no trailing lf"))], {
      dir: WT,
      prompt: PROMPT,
    });

    expect(result).toEqual({ ok: true, text: "no trailing lf" });
  });

  // node:readline also splits on U+2028/U+2029, which are legal inside a JSON
  // string — pi's docs call this out, hence the LF-only reader.
  it("does not split a record on U+2028 inside a string", async () => {
    const text = "before \u2028 after \u2029 still one record";

    const { result } = await drive([json(assistantEnd(text))], {
      dir: WT,
      prompt: PROMPT,
    });

    expect(result).toEqual({ ok: true, text });
  });

  it("logs a non-JSON stdout line and keeps going", async () => {
    const { result } = await drive(["not json at all\n", json(assistantEnd("still fine"))], {
      dir: WT,
      prompt: PROMPT,
    });

    expect(result).toEqual({ ok: true, text: "still fine" });
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("non-JSON stdout")
    );
  });

  it("forwards the container's stderr to the log", async () => {
    await drive([json(assistantEnd("ok"))], { dir: WT, prompt: PROMPT }, {}, [
      "pi: warning: something\n",
    ]);

    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("[agent] pi: warning")
    );
  });

  it("fails when docker exits non-zero, keeping the output it produced", async () => {
    const { result } = await drive(
      [json(assistantEnd("some output"))],
      { dir: WT, prompt: PROMPT },
      { code: 125 }
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("some output");
    expect(result.text).toContain("exited with code 125");
  });

  it("fails when the container is killed by a signal", async () => {
    const { result } = await drive(
      [],
      { dir: WT, prompt: PROMPT },
      { code: null, signal: "SIGKILL" }
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("SIGKILL");
  });

  it("fails on a provider error even though pi exits 0", async () => {
    const { result } = await drive([json(assistantEnd("", "error"))], {
      dir: WT,
      prompt: PROMPT,
    });

    expect(result.ok).toBe(false);
  });

  it("resolves instead of hanging when docker cannot be spawned", async () => {
    const { result } = await drive(
      [],
      { dir: WT, prompt: PROMPT },
      { error: new Error("spawn docker ENOENT") }
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("failed to start the agent container");
    expect(result.text).toContain("ENOENT");
  });

  it("hands dir, gitDir and image through to argv", async () => {
    await drive([], { dir: WT, prompt: PROMPT, gitDir: GIT_DIR, image: "custom:1" });

    const argv = spawnMock.mock.calls[0]?.[1] ?? [];
    expect(argv).toContain(`${WT}:/work`);
    expect(argv).toContain(`${GIT_DIR}:${GIT_DIR}:ro`);
    expect(argv).toContain("custom:1");
  });
});

describe("git config leak scan", () => {
  it("flags a remote URL with an embedded credential", () => {
    const findings = findGitConfigSecrets(
      [
        "[core]",
        "\trepositoryformatversion = 0",
        '[remote "origin"]',
        "\turl = https://octocat:ghp_SECRETVALUE@github.com/acme/app.git",
        "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      ].join("\n")
    );

    expect(findings).toEqual(['remote "origin".url embeds credentials']);
    // a description only — the value itself must never be echoed back
    expect(findings.join()).not.toContain("ghp_");
  });

  it("accepts a plain https or ssh remote", () => {
    expect(
      findGitConfigSecrets('[remote "origin"]\n\turl = https://github.com/acme/app.git')
    ).toEqual([]);
    expect(findGitConfigSecrets('[remote "origin"]\n\turl = git@github.com:acme/app.git')).toEqual(
      []
    );
  });

  it("flags an auth header or a token stashed in git config", () => {
    const findings = findGitConfigSecrets(
      "[http]\n\textraHeader = Authorization: Bearer github_pat_11ABC\n[foo]\n\ttoken = glpat-xyz"
    );

    expect(findings).toHaveLength(2);
    expect(findings.join()).not.toContain("github_pat");
    expect(findings.join()).not.toContain("glpat");
  });

  it("ignores comments, bare sections and empty values", () => {
    expect(
      findGitConfigSecrets(
        '# comment\n; other\n[branch "main"]\n\tremote = origin\n\tempty =\n'
      )
    ).toEqual([]);
  });

  it("refuses to mount a .git whose config carries a credential", () => {
    const dir = makeTempDir("factory-gitdir-");
    try {
      fs.writeFileSync(
        path.join(dir, "config"),
        '[remote "origin"]\n\turl = https://user:tok@example.com/a/b.git\n'
      );

      expect(() => assertGitDirSafeToMount(dir)).toThrow(/refusing to mount/);
      expect(() => assertGitDirSafeToMount(dir)).toThrow(/remote "origin"\.url/);
    } finally {
      removeTempDir(dir);
    }
  });

  it("allows a clean .git, and a directory with no config file", () => {
    const dir = makeTempDir("factory-gitdir-");
    try {
      fs.writeFileSync(
        path.join(dir, "config"),
        '[remote "origin"]\n\turl = git@github.com:a/b.git\n'
      );
      expect(() => assertGitDirSafeToMount(dir)).not.toThrow();
      expect(() => assertGitDirSafeToMount(path.join(dir, "missing"))).not.toThrow();
    } finally {
      removeTempDir(dir);
    }
  });

  it("refuses to spawn at all when the mounted .git would leak", () => {
    const dir = makeTempDir("factory-gitdir-");
    try {
      fs.writeFileSync(
        path.join(dir, "config"),
        "[http]\n\textraHeader = Authorization: Basic Zm9vYmFy\n"
      );

      expect(() => runAgentInContainer({ dir: WT, prompt: PROMPT, gitDir: dir })).toThrow(
        /refusing to mount/
      );
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      removeTempDir(dir);
    }
  });
});
