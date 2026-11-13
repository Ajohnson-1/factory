// Comment-resume watcher for the software factory (card 6ae89f208dab26fa65fe6b81).
// Pipeline spec: docs/factory.md ("Listening for human comments").
//
// Root cause this fixes: a human comments on an in-flight card whose headless
// scheduler run has ended (the stuck-Verify shape of card 6ae7941fdf19ee34c911f0ae
// — `[DEPLOY]` landed, the run died before Verify, a human asked "was going on
// with this card?" and nobody answered). The ask protocol only polls comments
// while a stage agent is ALIVE, so a dead run leaves the card invisible.
//
// Each tick (FACTORY_RESUME_POLL_MS → fallback FACTORY_POLL_MS → 15 s) this
// watcher examines the cards in the in-flight lists (Plan…Verify, needs-human
// excluded) and when a card's LATEST event (comment OR list-move — a human
// drag is an instruction to advance, same qualification rules) is
// human-authored, newer than the latest bot event, and newer than the
// per-card persisted watermark, it:
//   1. READS the comment (board state is the input),
//   2. RESPONDS with a visible `[RESUME]` ack comment,
//   3. RESUMES the pipeline: spawns a headless scheduler run seeded with the
//      card's CURRENT stage — never back to Plan. The stuck-Verify trap: a
//      card in Verify (or Deploy with the move pending) whose last stage tag
//      is `[DEPLOY]` with no `[VERIFY:*]` after it resumes at Verify.
// Guardrails (docs/factory.md): a pending `[ASK]` suppresses resume (silent
// watermark advance — the ask answer path owns the reply); a live run on the
// card dedups silently; no free concurrency slot leaves the watermark (retry
// next tick, at-least-once); `FACTORY_RESUME_MAX` resumes per card ends
// listening with a log line (never labels/moves). Ack-before-spawn with
// `ackSentFor` dedup: the human sees a response even if spawn then fails, and
// retries never spam comments. Bot identity via `getMe()` cached per process;
// identity lookup failure → fail-closed: skip the whole tick (ask-protocol
// philosophy). State persists at data/factory-comment-resume.json — the
// comment-id watermark makes resumes exactly-once across restarts.
//
// Dependency-injectable logic, the factory-done-ping.js pattern: every seam
// (trello client, spawnRun, isBusy, freeSlots, readState/writeState, sleep,
// log) defaults to the real thing and is faked in
// tests/factoryCommentResume.test.js — zero live Trello there. The tick logic
// itself never touches child processes directly; spawn is injected.
// runCommentResumeWatch NEVER rejects on internal errors: fetch/state/spawn
// failures are logged and retried next tick — service robustness over
// fast-fail.

