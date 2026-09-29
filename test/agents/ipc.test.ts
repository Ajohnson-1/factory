import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import {
  IPC_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  MAX_REVIEW_BODY_CHARS,
  createIpcServer,
  parseFrame,
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

/**
 * Phase 2.3 — the review request type on the same channel.
 *
 * The reviewer posts findings over this socket, so everything the spawn path
 * refuses by construction has to hold here too: same framing, same token check,
 * same reply shape, and a handler that is simply absent for the role that must not
 * use it.
 */
function reviewFrame(overrides: Record<string, unknown> = {}): string {
  return encodeFrame({
    v: IPC_PROTOCOL_VERSION,
    t: "review",
    token: TOKEN,
    body: "name is never validated",
    path: "src/greet.js",
    line: 12,
    ...overrides,
  });
}

describe("parseFrame", () => {
  it("routes a review frame to the review shape and keeps its fields", () => {
    const parsed = parseFrame(reviewFrame(), TOKEN);

    expect("request" in parsed).toBe(true);
    if ("request" in parsed) {
      expect(parsed.request).toEqual({
        v: IPC_PROTOCOL_VERSION,
        t: "review",
        token: TOKEN,
        body: "name is never validated",
        path: "src/greet.js",
        line: 12,
      });
    }
  });

  it("routes a spawn frame to the spawn shape, which is what keeps 2.2 working", () => {
    const parsed = parseFrame(request(), TOKEN);

    expect("request" in parsed && parsed.request.t).toBe("spawn");
  });

  it("refuses a body of any shape that is not a non-empty string", () => {
    for (const [label, frame] of [
      ["missing body", encodeFrame({ v: 1, t: "review", token: TOKEN })],
      ["empty body", reviewFrame({ body: "" })],
      ["whitespace body", reviewFrame({ body: "   " })],
      ["number body", reviewFrame({ body: 42 })],
      ["object body", reviewFrame({ body: { a: 1 } })],
    ] as Array<[string, string]>) {
      expect("error" in parseFrame(frame, TOKEN), label).toBe(true);
    }
  });

  /**
   * A finding has to say both where and when. Half of that is how a comment ends up
   * attached to the wrong line of the wrong file with a confident body, which is
   * worse on a public PR than no comment at all.
   */
  it("refuses a path without a line, and a line without a path", () => {
    expect("error" in parseFrame(reviewFrame({ line: undefined }), TOKEN)).toBe(true);
    expect("error" in parseFrame(reviewFrame({ path: undefined }), TOKEN)).toBe(true);
    expect("error" in parseFrame(reviewFrame({ line: "12" }), TOKEN)).toBe(true);
    expect("error" in parseFrame(reviewFrame({ path: "  " }), TOKEN)).toBe(true);
  });

  /**
   * JSON numbers are doubles. `line: 12.5` and `line: 1e99` are both valid JSON and
   * both nonsense as a line number, and GitHub's API would take the frame and fail
   * the post — the model then sees a tool error rather than the correction.
   */
  it("refuses a line that is not a positive integer", () => {
    for (const line of [0, -1, 12.5, Number.NaN, 1e99, "12"]) {
      expect("error" in parseFrame(reviewFrame({ line }), TOKEN), String(line)).toBe(true);
    }
    expect("error" in parseFrame(reviewFrame({ line: 1 }), TOKEN)).toBe(false);
  });

  it("refuses a body GitHub would reject anyway, rather than eating a 422 later", () => {
    expect("error" in parseFrame(reviewFrame({ body: "x".repeat(MAX_REVIEW_BODY_CHARS + 1) }), TOKEN)).toBe(
      true
    );
    expect("error" in parseFrame(reviewFrame({ body: "x".repeat(MAX_REVIEW_BODY_CHARS) }), TOKEN)).toBe(
      false
    );
  });

  it("refuses a wrong token on a review frame exactly as it does on a spawn one", () => {
    for (const frame of [reviewFrame({ token: "wrong" }), reviewFrame({ token: "" })]) {
      const parsed = parseFrame(frame, TOKEN);
      expect("error" in parsed && parsed.error).toBe("invalid token");
    }
  });

  it("refuses an unknown request type without naming the types it does know", () => {
    const parsed = parseFrame(encodeFrame({ v: 1, t: "exec", token: TOKEN }), TOKEN);

    expect("error" in parsed && parsed.error).toBe("unknown request type");
  });

  it("never throws on anything a container could send", () => {
    for (const junk of ["", "\n", "{}", encodeFrame(null), "[]", "  ", "{\"t\":", "0\n"]) {
      expect(() => parseFrame(junk, TOKEN), junk).not.toThrow();
    }
  });
});

describe("createIpcServer with a review handler", () => {
  async function withReviewServer(
    onReview: NonNullable<Parameters<typeof createIpcServer>[0]["onReview"]>,
    extra: { onSpawn?: Parameters<typeof createIpcServer>[0]["onSpawn"] } = {}
  ): Promise<{ port: number; close: () => Promise<void>; calls: unknown[] }> {
    const calls: unknown[] = [];
    const server = await createIpcServer({
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      ...extra,
      onReview: async (req) => {
        calls.push(req);
        return onReview(req);
      },
    });
    return { port: server.port, close: () => server.close(), calls };
  }

  const ok = async (): Promise<{ status: string; summary: string }> => ({
    status: "ok",
    summary: "posted",
  });

  it("hands the handler a parsed review and returns posted/remaining to the container", async () => {
    const { port, close } = await withReviewServer(async () => ({
      status: "ok",
      summary: "posted on src/greet.js:12",
      posted: 3,
      remaining: 17,
    }));

    const reply = await talk(port, reviewFrame());

    expect(reply).toMatchObject({
      v: IPC_PROTOCOL_VERSION,
      ok: true,
      status: "ok",
      summary: "posted on src/greet.js:12",
      posted: 3,
      remaining: 17,
    });
    await close();
  });

  it("passes a summary frame through with no path and no line invented for it", async () => {
    const { port, close, calls } = await withReviewServer(ok);

    await talk(port, reviewFrame({ path: undefined, line: undefined }));

    expect(calls).toEqual([{ body: "name is never validated" }]);
    await close();
  });

  /**
   * The role separation, enforced by the server rather than by trust. A reviewer
   * holds a valid token for the duration of its run; that token must buy it the
   * ability to post and nothing else — not a child container, not a merge.
   */
  it("refuses a spawn request on a channel with no spawn handler", async () => {
    const { port, close } = await withReviewServer(ok);

    const reply = await talk(port, request());

    expect(reply.ok).toBe(false);
    // The same words an unknown type gets, so the reply cannot be used to probe
    // which handlers this run happens to have.
    expect(reply.error).toBe("unknown request type");
    await close();
  });

  it("refuses a review request on an orchestrator's channel", async () => {
    const server = await createIpcServer({
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      onSpawn: async () => ({ status: "ok", summary: "child done" }),
    });

    const reply = await talk(server.port, reviewFrame());

    expect(reply.error).toBe("unknown request type");
    await server.close();
  });

  it("keeps the frame-size cap in front of the review handler", async () => {
    const { port, close, calls } = await withReviewServer(ok);

    const reply = await talk(port, reviewFrame({ body: "x".repeat(MAX_FRAME_BYTES + 10) }));

    expect(reply.error).toBe("frame too large");
    expect(calls).toEqual([]);
    await close();
  });

  it("reports a handler that throws as a failed reply rather than dropping the socket", async () => {
    const { port, close } = await withReviewServer(async () => {
      throw new Error("GitHub said no");
    });

    const reply = await talk(port, reviewFrame());

    expect(reply).toMatchObject({ ok: false, status: "failed", error: "GitHub said no" });
    await close();
  });

  it("counts a review request in flight the same way a spawn is", async () => {
    let release!: () => void;
    const inside = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await createIpcServer({
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      onReview: async () => {
        await inside;
        return { status: "ok", summary: "posted" };
      },
    });

    const inflight = talk(server.port, reviewFrame());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.inFlight()).toBe(1);
    release();
    expect((await inflight).ok).toBe(true);
    expect(server.inFlight()).toBe(0);
    await server.close();
  });
});
