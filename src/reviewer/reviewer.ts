/**
 * The PR reviewer (phase 2.3).
 *
 * One function, `reviewPr`, owns one review: claim the head SHA, check the PR out
 * detached, run the `reviewer` role in a container, post what it finds, tear the
 * checkout down. Everything it cannot do inside a container it does here, on the
 * host side of the 2.1 boundary — which is the whole reason this file exists:
 * `GITHUB_TOKEN` never enters a container, so the model can only ask.
 *
 * Three things about the shape are load-bearing, and each is a decision the code
 * would otherwise quietly reverse:
 *
 * 1. **The reviewer posts through a tool, over `src/agents/ipc.ts`.** Not through
 *    a JSON block parsed out of its final message. A run that times out having
 *    read the whole diff would otherwise post nothing; posted-as-it-goes, whatever
 *    it found is already on the PR.
 * 2. **Reviews live in their own table, not in `agent_runs`.** `countRuns` is the
 *    `MAX_AGENT_RUNS` budget, and a push to a PR is not a graph child — writing
 *    review rows there would let a noisy branch spend a coder's budget and starve
 *    the card. Reviews get their own budget (`REVIEW_MAX_RUNS_PER_CARD`) and their
 *    own usage columns instead.
 * 3. **The dedupe row is written before the container starts.** The reviewer can
 *    post mid-run, so a duplicate delivery that arrives while the first is still
 *    working would post the same finding twice. A check after the fact is a check
 *    that always arrives too late.
 */
import { IPC_ENV } from "../agents/spawn.js";
import { POST_REVIEW_TOOL, ROLES } from "../agents/roles.js";
import { MAX_REVIEW_BODY_CHARS, createIpcServer, createIpcToken, type IpcServer } from "../agents/ipc.js";
import { runAgentInContainer } from "../agent/container.js";
import type { AgentRunResult } from "../agent/types.js";
import { config } from "../config.js";
import { github as defaultGithub } from "../github/client.js";
import { progressEmbed, reviewPostedEmbed } from "../discord/embeds.js";
import type { DiscordBot } from "../discord/bot.js";
import { store as defaultStore, type Store } from "../state/store.js";
import {
  changedFiles as gitChangedFiles,
  commonGitDir,
  createReviewWorktree,
  fileLineCount,
  headCommit,
  removeReviewWorktree,
  type ReviewWorktree,
} from "../worker/worktree.js";

/** The reviewer's tool, baked into the agent image beside `spawn-agent.ts`. */
export const POST_REVIEW_EXTENSION = "/opt/factory/extensions/post-review.ts";

/** Env name for the in-container tool's own wait limit — a POST, not a child run. */
export const REVIEW_TIMEOUT_ENV = "FACTORY_REVIEW_TIMEOUT_MS";

/** What the reviewer diffs against. Factory PRs are all `base: main`. */
export const REVIEW_BASE_REF = "origin/main";

/** The pull request, as the webhook describes it. */
export interface PullRequestRef {
  number: number;
  htmlUrl: string;
  headRef: string;
  headSha: string;
}

export interface ReviewOutcome {
  status: "posted" | "skipped" | "failed";
  /** Why it stopped, when it did not post: the store's refusal reason or a fault. */
  reason?: string;
  /** Line comments the host accepted and posted. */
  comments: number;
  summaryPosted: boolean;
}

/** Git and container seams, so the tests can hold the container still. */
export interface ReviewWorktreeOps {
  create: (cardId: string, prNumber: number, headSha: string) => ReviewWorktree;
  remove: (cardId: string, headSha: string) => void;
  /** Files the PR touched, against `REVIEW_BASE_REF`. */
  changed: (dir: string) => string[];
  /** Lines in a file as the reviewed commit has it, or null when it does not. */
  lines: (dir: string, file: string) => number | null;
  gitDir: (dir: string) => string;
  head: (dir: string) => string;
}

