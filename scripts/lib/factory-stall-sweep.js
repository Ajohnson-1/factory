// Stall sweep for the software factory (card 6aebab9a65613358f4ca333a).
// Pipeline spec: docs/factory.md ("Auto-start daemon" — stall recovery).
//
// Root cause this fixes: a scheduler run that exits 0 WITHOUT advancing its
// card (dying at the FACTORY_MAX_TIME cap while blocked on something outside
// itself) strands the card in an in-flight list forever — the daemon logged
// "exited code=0" and did nothing; the scheduler only dispatches from Ready
// and the comment-resume watcher only fires on new HUMAN comments. A daemon
// restart made it worse: mid-pipeline cards with no owned run were only
// reported ("orphan candidate") and never revisited.
//
// Each tick (FACTORY_STALL_POLL_MS → 300 s) this sweep examines the cards in
// the OPEN in-flight lists (Plan…Verify, needs-human excluded — the same
// `selectInFlight` scope as the comment-resume watcher) and recovers the
// STALLED ones: a card with no live run, no free-slot excuse, whose NEWEST
// comment of ANY kind is older than the silence window
// (FACTORY_STALL_SILENCE_MS, default parseMaxTimeMs(FACTORY_MAX_TIME || '12h')
// + 15 min). The window is provably safe: a live run can never outlive
// FACTORY_MAX_TIME (the omp --max-time cap), so a silent in-flight card whose
// last comment predates max-time+grace cannot have a run that intends to
// continue — including children orphaned by a SIGKILLed daemon. Recovery is
// the EXISTING crash path: `handleRunCrash` with
// code = `stalled (orphan, silent <n> min)` — one implementation renders the
// `[DAEMON-CRASH]` comment (run-log tail included), enforces the
// comment-derived crash cap, and applies resume/requeue/park.
//
// Skips (leave the card to its owner):
//  - live run (`isBusy`) or no free slot (`freeSlots`) — retry next tick
//    (at-least-once, the same dedup the comment watcher relies on);
//  - latest comment is HUMAN-authored (untagged — the comment-resume watcher
//    owns human comments; tag-based detection, the ask protocol's degraded
//    fast-path precedent: every bot comment carries a board-contract tag);
//  - `isAskPending` — a pending `[ASK]` means the card waits on a human, and
//    resuming under their feet is exactly what D2 forbids;
//  - no comments / undated newest comment — silence is unprovable, fail closed.
//
// STATELESS by design: the trigger is board-derived (comment dates) and the
// retry cap is the comment-derived `[DAEMON-CRASH]` count — no state file,
// restart-safe by construction. `runStallSweepWatch` NEVER rejects on internal
// errors: fetch/spawn failures are logged and retried next tick (the
// `runCommentResumeWatch` supervision contract: `once` + `dryRun` +
// `shouldStop`, all seams injectable, zero live Trello in tests).
//
// The daemon integrates this lib three ways: `bootStallSweep` replaces the
// boot-time log-only orphan loop (keeps the log lines), `superviseStallSweep`
// keeps the periodic sweep alive in-process next to the comment watcher
// (sharing the daemon's `runs` map, cap, spawn machinery, and shutdown flag
// via the injected seams), and CLI-standalone live mode spawns fire-and-forget
// recovery runs itself. Do NOT run a LIVE `factory.js stall-sweep` by hand
// alongside the daemon (double-spawn); `--dry-run` is read-only and safe.

