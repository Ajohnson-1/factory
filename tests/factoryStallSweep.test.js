// Stall sweep invariants (card 6aebab9a65613358f4ca333a — docs/factory.md
// "Auto-start daemon": exit-0-without-advance + orphaned-card recovery).
// Zero live Trello: every seam (trello client, recover, isBusy, freeSlots,
// clock, sleep, log) is faked — the runCommentResumeWatch.test.js pattern.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseMaxTimeMs,
  defaultSilenceMs,
  pickStalledCards,
  runStallSweepWatch,
  bootStallSweep,
  superviseStallSweep,
} from '../scripts/lib/factory-stall-sweep.js';

// ---- fixtures ---------------------------------------------------------------

const TODO = 'todo000000000000000000001';
const READY = 'ready00000000000000000001';
const PLAN = 'plan000000000000000000001';
const IMPLEMENT = 'imple00000000000000000001';
const REVIEW = 'review000000000000000001';
const QA = 'qa00000000000000000000001';
const DEPLOY = 'deploy000000000000000001';
const VERIFY = 'verify000000000000000001';
const DONE = 'done00000000000000000001';
const CLOSED = 'closed000000000000000001';

const LISTS = [
  { id: TODO, name: 'To Do', closed: false },
  { id: READY, name: 'Ready', closed: false },
  { id: PLAN, name: 'Plan', closed: false },
  { id: IMPLEMENT, name: 'Implement', closed: false },
  { id: REVIEW, name: 'Review', closed: false },
  { id: QA, name: 'QA', closed: false },
  { id: DEPLOY, name: 'Deploy', closed: false },
  { id: VERIFY, name: 'Verify', closed: false },
  { id: DONE, name: 'Done', closed: false },
  { id: CLOSED, name: 'Implement', closed: true }, // rotated/closed never counts
];
const IN_FLIGHT = { plan: PLAN, impl: IMPLEMENT, review: REVIEW, qa: QA, deploy: DEPLOY, verify: VERIFY };
const BOT = { id: 'botid', username: 'factorybot', fullName: 'Factory Bot' };
const HUMAN = { id: 'humid', username: 'andrew', fullName: 'Andrew' };

// Fixed clock; the DEFAULT silence window (FACTORY_MAX_TIME 12h + 15 min grace).
const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const SILENCE = 44_100_000; // 12h + 15 min grace
const ago = (ms) => new Date(NOW - ms).toISOString();
const stalledDate = ago(SILENCE + 3_600_000); // silent window+1h > window
const freshDate = ago(60_000); // 1 min ago — well inside the window

const card = (id, name, idList, labels = []) => ({
  id,
  name,
  idList,
  labels,
  url: `https://trello.com/c/${id}/name`,
});
const cmt = (id, date, text, member = BOT) => ({ id, date, data: { text }, memberCreator: member });

/** Fake trello client for the sweep: listsSeq/cardsSeq sequences (last
 * sticks), per-card comments (array | Error), throws = getLists throw
 * sequence. Records every call. */
function fakeTrello({ lists = LISTS, cardsSeq = [[]], comments = {}, throws = [] } = {}) {
  const cs = [...cardsSeq];
  const ls = [...throws];
  const take = (seq) => (seq.length > 1 ? seq.shift() : seq[0]);
  const calls = { getLists: 0, getBoardCards: 0, getCardComments: 0, getCardCommentsBy: {}, addComment: 0 };
  return {
    calls,
    async getLists() {
      calls.getLists += 1;
      if (ls.length) {
        const f = ls.length > 1 ? ls.shift() : ls[0];
        if (f instanceof Error) throw f;
      }
      return lists;
    },
    async getBoardCards() {
      calls.getBoardCards += 1;
      const v = take(cs);
      if (v instanceof Error) throw v;
      return v;
    },
    async getCardComments(id) {
      calls.getCardComments += 1;
      calls.getCardCommentsBy[id] = (calls.getCardCommentsBy[id] ?? 0) + 1;
      const v = comments[id] ?? [];
      if (v instanceof Error) throw v;
      return v;
    },
    async addComment() {
      calls.addComment += 1;
      return {};
    },
  };
}

/** Recording recover seam — receives (card, code) exactly as handleRunCrash
 * is called. results = sequence (Error → reject; last sticks). */