const defaultOps: ReviewWorktreeOps = {
  create: (cardId, prNumber, headSha) => createReviewWorktree(cardId, prNumber, headSha),
  remove: (cardId, headSha) => removeReviewWorktree(cardId, headSha),
  changed: (dir) => gitChangedFiles(dir, REVIEW_BASE_REF),
  lines: (dir, file) => fileLineCount(dir, file),
  gitDir: (dir) => commonGitDir(dir),
  head: (dir) => headCommit(dir),
};

export interface ReviewDeps {
  store?: Store;
  github?: typeof defaultGithub;
  bot?: DiscordBot;
  /** The container boundary — the same seam `runCardGraph` injects. */
  runContainer?: typeof runAgentInContainer;
  worktree?: ReviewWorktreeOps;
}

/**
 * What the reviewer is told, per PR. Its *behaviour* rules live in the role
 * charter (`src/agents/roles.ts`); this carries only the facts it cannot read off
 * the checkout: which card, which pull request, and where to start.
 */
export function buildReviewPrompt(pr: PullRequestRef, cardName: string): string {
  return `Review this pull request.

Card: ${cardName}
Pull request: #${String(pr.number)} — ${pr.htmlUrl}
Head branch: ${pr.headRef}
Commit under review: ${pr.headSha} (checked out; \`git rev-parse HEAD\` agrees)

The diff to review is \`${REVIEW_BASE_REF}...HEAD\`. Post findings with
\`${POST_REVIEW_TOOL}\` as you make them, and finish with a summary.`;
}

/**
 * One review, start to finish. Never throws: every failure path returns a
 * `failed`/`skipped` outcome and leaves a row saying so, because the caller is a
 * webhook that has already answered 200 and cannot report anything to GitHub.
 */
