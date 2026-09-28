/**
 * Host side of the Option A boundary (phase 2.2).
 *
 * The orchestrator runs in a container like every other role, so its
 * `spawn_agent` tool cannot start children by itself — starting a container and
 * merging a branch are host operations, and the container has no docker socket,
 * no credentials and a read-only `.git`. The tool therefore asks the host over
 * this channel, and the host does the work and answers with a summary.
 *
 * Transport is JSONL on TCP. One request per connection, one reply, close:
 * a spawn can run for the whole `AGENT_TIMEOUT_MS`, so a long-lived multiplexed
 * connection would buy nothing and make "which run is this?" harder to answer.
 *
 * Framing is LF-only, never `node:readline` — U+2028/U+2029 are legal inside
 * JSON strings and readline splits on them (same rule src/agent/container.ts
 * follows for pi's own event stream).
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";

export const IPC_PROTOCOL_VERSION = 1;

/** Refuse anything larger before buffering it — the peer is a container. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Roles are data on the wire, so the tool's argument arrives as a string. */
export interface SpawnRequest {
  v: number;
  t: "spawn";
  token: string;
  role: string;
  task: string;
  context?: string;
}

export interface IpcReply {
  v: number;
  ok: boolean;
  /** Mirrors the spawn outcome: "ok" | "failed" | "timeout" | "rejected". */
  status?: string;
  summary?: string;
  error?: string;
}

export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Exact token compare, constant time when both sides are the same length. */
export function tokenMatches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Validate one request line. Everything about a peer is untrusted input, so this
 * reports a reason rather than throwing, and the caller turns it into a reply.
 */
export function parseRequest(
  line: string,
  expectedToken: string
): { request: SpawnRequest } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { error: "request is not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "request is not an object" };
  }
  const record = raw as Record<string, unknown>;
  if (record.v !== IPC_PROTOCOL_VERSION) {
    return { error: `unsupported protocol version ${String(record.v)}` };
  }
  if (record.t !== "spawn") return { error: `unknown request type` };
  if (typeof record.token !== "string" || !tokenMatches(record.token, expectedToken)) {
    return { error: "invalid token" };
  }
  if (typeof record.role !== "string" || !record.role.trim()) {
    return { error: "role must be a non-empty string" };
  }
  if (typeof record.task !== "string" || !record.task.trim()) {
    return { error: "task must be a non-empty string" };
  }
  if (record.context !== undefined && typeof record.context !== "string") {
    return { error: "context must be a string when present" };
  }
  return {
    request: {
      v: IPC_PROTOCOL_VERSION,
      t: "spawn",
      token: record.token,
      role: record.role,
      task: record.task,
      ...(typeof record.context === "string" ? { context: record.context } : {}),
    },
  };
}

/** A fresh per-run token. Never reused across cards or restarts. */
export function createIpcToken(): string {
  // base64url so it survives a JSON round-trip and an env var unchanged.
  return randomBytes(24).toString("base64url");
}

export interface IpcServerOptions {
  token: string;
  host: string;
  /** 0 lets the OS choose, which is what concurrent cards need. */
  port: number;
  onSpawn: (req: {
    role: string;
    task: string;
    context?: string;
  }) => Promise<{ status: string; summary: string }>;
  /** Egress for progress: the host streams tool events back to Discord itself. */
  onConnection?: (kind: "accepted" | "rejected", reason?: string) => void;
}

export interface IpcServer {
  port: number;
  /** Resolves once the listener is closed and no request is in flight. */
  close: () => Promise<void>;
  /** Requests still being handled; a close must not drop their replies. */
  inFlight: () => number;
}

/**
 * Listen for spawn requests. The caller owns the token: it hands it to exactly
 * one orchestrator container through `extraEnv`, so the channel is only usable
 * for as long as that run is, and by nothing that does not have it.
 */
export async function createIpcServer(opts: IpcServerOptions): Promise<IpcServer> {
  const inFlight = new Set<net.Socket>();
  let closing = false;

  const server = net.createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    inFlight.add(socket);
    let buffer = Buffer.alloc(0);
    let answered = false;

    const reply = (response: IpcReply): void => {
      if (answered) return;
      answered = true;
      socket.end(encodeFrame(response));
      inFlight.delete(socket);
    };

    socket.on("error", () => {
      // A container that goes away mid-request is normal on the timeout path.
      if (!answered) {
        answered = true;
        inFlight.delete(socket);
      }
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) {
        opts.onConnection?.("rejected", "frame too large");
        reply({ v: IPC_PROTOCOL_VERSION, ok: false, error: "frame too large" });
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;

      const parsed = parseRequest(buffer.subarray(0, newline).toString("utf8"), opts.token);
      if ("error" in parsed) {
        // Do not say which check failed beyond a category: the token comparison
        // in particular should not be distinguishable by timing or message.
        opts.onConnection?.("rejected", parsed.error);
        reply({ v: IPC_PROTOCOL_VERSION, ok: false, error: parsed.error });
        return;
      }

      opts.onConnection?.("accepted");
      void (async () => {
        try {
          const outcome = await opts.onSpawn(parsed.request);
          reply({
            v: IPC_PROTOCOL_VERSION,
            ok: outcome.status === "ok",
            status: outcome.status,
            summary: outcome.summary,
          });
        } catch (err) {
          reply({
            v: IPC_PROTOCOL_VERSION,
            ok: false,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("could not determine the spawn IPC port");
  }

  return {
    port: address.port,
    inFlight: () => inFlight.size,
    async close(): Promise<void> {
      closing = true;
      // Anything still in flight belongs to a run that is ending; its reply has
      // nowhere to go, so close it rather than hold the listener open forever.
      for (const socket of inFlight) socket.destroy();
      inFlight.clear();
      await new Promise<void>((resolve) => {
        // In-flight sockets are destroyed above, so this waits for nothing but
        // the listener itself. (net.Server has no idle-connection close to call.)
        server.close(() => resolve());
      });
    },
  };
}
