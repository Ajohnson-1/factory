/**
 * Unit tests for scripts/lib/factory-done-ping.js (poller + inline
 * pingDoneArrival) + scripts/factory.js done-watch/move wiring (card
 * 6ae7941fdf19ee34c911f0ae; docs/factory.md "Pinging on Done").
 *
 * Zero live Trello/Discord: every dep is injected — fake trello client (canned
 * lists + card snapshots, call counters), fake notify (records texts, scripted
 * results/throws), in-memory state store standing in for
 * data/factory-done-ping.json, bounded fake sleep to end the for(;;) loop. The
 * only process-level tests spawn the CLI on paths that die before any network
 * call (parseFlags errors, help). Style mirrors tests/factoryAsk.test.js.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

import {
  detectDoneArrivals,
  runDoneWatch,
  pingDoneArrival,
  STATE_PATH,
} from '../scripts/lib/factory-done-ping.js';
import { parseFlags } from '../scripts/lib/factory-ask.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');

const DONE = 'done00000000000000000001';
const REVIEW = 'review000000000000000001';
const READY = 'ready00000000000000000001';
const DONE_LIST = { id: DONE, name: 'Done', closed: false };

const card = (id, name, idList) => ({ id, name, idList, url: `https://trello.com/c/${id}/name` });
const cardX = card('x'.repeat(24), 'Ship the thing', REVIEW);
const cardY = card('y'.repeat(24), 'Another card', READY);
const stateOf = (entries, doneListId = DONE) => ({ doneListId, seen: { ...entries } });

/** Fake trello client. cardsSeq/listsSeq = sequences of arrays OR Errors
 * (last entry sticks); records call counts + the fields arg of getBoardCards. */
