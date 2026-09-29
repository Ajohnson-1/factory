/**
 * The reviewer (phase 2.3, step 2) — the whole flow with one thing faked.
 *
 * The container boundary and the GitHub API are the fakes; everything else is the
 * real thing: real git in a temp directory (so the detached checkout, the changed
 * file list and the per-file line counts are git's answers, not invented ones), a
 * real SQLite store, and a real TCP IPC server on a loopback port.
 *
 * The IPC server is deliberately *not* mocked. The point of the reviewer is a tool
 * call crossing that boundary and a comment appearing on a PR because of it, and a
 * fake `createIpcServer` would let a review post nothing while every assertion about
 * "what got posted" was satisfied by a stub. What the tests drive is
 * `server.onReview`'s counterpart — the request handler itself — reached by sending
 * actual frames over the socket the way the extension would.
 *
 * Per `plan/HANDOFF-2.3.md`'s BUG-1 note: the fake container writes nothing and
 * commits nothing, because a reviewer's checkout has `.git` mounted read-only and
 * its only output is what it posts. A fake that "helpfully" produced commits would
 * be modelling a thing that cannot exist.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AgentRunResult } from "../../src/agent/types.js";
import { POST_REVIEW_EXTENSION } from "../../src/reviewer/reviewer.js";
import { REVIEW_BASE_REF } from "../../src/reviewer/reviewer.js";
import {
  buildReviewPrompt,
  reviewPr,
  type PullRequestRef,
  type ReviewDeps,
} from "../../src/reviewer/reviewer.js";
import { ROLES } from "../../src/agents/roles.js";
import { createStore, type Store } from "../../src/state/store.js";
import { createWorktree, headCommit } from "../../src/worker/worktree.js";
import { makeGitRepo, type GitRepoFixture } from "../helpers/git.js";
import { makeTempDir, removeTempDir } from "../helpers/tmp.js";
import type { DiscordBot } from "../../src/discord/bot.js";

const CARD = "card-1";
const CARD_NAME = "Add a greet function";
const PR = 7;
const PR_URL = "https://github.com/acme/widgets/pull/7";

let fixture: GitRepoFixture;
let dbDir: string;
let store: Store;
let headSha: string;
let baseSha: string;
let bot: DiscordBot;
let sends: unknown[];

/** Everything the fake GitHub was asked to do, in order. */
interface GithubCall {
  kind: "get" | "comment" | "review";
  arg?: unknown;
}

let ghCalls: GithubCall[];
let prState: { state: string; draft: boolean; headSha: string };
let github: NonNullable<ReviewDeps["github"]>;
let containerOptions: unknown[];
let reviewRowBeforeStart: (() => void) | undefined;

beforeEach(() => {
  fixture = makeGitRepo();
  vi.stubEnv("REPO_PATH", fixture.repoPath);

  // `docs/extra.md` goes in on main, so the PR can *delete* a file it never added.
  // Added-then-deleted does not exercise anything: a file the PR both created and
  // removed is absent from `origin/main...HEAD` altogether, so the interesting
  // "in the diff but not in the commit" case never arises.
  writeFile(fixture.repoPath, "docs/extra.md", "# a\n# b\n# c\n");
  commit(fixture.repoPath, "docs: a file the PR will delete");
  execGit(fixture.repoPath, "push", "origin", "main");
  baseSha = execGit(fixture.repoPath, "rev-parse", "HEAD");

  // A factory PR's head: two commits that change two files and delete one, so
  // "is this path in the diff" and "does this line exist" have real answers.
  writeFile(fixture.repoPath, "src/greet.js", "export const greet = (name) => {\n  return 'hi ' + name;\n};\n");
  writeFile(fixture.repoPath, "src/unused.js", "// one line\n");
  execGit(fixture.repoPath, "checkout", "-B", `factory/${CARD}`, baseSha);
  commit(fixture.repoPath, "factory: greet");
  writeFile(fixture.repoPath, "src/greet.js", "export const greet = (name) => {\n  return 'hi ' + name;\n};\n// a note\n");
  fs.rmSync(path.join(fixture.repoPath, "docs/extra.md"));
  commit(fixture.repoPath, "factory: touch greet, delete extra.md");
  execGit(fixture.repoPath, "push", "-u", "origin", `factory/${CARD}`);
  headSha = execGit(fixture.repoPath, "rev-parse", "HEAD");
  execGit(fixture.repoPath, "checkout", "main");

  dbDir = makeTempDir("factory-review-db-");
  store = createStore(path.join(dbDir, "factory.db"));
  store.enqueue(CARD, CARD_NAME);

  sends = [];
  // Returns a promise because `DiscordBot.send` does (bot.ts:202). A fake that
  // answered `undefined` would let a `.catch()` on its result ship as working code.
  bot = {
    send: vi.fn(async (embed: unknown) => {
      sends.push(embed);
    }),
  } as unknown as DiscordBot;

  ghCalls = [];
  containerOptions = [];
  prState = { state: "open", draft: false, headSha };
  github = {
    getPullRequest: vi.fn(async () => ({
      number: PR,
      state: prState.state,
      draft: prState.draft,
      headSha: prState.headSha,
      htmlUrl: PR_URL,
    })),
    postLineComment: vi.fn(async (_n: number, finding: unknown) => {
      ghCalls.push({ kind: "comment", arg: finding });
      return "https://github.com/acme/widgets/pull/7#discussion_r1";
    }),
    postReview: vi.fn(async (_n: number, body: string) => {
      ghCalls.push({ kind: "review", arg: body });
      return `${PR_URL}#pullrequestreview-1`;
    }),
  } as unknown as NonNullable<ReviewDeps["github"]>;
});

