import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import {
  IPC_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  createIpcServer,
  createIpcToken,
  encodeFrame,
  parseRequest,
  tokenMatches,
  type IpcReply,
} from "../../src/agents/ipc.js";

/**
 * The channel is the only way a containerized orchestrator can do anything, so
 * everything it accepts or refuses is a security decision worth a test. These
 * use real loopback sockets: no docker, no network beyond 127.0.0.1.
 */

const TOKEN = "a-very-secret-token";

function request(overrides: Record<string, unknown> = {}): string {
  return encodeFrame({
    v: IPC_PROTOCOL_VERSION,
    t: "spawn",
    token: TOKEN,
    role: "coder",
    task: "add greet()",
    ...overrides,
  });
}

/** One connection, one frame, one reply — the documented shape of the channel. */
async function talk(
  port: number,
  frame: string,
  options: { rawChunks?: string[] } = {}
): Promise<IpcReply> {
  const socket = net.connect({ host: "127.0.0.1", port });
  const text = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    socket.setTimeout(5_000, () => reject(new Error("timed out waiting for the host")));
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        resolve(buffer.slice(0, newline));
        socket.end();
      }
    });
    if (options.rawChunks) {
      for (const part of options.rawChunks) socket.write(part);
    } else {
      socket.write(frame);
    }
  }).finally(() => socket.destroy());

  return JSON.parse(text) as IpcReply;
}

describe("parseRequest", () => {
  it("accepts a well-formed spawn request", () => {
    const parsed = parseRequest(request(), TOKEN);

    expect("request" in parsed).toBe(true);
    if ("request" in parsed) {
      expect(parsed.request.role).toBe("coder");
      expect(parsed.request.task).toBe("add greet()");
    }
  });

  it("carries context through when the orchestrator supplied it", () => {
    const parsed = parseRequest(request({ context: "c1 touched src/x.js" }), TOKEN);

    expect("request" in parsed && parsed.request.context).toBe("c1 touched src/x.js");
  });

  it("omits context entirely when it was absent rather than inventing one", () => {
    const parsed = parseRequest(request(), TOKEN);

    expect("request" in parsed && "context" in parsed.request).toBe(false);
  });

  // Every one of these is a container talking to the host; none may throw.
  it("refuses malformed, wrong-version, wrong-type and non-object frames", () => {
    for (const [label, frame] of [
      ["not json", "}{\n"],
      ["an array", "[1,2]\n"],
      ["a bare string", '"hello"\n'],
      ["a bare number", "7\n"],
      ["null", "null\n"],
      ["no version", encodeFrame({ t: "spawn", token: TOKEN, role: "coder", task: "x" })],
      ["wrong version", request({ v: 999 })],
      ["wrong type", request({ t: "exec" })],
      ["missing role", encodeFrame({ v: 1, t: "spawn", token: TOKEN, task: "x" })],
      ["blank role", request({ role: "   " })],
      ["non-string role", request({ role: { nope: true } })],
      ["missing task", encodeFrame({ v: 1, t: "spawn", token: TOKEN, role: "coder" })],
      ["blank task", request({ task: "" })],
      ["object context", request({ context: { a: 1 } })],
    ] as Array<[string, string]>) {
      const parsed = parseRequest(frame, TOKEN);
      expect("error" in parsed, label).toBe(true);
    }
  });

  it("refuses a wrong, empty or missing token without distinguishing them", () => {
    const errors = [
      parseRequest(request({ token: "wrong" }), TOKEN),
      parseRequest(request({ token: "" }), TOKEN),
      parseRequest(encodeFrame({ v: 1, t: "spawn", role: "coder", task: "x" }), TOKEN),
    ].map((parsed) => ("error" in parsed ? parsed.error : ""));

    // Same wording for all three: which check failed is not something a container
    // gets to learn, and it makes the token comparison non-oracle-ish.
    expect(new Set(errors).size).toBe(1);
    expect([...errors][0]).toBe("invalid token");
  });
});

