// Independent blocking-checks gate for the software factory (card
// 6ae9677239bb2697a13ea728; docs/factory.md "Independent blocking checks").
//
// Root cause this fixes: `npm test` ran only INSIDE agent sessions (the
// implementer's evidence run, the QA agent's procedure, the post-merge check)
// — enforcement was agent discipline, waivable by a lying or crashed run.
// This module moves execution into the deterministic layer: the daemon runs
// the blocking suite itself against the card's worktree tip and acts on the
// exit code — no LLM can skip it. A non-zero exit is treated exactly like
// `[VERIFY:FAIL]`: bounce to Implement, counted toward the 3-bounce rule.
//
// Trigger: a card sitting in QA (no needs-human label) whose LATEST stage tag
// is `[QA:PASS]` (the suite then covers the exact commit about to be merged)
// and whose worktree-tip sha differs from the sha recorded in
// data/factory-blocking-checks.json — the watermark makes checks
// exactly-once per tip across daemon restarts; a bounce + new `[IMPL]`
// commit changes the sha → automatic re-check. The bounce move itself is
// at-least-once: a FAIL entry keeps `moved:false` until the card actually
// reaches Implement, so a transient Trello error on the move is retried on
// a later tick MOVE-ONLY (the `[CHECK:FAIL]` comment is never re-posted,
// the suite never re-runs) — without that marker the posted FAIL comment
// (now the latest stage tag) would strand the card in QA forever. Verdicts are `[CHECK:PASS]` /
// `[CHECK:FAIL]` — scheduler-bookkeeping tags (same class as `[DEPLOY]` /
// `[DAEMON-CRASH]` / `[RESUME]`: posted by the deterministic layer, so the
// "one comment per stage" rule is untouched). `[CHECK:FAIL]` embeds the
// failing command, exit code, and output tail (the `[DAEMON-CRASH]`-embeds-
// log-tail precedent; reuse of `crashTail` newest-first / ≤40 lines / ≤4000
// chars caps). On FAIL the card is moved back to Implement ONLY if it is
// still in QA when the suite finishes — the live run may merge+move mid-
// suite, and the watcher re-checks list membership immediately before the
// bounce move (a moved card gets the verdict comment, no cross-list bounce).
//
// Dependency-injectable logic, the factory-done-ping.js /
// factory-comment-resume.js pattern: every seam (trello client, git runner,
// command runner, state read/write, sleep, log) defaults to the real thing
// and is faked in tests/factoryBlockingChecks.test.js — zero live Trello
// there. runBlockingChecksWatch NEVER rejects on internal errors: fetch/
// suite/comment/state failures are logged and retried next tick — service
// robustness over fast-fail.

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as trello from './trello.js';
// The board-contract stage-tag set (single source: factory-comment-resume.js;
// the [CHECK:*] verdicts are registered THERE — the comment-resume listener
// must recognize gate comments as bot bookkeeping, and docs/factory.md's tag
// enumeration is kept in lockstep by tests/factoryCommentResume.test.js #33).
// Trigger note: a [CHECK:*] comment can become the card's latest stage tag;
// that never deadlocks the gate — the sha watermark already recorded that
// tip's verdict, and per the board contract the next check needs a new
// commit AND a fresh [IMPL]→[QA:PASS] round, which post newer tags.
import { isStageTagText, latestStageTag } from './factory-comment-resume.js';
// ESM cycle with the daemon (daemon → this lib → daemon) is safe: crashTail
// is a hoisted function declaration and is only dereferenced inside function
// bodies (same pattern as STAGE_SEED_LIST in factory-comment-resume.js).
import { crashTail } from '../factory-daemon.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Dedup watermark state file (gitignored `data/`, self-heals if deleted). */
export const STATE_PATH = () => resolve(ROOT, 'data', 'factory-blocking-checks.json');

export const CHECK_TAG_PASS = '[CHECK:PASS]';
export const CHECK_TAG_FAIL = '[CHECK:FAIL]';