export async function reviewPr(
  cardId: string,
  pr: PullRequestRef,
  deps: ReviewDeps = {}
): Promise<ReviewOutcome> {
  const store = deps.store ?? defaultStore;
  const gh = deps.github ?? defaultGithub;
  const runContainer = deps.runContainer ?? runAgentInContainer;
  const worktree = deps.worktree ?? defaultOps;
  const maxComments = config.factory.reviewMaxComments;
  const headShort = pr.headSha.slice(0, 7);

  const skip = (reason: string): ReviewOutcome => ({
    status: "skipped",
    reason,
    comments: 0,
    summaryPosted: false,
  });

  const cardName = (deps.store ?? defaultStore).get(cardId)?.card_name ?? cardId;
  /**
   * Progress to Discord, one line per posted finding.
   *
   * Not `reportAgentEvent` from the runner: that is module-private and speaks in
   * `AgentEvent`s about graph children, and a review is neither. Every send is
   * awaited inside a try rather than chained with `.catch`, because a progress line
   * failing must be invisible, and chaining assumes `send` returned a promise — an
   * assumption a caller-supplied bot is not obliged to keep.
   */
  const report = async (text: string): Promise<void> => {
    if (!deps.bot) return;
    try {
      await deps.bot.send(progressEmbed(cardName, `[review] ${text}`));
    } catch (err) {
      console.error(`[review] discord send failed: ${message(err)}`);
    }
  };

  // ---- 1. Claim the head SHA. Nothing expensive happens before this. --------
  const claimed = store.startReview({
    prNumber: pr.number,
    cardId,
    headSha: pr.headSha,
    maxPerCard: config.factory.reviewMaxRunsPerCard,
  });
  if (!claimed.begin) {
    // Say the number, not just the category. "review budget for this card" reads
    // like a bug; "5 of 5" reads like a limit somebody set, which is what it is.
    const reason =
      claimed.reason === "budget"
        ? `review budget for this card is spent (${String(store.countReviews(cardId))} of ${String(
            config.factory.reviewMaxRunsPerCard
          )})`
        : `this head was already ${store.reviewFor(pr.number, pr.headSha)?.status ?? "reviewed"}`;
    console.log(`[review] skipped ${cardId} #${String(pr.number)}@${headShort}: ${reason}`);
    return skip(reason);
  }

  const finish = (
    status: ReviewOutcome["status"],
    extra: { reason?: string; comments: number; summaryPosted: boolean; usage?: AgentRunResult["usage"] }
  ): ReviewOutcome => {
    store.markReview(pr.number, pr.headSha, status, {
      ...(extra.reason ? { error: extra.reason } : {}),
      ...(extra.usage ? { usage: extra.usage } : {}),
    });
    return {
      status,
      ...(extra.reason ? { reason: extra.reason } : {}),
      comments: extra.comments,
      summaryPosted: extra.summaryPosted,
    };
  };

  let server: IpcServer | undefined;
  let checkedOut: ReviewWorktree | undefined;
  // What the reviewer has put on the PR so far, counted here rather than asked of
  // the store so a refusal and a success are distinguishable in the summary.
  const posted = { comments: 0, summary: false };
  let changed: string[] = [];

  try {
    // ---- 2. A disposable checkout of exactly this commit. -------------------
    checkedOut = worktree.create(cardId, pr.number, pr.headSha);
    // Belt and braces on the one thing the whole review depends on: if the
    // checkout is not sitting on the SHA the dedupe row names, every line number
    // the reviewer reports is wrong, silently, and on the wrong commit.
    if (worktree.head(checkedOut.dir) !== pr.headSha) {
      throw new Error(
        `review checkout is at ${worktree.head(checkedOut.dir)}, not ${pr.headSha}`
      );
    }
    changed = worktree.changed(checkedOut.dir);
    if (changed.length === 0) {
      return finish("skipped", {
        reason: "the diff against " + REVIEW_BASE_REF + " is empty",
        comments: 0,
        summaryPosted: false,
      });
    }

    // ---- 3. The host side of the reviewer's tool. ---------------------------
    const token = createIpcToken();
    /** Refuse a post, with the reason the model gets back. */
    const blocked = async (): Promise<{ ok: false; reason: string } | { ok: true }> => {
      const state = await readPr(gh, pr);
      if (!state.ok) return state;
      if (state.value.state !== "open") {
        return {
          ok: false,
          reason: "this pull request is closed, so the review stopped here",
        };
      }
      return { ok: true };
    };

    /** A PR that is not open any more, checked once before any money is spent. */
    const before = await readPr(gh, pr);
    if (!before.ok) {
      return finish("failed", {
        reason: before.reason,
        comments: 0,
        summaryPosted: false,
      });
    }
    if (before.value.state !== "open") {
      // The cheap refusal, and the one worth making: the webhook said this PR was
      // open minutes ago, and a container that reviews a closed PR costs a model run
      // to produce comments nobody will read.
      return finish("skipped", {
        reason: `the pull request is ${before.value.state}, not open`,
        comments: 0,
        summaryPosted: false,
      });
    }

    server = await createIpcServer({
      token,
      host: config.factory.ipcBind,
      port: config.factory.ipcPort,
      // Only `onReview`. An orchestrator's channel gets `onSpawn`; this one cannot
      // start containers, and `createIpcServer` refuses a request type it has no
      // handler for, so a compromised reviewer session cannot reach the spawn path
      // even with this run's token in hand.
      onReview: async (request) => {
        const allowed = await blocked();
        if (!allowed.ok) return { status: "rejected", summary: allowed.reason };
        if (request.path !== undefined && request.line !== undefined) {
          if (posted.comments >= maxComments) {
            // Cap checked here rather than in `blocked`, which the summary also
            // passes through: running out of line comments must not stop the
            // reviewer from saying what it concluded.
            return {
              status: "rejected",
              summary: `this review has reached its limit of ${String(maxComments)} line comments — put the rest in the summary`,
              posted: posted.comments,
              remaining: 0,
            };
          }
          const where = locateFinding(checkedOut!.dir, worktree, request.path, request.line, changed);
          if (!where.ok) {
            // Refused, not failed: the reason comes back to the model as a normal
            // tool result so it can move the finding or fold it into the summary.
            return {
              status: "rejected",
              summary: where.reason,
              posted: posted.comments,
              remaining: Math.max(maxComments - posted.comments, 0),
            };
          }
          await gh.postLineComment(pr.number, {
            path: request.path,
            line: request.line,
            body: request.body,
            commitId: pr.headSha,
          });
          posted.comments += 1;
          store.bumpReviewComment(pr.number, pr.headSha);
          void report(`comment on ${request.path}:${String(request.line)}`);
          return {
            status: "ok",
            summary: `posted on ${request.path}:${String(request.line)}`,
            posted: posted.comments,
            remaining: Math.max(maxComments - posted.comments, 0),
          };
        }
        // No path: the summary. One per review, and the store decides which call
        // wins, so a model that posts two gets a refusal rather than a second
        // review on the PR.
        if (!store.claimReviewSummary(pr.number, pr.headSha)) {
          return { status: "rejected", summary: "this review already has a summary" };
        }
        await gh.postReview(pr.number, request.body);
        posted.summary = true;
        void report("summary");
        return { status: "ok", summary: "summary posted" };
      },
    });

    // ---- 4. The reviewer itself, in a container. ----------------------------
    const role = ROLES.reviewer;
    const result = await runContainer({
      dir: checkedOut.dir,
      gitDir: worktree.gitDir(checkedOut.dir),
      prompt: buildReviewPrompt(pr, cardName),
      systemPrompt: role.systemPrompt,
      model: config.factory.reviewerModel || undefined,
      // The denylist covers the window before `session_start` applies
      // `FACTORY_ACTIVE_TOOLS`; the extension closes it for good. Both, because
      // `--tools` cannot express this set without taking `post_review` with it.
      excludeTools: role.excludeTools,
      piExtensions: [POST_REVIEW_EXTENSION],
      extraEnv: {
        [IPC_ENV.host]: "host.docker.internal",
        [IPC_ENV.port]: String(server.port),
        [IPC_ENV.token]: token,
        [IPC_ENV.activeTools]: (role.activeTools ?? []).join(","),
        [REVIEW_TIMEOUT_ENV]: String(config.factory.reviewTimeoutMs),
      },
      // The same mapping the orchestrator needs: without it the reviewer cannot
      // resolve the host at all on a Linux box, and every post fails.
      addHosts: config.factory.ipcAddHost ? [config.factory.ipcAddHost] : [],
      containerName: `factory-review-${cardId}-${headShort}`,
      timeoutMs: config.factory.reviewTimeoutMs,
      onTool: (toolName) => {
        void report(`tool: ${toolName}`);
      },
    });

    // ---- 5. A review is never lost. ---------------------------------------
    // The tool is the contract, but a model that wrote its findings into the
    // answer instead of posting them has still done the work. Post what it said as
    // the summary and let a reader have it, rather than reporting a clean run that
    // left nothing on the PR.
    //
    // Only for a run that *succeeded*. Without `result.ok` this fires on a failed
    // container too, and `runAgentInContainer` leads its text with the failure
    // reason — so the factory would post "agent process exited with code 137" on a
    // pull request as if it were a review. The error belongs in the store and the
    // log, which is where the `failed` branch below puts it.
    //
    // Through the same state check as everything else: skipping that guard is how
    // "the review is never lost" quietly becomes "the review is posted to a closed
    // PR", and the definition of done says it does not.
    if (result.ok && !posted.summary && result.text.trim()) {
      const stillOpen = await blocked();
      if (!stillOpen.ok) {
        console.log(`[review] ${cardId} #${String(pr.number)}: not posting the summary — ${stillOpen.reason}`);
      } else {
        const body = clampReviewBody(result.text);
        if (store.claimReviewSummary(pr.number, pr.headSha)) {
          try {
            await gh.postReview(pr.number, body);
            posted.summary = true;
          } catch (err) {
            console.error(`[review] could not post the fallback summary: ${message(err)}`);
          }
        }
      }
    }

    if (posted.summary || posted.comments > 0) {
      await announce(deps, pr, cardName, posted.comments);
    }

    if (!result.ok && !posted.summary && posted.comments === 0) {
      return finish("failed", {
        reason: `reviewer run failed: ${clampReviewBody(result.text)}`,
        comments: 0,
        summaryPosted: false,
        usage: result.usage,
      });
    }

    return finish(posted.summary || posted.comments > 0 ? "posted" : "failed", {
      ...(posted.summary || posted.comments > 0
        ? {}
        : { reason: "the reviewer posted nothing and left no text" }),
      comments: posted.comments,
      summaryPosted: posted.summary,
      usage: result.usage,
    });
  } catch (err) {
    const reason = message(err);
    console.error(`[review] ${cardId} #${String(pr.number)}@${headShort} failed: ${reason}`);
    return finish("failed", { reason, comments: posted.comments, summaryPosted: posted.summary });
  } finally {
    // Both cleanups run even when the container threw: a leaked detached
    // worktree is invisible until `git worktree list` is three entries long, and a
    // listener left open holds a port and a token that outlives the review.
    if (server) await server.close();
    if (checkedOut) worktree.remove(cardId, pr.headSha);
  }
}