function recovery(results = []) {
  const seq = [...results];
  const calls = [];
  return {
    calls,
    recover: async (c, code) => {
      calls.push({ card: c, code });
      const f = seq.length > 1 ? seq.shift() : seq[0];
      if (f instanceof Error) throw f;
      return undefined;
    },
  };
}

function recorder() {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
}

function harness({ t, rc = recovery(), isBusy = () => false, slots = () => 1, silenceMs = SILENCE, ...opts } = {}) {
  const r = recorder();
  return {
    t,
    rc,
    r,
    run: (extra = {}) =>
      runStallSweepWatch({
        t,
        recover: rc.recover,
        isBusy,
        freeSlots: slots,
        silenceMs,
        now: () => NOW,
        log: r.log,
        ...opts,
        ...extra,
      }),
  };
}

// ---- parseMaxTimeMs / defaultSilenceMs -------------------------------------

test('1. parseMaxTimeMs: h/m/s units + bare seconds parse; junk falls back to 12h', () => {
  assert.equal(parseMaxTimeMs('2h'), 7_200_000);
  assert.equal(parseMaxTimeMs('90m'), 5_400_000);
  assert.equal(parseMaxTimeMs('5400s'), 5_400_000);
  assert.equal(parseMaxTimeMs('5400'), 5_400_000); // bare seconds (omp grammar)
  assert.equal(parseMaxTimeMs(' 2H '), 7_200_000); // case + space tolerant
  assert.equal(parseMaxTimeMs('0h'), 43_200_000); // non-positive → fallback
  assert.equal(parseMaxTimeMs('abc'), 43_200_000);
  assert.equal(parseMaxTimeMs('2 days'), 43_200_000);
  assert.equal(parseMaxTimeMs(''), 43_200_000);
  assert.equal(parseMaxTimeMs(undefined), 43_200_000);
  assert.equal(parseMaxTimeMs('garbage', 60_000), 60_000); // custom fallback
});

test('2. defaultSilenceMs = FACTORY_STALL_SILENCE_MS override else max-time+15m', () => {
  const saved = process.env.FACTORY_STALL_SILENCE_MS;
  try {
    delete process.env.FACTORY_STALL_SILENCE_MS;
    assert.equal(defaultSilenceMs(), 43_200_000 + 15 * 60_000); // no knob set → 12h+15m
    process.env.FACTORY_STALL_SILENCE_MS = '12345';
    assert.equal(defaultSilenceMs(), 12345);
  } finally {
    if (saved === undefined) delete process.env.FACTORY_STALL_SILENCE_MS;
    else process.env.FACTORY_STALL_SILENCE_MS = saved;
  }
});

// ---- pickStalledCards (pure classifier table) ------------------------------

const nameFor = { [PLAN]: 'Plan', [IMPLEMENT]: 'Implement', [REVIEW]: 'Review', [QA]: 'QA', [DEPLOY]: 'Deploy', [VERIFY]: 'Verify' };
const listNames = () => new Map(Object.entries(nameFor));

function classify(cards, comments, { isBusy = () => false, silenceMs = SILENCE, nowMs = NOW, names = listNames() } = {}) {
  return pickStalledCards(cards, { listNames: names, comments: new Map(comments), nowMs, silenceMs, isBusy });
}

test('3. pickStalledCards: silence > window stalls at EVERY in-flight list', () => {
  for (const [idList, name] of Object.entries(nameFor)) {
    const [v] = classify(
      [card('c1', 'stalled card', idList)],
      [['c1', [cmt('k1', stalledDate, '[IMPL] evidence committed')]]],
    );
    assert.equal(v.reason, 'stalled', `card in ${name} must stall`);
    assert.equal(v.listName, name);
    assert.equal(v.lastCommentAt, stalledDate);
    assert.equal(v.silentMs, SILENCE + 3_600_000);
  }
});

test('4. pickStalledCards: busy cards skip; non-in-flight lists never stall', () => {
  const c = card('c1', 'busy', IMPLEMENT);
  const comments = [['c1', [cmt('k1', stalledDate, '[IMPL] x')]]];
  assert.equal(classify([c], comments, { isBusy: (id) => id === 'c1' })[0].reason, 'busy');
  for (const idList of [READY, DONE, TODO]) {
    const [v] = classify([card('c2', 'outside', idList)], [['c2', [cmt('k1', stalledDate, '[IMPL] x')]]]);
    assert.equal(v.reason, 'silent-ok', `${idList} list never stalls`);
  }
});