// Bounded output tail per command (same policy as the [DAEMON-CRASH] run-log
// embed: newest ≤40 lines / ≤4000 chars).
const MAX_TAIL_LINES = 40;
const MAX_TAIL_CHARS = 4000;
const MAX_BUFFER = 64 * 1024 * 1024;

// Same private helper as factory-comment-resume.js; kept local so the import
// surface stays as-is. Reads process env only (the daemon supplies its env).
function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * The blocking check suite. Default: `npm test` exactly as package.json
 * defines it (both halves). `FACTORY_CHECK_CMD` overrides with a JSON array
 * of `[cmd, ...args]` entries, e.g. `'[["npm","test"]]'`; invalid JSON or a
 * malformed shape logs and falls back to the default (best-effort board
 * reads philosophy: never crash the loop).
 */
export function checkCommands(env = process.env, { log = console.log } = {}) {
  const raw = env?.FACTORY_CHECK_CMD;
  if (raw == null || String(raw).trim() === '') return [['npm', 'test']];
  try {
    const parsed = JSON.parse(String(raw));
    const valid =
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (c) => Array.isArray(c) && c.length > 0 && c.every((a) => typeof a === 'string' && a.length > 0),
      );
    if (valid) return parsed;
  } catch {
    /* fall through to the default below */
  }
  log(`[blocking-checks] ignoring FACTORY_CHECK_CMD (want a JSON array of [cmd, ...args]): ${String(raw).slice(0, 120)}`);
  return [['npm', 'test']];
}

/** The card's worktree path — exact bootstrap location (docs/factory.md "Isolation"). */
export function worktreePath(cardId, root = ROOT) {
  return resolve(root, '..', 'discord-bot-factory-wt', String(cardId));
}

/** Real git runner: execFileSync in the MAIN repo (refs are shared across
 * worktrees), trimmed stdout, throws on non-zero exit. */