import { closeSync, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as trello from './trello.js';
import { parseDotEnv } from './trello.js';
// ESM cycle with the daemon is safe (same precedent as the comment-resume
// lib): every binding here is dereferenced only inside function bodies.
import { handleRunCrash } from '../factory-daemon.js';
import { selectInFlight, isAskPending, deriveResumeStage } from './factory-comment-resume.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const fileEnv = parseDotEnv();

// Same private helper as the comment-resume lib (process env then .env).
function envNum(name, fallback) {
  const n = Number(process.env[name] || fileEnv[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Lists whose cards the sweep examines (in-flight pipeline stages). */
const IN_FLIGHT_LISTS = ['Plan', 'Implement', 'Review', 'QA', 'Deploy', 'Verify'];

const textOf = (a) => (typeof a === 'string' ? a : String(a?.data?.text ?? a?.text ?? ''));
const msOf = (a) => Date.parse(a?.date ?? '');

/**
 * Parse a run time limit (`2h`, `90m`, `5400s`, bare seconds → ms) — the
 * same grammar `omp --max-time` takes. Junk/missing → `fallbackMs` (12 h, the
 * factory default). Pure; the silence window derives from it, so a malformed
 * FACTORY_MAX_TIME degrades to the default floor, never to zero.
 */
export function parseMaxTimeMs(text, fallbackMs = 12 * 60 * 60 * 1000) {
  const m = String(text ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*([hms]?)$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  const mult = { h: 3_600_000, m: 60_000, s: 1000, '': 1000 }[m[2].toLowerCase()];
  return Math.round(n * mult);
}

/**
 * Default silence window: FACTORY_STALL_SILENCE_MS (ms) when set, else the
 * FACTORY_MAX_TIME cap + 15 min grace. The grace covers the run's own tail
 * (final comments land at/after the deadline); silence past the cap+grace
 * proves no run intends to continue (§header proof).
 */
export function defaultSilenceMs() {
  return envNum('FACTORY_STALL_SILENCE_MS', parseMaxTimeMs(process.env.FACTORY_MAX_TIME || fileEnv.FACTORY_MAX_TIME || '12h') + 15 * 60_000);
}

/**
 * True when a comment is HUMAN-authored WITHOUT a bot identity: the board
 * contract tags every bot comment (`[PLAN]`…`[DAEMON-CRASH]`, `[HUMAN]`
 * relay), so an untagged comment is the human's. Same degraded fast-path as
 * the ask protocol / `factory-context.js` (tag-only when identity is absent).
 */
function isHumanText(text) {
  // Bracket-SHAPE detection (any tag shape incl. the hyphenated
  // [DAEMON-CRASH]/[PROD-CLOSE] and unknown future tags = bot-side — the
  // factory-context.js curator's rule); untagged = the human's own comment.
  const t = textOf(text).trimStart();
  return !/^\[[A-Z0-9_.-]+(?::[A-Z0-9_.-]+)?\]/i.test(t) || /^\[HUMAN\]/i.test(t);
}

/** Newest-first comment order (undated to the tail; ties keep Trello order). */
function newestFirst(comments) {
  return (Array.isArray(comments) ? comments : [])
    .map((c, i) => ({ c, i, ms: msOf(c) }))
    .sort((x, y) => {
      const xm = Number.isFinite(x.ms) ? x.ms : Number.NEGATIVE_INFINITY;
      const ym = Number.isFinite(y.ms) ? y.ms : Number.NEGATIVE_INFINITY;
      return ym - xm || x.i - y.i;
    });
}

/**
 * Pure stall classifier — the qualification predicate, testable without IO.
 * One entry per card → `{ card, listName, lastCommentAt, silentMs, reason }`
 * where reason ∈
 *  - 'stalled'      — newest comment of ANY kind older than `silenceMs`, no
 *                     busy/human/ask guard fired → recover via handleRunCrash.
 *  - 'busy'         — `isBusy(card.id)` — a live run owns the card.
 *  - 'human-latest' — newest comment is human-authored (the comment-resume
 *                     watcher owns it; resuming now would double-spawn).
 *  - 'ask-pending'  — `isAskPending(comments)` — a human answer is owed.
 *  - 'silent-ok'    — silence ≤ window (a young card or a recent comment) OR
 *                     silence unprovable (zero comments / undated newest).
 * Inputs are pre-fetched so the classifier stays pure: `cards` already
 * scoped by `selectInFlight` (in-flight list, no needs-human label — re-
 * checked here defensively via `listNames`), `comments` a Map (or plain
 * object) cardId → comment array, `nowMs` the injected clock, `silenceMs`
 * the window.
 */
export function pickStalledCards(cards, { listNames, comments, nowMs, silenceMs, isBusy = () => false } = {}) {
  const names = listNames instanceof Map ? listNames : new Map(Object.entries(listNames ?? {}));
  const cmts = comments instanceof Map ? comments : new Map(Object.entries(comments ?? {}));
  return (Array.isArray(cards) ? cards : []).map((card) => {
    const listName = names.get(card.idList);
    const base = { card, listName: listName ?? '', lastCommentAt: null, silentMs: null };
    if (!listName) return { ...base, reason: 'silent-ok' }; // not in-flight / closed — never stalls
    if (isBusy(card.id)) return { ...base, reason: 'busy' };
    const list = newestFirst(cmts.get(card.id));
    if (!list.length) return { ...base, reason: 'silent-ok' }; // zero comments → silence unprovable
    const top = list[0];
    if (!Number.isFinite(top.ms)) return { ...base, reason: 'silent-ok' }; // undated newest → unprovable
    const entry = { ...base, lastCommentAt: top.c?.date ?? null, silentMs: Math.max(0, nowMs - top.ms) };
    if (isHumanText(top.c)) return { ...entry, reason: 'human-latest' };
    if (isAskPending(cmts.get(card.id))) return { ...entry, reason: 'ask-pending' };
    if (entry.silentMs <= silenceMs) return { ...entry, reason: 'silent-ok' };
    return { ...entry, reason: 'stalled' };
  });
}

/** `stalled (orphan, silent <n> min)` — the handleRunCrash code for sweeps. */
function stallCode(silentMs) {
  return `stalled (orphan, silent ${Math.floor(silentMs / 60_000)} min)`;
}

// ---------------------------------------------------------------------------
// Standalone defaults (the daemon injects its own seams instead)
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget headless recovery run for CLI-standalone live mode — the
 * same guards as the daemon's spawnResumeRun (log file, fd stdio, cwd ROOT).
 * The daemon passes its own spawn so recovery runs register in its runs
 * map/cap; tests inject a fake. Resolves once the child exists.
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
 * Default recovery seam for CLI-standalone live mode: the daemon's crash
 * machinery (decide → comment → resume/requeue/park) with the local spawn.
 * The Ready list is fetched lazily once (requeue mode needs it); fetch
 * failure → no readyList, which handleRunCrash handles by leaving a requeue
 * decision untouched with a log line. Never rejects internally.
 */
async function defaultRecover(card, code, { log = console.log, shuttingDown = () => false, board = undefined } = {}) {
  let readyList;
  try {
    // FM-2 (docs/factory-migration.md §4.3): board-scoped fetch; undefined → trello.js default board.
    const lists = await trello.getLists({ board });
    readyList = lists.find((l) => !l.closed && String(l.name).toLowerCase() === 'ready');
  } catch (e) {
    log(`[stall-sweep] Ready list unavailable (${String(e?.message ?? e)}); requeue moves leave the card untouched`);
  }
  await handleRunCrash({ card, code, t: trello, readyList, log, spawnResumeRun: defaultSpawnRun, shuttingDown });
}

// ---------------------------------------------------------------------------
// The sweep watch
// ---------------------------------------------------------------------------

/**
 * Sweep the in-flight lists forever (or exactly one cycle when `once`) and
 * recover stalled orphan cards through `recover` (default the standalone
 * crash path; the daemon passes its `crashRecovery` closure so recovery runs
 * share its cap/spawn/shutdown wiring). Returns `{ …totals }` after the
 * `once` cycle (plus `ok: false` when the tick died on fetch); continuous
 * mode never returns UNLESS `shouldStop` flips — the loop then returns
 * `{ ok: true, stopped: true, …totals }` between ticks (identical supervision
 * contract to runCommentResumeWatch; counts ACCUMULATE across ticks).
 *
 * `dryRun` = pure read: reports would-resume candidates (`wouldResume` +
 * `WOULD-RESUME` log lines) and ask-pending holds (`askHeld` + `HOLD-ASK`
 * lines) with ZERO writes — safe to run while the daemon owns the board.
 *
 * Per stalled card, in order: `freeSlots() < 1` → log + retry next tick
 * (at-least-once); `dryRun` → report only; else `recover(card, stallCode)`
 * — a reject is logged, the card retried next tick (the `[DAEMON-CRASH]`
 * comment from a completed half bounds retries via the comment-derived cap).
 * NEVER rejects on internal errors.
 */
export async function runStallSweepWatch({
  intervalMs = envNum('FACTORY_STALL_POLL_MS', 300_000),
  silenceMs = defaultSilenceMs(),
  once = false,
  dryRun = false,
  shouldStop = undefined,
  t = trello,
  board = undefined, // FM-2 (docs/factory-migration.md §4.3): multi-board target for the tick's board-scoped calls; undefined → trello.js default (byte-identical)
  recover = undefined,
  isBusy = () => false,
  freeSlots = () => Infinity,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
} = {}) {
  log(`[stall-sweep] sweeping in-flight cards every ${intervalMs}ms, silence window ${silenceMs}ms${once ? ' (once)' : ''}${dryRun ? ' (dry-run)' : ''}`);
  const stopped = () => shouldStop?.() === true;
  const recoverCard =
    recover ?? ((card, code) => defaultRecover(card, code, { log, shuttingDown: stopped, board }));
  const empty = () => ({
    checked: 0,
    stalled: 0,
    recovered: 0,
    busySkipped: 0,
    humanSkipped: 0,
    silentOkSkipped: 0,
    deferred: 0,
    wouldResume: [],
    askHeld: [],
  });
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
    } catch (e) {
      // Includes assertCreds() throws and a missing in-flight list: transient.
      log(`[stall-sweep] fetch failed: ${String(e?.message ?? e)}; skipping tick`);
      if (once) return { ok: false, ...counts };
      if (stopped()) return { ok: true, stopped: true, ...last };
      await sleep(intervalMs);
      continue;
    }
    const comments = new Map();
    const inFlight = selectInFlight(cards, listIds);
    for (const card of inFlight) {
      counts.checked += 1;
      try {
        comments.set(card.id, await t.getCardComments(card.id));
      } catch (e) {
        log(`[stall-sweep] comment fetch failed for ${card.id}: ${String(e?.message ?? e)}; will retry`);
      }
    }
    for (const v of pickStalledCards(inFlight, {
      listNames,
      comments,
      nowMs: now(),
      silenceMs,
      isBusy,
    })) {
      const { card, listName, lastCommentAt, silentMs, reason } = v;
      if (reason === 'busy') {
        counts.busySkipped += 1;
        log(`[stall-sweep] ${card.id}: live run owns the card — skipped`);
      } else if (reason === 'human-latest') {
        counts.humanSkipped += 1;
        log(`[stall-sweep] ${card.id}: human comment owns the reply (comment-resume watcher) — skipped`);
      } else if (reason === 'ask-pending') {
        counts.askHeld.push({ card: card.id, name: card.name, list: listName });
        log(`HOLD-ASK ${card.id} "${card.name}" — pending [ASK] owns the reply (${listName})`);
      } else if (reason === 'silent-ok') {
        counts.silentOkSkipped += 1;
      } else if (freeSlots() < 1) {
        counts.deferred += 1;
        log(`[stall-sweep] ${card.id}: no free slot — stall recovery deferred to next tick`);
      } else if (dryRun) {
        counts.stalled += 1;
        counts.wouldResume.push({
          card: card.id,
          name: card.name,
          list: listName,
          resumeStage: deriveResumeStage({ listName, comments: comments.get(card.id) }),
          lastCommentAt,
          silentMs,
        });
        log(`WOULD-RESUME ${card.id} "${card.name}" at ${listName} (silent ${Math.floor((silentMs ?? 0) / 60_000)} min, last comment ${lastCommentAt})`);
      } else {
        counts.stalled += 1;
        try {
          await recoverCard(card, stallCode(silentMs));
          counts.recovered += 1;
          log(`STALL-RECOVER ${card.id} "${card.name}" at ${listName} (silent ${Math.floor((silentMs ?? 0) / 60_000)} min)`);
        } catch (e) {
          log(`[stall-sweep] recovery failed for ${card.id}: ${String(e?.message ?? e)}; will retry`);
        }
      }
    }
    last = {
      checked: last.checked + counts.checked,
      stalled: last.stalled + counts.stalled,
      recovered: last.recovered + counts.recovered,
      busySkipped: last.busySkipped + counts.busySkipped,
      humanSkipped: last.humanSkipped + counts.humanSkipped,
      silentOkSkipped: last.silentOkSkipped + counts.silentOkSkipped,
      deferred: last.deferred + counts.deferred,
      wouldResume: [...last.wouldResume, ...counts.wouldResume],
      askHeld: [...last.askHeld, ...counts.askHeld],
    };
    if (once) return { ok: true, ...last };
    if (stopped()) return { ok: true, stopped: true, ...last };
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Boot pass + supervision (daemon integration)
// ---------------------------------------------------------------------------

/**
 * Boot-time orphan pass (replaces the daemon's log-only orphan loop): log the
 * orphan candidates exactly as before, then run ONE live sweep tick — cards
 * stranded by a crash/restart get recovered at boot instead of only being
 * reported. Fetch failures here are logged, never thrown (boot continues).
 * `recover`/`isBusy`/`freeSlots` forward the daemon's seams; defaults serve
 * the standalone case.
 */
export async function bootStallSweep({
  t = trello,
  board = undefined, // FM-2 (docs/factory-migration.md §4.3): boot enumeration + forwarded tick sweep target this board; undefined → trello.js default (byte-identical)
  log = console.log,
  recover = undefined,
  isBusy = () => false,
  freeSlots = () => Infinity,
  silenceMs = defaultSilenceMs(),
  shouldStop = undefined,
  now = () => Date.now(),
} = {}) {
  try {
    const [lists, allCards] = await Promise.all([t.getLists({ board }), t.getBoardCards(undefined, { board })]);
    for (const name of IN_FLIGHT_LISTS) {
      const id = lists.find((l) => !l.closed && String(l.name).toLowerCase() === name.toLowerCase())?.id;
      for (const c of allCards.filter((c) => id && c.idList === id)) {
        log(`orphan candidate: ${c.id} "${c.name}" sits in ${name} with no owned run`);
      }
    }
  } catch (e) {
    log(`[stall-sweep] boot orphan enumeration failed: ${String(e?.message ?? e)}`);
  }
  return runStallSweepWatch({ t, board, once: true, log, recover, isBusy, freeSlots, silenceMs, shouldStop, now });
}

/**
 * Keep the stall sweep alive for the daemon's lifetime — the structural twin
 * of `superviseCommentWatch`. A never-rejecting loop: starts `runWatch` (the
 * real `runStallSweepWatch` by default) once and, whenever its promise
 * settles without honoring `shouldStop` — crash or unexpected resolve —
 * restarts it after `restartMs` ms. Exits when `runWatch` returns
 * `{stopped:true}` or when `shouldStop()` flips at a restart boundary. The
 * sweep owns all stall logic; this supervisor only keeps the loop alive.
 * `recover`/`isBusy`/`freeSlots` are forwarded so the sweep shares the
 * daemon's runs map, concurrency cap, crash-recovery path, and shutdown flag.
 */
export async function superviseStallSweep({
  runWatch = runStallSweepWatch,
  recover = undefined,
  isBusy = () => false,
  freeSlots = () => Infinity,
  log = (msg) => console.log(msg),
  shouldStop = () => false,
  restartMs = 5000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (;;) {
    let res;
    try {
      const opts = { log, shouldStop, isBusy, freeSlots };
      if (recover) opts.recover = recover;
      res = await runWatch(opts);
    } catch (e) {
      log(`[stall-sweep] sweeper crashed (${String(e?.message ?? e)}); restarting in ${restartMs}ms`);
    }
    if (res?.stopped || shouldStop()) return;
    await sleep(restartMs);
    if (shouldStop()) return;
  }
}