/**
 * Read the PR, turning an API failure into a refusal rather than an exception.
 *
 * A post that cannot check the PR's state does not happen: GitHub's API goes red
 * often enough that "assume it is still open" would be the normal path, and the
 * thing being assumed is whether it is safe to write to a public repository.
 */
async function readPr(
  gh: typeof defaultGithub,
  pr: PullRequestRef
): Promise<{ ok: true; value: Awaited<ReturnType<typeof gh.getPullRequest>> } | { ok: false; reason: string }> {
  try {
    return { ok: true, value: await gh.getPullRequest(pr.number) };
  } catch (err) {
    return { ok: false, reason: `the factory could not read the pull request: ${message(err)}` };
  }
}

/**
 * Is this a place a comment can go?
 *
 * GitHub accepts a comment on any line of any file in the PR's history, so an
 * invented path or a line past the end of the file gets posted and then sits
 * there, pointing at nothing, under a bot's name. Checking against the real diff
 * and the real file is the whole difference between a review bot and a noise
 * machine. The line is against the *new* version, because that is the version the
 * comment is attached to (`side: RIGHT`).
 */
function locateFinding(
  dir: string,
  worktree: ReviewWorktreeOps,
  path: string,
  line: number,
  changed: string[]
): { ok: true } | { ok: false; reason: string } {
  if (!changed.includes(path)) {
    return {
      ok: false,
      reason: `${path} is not in this diff. Comment only on: ${changed.slice(0, 12).join(", ")}`,
    };
  }
  const lines = worktree.lines(dir, path);
  if (lines === null) {
    // A deleted file is in the diff but has no new version to attach a comment to.
    return { ok: false, reason: `${path} does not exist in the reviewed commit (a deleted file takes no line comment)` };
  }
  if (line > lines) {
    return { ok: false, reason: `${path} has ${String(lines)} lines, so line ${String(line)} does not exist in it` };
  }
  return { ok: true };
}

/** GitHub's own body limit is 65536 chars; the IPC frame caps at 60000. */
function clampReviewBody(text: string): string {
  if (text.length <= MAX_REVIEW_BODY_CHARS) return text;
  return `${text.slice(0, MAX_REVIEW_BODY_CHARS - 20)}\n\n[truncated by the factory]`;
}

/**
 * The one Discord message that is not progress: the review landed, here is how
 * much of it there was. A send failure is logged and dropped — Discord being down
 * must never read as a review that failed, because the comments are already on
 * the PR and a retry would post them again.
 */
async function announce(
  deps: ReviewDeps,
  pr: PullRequestRef,
  cardName: string,
  comments: number
): Promise<void> {
  if (!deps.bot) return;
  try {
    await deps.bot.send(reviewPostedEmbed(cardName, pr.htmlUrl, comments));
  } catch (err) {
    console.error(`[review] discord send failed: ${message(err)}`);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
