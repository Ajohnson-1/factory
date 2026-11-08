// Done-list pinger for the software factory (card 6ae7941fdf19ee34c911f0ae).
// Pipeline spec: docs/factory.md ("Pinging on Done").
//
// Polls the board's open `Done` list and DMs the owner on Discord once per card
// ARRIVAL. Scheduler moves (moveCard) and human UI drags look identical in
// board state, so a poll-and-diff of card idLists covers both — mover-agnostic
// by construction, same polling philosophy as `factory.js watch`.
//
// Every tick (FACTORY_DONE_POLL_MS → fallback FACTORY_POLL_MS → 15 s) diffs the
// board cards against persisted state (data/factory-done-ping.json):
//   arrival   = card currently in the Done list whose stored entry holds a
//               DIFFERENT list id (it moved in) or is missing entirely (it
//               appeared straight inside Done after the baseline).
//   baseline  = first run (no state file): record every card's idList, ping
//               nothing — cards already sitting in Done never ping.
//   dedup     = an arrival is marked Done in state only AFTER a successful
//               ping ({sent:true}); a failed ping leaves the old entry → next
//               tick retries → at-least-once delivery, survives restarts.
//               Deliberate: losing a ping forever is worse than retry log noise.
//   rotate    = stored doneListId ≠ current Done list id (list deleted and
//               recreated) → re-baseline silently, no ping storm.
//   prune     = ids in state but absent from the board fetch are dropped
//               (archive/cleanup hygiene; bounds state growth).
// Deliberate missed edge (same class as `watch` missing fast Ready churn): a
// card moved into Done and back OUT within one poll interval is not pinged.
//
// Dependency-injectable logic, the factory-ask.js pattern: every seam (trello
// client, notify, state read/write, sleep, log) defaults to the real thing and
// is faked in tests/factoryDonePing.test.js — zero live Trello/Discord there.
// The ping plumbing itself is imported, never copied: `sendOwnerPing` from
// factory-ask.js (webhook override → bot DM; NEVER throws).
// runDoneWatch NEVER rejects on internal errors: fetch/ping/state failures are
// logged and retried next tick — service robustness over fast-fail.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as trello from './trello.js';
import { parseDotEnv } from './trello.js';
import { sendOwnerPing } from './factory-ask.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const fileEnv = parseDotEnv();