import { mkdirSync, openSync, readFileSync, closeSync, renameSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as trello from './trello.js';
import { parseDotEnv } from './trello.js';
import { repoContextBlock, worktreeFor } from './factory-registry.js';
// Single stage → prompt-file source of truth, the crash tag, and the run-log
// tail helpers/caps (ESM cycle with the daemon is safe: every binding here is
// only dereferenced inside function bodies — buildResumePrompt,
// crashCommentText, decideCrashRecovery).
import {
  STAGE_SEED_LIST,
  CRASH_TAG,
  RESTART_TAG,
  CRASH_TAIL_LINES,
  CRASH_TAIL_CHARS,
  MAX_CRASH_COMMENT_CHARS,
  crashTail,
} from '../factory-daemon.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const fileEnv = parseDotEnv();

// Same private helper as factory-ask.js / factory-done-ping.js (reads process
// env then .env); kept local so factory-ask's export surface stays as-is.
function envNum(name, fallback) {
  const n = Number(process.env[name] || fileEnv[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const STATE_PATH = () => resolve(ROOT, 'data', 'factory-comment-resume.json');

/** Lists whose cards the watcher listens to (in-flight pipeline stages). */
const IN_FLIGHT_LISTS = ['Plan', 'Implement', 'Review', 'QA', 'Deploy', 'Verify'];

/** Stage/bookkeeping tags a BOT comment may open with (board contract). */
export const STAGE_TAGS = [
  '[PLAN]',
  '[IMPL]',
  '[REVIEW:APPROVE]',
  '[REVIEW:CHANGES]',
  '[REVIEW:VERIFY]',
  '[SEC:PASS]',
  '[SEC:FINDINGS]',
  '[QA:PASS]',
  '[QA:FAIL]',
  '[DEPLOY]',
  '[VERIFY:PASS]',
  '[VERIFY:FAIL]',
  '[ROLLBACK]',
  '[PROD-CLOSE]',
  '[ASK]',
  '[HUMAN]',
  '[RESUME]',
  '[DAEMON-CRASH]',
  '[DAEMON-RESTART]',
  '[METRICS]',
  // Blocking-checks gate verdicts (card 6ae9677239bb2697a13ea728;
  // docs/factory.md "Independent blocking checks"): posted by the daemon,
  // scheduler bookkeeping of the same class as [DEPLOY]/[DAEMON-CRASH]. The
  // comment-resume listener must recognize them as BOT bookkeeping comments
  // (never a resume trigger; latestStageTag reads them as pipeline
  // bookkeeping). tests/factoryCommentResume.test.js #33 is the mechanical
  // docs↔registry sync that requires this entry.
  '[CHECK:PASS]',
  '[CHECK:FAIL]',
];

/** Scheduler-bookkeeping tags — visible trail, NOT evidence of committed stage work. */
const BOOKKEEPING_TAGS = ['[ASK]', '[HUMAN]', '[RESUME]', '[DAEMON-CRASH]', '[DAEMON-RESTART]', '[METRICS]'];

/**
 * The verdict subset of `STAGE_TAGS`: tags that record a completed stage
 * decision ([PLAN]…[VERIFY:*], [ROLLBACK], [PROD-CLOSE]). [ASK]/[HUMAN]/
 * [RESUME]/[DAEMON-CRASH]/[DAEMON-RESTART]/[METRICS] are scheduler bookkeeping — a card whose
 * only comments are bookkeeping has committed NOTHING, so crash recovery
 * treats it like a fresh card (docs/factory.md "Auto-start daemon").
 */
export const STAGE_VERDICT_TAGS = STAGE_TAGS.filter((tag) => !BOOKKEEPING_TAGS.includes(tag));

/**
 * The daemon GATE verdicts (blocking-checks poller) — registered in
 * `STAGE_TAGS` above, and the only `STAGE_VERDICT_TAGS` members the DAEMON
 * itself posts rather than a stage agent. A gate verdict is bookkeeping
 * noise over a waiting human — NOT an answer and NOT pipeline progress — so
 * it NEVER supersedes a pending `[ASK]` (docs/factory.md "Independent
 * blocking checks": "a daemon gate verdict is bookkeeping noise, not
 * supersession"). The pending-ask supersede set (`verdictSupersedes`, shared
 * by `isAskPending` and `decideAskLift`) EXCLUDES these two for that
 * reason. The card-29 regression (card 6af623a7c8924f3e7df3c109,
 * 2026-11-12): a `[CHECK:PASS]` landing 9 s AFTER an approval `[ASK]`
 * superseded it under the old isAskPending set, so crash recovery resumed
 * the run under the human's feet — burning a crash retry AND forcing the
 * resumed run to re-post the identical `[ASK]`. `supersededApprovalAsk`
 * still counts gate verdicts (a gate FAIL did move the pipeline on — the
 * bounce is real stage progress for THAT report).
 */
export const DAEMON_GATE_TAGS = ['[CHECK:PASS]', '[CHECK:FAIL]'];

/**
 * True iff any comment opens with a stage VERDICT tag (case-insensitive).
 * Accepts raw strings or `{ data: { text } }` action items. Bookkeeping tags
 * alone never count — `hasStageVerdict([crashComment])` is false. Note this
 * matches `[PROD-CLOSE]` by literal prefix (unlike `isStageTagText`'s
 * hyphenated-token regex — same precedent as the daemon's crash filter).
 */
export function hasStageVerdict(comments) {
  return (Array.isArray(comments) ? comments : []).some((c) => {
    const text = textOf(c).trimStart().toUpperCase();
    return STAGE_VERDICT_TAGS.some((tag) => text.startsWith(tag));
  });
}

/**
 * Trailing CONSECUTIVE comments opening with `tag` — date-sorted newest-first
 * via the shared `newestFirst` ordering. ANY other comment between stops (a
 * stage verdict, a human reply, another tag) breaks the streak: stops with no
 * progress between them are what "the pipeline keeps dying in place" looks
 * like, while a card that keeps landing verdicts between stops is making
 * progress and never accumulates a streak.
 */
function countTagStreak(comments, tag) {
  let n = 0;
  for (const { c } of newestFirst(comments)) {
    if (!textOf(c).startsWith(tag)) break;
    n += 1;
  }
  return n;
}

/**
 * CONSECUTIVE trailing `[DAEMON-RESTART]` comments — the restart-stop storm
 * signal (daemon flap without progress). A card that self-deploys once an
 * evening never accumulates one.
 */
export function countRestartStops(comments) {
  return countTagStreak(comments, RESTART_TAG);
}

/**
 * CONSECUTIVE trailing `[DAEMON-CRASH]` comments — the crash-storm signal the
 * retry cap reads ([DAEMON-RESTART] breaks the streak: restart stops stay
 * invisible to the crash cap, card 6af1fa46fecb634350948a5d). CONSECUTIVE is
 * the whole point (card 6af623a7c8924f3e7df3c109, 2026-11-13): a healthy
 * 7-hour card posted verdicts between every crash, yet the LIFETIME total
 * spent the cap and parked its finished Done card `needs-human` with a crash
 * report on top of [VERIFY:PASS]. Progress between crashes resets the count;
 * only a card dying in place escalates to park.
 */
export function countConsecutiveCrashComments(comments) {
  return countTagStreak(comments, CRASH_TAG);
}

/**
 * True when `listName` names an OPEN pipeline stage (Plan…Verify). Ready/Done/
 * To Do/unknown lists are NOT in-flight: their cards have no committed stage
 * work in progress to resume.
 */
function isInFlightList(listName) {
  const name = String(listName ?? '').trim().toLowerCase();
  return IN_FLIGHT_LISTS.some((n) => n.toLowerCase() === name);
}

/**
 * Pure crash-recovery decision (card 6ae96770d68eed22d6069c6e — Factor 12:
 * resume from the log, never redo committed work). The daemon's crashed runs
 * (dispatch OR resume) ask the card itself what to do, in this order:
 *
 *  - `hold` (first)  — card NOT in-flight (Done / Ready / To Do / unknown /
 *               unreadable board state): log only, zero moves, zero labels.
 *               A card that LEFT the pipeline is finished or parked by a
 *               human — the crash cap NEVER parks it (card
 *               6af623a7c8924f3e7df3c109: a healthy [VERIFY:PASS] → Done
 *               arrival got a `[DAEMON-CRASH] park (Done)` + `needs-human`
 *               because the lifetime crash count outranked this check).
 *               An agent that exits non-zero AFTER moving the card to Done
 *               finished the contract; re-queuing that card would re-run a
 *               completed pipeline. A human drag back to Ready re-runs via
 *               the ordinary poll loop.
 *  - `park`   — `crashRetries` CONSECUTIVE trailing `[DAEMON-CRASH] comments
 *               (`countConsecutiveCrashComments` — any other comment between
 *               crashes, verdict or human reply, resets the count): needs-
 *               human where the card stands; no move, no spawn. Comment-
 *               derived counting keeps the cap surviving daemon restarts.
 *  - `resume` — a stage verdict exists AND the card sits in an open in-flight
 *               list: re-enter at `deriveResumeStage` — the stuck-Verify and
 *               `[ROLLBACK]`→Implement traps apply to crash recovery for free
 *               (worktree reuse, no Ready/Plan move; the run continues).
 *  - `requeue`— in-flight list, NO verdict yet: full Ready → Plan re-run —
 *               nothing is committed, so the fold loses nothing when it
 *               restarts (the reservation the old comment-resume exception
 *               made general).
 *  - `askPending` (card 6aebab9a65613358f4ca333a — D2) — caller passes the
 *               `isAskPending(comments)` verdict: a pending `[ASK]` means the
 *               card is WAITING ON A HUMAN, so hold (zero move, zero spawn)
 *               even mid-pipeline — a stage-aware resume would restart work
 *               under the human's feet while their answer is still owed.
 *               Evaluated AFTER the park cap so stall/ask loops still
 *               escalate to `needs-human` at the cap.
 *  - `restartStopped` (the self-deploy class, card 6af1fa46fecb634350948a5d)
 *               — caller passes `sigtermStopped(runLogText)`: the run died to
 *               a SIGTERM from the daemon's OWN (re)start (a `factory` run
 *               deploys by restarting the daemon it runs under, so this stop
 *               is EXPECTED). The crash cap is NEVER consulted — the card's
 *               historical crash comments must not park every future
 *               self-deploy; instead `countRestartStops` bounds the
 *               CONSECUTIVE-stop storm with the same `crashRetries` cap
 *               (daemon flap without progress → park like any other loop).
 *
 * @returns {{ mode: 'park'|'resume'|'requeue'|'hold', stage: string }}
 *   `stage` = resume target (or the current list name for park/hold, 'Plan'
 *   for requeue).
 */
export function decideCrashRecovery({ comments, listName, crashRetries = 2, askPending = false, restartStopped = false } = {}) {
  const name = String(listName ?? '').trim();
  // Finished / parked-by-a-human beats EVERYTHING — especially the park cap:
  // parking a card that already left the pipeline stamps needs-human on a
  // completed card (the card-29 Done park).
  if (!isInFlightList(name)) return { mode: 'hold', stage: name };
  if (restartStopped) {
    if (countRestartStops(comments) >= crashRetries) return { mode: 'park', stage: name };
    if (askPending) return { mode: 'hold', stage: name };
    if (!hasStageVerdict(comments)) return { mode: 'requeue', stage: 'Plan' };
    return { mode: 'resume', stage: deriveResumeStage({ listName: name, comments }) };
  }
  if (countConsecutiveCrashComments(comments) >= crashRetries) return { mode: 'park', stage: name };
  if (askPending) return { mode: 'hold', stage: name };
  if (!hasStageVerdict(comments)) return { mode: 'requeue', stage: 'Plan' };
  return { mode: 'resume', stage: deriveResumeStage({ listName: name, comments }) };
}

/**
 * The `[DAEMON-CRASH]` comment per recovery mode — first token stays
 * `CRASH_TAG`, so retry counting remains byte-compatible with the daemon's
 * comment filter (and survives daemon restarts). `requeue` keeps the
 * original wording byte-for-byte.
 *
 * Run-log tail (card 6ae96770782334e43c98b13d, Factor 9 — unified here so
 * BOTH cards' contracts ride one implementation): when `logText` yields a
 * non-empty `crashTail`, a "run log tail" section is appended after the
 * head (mirrors the [VERIFY:FAIL]-embeds-JSON precedent) and the assembled
 * comment is clamped to MAX_CRASH_COMMENT_CHARS, still keeping the tail's
 * end. Missing/empty/unreadable log text → exactly the exit-code-only head,
 * byte-identical — for EVERY mode. `restartStopped: true` renders the same
 * mode shapes under `RESTART_TAG` with "run stopped by SIGTERM (daemon
 * restart)" wording (the self-deploy class — invisible to the crash cap).
 * Park heads (card 6af60d6a85947225f6ed75a0) stay a cap record FIRST line
 * (the crash-cap filter reads the first token; metrics and every
 * `startsWith(CRASH_TAG)` logic unaffected) and gain human-facing lines:
 * a `needs you:` action second line, and — when `superseded` (from
 * `supersededApprovalAsk`) names a sha-keyed approval ask a verdict tag
 * superseded — a third sentence saying so. `superseded = null` (every other
 * mode, and park under a still-pending ask) leaves the head 2 lines.
 * TAILLESS exception (RC4 amendment, same card): `hold` +
 * `holdReason === 'ask-pending'` returns the HEAD ONLY — the Factor-9
 * run-log tail exists so a RESUMING run self-heals from failure text, and
 * this hold spawns no resume: the tail serves nobody while burying the
 * pending `[ASK]` the human must read.
 */
export function crashCommentText(code, prior, { mode = 'requeue', stage, crashRetries = 2, logPath = '', logText = '', holdReason = '', restartStopped = false, superseded = null } = {}) {
  const n = `${prior + 1}/${crashRetries + 1}`;
  // Restart-stops (self-deploy class) post under RESTART_TAG — invisible to
  // the crash cap — with the same mode shapes; crash wording stays byte-
  // identical (`prior`/`n` carry restart counts when restartStopped).
  const tag = restartStopped ? RESTART_TAG : CRASH_TAG;
  const death = restartStopped ? 'run stopped by SIGTERM (daemon restart)' : `run exited ${code}`;
  const unit = restartStopped ? 'restart' : 'crash';
  let head;
  if (mode === 'park') {
    head = `${tag} ${death} after ${prior} prior ${restartStopped ? 'restart-stop(s)' : 'crash(es)'}; parking needs-human where it stands${stage ? ` (${stage})` : ''}`;
    // Park speaks human (card 6af60d6a85947225f6ed75a0): the cap record stays
    // the FIRST line; the second line names the action so a parked card's
    // top-of-card comment is self-contained.
    head += `\nneeds you: reply anything (e.g. "resume") to restart at ${stage || 'the current stage'}.`;
    if (superseded) {
      head += `\nthe earlier approval ask for sha ${superseded.sha} was superseded by ${superseded.tag}; a fresh approval ask will follow the re-run.`;
    }
  } else if (mode === 'resume') {
    head = `${tag} ${death}; stage-aware resume at ${stage} (${unit} ${n})`;
  } else if (mode === 'hold' && holdReason === 'ask-pending') {
    // RC4 visibility (card 6aebab9a65613358f4ca333a): the pending [ASK] owns
    // the reply — this comment turns "waiting on a human" board-visible.
    head = `${tag} ${death}; a pending [ASK] owns the reply — left waiting on the human${stage ? ` (${stage})` : ''} (${unit} ${n})`;
  } else if (mode === 'hold') {
    head = `${tag} ${death}; card sits in ${stage || 'an unknown list'} — outside the in-flight pipeline, left untouched (${unit} ${n})`;
  } else {
    head = `${tag} ${death}; re-queueing to Ready (${unit} ${n})`;
  }
  // RC4 amendment (card 6af60d6a85947225f6ed75a0): the ask-pending hold is
  // HEAD ONLY — its run-log tail exists for RESUMING runs (Factor 9) and
  // this hold spawns no resume, so the tail serves nobody while burying the
  // pending `[ASK]`. Resume/requeue/park keep the tail unchanged (D2).
  if (mode === 'hold' && holdReason === 'ask-pending') return head;
  const tail = crashTail(logText);
  if (!tail) return head;
  const header = `\n\n--- run log tail (${logPath}, last ≤${CRASH_TAIL_LINES} lines / ≤${CRASH_TAIL_CHARS} chars) ---\n`;
  const room = MAX_CRASH_COMMENT_CHARS - head.length - header.length;
  if (tail.length <= room) return head + header + tail;
  return room > 0 ? head + header + tail.slice(-room) : head;
}

/**
 * True when `member` (a comment's memberCreator) is the bot account `bot`.
 * Prefer immutable member ids (usernames can be renamed); fall back to a
 * case-insensitive username compare; a member with neither usable id nor
 * username is treated as human (only fake clients produce such objects).
 * Local copy of factory-ask.js's private helper — same rationale as the
 * local envNum above: factory-ask's export surface stays untouched.
 */
function isBotMember(member, bot) {
  if (!member || !bot) return false;
  if (member.id != null && bot.id != null) return String(member.id) === String(bot.id);
  if (member.username != null && bot.username != null) {
    return String(member.username).toLowerCase() === String(bot.username).toLowerCase();
  }
  return false;
}

// Accepts a raw string OR an action/comment object (`{ data: { text } }`).
const textOf = (a) =>
  typeof a === 'string' ? a : String(a?.data?.text ?? a?.text ?? '');
const authorOf = (a) => a?.memberCreator?.fullName ?? a?.memberCreator?.username ?? 'unknown';
const msOf = (a) => Date.parse(a?.date ?? '');

/** Collapse a comment to a one-line quoted excerpt (bounded length). */
function excerptOf(text, max = 200) {
  const oneLine = textOf(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

/**
 * The first token of `text` when it is a known stage tag (e.g. '[DEPLOY]'),
 * else null. Tags match case-insensitively; the returned tag is canonical.
 */
export function isStageTagText(text) {
  const m = textOf(text).trim().match(/^\[([A-Z][A-Z0-9_]*(?::[A-Z0-9_]+)?)\]/i);
  if (!m) return null;
  const upper = `[${m[1].toUpperCase()}]`;
  return STAGE_TAGS.includes(upper) ? upper : null;
}

/** True when a bot comment opens with the `[ASK]` tag (blocking ask owns the reply). */
function isAskText(text) {
  return /^\[ASK\]/i.test(textOf(text).trim());
}

// Bracket-shape tag detection (NOT isStageTagText — its token regex never
// matches the hyphenated [DAEMON-CRASH]/[PROD-CLOSE]; same literal-prefix
// precedent as hasStageVerdict). Any bracketed tag = bot-side per the
// factory-context.js curator's rule; untagged = human.
const bracketTagOf = (text) =>
  textOf(text).trimStart().match(/^\[[A-Z0-9_.-]+(?::[A-Z0-9_.-]+)?\]/i)?.[0]?.toUpperCase() ?? null;

// Comments newest-first by parsed date; undated items sort last
// (NEGATIVE_INFINITY), ties keep Trello's order (input index). Shared by the
// pending-ask scans and supersededApprovalAsk — one ordering rule board-wide.
function newestFirst(comments) {
  return (Array.isArray(comments) ? comments : [])
    .map((c, i) => ({ c, i, ms: msOf(c) }))
    .sort((x, y) => {
      const xm = Number.isFinite(x.ms) ? x.ms : Number.NEGATIVE_INFINITY;
      const ym = Number.isFinite(y.ms) ? y.ms : Number.NEGATIVE_INFINITY;
      return ym - xm || x.i - y.i; // newest first; ties keep Trello's order
    });
}

/**
 * The still-UNANSWERED latest dated `[ASK]` entry (`{ c, i, ms }`) or null —
 * the shared core of `isAskPending` and `decideAskLift`. A later UNTAGGED
 * comment or `[HUMAN]` relay ANSWERS the ask; a later comment where
 * `supersedes(text)` holds supersedes it (the pipeline moved on); later
 * bookkeeping leaves it pending. Same-second comments after the ask do NOT
 * count (fail toward pending = fail toward zero-move). Undated latest ask →
 * null (undated = unprovable).
 */
function findPendingAsk(comments, supersedes) {
  const list = newestFirst(comments);
  const ask = list.find(({ c }) => isAskText(c));
  if (!ask || !Number.isFinite(ask.ms)) return null;
  for (const { c, ms } of list) {
    if (!Number.isFinite(ms) || ms <= ask.ms) continue;
    const tag = bracketTagOf(c);
    if (tag == null || tag === '[HUMAN]') return null; // human reply / relay answers the ask
    if (supersedes(c)) return null; // stage progress supersedes the ask
  }
  return ask;
}

// The single pending-ask supersede set (shared by `isAskPending` and
// `decideAskLift`): only AGENT stage verdicts move the pipeline on. DAEMON
// GATE verdicts ([CHECK:*]) are explicitly NOT supersession — the blocking-
// checks poller posts them regardless of the human's reply, and one landing
// above a live approval ask used to make crash recovery resume the run
// under the human's feet (the card-29 double-[ASK] + cap burn).
const verdictSupersedes = (c) => {
  const t = textOf(c).trimStart().toUpperCase();
  return STAGE_VERDICT_TAGS.some((tag) => t.startsWith(tag) && !DAEMON_GATE_TAGS.includes(tag));
};

/**
 * True when some comment opens with an AGENT stage VERDICT tag (gate verdicts
 * excluded, same set as `verdictSupersedes`) and is dated strictly after
 * `ms`. The healthy-handoff signal for crash recovery (D4 extension): a run
 * whose own section posted a verdict after its `# dispatch`/`# resume` header
 * ENDED ITS TURN ON PURPOSE — stage-aware resume continues it, but the exit
 * is a handoff, not a stall, and deserves no `[DAEMON-CRASH]` comment.
 * Undated comments never qualify (unprovable, same rule as `findPendingAsk`).
 */
export function agentVerdictAfterMs(comments, ms) {
  if (!Number.isFinite(ms)) return false;
  return (Array.isArray(comments) ? comments : []).some((c) => {
    if (!verdictSupersedes(c)) return false;
    const cm = msOf(c);
    return Number.isFinite(cm) && cm > ms;
  });
}

/**
 * True when a blocking `[ASK]` on this card is still UNANSWERED (D2, card
 * 6aebab9a65613358f4ca333a): the latest `[ASK]` comment exists and no later
 * comment answers or supersedes it. Authorship needs no `getMe` identity —
 * the board contract tags every bot comment (the ask protocol's degraded
 * fast-path and the `factory-context.js` curator use the same signal):
 * a later UNTAGGED comment or `[HUMAN]` relay ANSWERS the ask; a later AGENT
 * stage VERDICT tag supersedes it (the pipeline moved on) — daemon GATE
 * verdicts `[CHECK:*]` do NOT (bookkeeping noise, not supersession; the
 * card-29 double-[ASK] regression). Later `[ASK]`/`[RESUME]`/
 * `[DAEMON-CRASH]` bookkeeping leaves it pending (crash comments landing on a
 * waiting card must not erase the human's owed answer). Same-second comments
 * after the ask do NOT count as replies (fail toward pending = fail toward
 * zero-move). An undated latest `[ASK]` → false (undated = unprovable).
 * The crash-resume watcher (`decideCrashRecovery`'s `askPending`) and the
 * stall sweep both read this — one pending-ask definition on the board.
 */
export function isAskPending(comments) {
  return findPendingAsk(comments, verdictSupersedes) !== null;
}

/**
 * Ask-on-top invariant core (card 6af60d6a85947225f6ed75a0): when a pending
 * `[ASK]` is NOT the card's newest comment, return the ask's VERBATIM text —
 * re-posting is the only lift mechanism (a Trello comment EDIT does not
 * restamp or move it; API-verified 2026-11-12). Null when nothing should
 * post: no pending ask, answered/superseded, or the newest comment already
 * byte-equals the ask text (dedup, D5 — repeated lifts are impossible while
 * nothing newer lands). One supersede set board-wide (`verdictSupersedes`):
 * AGENT verdicts supersede — no lift; DAEMON gate verdicts never do (they
 * are exactly the bookkeeping noise the invariant lifts above).
 */
export function decideAskLift(comments) {
  const ask = findPendingAsk(comments, verdictSupersedes);
  if (!ask) return null;
  const askText = textOf(ask.c);
  const latest = newestFirst(comments).find(({ ms }) => Number.isFinite(ms));
  if (latest && textOf(latest.c) === askText) return null; // already top-of-card (D5)
  return askText;
}

/**
 * Lift the card's pending `[ASK]` top-of-card: fetch comments → decide →
 * re-post VERBATIM. `{ lifted: true }` when the re-post landed, `{ lifted:
 * false }` otherwise (no pending ask, deduped, or a failed read/post —
 * logged, NEVER rejects: the watch-loop's never-reject robustness; Trello
 * read-after-write lag degrades to "no lift this post, next bookkeeping post
 * retries" — the same never-reject retry class).
 */
export async function liftPendingAsk(cardId, { t = trello, log = console.log } = {}) {
  let comments;
  try {
    comments = await t.getCardComments(cardId);
  } catch (e) {
    log(`ask-lift comment fetch failed for ${cardId}: ${String(e?.message ?? e)} — next bookkeeping post retries`);
    return { lifted: false };
  }
  const askText = decideAskLift(comments);
  if (askText === null) return { lifted: false };
  try {
    await t.addComment(cardId, askText);
  } catch (e) {
    log(`ask-lift re-post failed for ${cardId}: ${String(e?.message ?? e)} — next bookkeeping post retries`);
    return { lifted: false };
  }
  return { lifted: true };
}

/**
 * The superseded sha-keyed approval ask (card 6af60d6a85947225f6ed75a0, the
 * card-28 shape: approval `[ASK]` quoting a sha → a later verdict tag moved
 * the pipeline on → park). Scans newest-first like `isAskPending`; then
 * walks comments NEWER than the latest dated `[ASK]` oldest-first: the first
 * UNTAGGED/`[HUMAN]` comment means a human ANSWERED → null; the first
 * `STAGE_VERDICT_TAGS` member (prefix match, INCLUDING `DAEMON_GATE_TAGS` —
 * a gate verdict moved the pipeline on too) supersedes → `{ sha, tag }` with
 * the sha read back out of the ask text (`approvalAskText` quotes it —
 * comments remain the only state; no sha in the ask → not an approval ask →
 * null). Bookkeeping tags (crash/restart/ask/resume/metrics) are skipped —
 * keep walking. Nothing newer → null (the ask is still pending).
 */
export function supersededApprovalAsk(comments) {
  const list = newestFirst(comments);
  const ask = list.find(({ c }) => isAskText(c));
  if (!ask || !Number.isFinite(ask.ms)) return null;
  const newer = list.filter(({ ms }) => Number.isFinite(ms) && ms > ask.ms).reverse(); // oldest-first walk
  for (const { c } of newer) {
    const tag = bracketTagOf(c);
    if (tag == null || tag === '[HUMAN]') return null; // a human answered the ask
    const text = textOf(c).trimStart().toUpperCase();
    const verdict = STAGE_VERDICT_TAGS.find((v) => text.startsWith(v));
    if (!verdict) continue; // bookkeeping — keep walking
    const m = textOf(ask.c).match(/\b[0-9a-f]{7,40}\b/i);
    return m ? { sha: m[0], tag: verdict } : null; // no sha → not an approval ask
  }
  return null; // nothing newer — the ask is still pending
}

/**
 * Pure trigger core — the qualification predicate, testable without IO.
 * `actions` = trello.js `getCardComments` items: `{ id, date, data.text,
 * memberCreator }`. `bot` = bot identity from `getMe()` (id and/or username);
 * unknown/null → ALWAYS null (fail-closed: we cannot tell our own comments
 * from a human's, so we never act). `watermark` = the card's persisted entry
 * (`{ lastCommentId }`) or null/absent.
 *
 * A comment qualifies ⇔ it is the card's LATEST comment (newest date;
 * same-second ties keep Trello's newest-first order), its author is a member
 * OTHER than the bot (id-preferred username-fallback compare), its date is
 * strictly after the latest bot-authored comment on the card, and its id is
 * NOT the card's watermark (`lastCommentId` — never re-act, across restarts).
 * The bot's own `[ASK]`/`[RESUME]` comments are excluded by the author rule
 * automatically.
 * → `{ id, date, text, author, latestBotText }` (latestBotText = trimmed text
 * of the latest bot comment or null — the poller's ask-guard reads it) or null.
 */
export function pickResumeTrigger(actions, { bot, watermark } = {}) {
  const botKnown = Boolean(bot && (bot.id != null || bot.username != null));
  if (!botKnown) return null; // fail-closed degraded mode
  // Newest first; undated comments to the tail; ties stable (Trello's own
  // newest-first order decides same-second comments).
  const list = (Array.isArray(actions) ? actions : [])
    .map((a, i) => ({ a, i, ms: msOf(a) }))
    .sort((x, y) => {
      const xm = Number.isFinite(x.ms) ? x.ms : Number.NEGATIVE_INFINITY;
      const ym = Number.isFinite(y.ms) ? y.ms : Number.NEGATIVE_INFINITY;
      return ym - xm || x.i - y.i;
    });
  if (!list.length) return null;
  const isBot = (a) => a?.memberCreator != null && isBotMember(a.memberCreator, bot);
  let lastBotMs = Number.NEGATIVE_INFINITY;
  let latestBotText = null;
  for (const { a, ms } of list) {
    if (!isBot(a)) continue;
    lastBotMs = Number.isFinite(ms) ? ms : 0;
    // A bot MOVE carries no trail text of its own — keep the latest bot
    // COMMENT's text (the ask guard reads stage tags, not move noise).
    const t = textOf(a).trim();
    if (t && latestBotText == null) latestBotText = t;
  }
  const latest = list[0];
  if (isBot(latest.a)) return null; // latest event is ours → nothing to answer
  if (latest.a.memberCreator == null) return null; // author unverifiable → fail-closed
  if (!Number.isFinite(latest.ms) || latest.ms <= lastBotMs) return null; // not after the last bot event
  const id = latest.a.id;
  if (!id || (watermark?.lastCommentId && id === watermark.lastCommentId)) return null; // already processed
  return {
    id,
    date: latest.a.date,
    text: textOf(latest.a).trim(),
    author: authorOf(latest.a),
    latestBotText,
    kind: latest.a.kind === 'move' ? 'move' : 'comment',
    listName: latest.a.listAfter ?? null,
  };
}

/**
 * One human MOVE event from a Trello `updateCard:idList` action: the watcher
 * reads comments and moves through the SAME qualification predicate
 * (`pickResumeTrigger`), so moves carry a synthesized trail text and the
 * destination list under `listAfter`. Human authorship is the token-holder
 * check the comments already use — the bot account (`ompbot`) makes every
 * scheduler move, a UI drag carries the draggee's member.
 */
export function moveEvent(move) {
  const before = String(move?.data?.listBefore?.name ?? '').trim();
  const after = String(move?.data?.listAfter?.name ?? '').trim();
  return {
    id: move?.id,
    date: move?.date,
    memberCreator: move?.memberCreator ?? null,
    kind: 'move',
    listAfter: after || null,
    data: { text: before ? `Moved the card from "${before}" to "${after}"` : `Moved the card to "${after}"` },
  };
}

/** Newest-first merge of comment items + raw move actions (undated to tail). */
export function mergeResumeEvents(comments, moves) {
  const msOfRaw = (x) => Date.parse(x?.date ?? '');
  const events = (Array.isArray(comments) ? comments : []).concat(
    (Array.isArray(moves) ? moves : []).map(moveEvent),
  );
  return events.sort((x, y) => {
    const xm = Number.isFinite(msOfRaw(x)) ? msOfRaw(x) : Number.NEGATIVE_INFINITY;
    const ym = Number.isFinite(msOfRaw(y)) ? msOfRaw(y) : Number.NEGATIVE_INFINITY;
    return ym - xm;
  });
}

/**
 * Latest stage-tagged comment among `comments`/`actions` (any `{date, data.text}`
 * items), newest-first with Trello-order tie-break → `{ tag, text, date }` or
 * null. Reads the card's pipeline trail the same way every stage agent does.
 */
export function latestStageTag(comments) {
  const list = (Array.isArray(comments) ? comments : [])
    .map((c, i) => ({ c, i, ms: msOf(c) }))
    .sort((x, y) => {
      const xm = Number.isFinite(x.ms) ? x.ms : Number.NEGATIVE_INFINITY;
      const ym = Number.isFinite(y.ms) ? y.ms : Number.NEGATIVE_INFINITY;
      return ym - xm || x.i - y.i;
    });
  for (const { c } of list) {
    const tag = isStageTagText(c?.data?.text ?? c?.text);
    if (tag) return { tag, text: textOf(c).trim(), date: c?.date ?? null };
  }
  return null;
}

/**
 * The stage the resumed run must re-enter at. Normally the card's current
 * list; the stuck-Verify trap: a card in Verify — or Deploy with the
 * contract's Verify move still pending — whose LAST stage tag is `[DEPLOY]`
 * (so no `[VERIFY:*]` ever followed) resumes at the Verify stage: the run
 * re-runs the REPO CONTEXT verify line (routed repo's deploy driver) and posts
 * `[VERIFY:PASS]`/`[VERIFY:FAIL]`
 * per the contract instead of replanning a finished implementation.
 * The rollback trap (card 6ae9676d2461fd41204b507e): a card in Verify/Deploy
 * whose LAST stage tag is `[ROLLBACK]` resumes at **Implement** — the
 * `[VERIFY:FAIL]` verdict and the last-known-good restore are both recorded,
 * so the pending action is the fix-forward bounce the dead run never
 * completed (the resumed run performs the bounce move, a legal scheduler
 * move). Pure; returns the list name unchanged for every other shape.
 */
export function deriveResumeStage({ listName, comments } = {}) {
  const name = String(listName ?? '').trim();
  const last = latestStageTag(comments);
  if (last?.tag === '[DEPLOY]' && /^(verify|deploy)$/i.test(name)) return 'Verify';
  if (last?.tag === '[ROLLBACK]' && /^(verify|deploy)$/i.test(name)) return 'Implement';
  return name;
}

/**
 * The `[RESUME]` ack comment (first token `[RESUME]` — the visible response
 * to the human; same scheduler-bookkeeping class as `[DAEMON-CRASH]`).
 */
export function ackCommentText(card, { stage, comment } = {}) {
  const head =
    comment?.kind === 'move'
      ? `[RESUME] Acknowledged — your move into "${comment.listName ?? stage}" resumes this card's pipeline at the ${stage} stage.`
      : `[RESUME] Acknowledged — resuming this card's pipeline at the ${stage} stage in response to your comment.`;
  return [
    head,
    comment?.kind === 'move'
      ? 'The move is taken as your instruction to continue the pipeline from the list you dragged the card into.'
      : `Your comment: "${excerptOf(comment?.text)}"`,
    'A scheduler run is starting at the card\'s current stage (no restart from Plan).',
  ].join('\n');
}

/**
 * Headless scheduler prompt for a stage-aware resume (mirrors buildRunPrompt
 * in factory-daemon.js). Forbids Ready/Plan moves, mandates worktree reuse,
 * quotes the human comment, and routes unresolvable continuations to `[ASK]`
 * without card moves.
 *
 * Crash recovery (card 6ae96770d68eed22d6069c6e) passes `crash` (the exit
 * code/signal string) instead of a human `comment`: the same resume contract
 * then reads the comment trail for the last stage verdict instead of quoting
 * a comment. Every other line is byte-identical across the two variants;
 * comment-resume callers pass no `crash` → prompt unchanged.
 *
 * FM-2 (§4.3): `repo` = a registry entry (scripts/lib/factory-registry.js
 * from config/factory-repos.json) — the resume then embeds the REPO CONTEXT
 * block (repoDir/worktree/bootstrap/deploy command lines) and the worktree
 * path resolves from the repo's `worktreeRoot`. Without `repo` the prompt is
 * byte-identical to the pre-multi-repo shape (the discord-bot default).
 */
export function buildResumePrompt(card, { stage, comment, crash, repo = null } = {}) {
  const s = String(stage ?? 'its current stage');
  const crashText = crash == null ? null : String(crash).trim();
  const wt = repo ? worktreeFor(repo, card.id) : `../discord-bot-factory-wt/${card.id}`;
  const repoContext = repo ? repoContextBlock(repo, { cardId: card.id }) : null;
  return [
    `You are the software factory scheduler RESUMING exactly one Trello card: ${card.id} "${card.name}".`,
    `Read docs/factory.md first and follow the board contract exactly, then run \`node scripts/factory.js context ${card.id} ${s.toLowerCase()}\` for the curated stage context — the raw trail (factory.js read) is audit-only.`,
    `The card currently sits in stage "${s}" — do NOT move the card back to Plan or Ready; it re-enters the pipeline at ${s}.`,
    crashText
      ? `The previous scheduler run exited abnormally (${crashText}) before completing this card — read the comment trail, find the last stage verdict, and continue from ${s}.`
      : comment?.kind === 'move'
        ? `A human just moved the card into the "${comment.listName ?? s}" list — that move is their instruction to advance: treat it as approval to proceed from ${s} (including past any pending [ASK] gate the drag clearly answers), read the comment trail for any open feedback, and address the newest human comment there.`
        : `A human just commented on the card — read it and address this comment (quoted): "${excerptOf(comment?.text)}"`,
    `Reuse the existing worktree and branch factory/${card.id} if present (git worktree at ${wt}) — never recreate it from master or redo committed work.`,
    `Continue the pipeline from ${s} per the contract (forward stage moves only: ${IN_FLIGHT_LISTS.join(' → ')} → Done).`,
    `When a stage spawns a subagent, its prompt MUST begin "Read docs/factory-prompts/<stage>.md and follow it as your authoritative role instructions (they override your harness role defaults)"; stage → file: ${STAGE_SEED_LIST}.`,
    `If the pipeline cannot continue, post an [ASK] comment asking the human — do NOT move the card.`,
    'Post every stage comment with node scripts/factory.js comment. Finish by printing the final card state.',
    ...(repoContext ? ['', repoContext] : []),
  ].join('\n');
}

/**
 * Pure list-scoped filter: cards sitting in one of `listIds` (the OPEN
 * in-flight list ids) WITHOUT the `needs-human` label. Ready/Done/To Do cards
 * never qualify (their lists are not in `listIds`); parked cards are never
 * fetched-for-comments by the poller.
 */
export function selectInFlight(cards, listIds) {
  const ids = listIds instanceof Set ? listIds : new Set(listIds ?? []);
  return (Array.isArray(cards) ? cards : []).filter(
    (c) => c && ids.has(c.idList) && !(c.labels ?? []).some((l) => l?.name === 'needs-human'),
  );
}

/** Real state reader → parsed state object, or null on missing/corrupt/unusable. */
function defaultReadState() {
  let state;
  try {
    state = JSON.parse(readFileSync(STATE_PATH(), 'utf8'));
  } catch {
    return null;
  }
  return state && typeof state === 'object' && state.cards && typeof state.cards === 'object'
    ? state
    : null;
}

/** Real state writer: mkdir -p data/, temp file + rename (atomic-ish). */
function defaultWriteState(state) {
  const file = STATE_PATH();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * CLI-standalone default spawn (the daemon injects its own spawnResumeRun so
 * resume runs register in the daemon's runs map/cap). Fire-and-forget headless
 * `omp` run with the same guards as factory-daemon's dispatch, logging to
 * data/factory-daemon/<card>.log. Resolves once the child exists; a spawn
 * error rejects (→ the tick logs it and retries next tick).
 */
function defaultSpawnRun(card, prompt) {
  const bin = process.env.FACTORY_OMP_BIN || fileEnv.FACTORY_OMP_BIN || 'omp';
  const argv = ['-p', '--auto-approve', '--max-time', process.env.FACTORY_MAX_TIME || fileEnv.FACTORY_MAX_TIME || '12h'];
  const maxCost = process.env.FACTORY_MAX_COST || fileEnv.FACTORY_MAX_COST || '100';
  if (maxCost) argv.push('--max-cost', maxCost);
  if (process.env.FACTORY_MODEL || fileEnv.FACTORY_MODEL) {
    argv.push('--model', process.env.FACTORY_MODEL || fileEnv.FACTORY_MODEL);
  }
  argv.push(prompt);
  const logDir = join(ROOT, 'data', 'factory-daemon');
  mkdirSync(logDir, { recursive: true });
  const fd = openSync(join(logDir, `${card.id}.log`), 'a');
  try {
    const child = spawn(bin, argv, { cwd: ROOT, stdio: ['ignore', fd, fd], env: process.env });
    child.on('error', () => {}); // post-spawn error: logged nowhere richer than the tick result
    return Promise.resolve(child);
  } finally {
    closeSync(fd);
  }
}

/**
 * Poll the in-flight lists forever (or exactly one cycle when `once`) and
 * resume cards whose latest comment is a pending human comment. Returns
 * `{ …totals }` after the `once` cycle (plus `ok: false` when the tick died
 * on fetch/identity); continuous mode never returns UNLESS `shouldStop`
 * flips — the loop then returns `{ ok: true, stopped: true, …totals }`
 * between ticks (same supervision contract as runDoneWatch; counts ACCUMULATE
 * across the ticks the run completed).
 *
 * `dryRun` = pure read: reports would-resume candidates (`wouldResume` +
 * `WOULD-RESUME` log lines) with ZERO board writes and ZERO state writes —
 * safe to run while the daemon watches the same board.
 *
 * Per qualifying card, in order: pending `[ASK]` → advance watermark silently
 * (the ask path owns the reply); live run (`isBusy`) → advance silently;
 * `resumes >= resumeMax` → log + advance silently; `freeSlots() < 1` → leave
 * the watermark, retry next tick; else ack-before-spawn (`ackSentFor` dedup)
 * then `spawnRun(card, buildResumePrompt(...))` — the watermark advances ONLY
 * on spawn success (at-least-once spawn, spam-free retry).
 * NEVER rejects on internal errors; `t`/`spawnRun`/`isBusy`/`freeSlots`/
 * `readState`/`writeState`/`sleep`/`log` are faked in tests.
 */
export async function runCommentResumeWatch({
  intervalMs = envNum('FACTORY_RESUME_POLL_MS', envNum('FACTORY_POLL_MS', 15_000)),
  resumeMax = envNum('FACTORY_RESUME_MAX', 5),
  once = false,
  dryRun = false,
  shouldStop = undefined,
  t = trello,
  board = undefined, // FM-2 §4.3: per-board pass; undefined = trello BOARD default (byte-identical today)
  repoFor = undefined, // FM-2 §4.3: (card) => registry repo entry for the resume prompt's REPO CONTEXT
  spawnRun = defaultSpawnRun,
  isBusy = () => false,
  freeSlots = () => Infinity,
  readState = defaultReadState,
  writeState = defaultWriteState,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
} = {}) {
  log(`[comment-resume] watching in-flight cards every ${intervalMs}ms${once ? ' (once)' : ''}${dryRun ? ' (dry-run)' : ''}, resume cap ${resumeMax}/card`);
  const stopped = () => shouldStop?.() === true;
  const empty = () => ({ checked: 0, resumed: 0, acked: 0, askSkipped: 0, busySkipped: 0, capSkipped: 0, wouldResume: [], pruned: [] });
  // Bot identity: undefined = unresolved (retry next tick), object = cached for
  // the whole process (one SUCCESSFUL getMe), null = permanently unusable.
  let bot;
  let last = empty();
  for (;;) {
    if (stopped()) return { ok: true, stopped: true, ...last };
    const counts = empty();
    let cards;
    const listNames = new Map(); // idList -> canonical in-flight list name
    const listIds = new Set();
    try {
      const lists = await t.getLists({ board });
      for (const l of lists ?? []) {
        if (l.closed) continue;
        const canonical = IN_FLIGHT_LISTS.find((n) => n.toLowerCase() === String(l.name).toLowerCase());
        if (canonical) {
          listIds.add(l.id);
          listNames.set(l.id, canonical);
        }
      }
      if (!listIds.size) throw new Error(`No open in-flight lists (${IN_FLIGHT_LISTS.join('/')}) on the board`);
      cards = await t.getBoardCards('id,name,idList,labels,url', { board });
      if (bot === undefined && typeof t.getMe === 'function') {
        try {
          const me = await t.getMe({ board });
          bot = me && (me.id != null || me.username != null) ? me : null;
        } catch (e) {
          // getMe failure costs one retry per tick and self-heals (ask-protocol
          // precedent), but the TICK is skipped while identity is unknown:
          // acting without it could mistake our own comment for a human's.
          log(`[comment-resume] bot identity unavailable (${String(e?.message ?? e)}); skipping tick`);
        }
      }
    } catch (e) {
      // Includes assertCreds() throws (missing TRELLO_KEY/TRELLO_TOKEN) and a
      // missing in-flight list: transient — log and try again next tick.
      log(`[comment-resume] poll failed: ${String(e?.message ?? e)}; skipping tick`);
      if (once) return { ok: false, ...counts };
      if (stopped()) return { ok: true, stopped: true, ...last };
      await sleep(intervalMs);
      continue;
    }
    if (!bot) {
      // Fail-closed: identity permanently unusable (or the getMe attempt above
      // failed / was unavailable) — never act on comment authorship blind.
      log('[comment-resume] bot identity unresolved — skipping tick (fail-closed)');
      if (once) return { ok: false, ...counts };
      if (stopped()) return { ok: true, stopped: true, ...last };
      await sleep(intervalMs);
      continue;
    }
    let state;
    try {
      state = readState();
    } catch (e) {
      log(`[comment-resume] state unreadable (${String(e?.message ?? e)}) — treating watermarks as absent`);
      state = null;
    }
    state = state && typeof state === 'object' && state.cards && typeof state.cards === 'object'
      ? state
      : { cards: {} };
    const persist = () => {
      if (dryRun) return;
      try {
        writeState(state);
      } catch (e) {
        log(`[comment-resume] state write failed: ${String(e?.message ?? e)}`);
      }
    };
    const entryFor = (cardId) => state.cards[cardId] ?? (state.cards[cardId] = {});
    for (const card of selectInFlight(cards, listIds)) {
      counts.checked += 1;
      let actions;
      try {
        actions = await t.getCardComments(card.id);
      } catch (e) {
        log(`[comment-resume] comment fetch failed for ${card.id}: ${String(e?.message ?? e)}; will retry`);
        continue;
      }
      // Human list-moves advance cards too (docs/factory.md "Listening for
      // human comments"): fetch `updateCard:idList` authorship-best-effort —
      // a move-fetch failure degrades to comment-only, never skips the card.
      let moves = [];
      if (typeof t.getCardMoves === 'function') {
        try {
          moves = await t.getCardMoves(card.id);
        } catch (e) {
          log(`[comment-resume] move fetch failed for ${card.id}: ${String(e?.message ?? e)}; comment-only this tick`);
        }
      }
      const events = mergeResumeEvents(actions, moves);
      const entry = state.cards[card.id] ?? null;
      const trigger = pickResumeTrigger(events, { bot, watermark: entry });
      if (!trigger) continue;
      const stage = deriveResumeStage({ listName: listNames.get(card.idList) ?? card.idList, comments: events });
      if (isAskPending(events)) {
        // An UNANSWERED ask owns the reply — advance the watermark SILENTLY so
        // the ask-answer path stays byte-for-byte. The answered case must NOT
        // be skipped here: the blocking `ask`/`wait` waiter lives inside a
        // spawned run, and a run that exits 0 mid-wait (card
        // 6ae9676d0ee4189387157881 — C-H4 risk-gate approval stranded in QA
        // for a day) takes the waiter to the grave with it, while
        // `latestBotText` still reads `[ASK]`. Keying on "is the ask still
        // unanswered" (isAskPending — the board's one pending-ask definition)
        // keeps the delegation for live waiters and resumes answered asks
        // whose waiter died; a LIVE waiter inside a daemon run is still
        // deduped by the isBusy guard below.
        const e = entryFor(card.id);
        e.lastCommentId = trigger.id;
        e.lastCommentDate = trigger.date;
        counts.askSkipped += 1;
        log(`[comment-resume] ${card.id}: pending [ASK] owns the reply — watermark advanced silently`);
        continue;
      }
      if (isBusy(card.id)) {
        // A live run owns the card (its own reads + the ask protocol cover it)
        // — dedup silently so comments arriving mid-run never double-answer.
        const e = entryFor(card.id);
        e.lastCommentId = trigger.id;
        e.lastCommentDate = trigger.date;
        counts.busySkipped += 1;
        log(`[comment-resume] ${card.id}: live run owns the card — watermark advanced silently`);
        continue;
      }
      if ((entry?.resumes ?? 0) >= resumeMax) {
        const e = entryFor(card.id);
        e.lastCommentId = trigger.id;
        e.lastCommentDate = trigger.date;
        counts.capSkipped += 1;
        log(`[comment-resume] ${card.id}: resume cap ${resumeMax} reached — ignoring further comments (log-only, card untouched)`);
        continue;
      }
      if (freeSlots() < 1) {
        // No concurrency slot: leave the watermark untouched → retry next tick
        // (at-least-once; the ack-dedup key stops comment spam on retries).
        log(`[comment-resume] ${card.id}: no free slot — resume deferred to next tick`);
        continue;
      }
      if (dryRun) {
        counts.wouldResume.push({ card: card.id, name: card.name, stage, comment: trigger.id, author: trigger.author });
        log(`WOULD-RESUME ${card.id} "${card.name}" at ${stage} (comment ${trigger.id} by ${trigger.author})`);
        continue;
      }
      try {
        // Ack BEFORE spawn: the human sees a response even if spawn then fails.
        const e = entryFor(card.id);
        if (e.ackSentFor !== trigger.id) {
          await t.addComment(card.id, ackCommentText(card, { stage, comment: trigger }));
          e.ackSentFor = trigger.id;
          counts.acked += 1;
          persist(); // persist the ack-dedup key BEFORE spawning (spam-free retry)
        }
        await spawnRun(card, buildResumePrompt(card, { stage, comment: trigger, repo: repoFor ? repoFor(card) ?? undefined : undefined }));
        e.lastCommentId = trigger.id;
        e.lastCommentDate = trigger.date;
        e.resumes = (e.resumes ?? 0) + 1;
        e.lastResumeAt = new Date().toISOString();
        e.lastResumeStage = stage;
        counts.resumed += 1;
        log(`RESUME ${card.id} "${card.name}" at ${stage}`);
      } catch (e) {
        // Spawn/ack failure: watermark NOT advanced → retry next tick; the
        // persisted ackSentFor (when the ack had landed) suppresses a re-ack.
        log(`[comment-resume] resume failed for ${card.id}: ${String(e?.message ?? e)}; will retry`);
      }
    }
    // Prune cards that vanished from the board fetch (bounds state growth).
    const present = new Set((Array.isArray(cards) ? cards : []).map((c) => c?.id));
    for (const id of Object.keys(state.cards)) {
      if (!present.has(id)) {
        delete state.cards[id];
        counts.pruned.push(id);
      }
    }
    persist();
    last = {
      checked: last.checked + counts.checked,
      resumed: last.resumed + counts.resumed,
      acked: last.acked + counts.acked,
      askSkipped: last.askSkipped + counts.askSkipped,
      busySkipped: last.busySkipped + counts.busySkipped,
      capSkipped: last.capSkipped + counts.capSkipped,
      wouldResume: [...last.wouldResume, ...counts.wouldResume],
      pruned: [...last.pruned, ...counts.pruned],
    };
    if (once) return { ok: true, ...last };
    if (stopped()) return { ok: true, stopped: true, ...last };
    await sleep(intervalMs);
  }
}
