/**
 * The reviewer's `post_review` tool — loaded *inside* the reviewer container.
 *
 * Same shape and same reasons as `spawn-agent.ts`, which this deliberately
 * imitates rather than imports: an extension resolves its imports from its own
 * directory upward, so it can only reach what the image shims at
 * `/opt/factory/node_modules`, and `src/agents/ipc.ts` is not in the image. The
 * duplication is pinned by `test/agents/extension-drift.test.ts`.
 *
 * Why a tool and not a report the host parses: `GITHUB_TOKEN` cannot enter a
 * container (phase 2.1's rule), so the host has to post everything. Asking the
 * reviewer for one JSON block at the end of its turn would make every finding
 * depend on the run finishing — a reviewer that times out or dies mid-message
 * would have read the whole diff and posted none of it. Posting per call puts
 * each finding on the PR the moment it is made, and lets the host refuse one
 * out-of-bounds comment without losing the others.
 *
 * What this file does NOT know: the pull request number, the owner, the repo and
 * the head SHA. All of them are the host's, which is what stops a reviewed
 * container from commenting on a PR nobody asked it to review.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import net from "node:net";

const IPC_HOST = process.env.FACTORY_IPC_HOST || "host.docker.internal";
const IPC_PORT = Number(process.env.FACTORY_IPC_PORT || "0");
const IPC_TOKEN = process.env.FACTORY_IPC_TOKEN || "";
const PROTOCOL_VERSION = 1;

/** How long to wait on the host for one comment. A POST to the GitHub API, not a
 *  whole child container, so this is a minute rather than the spawn timeout. */
const POST_TIMEOUT_MS = Number(process.env.FACTORY_REVIEW_TIMEOUT_MS || "60000");

/** The role's tool set, applied here rather than by `--tools`, which is an
 *  allowlist that would also take post_review away (plan "Spike 2"). */
const ACTIVE_TOOLS = (process.env.FACTORY_ACTIVE_TOOLS || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

/** Diagnostics to stderr only: stdout IS pi's JSONL event stream. */
function note(message: string): void {
  process.stderr.write(`[post-review] ${message}\n`);
}

/**
 * The hint that turns "cannot reach the host" into something an operator can fix.
 *
 * Identical wording to `spawn-agent.ts` on purpose — it is the same fault on the
 * same listener, and a reviewer on a Linux host hits it for exactly the reason an
 * orchestrator does. The drift test compares the two so they cannot diverge into
 * two different diagnoses of one problem.
 */
const BIND_HINT =
  "is the host's FACTORY_IPC_BIND reachable from a container? On a Linux host " +
  "--add-host=host.docker.internal:host-gateway arrives at the bridge address, so " +
  "the 127.0.0.1 default never gets here (deploy/setup-factory.sh sets it).";

function channelFault(cause: string): Error {
  return new Error(`review channel failed: ${cause} \u2014 ${BIND_HINT}`);
}

interface HostReply {
  v?: number;
  ok?: boolean;
  status?: string;
  summary?: string;
  error?: string;
  posted?: number;
  remaining?: number;
}

/** One request per connection, one reply, closed. */
function askHost(payload: Record<string, unknown>, timeoutMs: number): Promise<HostReply> {
  return new Promise<HostReply>((resolve, reject) => {
    if (!IPC_PORT) {
      reject(new Error("the factory host gave this review no channel to post through"));
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
      done(() => reject(channelFault(`the factory host did not answer within ${timeoutMs}ms`)));
    }, timeoutMs);

    socket.on("error", (err: Error) => {
      done(() => reject(channelFault(err.message)));
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

const postReviewTool = {
  name: "post_review",
  label: "Post review",
  description:
    "Post one review finding to the pull request under review. With a path and a " +
    "line it becomes a comment on that line of the new version of the file; with " +
    "only a body it becomes the review summary. The host checks the location and " +
    "posts it — you cannot reach GitHub yourself.",
  parameters: Type.Object({
    body: Type.String({
      description:
        "The finding, or the summary. Say what is wrong, what happens because of " +
        "it, and what would fix it. Vague findings are not salvageable later.",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "File the finding is in, exactly as `git diff` names it. Omit it for the " +
          "summary. A path the diff does not touch is refused.",
      })
    ),
    line: Type.Optional(
      Type.Number({
        description:
          "Line number in the NEW version of that file — the file as it is checked " +
          "out here, not a diff offset and not a removed line. Required with a path.",
      })
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { body: string; path?: string; line?: number }
  ): Promise<{ content: { type: "text"; text: string }[]; details: undefined }> {
    const request = {
      t: "review",
      token: IPC_TOKEN,
      body: params.body,
      ...(params.path !== undefined ? { path: params.path } : {}),
      ...(params.line !== undefined ? { line: params.line } : {}),
    };

    let reply: HostReply;
    try {
      reply = await askHost(request, POST_TIMEOUT_MS);
    } catch (err) {
      // A channel fault is a factory fault, not a finding: throw so pi reports it
      // as a tool error rather than letting the model read it as a rejection of
      // the comment and move on to the next one.
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (reply.v !== PROTOCOL_VERSION) {
      throw new Error(`unexpected protocol version ${String(reply.v)} from the factory host`);
    }

    const status = reply.status ?? (reply.ok ? "ok" : "failed");
    const body =
      reply.summary ?? reply.error ?? `post_review: no answer from the factory host`;
    const counts =
      reply.posted !== undefined
        ? ` [${reply.posted} posted${reply.remaining !== undefined ? `, ${Math.max(reply.remaining, 0)} left` : ""}]`
        : "";
    note(`${params.path ? `line ${params.path}:${String(params.line)}` : "summary"} -> ${status}`);

    // A refused comment comes back as a normal result, not an error: the model has
    // to read the reason and decide whether to move the finding, and pi only shows
    // a thrown error as a failed tool call.
    return {
      content: [{ type: "text", text: `status=${status}${counts}\n${body}` }],
      details: undefined,
    };
  },
};

export default function (pi: ExtensionAPI): void {
  pi.registerTool(postReviewTool);

  // setActiveTools() is an action method: not callable while extensions load
  // ("Extension runtime not initialized"), so the tool set is applied at
  // session_start.
  pi.on("session_start", async () => {
    if (!ACTIVE_TOOLS.length) {
      note("FACTORY_ACTIVE_TOOLS is empty; leaving pi's default tool set in place");
      return;
    }
    pi.setActiveTools(ACTIVE_TOOLS);
    note(`active tools: ${pi.getActiveTools().join(",")}`);
  });
}