test('5. pickStalledCards: human-latest skips (watcher owns it)', () => {
  // Untagged latest comment = human (bot comments are always tagged).
  const [a] = classify(
    [card('c1', 'human latest', IMPLEMENT)],
    [['c1', [cmt('h1', stalledDate, 're-run with the new model', HUMAN), cmt('k1', ago(10 * 86_400_000), '[IMPL] x')]]],
  );
  assert.equal(a.reason, 'human-latest');
  // A [HUMAN]-tagged relay is also a human comment (ask answer path).
  const [b] = classify(
    [card('c2', 'relay latest', REVIEW)],
    [['c2', [cmt('h2', stalledDate, '[HUMAN] sure, go ahead', BOT)]]],
  );
  assert.equal(b.reason, 'human-latest');
  // [DAEMON-CRASH] latest is BOT-side (hyphenated tag — not human): still stalls.
  const [d] = classify(
    [card('c3', 'crash latest', REVIEW)],
    [['c3', [cmt('k2', stalledDate, '[DAEMON-CRASH] run exited 1; …')]]],
  );
  assert.equal(d.reason, 'stalled');
});

test('6. pickStalledCards: ask-pending holds; a human reply ENDS pending', () => {
  const [pending] = classify(
    [card('c1', 'asked', QA)],
    [['c1', [cmt('a1', stalledDate, '[ASK] which sha do you want?'), cmt('k1', ago(9 * 86_400_000), '[IMPL] x')]]],
  );
  assert.equal(pending.reason, 'ask-pending');
  // Bookkeeping AFTER the ask (crash comment) does NOT erase pending.
  const [crashed] = classify(
    [card('c2', 'asked+crashed', QA)],
    [['c2', [cmt('a2', ago(SILENCE + 7_200_000), '[ASK] waiting'), cmt('k2', stalledDate, '[DAEMON-CRASH] run exited stalled (exit 0 with no verdict)')]]],
  );
  assert.equal(crashed.reason, 'ask-pending');
  // Human reply after the ask → no longer pending. With a BOT comment
  // landing last (the sweep only acts when the watcher's human-latest guard
  // does not fire), the silent card stalls instead of holding.
  const [answered] = classify(
    [card('c3', 'asked+answered', QA)],
    [['c3', [
      cmt('k3', stalledDate, '[DAEMON-CRASH] run exited stalled (exit 0 with no verdict)'),
      cmt('h3', ago(SILENCE + 7_200_000), 'use 197a29ce', HUMAN),
      cmt('a3', ago(9 * 86_400_000), '[ASK] which sha?'),
    ]]],
  );
  assert.equal(answered.reason, 'stalled');
});

test('7. pickStalledCards: silence ≤ window, zero/undated comments never stall', () => {
  const [fresh] = classify(
    [card('c1', 'young', IMPLEMENT)],
    [['c1', [cmt('k1', freshDate, '[IMPL] still working')]]],
  );
  assert.equal(fresh.reason, 'silent-ok');
  const [empty] = classify([card('c2', 'no comments', PLAN)], [['c2', []]]);
  assert.equal(empty.reason, 'silent-ok'); // silence unprovable → fail closed
  const [undated] = classify(
    [card('c3', 'undated', PLAN)],
    [['c3', [cmt('k3', 'not-a-date', '[IMPL] x')]]],
  );
  assert.equal(undated.reason, 'silent-ok');
  // exactly at the window boundary is NOT stalled (older THAN is required)
  const [edge] = classify(
    [card('c4', 'edge', PLAN)],
    [['c4', [cmt('k4', ago(SILENCE), '[IMPL] x')]]],
  );
  assert.equal(edge.reason, 'silent-ok');
});

test('8. pickStalledCards accepts plain-object comment maps (Map or object)', () => {
  const cards = [card('c1', 'obj map', IMPLEMENT)];
  const comments = { c1: [cmt('k1', stalledDate, '[IMPL] x')] };
  const [v] = pickStalledCards(cards, { listNames: Object.fromEntries(listNames()), comments, nowMs: NOW, silenceMs: SILENCE });
  assert.equal(v.reason, 'stalled');
});