afterEach(() => {
  store.close();
  removeTempDir(dbDir);
  fixture.cleanup();
});

function execGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function writeFile(root: string, rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(cwd: string, message: string): string {
  execGit(cwd, "-c", "user.email=f@test.local", "-c", "user.name=f", "add", "-A");
  execGit(cwd, "-c", "user.email=f@test.local", "-c", "user.name=f", "commit", "-m", message);
  return execGit(cwd, "rev-parse", "HEAD");
}

/** Another push to the same PR branch — what a `synchronized` event carries. */
function commitOnBranch(rel: string, content: string): string {
  execGit(fixture.repoPath, "checkout", `factory/${CARD}`);
  writeFile(fixture.repoPath, rel, content);
  const sha = commit(fixture.repoPath, `factory: add ${rel}`);
  execGit(fixture.repoPath, "checkout", "main");
  return sha;
}

/** A function, not a const: the head SHA only exists once `beforeEach` has run. */
function prRef(sha: string = headSha): PullRequestRef {
  return { number: PR, htmlUrl: PR_URL, headRef: `factory/${CARD}`, headSha: sha };
}

/** A container that reports a plain answer and changes nothing, like a real reviewer. */
function containerReturning(text: string, ok = true) {
  return vi.fn(async (options: unknown): Promise<AgentRunResult> => {
    containerOptions.push(options);
    reviewRowBeforeStart?.();
    return { ok, text, usage: { input: 5_000, output: 200, cacheRead: 40_000 } };
  }) as unknown as NonNullable<ReviewDeps["runContainer"]>;
}

/**
 * Send one frame over a real socket and read the reply, the way the in-container
 * extension does. Returns the decoded reply.
 */
function sendFrame(
  port: number,
  token: string,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ v: 1, token, ...payload })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const nl = buffer.indexOf(0x0a);
      if (nl === -1) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.subarray(0, nl).toString("utf8")) as Record<string, unknown>);
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}

/**
 * Run `reviewPr` with the container's view of the world intercepted while it is
 * running, so a test can post through the real channel at the moment the reviewer
 * would be posting.
 */
async function reviewWithLiveChannel(
  text: string,
  during: (api: { port: number; token: string; send: typeof sendFrame }) => Promise<void>,
  deps: Partial<ReviewDeps> = {}
) {
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured: { port: number; token: string } | undefined;

  // The token and port only exist inside reviewPr; recover them from the env the
  // container was handed, which is the same pair the extension sees.
  const runContainer = vi.fn(async (options: Parameters<NonNullable<ReviewDeps["runContainer"]>>[0]) => {
    const env = (options.extraEnv ?? {}) as Record<string, string>;
    captured = { port: Number(env.FACTORY_IPC_PORT), token: env.FACTORY_IPC_TOKEN };
    release();
    await during({ port: captured.port, token: captured.token, send: sendFrame });
    return { ok: true, text, usage: { input: 1, output: 1, cacheRead: 0 } } as AgentRunResult;
  }) as unknown as NonNullable<ReviewDeps["runContainer"]>;

  const outcome = await reviewPr(CARD, prRef(), {
    store,
    github,
    bot,
    runContainer,
    ...deps,
  });
  await started;
  return outcome;
}

