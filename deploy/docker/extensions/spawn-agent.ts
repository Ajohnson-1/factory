/**
 * The orchestrator's `spawn_agent` tool — loaded *inside* the agent container.
 *
 * This file is baked into the `factory-agent` image (deploy/docker/
 * factory-agent.Dockerfile) rather than mounted, because an extension resolves
 * its imports from its own directory upward and `@earendil-works/pi-ai` only
 * lives inside pi's package tree; from an arbitrary mount point the import fails
 * with ERR_MODULE_NOT_FOUND. Baking also pins this code to the image's pi
 * version, the same reason build.sh pins pi itself, and keeps the container's
 * mount list at exactly two entries.
 *
 * It deliberately duplicates the wire and env names rather than importing them:
 * src/agents/ipc.ts is not in the image. `test/agents/extension-drift.test.ts`
 * asserts the two files agree, so the duplication cannot rot silently.
 *
 * Everything here is a host operation the container is not allowed to do: start
 * a container, write git, merge a branch. The tool's whole job is to carry a
 * request out and bring a summary back.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import net from "node:net";

const IPC_HOST = process.env.FACTORY_IPC_HOST || "host.docker.internal";
const IPC_PORT = Number(process.env.FACTORY_IPC_PORT || "0");
const IPC_TOKEN = process.env.FACTORY_IPC_TOKEN || "";
const PROTOCOL_VERSION = 1;

/** How long to wait on the host. Must outlast AGENT_TIMEOUT_MS — the host is
 *  running a whole child container for us, and giving up first would leave the
 *  orchestrator retrying a spawn that is still spending money. */
const SPAWN_TIMEOUT_MS = Number(process.env.FACTORY_SPAWN_TIMEOUT_MS || "0");

/** The role's tool set, applied here rather than by `--tools`, which is an
 *  allowlist that would also take spawn_agent away (plan "Spike 2"). */
const ACTIVE_TOOLS = (process.env.FACTORY_ACTIVE_TOOLS || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const SPAWNABLE_HINT = process.env.FACTORY_SPAWNABLE_ROLES || "";

/** Diagnostics to stderr only: stdout IS pi's JSONL event stream, and a stray
 *  write there corrupts the run's own record of what happened. */
function note(message: string): void {
  process.stderr.write(`[spawn-agent] ${message}\n`);
}

interface HostReply {
  v?: number;
  ok?: boolean;
  status?: string;
  summary?: string;
  error?: string;
}

/** One request per connection, one reply, closed. */
function askHost(payload: Record<string, unknown>, timeoutMs: number): Promise<HostReply> {
  return new Promise<HostReply>((resolve, reject) => {
    if (!IPC_PORT) {
      reject(new Error("the factory host gave this run no spawn channel"));
      return;
    }
    const socket = net.connect({ host: IPC_HOST, port: IPC_PORT });
    let buffer = Buffer.alloc(0);
    let settled = false;

    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      socket.destroy();
      done(() => reject(new Error(`the factory host did not answer within ${timeoutMs}ms`)));
    }, timeoutMs);

    socket.on("error", (err: Error) => {
      done(() => reject(new Error(`spawn channel failed: ${err.message}`)));
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ ...payload, v: PROTOCOL_VERSION })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      // LF-only framing: U+2028/U+2029 are valid inside JSON strings.
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      const line = buffer.subarray(0, newline).toString("utf8");
      done(() => {
        try {
          resolve(JSON.parse(line) as HostReply);
        } catch (err) {
          reject(new Error(`unparsable host reply: ${(err as Error).message}`));
        }
        socket.end();
      });
    });
  });
}

const spawnAgentTool = {
  name: "spawn_agent",
  label: "Spawn agent",
  description:
    "Ask the factory host to run one specialist agent on a scoped task and " +
    "merge its work back into the card branch. Returns what the child did, " +
    "whether it succeeded, and the diff it produced.",
  parameters: Type.Object({
    role: Type.String({
      description: `Which specialist to run. One of: ${SPAWNABLE_HINT}.`,
      ...(SPAWNABLE_HINT ? { enum: SPAWNABLE_HINT.split(",").map((s) => s.trim()) } : {}),
    }),
    task: Type.String({
      description:
        "The single scoped job for this child: what to change, and how to " +
        "know it is done. Independent tasks go out together; tasks that touch " +
        "the same files must be serialised.",
    }),
    context: Type.Optional(
      Type.String({
        description:
          "Extra facts the child needs — file paths, a spec excerpt, or the " +
          "merge conflict it must work around when re-spawning a failed task.",
      })
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { role: string; task: string; context?: string }
  ): Promise<{ content: { type: "text"; text: string }[]; details: undefined }> {
    const request = {
      t: "spawn",
      token: IPC_TOKEN,
      role: params.role,
      task: params.task,
      ...(params.context ? { context: params.context } : {}),
    };

    let reply: HostReply;
    try {
      reply = await askHost(request, SPAWN_TIMEOUT_MS);
    } catch (err) {
      // An IPC failure is a factory fault, not a failed plan: surface it as a
      // tool error so pi reports it rather than treating it as a child result.
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (reply.v !== PROTOCOL_VERSION) {
      throw new Error(`unexpected protocol version ${String(reply.v)} from the factory host`);
    }

    const status = reply.status ?? (reply.ok ? "ok" : "failed");
    const body =
      reply.summary ?? reply.error ?? `spawn_agent(${params.role}): no summary from the host`;
    note(`${params.role} -> ${status}`);

    // A child that failed is information the orchestrator must reason about
    // (re-spawn with the conflict as context), so it comes back as a normal
    // result. Only channel faults throw.
    return {
      content: [{ type: "text", text: `role=${params.role} status=${status}\n${body}` }],
      details: undefined,
    };
  },
};

export default function (pi: ExtensionAPI): void {
  pi.registerTool(spawnAgentTool);

  // setActiveTools() is an action method: it is not callable while extensions
  // load ("Extension runtime not initialized"), so the tool set is applied when
  // the session starts.
  pi.on("session_start", async () => {
    if (!ACTIVE_TOOLS.length) {
      note("FACTORY_ACTIVE_TOOLS is empty; leaving pi's default tool set in place");
      return;
    }
    pi.setActiveTools(ACTIVE_TOOLS);
    note(`active tools: ${pi.getActiveTools().join(",")}`);
  });
}