// ---- runStallSweepWatch -----------------------------------------------------

const stranded = () => card('6ae96772aaa', 'C-M9 stranded', IMPLEMENT);
const strandedComments = () => [cmt('k1', stalledDate, '[IMPL] evidence — commits pushed')];

test('9. once tick: stalled card recovered with the handleRunCrash-shaped code', async () => {
  const t = fakeTrello({ cardsSeq: [[stranded()]], comments: { '6ae96772aaa': strandedComments() } });
  const rc = recovery();
  const h = harness({ t, rc });
  const res = await h.run({ once: true });
  assert.equal(res.ok, true);
  assert.deepEqual(
    { checked: res.checked, stalled: res.stalled, recovered: res.recovered },
    { checked: 1, stalled: 1, recovered: 1 },
  );
  assert.equal(rc.calls.length, 1);
  assert.equal(rc.calls[0].card.id, '6ae96772aaa');
  assert.match(rc.calls[0].code, /^stalled \(orphan, silent \d+ min\)$/);
  assert.equal(Number(rc.calls[0].code.match(/silent (\d+) min/)[1]), 795); // window+1h of silence
  assert.ok(h.r.lines.some((l) => l.includes('STALL-RECOVER') && l.includes('6ae96772aaa')));
});

test('10. dry-run reports would-resume + ask-holds with ZERO writes (daemon-safe)', async () => {
  const ask = card('6ae9676d', 'C-H4 ask-parked', QA);
  const stuckVerify = card('6ae9676e', 'C-M13 deploy-stuck', VERIFY);
  const t = fakeTrello({
    cardsSeq: [[stranded(), ask, stuckVerify]],
    comments: {
      '6ae96772aaa': strandedComments(),
      '6ae9676d': [cmt('a1', stalledDate, '[ASK] re-approve post-rebase sha?'), cmt('k1', ago(9 * 86_400_000), '[QA:FAIL] bounce')],
      '6ae9676e': [cmt('d1', stalledDate, '[DEPLOY] sha=a4e8f04 img=multibot-fix')],
    },
  });
  const rc = recovery();
  const h = harness({ t, rc });
  const res = await h.run({ once: true, dryRun: true });
  assert.equal(res.recovered, 0);
  assert.equal(rc.calls.length, 0); // ZERO recovery calls — report only
  assert.equal(t.calls.addComment, 0);
  assert.equal(res.wouldResume.length, 2);
  assert.deepEqual(res.wouldResume.map((w) => [w.card, w.list, w.resumeStage]), [
    ['6ae96772aaa', 'Implement', 'Implement'],
    ['6ae9676e', 'Verify', 'Verify'], // stuck-Verify trap rides the report
  ]);
  assert.deepEqual(res.askHeld, [{ card: '6ae9676d', name: 'C-H4 ask-parked', list: 'QA' }]);
  assert.ok(h.r.lines.some((l) => l.startsWith('WOULD-RESUME') && l.includes('Implement')));
  assert.ok(h.r.lines.some((l) => l.startsWith('HOLD-ASK') && l.includes('6ae9676d')));
});

test('11. busy + human-latest + needs-human + Ready/Done cards never recovered', async () => {
  const busy = card('c-busy', 'live run', IMPLEMENT);
  const human = card('c-human', 'human comment', REVIEW);
  const parked = card('c-park', 'needs-human', PLAN, [{ name: 'needs-human' }]);
  const ready = card('c-ready', 'queued', READY);
  const done = card('c-done', 'finished', DONE);
  const t = fakeTrello({
    cardsSeq: [[busy, human, parked, ready, done]],
    comments: {
      'c-busy': [cmt('k', stalledDate, '[IMPL] mid-flight')],
      'c-human': [cmt('h', stalledDate, 'please continue', HUMAN)],
      'c-park': [cmt('k', stalledDate, '[DAEMON-CRASH] parked')],
    },
  });
  const rc = recovery();
  const h = harness({ t, rc, isBusy: (id) => id === 'c-busy' });
  const res = await h.run({ once: true });
  assert.deepEqual(rc.calls, []);
  assert.equal(res.busySkipped, 1);
  assert.equal(res.humanSkipped, 1);
  assert.equal(res.checked, 2); // only the two un-parked in-flight cards fetched
  for (const id of ['c-park', 'c-ready', 'c-done']) {
    assert.equal(t.calls.getCardCommentsBy[id], undefined, `${id} never fetched`);
  }
});