describe("reviewPr — the happy path", () => {
  /**
   * The one assertion the whole feature rests on, and the easiest to fake: while the
   * reviewer is running, its working directory is a detached checkout of the commit
   * the webhook named. Get this wrong and every line number it reports is
   * confidently attached to the wrong code.
   */
  it("runs the reviewer in a detached checkout of exactly the PR head", async () => {
    const seen: { dir: string; head: string; detached: boolean; exists: boolean }[] = [];
    const runContainer = vi.fn(async (options: { dir: string }) => {
      seen.push({
        dir: options.dir,
        head: execGit(options.dir, "rev-parse", "HEAD"),
        detached: execGit(options.dir, "rev-parse", "--abbrev-ref", "HEAD") === "HEAD",
        exists: fs.existsSync(options.dir),
      });
      return { ok: true, text: "summary body" } as AgentRunResult;
    }) as unknown as NonNullable<ReviewDeps["runContainer"]>;

    const outcome = await reviewPr(CARD, prRef(), { store, github, bot, runContainer });

    expect(seen).toHaveLength(1);
    expect(seen[0].head).toBe(headSha);
    expect(seen[0].detached).toBe(true);
    expect(seen[0].exists).toBe(true);
    expect(outcome).toMatchObject({ status: "posted", comments: 0, summaryPosted: true });
  });

  it("posts a line comment the reviewer asks for, at the reviewed commit", async () => {
    await reviewWithLiveChannel("ignored", async ({ port, token, send }) => {
      const reply = await send(port, token, {
        t: "review",
        body: "name is never validated",
        path: "src/greet.js",
        line: 2,
      });
      expect(reply).toMatchObject({ ok: true, status: "ok", posted: 1 });
    });

    // Exactly one comment, at the reviewed commit, on the new version's line 2.
    // A second call is expected: this reviewer never posted a summary, so the
    // "a review is never lost" fallback put its final text there instead.
    expect(ghCalls.filter((c) => c.kind === "comment")).toEqual([
      {
        kind: "comment",
        arg: {
          path: "src/greet.js",
          line: 2,
          body: "name is never validated",
          commitId: headSha,
        },
      },
    ]);
  });

  it("records the review as posted, with the comment count and the run's usage", async () => {
    const outcome = await reviewWithLiveChannel("nothing to add", async ({ port, token, send }) => {
      await send(port, token, { t: "review", body: "a finding", path: "src/greet.js", line: 2 });
      await send(port, token, { t: "review", body: "the summary" });
    });

    expect(outcome).toMatchObject({ status: "posted", comments: 1, summaryPosted: true });
    const row = store.reviewFor(PR, headSha);
    expect(row).toMatchObject({
      status: "posted",
      comments: 1,
      summary_posted: 1,
      card_id: CARD,
      usage_in: 1,
    });
  });

  it("removes the review worktree when the run ends, and de-registers it", async () => {
    const during: { dir: string; exists: boolean }[] = [];
    const runContainer = vi.fn(async (options: { dir: string }) => {
      during.push({ dir: options.dir, exists: fs.existsSync(options.dir) });
      return { ok: true, text: "summary" } as AgentRunResult;
    }) as unknown as NonNullable<ReviewDeps["runContainer"]>;

    await reviewPr(CARD, prRef(), { store, github, bot, runContainer });

    expect(during).toHaveLength(1);
    expect(during[0].exists).toBe(true);
    expect(path.basename(during[0].dir)).toBe(`wt-${CARD}-r${headSha.slice(0, 7)}`);
    expect(fs.existsSync(during[0].dir)).toBe(false);
    // The directory is the visible half; a stale git registration outlives a reboot
    // and is what makes the next `worktree add` on the path fail confusingly.
    expect(execGit(fixture.repoPath, "worktree", "list")).not.toContain(`wt-${CARD}-r`);
  });

  it("tells Discord once, with the comment count", async () => {
    await reviewWithLiveChannel("x", async ({ port, token, send }) => {
      await send(port, token, { t: "review", body: "one", path: "src/greet.js", line: 1 });
      await send(port, token, { t: "review", body: "two", path: "src/greet.js", line: 2 });
      await send(port, token, { t: "review", body: "the summary" });
    });

    const posted = sends.filter(
      (e) => (e as { data?: { title?: string } }).data?.title === "🔍 Review posted"
    );
    expect(posted).toHaveLength(1);
    const fields = (posted[0] as { data: { fields: { name: string; value: string }[] } }).data.fields;
    expect(fields.find((f) => f.name === "Comments")?.value).toBe("2");
  });
});