function defaultGit(argv) {
  return execFileSync('git', argv, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The branch tip sha, or null when the branch is missing/git failed (skip
 * this tick, retry next tick). Run in the main repo — worktrees share refs.
 */
export function tipShaOf(branch, { git = defaultGit } = {}) {
  try {
    const out = String(git(['rev-parse', String(branch)]) ?? '').trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Pure trigger core: cards sitting in `qaListId` WITHOUT the needs-human
 * label whose `shaOf` result differs from the recorded watermark sha AND
 * whose LATEST stage tag (read via `latestTagOf`, default: the card's
 * `latestTag` field — the tick re-derives it from freshly fetched comments
 * before acting) is `[QA:PASS]`. Cards in other lists are never even
 * sha-resolved. `shaOf` → null (missing branch / git failed) → skip, retry
 * next tick. Sha is resolved BEFORE the tag check so the tick only pays a
 * comment fetch for cards whose tip actually changed.
 */
export function planChecks({ cards = [], qaListId, state, shaOf = () => null, latestTagOf = (card) => card?.latestTag } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const triggers = [];
  for (const card of list) {
    if (!card || card.idList !== qaListId) continue;
    if ((card.labels ?? []).some((l) => l?.name === 'needs-human')) continue;
    const sha = shaOf(card);
    if (!sha) continue; // branch missing / git failed → retry next tick
    const rec = state?.[card.id];
    if (rec && rec.sha === sha) continue; // already checked at this tip
    // A KNOWN tag that isn't `[QA:PASS]` skips. An UNKNOWN tag (the board
    // card field is absent — the tick never fetches comments up front) is
    // carried: `tickBlockingChecks` re-derives the latest tag from freshly
    // fetched comments and applies the same gate there, authoritatively.
    const known = latestTagOf(card);
    if (known != null && isStageTagText(known) !== '[QA:PASS]') continue;
    triggers.push({ card, sha });
  }
  return triggers;
}

/**
 * Pure retry planner for PENDING bounce moves (finding #3, card
 * 6ae9677239bb2697a13ea728): a transient `moveCard` failure on the FAIL
 * path must not strand the card in QA forever. Once the `[CHECK:FAIL]`
 * verdict comment is posted it becomes the latest stage tag, so the
 * `[QA:PASS]` trigger above can NEVER re-fire for this sha — the watermark
 * entry `{ sha, verdict:'fail', moved:false }` is the card's only way back.
 * Returns QA-list, non-needs-human cards whose recorded FAIL at the CURRENT
 * tip sha is still un-settled: `tickBlockingChecks` retries the MOVE ONLY
 * (the marker says the comment already landed — no suite re-run, no second
 * `[CHECK:FAIL]`; at-least-once, spam-free). Entries with `moved` unset or
 * true are settled business; a sha that moved on is a NEW tip the next
 * `[QA:PASS]` round re-checks (the pending verdict is stale), so it drops
 * out here. `shaOf` → null (git failed) → skip, retry next tick.
 */
export function planMoveRetries({ cards = [], qaListId, state, shaOf = () => null } = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const retries = [];
  for (const card of list) {
    if (!card || card.idList !== qaListId) continue;
    if ((card.labels ?? []).some((l) => l?.name === 'needs-human')) continue;
    const rec = state?.[card.id];
    if (rec?.verdict !== 'fail' || rec.moved !== false) continue;
    const sha = shaOf(card);
    if (!sha || sha !== rec.sha) continue; // git failed / new tip → not ours
    retries.push({ card, sha });
  }
  return retries;
}

/** Collapse the output tail of each command into bounded, newest-last lines.
 * Prefers the pre-bounded `tail` `runCheckSuite` attaches; falls back to
 * raw stdout/stderr (direct `checkCommentText` callers, e.g. tests). */
function tailBlock(results) {
  const parts = [];
  for (const r of results ?? []) {
    const tail =
      r?.tail != null
        ? String(r.tail)
        : crashTail(String(r?.stdout ?? '') + String(r?.stderr ?? ''), {
            maxLines: MAX_TAIL_LINES,
            maxChars: MAX_TAIL_CHARS,
          });
    parts.push(`--- ${r?.cmd} exit ${r?.exit} ---\n${tail}`);
  }
  return parts.join('\n');
}

/**
 * The `[CHECK:PASS]` / `[CHECK:FAIL]` comment text. First line is
 * byte-stable: `[CHECK:PASS] all <n> blocking checks green at sha=<short> —
 * <cmd>=<exit> …`, FAIL names the failing command + exit code, followed by
 * bounded per-command output tails (newest last, crashTail caps).
 */
export function checkCommentText({ pass, sha, results = [] } = {}) {
  const short = String(sha ?? '').slice(0, 10);
  const summary = (results ?? [])
    .map((r) => `${String(r?.cmd ?? '?')}=${r?.exit ?? '?'}`)
    .join(' ');
  const head = pass
    ? `${CHECK_TAG_PASS} all ${results.length} blocking checks green at sha=${short} — ${summary}`
    : (() => {
        const bad = (results ?? []).find((r) => r?.exit !== 0);
        return (
          `${CHECK_TAG_FAIL} \`${bad?.cmd ?? '?'}\` exited ${bad?.exit ?? '?'} at sha=${short} — bouncing to Implement (counts). ` +
          'Run `git diff` in the worktree and fix, then push (a new tip sha re-triggers the gate).'
        );
      })();
  const block = tailBlock(results);
  return block ? `${head}\n\n--- output tail ---\n${block}` : head;
}

/** Real per-command runner: execFile in the worktree, 64 MB buffer,
 * NODE_OPTIONS inherited from process.env. Resolves the exit code; spawn
 * errors resolve as exit null with the message captured on stderr. */
function defaultRun({ cmd, args = [], cwd }) {
  return new Promise((resolveRun) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8', env: process.env },
      (err, stdout, stderr) => {
        if (err && err.code != null && !Number.isInteger(err.code)) {
          // spawn failure (ENOENT etc.): err.code is a string — record exit
          // null and fold the message into stderr so the tail shows it.
          resolveRun({ exit: null, stdout: String(stdout ?? ''), stderr: `${String(stderr ?? '')}\n${err.message}` });
          return;
        }
        resolveRun({ exit: err ? (err.code ?? null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/**
 * Run the blocking suite SEQUENTIALLY in `worktree`; first non-zero exit
 * stops the suite (boring — the first failing command is the actionable
 * one). Returns `{ pass, results: [{ cmd, exit, tail }] }`.
 */
export async function runCheckSuite({ worktree, commands, run = defaultRun } = {}) {
  const results = [];
  let pass = true;
  for (const [cmd, ...args] of commands ?? []) {
    const res = await run({ cmd, args, cwd: worktree });
    const tail = crashTail(String(res?.stdout ?? '') + String(res?.stderr ?? ''), {
      maxLines: MAX_TAIL_LINES,
      maxChars: MAX_TAIL_CHARS,
    });
    results.push({ cmd: String(cmd), exit: res?.exit ?? null, tail, stdout: String(res?.stdout ?? ''), stderr: String(res?.stderr ?? '') });
    if (res?.exit !== 0) {
      pass = false;
      break;
    }
  }
  return { pass, results };
}

/** Real state reader → parsed `{ <cardId>: { sha, verdict, ts, moved? } }`,
 * or {} on missing/corrupt/unusable (self-heal: treat as fresh). */
function defaultReadState() {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH(), 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

/** Real state writer: mkdir -p data/, temp file + rename (atomic — the
 * comment-resume writeState pattern). */
function defaultWriteState(state) {
  const file = STATE_PATH();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

// FM-2 (docs/factory-migration.md §4.3): `opts` carries the optional `board`
// for the board-scoped getLists call; undefined → trello.js default board.
async function findOpenList(listName, t, opts = {}) {
  const lists = await t.getLists(opts);
  return (lists ?? []).find((l) => !l.closed && String(l.name).toLowerCase() === listName);
}

/**
 * One check cycle: find the QA (+ Implement fallback) list ids, read the
 * watermark state, `planChecks`, and for each trigger: fetch comments →
 * derive the latest stage tag → run the suite → post the verdict → on FAIL
 * and STILL IN QA → `moveCard` to Implement → write state atomically. A
 * FAIL entry carries `moved:false` until the bounce actually lands; the
 * `planMoveRetries` candidates from earlier ticks (move failed transiently)
 * are processed after the triggers, MOVE ONLY — no suite re-run, no second
 * verdict comment. `shouldStop()` is honored between cards. Fail-open on
 * board fetch errors (log, return `{ ok: false }` — never throws). Returns
 * the tick summary.
 */
export async function tickBlockingChecks({
  t = trello,
  board = undefined, // FM-2 (docs/factory-migration.md §4.3): list/card-fetch calls target this board; undefined → trello.js default (byte-identical)
  worktreeOf = undefined, // FM-2 — the daemon injects a registry-driven resolver (config/factory-repos.json worktreeRoot); undefined keeps today's discord-bot default byte-identical
  gitFor = undefined, // FM-2 — (card) => git runner of the card's ROUTED repo (branch refs live in that repo); undefined → the single `git` runner (byte-identical today)
  git = defaultGit,
  run = defaultRun,
  readState = defaultReadState,
  writeState = defaultWriteState,
  commands = checkCommands(),
  shouldStop = () => false,
  log = console.log,
} = {}) {
  const summary = { checked: 0, pass: 0, fail: 0, bounced: 0, movedOutOfQa: 0, pruned: [], ok: true };
  let qaList, implList, cards;
  try {
    qaList = await findOpenList('qa', t, { board });
    implList = await findOpenList('implement', t, { board });
    if (!qaList) throw new Error('no open QA list on the board');
    cards = await t.getBoardCards('id,name,idList,labels,url', { board });
  } catch (e) {
    // assertCreds() throws / transient API errors — skip the tick (comment-
    // resume philosophy); the loop retries next tick.
    log(`[blocking-checks] poll failed: ${String(e?.message ?? e)}; skipping tick`);
    return { ...summary, ok: false };
  }

  let state;
  try {
    state = readState();
  } catch (e) {
    log(`[blocking-checks] state unreadable (${String(e?.message ?? e)}) — treating watermarks as absent`);
    state = {};
  }
  const persist = () => {
    try {
      writeState(state);
    } catch (e) {
      log(`[blocking-checks] state write failed: ${String(e?.message ?? e)}`);
    }
  };

  // Bounce a FAILed card to Implement, re-checking list membership
  // IMMEDIATELY before the move: the live run may have merged + moved the
  // card out of QA while the suite ran — a card that already left QA keeps
  // its FAIL verdict comment but is NOT bounced across lists (docs/factory.md
  // "Independent blocking checks" — race note). Resolves true when the
  // bounce is SETTLED (the card moved, or it left QA on its own — nothing
  // owed), false when the fetch/move failed transiently (a later tick
  // retries via `planMoveRetries`). Never throws; the summary counters
  // account for both paths.
  const settleBounceMove = async (card, sha) => {
    try {
      const fresh = await t.getCard(card.id, 'id,idList');
      if (fresh?.idList === qaList.id && implList) {
        await t.moveCard(card.id, implList.id);
        summary.bounced += 1;
        log(`CHECK:FAIL ${card.id} at sha=${sha.slice(0, 10)} — bounced to Implement (counts)`);
      } else {
        summary.movedOutOfQa += 1;
        log(`CHECK:FAIL ${card.id} at sha=${sha.slice(0, 10)} — card no longer in QA; verdict posted, no move`);
      }
      return true;
    } catch (e) {
      log(
        `[blocking-checks] bounce move failed for ${card.id}: ${String(e?.message ?? e)}; ` +
          'watermark stays pending — the move is retried next tick',
      );
      return false;
    }
  };

  // FM-2 (§4.4): a routed card's branch refs live in ITS repo (worktrees
  // share refs per repo), so with `gitFor` injected the tip read runs in the
  // routed repoDir; without it the single runner = today's ROOT byte-for-byte.
  const shaOfCard = (card) => tipShaOf(`factory/${card.id}`, { git: gitFor ? gitFor(card) : git });
  const triggers = planChecks({ cards, qaListId: qaList.id, state, shaOf: shaOfCard });
  // Bounce moves owed from earlier ticks (moved:false at the current tip).
  const retries = planMoveRetries({ cards, qaListId: qaList.id, state, shaOf: shaOfCard });

  for (const { card, sha } of triggers) {
    if (shouldStop()) break;
    let comments;
    try {
      comments = await t.getCardComments(card.id);
    } catch (e) {
      log(`[blocking-checks] comment fetch failed for ${card.id}: ${String(e?.message ?? e)}; will retry`);
      continue;
    }
    // Latest stage tag read the same way every stage agent does — the tag
    // rules live in factory-comment-resume.js (single source of truth).
    const latest = latestStageTag(comments)?.tag ?? null;
    if (latest !== '[QA:PASS]') {
      log(`[blocking-checks] ${card.id}: latest stage tag is ${latest ?? '(none)'}, not [QA:PASS] — skipping`);
      continue;
    }
    // FM-2 (§4.3): registry-driven worktree resolver when injected; the
    // default keeps today's discord-bot path byte-identical.
    const wt = worktreeOf ? worktreeOf(card) : worktreePath(card.id);
    const { pass, results } = await runCheckSuite({
      worktree: wt,
      commands,
      run,
    });
    try {
      await t.addComment(card.id, checkCommentText({ pass, sha, results }));
    } catch (e) {
      // Comment failure: watermark NOT advanced → retry next tick (the sha
      // still mismatches, so the suite re-runs — at-least-once, spam-free).
      log(`[blocking-checks] verdict comment failed for ${card.id}: ${String(e?.message ?? e)}; will retry`);
      continue;
    }
    summary.checked += 1;
    if (pass) {
      summary.pass += 1;
      state[card.id] = { sha, verdict: 'pass', ts: new Date().toISOString() };
      persist();
      log(`CHECK:PASS ${card.id} at sha=${sha.slice(0, 10)}`);
      continue;
    }
    summary.fail += 1;
    // Record the marker BEFORE the move attempt: `moved:false` says the
    // bounce is owed. A transient moveCard failure must never strand the
    // card — with the watermark advanced and the just-posted [CHECK:FAIL]
    // now the latest stage tag, the [QA:PASS] trigger can never re-fire
    // for this sha, so the marker (a planMoveRetries candidate) is the
    // only path back: a later tick retries the MOVE, and because the
    // marker also says the verdict comment landed, the re-fire re-runs
    // neither the suite nor the comment (at-least-once, spam-free).
    state[card.id] = { sha, verdict: 'fail', ts: new Date().toISOString(), moved: false };
    persist();
    if (await settleBounceMove(card, sha)) {
      state[card.id] = { ...state[card.id], moved: true };
      persist();
    }
  }

  // Settle bounce moves owed from earlier ticks. Move-only, by contract
  // with the marker: the [CHECK:FAIL] comment already landed, so neither
  // the suite nor the board sees a duplicate. A card that left QA in the
  // meantime settles untouched (a human dragged it, or a mid-suite race
  // moved it); a new tip drops it out of the retry list (the next
  // [QA:PASS] round re-checks the new sha authoritatively).
  for (const { card, sha } of retries) {
    if (shouldStop()) break;
    if (await settleBounceMove(card, sha)) {
      state[card.id] = { ...state[card.id], moved: true };
      persist();
    }
  }

  // Prune cards that vanished from the board fetch (bounds state growth —
  // comment-resume precedent).
  const present = new Set((Array.isArray(cards) ? cards : []).map((c) => c?.id));
  for (const id of Object.keys(state)) {
    if (!present.has(id)) {
      delete state[id];
      summary.pruned.push(id);
    }
  }
  persist();
  return summary;
}

/**
 * Poll the QA list forever (or exactly one cycle when `once`) and run the
 * blocking suite against every QA-passed card tip not yet checked. Same
 * supervision contract as runDoneWatch / runCommentResumeWatch: never
 * rejects on board errors, returns `{ ok: true, stopped: true, …totals }`
 * when `shouldStop` flips between ticks (counts ACCUMULATE across ticks).
 */
export async function runBlockingChecksWatch({
  once = false,
  intervalMs = envNum('FACTORY_CHECK_INTERVAL_MS', envNum('FACTORY_POLL_MS', 15_000)),
  shouldStop = undefined,
  t = trello,
  board = undefined, // FM-2 (docs/factory-migration.md §4.3): forwarded to every tick; undefined → trello.js default (byte-identical)
  worktreeOf = undefined, // FM-2 — the daemon injects a registry-driven resolver (config/factory-repos.json worktreeRoot); undefined keeps today's discord-bot default byte-identical
  gitFor = undefined, // FM-2 — (card) => git runner of the card's routed repo; undefined → `git` (byte-identical today)
  git = defaultGit,
  run = defaultRun,
  readState = defaultReadState,
  writeState = defaultWriteState,
  commands = checkCommands(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
} = {}) {
  log(
    `[blocking-checks] watching QA-list cards every ${intervalMs}ms${once ? ' (once)' : ''}: suite ${JSON.stringify(commands)}`,
  );
  const stopped = () => shouldStop?.() === true;
  const empty = () => ({ checked: 0, pass: 0, fail: 0, bounced: 0, movedOutOfQa: 0, pruned: [] });
  let last = empty();
  for (;;) {
    if (stopped()) return { ok: true, stopped: true, ...last };
    const res = await tickBlockingChecks({ t, board, worktreeOf, gitFor, git, run, readState, writeState, commands, shouldStop: stopped, log });
    const { ok, pruned = [], ...counts } = res;
    last = {
      checked: last.checked + counts.checked,
      pass: last.pass + counts.pass,
      fail: last.fail + counts.fail,
      bounced: last.bounced + counts.bounced,
      movedOutOfQa: last.movedOutOfQa + counts.movedOutOfQa,
      pruned: [...last.pruned, ...pruned],
    };
    if (once) return { ok, ...last };
    if (stopped()) return { ok: true, stopped: true, ...last };
    await sleep(intervalMs);
  }
}