test('12. no free slot defers the tick; freed slots recover next tick (at-least-once)', async () => {
  const t = fakeTrello({ cardsSeq: [[stranded()]], comments: { '6ae96772aaa': strandedComments() } });
  const rc = recovery();
  let slots = 0;
  let ticks = 0;
  let stop = false;
  const h = harness({ t, rc, slots: () => slots });
  const res = await h.run({
    sleep: async () => {
      slots = 1; // a run finished — the slot frees before the next tick
      ticks += 1;
      if (ticks >= 2) stop = true;
    },
    shouldStop: () => stop,
  });
  assert.equal(res.stopped, true);
  assert.equal(res.deferred, 1); // tick 1: no slot — logged, deferred
  assert.equal(res.recovered, 1); // tick 2: slot free — recovered
  assert.equal(rc.calls.length, 1);
  assert.ok(h.r.lines.some((l) => /no free slot — stall recovery deferred/.test(l)));
});

test('13. recover reject → logged + counted out, tick survives (never rejects)', async () => {
  const t = fakeTrello({ cardsSeq: [[stranded()]], comments: { '6ae96772aaa': strandedComments() } });
  const rc = recovery([new Error('handleRunCrash exploded')]);
  const h = harness({ t, rc });
  const res = await h.run({ once: true });
  assert.equal(res.ok, true);
  assert.equal(res.stalled, 1);
  assert.equal(res.recovered, 0);
  assert.ok(h.r.lines.some((l) => /recovery failed .* will retry/.test(l)));
});

test('14. fetch failure → logged skip (once: ok:false; continuous: retried next tick)', async () => {
  const boom = new Error('trello 500');
  const t = fakeTrello({ cardsSeq: [[stranded()]], comments: { '6ae96772aaa': strandedComments() }, throws: [boom, null] });
  const rc = recovery();
  let ticks = 0;
  let stop = false;
  const h = harness({ t, rc });
  const res = await h.run({
    shouldStop: () => stop,
    sleep: async () => {
      ticks += 1;
      if (ticks >= 2) stop = true;
    },
  });
  assert.ok(h.r.lines.some((l) => /fetch failed: trello 500/.test(l)));
  assert.equal(res.recovered, 1); // second (good) tick recovered
  const h2 = harness({ t: fakeTrello({ cardsSeq: [boom] }) });
  const res2 = await h2.run({ once: true });
  assert.equal(res2.ok, false);
});

test('15. per-card comment fetch failure → logged, other cards still processed', async () => {
  const other = card('c-other', 'fine', REVIEW);
  const t = fakeTrello({
    cardsSeq: [[stranded(), other]],
    comments: { '6ae96772aaa': new Error('404'), 'c-other': [cmt('k1', stalledDate, '[REVIEW:APPROVE] lgtm')] },
  });
  const rc = recovery();
  const h = harness({ t, rc });
  const res = await h.run({ once: true });
  assert.ok(h.r.lines.some((l) => /comment fetch failed for 6ae96772aaa/.test(l)));
  assert.equal(res.recovered, 1);
  assert.equal(rc.calls[0].card.id, 'c-other');
});

test('16. shouldStop: pre-cycle zero fetch; flip during sleep stops with counts', async () => {
  const t1 = fakeTrello({ cardsSeq: [[stranded()]] });
  const h1 = harness({ t: t1 });
  const r1 = await h1.run({ shouldStop: () => true });
  assert.deepEqual({ ok: r1.ok, stopped: r1.stopped }, { ok: true, stopped: true });
  assert.equal(t1.calls.getLists, 0);

  const t2 = fakeTrello({ cardsSeq: [[stranded()]], comments: { '6ae96772aaa': strandedComments() } });
  const rc2 = recovery();
  let stop = false;
  const h2 = harness({ t: t2, rc: rc2 });
  const r2 = await h2.run({ shouldStop: () => stop, sleep: async () => { stop = true; } });
  assert.equal(r2.stopped, true);
  assert.equal(r2.recovered, 1); // accumulated counts survive the clean stop
});