describe("tokenMatches", () => {
  it("is exact and length-sensitive", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(tokenMatches("", "")).toBe(true);
  });

  it("mints tokens that are unguessable, url-safe and never reused", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => createIpcToken()));

    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token.length).toBeGreaterThanOrEqual(32);
      // safe for a JSON frame and an env var: no padding, no +/= 
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("createIpcServer", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("hands a valid request to the handler and relays its answer", async () => {
    const seen: Array<{ role: string; task: string }> = [];
    const server = await createIpcServer({
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      onSpawn: async (req) => {
        seen.push({ role: req.role, task: req.task });
        return { status: "ok", summary: "role=coder status=ok" };
      },
    });
    close = server.close;

    const reply = await talk(server.port, request());

    expect(seen).toEqual([{ role: "coder", task: "add greet()" }]);
    expect(reply).toMatchObject({ v: IPC_PROTOCOL_VERSION, ok: true, status: "ok" });
  });

  it("answers ok:false for a child that failed, so the tool can report it", async () => {
    const server = await createIpcServer({
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      onSpawn: async () => ({ status: "failed", summary: "MERGE CONFLICT" }),
    });
    close = server.close;

    const reply = await talk(server.port, request());

    expect(reply.ok).toBe(false);
    expect(reply.status).toBe("failed");
    expect(reply.summary).toContain("MERGE CONFLICT");
  });

  it("refuses a bad token before the handler ever runs", async () => {
    let handlerCalls = 0;
    const server = await createIpcServer({
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      onSpawn: async () => {
        handlerCalls += 1;
        return { status: "ok", summary: "" };
      },
    });
    close = server.close;

    const reply = await talk(server.port, request({ token: "guessed" }));

    expect(handlerCalls).toBe(0);
    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("invalid token");
  });

  it("turns a throwing handler into an error reply rather than a hung connection", async () => {
    const server = await createIpcServer({
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      onSpawn: async () => {
        throw new Error("docker is on fire");
      },
    });
    close = server.close;

    const reply = await talk(server.port, request());

    expect(reply).toMatchObject({ ok: false, status: "failed" });
    expect(reply.error).toContain("docker is on fire");
  });

  it("reassembles a request split across TCP chunks", async () => {
    const frame = request();
    const server = await createIpcServer({
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      onSpawn: async (req) => ({ status: "ok", summary: req.task }),
    });
    close = server.close;

    const reply = await talk(server.port, "", {
      rawChunks: [frame.slice(0, 12), frame.slice(12, 30), frame.slice(30)],
    });

    expect(reply.ok).toBe(true);
    expect(reply.summary).toBe("add greet()");
  });

  it("rejects an oversized frame instead of buffering it", async () => {
    const server = await createIpcServer({
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      onSpawn: async () => ({ status: "ok", summary: "" }),
    });
    close = server.close;

    // Write past the cap without a newline first: the size check has to fire on
    // the accumulated buffer, not only when a frame completes.
    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    const reply = await new Promise<IpcReply>((resolve, reject) => {
      let buffer = "";
      socket.setTimeout(5_000, () => reject(new Error("no reply")));
      socket.on("error", reject);
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline !== -1) resolve(JSON.parse(buffer.slice(0, newline)) as IpcReply);
      });
      socket.write(request({ task: "x".repeat(MAX_FRAME_BYTES) }));
    }).finally(() => socket.destroy());

    expect(reply.ok).toBe(false);
    expect(reply.error).toBe("frame too large");
  });

  it("reports each connection, accepted or rejected, for the operator's log", async () => {
    const kinds: string[] = [];
    const server = await createIpcServer({
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      onSpawn: async () => ({ status: "ok", summary: "" }),
      onConnection: (kind, reason) => {
        kinds.push(reason ? `${kind}:${reason}` : kind);
      },
    });
    close = server.close;

    await talk(server.port, request());
    await talk(server.port, request({ token: "nope" }));

    expect(kinds).toContain("accepted");
    expect(kinds).toContain("rejected:invalid token");
  });

  it("stops answering once closed, so a token cannot outlive its run", async () => {
    const server = await createIpcServer({
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      onSpawn: async () => ({ status: "ok", summary: "" }),
    });

    await server.close();

    const socket = net.connect({ host: "127.0.0.1", port: server.port });
    const refused = await new Promise<boolean>((resolve) => {
      socket.on("error", () => resolve(true));
      socket.on("connect", () => resolve(false));
      socket.setTimeout(2_000, () => resolve(true));
    });
    socket.destroy();

    expect(refused).toBe(true);
  });
});