describe("the container the reviewer runs in", () => {
  let probes = 0;

  /**
   * Each call gets its *own* head commit. Reusing `headSha` would make the second
   * call a duplicate of the first, and `reviewPr` would correctly refuse to run a
   * container — so a test that calls this twice would be asserting on `undefined`.
   */
  async function optionsFor(): Promise<Record<string, unknown>> {
    probes += 1;
    const sha = commitOnBranch(`src/probe${probes}.js`, `// probe ${probes}\n`);
    const runContainer = vi.fn(async () => ({ ok: true, text: "s" }) as AgentRunResult);
    await reviewPr(CARD, prRef(sha), {
      store,
      github,
      bot,
      runContainer: runContainer as unknown as NonNullable<ReviewDeps["runContainer"]>,
    });
    expect(runContainer).toHaveBeenCalledTimes(1);
    return (runContainer as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock
      .calls[0][0];
  }

  it("gets the role's charter, its model and its denylist", async () => {
    const options = await optionsFor();

    expect(options.systemPrompt).toBe(ROLES.reviewer.systemPrompt);
    expect(options.excludeTools).toEqual(["edit", "write"]);
    expect(options.model).toBeUndefined();
  });

  it("loads the baked post_review extension and names its tool set as data", async () => {
    const options = await optionsFor();
    const env = options.extraEnv as Record<string, string>;

    expect(options.piExtensions).toEqual([POST_REVIEW_EXTENSION]);
    expect(env.FACTORY_ACTIVE_TOOLS).toBe(
      ["read", "grep", "find", "ls", "bash", "post_review"].join(",")
    );
  });

  /**
   * 2.1's boundary, restated for a role whose entire job is to make network calls
   * on someone's behalf. The reviewer's container must reach the *host*, never
   * GitHub: no token, no Trello key, no Discord key in its environment, and the only
   * credential in sight is a per-run IPC token that can do one thing.
   */
  it("is handed no credential but a single-use review token", async () => {
    const options = await optionsFor();
    const env = options.extraEnv as Record<string, string>;

    expect(Object.keys(env).sort()).toEqual([
      "FACTORY_ACTIVE_TOOLS",
      "FACTORY_IPC_HOST",
      "FACTORY_IPC_PORT",
      "FACTORY_IPC_TOKEN",
      "FACTORY_REVIEW_TIMEOUT_MS",
    ]);
    for (const key of ["GITHUB_TOKEN", "TRELLO_API_KEY", "TRELLO_TOKEN", "DISCORD_BOT_TOKEN"]) {
      expect(env, key).not.toHaveProperty(key);
    }
    expect(env.FACTORY_IPC_TOKEN).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it("is named after the card and the short head, and killed on that name", async () => {
    const options = await optionsFor();

    // The container is named after the head under review, not after `main`.
    expect(String(options.containerName)).toMatch(new RegExp(`^factory-review-${CARD}-[0-9a-f]{7}$`));
    expect(typeof options.timeoutMs).toBe("number");
  });

  it("is given the review checkout and its shared git dir, read-only by the caller", async () => {
    const options = await optionsFor();

    expect(String(options.dir)).toMatch(new RegExp(`wt-${CARD}-r[0-9a-f]{7}$`));
    expect(String(options.gitDir)).toContain(".git");
  });

  it("gets the host-gateway mapping only when the deployment asks for it", async () => {
    expect((await optionsFor()).addHosts).toEqual([]);

    vi.stubEnv("FACTORY_IPC_ADD_HOST", "host.docker.internal:host-gateway");
    const withHost = await optionsFor();
    expect(withHost.addHosts).toEqual(["host.docker.internal:host-gateway"]);
  });
});

describe("what the host refuses to post", () => {
  it("refuses a path that is not in the diff, and tells the reviewer what is", async () => {
    let reason = "";
    await reviewWithLiveChannel("x", async ({ port, token, send }) => {
      const reply = await send(port, token, {
        t: "review",
        body: "notebook leak",
        path: "notebooks/experiment.ipynb",
        line: 1,
      });
      reason = String(reply.summary);
      expect(reply).toMatchObject({ ok: false, status: "rejected" });
    });

    expect(reason).toContain("not in this diff");
    expect(reason).toContain("src/greet.js");
    // Nothing reached the PR as a comment. A summary may still land — the run
    // finished, and its text is a review — but a refused finding must not.
    expect(ghCalls.filter((c) => c.kind === "comment")).toEqual([]);
  });

  /**
   * A comment past the end of the file is accepted by GitHub's API and then sits on
   * the PR pointing at nothing. The only defence is the file's real length at the
   * reviewed commit.
   */
  it("refuses a line beyond the end of the file", async () => {
    let reason = "";
    await reviewWithLiveChannel("x", async ({ port, token, send }) => {
      const reply = await send(port, token, {
        t: "review",
        body: "way down",
        path: "src/greet.js",
        line: 999,
      });
      reason = String(reply.summary);
    });

    expect(reason).toMatch(/has 4 lines, so line 999 does not exist/);
    expect(ghCalls.filter((c) => c.kind === "comment")).toEqual([]);
  });

  /**
   * `docs/extra.md` is in the diff — deleted by the PR — but has no new version for a
   * `side: RIGHT` comment to attach to. Distinguishing this from "not in the diff" is
   * what makes the refusal actionable.
   */
  it("refuses a line comment on a file the PR deleted", async () => {
    let reason = "";
    await reviewWithLiveChannel("x", async ({ port, token, send }) => {
      const reply = await send(port, token, {
        t: "review",
        body: "this line was removed",
        path: "docs/extra.md",
        line: 2,
      });
      reason = String(reply.summary);
    });

    expect(reason).toContain("does not exist in the reviewed commit");
    expect(ghCalls.filter((c) => c.kind === "comment")).toEqual([]);
  });

  it("counts line comments against a cap, without stopping the summary", async () => {
    vi.stubEnv("REVIEW_MAX_COMMENTS", "2");
    const outcome = await reviewWithLiveChannel(
      "the summary after the cap",
      async ({ port, token, send }) => {
        for (const line of [1, 2, 3, 4]) {
          await send(port, token, { t: "review", body: `n${line}`, path: "src/greet.js", line });
        }
        const summary = await send(port, token, { t: "review", body: "the summary" });
        expect(summary).toMatchObject({ ok: true });
      }
    );

    const comments = ghCalls.filter((c) => c.kind === "comment");
    expect(comments).toHaveLength(2);
    expect(ghCalls.filter((c) => c.kind === "review")).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "posted", comments: 2 });
  });

  it("refuses a second summary rather than posting two reviews", async () => {
    await reviewWithLiveChannel("x", async ({ port, token, send }) => {
      expect(await send(port, token, { t: "review", body: "first summary" })).toMatchObject({
        ok: true,
      });
      const second = await send(port, token, { t: "review", body: "second summary" });
      expect(second).toMatchObject({ ok: false, status: "rejected" });
      expect(String(second.summary)).toContain("already has a summary");
    });

    expect(ghCalls.filter((c) => c.kind === "review")).toHaveLength(1);
  });

  it("refuses a half-specified finding instead of guessing at it", async () => {
    await reviewWithLiveChannel("x", async ({ port, token, send }) => {
      const noLine = await send(port, token, { t: "review", body: "b", path: "src/greet.js" });
      expect(noLine).toMatchObject({ ok: false });
      const noPath = await send(port, token, { t: "review", body: "b", line: 2 });
      expect(noPath).toMatchObject({ ok: false });
    });

    // Neither half-specifying a finding posts anything, and neither spends a comment
    // slot: the reason the reply has to name the mistake is that the model is the
    // only party that can correct it.
    expect(ghCalls.filter((c) => c.kind === "comment")).toEqual([]);
    expect(store.reviewFor(PR, headSha)?.comments).toBe(0);
  });

  /**
   * The reviewer is not an orchestrator. A frame asking the host to start a child
   * container arrives on a channel with no spawn handler, and the answer has to be
   * the same shape as any other unknown request — not "valid token, wrong role".
   */
  it("will not spawn anything, whatever it sends", async () => {
    await reviewWithLiveChannel("x", async ({ port, token, send }) => {
      const reply = await send(port, token, { t: "spawn", role: "coder", task: "do it" });
      expect(reply).toMatchObject({ ok: false });
      expect(String(reply.error)).toContain("unknown request type");
    });
  });

  it("rejects a frame with the wrong token", async () => {
    await reviewWithLiveChannel("x", async ({ port, send }) => {
      const reply = await send(port, 1234 as unknown as string, {
        t: "review",
        body: "someone else's review",
      } as Record<string, unknown>);
      expect(reply).toMatchObject({ ok: false, error: "invalid token" });
    });
  });
});

describe("de-duplication, budget and closed pull requests", () => {
  it("runs one container for the first delivery and none for a duplicate", async () => {
    const runContainer = containerReturning("summary");

    const first = await reviewPr(CARD, prRef(), { store, github, bot, runContainer });
    expect(first.status).toBe("posted");
    expect(runContainer).toHaveBeenCalledTimes(1);

    const second = await reviewPr(CARD, prRef(), { store, github, bot, runContainer });

    expect(second).toMatchObject({ status: "skipped", reason: "this head was already posted" });
    // The count, not the outcome, is the assertion: a skipped review that still
    // started a container has spent the money the guard exists to save.
    expect(runContainer).toHaveBeenCalledTimes(1);
    expect(store.countReviews(CARD)).toBe(1);
  });

  it("refuses a second review of the same head while the first is still running", async () => {
    // The row is what blocks it, and it is written before the container starts —
    // with a reviewer that posts as it works, a mid-run duplicate would post twice.
    store.startReview({ prNumber: PR, cardId: CARD, headSha, maxPerCard: 5 });
    const runContainer = containerReturning("summary");

    const outcome = await reviewPr(CARD, prRef(), { store, github, bot, runContainer });

    expect(outcome).toMatchObject({ status: "skipped", reason: "this head was already running" });
    expect(runContainer).not.toHaveBeenCalled();
  });

  /**
   * Three real commits on the PR branch, a cap of two: the first two each start a
   * container, the third is refused before one exists. The count of *containers* is
   * the assertion — an outcome list alone would also be produced by a guard that ran
   * the model and then threw its result away.
   */
  it("reviews each new head a card pushes, and stops at the per-card budget", async () => {
    vi.stubEnv("REVIEW_MAX_RUNS_PER_CARD", "2");
    const second = commitOnBranch("src/two.js", "// two\n");
    const third = commitOnBranch("src/three.js", "// three\n");
    const runContainer = containerReturning("summary");

    const outcomes = [];
    for (const sha of [headSha, second, third]) {
      outcomes.push(await reviewPr(CARD, prRef(sha), { store, github, bot, runContainer }));
    }

    expect(outcomes.map((o) => o.status)).toEqual(["posted", "posted", "skipped"]);
    expect(outcomes[2].reason).toContain("review budget");
    expect(runContainer).toHaveBeenCalledTimes(2);
    expect(store.countReviews(CARD)).toBe(2);
  });

  it("skips a PR that closed before the container started, without running one", async () => {
    prState = { ...prState, state: "closed" };
    const runContainer = containerReturning("summary");

    const outcome = await reviewPr(CARD, prRef(), { store, github, bot, runContainer });

    expect(outcome).toMatchObject({ status: "skipped", reason: /is closed, not open/ });
    expect(runContainer).not.toHaveBeenCalled();
    expect(store.reviewFor(PR, headSha)?.status).toBe("skipped");
    expect(ghCalls).toEqual([]);
  });

  /**
   * The DoD line: no review posts to a closed PR. A PR can close *during* a review,
   * which is minutes long, so the check has to be per post and not only at the top.
   */
  it("stops posting when the PR closes mid-review", async () => {
    const outcome = await reviewWithLiveChannel(
      "a late summary, which must not be posted either",
      async ({ port, token, send }) => {
        const first = await send(port, token, { t: "review", body: "one", path: "src/greet.js", line: 1 });
        expect(first).toMatchObject({ ok: true });
        prState = { ...prState, state: "closed" };
        const second = await send(port, token, { t: "review", body: "two", path: "src/greet.js", line: 2 });
        expect(second).toMatchObject({ ok: false, status: "rejected" });
      }
    );

    // One comment landed, and *nothing* after the close — including the fallback
    // summary. "Never lost" must not quietly outrank "never to a closed PR".
    expect(ghCalls.filter((c) => c.kind === "comment")).toHaveLength(1);
    expect(ghCalls.filter((c) => c.kind === "review")).toHaveLength(0);
    // The outcome is still `posted`, and correctly so: a finding did reach the PR.
    // The honest record is what landed, not what the review intended to do.
    expect(outcome).toMatchObject({ status: "posted", comments: 1, summaryPosted: false });
    expect(store.reviewFor(PR, headSha)).toMatchObject({ status: "posted", comments: 1 });
  });
});

describe("a review is never lost", () => {
  /**
   * The failure this pins is the silent one: a model that writes its findings into
   * its answer instead of calling the tool has done the work, and a reviewer that
   * reports success having posted nothing teaches nobody anything.
   */
  it("posts the run's own text as the summary when the reviewer used no tool", async () => {
    const runContainer = containerReturning("## Review\n\n`greet` never validates `name`.");

    const outcome = await reviewPr(CARD, prRef(), { store, github, bot, runContainer });

    expect(outcome).toMatchObject({ status: "posted", comments: 0, summaryPosted: true });
    expect(ghCalls).toEqual([{ kind: "review", arg: "## Review\n\n`greet` never validates `name`." }]);
  });

  it("does not double-post when the tool already posted a summary", async () => {
    const outcome = await reviewWithLiveChannel(
      "the model repeated its summary in text",
      async ({ port, token, send }) => {
        await send(port, token, { t: "review", body: "the tool summary" });
      }
    );

    expect(outcome).toMatchObject({ status: "posted", summaryPosted: true });
    expect(ghCalls.filter((c) => c.kind === "review")).toHaveLength(1);
    expect(ghCalls[0].arg).toBe("the tool summary");
  });

  it("marks the review failed when the run failed and produced nothing", async () => {
    const runContainer = vi.fn(async () => ({
      ok: false,
      text: "agent process exited with code 137",
    })) as unknown as NonNullable<ReviewDeps["runContainer"]>;

    const outcome = await reviewPr(CARD, prRef(), { store, github, bot, runContainer });

    expect(outcome.status).toBe("failed");
    expect(store.reviewFor(PR, headSha)).toMatchObject({
      status: "failed",
      error: /exited with code 137/,
    });
    expect(ghCalls).toEqual([]);
  });

  it("marks the review failed and cleans up when the container throws", async () => {
    const runContainer = vi.fn(async () => {
      throw new Error("docker: command not found");
    }) as unknown as NonNullable<ReviewDeps["runContainer"]>;

    const outcome = await reviewPr(CARD, prRef(), { store, github, bot, runContainer });

    expect(outcome).toMatchObject({ status: "failed", reason: /docker: command not found/ });
    expect(store.reviewFor(PR, headSha)?.status).toBe("failed");
    expect(execGit(fixture.repoPath, "worktree", "list")).not.toContain(`wt-${CARD}-r`);
  });

  it("records a failure, not a crash, when the head cannot be checked out", async () => {
    const unobtainable = prRef("e".repeat(40));
    const runContainer = containerReturning("summary");

    const outcome = await reviewPr(CARD, unobtainable, { store, github, bot, runContainer });

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toMatch(/not available locally/);
    expect(runContainer).not.toHaveBeenCalled();
    expect(store.reviewFor(PR, unobtainable.headSha)?.status).toBe("failed");
  });

  it("leaves an empty diff skipped rather than reviewed", async () => {
    const wt = createWorktree("card-empty", fixture.repoPath);
    const sameAsMain = headCommit(wt.dir);
    const runContainer = containerReturning("summary");

    const outcome = await reviewPr("card-empty", prRef(sameAsMain), {
      store,
      github,
      bot,
      runContainer,
    });

    expect(outcome).toMatchObject({ status: "skipped", reason: /diff against origin\/main is empty/ });
    expect(runContainer).not.toHaveBeenCalled();
  });
});

describe("buildReviewPrompt", () => {
  it("names the card, the PR, the branch and the exact commit", () => {
    const prompt = buildReviewPrompt(prRef(), CARD_NAME);

    expect(prompt).toContain(CARD_NAME);
    expect(prompt).toContain(`#${String(PR)}`);
    expect(prompt).toContain(PR_URL);
    expect(prompt).toContain(`factory/${CARD}`);
    expect(prompt).toContain(headSha);
    expect(prompt).toContain(REVIEW_BASE_REF);
  });

  it("does not contain a token or an environment value", () => {
    vi.stubEnv("GITHUB_TOKEN", "secret-token-value");
    const prompt = buildReviewPrompt(prRef(), CARD_NAME);

    expect(prompt).not.toContain("secret-token-value");
  });
});