// ---- bootStallSweep ---------------------------------------------------------

test('17. boot pass logs orphan candidates, then recovers stalled cards once', async () => {
  const parked = card('c-park', 'needs-human stuck', PLAN, [{ name: 'needs-human' }]);
  const t = fakeTrello({
    cardsSeq: [[stranded(), parked]],
    comments: { '6ae96772aaa': strandedComments(), 'c-park': [cmt('k', stalledDate, '[DAEMON-CRASH] parked')] },
  });
  const rc = recovery();
  const r = recorder();
  const res = await bootStallSweep({ t, log: r.log, recover: rc.recover, silenceMs: SILENCE, now: () => NOW });
  assert.ok(r.lines.some((l) => /^orphan candidate: 6ae96772aaa "C-M9 stranded" sits in Implement with no owned run$/.test(l)));
  assert.ok(r.lines.some((l) => /^orphan candidate: c-park "needs-human stuck" sits in Plan with no owned run$/.test(l)));
  assert.equal(res.ok, true);
  assert.equal(res.recovered, 1); // the sweep tick ran immediately — needs-human card untouched
  assert.equal(rc.calls[0].card.id, '6ae96772aaa');
  assert.equal(t.calls.getCardCommentsBy['c-park'], undefined);
});

test('18. boot enumeration failure is logged, never thrown (boot continues)', async () => {
  const t = fakeTrello({ cardsSeq: [[stranded()]], comments: { '6ae96772aaa': strandedComments() }, throws: [new Error('trello down'), null] });
  const rc = recovery();
  const r = recorder();
  const res = await bootStallSweep({ t, log: r.log, recover: rc.recover, silenceMs: SILENCE, now: () => NOW });
  assert.ok(r.lines.some((l) => /boot orphan enumeration failed/.test(l)));
  assert.equal(res.recovered, 1); // enumeration failed but the sweep tick's own retry fetch succeeded
});

// ---- superviseStallSweep ----------------------------------------------------

test('19. superviseStallSweep starts the sweeper once and forwards the seams', async () => {
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const runWatch = async (opts) => { seen.push(opts); await gate; return { stopped: true }; };
  const r = recorder();
  const rc = recovery();
  const p = superviseStallSweep({
    runWatch,
    recover: rc.recover,
    isBusy: () => true,
    freeSlots: () => 0,
    log: r.log,
    shouldStop: () => false,
    restartMs: 1,
    sleep: async () => {},
  });
  await new Promise((r2) => setImmediate(r2));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].recover, rc.recover);
  assert.equal(seen[0].isBusy(), true);
  assert.equal(seen[0].freeSlots(), 0);
  assert.equal(typeof seen[0].shouldStop, 'function');
  release();
  await p;
});

test('20. superviseStallSweep restarts after a reject and stops on stopped:true', async () => {
  let starts = 0;
  const r = recorder();
  const slept = [];
  const runWatch = async () => {
    starts += 1;
    if (starts === 1) throw new Error('boom');
    return { stopped: true };
  };
  const p = superviseStallSweep({
    runWatch,
    log: r.log,
    shouldStop: () => false,
    restartMs: 7000,
    sleep: async (ms) => { slept.push(ms); },
  });
  await p;
  assert.equal(starts, 2);
  assert.deepEqual(slept, [7000]);
  assert.ok(r.lines.some((l) => /sweeper crashed \(boom\); restarting in 7000ms/.test(l)));
});

test('21. superviseStallSweep exits on stopped:true and never rejects on non-Error throws', async () => {
  let stop = false;
  const slept = [];
  const p = superviseStallSweep({
    runWatch: async () => ({ stopped: true }),
    log: () => {},
    shouldStop: () => stop,
    sleep: async () => { slept.push(1); },
  });
  await p; // resolves without throwing when the watch returns stopped:true
  assert.deepEqual(slept, []);

  // A non-Error throw followed by shouldStop flipping at the restart boundary.
  let starts = 0;
  let stop2 = false;
  const p2 = superviseStallSweep({
    runWatch: async () => { starts += 1; throw 'string failure'; },
    log: () => {},
    shouldStop: () => (stop2 = true) && true,
    sleep: async () => {},
  });
  await p2;
  assert.equal(starts, 1); // stopped at the restart boundary, loop exited
});