// Same private helper as factory-ask.js (reads process env then .env); kept
// local so factory-ask's export surface stays as-is.
function envNum(name, fallback) {
  const n = Number(process.env[name] || fileEnv[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Dedup state file. FM-2 (§4.3): the pollers run one loop per registered
 * board, but the dedup state records a SINGLE `doneListId` — two boards'
 * Done-list ids written alternately would rotate each other every tick
 * (each poller would re-baseline and silently miss arrivals). Non-default
 * boards therefore get their own file (`factory-done-ping.<board>.json`);
 * the default board keeps the legacy filename byte-for-byte (the inline
 * `factory.js move` pinger shares it).
 */
export const STATE_PATH = (board = undefined) =>
  resolve(
    ROOT,
    'data',
    board && board !== trello.BOARD ? `factory-done-ping.${board}.json` : 'factory-done-ping.json',
  );

/**
 * Pure diff core — testable without any IO/timers.
 * `cards` = current board cards `[{id, name, idList, url}]`; `doneListId` = the
 * open Done list's id right now; `seen` = the persisted state object
 * `{ doneListId, seen: { cardId: lastKnownIdList } }`, or null/undefined on the
 * first run; `pruned` = optional array collecting ids dropped from state this
 * tick (present in state, absent from the board fetch).
 * → `{ arrivals: [{id, name, url}], seen, baselined, rotated, pruned }` where
 * `seen` is the merged state to persist: arrivals keep their OLD entry (or stay
 * absent) until the caller advances them after a successful ping — that is what
 * makes delivery at-least-once.
 */
export function detectDoneArrivals(cards, { doneListId, seen, pruned = [] } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const fresh = () => {
    const map = {};
    for (const c of list) map[c.id] = c.idList;
    return { doneListId, seen: map };
  };
  // First run or unusable state → silent re-baseline, zero pings.
  if (seen == null) return { arrivals: [], seen: fresh(), baselined: true, rotated: false, pruned };
  if (seen.doneListId !== doneListId || !seen.seen || typeof seen.seen !== 'object') {
    return { arrivals: [], seen: fresh(), baselined: false, rotated: true, pruned };
  }
  const prev = seen.seen;
  const next = {};
  const arrivals = [];
  for (const c of list) {
    const prior = prev[c.id];
    if (c.idList === doneListId && prior !== doneListId) {
      // moved in (prior = old list id) or appeared straight inside Done (missing).
      arrivals.push({ id: c.id, name: c.name, url: c.url });
      if (prior !== undefined) next[c.id] = prior; // keep stale entry until the ping lands
    } else {
      next[c.id] = c.idList; // steady-Done (no ping) or non-Done: refresh in place
    }
  }
  const present = new Set(list.map((c) => c.id));
  for (const id of Object.keys(prev)) if (!present.has(id)) pruned.push(id);
  return { arrivals, seen: { doneListId, seen: next }, baselined: false, rotated: false, pruned };
}

/** Real state reader → parsed state object, or null on missing/corrupt/unusable.
 * FM-2: takes the board so the default file is the per-board one (§4.3). */
function defaultReadState(board = undefined) {
  let state;
  try {
    state = JSON.parse(readFileSync(STATE_PATH(board), 'utf8'));
  } catch {
    return null;
  }
  return state && typeof state === 'object' && state.seen && typeof state.seen === 'object'
    ? state
    : null;
}

/** Real state writer: mkdir -p data/, temp file + rename (atomic-ish). */
function defaultWriteState(state, board = undefined) {
  const file = STATE_PATH(board);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

/**
 * Poll the Done list forever (or exactly one cycle when `once`) and ping the
 * owner once per arrival. Returns `{ ok, baselined, rotated, arrivals, pinged }`
 * after the `once` cycle only — continuous mode never returns (loop of
 * sleep → fetch → diff → ping → persist) UNLESS `shouldStop` is supplied and
 * flips true: the loop then returns `{ ok: true, stopped: true, …lastCounts }`
 * between ticks (checked at the top of each cycle and right before each
 * sleep), so a supervisor (factory-daemon) can shut the poller down cleanly
 * without killing the process. `shouldStop` defaults to undefined = today's
 * forever semantics; the `done-watch` CLI never passes it.
 */
export async function runDoneWatch({
  listName = 'Done',
  intervalMs = envNum('FACTORY_DONE_POLL_MS', envNum('FACTORY_POLL_MS', 15_000)),
  once = false,
  shouldStop = undefined,
  board = undefined, // FM-2 per-board pass-through, docs/factory-migration.md §4.3
  t = trello,
  notify = sendOwnerPing,
  readState = () => defaultReadState(board), // FM-2: defaults resolve the per-board state file (§4.3)
  writeState = (s) => defaultWriteState(s, board),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
} = {}) {
  log(`[done-ping] watching "${listName}" every ${intervalMs}ms${once ? ' (once)' : ''}`);
  const stopped = () => shouldStop?.() === true;
  let last = { baselined: false, rotated: false, arrivals: [], pinged: 0 };
  for (;;) {
    if (stopped()) return { ok: true, stopped: true, ...last };
    let doneListId;
    let cards;
    try {
      const lists = await t.getLists({ board });
      const list = lists.find(
        (l) => !l.closed && l.name.toLowerCase() === String(listName).toLowerCase(),
      );
      if (!list) throw new Error(`No open list named "${listName}" on the board`);
      doneListId = list.id;
      cards = await t.getBoardCards('id,name,idList,url', { board });
    } catch (e) {
      // Includes assertCreds() throws (missing TRELLO_KEY/TRELLO_TOKEN) and a
      // missing Done list: transient — log and try again next tick.
      log(`[done-ping] poll failed: ${String(e?.message ?? e)}`);
      if (once) return { ok: false };
      if (stopped()) return { ok: true, stopped: true, ...last };
      await sleep(intervalMs);
      continue;
    }
    let seen = null;
    try {
      seen = readState();
    } catch (e) {
      log(`[done-ping] state unreadable (${String(e?.message ?? e)}) — re-baselining`);
      seen = null;
    }
    const pruned = [];
    const diff = detectDoneArrivals(cards, { doneListId, seen, pruned });
    if (diff.baselined) {
      log(`[done-ping] baseline seeded (${Object.keys(diff.seen.seen).length} cards)`);
    } else if (diff.rotated) {
      log('[done-ping] Done list rotated — re-baselined');
    }
    let pinged = 0;
    for (const c of diff.arrivals) {
      try {
        const res = await notify({ text: `✅ Done: ${c.name} — ${c.url}` });
        if (res?.sent) {
          diff.seen.seen[c.id] = doneListId; // advance only on confirmed delivery
          pinged += 1;
          log(`DONE ${c.id} ${c.name}`);
        } else {
          log(`[done-ping] ping failed for ${c.id}: ${res?.error ?? 'unknown error'}; will retry`);
        }
      } catch (e) {
        log(`[done-ping] ping failed for ${c.id}: ${String(e?.message ?? e)}; will retry`);
      }
    }
    try {
      writeState(diff.seen);
    } catch (e) {
      log(`[done-ping] state write failed: ${String(e?.message ?? e)}`);
    }
    last = { baselined: diff.baselined, rotated: diff.rotated, arrivals: diff.arrivals, pinged };
    if (once) {
      return { ok: true, ...last };
    }
    if (stopped()) return { ok: true, stopped: true, ...last };
    await sleep(intervalMs);
  }
}

/**
 * Inline Done-arrival ping for the scheduler path (card 6ae7941fdf19ee34c911f0ae
 * re-run): `factory.js move <card> Done` calls this right after verifying the
 * card landed, so the owner gets pinged even when NO `done-watch` poller is
 * running. Shares the poller's state file and rules for exact-once semantics:
 *
 *   dedup     = skip (no send, no write) when state already records this card
 *               in `doneListId` — the poller (or an earlier move) pinged it.
 *   advance   = mark the card Done in the SAME state the poller reads, only
 *               after `{sent:true}` (at-least-once parity); a failed send
 *               leaves state untouched so a live poller retries next tick.
 *   fresh     = missing/corrupt/rotated state → seed a FULL baseline of the
 *               board first (same builder the poller uses) before recording
 *               this card; a one-entry file would make the poller treat every
 *               other Done card as a fresh arrival (ping storm).
 *
 * NEVER throws/rejects: notify/read/write/fetch failures are logged. Returns
 * `{ skipped: 'already-pinged' }`, `{ sent: false, error }`, or `{ sent: true }`.
 */
export async function pingDoneArrival({
  card, // { id, name, url } — the card that just landed in Done
  doneListId, // resolved Done list id (caller already knows it)
  board = undefined, // FM-2 per-board pass-through, docs/factory-migration.md §4.3
  t = trello,
  notify = sendOwnerPing,
  readState = () => defaultReadState(board), // FM-2: shares the poller's per-board state file (§4.3)
  writeState = (s) => defaultWriteState(s, board),
  log = console.log,
} = {}) {
  let state = null;
  try {
    state = readState();
  } catch (e) {
    log(`[done-ping] inline: state unreadable (${String(e?.message ?? e)}) — treating as fresh`);
    state = null;
  }
  if (state?.seen?.[card.id] === doneListId) {
    return { skipped: 'already-pinged' }; // poller or earlier move already pinged
  }
  let res;
  try {
    res = await notify({ text: `✅ Done: ${card.name} — ${card.url}` });
  } catch (e) {
    log(`[done-ping] inline ping failed for ${card.id}: ${String(e?.message ?? e)}; poller will retry`);
    return { sent: false, error: String(e?.message ?? e) };
  }
  if (!res?.sent) {
    const error = res?.error ?? 'unknown error';
    log(`[done-ping] inline ping failed for ${card.id}: ${error}; poller will retry`);
    return { sent: false, error };
  }
  // Delivered → advance shared state so the poller never re-pings this arrival.
  let next;
  if (state && state.doneListId === doneListId && state.seen && typeof state.seen === 'object') {
    next = { ...state, seen: { ...state.seen, [card.id]: doneListId } }; // preserve other entries
  } else {
    // Fresh/corrupt/rotated: full baseline first, then mark this card pinged.
    try {
      const cards = await t.getBoardCards('id,name,idList,url', { board });
      const built = detectDoneArrivals(cards, { doneListId, seen: null });
      next = { ...built.seen, seen: { ...built.seen.seen, [card.id]: doneListId } };
    } catch (e) {
      // Cannot build a storm-safe baseline; leave state alone (a later poller
      // re-baselines silently) and keep the at-least-once delivery result.
      log(`[done-ping] inline: baseline fetch failed (${String(e?.message ?? e)}) — state not advanced`);
      log(`DONE ${card.id} ${card.name} (inline)`);
      return { sent: true };
    }
  }
  try {
    writeState(next);
  } catch (e) {
    log(`[done-ping] inline: state write failed: ${String(e?.message ?? e)}`);
  }
  log(`DONE ${card.id} ${card.name} (inline)`);
  return { sent: true };
}
