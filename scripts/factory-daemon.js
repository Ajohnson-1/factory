#!/usr/bin/env node
// Auto-start daemon for the software factory (spec: docs/factory.md).
//
// Polls the Ready list on EVERY board in config/factory-repos.json (FM-2,
// docs/factory-migration.md §4.3); each arrival gets a headless `omp`
// scheduler run that drives the card Plan -> ... -> Done per the board
// contract. The daemon moves each card Ready -> Plan before spawning (the
// daemon is part of the scheduler; only the scheduler moves cards), which
// also makes restarts safe: a dispatched card is no longer in Ready to be
// double-picked. One global queue + one global `FACTORY_MAX_PARALLEL` cap
// across boards; a card whose `repo:` label cannot be resolved gets an
// `[ASK]` + `needs-human` and stays in Ready (fail-closed, zero spawn).
//
// Run interactively, or install as a launchd agent (RunAtLoad + KeepAlive)
// so work starts the moment you drag a card to Ready:
//
//   node scripts/factory-daemon.js install
//   node scripts/factory-daemon.js status
//   node scripts/factory-daemon.js uninstall
//
// `install` is safe to run from INSIDE a factory run (the usual ops-step
// restart): a detached bootstrap guard survives bootout's SIGTERM cascade and
// finishes the bootstrap even if this process is killed mid-flight.
//
// `run` also auto-starts and supervises the Done-list pinger (the
// `factory.js done-watch` poller) IN-PROCESS, so every Done arrival —
// scheduler move or UI drag, including drag-out-then-back-in — DMs the owner
// through the shared data/factory-done-ping.json dedup, with zero human
// ceremony. Do NOT also run `factory.js done-watch` by hand while the daemon
// runs: two live pollers can double-ping a race. See docs/factory.md
// "Pinging on Done".
//
// `run` likewise auto-starts and supervises the COMMENT-RESUME watcher (the
// `factory.js resume-watch` poller) IN-PROCESS: a human comment on an
// in-flight card whose run has died gets a `[RESUME]` ack and a headless
// scheduler run seeded at the card's CURRENT stage (never back to Plan),
// deduped via data/factory-comment-resume.json watermarks. Do NOT also run
// `factory.js resume-watch` by hand while the daemon runs (a concurrent tick
// can double-spawn). See docs/factory.md "Listening for human comments".
//
// Crashed runs (dispatch OR resume) recover STAGE-AWARE, never via a blind
// Ready re-queue (docs/factory.md "Auto-start daemon"): `handleRunCrash`
// reads the card's own log — a stage verdict exists → respawn AT the card's
// current list with the reuse-the-worktree instruction; no verdict yet →
// full Ready re-run (nothing is committed yet); crash cap → needs-human
// where it stands; card already left the pipeline (Done etc.) → untouched.
// Committed work is never redone. A run that exits 0 WITHOUT advancing the
// card (dying at its --max-time cap while blocked on something outside
// itself) takes the SAME path with code 'stalled (exit 0 with no verdict)' —
// exit 0 is only silent when the card already left the pipeline (the Done
// arrival is pinged by done-watch) or a pending [ASK] owns the reply
// (hold + a visible waiting-on-you comment).
//
// `run` likewise auto-starts and supervises the STALL SWEEP (the
// `factory.js stall-sweep` poller) IN-PROCESS: a boot pass replaces the old
// log-only orphan-candidate loop, and every FACTORY_STALL_POLL_MS (default
// 5 min) the sweep recovers in-flight cards whose newest comment has been
// silent longer than FACTORY_MAX_TIME + 15 min through the SAME crash path
// (code `stalled (orphan, silent <n> min)`) — orphaned cards after a restart
// recover, not just get reported. A pending [ASK] or a latest human comment
// holds the sweep off the card (the human / comment watcher own those).
// Do NOT run a live `factory.js stall-sweep` by hand alongside the daemon
// (double-spawn); `--once --dry-run` is read-only and safe. See
// scripts/lib/factory-stall-sweep.js + docs/factory.md "Auto-start daemon".
//
// `run` also auto-starts and supervises the BLOCKING-CHECKS gate IN-PROCESS:
// for a card sitting in QA whose latest stage tag is `[QA:PASS]`, the daemon
// runs the blocking suite (`npm test`; `FACTORY_CHECK_CMD` override) ITSELF
// against the card's worktree tip — no LLM can skip it — and posts
// `[CHECK:PASS]`/`[CHECK:FAIL]`. A FAIL bounces the card to Implement and
// counts toward the 3-bounce rule, exactly like `[VERIFY:FAIL]`. The sha
// watermark in data/factory-blocking-checks.json makes checks exactly-once
// per worktree tip across restarts. See docs/factory.md "Independent
// blocking checks".
//
// Env (all optional):
//   FACTORY_POLL_MS       poll interval                (default 15000)
//   FACTORY_MAX_PARALLEL  concurrent card runs (cap)   (default 1 — internal-first canary; see docs/factory.md "Gradual rollout (internal-first)")
//   FACTORY_OMP_BIN       agent CLI to spawn           (default "omp")
//   FACTORY_MODEL         --model for headless runs    (default: omp default)
//   FACTORY_MAX_TIME      --max-time per run           (default 12h)
//   FACTORY_MAX_COST      --max-cost USD guard per run (default 100)
//   FACTORY_DONE_POLL_MS  Done-ping poll interval      (default: FACTORY_POLL_MS → 15000)
//   FACTORY_RESUME_POLL_MS comment-resume poll interval(default: FACTORY_POLL_MS → 15000)
//   FACTORY_RESUME_MAX    auto-resumes per card (guard)(default 5)
//   FACTORY_STALL_POLL_MS  stall-sweep poll interval   (default 300000)
//   FACTORY_STALL_SILENCE_MS stall silence window     (default FACTORY_MAX_TIME + 15 min)
//   FACTORY_CHECK_INTERVAL_MS blocking-checks gate poll interval (default: FACTORY_POLL_MS → 15000)
//   FACTORY_CHECK_CMD     blocking suite override (JSON array of [cmd,...args]; default [["npm","test"]])
import { execFile, execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as trelloLib from './lib/trello.js';
import { runDoneWatch } from './lib/factory-done-ping.js';
import { ensureBootstrapped, launchctl } from './lib/factory-launchd.js';
import { runCommentResumeWatch, buildResumePrompt, decideCrashRecovery, crashCommentText, isAskPending } from './lib/factory-comment-resume.js';
import { bootStallSweep, superviseStallSweep, runStallSweepWatch } from './lib/factory-stall-sweep.js';
import { runBlockingChecksWatch } from './lib/factory-blocking-checks.js';
import { askHuman } from './lib/factory-ask.js';
import { loadRegistry, boardIds, repoForCard, repoContextBlock, worktreeFor } from './lib/factory-registry.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = resolve(ROOT, 'data/factory-daemon');
const PID_FILE = join(STATE_DIR, 'daemon.pid');
export const LABEL = 'com.ajohnson.factory-daemon';
const PLIST_PATH = join(process.env.HOME ?? '', 'Library/LaunchAgents', `${LABEL}.plist`);

const [, , cmd = 'run', ...args] = process.argv;

export const CRASH_TAG = '[DAEMON-CRASH]';
export const MAX_CRASH_RETRIES = Number(process.env.FACTORY_CRASH_RETRIES || 2);
// D1 (card 6aebab9a65613358f4ca333a): a run that exits 0 without advancing
// its card is a STALL, not a success — it takes the same crash-recovery path
// under this code string instead of being silently ignored. handleRunCrash
// treats any code starting with 'stalled (' as stall-family for D4's
// healthy-path hold silence; non-zero codes/sig/'spawn-failed' keep posting
// their crash comments byte-for-byte.
export const STALL_EXIT_CODE = 'stalled (exit 0 with no verdict)';
/** The `code` string one child exit hands to crashRecovery. */
export function exitCodeStr(code, sig) {
  return code === 0 ? STALL_EXIT_CODE : code ?? sig ?? 'null';
}
/** True for stall-family codes (D1 exit-0 stalls + D3 sweep orphans). */
export function isStallCode(code) {
  return typeof code === 'string' && code.startsWith('stalled (');
}
// Caps for the run-log tail embedded in [DAEMON-CRASH] comments (Factor 9:
// the retrying run must see the failure text, not just an exit code).
export const CRASH_TAIL_LINES = 40;
export const CRASH_TAIL_CHARS = 4000;
// Trello rejects comments >16,384 chars; margin keeps the defensive clamp safe.
export const MAX_CRASH_COMMENT_CHARS = 16000;

// ---------------------------------------------------------------------------
// Pure logic (unit-tested in tests/factoryDaemon.test.js)
// ---------------------------------------------------------------------------

/**
 * Last ≤maxLines lines / ≤maxChars chars of a run log, newest content first.
 * The crash output of a headless run sits at the END of the log, so the tail
 * IS the error context; no `/error/i` filter — deterministic and boring beats
 * a heuristic that silently drops stack traces lacking the word "error".
 * A char trim keeps the newest end, prefixed with `… (trimmed)`.
 * @param {string} text full run-log text (may be huge)
 * @returns {string} tail, or '' for empty/whitespace-only input
 */
export function crashTail(text, { maxLines = CRASH_TAIL_LINES, maxChars = CRASH_TAIL_CHARS } = {}) {
  if (!text || !text.trim()) return '';
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const kept = lines.slice(-maxLines).join('\n');
  return kept.length > maxChars ? `… (trimmed)${kept.slice(-maxChars)}` : kept;
}

// The [DAEMON-CRASH] comment builder itself lives in the stage-aware resume
// lib (single coherent implementation — C-M5's decideCrashRecovery modes
// render the head, C-M4's run-log tail above is appended by it via the
// `crashTail`/cap imports documented in the lib header's ESM-cycle note).
// Re-exported here so the daemon keeps its public helper surface.
export { crashCommentText };

/**
 * Decide which Ready cards to dispatch this tick (FM-2: multi-board —
 * `queued`/`ready` are `{board, cardId}` entries, one per Ready card on
 * every registered board; the cap stays GLOBAL: `FACTORY_MAX_PARALLEL`
 * bounds total in-flight runs ACROSS boards, docs/factory-migration.md §4.3).
 * @param {Array<{board: string, cardId: string}>} queued  entries waiting from previous ticks (arrival order)
 * @param {Array<{board: string, cardId: string}>} ready   entries currently in the Ready lists (board order, boards in registry order)
 * @param {Set<string>} inFlight card ids with a live agent run (ids are globally unique on Trello)
 * @param {number} cap        max concurrent runs across all boards
 * @returns {{queue: Array<{board: string, cardId: string}>, dispatch: Array<{board: string, cardId: string}>}} new waiting queue, entries to start now
 *
 * Invariants (unchanged, now per-board): queued entries keep their place and
 * drop out only when their card leaves its Ready list (cancel — the SAME
 * card id on another board is a different entry); running cards are never
 * re-dispatched; dispatch never exceeds the free slots under the global cap.
 */
export function planDispatch(queued, ready, inFlight, cap) {
  const key = (e) => `${e.board}/${e.cardId}`;
  const readySet = new Set(ready.map(key));
  const kept = queued.filter((e) => readySet.has(key(e)) && !inFlight.has(e.cardId));
  const keptSet = new Set(kept.map(key));
  const queuedSet = new Set(queued.map(key));
  const fresh = ready.filter((e) => !keptSet.has(key(e)) && !inFlight.has(e.cardId) && !queuedSet.has(key(e)));
  const queue = [...kept, ...fresh];
  const slots = Math.max(0, cap - inFlight.size);
  const dispatch = queue.slice(0, slots);
  return { queue: queue.slice(dispatch.length), dispatch };
}

/**
 * Repo-owned stage prompt documents (docs/factory-prompts/, card
 * 6ae9676f557d52cce856d1a4): every stage subagent is seeded to read its
 * document as authoritative role instructions. Single stage → file
 * source of truth so buildRunPrompt, the resume prompt, docs/factory.md,
 * and tests/factoryStagePrompts.test.js all agree.
 */
export const STAGE_PROMPT_FILES = {
  planner: 'docs/factory-prompts/planner.md',
  implementer: 'docs/factory-prompts/implementer.md',
  reviewer: 'docs/factory-prompts/reviewer.md',
  'security-reviewer': 'docs/factory-prompts/security-reviewer.md',
  qa: 'docs/factory-prompts/qa.md',
};

/** "planner → docs/factory-prompts/planner.md; …" seed mapping. */
export const STAGE_SEED_LIST = Object.entries(STAGE_PROMPT_FILES)
  .map(([stage, file]) => `${stage} → ${file}`)
  .join('; ');

/** Lazy default registry for direct callers (tests, CLI) that build prompts
 * without a resolved repo; the daemon resolves routing explicitly per card. */
let defaultRegistryCache;
function defaultRegistry() {
  if (defaultRegistryCache === undefined) {
    try {
      defaultRegistryCache = loadRegistry();
    } catch {
      defaultRegistryCache = null; // unparseable/missing config → no block (§4.1 fail-closed applies to the DAEMON, which loads it explicitly)
    }
  }
  return defaultRegistryCache;
}

/** Headless scheduler prompt for one card (already moved to Plan).
 * `repo` = registry entry (config/factory-repos.json) the card routes to;
 * default = registry `defaultRepo`. FM-2: the REPO CONTEXT block (§4.3)
 * carries the exact repoDir/worktree paths, bootstrap recipe, and deploy
 * command lines — pinned by tests/factoryStagePrompts.test.js. */
export function buildRunPrompt(card, { repo = null } = {}) {
  const ctxRepo = repo ?? defaultRegistry()?.repos?.[defaultRegistry()?.defaultRepo] ?? null;
  const repoContext = ctxRepo ? repoContextBlock(ctxRepo, { cardId: card.id, factoryRoot: ROOT }) : null;
  return [
    `You are the software factory scheduler for exactly one Trello card: ${card.id} "${card.name}".`,
    `Read docs/factory.md first and follow the board contract exactly.`,
    `The card has already been moved Ready -> Plan; do not touch any other card and do not drain the board.`,
    `Run the full pipeline for this one card now:`,
    `1. Worktree bootstrap per the REPO CONTEXT block below${ctxRepo ? ` (branch factory/${card.id} cut from origin/${ctxRepo.baseBranch})` : ` (branch factory/${card.id} cut from origin/master) per the spec`}.`,
    `2. Spawn stage subagents: planner ([PLAN]), implementer ([IMPL]), merge gate (rebase onto origin/master + factory.js mergeable), reviewer ([REVIEW:*]; findings tagged [Important]/[Nit]/[Pre-existing]), Review-verify (after every [REVIEW:CHANGES]: spawn one fresh-context read-only verifier per finding — buildVerifierPrompt in scripts/lib/factory-review-verify.js — then pipe the classifications to factory.js review-verify → [REVIEW:VERIFY] verdict; proceed → security pass, bounce → Implement), security pass (scheduler: factory.js security-check factory/<id> master; sensitive → spawn security-reviewer, verdict [SEC:PASS|SEC:FINDINGS]; not sensitive → scheduler posts [SEC:PASS] no-op), qa ([QA:PASS|QA:FAIL]). QA requires REVIEW:APPROVE AND [SEC:PASS] after the latest [IMPL]; [SEC:FINDINGS] bounces → Implement (counts toward the 3-bounce rule). Bounce and needs-human parking rules per spec (node scripts/factory.js bounces <card>).`,
    `   Seed EVERY stage subagent so its prompt begins: "Read docs/factory-prompts/<stage>.md and follow it as your authoritative role instructions (they override your harness role defaults)" — stage → file: ${STAGE_SEED_LIST}. The security-reviewer doc points at docs/security-review.md for the checklist; the [SEC:PASS] no-op stays scheduler-posted.`,
    `3. On QA:PASS: RISK GATE before merge — in the worktree run node scripts/factory.js approve <card> $(git rev-parse HEAD) factory/${card.id}. Tier low → proceed. Tier medium/high → the gate posts [ASK] + pings and blocks for a human comment containing that sha. Gate exit 1 (timeout) → node scripts/factory.js label <card> needs-human, leave the card in QA, do NOT merge; stop this run. Gate exit 0 → run node scripts/factory.js merge-guard factory/<id> master BEFORE merging — exit 0 means the branch sits on the freshly fetched origin/master tip; exit 1 (or a fetch failure — fail-closed) means master advanced: re-run the merge gate (rebase factory/<id> onto fresh origin/master + factory.js mergeable, same conflict rules) then RE-RUN THE RISK GATE on the new tip — node scripts/factory.js approve <card> $(git rev-parse HEAD) (the rebase changed the sha: a stale approval never keys it; tier medium/high re-asks and blocks before merge) — then merge-guard again (loop ≤3, exhausted → needs-human park). Then git merge --ff-only into master and run npm test — this post-merge npm test is the combined re-test against the exact master being pushed; non-zero → git reset --hard origin/master (the branch keeps the work) and bounce to Implement (counts). git push origin master: rejected (the residual fetch→push window) → git reset --hard origin/master and re-run the merge-guard loop (≤3 rounds), NEVER --force-push master.`,
    `4. Deploy + Verify via scripts/deploy.js and scripts/verify-deploy.js with [DEPLOY]/[VERIFY:*] comments (the Deploy move only ever happens post-gate). On [VERIFY:FAIL]: after posting the verdict, run node scripts/deploy.js rollback (restores the last known-good deploy) and post exactly one [ROLLBACK] comment (success or failure — rollback failure NEVER blocks the bounce), THEN bounce to Implement (counts).`,
    `5. Remove worktree + branch, move the card to Done on success (park per spec on failure). A [PROD-WATCH]-titled card must first answer "which layer should have caught this" with node scripts/factory.js prod-close <card> --layer <name> --why "<text>" [--fix "<text>"] — move … Done refuses without the [PROD-CLOSE] comment (--no-close-check opts out).`,
    `Post every stage comment with node scripts/factory.js comment. Finish by printing the final card state.`,
    `Stage context is curated per docs/factory.md "Per-stage context": seed every stage subagent with node scripts/factory.js context <card> <stage> output — the raw factory.js read trail is audit-only.`,
    ...(repoContext ? ['', repoContext] : []),
  ].join('\n');
}

/** Args for one headless run, given the binary name and prompt. */
export function agentArgs(prompt) {
  const argv = ['-p', '--auto-approve', '--max-time', process.env.FACTORY_MAX_TIME || '12h'];
  const maxCost = process.env.FACTORY_MAX_COST || '100';
  if (maxCost) argv.push('--max-cost', maxCost);
  if (process.env.FACTORY_MODEL) argv.push('--model', process.env.FACTORY_MODEL);
  argv.push(prompt);
  return argv;
}

/** launchd plist XML (absolute paths; launchd's default PATH has no node/git/omp). */
export function plistXml({ label = LABEL, nodePath, scriptPath = join(ROOT, 'scripts/factory-daemon.js'), logDir = STATE_DIR, repo = ROOT } = {}) {
  const envPath = [dirname(nodePath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${repo}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${envPath}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${join(logDir, 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(logDir, 'launchd.err.log')}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// Done-ping supervision (card 6ae7941fdf19ee34c911f0ae)
// ---------------------------------------------------------------------------

/**
 * Keep the Done-list poller alive for the daemon's lifetime. A
 * never-rejecting loop: starts `runWatch` (the real `runDoneWatch` by
 * default) once and, whenever its promise settles without honoring
 * `shouldStop` — crash or unexpected resolve — restarts it after `restartMs`
 * ms. Exits when `runWatch` returns `{stopped:true}` (the poller saw
 * `shouldStop()` flip and finished its tick cleanly) or when `shouldStop()`
 * flips true at a restart boundary. The poller owns all Done-ping state;
 * this supervisor never touches it — it only keeps the loop alive.
 * DI'd (runWatch/sleep/log) so tests run it with fake timers, no network.
 */
export async function superviseDoneWatch({
  runWatch = runDoneWatch,
  log = (msg) => console.log(msg),
  shouldStop = () => false,
  restartMs = 5000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (;;) {
    let res;
    try {
      res = await runWatch({ log, shouldStop });
    } catch (e) {
      log(`[done-watch] poller crashed (${String(e?.message ?? e)}); restarting in ${restartMs}ms`);
    }
    if (res?.stopped || shouldStop()) return;
    await sleep(restartMs);
    if (shouldStop()) return;
  }
}

// ---------------------------------------------------------------------------
// Comment-resume supervision (card 6ae89f208dab26fa65fe6b81)
// ---------------------------------------------------------------------------

/**
 * Keep the comment-resume watcher alive for the daemon's lifetime — the
 * structural twin of `superviseDoneWatch`. A never-rejecting loop: starts
 * `runWatch` (the real `runCommentResumeWatch` by default) once and, whenever
 * its promise settles without honoring `shouldStop` — crash or unexpected
 * resolve — restarts it after `restartMs` ms. Exits when `runWatch` returns
 * `{stopped:true}` (the watcher saw `shouldStop()` flip and finished its tick
 * cleanly) or when `shouldStop()` flips true at a restart boundary. The
 * watcher owns all comment-resume state; this supervisor never touches it —
 * it only keeps the loop alive. `isBusy`/`freeSlots`/`spawnRun` are forwarded
 * so the watcher shares the daemon's runs map, concurrency cap, and spawn
 * machinery. DI'd (runWatch/sleep/log) so tests run it with fake timers, no
 * network.
 */
export async function superviseCommentWatch({
  runWatch = runCommentResumeWatch,
  isBusy = () => false,
  freeSlots = () => Infinity,
  spawnRun = undefined,
  log = (msg) => console.log(msg),
  shouldStop = () => false,
  restartMs = 5000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (;;) {
    let res;
    try {
      const opts = { log, shouldStop, isBusy, freeSlots };
      if (spawnRun) opts.spawnRun = spawnRun;
      res = await runWatch(opts);
    } catch (e) {
      log(`[comment-watch] watcher crashed (${String(e?.message ?? e)}); restarting in ${restartMs}ms`);
    }
    if (res?.stopped || shouldStop()) return;
    await sleep(restartMs);
    if (shouldStop()) return;
  }
}

// ---------------------------------------------------------------------------
// Stage-aware crash recovery (card 6ae96770d68eed22d6069c6e — Factor 12)
// ---------------------------------------------------------------------------

/**
 * Recover ONE ended run — dispatch OR resume, non-zero exit OR spawn
 * failure OR exit-0-without-advance (stall, D1) — by reading the card's own
 * log instead of a fixed re-queue policy (docs/factory.md "Auto-start
 * daemon"): `decideCrashRecovery` returns park/resume/requeue/hold from the
 * comment trail + the card's CURRENT list + the `isAskPending` verdict (D2:
 * a pending `[ASK]` holds the card waiting on its human). The closure `card`
 * is stale (dispatch moved the card to Plan after the poll snapshot and
 * agents move it further), so board state is re-fetched here. Order of
 * operations:
 *
 *  1. `shuttingDown()` → return — the daemon is stopping; leave the card.
 *  2. Read the card's comments (fetch failure → `[]`: no verdict visible,
 *     the decision degrades conservatively and the crash comment still
 *     lands).
 *  3. Fetch CURRENT board state (`getCard` + `getLists` → list name);
 *     either fetch throwing → degraded **hold**: post the crash comment,
 *     touch nothing. Zero-move is the safe degraded mode — a human comment
 *     then reaches the comment watcher; a drag back to Ready re-runs via
 *     the ordinary poll loop.
 *  4. `decideCrashRecovery`: park at the comment-derived crash cap; resume
 *     at the current stage once a stage verdict exists (committed work is
 *     never redone); full Ready re-run ONLY before the first stage verdict;
 *     hold when the card already left the in-flight lists (Done/Ready/…).
 *  5. Post `crashCommentText` — first token stays `[DAEMON-CRASH]`, so the
 *     comment-derived retry cap keeps surviving daemon restarts; the comment
 *     also embeds the run-log tail (`readRunLog` seam, default the real
 *     `readFileSync`; an unreadable log falls back byte-identical and never
 *     blocks any recovery mode — card 6ae96770782334e43c98b13d, Factor 9).
 *     D4 exception: a stall-family call deciding a plain left-the-pipeline
 *     hold posts NOTHING (healthy finish — done-watch already pinged it);
 *     ask-pending holds and degraded holds still post.
 *  6. Apply the mode. The crashed run already freed its slot (`runs.delete`
 *     fires before this handler), so the immediate respawn is cap-neutral;
 *     `deferResume(entry)` absorbs the race where the comment watcher
 *     grabbed the last slot meanwhile — returning true means the entry was
 *     queued for the poll-loop drain (the crash comment already landed; the
 *     crash cap bounds retries if the resumed run crashes again).
 *
 * DI'd (trello client, spawn/defer seams, cap, shutdown flag, log) so
 * tests/factoryDaemon.test.js drives every branch with fakes — zero live
 * Trello there.
 */
export async function handleRunCrash({
  card,
  code,
  t = trelloLib,
  readyList,
  board = undefined,
  repo = undefined,
  log = (msg) => console.log(msg),
  spawnResumeRun = undefined,
  deferResume = undefined,
  crashRetries = MAX_CRASH_RETRIES,
  shuttingDown = () => false,
  readRunLog = (path) => readFileSync(path, 'utf8'),
} = {}) {
  if (shuttingDown()) return; // daemon is stopping; leave the card where it is
  const comments = await t.getCardComments(card.id).catch(() => []);
  const prior = comments.filter((c) => (c.data?.text ?? '').startsWith(CRASH_TAG)).length;
  let listName = '';
  let degraded = false;
  try {
    const [fresh, lists] = await Promise.all([t.getCard(card.id), t.getLists({ board })]);
    listName = String((lists ?? []).find((l) => l.id === fresh?.idList && !l.closed)?.name ?? '');
  } catch (e) {
    degraded = true; // board state unreadable → zero-move degraded mode
    log(`crash recovery for ${card.id}: board state unavailable (${e?.message ?? e}) — card untouched`);
  }
  const askPending = isAskPending(comments);
  const { mode, stage } = degraded
    ? { mode: 'hold', stage: listName }
    : decideCrashRecovery({ comments, listName, crashRetries, askPending });
  const holdReason = mode === 'hold' && !degraded && askPending ? 'ask-pending' : '';
  // D4 (card 6aebab9a65613358f4ca333a) — keep the healthy path silent: a
  // stall-family call (exit-0 exit / sweep orphan) that decides a plain
  // left-the-pipeline hold is the NORMAL finish (the run completed its
  // contract and the Done arrival is already pinged by done-watch); posting
  // a [DAEMON-CRASH] there would spam a trail per healthy run. Crash calls
  // (non-zero code / sig / spawn-failed) post byte-for-byte as ever; a
  // degraded hold posts (board-state uncertainty deserves the record); an
  // ask-pending hold posts (RC4 — turn "waiting on a human" board-visible).
  const silentHold = mode === 'hold' && !degraded && !askPending && isStallCode(code);
  // Embed the run-log tail so the recovering run self-heals from real failure
  // text, not just an exit number (Factor 9; [VERIFY:FAIL]-embeds-JSON
  // precedent). A missing/unreadable log must NEVER block the comment or any
  // recovery mode — crashCommentText falls back to the byte-identical
  // exit-code-only head when logText is empty.
  const logPath = join(STATE_DIR, `${card.id}.log`);
  let logText = '';
  try {
    logText = readRunLog(logPath);
  } catch {}
  if (!silentHold) {
    await t
      .addComment(
        card.id,
        crashCommentText(code, prior, { mode, stage, crashRetries, logPath: `data/factory-daemon/${card.id}.log`, logText, holdReason }),
      )
      .catch((e) => log(`crash comment failed: ${e.message}`));
  } else {
    log(`healthy exit for ${card.id} (${code}); card sits in ${stage || 'an unknown list'} — outside the pipeline, comment suppressed`);
  }
  if (mode === 'park') {
    const parked = (await t.getLabels({ board })).find((l) => l.name === 'needs-human');
    if (parked) await t.addLabelToCard(card.id, parked.id).catch(() => {});
    log(`crash cap reached for ${card.id}; parked where it stands with needs-human${stage ? ` (${stage})` : ''}`);
  } else if (mode === 'resume') {
    if (!spawnResumeRun) {
      log(`crash recovery wants a resume for ${card.id} at ${stage} but no spawn seam is wired; card untouched`);
    } else {
      const prompt = buildResumePrompt(card, { stage, crash: code, repo });
      if (!deferResume || !deferResume({ card, prompt })) {
        spawnResumeRun(card, prompt);
        log(`crashed run for ${card.id} (exit ${code}); stage-aware resume at ${stage}`);
      } else {
        log(`crashed run for ${card.id} (exit ${code}); resume at ${stage} deferred — no free slot`);
      }
    }
  } else if (mode === 'requeue') {
    if (readyList) {
      await t.moveCard(card.id, readyList.id).catch((e) => log(`re-queue move failed: ${e?.message ?? e}`));
      log(`crashed run for ${card.id} (exit ${code}); no stage verdict yet — card re-queued to Ready for a full re-run`);
    } else {
      log(`crashed run for ${card.id} (exit ${code}); requeue decided but no Ready list on this board — card untouched`);
    }
  } else if (!degraded) {
    log(
      askPending
        ? `run for ${card.id} (exit ${code}); pending [ASK] owns the reply — card left waiting in ${stage || 'an unknown list'}, untouched`
        : `crashed run for ${card.id} (exit ${code}); card sits in ${stage || 'an unknown list'} — outside the pipeline, untouched`,
    );
  }
}

// ---------------------------------------------------------------------------
// Blocking-checks gate supervision (card 6ae9677239bb2697a13ea728)
// ---------------------------------------------------------------------------

/**
 * Keep the independent blocking-checks gate alive for the daemon's lifetime —
 * the structural twin of `superviseCommentWatch`, WITHOUT the
 * `isBusy`/`freeSlots`/`spawnRun` seams: the poller runs the suite ITSELF
 * (no omp spawn, nothing to register in the runs map or count against the
 * concurrency cap). A never-rejecting loop: starts `runWatch` (the real
 * `runBlockingChecksWatch` by default) once and, whenever its promise settles
 * without honoring `shouldStop` — crash or unexpected resolve — restarts it
 * after `restartMs` ms. Exits when `runWatch` returns `{stopped:true}` or
 * when `shouldStop()` flips true at a restart boundary. The poller owns all
 * check state; this supervisor never touches it — it only keeps the loop
 * alive. DI'd (runWatch/sleep/log) so tests run it with fake timers, no
 * network. Unlike the two agent-spawning pollers, a concurrent one-shot CLI
 * (`factory.js blocking-checks`) is harmless alongside — no double-spawn
 * warning needed here.
 */
export async function superviseBlockingChecks({
  runWatch = runBlockingChecksWatch,
  log = (msg) => console.log(msg),
  shouldStop = () => false,
  restartMs = 5000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (;;) {
    let res;
    try {
      res = await runWatch({ log, shouldStop });
    } catch (e) {
      log(`[blocking-checks] gate crashed (${String(e?.message ?? e)}); restarting in ${restartMs}ms`);
    }
    if (res?.stopped || shouldStop()) return;
    await sleep(restartMs);
    if (shouldStop()) return;
  }
}

// ---------------------------------------------------------------------------
// run: poll + dispatch
// ---------------------------------------------------------------------------

/**
 * Default in-flight cap — internal-first canary (card 6ae96773f672adf3d556b8ec;
 * docs/factory.md "Gradual rollout (internal-first)"): one card at a time so
 * the prod-watchdog interval (300 s) is the canary window between single-
 * in-flight deploys. Raise `FACTORY_MAX_PARALLEL` in the daemon's process env
 * (restart required) once the docs raise policy is satisfied.
 */
export const DEFAULT_MAX_PARALLEL = 1;

const envNum = (name, def) => Number(process.env[name] || def);
const log = (msg) => console.log(`[factory-daemon ${new Date().toISOString()}] ${msg}`);

function acquirePidLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    try {
      if (pid && process.kill(pid, 0)) {
        console.error(`factory-daemon already running (pid ${pid}); refusing to double-run`);
        process.exit(1);
      }
    } catch {
      /* stale lock from a dead daemon */
    }
  }
  writeFileSync(PID_FILE, `${process.pid}\n`);
}

async function findList(name, board) {
  const lists = await trelloLib.getLists({ board });
  return lists.find((l) => !l.closed && l.name.toLowerCase() === name.toLowerCase());
}

/**
 * FM-2 (§4.3): one process polls EVERY registered board each tick. `registry`
 * is the DI seam for tests (default: the loaded config/factory-repos.json —
 * fail-closed at startup, the loader names the offending key).
 */
async function run({ registry = undefined } = {}) {
  const pollMs = envNum('FACTORY_POLL_MS', 15000);
  const cap = envNum('FACTORY_MAX_PARALLEL', DEFAULT_MAX_PARALLEL);
  const ompBin = process.env.FACTORY_OMP_BIN || 'omp';
  trelloLib.assertCreds();
  const repos = registry ?? loadRegistry(); // D2 fail-closed: invalid registry = startup error
  const boards = boardIds(repos);
  acquirePidLock();

  // Per-board list context: Ready/Plan are resolved ONCE per board at boot;
  // every list the daemon names (Ready dispatch, Plan move) is board-scoped.
  const ctxs = [];
  for (const board of boards) {
    const [readyList, planList] = [await findList('Ready', board), await findList('Plan', board)];
    if (!readyList || !planList) {
      console.error(`Board ${board} is missing Ready/Plan lists (run: node scripts/factory.js init --board ${board})`);
      process.exit(1);
    }
    ctxs.push({ board, readyList, planList });
  }
  const byBoard = new Map(ctxs.map((c) => [c.board, c]));

  let queue = []; // {board, cardId, card} — planDispatch entries, board-keyed
  const pendingCrashResumes = []; // crash resumes deferred for lack of a slot (drained per tick)
  const runs = new Map(); // cardId -> ChildProcess
  // Declared before the boot sweep: crashRecovery's `shuttingDown` closure
  // runs during bootStallSweep, where a later `let` would still be TDZ.
  let shuttingDown = false;

  // One crash path for BOTH spawn kinds (docs/factory.md "Auto-start
  // daemon"): stage-aware recovery decided by the card's log, never a
  // blind Ready re-queue — committed work is never redone. The crashed
  // run already freed its slot (`runs.delete` fires before the exit
  // handler), so the immediate respawn is cap-neutral; `deferResume`
  // absorbs the race where the comment watcher grabbed the last slot
  // meanwhile by queueing the entry for the poll-loop drain. FM-2: `ctx`
  // (the run's board context + routed repo) rides along — Ready re-queues
  // move on the card's OWN board, the [ASK]/resume board-scope likewise,
  // and the resume prompt's REPO CONTEXT comes from the routing decision
  // made at dispatch time.
  const crashRecovery = (crashedCard, codeStr, ctx = ctxs[0]) =>
    handleRunCrash({
      card: crashedCard,
      code: codeStr,
      readyList: ctx?.readyList,
      board: ctx?.board,
      repo: ctx?.repo,
      log,
      spawnResumeRun: (c, p) => spawnResumeRun(c, p, ctx),
      deferResume: (entry) => {
        if (runs.size < cap) return false; // slot free — spawn immediately
        pendingCrashResumes.push({ ...entry, ctx });
        return true; // queued — drained when a slot frees
      },
      shuttingDown: () => shuttingDown,
    });

  // Boot STALL SWEEP (card 6aebab9a65613358f4ca333a — replaces the old
  // log-only orphan-candidate loop, keeping its log lines): cards stranded
  // mid-pipeline with no owned run and a silent comment trail past
  // FACTORY_MAX_TIME + grace get recovered through `crashRecovery` right at
  // boot instead of only being reported (RC2). Never throws internally.
  // FM-2: per board — the lists it names are per-board (§4.3).
  for (const ctx of ctxs) {
    await bootStallSweep({
      board: ctx.board,
      log,
      recover: (orphanCard, code) => crashRecovery(orphanCard, code, ctx),
      isBusy: (id) => runs.has(id),
      freeSlots: () => Math.max(0, cap - runs.size),
    });
  }

  /**
   * Fail-closed repo routing (§4.3, D3): unknown/ambiguous `repo:` label →
   * ONE `[ASK]` (+ needs-human park, + Discord ping via the ask protocol) and
   * the card STAYS in Ready with ZERO spawn — never a guessed checkout. A
   * pending `[ASK]` owns the reply (isAskPending): re-poll ticks stay silent
   * until a human comment answers it; then the next re-dispatch re-asks if
   * the label is still unresolvable (one ask per human reply — no spam).
   */
  async function askRepo(card, ctx, routing) {
    const comments = await trelloLib.getCardComments(card.id).catch(() => []);
    if (isAskPending(comments)) {
      log(`repo routing unresolved for ${card.id} (${routing.reason}) — pending [ASK] owns the reply`);
      return;
    }
    const known = Object.keys(repos.repos).join(', ');
    const detail =
      routing.reason === 'unknown-repo'
        ? `repo:${routing.candidates.join(', ')} is not in the registry`
        : routing.reason === 'ambiguous-repo-label'
          ? `${routing.candidates.map((c) => `repo:${c}`).join(' + ')} are both set`
          : `board ${routing.board} is claimed by multiple repos (${routing.candidates.join(', ')})`;
    log(`repo routing unresolved for ${card.id} (${routing.reason}) — [ASK] + needs-human, left in Ready`);
    await askHuman({
      cardId: card.id,
      question:
        `Repo routing unresolved: ${detail}. Exactly one \`repo:<name>\` label out of {${known}} decides the checkout ` +
        '(docs/factory-migration.md D3); with no label the board default applies. Fix the labels (or comment the choice) — the card stays in Ready until then.',
      noWait: true,
      board: ctx.board,
    }).catch((e) => log(`[ASK] failed for ${card.id}: ${e.message}`));
    const labels = await trelloLib.getLabels({ board: ctx.board }).catch(() => []);
    const label = labels.find((l) => l.name === 'needs-human');
    if (label) await trelloLib.addLabelToCard(card.id, label.id).catch(() => {});
  }

  async function dispatch(entry) {
    const ctx = byBoard.get(entry.board) ?? ctxs[0];
    const card = entry.card ?? { id: entry.cardId };
    // Repo routing BEFORE the move — a routing failure never touches the board.
    const routing = repoForCard(repos, { labels: card.labels ?? [], board: ctx.board });
    if (!routing.ok) return askRepo(card, ctx, routing);
    const runCtx = { ...ctx, repo: routing.repo };
    await trelloLib.moveCard(card.id, ctx.planList.id);
    if (card.labels?.some((l) => l.name === 'needs-human')) {
      const parked = (await trelloLib.getLabels({ board: ctx.board })).find((l) => l.name === 'needs-human');
      if (parked) await trelloLib.removeLabelFromCard(card.id, parked.id).catch(() => {});
      log(`re-queued needs-human card ${card.id}; label removed`);
    }
    const logPath = join(STATE_DIR, `${card.id}.log`);
    const fd = openSync(logPath, 'a');
    writeFileSync(fd, `\n# dispatch ${new Date().toISOString()} ${ompBin} ${JSON.stringify(agentArgs(''))}\n`);
    log(`dispatching ${card.id} "${card.name}" -> Plan (${routing.source === 'label' ? `repo:${routing.repo.name} label` : `board default repo:${routing.repo.name}`}; log: ${logPath})`);
    const child = spawn(ompBin, agentArgs(buildRunPrompt(card, { repo: routing.repo })), {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    closeSync(fd);
    runs.set(card.id, child);
    child.on('exit', (code, sig) => {
      runs.delete(card.id);
      log(`run for ${card.id} exited code=${code} signal=${sig ?? '-'}`);
      // D1: exit 0 is only silent when handleRunCrash decides a healthy
      // left-the-pipeline hold (D4); an in-flight card that exits 0 stalled
      // and gets the same stage-aware recovery as a crash.
      crashRecovery(card, exitCodeStr(code, sig), runCtx).catch((e) => log(`crash handling failed: ${e.message}`));
    });
    child.on('error', (e) => {
      runs.delete(card.id);
      log(`spawn failed for ${card.id}: ${e.message}`);
      crashRecovery(card, 'spawn-failed', runCtx).catch((err) => log(`crash handling failed: ${err.message}`));
    });
  }

  // Stage-aware recovery spawn (docs/factory.md "Listening for human
  // comments" + "Auto-start daemon"): same spawn machinery as `dispatch`
  // (log file, fd stdio, cwd ROOT) but NO Ready→Plan move — the card
  // re-enters at the stage its list says, worktree reuse mandated. Serves
  // BOTH resume kinds: a human comment (the watcher) and a crashed run
  // (`handleRunCrash`'s resume mode); a crash at the cap parks
  // needs-human where the card stands, never a Ready re-queue.
  function spawnResumeRun(card, prompt, ctx = ctxs[0]) {
    const logPath = join(STATE_DIR, `${card.id}.log`);
    const fd = openSync(logPath, 'a');
    writeFileSync(fd, `\n# resume ${new Date().toISOString()} ${ompBin} ${JSON.stringify(agentArgs(''))}\n`);
    log(`resuming ${card.id} "${card.name}" (stage-aware recovery run (crash or comment); log: ${logPath})`);
    const child = spawn(ompBin, agentArgs(prompt), {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
      env: process.env,
    });
    closeSync(fd);
    runs.set(card.id, child);
    child.on('exit', (code, sig) => {
      runs.delete(card.id);
      log(`run for ${card.id} exited code=${code} signal=${sig ?? '-'}`);
      // D1 covers resume runs too: a resume that stalls at exit 0 mid-pipeline
      // re-enters stage-aware (or parks at the cap), never strands the card.
      crashRecovery(card, exitCodeStr(code, sig), ctx).catch((e) => log(`crash handling failed: ${e.message}`));
    });
    child.on('error', (e) => {
      runs.delete(card.id);
      log(`spawn failed for ${card.id}: ${e.message}`);
      crashRecovery(card, 'spawn-failed', ctx).catch((err) => log(`crash handling failed: ${err.message}`));
    });
  }

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down; ${runs.size} run(s) still active`);
    for (const [id, child] of runs) {
      log(`SIGTERM -> run ${id} (pid ${child.pid})`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }
    try {
      unlinkSync(PID_FILE);
    } catch {}
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Per-board pollers (FM-2 §4.3): the Done-pinger, comment-resume watcher,
  // stall sweeper, and blocking-checks gate each run ONE supervised loop per
  // registered board (the lists they name are per-board; the state files are
  // card-id keyed → unchanged). The pid lock guarantees a single daemon, so
  // exactly one of each per board. The daemon's per-board `repoOf` resolves
  // the resume/run repo context from the card's labels + board.
  const repoOf = (card, board) => {
    const r = repoForCard(repos, { labels: card?.labels ?? [], board });
    return r.ok ? r.repo : null;
  };
  for (const ctx of ctxs) {
    // Done-list pinger: auto-started and supervised in-process (the
    // `factory.js done-watch` poller), so Done arrivals ping on EVERY path —
    // scheduler moves AND UI drags, including drag-out → back-in — with zero
    // human ceremony (docs/factory.md "Pinging on Done"). It shares the
    // daemon's ROOT/data/factory-done-ping.json with the inline `move` pings.
    // `shuttingDown` flips on SIGTERM/SIGINT and the poller returns between
    // ticks; the existing 500 ms exit path is unchanged. Do NOT run
    // `factory.js done-watch` by hand alongside the daemon (double-ping race).
    void superviseDoneWatch({
      log,
      shouldStop: () => shuttingDown,
      runWatch: (opts) => runDoneWatch({ ...opts, board: ctx.board }),
    });

    // Comment-resume watcher: auto-started and supervised in-process (the
    // `factory.js resume-watch` poller), so a human comment on an in-flight
    // card whose run has died gets a `[RESUME]` ack + a scheduler run seeded at
    // the card's CURRENT stage — the stuck-Verify fix (docs/factory.md
    // "Listening for human comments"). It shares this daemon's `runs` map
    // (live-run dedup), the FACTORY_MAX_PARALLEL cap, and the spawn
    // machinery above; the pid lock guarantees a single watcher per board. Do
    // NOT run `factory.js resume-watch` by hand alongside the daemon
    // (double-spawn race).
    void superviseCommentWatch({
      log,
      shouldStop: () => shuttingDown,
      isBusy: (id) => runs.has(id),
      freeSlots: () => Math.max(0, cap - runs.size),
      spawnRun: (card, prompt) => spawnResumeRun(card, prompt, { ...ctx, repo: repoOf(card, ctx.board) }),
      runWatch: (opts) => runCommentResumeWatch({ ...opts, board: ctx.board, repoFor: (card) => repoOf(card, ctx.board) }),
    });

    // Stall sweep: supervised in-process after the boot pass above, so cards
    // orphaned LATER (runs killed by a SIGKILLed daemon, exit-0 stalls whose
    // crashRecovery died mid-flight) get recovered within
    // FACTORY_STALL_POLL_MS instead of waiting for the next restart (docs/
    // factory.md "Auto-start daemon" — stall recovery). It shares this
    // daemon's `runs` map, the concurrency cap, and the SAME crash-recovery
    // path (`crashRecovery`), and stops on `shuttingDown` between ticks; the
    // pid lock guarantees a single sweeper per board. Do NOT run a LIVE
    // `factory.js stall-sweep` by hand alongside the daemon (double-spawn).
    void superviseStallSweep({
      log,
      shouldStop: () => shuttingDown,
      isBusy: (id) => runs.has(id),
      freeSlots: () => Math.max(0, cap - runs.size),
      recover: (stalledCard, code) => crashRecovery(stalledCard, code, { ...ctx, repo: repoOf(stalledCard, ctx.board) }),
      runWatch: (opts) => runStallSweepWatch({ ...opts, board: ctx.board }),
    });

    // Independent blocking-checks gate: auto-started and supervised in-process
    // (docs/factory.md "Independent blocking checks"). When a card sits in QA
    // with latest stage tag `[QA:PASS]`, the daemon runs the blocking suite
    // (`npm test`; `FACTORY_CHECK_CMD` override) ITSELF against the card's
    // worktree tip and posts `[CHECK:PASS]`/`[CHECK:FAIL]`; a FAIL bounces to
    // Implement and counts toward the 3-bounce rule — exactly like
    // `[VERIFY:FAIL]`. The sha watermark in data/factory-blocking-checks.json
    // makes checks exactly-once per worktree tip across restarts, so a long
    // suite never double-runs the same commit. No spawn: the poller runs the
    // commands itself, so nothing registers in `runs`/the cap, and a manual
    // `factory.js blocking-checks` one-shot alongside is harmless. FM-2: the
    // worktree path is registry-driven (§4.1 `worktreeRoot` per repo).
    void superviseBlockingChecks({
      log,
      shouldStop: () => shuttingDown,
      runWatch: (opts) =>
        runBlockingChecksWatch({
          ...opts,
          board: ctx.board,
          worktreeOf: (card) => worktreeFor(repoOf(card, ctx.board) ?? repos.repos[repos.defaultRepo], card.id),
          // A routed card's branch refs live in ITS repo (worktrees share
          // refs per repo) — the tip read must run there (§4.4).
          gitFor: (card) => {
            const dir = (repoOf(card, ctx.board) ?? repos.repos[repos.defaultRepo]).repoDir;
            return (argv) =>
              execFileSync('git', argv, {
                cwd: dir,
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
          },
        }),
    });
  }

  log(`watching "Ready" on ${ctxs.length} board(s) (${ctxs.map((c) => c.board).join(', ')}) every ${pollMs}ms, cap ${cap}, agent "${ompBin}"`);
  for (;;) {
    try {
      // Drain crash-recovery resumes deferred for lack of a slot (same
      // shape as the Ready `queue` above; the `[DAEMON-CRASH]` comment
      // already landed, so a re-crash still counts toward the cap).
      while (pendingCrashResumes.length && runs.size < cap) {
        const { card: c, prompt, ctx } = pendingCrashResumes.shift();
        spawnResumeRun(c, prompt, ctx);
      }
      // Per-board Ready pass (§4.3): every registered board contributes
      // {board, cardId, card} entries; the GLOBAL queue + global cap order
      // them across boards (board order = registry order, default first).
      const ready = [];
      for (const ctx of ctxs) {
        const cards = await trelloLib.getBoardCards(undefined, { board: ctx.board });
        for (const c of (cards ?? []).filter((c) => c.idList === ctx.readyList.id)) {
          ready.push({ board: ctx.board, cardId: c.id, card: c });
        }
      }
      const started = new Set(runs.keys());
      const { queue: nextQueue, dispatch: toStart } = planDispatch(queue, ready, started, cap);
      queue = nextQueue;
      // Queue entries survive ticks — dispatch re-resolves the card from THIS
      // tick's fetch so labels added while the card waited (a `repo:` fix
      // after an [ASK]) route correctly; a vanished card falls back to the
      // queued snapshot.
      const freshCards = new Map(ready.map((e) => [`${e.board}/${e.cardId}`, e.card]));
      for (const entry of toStart) {
        await dispatch({ ...entry, card: freshCards.get(`${entry.board}/${entry.cardId}`) ?? entry.card });
      }
    } catch (e) {
      log(`poll error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// ---------------------------------------------------------------------------
// install / uninstall / status (launchd)
// ---------------------------------------------------------------------------

async function install() {
  const nodePath = process.execPath;
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, plistXml({ nodePath }));
  log(`wrote ${PLIST_PATH}`);
  // Arm the detached bootstrap guard BEFORE bootout: when install runs under
  // the daemon (a factory run restarting the daemon as an ops step), bootout's
  // SIGTERM cascades into this very process, and without a survivor the job
  // stays unloaded forever — KeepAlive only revives loaded jobs. See
  // scripts/lib/factory-launchd.js.
  const guard = bootstrapGuard();
  log(`bootstrap guard armed (pid ${guard.pid})`);
  await launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]).catch(() => {});
  await launchctl(['bootstrap', `gui/${process.getuid()}`, PLIST_PATH]);
  log('bootstrapped; cards moved to Ready now auto-start the factory');
}

/** Detached `ensureBootstrapped` retry loop in its own session. */
function bootstrapGuard() {
  const lib = pathToFileURL(join(ROOT, 'scripts/lib/factory-launchd.js')).href;
  const script =
    `import { ensureBootstrapped } from ${JSON.stringify(lib)};\n` +
    `const ok = await ensureBootstrapped({ label: ${JSON.stringify(LABEL)}, plist: ${JSON.stringify(PLIST_PATH)} });\n` +
    `process.exit(ok ? 0 : 1);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

async function uninstall() {
  // Unlink before bootout so a SIGTERM cascade mid-uninstall converges toward
  // "uninstalled" (a surviving loaded job exits at session end) instead of
  // leaving a plist that re-bootstraps itself at the next login.
  try {
    unlinkSync(PLIST_PATH);
    log(`removed ${PLIST_PATH}`);
  } catch {
    log(`${PLIST_PATH} was not present`);
  }
  await launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]).catch((e) => log(`bootout: ${e.message}`));
}

async function status() {
  try {
    const out = await new Promise((res, rej) =>
      execFile('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { encoding: 'utf8' }, (e, so) => (e ? rej(e) : res(so))),
    );
    const pid = out.match(/^\s*pid\s*=\s*(\d+)/m)?.[1];
    const state = out.match(/^\s*state\s*=\s*(\S+)/m)?.[1];
    console.log(pid ? `launchd job running (state=${state}, pid ${pid})` : `launchd job installed, not running (state=${state ?? 'unknown'})`);
  } catch {
    console.log('not installed (no launchd job)');
  }
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    try {
      process.kill(pid, 0);
      console.log(`daemon pid ${pid} alive`);
      try {
        console.log(`Boards polled from config/factory-repos.json: ${boardIds(loadRegistry()).join(', ')}`);
      } catch (e) {
        console.log(`Boards polled: registry unavailable (${e.message})`);
      }
      console.log('Done-ping watcher: supervised in-process by the daemon (do not run factory.js done-watch separately)');
      console.log('Comment-resume watcher: supervised in-process by the daemon (do not run factory.js resume-watch separately)');
      console.log('Stall sweep: supervised in-process by the daemon (do not run a live factory.js stall-sweep separately; --dry-run is safe)');
      console.log('Blocking-checks gate: supervised in-process by the daemon (daemon runs npm test against QA tips; [CHECK:FAIL] bounces)');
    } catch {
      console.log(`stale pid file for dead pid ${pid}`);
    }
  }
  if (existsSync(STATE_DIR)) {
    const logs = readdirSync(STATE_DIR).filter((f) => f.endsWith('.log'));
    if (logs.length) console.log(`logs in ${STATE_DIR}: ${logs.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const actions = { run, install, uninstall, status };
  const fn = actions[cmd];
  if (!fn) {
    console.error(
      'Usage: node scripts/factory-daemon.js run|install|uninstall|status  (run also auto-starts and supervises the Done-ping + comment-resume watchers + stall sweep + the independent blocking-checks gate)',
    );
    process.exit(1);
  }
  Promise.resolve(fn(...args)).catch((e) => {
    console.error(e.message ?? String(e));
    process.exit(1);
  });
}
