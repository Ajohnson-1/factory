/**
 * Unit tests for scripts/lib/factory-blocking-checks.js — the daemon's
 * independent blocking-checks gate (card 6ae9677239bb2697a13ea728;
 * docs/factory.md "Independent blocking checks").
 *
 * Zero live Trello: the trello client, git runner, command runner, and state
 * read/write are injected fakes. Style mirrors tests/factoryProdClose.test.js
 * — this file runs in the `node --test` half of `npm test` (package.json
 * lists it there and in the jest --testPathIgnorePatterns half).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  STATE_PATH,
  CHECK_TAG_PASS,
  CHECK_TAG_FAIL,
  checkCommands,
  worktreePath,
  tipShaOf,
  planChecks,
  planMoveRetries,
  checkCommentText,
  runCheckSuite,
  tickBlockingChecks,
  runBlockingChecksWatch,
} from '../scripts/lib/factory-blocking-checks.js';

const CARD_ID = 'a1b2c3d4e5f60718293a4b5c';
const CARD_ID_2 = 'a1b2c3d4e5f60718293a4b5d';
const LIST_QA = 'L-QA';
const LIST_IMPL = 'L-IMPL';
const LIST_DONE = 'L-DONE';

const LISTS = [
  { id: LIST_QA, name: 'QA', closed: false },
  { id: LIST_IMPL, name: 'Implement', closed: false },
  { id: LIST_DONE, name: 'Done', closed: false },
];

const comment = (text, date) => ({ data: { text }, date });
const passComments = () => [
  comment('[IMPL] evidence: npm test → 200 pass / 0 fail, EXIT=0', '2026-01-01T00:00:00.000Z'),
  comment('[QA:PASS] all acceptance criteria green', '2026-01-02T00:00:00.000Z'),
];
const qaCard = (id = CARD_ID, extra = {}) => ({
  id,
  name: `card ${id}`,
  idList: LIST_QA,
  labels: [],
  url: `https://trello.example/${id}`,
  ...extra,
});

// ---------------------------------------------------------------------------
// checkCommands
// ---------------------------------------------------------------------------

test('checkCommands defaults to npm test when FACTORY_CHECK_CMD is unset/blank', () => {
  assert.deepEqual(checkCommands({}), [['npm', 'test']]);
  assert.deepEqual(checkCommands({ FACTORY_CHECK_CMD: '' }), [['npm', 'test']]);
  assert.deepEqual(checkCommands({ FACTORY_CHECK_CMD: '   ' }), [['npm', 'test']]);
});

test('checkCommands parses a valid FACTORY_CHECK_CMD JSON array override', () => {
  const env = { FACTORY_CHECK_CMD: '[["node","--test","t.js"],["npx","jest"]]' };
  assert.deepEqual(checkCommands(env, { log: () => {} }), [
    ['node', '--test', 't.js'],
    ['npx', 'jest'],
  ]);
});

test('checkCommands falls back to the default (with a log, never throws) on invalid overrides', () => {
  for (const raw of ['not json', '{"a":1}', '[]', '[["npm",""]]', '["npm"]', '[""]', '[[]]']) {
    const logs = [];
    assert.deepEqual(
      checkCommands({ FACTORY_CHECK_CMD: raw }, { log: (m) => logs.push(m) }),
      [['npm', 'test']],
      `invalid override must fall back: ${raw}`,
    );
    assert.equal(logs.length, 1, `invalid override must log once: ${raw}`);
    assert.match(logs[0], /FACTORY_CHECK_CMD/);
  }
});

// ---------------------------------------------------------------------------
// tipShaOf / worktreePath / STATE_PATH
// ---------------------------------------------------------------------------

test('tipShaOf returns the trimmed sha, runs rev-parse in the main repo, null on failure', () => {
  const seen = [];
  const sha = tipShaOf(`factory/${CARD_ID}`, {
    git: (argv) => {
      seen.push(argv);
      return `  deadbeefcafe1234567890\n`;
    },
  });
  assert.equal(sha, 'deadbeefcafe1234567890');
  assert.deepEqual(seen, [['rev-parse', `factory/${CARD_ID}`]]);
  assert.equal(tipShaOf('factory/x', { git: () => '' }), null);
  assert.equal(
    tipShaOf('factory/x', {
      git: () => {
        throw new Error('fatal: unknown revision');
      },
    }),
    null,
  );
});

test('worktreePath resolves the exact bootstrap layout (docs/factory.md Isolation)', () => {
  assert.equal(
    worktreePath(CARD_ID, '/Users/x/GitHub/discord-bot'),
    path.resolve('/Users/x/GitHub/discord-bot-factory-wt', CARD_ID),
  );
});

test('STATE_PATH points at data/factory-blocking-checks.json', () => {
  assert.ok(STATE_PATH().endsWith(path.join('data', 'factory-blocking-checks.json')));
});

// ---------------------------------------------------------------------------
// planChecks (pure trigger core)
// ---------------------------------------------------------------------------

test('planChecks triggers a QA card with latest [QA:PASS] and an unrecorded sha', () => {
  const card = qaCard(CARD_ID, { latestTag: '[QA:PASS]' });
  const got = planChecks({ cards: [card], qaListId: LIST_QA, state: {}, shaOf: () => 'sha-1' });
  assert.deepEqual(got, [{ card, sha: 'sha-1' }]);
});

test('planChecks skips needs-human cards and known non-[QA:PASS] latest tags', () => {
  const base = { qaListId: LIST_QA, state: {}, shaOf: () => 'sha-1' };
  const withLabel = planChecks({
    ...base,
    cards: [qaCard(CARD_ID, { latestTag: '[QA:PASS]', labels: [{ name: 'needs-human' }] })],
  });
  assert.deepEqual(withLabel, []);
  for (const latestTag of ['[QA:FAIL]', '[IMPL]', '[REVIEW:CHANGES]']) {
    const got = planChecks({ ...base, cards: [qaCard(CARD_ID, { latestTag })] });
    assert.deepEqual(got, [], `latest ${latestTag} must not trigger`);
  }
});

test('planChecks dedups by recorded sha; a new tip sha re-triggers', () => {
  const card = qaCard(CARD_ID, { latestTag: '[QA:PASS]' });
  const base = { cards: [card], qaListId: LIST_QA, shaOf: () => 'sha-2' };
  assert.deepEqual(
    planChecks({ ...base, state: { [CARD_ID]: { sha: 'sha-2', verdict: 'pass' } } }),
    [],
    'same sha as the watermark must not re-check',
  );
  const recheck = planChecks({ ...base, state: { [CARD_ID]: { sha: 'sha-1', verdict: 'fail' } } });
  assert.deepEqual(recheck, [{ card, sha: 'sha-2' }], 'bounce + new commit → re-check');
});

test('planChecks never sha-resolves non-QA cards and skips unresolvable shas', () => {
  const shaSeen = [];
  const shaOf = (c) => {
    shaSeen.push(c.id);
    return c.id === CARD_ID ? null : 'sha-x';
  };
  const cards = [
    qaCard(CARD_ID, { latestTag: '[QA:PASS]' }),
    { ...qaCard(CARD_ID_2), idList: LIST_DONE },
  ];
  const got = planChecks({ cards, qaListId: LIST_QA, state: {}, shaOf });
  assert.deepEqual(shaSeen, [CARD_ID], 'only QA-list cards are sha-resolved');
  assert.deepEqual(got, [], 'sha → null (missing branch) → skip, retry next tick');
});

test('planChecks carries cards with an unknown latest tag for the tick to verify', () => {
  // Board cards from getBoardCards carry no latestTag field; the tick
  // re-derives the tag from freshly fetched comments. planChecks must not
  // silently drop every real candidate at the pre-filter.
  const card = qaCard(CARD_ID); // no latestTag
  const got = planChecks({ cards: [card], qaListId: LIST_QA, state: {}, shaOf: () => 'sha-1' });
  assert.deepEqual(got, [{ card, sha: 'sha-1' }]);
});

// ---------------------------------------------------------------------------
// checkCommentText
// ---------------------------------------------------------------------------

test('checkCommentText PASS: byte-stable first line with counts, sha, and cmd=exit summary', () => {
  const sha = 'deadbeefcafe1234567890abcdef';
  const text = checkCommentText({
    pass: true,
    sha,
    results: [{ cmd: 'npm test', exit: 0, stdout: 'ok', stderr: '' }],
  });
  assert.ok(text.startsWith(CHECK_TAG_PASS), text);
  assert.equal(
    text.split('\n')[0],
    `[CHECK:PASS] all 1 blocking checks green at sha=${sha.slice(0, 10)} — npm test=0`,
  );
});

test('checkCommentText FAIL: names the failing command + exit, embeds bounded tails', () => {
  const sha = 'cafe1234deadbeef';
  const text = checkCommentText({
    pass: false,
    sha,
    results: [
      { cmd: 'npm test', exit: 0, stdout: 'jest green\nnode --test green', stderr: '' },
      { cmd: 'npx jest x', exit: 1, stdout: '', stderr: 'FAIL x\n1 test failed' },
    ],
  });
  assert.ok(text.startsWith(CHECK_TAG_FAIL), text);
  assert.match(text, /`npx jest x` exited 1 at sha=/);
  assert.match(text, /bouncing to Implement \(counts\)/);
  assert.match(text, /--- output tail ---/);
  assert.match(text, /--- npm test exit 0 ---/);
  assert.match(text, /--- npx jest x exit 1 ---/);
  assert.ok(text.includes('FAIL x\n1 test failed'));
});

test('checkCommentText bounds each tail: newest ≤40 lines kept, oldest dropped', () => {
  const stdout = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join('\n');
  const text = checkCommentText({
    pass: false,
    sha: 'sha',
    results: [{ cmd: 'npm test', exit: 1, stdout, stderr: '' }],
  });
  const tailLines = text.split('--- npm test exit 1 ---\n')[1].split('\n');
  assert.equal(tailLines.length, 40);
  assert.equal(tailLines[0], 'l61'); // newest 40 kept
  assert.equal(tailLines[39], 'l100');
  assert.ok(!text.includes('--- npm test exit 1 ---\nl60'));
});

test('checkCommentText consumes runCheckSuite-shaped results (tail field)', () => {
  const text = checkCommentText({
    pass: false,
    sha: 'sha',
    results: [{ cmd: 'npm test', exit: 1, tail: 'boom on stdout\nFAIL' }],
  });
  assert.ok(text.includes('--- npm test exit 1 ---\nboom on stdout\nFAIL'), text);
});

// ---------------------------------------------------------------------------
// runCheckSuite
// ---------------------------------------------------------------------------

test('runCheckSuite runs the suite sequentially in the worktree cwd', async () => {
  const seen = [];
  const { pass, results } = await runCheckSuite({
    worktree: '/tmp/wt',
    commands: [
      ['npm', 'test'],
      ['npx', 'jest', 'a.test.js'],
    ],
    run: async ({ cmd, args, cwd }) => {
      seen.push({ cmd, args, cwd });
      return { exit: 0, stdout: 'green', stderr: '' };
    },
  });
  assert.equal(pass, true);
  assert.deepEqual(seen, [
    { cmd: 'npm', args: ['test'], cwd: '/tmp/wt' },
    { cmd: 'npx', args: ['jest', 'a.test.js'], cwd: '/tmp/wt' },
  ]);
  assert.deepEqual(
    results.map((r) => ({ cmd: r.cmd, exit: r.exit })),
    [
      { cmd: 'npm', exit: 0 },
      { cmd: 'npx', exit: 0 },
    ],
  );
});

test('runCheckSuite stops at the first non-zero exit and captures its tail', async () => {
  let calls = 0;
  const { pass, results } = await runCheckSuite({
    worktree: '/tmp/wt',
    commands: [['npm', 'test'], ['node', '--test']],
    run: async () => {
      calls += 1;
      return { exit: calls === 1 ? 1 : 0, stdout: `out ${calls}`, stderr: `err ${calls}` };
    },
  });
  assert.equal(calls, 1, 'first failure stops the suite');
  assert.equal(pass, false);
  assert.equal(results.length, 1);
  assert.equal(results[0].exit, 1);
  assert.ok(results[0].tail.includes('out 1') && results[0].tail.includes('err 1'));
});

// ---------------------------------------------------------------------------
// tickBlockingChecks (fake-driven board cycle)
// ---------------------------------------------------------------------------

function tickHarness({
  cards = [],
  comments = {},
  state = {},
  shas = {},
  freshIdList = LIST_QA,
  runResults = [{ exit: 0, stdout: 'green', stderr: '' }],
  fail = {},
  shouldStop = () => false,
} = {}) {
  const logs = [];
  const writes = [];
  const runs = [];
  const t = {
    calls: { addComment: [], moveCard: [], getCard: [] },
    async getLists() {
      if (fail.lists) throw new Error('lists exploded');
      return LISTS;
    },
    async getBoardCards() {
      if (fail.cards) throw new Error('cards exploded');
      return cards;
    },
    async getCardComments(id) {
      if (fail.comments) throw new Error('comments exploded');
      return comments[id] ?? [];
    },
    async addComment(id, text) {
      if (fail.comment) throw new Error('comment exploded');
      t.calls.addComment.push({ id, text });
    },
    async getCard(id) {
      t.calls.getCard.push(id);
      return { id, idList: freshIdList };
    },
    async moveCard(cardId, listId) {
      if (fail.move) throw new Error('move exploded');
      t.calls.moveCard.push({ cardId, listId });
    },
  };
  const git = (argv) => {
    const key = argv.slice(1).join(' ');
    if (shas[key] == null) throw new Error(`fatal: unknown rev ${key}`);
    return `${shas[key]}\n`;
  };
  let runN = 0;
  const run = async ({ cmd, args, cwd }) => {
    const res = runResults[Math.min(runN, runResults.length - 1)];
    runN += 1;
    runs.push({ cmd, args, cwd, exit: res?.exit });
    return { exit: res?.exit ?? 0, stdout: res?.stdout ?? '', stderr: res?.stderr ?? '' };
  };
  const promise = tickBlockingChecks({
    t,
    git,
    run,
    readState: () => state,
    writeState: (s) => writes.push(structuredClone(s)),
    commands: [['npm', 'test']],
    shouldStop,
    log: (m) => logs.push(m),
  });
  return { logs, writes, runs, calls: t.calls, state, promise };
}

test('tick bounces to Implement on FAIL while the card is still in QA', async () => {
  const h = tickHarness({
    cards: [qaCard()],
    comments: { [CARD_ID]: passComments() },
    shas: { [`factory/${CARD_ID}`]: 'deadbeefcafe' },
    runResults: [{ exit: 1, stdout: '', stderr: 'FAIL suite\n1 test failed' }],
  });
  const summary = await h.promise;
  assert.deepEqual(
    { checked: summary.checked, pass: summary.pass, fail: summary.fail, bounced: summary.bounced },
    { checked: 1, pass: 0, fail: 1, bounced: 1 },
  );
  assert.equal(h.calls.addComment.length, 1);
  const text = h.calls.addComment[0].text;
  assert.ok(text.startsWith(CHECK_TAG_FAIL));
  assert.match(text, /`npm` exited 1 at sha=deadbeefca — bouncing/);
  assert.ok(text.includes('FAIL suite\n1 test failed'));
  assert.deepEqual(h.calls.moveCard, [{ cardId: CARD_ID, listId: LIST_IMPL }]);
  const last = h.writes[h.writes.length - 1];
  assert.equal(last[CARD_ID].sha, 'deadbeefcafe');
  assert.equal(last[CARD_ID].verdict, 'fail');
  assert.equal(last[CARD_ID].moved, true, 'successful bounce settles the marker');
  assert.ok(h.runs[0].cwd.endsWith(path.join('discord-bot-factory-wt', CARD_ID)));
});

test('tick posts the FAIL verdict but never bounces a card that left QA mid-suite', async () => {
  const h = tickHarness({
    cards: [qaCard()],
    comments: { [CARD_ID]: passComments() },
    shas: { [`factory/${CARD_ID}`]: 'sha1' },
    runResults: [{ exit: 1, stdout: 'nope', stderr: '' }],
    freshIdList: LIST_DONE, // merged + moved out of QA while the suite ran
  });
  const summary = await h.promise;
  assert.equal(summary.fail, 1);
  assert.equal(summary.bounced, 0);
  assert.equal(summary.movedOutOfQa, 1);
  assert.equal(h.calls.addComment.length, 1, 'verdict comment still posted');
  assert.deepEqual(h.calls.moveCard, [], 'no cross-list bounce for a moved card');
});

test('tick posts PASS with no card fetch/move and records the watermark', async () => {
  const h = tickHarness({
    cards: [qaCard()],
    comments: { [CARD_ID]: passComments() },
    shas: { [`factory/${CARD_ID}`]: 'sha1' },
    runResults: [{ exit: 0, stdout: 'all green', stderr: '' }],
  });
  const summary = await h.promise;
  assert.deepEqual(
    { checked: summary.checked, pass: summary.pass, fail: summary.fail, bounced: summary.bounced },
    { checked: 1, pass: 1, fail: 0, bounced: 0 },
  );
  assert.ok(h.calls.addComment[0].text.startsWith(CHECK_TAG_PASS));
  assert.deepEqual(h.calls.moveCard, []);
  assert.deepEqual(h.calls.getCard, [], 'PASS never consults membership for a move');
  assert.equal(h.writes.at(-1)[CARD_ID].verdict, 'pass');
});

test('tick never re-runs the suite for the recorded tip sha', async () => {
  const h = tickHarness({
    cards: [qaCard()],
    comments: { [CARD_ID]: passComments() },
    shas: { [`factory/${CARD_ID}`]: 'sha-same' },
    state: { [CARD_ID]: { sha: 'sha-same', verdict: 'pass' } },
  });
  const summary = await h.promise;
  assert.equal(summary.checked, 0);
  assert.equal(h.runs.length, 0, 'exactly-once per tip across ticks/restarts');
  assert.deepEqual(h.calls.addComment, []);
});

test('tick re-derives the latest stage tag from comments; non-[QA:PASS] skips without running', async () => {
  const h = tickHarness({
    cards: [qaCard()],
    comments: {
      [CARD_ID]: [
        comment('[QA:PASS] earlier', '2026-01-01T00:00:00.000Z'),
        comment('[IMPL] bounced, new commit', '2026-01-03T00:00:00.000Z'),
      ],
    },
    shas: { [`factory/${CARD_ID}`]: 'sha1' },
  });
  const summary = await h.promise;
  assert.equal(summary.checked, 0);
  assert.equal(h.runs.length, 0);
  assert.deepEqual(h.calls.addComment, []);
  assert.ok(h.logs.some((l) => l.includes('not [QA:PASS]')), h.logs.join('\n'));
});

test('tick is fail-open on board fetch errors: logs, returns, never throws', async () => {
  const h = tickHarness({ cards: [qaCard()], fail: { lists: true } });
  const summary = await h.promise; // must resolve, not reject
  assert.equal(summary.ok, false);
  assert.equal(summary.checked, 0);
  assert.ok(h.logs.some((l) => l.includes('poll failed') && l.includes('skipping tick')));
});

test('tick honors shouldStop between cards', async () => {
  let stop = false;
  const h = tickHarness({
    cards: [qaCard(CARD_ID), qaCard(CARD_ID_2)],
    comments: { [CARD_ID]: passComments(), [CARD_ID_2]: passComments() },
    shas: { [`factory/${CARD_ID}`]: 'sha1', [`factory/${CARD_ID_2}`]: 'sha2' },
    shouldStop: () => {
      const was = stop;
      stop = true; // stop after the first card
      return was;
    },
  });
  const summary = await h.promise;
  assert.equal(summary.checked, 1, 'second card deferred to the next tick');
  assert.equal(h.calls.addComment.length, 1);
});

test('tick prunes watermark entries for cards that vanished from the board', async () => {
  const h = tickHarness({
    cards: [qaCard()],
    comments: { [CARD_ID]: passComments() },
    shas: { [`factory/${CARD_ID}`]: 'sha-same' },
    state: { [CARD_ID]: { sha: 'sha-same' }, gone123: { sha: 'old' } },
  });
  const summary = await h.promise;
  assert.deepEqual(summary.pruned, ['gone123']);
  assert.ok(!('gone123' in h.writes.at(-1)));
  assert.ok(CARD_ID in h.writes.at(-1));
});

test('tick does not advance the watermark when the verdict comment fails', async () => {
  const h = tickHarness({
    cards: [qaCard()],
    comments: { [CARD_ID]: passComments() },
    shas: { [`factory/${CARD_ID}`]: 'sha1' },
    fail: { comment: true },
  });
  const summary = await h.promise;
  assert.equal(summary.checked, 0, 'comment failure ⇒ at-least-once retry next tick');
  assert.equal(h.calls.moveCard.length, 0);
  for (const w of h.writes) assert.ok(!(CARD_ID in w), 'watermark stayed un-advanced');
});

// ---------------------------------------------------------------------------
// planMoveRetries (pure pending-bounce planner — finding #3)
// ---------------------------------------------------------------------------

test('planMoveRetries returns only un-settled FAIL entries at the current tip', () => {
  const state = {
    pending: { sha: 'sha1', verdict: 'fail', moved: false }, // the owed move → candidate
    settled: { sha: 'sha1', verdict: 'fail', moved: true }, // already bounced → done
    passed: { sha: 'sha1', verdict: 'pass', moved: true }, // PASS owes no move
    legacy: { sha: 'sha1', verdict: 'fail' }, // no marker → not ours to retry
    advanced: { sha: 'sha1', verdict: 'fail', moved: false }, // tip moved on → next round owns it
  };
  const cards = [
    qaCard('pending'),
    qaCard('settled'),
    qaCard('passed'),
    qaCard('legacy'),
    qaCard('advanced'),
    qaCard('parked', { labels: [{ name: 'needs-human' }] }),
    { id: 'elsewhere', idList: LIST_DONE, labels: [] },
  ];
  const out = planMoveRetries({
    cards,
    qaListId: LIST_QA,
    state,
    shaOf: (card) => (card.id === 'advanced' ? 'sha9' : card.id === 'missing' ? null : 'sha1'),
  });
  assert.deepEqual(out.map((r) => r.card.id), ['pending']);
  assert.deepEqual(out[0], { card: cards[0], sha: 'sha1' });
  // git failure (shaOf → null) skips, retry next tick.
  assert.deepEqual(planMoveRetries({ cards: [qaCard('pending')], qaListId: LIST_QA, state, shaOf: () => null }), []);
});

test('tick marks the bounce PENDING when moveCard fails and retries it move-only later', async () => {
  // tick 1: the verdict comment lands, the bounce move explodes (transient).
  const h1 = tickHarness({
    cards: [qaCard()],
    comments: { [CARD_ID]: passComments() },
    shas: { [`factory/${CARD_ID}`]: 'sha1' },
    runResults: [{ exit: 1, stdout: 'nope', stderr: '' }],
    fail: { move: true },
  });
  const s1 = await h1.promise;
  assert.equal(s1.fail, 1);
  assert.equal(s1.bounced, 0, 'nothing settled to report');
  assert.equal(h1.calls.addComment.length, 1, 'the verdict comment landed');
  assert.ok(h1.logs.some((l) => l.includes('bounce move failed') && l.includes('retried next tick')));
  const pending = h1.writes.at(-1)[CARD_ID];
  assert.equal(pending.verdict, 'fail');
  assert.equal(pending.moved, false, 'watermark records the OWED move');

  // tick 2: same tip, and the [CHECK:FAIL] comment is now the latest stage
  // tag — the normal trigger is closed for this sha, only the marker can
  // re-fire the gate. The retry must move ONLY: no suite re-run, no
  // duplicate comment, no double move.
  const failTrail = [
    ...passComments(),
    comment(`${CHECK_TAG_FAIL} \`npm\` exited 1 at sha=sha1 — bouncing to Implement (counts).`, '2026-01-03T00:00:00.000Z'),
  ];
  const h2 = tickHarness({
    cards: [qaCard()],
    comments: { [CARD_ID]: failTrail },
    shas: { [`factory/${CARD_ID}`]: 'sha1' },
    state: structuredClone(h1.writes.at(-1)),
  });
  const s2 = await h2.promise;
  assert.equal(h2.runs.length, 0, 'suite NOT re-run — the verdict already posted');
  assert.deepEqual(h2.calls.addComment, [], 'no duplicate [CHECK:FAIL]');
  assert.deepEqual(h2.calls.moveCard, [{ cardId: CARD_ID, listId: LIST_IMPL }], 'the bounce is retried');
  assert.equal(s2.bounced, 1);
  assert.equal(h2.writes.at(-1)[CARD_ID].moved, true, 'settled');

  // tick 3: nothing owed any more — a settled marker never re-fires.
  const h3 = tickHarness({
    cards: [qaCard()],
    comments: { [CARD_ID]: failTrail },
    shas: { [`factory/${CARD_ID}`]: 'sha1' },
    state: structuredClone(h2.writes.at(-1)),
  });
  const s3 = await h3.promise;
  assert.equal(h3.runs.length, 0);
  assert.deepEqual(h3.calls.addComment, []);
  assert.deepEqual(h3.calls.moveCard, [], 'at-least-once, spam-free — no re-move after settling');
  assert.equal(s3.bounced, 0);
});

test('tick settles a pending retry when the card has since left QA (no move owed)', async () => {
  const h = tickHarness({
    cards: [qaCard()],
    comments: {
      [CARD_ID]: [...passComments(), comment(`${CHECK_TAG_FAIL} earlier verdict`, '2026-01-03T00:00:00.000Z')],
    },
    shas: { [`factory/${CARD_ID}`]: 'sha1' },
    state: { [CARD_ID]: { sha: 'sha1', verdict: 'fail', ts: '2026-01-02T00:00:00.000Z', moved: false } },
    freshIdList: LIST_DONE, // a human dragged it to Done while the move was pending
  });
  const summary = await h.promise;
  assert.equal(h.runs.length, 0, 'no suite re-run for a pending move');
  assert.deepEqual(h.calls.addComment, [], 'the single verdict comment stays single');
  assert.deepEqual(h.calls.moveCard, [], 'out of QA — nothing to move');
  assert.equal(summary.movedOutOfQa, 1);
  assert.equal(h.writes.at(-1)[CARD_ID].moved, true, 'settled without a move');
});

// ---------------------------------------------------------------------------
// runBlockingChecksWatch (loop contract)
// ---------------------------------------------------------------------------

test('runBlockingChecksWatch with once:true runs exactly one cycle and never sleeps', async () => {
  const sleeps = [];
  const res = await runBlockingChecksWatch({
    once: true,
    intervalMs: 7,
    t: {
      async getLists() {
        return LISTS;
      },
      async getBoardCards() {
        return [qaCard()];
      },
      async getCardComments() {
        return passComments();
      },
      async addComment() {},
      async getCard() {
        return { id: CARD_ID, idList: LIST_QA };
      },
      async moveCard() {},
    },
    git: (argv) => `${argv.join(' ')}-sha\n`,
    run: async () => ({ exit: 0, stdout: 'green', stderr: '' }),
    readState: () => ({}),
    writeState: () => {},
    commands: [['npm', 'test']],
    sleep: async (ms) => sleeps.push(ms),
    log: () => {},
  });
  assert.equal(res.ok, true);
  assert.equal(res.checked, 1);
  assert.equal(res.pass, 1);
  assert.deepEqual(sleeps, [], '--once never sleeps');
});

test('runBlockingChecksWatch loops until shouldStop, accumulating totals', async () => {
  let stop = false;
  const sleeps = [];
  const res = await runBlockingChecksWatch({
    intervalMs: 40,
    shouldStop: () => stop,
    t: {
      async getLists() {
        return LISTS;
      },
      async getBoardCards() {
        return [qaCard()];
      },
      async getCardComments() {
        return passComments();
      },
      async addComment() {},
      async getCard() {
        return { id: CARD_ID, idList: LIST_QA };
      },
      async moveCard() {},
    },
    git: () => {
      throw new Error('git down'); // tip unresolvable → nothing triggers; loop contract only
    },
    run: async () => ({ exit: 0, stdout: '', stderr: '' }),
    readState: () => ({}),
    writeState: () => {},
    commands: [['npm', 'test']],
    sleep: async (ms) => {
      sleeps.push(ms);
      stop = true; // shut down between ticks
    },
    log: () => {},
  });
  assert.deepEqual(res, {
    ok: true,
    stopped: true,
    checked: 0,
    pass: 0,
    fail: 0,
    bounced: 0,
    movedOutOfQa: 0,
    pruned: [],
  });
  assert.deepEqual(sleeps, [40], 'slept the configured interval once, then honored stop');
});

test('runBlockingChecksWatch never rejects on board errors', async () => {
  let stop = false;
  const res = await runBlockingChecksWatch({
    once: true,
    t: {
      async getLists() {
        throw new Error('429 rate limited');
      },
    },
    git: () => 'sha',
    run: async () => ({ exit: 0, stdout: '', stderr: '' }),
    readState: () => {
      throw new Error('state file corrupt'); // readState throw path → treated as fresh
    },
    writeState: () => {},
    commands: [['npm', 'test']],
    shouldStop: () => stop,
    sleep: async () => {},
    log: () => {},
  });
  assert.equal(res.ok, false, 'tick error surfaces as ok:false, not a rejection');
});