function fakeTrello({ lists = [DONE_LIST], cardsSeq = [[]], listsSeq = null } = {}) {
  const cs = [...cardsSeq];
  const ls = listsSeq ? [...listsSeq] : null;
  const take = (seq) => (seq.length > 1 ? seq.shift() : seq[0]);
  const calls = { getLists: 0, getBoardCards: 0, fields: [] };
  return {
    calls,
    async getLists() {
      calls.getLists += 1;
      const v = ls ? take(ls) : lists;
      if (v instanceof Error) throw v;
      return v;
    },
    async getBoardCards(fields) {
      calls.getBoardCards += 1;
      calls.fields.push(fields);
      const v = take(cs);
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

/** Records ping texts; results = sequence of {sent}|{error}|Error (last sticks). */
function fakeNotify(results = [{ sent: true }]) {
  const seq = [...results];
  const take = () => (seq.length > 1 ? seq.shift() : seq[0]);
  const texts = [];
  return {
    texts,
    notify: async ({ text }) => {
      texts.push(text);
      const r = take();
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

/** In-memory stand-in for data/factory-done-ping.json (deep copies, no aliasing). */
function store(initial = null) {
  let s = initial;
  return {
    readState: () => (s === null || s === undefined ? null : JSON.parse(JSON.stringify(s))),
    writeState: (v) => {
      s = JSON.parse(JSON.stringify(v));
    },
    get: () => s,
  };
}

/** sleep that throws the sentinel after n calls — bounds the continuous loop. */
function boundedSleep(n, sentinel = new Error('sleep-limit')) {
  let calls = 0;
  const sleep = async () => {
    calls += 1;
    if (calls >= n) throw sentinel;
  };
  return { sleep, sentinel, calls: () => calls };
}

function recorder() {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
}

// 1. baseline: first run records every card, pings nothing.
test('1. first run (no state) = silent baseline seed, zero pings', async () => {
  const t = fakeTrello({ cardsSeq: [[cardX, cardY]] });
  const n = fakeNotify();
  const s = store(null);
  const r = recorder();
  const res = await runDoneWatch({
    t,
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    sleep: async () => {},
    log: r.log,
    once: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.baselined, true);
  assert.equal(res.rotated, false);
  assert.deepEqual(res.arrivals, []);
  assert.equal(res.pinged, 0);
  assert.deepEqual(n.texts, []);
  assert.deepEqual(s.get(), { doneListId: DONE, seen: { [cardX.id]: REVIEW, [cardY.id]: READY } });
  assert.match(r.lines.join('\n'), /baseline seeded \(2 cards\)/);
  // trimmed field set, exactly as the plan specifies
  assert.deepEqual(t.calls.fields, ['id,name,idList,url']);
});

// 2. arrival ping: card moved review→Done pings exactly once with title+URL.
test('2. arrival (Review → Done) pings once with title + URL and advances state', async () => {
  const t = fakeTrello({ cardsSeq: [[{ ...cardX, idList: DONE }]] });
  const n = fakeNotify();
  const s = store(stateOf({ [cardX.id]: REVIEW }));
  const r = recorder();
  const res = await runDoneWatch({
    t,
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    sleep: async () => {},
    log: r.log,
    once: true,
  });
  assert.equal(res.pinged, 1);
  assert.deepEqual(res.arrivals, [{ id: cardX.id, name: cardX.name, url: cardX.url }]);
  assert.equal(n.texts.length, 1);
  assert.match(n.texts[0], /✅ Done: Ship the thing .*trello\.com\/c\/x{24}/);
  assert.equal(s.get().seen[cardX.id], DONE);
  assert.match(r.lines.join('\n'), new RegExp(`DONE ${cardX.id} Ship the thing`));
});

// 3. dedup / restart safety: card already marked Done in persisted state never
// re-pings — a fresh runDoneWatch call (restart) reads the same store.
test('3. steady-state Done card never re-pings, even across a fresh run (restart)', async () => {
  const s = store(stateOf({ [cardX.id]: DONE }));
  const t = fakeTrello({ cardsSeq: [[{ ...cardX, idList: DONE }, cardY]] });
  const n = fakeNotify();
  const res = await runDoneWatch({
    t,
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    sleep: async () => {},
    log: () => {},
    once: true,
  });
  assert.deepEqual(n.texts, []);
  assert.deepEqual(res.arrivals, []);
  assert.equal(s.get().seen[cardX.id], DONE); // state stable
});

// 4. drag equivalence: a human dragging Ready → Done (never touched the
// pipeline) pings exactly like a scheduler move.
test('4. human UI drag Ready → Done pings (mover-agnostic)', async () => {
  const s = store(stateOf({ [cardY.id]: READY }));
  const n = fakeNotify();
  const res = await runDoneWatch({
    t: fakeTrello({ cardsSeq: [[{ ...cardY, idList: DONE }]] }),
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    sleep: async () => {},
    log: () => {},
    once: true,
  });
  assert.equal(res.pinged, 1);
  assert.match(n.texts[0], /Another card/);
  assert.equal(s.get().seen[cardY.id], DONE);
});

// 5. appeared directly in Done: card absent from state, first seen inside the
// Done list → pings; entry is only written after the ping lands.
test('5. card appearing straight inside Done pings (missing entry = arrival)', async () => {
  const s = store(stateOf({}));
  const n = fakeNotify();
  const res = await runDoneWatch({
    t: fakeTrello({ cardsSeq: [[{ ...cardX, idList: DONE }]] }), // cardX never in state, now in Done
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    sleep: async () => {},
    log: () => {},
    once: true,
  });
  assert.equal(res.pinged, 1);
  assert.equal(s.get().seen[cardX.id], DONE);
});

// 6. re-arrival: Done → Review (state follows it out) → Done again → second ping.
test('6. dragged out of Done and back in pings again', async () => {
  const s = store(stateOf({ [cardX.id]: DONE }));
  const n = fakeNotify();
  const opts = {
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    sleep: async () => {},
    log: () => {},
    once: true,
  };
  // tick 1: card moved out — state refreshes to Review, no ping.
  const r1 = await runDoneWatch({ t: fakeTrello({ cardsSeq: [[cardX]] }), ...opts });
  assert.deepEqual(r1.arrivals, []);
  assert.equal(s.get().seen[cardX.id], REVIEW);
  // tick 2: back inside Done — pings again.
  const r2 = await runDoneWatch({
    t: fakeTrello({ cardsSeq: [[{ ...cardX, idList: DONE }]] }),
    ...opts,
  });
  assert.equal(r2.pinged, 1);
  assert.equal(n.texts.length, 1);
});

// 7. at-least-once: notify returning {error} (and notify throwing) leaves the
// entry behind → next tick retries → success. Exactly one DELIVERED ping; the
// poller never rejects.
test('7. failed ping (error result AND thrown) retries next tick; one delivery total', async () => {
  const s = store(stateOf({ [cardX.id]: REVIEW }));
  const n = fakeNotify([{ error: 'Discord webhook -> HTTP 500' }, new Error('socket hang up'), { sent: true }]);
  const r = recorder();
  const bs = boundedSleep(3); // three ticks (error → throw → success), then end the loop
  await assert.rejects(
    () =>
      runDoneWatch({
        t: fakeTrello({ cardsSeq: [[{ ...cardX, idList: DONE }]] }),
        notify: n.notify,
        readState: s.readState,
        writeState: s.writeState,
        sleep: bs.sleep,
        log: r.log,
      }),
    /sleep-limit/,
  );
  assert.equal(n.texts.length, 3); // three attempts…
  assert.equal(s.get().seen[cardX.id], DONE); // …success on the third → state advanced
  const doneLines = r.lines.filter((l) => l.startsWith(`DONE ${cardX.id}`));
  assert.equal(doneLines.length, 1); // …exactly one DELIVERED ping
  assert.match(r.lines.join('\n'), /ping failed for x{24}: Discord webhook -> HTTP 500; will retry/);
  assert.match(r.lines.join('\n'), /ping failed for x{24}: socket hang up; will retry/);
});

// 7b. ping failing forever keeps retrying every tick without rejecting and
// without advancing state (the deliberate at-least-once log-noise trade-off).
test('7b. permanently failing webhook retries every tick, state stays stale, no rejection', async () => {
  const s = store(stateOf({ [cardX.id]: REVIEW }));
  const n = fakeNotify([{ error: 'connection refused' }]);
  const r = recorder();
  const bs = boundedSleep(3);
  await assert.rejects(
    () =>
      runDoneWatch({
        t: fakeTrello({ cardsSeq: [[{ ...cardX, idList: DONE }]] }),
        notify: n.notify,
        readState: s.readState,
        writeState: s.writeState,
        sleep: bs.sleep,
        log: r.log,
      }),
    /sleep-limit/,
  );
  assert.equal(n.texts.length, 3); // retried every tick
  assert.equal(s.get().seen[cardX.id], REVIEW); // never advanced
  assert.equal(r.lines.filter((l) => /will retry/.test(l)).length, 3);
});

// 8. Trello fetch throws: once mode returns {ok:false}; continuous mode logs,
// keeps polling, and processes the recovery snapshot (bounded polls).
test('8. trello fetch errors are logged and retried, never thrown', async () => {
  // once + always-throws → clean {ok:false}
  const r1 = recorder();
  const res = await runDoneWatch({
    t: fakeTrello({ cardsSeq: [new Error('Trello GET -> 500')] }),
    notify: async () => ({ sent: true }),
    readState: () => null,
    writeState: () => {},
    sleep: async () => {},
    log: r1.log,
    once: true,
  });
  assert.deepEqual(res, { ok: false });
  assert.match(r1.lines.join('\n'), /\[done-ping\] poll failed: Trello GET -> 500/);

  // continuous: throw once, then recover; arrival on the recovery tick pings;
  // third tick dedups. Loop ends via the bounded sleep.
  const s = store(stateOf({ [cardX.id]: REVIEW }));
  const n = fakeNotify();
  const t = fakeTrello({
    cardsSeq: [new Error('Trello GET -> 502'), [{ ...cardX, idList: DONE }]],
  });
  const r2 = recorder();
  const bs = boundedSleep(3);
  await assert.rejects(
    () =>
      runDoneWatch({
        t,
        notify: n.notify,
        readState: s.readState,
        writeState: s.writeState,
        sleep: bs.sleep,
        log: r2.log,
      }),
    /sleep-limit/,
  );
  assert.equal(t.calls.getBoardCards, 3); // bounded polls, loop survived the error
  assert.equal(n.texts.length, 1);
  assert.match(r2.lines.join('\n'), /poll failed/);
  assert.equal(s.get().seen[cardX.id], DONE);
});

// 8b. missing/closed Done list is treated like any transient error.
test('8b. missing Done list → logged poll failure, keeps looping', async () => {
  const t = fakeTrello({ lists: [{ id: REVIEW, name: 'Review', closed: false }] });
  const res = await runDoneWatch({
    t,
    notify: async () => ({ sent: true }),
    readState: () => null,
    writeState: () => {},
    sleep: async () => {},
    log: () => {},
    once: true,
  });
  assert.deepEqual(res, { ok: false });
  assert.equal(t.calls.getBoardCards, 0); // died at getLists resolution
});

// 9. list-id rotation: stored doneListId ≠ current → silent re-baseline, no storm.
test('9. Done list id rotated → zero pings, state re-baselined, rotated:true', async () => {
  const s = store({ doneListId: 'stale-old-done-id', seen: { [cardX.id]: 'stale-old-done-id' } });
  const n = fakeNotify();
  const r = recorder();
  const res = await runDoneWatch({
    t: fakeTrello({ cardsSeq: [[{ ...cardX, idList: DONE }]] }),
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    sleep: async () => {},
    log: r.log,
    once: true,
  });
  assert.equal(res.rotated, true);
  assert.equal(res.baselined, false);
  assert.deepEqual(n.texts, []);
  assert.deepEqual(res.arrivals, []);
  assert.equal(s.get().doneListId, DONE);
  assert.match(r.lines.join('\n'), /Done list rotated — re-baselined/);
});

// 10. corrupt state: unreadable file / throwing reader / garbage shape →
// silent re-baseline, never a crash, never a ping storm.
test('10a. readState throwing → re-baseline silently', async () => {
  const s = store();
  const n = fakeNotify();
  const res = await runDoneWatch({
    t: fakeTrello({ cardsSeq: [[{ ...cardX, idList: DONE }]] }),
    notify: n.notify,
    readState: () => {
      throw new Error('EPERM: unreadable');
    },
    writeState: s.writeState,
    sleep: async () => {},
    log: () => {},
    once: true,
  });
  assert.equal(res.baselined, true);
  assert.equal(res.pinged, 0); // baseline = silent
});

test('10b. corrupt state file through the REAL default reader → silent re-baseline', async () => {
  const file = STATE_PATH();
  let had = null;
  try {
    had = readFileSync(file, 'utf8'); // remember real state (data/ is gitignored)
  } catch {
    /* file absent — restored by deletion below */
  }
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, 'not-json{{{');
    const n = fakeNotify();
    const res = await runDoneWatch({
      t: fakeTrello({ cardsSeq: [[{ ...cardX, idList: DONE }, cardY]] }),
      notify: n.notify,
      sleep: async () => {},
      log: () => {},
      once: true,
    });
    assert.equal(res.baselined, true);
    assert.deepEqual(n.texts, []); // zero pings for a corrupt baseline
    // defaultWriteState rewrote the file atomically with a usable map
    const written = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(written.doneListId, DONE);
    assert.equal(written.seen[cardX.id], DONE);
    assert.equal(written.seen[cardY.id], READY);
  } finally {
    if (had === null) rmSync(file, { force: true });
    else writeFileSync(file, had);
  }
});

// 11. prune: ids in state but absent from the board fetch are dropped.
test('11. archived card is pruned from state', async () => {
  const s = store(stateOf({ [cardX.id]: REVIEW, gone: DONE }));
  const n = fakeNotify();
  await runDoneWatch({
    t: fakeTrello({ cardsSeq: [[cardX]] }), // 'gone' vanished (archived)
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    sleep: async () => {},
    log: () => {},
    once: true,
  });
  assert.equal('gone' in s.get().seen, false);
  assert.equal(s.get().seen[cardX.id], REVIEW);
});

// 12. detectDoneArrivals pure-unit: no IO, no timers — the diff rules directly.
test('12. detectDoneArrivals pure rules: baseline/rotation/arrival/dedup/prune', () => {
  const inDone = { id: 'a'.repeat(24), name: 'A', idList: DONE, url: 'u/a' };
  const inReview = { id: 'b'.repeat(24), name: 'B', idList: REVIEW, url: 'u/b' };

  // baseline: seen == null → everything recorded, nothing arrives
  const b = detectDoneArrivals([inDone, inReview], { doneListId: DONE, seen: null });
  assert.equal(b.baselined, true);
  assert.deepEqual(b.arrivals, []);
  assert.deepEqual(b.seen, { doneListId: DONE, seen: { [inDone.id]: DONE, [inReview.id]: REVIEW } });

  // rotation: stored id ≠ current → silent re-baseline, rotated flag
  const rot = detectDoneArrivals([inDone], {
    doneListId: DONE,
    seen: { doneListId: 'other', seen: { [inDone.id]: 'other' } },
  });
  assert.equal(rot.rotated, true);
  assert.deepEqual(rot.arrivals, []);
  assert.equal(rot.seen.doneListId, DONE);

  // arrival from another list: reported; OLD entry kept until ping success
  const moved = detectDoneArrivals([{ ...inReview, idList: DONE }], {
    doneListId: DONE,
    seen: stateOf({ [inReview.id]: REVIEW }),
  });
  assert.deepEqual(moved.arrivals, [{ id: inReview.id, name: 'B', url: 'u/b' }]);
  assert.equal(moved.seen.seen[inReview.id], REVIEW); // NOT yet advanced

  // appeared straight in Done: reported; entry stays ABSENT until ping success
  const appeared = detectDoneArrivals([inDone], { doneListId: DONE, seen: stateOf({}) });
  assert.deepEqual(appeared.arrivals, [{ id: inDone.id, name: 'A', url: 'u/a' }]);
  assert.equal(inDone.id in appeared.seen.seen, false);

  // steady Done: no arrival, entry stays
  const steady = detectDoneArrivals([inDone], {
    doneListId: DONE,
    seen: stateOf({ [inDone.id]: DONE }),
  });
  assert.deepEqual(steady.arrivals, []);
  assert.equal(steady.seen.seen[inDone.id], DONE);

  // prune: absent ids collected + dropped
  const pruned = [];
  const p = detectDoneArrivals([inReview], {
    doneListId: DONE,
    seen: stateOf({ [inReview.id]: REVIEW, archived: DONE }),
    pruned,
  });
  assert.deepEqual(pruned, ['archived']);
  assert.deepEqual(p.pruned, ['archived']);
  assert.equal('archived' in p.seen.seen, false);
});

// 13. parseFlags regression: --once is additive; existing flags untouched.
test('13. parseFlags: --once + existing flags unaffected', () => {
  assert.deepEqual(parseFlags(['--once']).flags, { once: true });
  assert.deepEqual(parseFlags(['Done', '--interval', '500', '--once']), {
    flags: { intervalMs: 500, once: true },
    positional: ['Done'],
  });
  assert.deepEqual(
    parseFlags(['a'.repeat(24), '--timeout', '1000', '--interval', '2000', '--no-wait']).flags,
    { timeoutMs: 1000, intervalMs: 2000, noWait: true },
  );
});

// 14. CLI wiring via spawnSync — usage paths die BEFORE any network call.
const runCli = (...argv) =>
  spawnSync(process.execPath, [FACTORY_JS, ...argv], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

test('14a. CLI done-watch --interval x → exit 1 parseFlags error before any network', () => {
  const r = runCli('done-watch', '--interval', 'x');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--interval/);
});

test('14b. CLI help lists done-watch', () => {
  const r = runCli('help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\s+done-watch \[Done\]/m);
});

test('14c. CLI unknown command behavior unchanged', () => {
  const r = runCli('bogus-command');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown command "bogus-command"/);
});

// ---- inline pingDoneArrival (scheduler-path ping; move → Done) ----

// 15. inline arrival with existing state: exactly one ping in the poller's
// text format; state advanced for the moved card only, other entries kept.
test('15. inline pingDoneArrival pings once and advances only the moved card', async () => {
  const t = fakeTrello({ cardsSeq: [[cardX, cardY]] });
  const n = fakeNotify();
  const s = store(stateOf({ [cardX.id]: REVIEW, [cardY.id]: DONE, other1: READY }));
  const r = recorder();
  const res = await pingDoneArrival({
    card: { id: cardX.id, name: cardX.name, url: cardX.url },
    doneListId: DONE,
    t,
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    log: r.log,
  });
  assert.deepEqual(res, { sent: true });
  assert.deepEqual(n.texts, [`✅ Done: ${cardX.name} — ${cardX.url}`]); // exact poller format
  assert.equal(s.get().doneListId, DONE);
  assert.equal(s.get().seen[cardX.id], DONE); // moved card advanced
  assert.equal(s.get().seen[cardY.id], DONE); // other entries preserved
  assert.equal(s.get().seen.other1, READY);
});

// 16. dedup poller-first: state already records card→Done (poller pinged it)
// → inline skips BEFORE sending; no ping, no state write.
test('16. inline skips when poller already pinged (state dedup, no send, no write)', async () => {
  const before = stateOf({ [cardX.id]: DONE, [cardY.id]: READY });
  const s = store(before);
  let writes = 0;
  const n = fakeNotify();
  const res = await pingDoneArrival({
    card: { id: cardX.id, name: cardX.name, url: cardX.url },
    doneListId: DONE,
    t: fakeTrello(),
    notify: n.notify,
    readState: s.readState,
    writeState: (v) => {
      writes += 1;
      s.writeState(v);
    },
    log: () => {},
  });
  assert.deepEqual(res, { skipped: 'already-pinged' });
  assert.deepEqual(n.texts, []);
  assert.equal(writes, 0);
  assert.deepEqual(s.get(), before); // state file untouched
});

// 17. send failure both ways (notify → {error} AND notify throwing): never
// rejects, result reports sent:false, state left UNTOUCHED (stale entry kept →
// a live poller retries next tick — at-least-once parity with the poller).
test('17. inline send failure ({error} AND throw): state untouched, never rejects', async () => {
  const stale = stateOf({ [cardX.id]: REVIEW });
  const s1 = store(stale);
  const n1 = fakeNotify([{ error: 'webhook 401' }]);
  const res1 = await pingDoneArrival({
    card: { id: cardX.id, name: cardX.name, url: cardX.url },
    doneListId: DONE,
    t: fakeTrello(),
    notify: n1.notify,
    readState: s1.readState,
    writeState: s1.writeState,
    log: () => {},
  });
  assert.equal(res1.sent, false);
  assert.match(res1.error, /webhook 401/);
  assert.deepEqual(s1.get(), stale); // stale entry kept → poller retries

  const s2 = store(stale);
  const n2 = fakeNotify([new Error('socket hang up')]);
  const res2 = await pingDoneArrival({
    card: { id: cardX.id, name: cardX.name, url: cardX.url },
    doneListId: DONE,
    t: fakeTrello(),
    notify: n2.notify,
    readState: s2.readState,
    writeState: s2.writeState,
    log: () => {},
  });
  assert.equal(res2.sent, false);
  assert.match(res2.error, /socket hang up/);
  assert.deepEqual(s2.get(), stale);
});

// 18. fresh-state trap: missing (null) AND throwing reader must NOT produce a
// one-entry file — after a successful send the written state is the FULL
// baseline of every board card (moved card marked Done). A subsequent poller
// tick over the same board + store pings ZERO (no storm, no double-ping).
test('18. fresh state (null AND throwing reader) → full baseline seed, poller then pings 0', async () => {
  const inDone = card(cardX.id, cardX.name, DONE); // board after the move
  const freshRuns = [
    { readState: () => null },
    { readState: () => { throw new Error('EIO'); } },
  ];
  for (const { readState } of freshRuns) {
    const s = store(null);
    const n = fakeNotify();
    const res = await pingDoneArrival({
      card: { id: cardX.id, name: cardX.name, url: cardX.url },
      doneListId: DONE,
      t: fakeTrello({ cardsSeq: [[inDone, cardY]] }),
      notify: n.notify,
      readState,
      writeState: s.writeState,
      log: () => {},
    });
    assert.deepEqual(res, { sent: true });
    assert.deepEqual(n.texts, [`✅ Done: ${cardX.name} — ${cardX.url}`]);
    assert.deepEqual(s.get(), { doneListId: DONE, seen: { [cardX.id]: DONE, [cardY.id]: READY } });
    // same board + same store → poller tick: zero pings (no storm, no re-ping)
    const n2 = fakeNotify();
    const poll = await runDoneWatch({
      t: fakeTrello({ cardsSeq: [[inDone, cardY]] }),
      notify: n2.notify,
      readState: s.readState,
      writeState: s.writeState,
      sleep: async () => {},
      log: () => {},
      once: true,
    });
    assert.equal(poll.pinged, 0);
    assert.deepEqual(poll.arrivals, []);
    assert.deepEqual(n2.texts, []);
  }
});

// 19. sequential dedup inline-first: with VALID existing state, pingDoneArrival
// advances the shared store, then a poller --once tick sees the card as steady
// Done and pings 0 (16 proves the poller-first direction).
test('19. inline pinged first → poller --once pings 0 on shared state', async () => {
  const s = store(stateOf({ [cardX.id]: REVIEW, [cardY.id]: READY }));
  const inDone = card(cardX.id, cardX.name, DONE);
  await pingDoneArrival({
    card: { id: cardX.id, name: cardX.name, url: cardX.url },
    doneListId: DONE,
    t: fakeTrello(),
    notify: fakeNotify().notify,
    readState: s.readState,
    writeState: s.writeState,
    log: () => {},
  });
  assert.equal(s.get().seen[cardX.id], DONE);
  const n = fakeNotify();
  const poll = await runDoneWatch({
    t: fakeTrello({ cardsSeq: [[inDone, cardY]] }),
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    sleep: async () => {},
    log: () => {},
    once: true,
  });
  assert.equal(poll.pinged, 0);
  assert.deepEqual(n.texts, []);
});

// 20. writeState throwing on the advanced write: ping already landed →
// {sent:true} anyway, error logged, never rejects (best-effort contract).
test('20. inline state-write failure after send: still {sent:true}, logged, no reject', async () => {
  const s = store(stateOf({ [cardX.id]: REVIEW }));
  const r = recorder();
  const res = await pingDoneArrival({
    card: { id: cardX.id, name: cardX.name, url: cardX.url },
    doneListId: DONE,
    t: fakeTrello(),
    notify: fakeNotify().notify,
    readState: s.readState,
    writeState: () => {
      throw new Error('EROFS');
    },
    log: r.log,
  });
  assert.deepEqual(res, { sent: true });
  assert.deepEqual(s.get(), stateOf({ [cardX.id]: REVIEW })); // write never landed
  assert.ok(r.lines.some((l) => /EROFS/.test(l))); // logged, not thrown
});

// 21. parseFlags regression: --no-ping is additive; move positionals and all
// existing flags unaffected.
test('21. parseFlags: --no-ping + existing flags unaffected', () => {
  assert.deepEqual(parseFlags(['a'.repeat(24), 'Done', '--no-ping']), {
    flags: { noPing: true },
    positional: ['a'.repeat(24), 'Done'],
  });
  assert.deepEqual(parseFlags(['--no-ping']).flags, { noPing: true });
  assert.deepEqual(
    parseFlags(['x'.repeat(24), '--timeout', '1000', '--interval', '2000', '--no-wait', '--once']),
    {
      flags: { timeoutMs: 1000, intervalMs: 2000, noWait: true, once: true },
      positional: ['x'.repeat(24)],
    },
  );
  assert.deepEqual(parseFlags(['Done', '--since', '2026-01-01T00:00:00.000Z']).flags, {
    sinceIso: '2026-01-01T00:00:00.000Z',
  });
});

// 22. shouldStop DI (daemon supervision): true before the first cycle → clean
// {ok:true,stopped:true} with zero fetch/ping/write; false-until-after-first-
// arrival → the arrival is pinged (state advances on {sent:true}), then the
// loop honors the stop between ticks. Default undefined keeps today's forever
// semantics — every test above exercises exactly that unchanged path.
test('22. runDoneWatch shouldStop: pre-cycle stop and stop-after-arrival', async () => {
  // (a) stop already requested before the first cycle → nothing happens.
  const t = fakeTrello({ cardsSeq: [[{ ...cardX, idList: DONE }]] });
  const n = fakeNotify();
  const s = store(stateOf({ [cardX.id]: REVIEW }));
  const r = recorder();
  const res = await runDoneWatch({
    t,
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    sleep: async () => {
      throw new Error('must not sleep after a stopped return');
    },
    log: r.log,
    shouldStop: () => true,
  });
  assert.deepEqual(res, {
    ok: true,
    stopped: true,
    baselined: false,
    rotated: false,
    arrivals: [],
    pinged: 0,
  });
  assert.equal(t.calls.getBoardCards, 0); // exited before the first fetch
  assert.equal(n.texts.length, 0); // zero pings
  assert.deepEqual(s.get(), stateOf({ [cardX.id]: REVIEW })); // no state write

  // (b) stop flips only after the first arrival tick: arrival pings and
  // advances state, then the loop returns between ticks.
  const t2 = fakeTrello({ cardsSeq: [[{ ...cardX, idList: DONE }]] });
  const n2 = fakeNotify();
  const s2 = store(stateOf({ [cardX.id]: REVIEW }));
  let stop = false;
  const r2 = recorder();
  const res2 = await runDoneWatch({
    t: t2,
    notify: n2.notify,
    readState: s2.readState,
    writeState: s2.writeState,
    sleep: async () => {
      stop = true; // stop requested during the first inter-tick sleep
    },
    log: r2.log,
    shouldStop: () => stop,
  });
  assert.equal(res2.ok, true);
  assert.equal(res2.stopped, true);
  assert.equal(res2.pinged, 1); // lastCounts carry the arrival tick
  assert.deepEqual(res2.arrivals.map((c) => c.id), [cardX.id]);
  assert.equal(n2.texts.length, 1); // sent exactly once, before the stop
  assert.equal(s2.get().seen[cardX.id], DONE); // advanced on {sent:true}
  assert.ok(r2.lines.some((l) => l.startsWith(`DONE ${cardX.id}`)));
});

// 23. Complaint regression (card 6ae7f8a5ec425d55108d509d,
// trello.com/c/XhJUZHGG, 2026-11-02T03:58:32Z: "this card was moved back to
// done and I was not pinged"): the card was pinged on first Done arrival, a
// human dragged it OUT of Done in the UI while NO poller was running, and the
// stale seen-Done entry swallowed the re-arrival's inline ping. With the
// daemon-supervised live poller (this card's fix), every tick refreshes each
// card's last-known list, so out-and-back re-arrival pings again. Four ticks
// of ONE card through ONE continuous poller, bounded only by shouldStop:
//   tick 1: card arrives in Done         → ping #1 (state advances to Done)
//   tick 2: human drags it out to Ready  → entry refreshed silently, no ping
//   tick 3: dragged BACK into Done       → ping #2 — the complaint scenario
//   tick 4: steady in Done               → silent (dedup holds)
test('23. hangman regression: pinged → dragged out (poller observes) → back in → pinged again', async () => {
  const hangman = card(
    '6ae7f8a5ec425d55108d509d',
    'Hang man is still not working when I add a reaction.',
    READY,
  );
  const snapshots = [DONE, READY, DONE, DONE].map((idList) => [{ ...hangman, idList }]);
  const t = fakeTrello({ cardsSeq: snapshots });
  const n = fakeNotify();
  const s = store(stateOf({ [hangman.id]: READY })); // last-known: Ready (dispatched)
  const r = recorder();
  let ticks = 0;
  const res = await runDoneWatch({
    t,
    notify: n.notify,
    readState: s.readState,
    writeState: s.writeState,
    sleep: async () => {
      ticks += 1; // each fake sleep bounds one full poll tick
    },
    log: r.log,
    shouldStop: () => ticks >= 4,
  });
  assert.equal(res.ok, true);
  assert.equal(res.stopped, true); // clean supervisor-visible stop after tick 4
  assert.equal(t.calls.getBoardCards, 4); // exactly four ticks
  assert.equal(n.texts.length, 2); // exactly two ✅ Done messages total
  assert.ok(n.texts[0].includes('✅ Done') && n.texts[0].includes('Hang man'));
  assert.ok(n.texts[1].includes('✅ Done') && n.texts[1].includes('Hang man'));
  assert.equal(r.lines.filter((l) => l.startsWith(`DONE ${hangman.id}`)).length, 2);
  assert.equal(s.get().seen[hangman.id], DONE); // final state: seen-Done again
});
