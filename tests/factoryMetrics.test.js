/**
 * Unit tests for scripts/lib/factory-metrics.js (pure compute core + reporting
 * shell) + scripts/factory-metrics.js (plist XML + unknown command) +
 * scripts/factory.js metrics wiring (card 6ae9676e2c38913cca053d37;
 * docs/factory.md "Metrics report").
 *
 * Bounce figures are pinned against the GATE RULE itself: countBounces() from
 * scripts/lib/factory-review-verify.js (netting + whole-trail scope), not a
 * tag tally — plus the honest touched counter, the 404 report-card self-heal,
 * the newest-in-window live cost cap, and the --no-post zero-write contract.
 *
 * Zero live Trello / launchctl / fs-outside-tmpdir: every dep is injected —
 * fake trello client (canned cards + comment trails, call counters, scripted
 * throws), in-memory state store, fake prod-watch / daemon-log readers, fixed
 * clock. The only process-level tests spawn the CLIs on paths that die before
 * any network call (usage / unknown-arg / help). Style mirrors
 * tests/factoryDonePing.test.js.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildMetricsComment,
  buildMetricsHeadline,
  buildMetricsSummary,
  computeCardMetrics,
  computeMetrics,
  askOnTopOk,
  extractCostSpent,
  parseDispatchHeaders,
  percentile,
  readDaemonLogs,
  readProdWatchState,
  runMetricsReport,
  summarize,
  BOUNCE_TAGS,
  COMMENT_LIMIT,
  METRICS_COMMENT_MAX_CHARS,
  SUMMARY_TAIL,
} from '../scripts/lib/factory-metrics.js';
import { plistXml } from '../scripts/factory-metrics.js';
// The curator's list is the single source of truth for the bounce formula
// (itself pinned to docs/factory.md by tests/factoryContext.test.js #8/#8b)
// — test 40 pins the metrics mirror against it so the copy cannot drift.
import { BOUNCE_TAGS as CURATOR_BOUNCE_TAGS } from '../scripts/lib/factory-context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');
const METRICS_JS = path.join(ROOT, 'scripts', 'factory-metrics.js');

const BOT_ID = 'bot000000000000000000000a';
const HUMAN_ID = 'human00000000000000000000b';
const me = { id: BOT_ID, username: 'ompbot', fullName: 'OMP BOT' };
const SINCE = '2026-01-01T00:00:00.000Z';
const UNTIL = '2026-01-08T00:00:00.000Z';
const DONE = 'done00000000000000000001';
const REVIEW = 'review000000000000000001';
const HOUR = 3_600_000;

// Day 1..8 of January 2026 at HH:00 — every fixture timestamp inside the window.
const d = (day, hour = 0) => `2026-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const ms = (iso) => Date.parse(iso);

let seq = 0;
/** Comment action in trello.js getCardComments shape. who: 'bot' | 'human' | id */
const c = (date, text, who = 'bot') => ({
  id: `cm${(seq += 1)}`,
  date,
  data: { text },
  memberCreator: who === 'bot' ? { id: BOT_ID, username: 'ompbot' } : who === 'human' ? { id: HUMAN_ID, username: 'andrew' } : who,
});
const card = (id, name, { idList = REVIEW, labels = [] } = {}) => ({
  id,
  name,
  idList,
  labels,
  url: `https://trello.com/c/${id}/x`,
});
const NEEDS_HUMAN = [{ name: 'needs-human' }];
const W = { since: ms(SINCE), until: ms(UNTIL), me };

// A clean full pipeline trail: PLAN d1 01:00 → IMPL 05:00 → APPROVE 09:00 →
// QA:PASS 15:00 → DEPLOY 18:00 → VERIFY:PASS d2 01:00, first comment d1 00:00.
const cleanTrail = () => [
  c(d(1, 0), 'desc seeded'),
  c(d(1, 1), '[PLAN] the plan'),
  c(d(1, 5), '[IMPL] evidence'),
  c(d(1, 9), '[REVIEW:APPROVE] lgtm'),
  c(d(1, 11), '[SEC:PASS] no-op'),
  c(d(1, 15), '[QA:PASS] green'),
  c(d(1, 18), '[DEPLOY] sha=abc'),
  c(d(2, 1), '[VERIFY:PASS] healthy'),
];

// ---------------------------------------------------------------------------
// 1. percentile / summarize math
// ---------------------------------------------------------------------------
test('1. percentile nearest-rank + summarize shapes', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([10, 20], 50), 10); // ceil(.5*2)-1 = rank 0
  assert.equal(percentile([10, 20], 95), 20); // ceil(.95*2)-1 = rank 1
  assert.equal(percentile([10, 20, 30, 40], 95), 40); // ceil(3.8)-1 = rank 3
  assert.deepEqual(summarize([40, 10, 30, 20]), { n: 4, p50: 20, p95: 40, max: 40 });
  assert.equal(summarize([]), null);
});

// ---------------------------------------------------------------------------
// 2. clean Done card — full stage chain, zero bounces/crashes/asks
// ---------------------------------------------------------------------------
test('2. clean card: every stage interval from comment dates', () => {
  const m = computeCardMetrics(card('a'.repeat(24), 'Clean', { idList: DONE }), cleanTrail(), W);
  assert.deepEqual(m.stages, {
    planMs: 1 * HOUR, // first comment d1 00:00 → PLAN d1 01:00
    implementMs: 4 * HOUR,
    reviewMs: 4 * HOUR,
    qaMs: 6 * HOUR,
    deployMs: 3 * HOUR,
    verifyMs: 7 * HOUR,
    totalMs: 24 * HOUR,
  });
  assert.equal(m.bounces.lifetime, 0);
  assert.equal(m.crashes.lifetime, 0);
  assert.equal(m.truncated, false);
  assert.deepEqual(m.asks, []);
  assert.deepEqual(m.reviewRounds, []);
});

// ---------------------------------------------------------------------------
// 3. bounces = the gate rule ITSELF: countBounces() from
//    factory-review-verify.js (VERIFY decision=proceed nets CHANGES to zero,
//    decision=bounce keeps it, [QA:FAIL]/[SEC:FINDINGS]/[CHECK:FAIL]/
//    [VERIFY:FAIL] count unconditionally over the WHOLE trail), plus the
//    after-latest-[IMPL] pending slice and the separately labeled raw
//    windowTagTally.
// ---------------------------------------------------------------------------
test('3. bounces reuse countBounces: netting, pending slice, honest window tally', () => {
  // Noise round: CHANGES netted to zero by a later VERIFY decision=proceed —
  // the exact finding-response outcome the old tag tally miscounted.
  const noise = [
    c(d(1, 2), '[IMPL] r1'),
    c(d(1, 4), '[REVIEW:CHANGES] nit'),
    c(d(1, 6), '[REVIEW:VERIFY] decision=proceed confirmed=0 nits=1'),
  ];
  assert.deepEqual(
    computeCardMetrics(card('b'.repeat(24), 'Noise'), noise, W).bounces,
    { pending: 0, lifetime: 0, needsHumanRisk: false, windowTagTally: 1 }, // raw tally still shows the tag
  );
  // decision=bounce KEEPS the tentative pair — netting is one-way.
  const real = [
    c(d(1, 2), '[IMPL] r1'),
    c(d(1, 4), '[REVIEW:CHANGES] finding'),
    c(d(1, 6), '[REVIEW:VERIFY] decision=bounce confirmed=1'),
  ];
  assert.deepEqual(
    computeCardMetrics(card('b'.repeat(24), 'Real'), real, W).bounces,
    { pending: 1, lifetime: 1, needsHumanRisk: false, windowTagTally: 1 },
  );
  // Whole-trail scope (the gate counts OUT-OF-WINDOW failures too — the old
  // rule anchored at the latest [IMPL] and missed both).
  const ancient = [c('2025-12-20T00:00:00.000Z', '[QA:FAIL] ancient'), c(d(1, 5), '[IMPL] r1')];
  assert.deepEqual(
    computeCardMetrics(card('b'.repeat(24), 'Ancient'), ancient, W).bounces,
    { pending: 0, lifetime: 1, needsHumanRisk: false, windowTagTally: 0 },
  );
  // Multi-round trail: netted total (all four tags, unresolved CHANGES stay
  // counted fail-closed), pending slice empty behind the newest [IMPL], raw
  // window tally counting all five bounce-tag comments.
  const trail = [
    c(d(1, 0), '[PLAN] p'),
    c(d(1, 2), '[IMPL] round 1'),
    c(d(1, 4), '[REVIEW:CHANGES] f1'),
    c(d(1, 6), '[SEC:FINDINGS] f2'),
    c(d(1, 8), '[QA:FAIL] f3'),
    c(d(1, 10), '[IMPL] round 2'),
    c(d(1, 12), '[VERIFY:FAIL] f4'),
    c(d(1, 14), '[REVIEW:CHANGES] f5'),
    c(d(1, 16), '[IMPL] round 3'),
  ];
  const m = computeCardMetrics(card('b'.repeat(24), 'Bounced'), trail, W);
  assert.deepEqual(m.bounces, { pending: 0, lifetime: 5, needsHumanRisk: true, windowTagTally: 5 });
  const m2 = computeCardMetrics(card('b'.repeat(24), 'Bounced'), [...trail, c(d(1, 20), '[QA:FAIL] again')], W);
  assert.deepEqual(m2.bounces, { pending: 1, lifetime: 6, needsHumanRisk: true, windowTagTally: 6 });
});

test('4. needsHumanRisk = the gate park condition on the NETTED total', () => {
  // Raw tally hits 3, but a later VERIFY decision=proceed nets the CHANGES
  // to zero → netted 2 < BOUNCE_CAP → the gate would NOT park, so no risk.
  const trail = [
    c(d(1, 0), '[PLAN] p'),
    c(d(1, 2), '[IMPL] r1'),
    c(d(1, 4), '[REVIEW:CHANGES] x'),
    c(d(1, 5), '[SEC:FINDINGS] y'),
    c(d(1, 6), '[QA:FAIL] z'),
  ];
  const m = computeCardMetrics(card('c'.repeat(24), 'Netted'), [...trail, c(d(1, 7), '[REVIEW:VERIFY] decision=proceed')], { ...W, me: null });
  assert.equal(m.bounces.lifetime, 2); // CHANGES netted; SEC + QA count unconditionally
  assert.equal(m.bounces.needsHumanRisk, false);
  // decision=bounce keeps the pair → netted 3 = cap → the gate parks → risk.
  const m2 = computeCardMetrics(card('c'.repeat(24), 'Parked'), [...trail, c(d(1, 7), '[REVIEW:VERIFY] decision=bounce')], { ...W, me: null });
  assert.equal(m2.bounces.lifetime, 3);
  assert.equal(m2.bounces.needsHumanRisk, true);
});

// ---------------------------------------------------------------------------
// 5. crashes: window + lifetime; needs-human label surfaced
// ---------------------------------------------------------------------------
test('5. DAEMON-CRASH comments counted in window and lifetime', () => {
  const trail = [
    c(d(1, 0), '[PLAN] p'),
    c(d(1, 1), `${'[DAEMON-CRASH]'} run exited 1`),
    c(d(1, 2), '[DAEMON-CRASH] run exited 1'),
    c(d(1, 3), '[IMPL] ok'),
  ];
  const cc = card('e'.repeat(24), 'Crashy', { labels: NEEDS_HUMAN });
  const m = computeCardMetrics(cc, trail, W);
  assert.deepEqual(m.crashes, { window: 2, lifetime: 2 });
  assert.equal(m.needsHumanLabel, true);
  // outside window (December 2025) → lifetime only
  const m2 = computeCardMetrics(cc, [...trail, c('2025-12-25T00:00:00.000Z', '[DAEMON-CRASH] old')], W);
  assert.deepEqual(m2.crashes, { window: 2, lifetime: 3 });
});

// ---------------------------------------------------------------------------
// 6. ask latency — the ask protocol's reply rule, byte-for-byte
// ---------------------------------------------------------------------------
test('6. ask answered by a non-bot member; earliest reply wins', () => {
  const trail = [
    c(d(1, 0), '[ASK] which port?'),
    c(d(1, 1), 'bot noise', 'bot'), // bot-authored → never a reply
    c(d(1, 2), '8080', 'human'),
    c(d(1, 3), 'actually 9090', 'human'),
  ];
  const m = computeCardMetrics(card('g'.repeat(24), 'Ask'), trail, W);
  assert.equal(m.asks.length, 1);
  assert.deepEqual(m.asks[0], {
    card: 'g'.repeat(24),
    name: 'Ask',
    askedAt: d(1, 0),
    repliedAt: d(1, 2),
    latencyMs: 2 * HOUR,
  });
});

test('7. unanswered ask → repliedAt null; window-filtered', () => {
  const trail = [c(d(1, 0), '[ASK] pending'), c(d(1, 1), '[HUMAN] late-ish')];
  const m = computeCardMetrics(card('h'.repeat(24), 'Pending'), trail, { since: ms(d(1, 2)), until: ms(UNTIL), me });
  assert.deepEqual(m.asks, []); // ask landed before `since`
  const m2 = computeCardMetrics(card('h'.repeat(24), 'Pending'), [c(d(1, 0), '[ASK] pending')], W);
  assert.equal(m2.asks[0].repliedAt, null);
  assert.equal(m2.asks[0].latencyMs, null);
});

test('8. identity degraded (me=null): only [HUMAN]-tagged replies count', () => {
  const trail = [
    c(d(1, 0), '[ASK] q'),
    c(d(1, 1), 'plain human reply without tag', 'human'),
    c(d(1, 3), '[HUMAN] tagged answer', 'human'),
  ];
  const m = computeCardMetrics(card('i'.repeat(24), 'Degraded'), trail, { ...W, me: null });
  assert.equal(m.asks[0].repliedAt, d(1, 3)); // [HUMAN] fast-path, not the earlier plain reply
  const m2 = computeCardMetrics(card('i'.repeat(24), 'Degraded'), [c(d(1, 0), '[ASK] q'), c(d(1, 1), 'plain', 'human')], { ...W, me: null });
  assert.equal(m2.asks[0].repliedAt, null); // no tag, no identity → cannot attribute → unanswered
});

// ---------------------------------------------------------------------------
// 9-12. REVIEW:CHANGES round dispositions
// ---------------------------------------------------------------------------
const dispOf = (trail) => computeCardMetrics(card('j'.repeat(24), 'Rounds'), trail, W).reviewRounds.map((r) => r.disposition);

test('9. CHANGES → new IMPL → APPROVE = fixed; markers alone = dismissed', () => {
  assert.deepEqual(
    dispOf([c(d(1, 1), '[REVIEW:CHANGES] f1'), c(d(1, 2), '[IMPL] fixed f1'), c(d(1, 3), '[REVIEW:APPROVE] ok')]),
    ['fixed'],
  );
  assert.deepEqual(
    dispOf([c(d(1, 1), '[REVIEW:CHANGES] f1'), c(d(1, 2), "[IMPL] won't fix — not a bug"), c(d(1, 3), '[REVIEW:APPROVE] ok')]),
    ['dismissed'],
  );
  assert.deepEqual(
    dispOf([c(d(1, 1), '[REVIEW:CHANGES] f1'), c(d(1, 2), '[IMPL] finding dismissed — rationale'), c(d(1, 3), '[REVIEW:APPROVE] ok')]),
    ['dismissed'],
  );
});

test('10. APPROVE with no intervening IMPL = dismissed (reviewer withdrew)', () => {
  assert.deepEqual(dispOf([c(d(1, 1), '[REVIEW:CHANGES] noise'), c(d(1, 2), '[REVIEW:APPROVE] withdrew')]), ['dismissed']);
});

test('11. CHANGES with nothing after / IMPL pending re-review = open', () => {
  assert.deepEqual(dispOf([c(d(1, 1), '[REVIEW:CHANGES] pending')]), ['open']);
  assert.deepEqual(dispOf([c(d(1, 1), '[REVIEW:CHANGES] f'), c(d(1, 2), '[IMPL] new round')]), ['open']);
});

test('12. disposition ORDER matters: APPROVE before the new IMPL ≠ fixed', () => {
  // CHANGES → APPROVE (withdrew, no IMPL between) → IMPL (next round).
  assert.deepEqual(
    dispOf([c(d(1, 1), '[REVIEW:CHANGES] f1'), c(d(1, 2), '[REVIEW:APPROVE] withdrew'), c(d(1, 5), '[IMPL] later round')]),
    ['dismissed'],
  );
  // Two rounds in one trail, counted independently.
  assert.deepEqual(
    dispOf([
      c(d(1, 1), '[REVIEW:CHANGES] r1'),
      c(d(1, 2), '[IMPL] fixed r1'),
      c(d(1, 3), '[REVIEW:APPROVE] ok'),
      c(d(2, 1), '[REVIEW:CHANGES] r2'),
      c(d(2, 2), '[IMPL] dismissed r2 — declined'),
      c(d(2, 3), '[REVIEW:APPROVE] ok'),
    ]),
    ['fixed', 'dismissed'],
  );
});

// ---------------------------------------------------------------------------
// 13. missing tags → intervals skipped, never fabricated
// ---------------------------------------------------------------------------
test('13. missing tags at every stage → only computable intervals exist', () => {
  const m = computeCardMetrics(card('k'.repeat(24), 'Sparse'), [c(d(1, 0), 'hi'), c(d(1, 5), '[IMPL] no plan yet')], W);
  assert.equal(m.stages.planMs, undefined);
  assert.equal(m.stages.implementMs, 5 * HOUR); // anchored at the first-comment proxy
  assert.equal(m.stages.reviewMs, undefined);
  assert.equal(m.stages.totalMs, undefined);
  const m2 = computeCardMetrics(card('k'.repeat(24), 'Sparser'), [c(d(1, 0), 'just chatter')], W);
  assert.deepEqual(m2.stages, {});
});

// ---------------------------------------------------------------------------
// 14. comment list at the fetch cap → truncated flag
// ---------------------------------------------------------------------------
test('14. comment list at limit 50 → truncated:true', () => {
  const at = Array.from({ length: COMMENT_LIMIT }, (_, i) => c(d(1, 0, i), `chatter ${i}`));
  const m = computeCardMetrics(card('l'.repeat(24), 'Big'), at, W);
  assert.equal(m.truncated, true);
  const under = Array.from({ length: COMMENT_LIMIT - 1 }, (_, i) => c(d(1, 0, i), `chatter ${i}`));
  assert.equal(computeCardMetrics(card('l'.repeat(24), 'Small'), under, W).truncated, false);
});

// ---------------------------------------------------------------------------
// 15. windowing: outside comments excluded from the window tally, KEPT in
//     the netted lifetime (the gate reads the whole trail — the old rule
//     dropped pre-latest-[IMPL] bounces entirely)
// ---------------------------------------------------------------------------
test('15. window filter: out-of-window bounces stay in the netted lifetime', () => {
  const trail = [c('2025-12-20T00:00:00.000Z', '[IMPL] old'), c('2025-12-21T00:00:00.000Z', '[REVIEW:CHANGES] old'), c(d(1, 5), '[IMPL] new')];
  const m = computeCardMetrics(card('m'.repeat(24), 'Old bounce'), trail, W);
  // unresolved CHANGES: the gate counts it fail-closed even though a later
  // [IMPL] landed and it sits outside the window.
  assert.deepEqual(m.bounces, { pending: 0, lifetime: 1, needsHumanRisk: false, windowTagTally: 0 });
  const trail2 = [c(d(1, 5), '[IMPL] new'), c('2025-12-21T00:00:00.000Z', '[REVIEW:CHANGES] old')];
  const m2 = computeCardMetrics(card('m'.repeat(24), 'Old bounce'), trail2, W);
  // chronological order (not array order) decides — the 2025 CHANGES precedes
  // the newest [IMPL]; netting has no anchor to reset.
  assert.deepEqual(m2.bounces, { pending: 0, lifetime: 1, needsHumanRisk: false, windowTagTally: 0 });
  const trail3 = [c('2025-12-21T00:00:00.000Z', '[IMPL] old'), c('2025-12-22T00:00:00.000Z', '[QA:FAIL] old')];
  const m3 = computeCardMetrics(card('m'.repeat(24), 'Out of window'), trail3, W);
  assert.deepEqual(m3.bounces, { pending: 1, lifetime: 1, needsHumanRisk: false, windowTagTally: 0 });
});

// ---------------------------------------------------------------------------
// 16-17. daemon log header scan + cost line regex
// ---------------------------------------------------------------------------
test('16. dispatch/resume headers: window filter + live --max-cost cap', () => {
  const text = [
    '',
    `# dispatch ${d(3, 1)} omp ["-p","--auto-approve","--max-cost","10","--max-time","2h"]`,
    '[factory-daemon] run prose…',
    `# resume ${d(4, 1)} omp ["-p","--max-cost","25"]`,
    '# dispatch not-a-date omp []',
    '# dispatch 2025-12-25T00:00:00.000Z omp ["-p","--max-cost","10"]',
    '# dispatch 2026-01-20T00:00:00.000Z omp ["-p"]', // after UNTIL
    '# dispatch 2026-01-05T00:00:00.000Z omp ["-p" broken json',
  ].join('\n');
  const runs = parseDispatchHeaders(text, { sinceIso: SINCE, untilIso: UNTIL });
  assert.equal(runs.length, 5); // malformed DATE line skipped; broken JSON kept (cap defaults to 10)
  assert.equal(runs.filter((r) => r.inWindow).length, 3);
  assert.deepEqual(runs.map((r) => r.costCapUsd), [10, 25, 10, 10, 10]);
});

test('17. cost tail regex: hit near tail, miss → null', () => {
  assert.equal(extractCostSpent('start\nrun prose\ntotal cost: $1.25\n'), 1.25);
  assert.equal(extractCostSpent('header\nCost USD 0.42\nmore'), 0.42);
  assert.equal(extractCostSpent('no cost anywhere\n--max-cost 10\n'), null);
});

// ---------------------------------------------------------------------------
// 18-19. prod-watch snapshot + daemon log dir scan (tmpdir only)
// ---------------------------------------------------------------------------
test('18. readProdWatchState: up/down snapshot, missing → null', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fmet-'));
  try {
    writeFileSync(join(tmp, 'up.json'), JSON.stringify({ status: 'up', lastCheck: d(2, 0), lastVerdict: 'up' }));
    assert.equal(readProdWatchState(join(tmp, 'up.json')).status, 'up');
    writeFileSync(join(tmp, 'down.json'), JSON.stringify({ status: 'down', incident: { cardId: 'p1', url: 'u' } }));
    assert.equal(readProdWatchState(join(tmp, 'down.json')).incident.cardId, 'p1');
    assert.equal(readProdWatchState(join(tmp, 'missing.json')), null);
    writeFileSync(join(tmp, 'bad.json'), '{ not json');
    assert.equal(readProdWatchState(join(tmp, 'bad.json')), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('19. readDaemonLogs: reads .log files only; unreadable dir → []', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fmet-'));
  try {
    mkdirSync(join(tmp, 'logs'), { recursive: true });
    writeFileSync(join(tmp, 'logs', 'card1.log'), '# dispatch 2026-01-02T00:00:00.000Z omp []');
    writeFileSync(join(tmp, 'logs', 'daemon.pid'), '123');
    const entries = readDaemonLogs(join(tmp, 'logs'));
    assert.deepEqual(entries.map((e) => e.file), ['card1.log']);
    assert.deepEqual(readDaemonLogs(join(tmp, 'nope')), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 20-21. computeMetrics roll-ups (stage percentiles, disposition ratios,
//        [PROD-WATCH] counting, errors passthrough)
// ---------------------------------------------------------------------------
test('20. computeMetrics: stage p50 across cards, ratios, prodWatch guardrail', () => {
  const clean = cleanTrail();
  const bouncer = [
    c(d(1, 0), 'x'),
    c(d(1, 1), '[PLAN] p'),
    c(d(1, 2), '[IMPL] r1'),
    c(d(1, 3), '[REVIEW:CHANGES] f1'),
    c(d(1, 4), '[IMPL] r2'),
    c(d(1, 5), '[REVIEW:APPROVE] ok'),
  ];
  const pwCard = card('pw'.padEnd(24, '0'), '[PROD-WATCH] prod bot down: unreachable — ssh exit 255');
  const cards = [card('a'.repeat(24), 'Clean', { idList: DONE }), card('n'.repeat(24), 'Bouncer'), pwCard];
  const commentsByCard = {
    [a24('a')]: clean,
    [a24('n')]: bouncer,
    [a24('p')]: [c(d(2, 0), 'incident opened')],
  };
  const rep = computeMetrics({
    cards,
    commentsByCard,
    me,
    sinceIso: SINCE,
    untilIso: UNTIL,
    prodWatch: { status: 'down', incident: { cardId: 'p1' }, lastCheck: d(2, 1), lastVerdict: 'unreachable' },
    daemonLogs: [
      { file: 'card1.log', text: `# dispatch ${d(3, 1)} omp ["--max-cost","10"]` },
      { file: 'card2.log', error: 'EACCES' },
    ],
  });
  assert.equal(rep.stageTimes.planMs.n, 2); // Clean + Bouncer (PROD-WATCH card has no [PLAN])
  assert.equal(rep.stageTimes.reviewMs.p50, 1 * HOUR); // Clean 4h + Bouncer 1h → nearest-rank p50 = 1h
  assert.equal(rep.cards.needsHumanLabeled, 0);
  assert.deepEqual(
    { f: rep.reviewDisposition.fixed, d: rep.reviewDisposition.dismissed, o: rep.reviewDisposition.open },
    { f: 1, d: 0, o: 0 },
  );
  assert.equal(Number(rep.reviewDisposition.actedRatio.toFixed(2)), 1.0);
  assert.equal(rep.prodWatch.snapshot.status, 'down');
  assert.equal(rep.prodWatch.downEventsInWindow, 1);
  assert.equal(rep.cost.runsInWindow, 1);
  assert.equal(rep.cost.costObserved, false);
  assert.equal(rep.cost.costSpentUsd, null);
  assert.equal(rep.cost.maxCostCapUsd, 10);
  assert.ok(rep.errors.some((e) => e.includes('card2.log') && e.includes('EACCES')));
  assert.ok(rep.caveats.length >= 3);
});
function a24(ch) {
  return ch === 'p' ? 'pw'.padEnd(24, '0') : ch.repeat(24);
}

test('21. computeMetrics: missing prodWatch → null section + error note', () => {
  const rep = computeMetrics({ cards: [], commentsByCard: {}, me, sinceIso: SINCE, untilIso: UNTIL, prodWatch: null, daemonLogs: [] });
  assert.equal(rep.prodWatch, null);
  assert.ok(rep.errors.some((e) => e.includes('prod-watch.json')));
});

// ---------------------------------------------------------------------------
// Fake shells for runMetricsReport
// ---------------------------------------------------------------------------
function store(initial = null) {
  let s = initial;
  return {
    get: () => s,
    readState: () => (s == null ? null : JSON.parse(JSON.stringify(s))),
    writeState: (v) => {
      s = JSON.parse(JSON.stringify(v));
    },
  };
}

/** Fake trello client: canned cards/lists/comment trails + call counters,
 * scripted per-method errors. */
function fakeTrello({ cards = [], lists = [{ id: DONE, name: 'Done', closed: false }], comments = {}, meObj = me, errors = {} } = {}) {
  const calls = { getBoardCards: 0, getMe: 0, getLists: 0, getCardComments: 0, createCard: 0, addComment: [], moved: [] };
  return {
    calls,
    async getBoardCards() {
      calls.getBoardCards += 1;
      if (errors.getBoardCards) throw errors.getBoardCards;
      return cards;
    },
    async getMe() {
      calls.getMe += 1;
      if (errors.getMe) throw errors.getMe;
      return meObj;
    },
    async getLists() {
      calls.getLists += 1;
      if (errors.getLists) throw errors.getLists;
      return lists;
    },
    async getCardComments(id, limit) {
      calls.getCardComments += 1;
      if (errors[`comments:${id}`]) throw errors[`comments:${id}`];
      const all = comments[id] ?? [];
      return limit && limit < all.length ? all.slice(Math.max(all.length - limit, 0)) : all; // API returns newest-first page — fakes pass the window-relevant slice
    },
    async createCard(name, idList) {
      calls.createCard += 1;
      if (errors.createCard) throw errors.createCard;
      return { id: 'reportcard00000000000000', name, idList, url: 'https://trello.com/c/report/x' };
    },
    async addComment(cardId, text) {
      calls.addComment.push({ cardId, text });
      if (errors.addComment) throw errors.addComment;
      return { id: 'cm-new' };
    },
  };
}

const noop = { readProdWatch: () => null, readDaemonLogs: () => [], writeArtifacts: () => {}, notify: async () => ({ sent: true }) };

/** Records Discord texts; result is a result object OR an Error to throw. */
function fakeNotify(result = { sent: true }) {
  const texts = [];
  let calls = 0;
  return {
    texts,
    get calls() {
      return calls;
    },
    notify: async ({ text }) => {
      calls += 1;
      texts.push(text);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// 22. runMetricsReport: card created once, reused on the second pass; state
//     watermark seeds the next window; artifacts written.
// ---------------------------------------------------------------------------
test('22. report card created once then reused; state advances after post', async () => {
  const touched = card('a'.repeat(24), 'Touched card');
  const t1 = fakeTrello({ cards: [touched], comments: { [a24('a')]: cleanTrail() } });
  const stObj = store(null);
  let art = null;
  const r1 = await runMetricsReport({
    ...noop,
    t: t1,
    now: () => d(8, 0), // past the whole trail so the probe fetch sees a window comment
    readState: stObj.readState,
    writeState: stObj.writeState,
    writeArtifacts: (rep) => (art = rep),
  });
  assert.equal(r1.ok, true);
  assert.equal(t1.calls.createCard, 1); // first run creates the card
  assert.deepEqual(r1.postCard, { id: 'reportcard00000000000000', url: 'https://trello.com/c/report/x', created: true, posted: true });
  assert.equal(t1.calls.addComment.length, 1);
  const body1 = t1.calls.addComment[0].text;
  assert.ok(body1.startsWith('[METRICS] ')); // first-token contract
  assert.ok(body1.length <= METRICS_COMMENT_MAX_CHARS);
  assert.ok(!body1.includes('```json'), 'board comment must be the compact summary, never the full JSON dump');
  for (const tok of ['cards:', 'bounces:', 'needs-human risk:', 'top bounced:', 'stage times:', 'crashes:', 'asks:', 'findings:', 'prod:', 'cost:', 'errors:']) {
    assert.ok(body1.includes(tok), `comment summary missing "${tok}" line: ${body1}`);
  }
  assert.deepEqual(stObj.get(), { lastRun: d(8, 0), lastReportCardId: 'reportcard00000000000000' });
  assert.equal(art.window.since, new Date(0).toISOString()); // first run = full-board window
  assert.equal(art.window.note, 'first run — window spans full board history');
  assert.equal(r1.report.bounces.perCard.length, 1);

  // Second pass: state holds lastRun + lastReportCardId → same window start,
  // same card id, NO second card, comments fetched with the 50 cap.
  const t2 = fakeTrello({ cards: [touched], comments: { [a24('a')]: cleanTrail() } });
  const st2 = store({ lastRun: d(2, 0), lastReportCardId: 'reportcard00000000000000' });
  const r2 = await runMetricsReport({
    t: t2,
    now: () => d(3, 0),
    readState: st2.readState,
    writeState: st2.writeState,
    writeArtifacts: () => {},
    ...noop,
  });
  assert.equal(t2.calls.createCard, 0);
  assert.equal(r2.postCard.created, false);
  assert.equal(t2.calls.addComment[0].cardId, 'reportcard00000000000000');
  assert.equal(r2.report.window.since, d(2, 0)); // watermark advanced
  assert.equal(st2.get().lastRun, d(3, 0));
});

// ---------------------------------------------------------------------------
// 23. post failure → state NOT advanced (at-least-once reporting: same window
//     retried next run); degraded reads land in errors instead of throwing.
// ---------------------------------------------------------------------------
test('23. failed post keeps the window; degraded reads never reject', async () => {
  const touched = card('a'.repeat(24), 'Touched card');
  const t = fakeTrello({
    cards: [touched],
    comments: { [a24('a')]: cleanTrail() },
    errors: { getMe: new Error('404 /members/me'), addComment: new Error('500 from Trello'), ['comments:' + a24('a')]: null },
  });
  const st = store(null);
  const r = await runMetricsReport({
    t,
    now: () => d(2, 0),
    readState: st.readState,
    writeState: st.writeState,
    ...noop,
    readProdWatch: () => {
      throw new Error('EIO');
    },
    readDaemonLogs: () => {
      throw new Error('EIO logs');
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.report.askLatency.identityDegraded, true); // getMe failed → [HUMAN]-tag-only mode
  assert.ok(r.report.errors.some((e) => e.includes('summary comment failed')));
  assert.equal(st.get(), null); // window NOT advanced — retried next run
  assert.equal(t.calls.createCard, 1);
  assert.equal(r.report.prodWatch, null); // readProdWatch threw EIO → section null + note
  assert.ok(r.report.errors.some((e) => e.includes('prod-watch.json')));
});

test('23b. comment fetch throw → per-card error entry, pass survives', async () => {
  const bad = card('b'.repeat(24), 'Fetch fails');
  const t = fakeTrello({ cards: [bad], comments: {}, errors: { [`comments:${a24('b')}`]: new Error('ETIMEDOUT') } });
  const st = store({ lastRun: SINCE });
  const r = await runMetricsReport({ t, now: () => d(2, 0), readState: st.readState, writeState: st.writeState, ...noop });
  assert.equal(r.ok, true);
  assert.ok(r.report.errors.some((e) => e.includes('ETIMEDOUT')));
  assert.equal(st.get().lastRun, d(2, 0)); // post succeeded → advanced
});

// ---------------------------------------------------------------------------
// 24. board fetch failure → ok:false, ZERO board writes, exit-1 signal
// ---------------------------------------------------------------------------
test('24. getBoardCards throws → ok:false with errors, no state write', async () => {
  const t = fakeTrello({ errors: { getBoardCards: new Error('ETIMEDOUT') } });
  const st = store({ lastRun: SINCE });
  const r = await runMetricsReport({ t, readState: st.readState, writeState: st.writeState, ...noop });
  assert.equal(r.ok, false);
  assert.equal(r.report, null);
  assert.equal(t.calls.addComment.length, 0);
  assert.equal(t.calls.createCard, 0);
  assert.deepEqual(st.get(), { lastRun: SINCE });
});

// ---------------------------------------------------------------------------
// 25. --no-post: zero board writes, state untouched
// ---------------------------------------------------------------------------
test('25. noPost → zero board writes, state not advanced', async () => {
  const touched = card('a'.repeat(24), 'Touched card');
  const t = fakeTrello({ cards: [touched], comments: { [a24('a')]: cleanTrail() } });
  const st = store({ lastRun: SINCE });
  const r = await runMetricsReport({
    t,
    now: () => d(2, 0),
    noPost: true,
    readState: st.readState,
    writeState: st.writeState,
    ...noop,
  });
  assert.equal(r.ok, true);
  assert.equal(t.calls.addComment.length, 0);
  assert.equal(t.calls.createCard, 0);
  assert.equal(r.postCard, undefined);
  assert.deepEqual(st.get(), { lastRun: SINCE });
});

// ---------------------------------------------------------------------------
// 26. missing Done list → error note, no post, state not advanced
// ---------------------------------------------------------------------------
test('26. Done list missing → documented error, board untouched', async () => {
  const touched = card('a'.repeat(24), 'Touched card');
  const t = fakeTrello({ cards: [touched], lists: [], comments: { [a24('a')]: cleanTrail() } });
  const st = store(null);
  const r = await runMetricsReport({ t, now: () => d(2, 0), readState: st.readState, writeState: st.writeState, ...noop });
  assert.ok(r.report.errors.some((e) => e.includes('list not found')));
  assert.equal(t.calls.addComment.length, 0);
  assert.equal(st.get(), null);
});

// ---------------------------------------------------------------------------
// 27. headline covers every AC-7 section
// ---------------------------------------------------------------------------
test('27. [METRICS] headline names every metric family', async () => {
  const t = fakeTrello({ cards: [card('a'.repeat(24), 'Touched')], comments: { [a24('a')]: cleanTrail() } });
  const st = store(null);
  const r = await runMetricsReport({ t, now: () => d(8, 0), noPost: true, readState: st.readState, writeState: st.writeState, ...noop });
  const line = buildMetricsHeadline(r.report);
  for (const token of ['[METRICS]', 'bounced cards', 'crashes', 'asks answered', 'fixed/dismissed/open', 'prod', 'cap $10', 'implementMs:p50']) {
    assert.ok(line.includes(token), `headline missing "${token}": ${line}`);
  }
});

// ---------------------------------------------------------------------------
// 28. plist XML — launchd contract (once arg, StartInterval 21600, log paths)
// ---------------------------------------------------------------------------
test('28. plistXml carries the launchd contract', () => {
  const xml = plistXml({ nodePath: '/usr/local/bin/node' });
  assert.ok(xml.includes('<string>/usr/local/bin/node</string>'));
  assert.ok(xml.includes('<string>once</string>'));
  assert.ok(xml.includes('com.discordbot.factory-metrics'));
  assert.ok(xml.includes('<key>StartInterval</key><integer>21600</integer>'));
  assert.ok(xml.includes('<key>RunAtLoad</key><true/>'));
  assert.ok(xml.includes('data/factory-metrics/launchd.out.log'.split('/').join(path.sep)));
});

// ---------------------------------------------------------------------------
// 29. CLI processes: usage/die paths only — zero network before exit.
// ---------------------------------------------------------------------------
test('29. CLI unknown paths exit before any network call', () => {
  const metricsRun = spawnSync('node', [METRICS_JS, 'bogus'], { encoding: 'utf8' });
  assert.equal(metricsRun.status, 3);
  assert.ok(metricsRun.stderr.includes('usage: node scripts/factory-metrics.js'));

  const factoryDie = spawnSync('node', [FACTORY_JS, 'metrics', '--no-post', '--since', 'not-a-date'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(factoryDie.status, 1);
  assert.ok(factoryDie.stderr.includes('--since'));

  const unknownArg = spawnSync('node', [FACTORY_JS, 'metrics', '--no-post', 'extra'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(unknownArg.status, 1);
  assert.ok(unknownArg.stderr.includes('Unknown metrics argument'));

  const help = spawnSync('node', [FACTORY_JS, 'help'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('metrics [--no-post]'));
});

// ---------------------------------------------------------------------------
// 30-32. Discord summary (human request: "can you post the metric to discord
// as well?") — best-effort: sent on success, errors land in report.errors,
// never fails the run / blocks the state advance; --no-post skips it too.
// ---------------------------------------------------------------------------
async function passWithNotify(notify) {
  const touched = card('a'.repeat(24), 'Touched card');
  const t = fakeTrello({ cards: [touched], comments: { [a24('a')]: cleanTrail() } });
  const st = store(null);
  const r = await runMetricsReport({
    ...noop,
    notify,
    t,
    now: () => d(8, 0),
    readState: st.readState,
    writeState: st.writeState,
  });
  return { r, st, t };
}

test('30. Discord summary sent once with the headline after a board post', async () => {
  const n = fakeNotify({ sent: true });
  const { r, st } = await passWithNotify(n.notify);
  assert.equal(r.ok, true);
  assert.deepEqual(r.discordPing, { sent: true });
  assert.equal(n.calls, 1);
  assert.ok(n.texts[0].startsWith('📊 '));
  assert.ok(!n.texts[0].includes('[METRICS] '), `headline tag must not reach Discord: ${n.texts[0]}`);
  for (const token of ['bounced cards', 'crashes', 'prod', 'cap $10']) {
    assert.ok(n.texts[0].includes(token), `discord text missing "${token}": ${n.texts[0]}`);
  }
  assert.ok(!r.report.errors.some((e) => e.includes('discord')), `no discord error on success: ${r.report.errors}`);
  assert.deepEqual(st.get().lastRun, d(8, 0)); // unaffected by the ping
});

test('31. Discord failure ({error} AND throw) lands in errors, never fails the run, state still advances', async () => {
  const n1 = fakeNotify({ error: 'Discord webhook -> HTTP 401' });
  const { r: r1, st: st1 } = await passWithNotify(n1.notify);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.discordPing, { error: 'Discord webhook -> HTTP 401' });
  assert.ok(r1.report.errors.some((e) => e.includes('discord summary failed') && e.includes('HTTP 401')));
  assert.equal(st1.get().lastRun, d(8, 0)); // window watermark advanced despite the ping failure
  assert.equal(r1.postCard.posted, true);

  const n2 = fakeNotify(new Error('socket hang up'));
  const { r: r2, st: st2 } = await passWithNotify(n2.notify);
  assert.equal(r2.ok, true); // never rejects
  assert.deepEqual(r2.discordPing, { error: 'socket hang up' });
  assert.ok(r2.report.errors.some((e) => e.includes('socket hang up')));
  assert.equal(st2.get().lastRun, d(8, 0));
});

test('32. --no-post skips Discord too (zero external writes) — discordPing null, notify untouched', async () => {
  const n = fakeNotify({ sent: true });
  const touched = card('a'.repeat(24), 'Touched card');
  const t = fakeTrello({ cards: [touched], comments: { [a24('a')]: cleanTrail() } });
  const st = store({ lastRun: SINCE });
  const r = await runMetricsReport({
    ...noop,
    notify: n.notify,
    t,
    now: () => d(8, 0),
    noPost: true,
    readState: st.readState,
    writeState: st.writeState,
  });
  assert.equal(r.ok, true);
  assert.equal(n.calls, 0);
  assert.equal(r.discordPing, null);
  assert.deepEqual(st.get(), { lastRun: SINCE });
});

// ---------------------------------------------------------------------------
// 33-36. bounce-round fixes (card 6ae9676e2c38913cca053d37 review findings):
// honest touched counter, 404 report-card self-heal, live in-window cost cap,
// --no-post zero-write artifact contract.
// ---------------------------------------------------------------------------
test('33. cards.touchedInWindow counts ONLY in-window activity, not lifetime inclusions', () => {
  const clean = card('a'.repeat(24), 'Clean', { idList: DONE });
  const stale = card('n'.repeat(24), 'Stale bounce', { idList: DONE });
  // Entirely OUTSIDE the window: kept in perCards for the roll-ups (lifetime
  // QA:FAIL counts toward the gate figure) but it is NOT touched.
  const staleTrail = [c('2025-12-21T00:00:00.000Z', '[IMPL] r1'), c('2025-12-22T00:00:00.000Z', '[QA:FAIL] old')];
  const rep = computeMetrics({
    cards: [clean, stale],
    commentsByCard: { [a24('a')]: cleanTrail(), [a24('n')]: staleTrail },
    me,
    sinceIso: SINCE,
    untilIso: UNTIL,
    prodWatch: { status: 'up', lastCheck: d(2, 0), lastVerdict: 'up' },
    daemonLogs: [],
  });
  assert.equal(rep.bounces.perCard.length, 2); // stale card stays in perCards (lifetime roll-up)
  assert.equal(rep.bounces.perCard[1].bouncesLifetime, 1);
  assert.equal(rep.cards.onBoard, 2);
  assert.equal(rep.cards.touchedInWindow, 1); // only the card with in-window comments
});

test('34. pinned report card deleted (addComment 404) → pin cleared + persisted, window retried', async () => {
  const touched = card('a'.repeat(24), 'Touched card');
  const err404 = new Error('Trello POST /cards/x/actions/comments -> 404: not found');
  err404.status = 404;
  const t = fakeTrello({
    cards: [touched],
    comments: { [a24('a')]: cleanTrail() },
    errors: { addComment: err404, createCard: new Error('must not recreate in the failed run') },
  });
  const st = store({ lastRun: SINCE, lastReportCardId: 'reportcard00000000000000' });
  const r = await runMetricsReport({ t, now: () => d(2, 0), readState: st.readState, writeState: st.writeState, ...noop });
  assert.equal(r.ok, true); // self-heal must never reject the run
  assert.ok(r.report.errors.some((e) => e.includes('not found (404)') && e.includes('cleared the stale lastReportCardId')));
  assert.ok(r.report.errors.some((e) => e.includes('summary comment failed'))); // window still retried
  const persisted = st.get();
  assert.ok(!('lastReportCardId' in persisted), `stale pin must be gone: ${JSON.stringify(persisted)}`);
  assert.equal(persisted.lastRun, SINCE); // watermark PRESERVED — same window retried next run
  assert.equal(t.calls.createCard, 0);
  // Next run: no pin, no report card on the board → find-or-create recreates
  // it, the post succeeds, and the watermark advances.
  const t2 = fakeTrello({ cards: [touched], comments: { [a24('a')]: cleanTrail() } });
  const r2 = await runMetricsReport({ t: t2, now: () => d(3, 0), readState: st.readState, writeState: st.writeState, ...noop });
  assert.equal(r2.ok, true);
  assert.equal(t2.calls.createCard, 1); // recreated — reporting self-heals
  assert.equal(st.get().lastReportCardId, 'reportcard00000000000000');
  assert.equal(st.get().lastRun, d(3, 0));
});

test('34b. non-404 addComment failure keeps the pin untouched', async () => {
  const touched = card('a'.repeat(24), 'Touched card');
  const err500 = new Error('Trello POST -> 500: server error');
  err500.status = 500;
  const t = fakeTrello({ cards: [touched], comments: { [a24('a')]: cleanTrail() }, errors: { addComment: err500 } });
  const st = store({ lastRun: SINCE, lastReportCardId: 'reportcard00000000000000' });
  const r = await runMetricsReport({ t, now: () => d(2, 0), readState: st.readState, writeState: st.writeState, ...noop });
  assert.equal(r.ok, true);
  assert.ok(!r.report.errors.some((e) => e.includes('cleared the stale lastReportCardId')));
  assert.deepEqual(st.get(), { lastRun: SINCE, lastReportCardId: 'reportcard00000000000000' }); // nothing rewritten
});

test('35. maxCostCapUsd = newest IN-WINDOW dispatch header; fallback labeled', () => {
  const mk = (daemonLogs) =>
    computeMetrics({ cards: [], commentsByCard: {}, me, sinceIso: SINCE, untilIso: UNTIL, prodWatch: { status: 'up' }, daemonLogs });
  // A pre-window header with the OLD high cap must not outshine the live cap
  // (all-time-max reading showed $50 forever after FACTORY_MAX_COST dropped).
  const r1 = mk([
    { file: 'a.log', text: '# dispatch 2025-12-25T00:00:00.000Z omp ["--max-cost","50"]' },
    { file: 'b.log', text: `# dispatch ${d(3, 1)} omp ["--max-cost","10"]\n# resume ${d(5, 1)} omp ["--max-cost","25"]` },
  ]);
  assert.equal(r1.cost.runsInWindow, 2);
  assert.equal(r1.cost.maxCostCapUsd, 25); // NEWEST in-window header (d5 resume), not max 50
  assert.equal(r1.cost.costCapSource, 'newest-in-window-header');
  // Window with NO headers → newest overall, honestly labeled fallback.
  const r2 = mk([{ file: 'a.log', text: '# dispatch 2025-12-20T00:00:00.000Z omp ["--max-cost","50"]\n# dispatch 2025-12-25T00:00:00.000Z omp ["--max-cost","7"]' }]);
  assert.equal(r2.cost.maxCostCapUsd, 7); // newest overall, not the 50 max
  assert.equal(r2.cost.costCapSource, 'newest-header-no-in-window-runs');
  // No headers at all → default, labeled.
  const r3 = mk([]);
  assert.equal(r3.cost.maxCostCapUsd, 10);
  assert.equal(r3.cost.costCapSource, 'default');
});

test('36. --no-post writes NO artifacts; posted runs do (latest.json = posted reports only)', async () => {
  const touched = card('a'.repeat(24), 'Touched card');
  const t = fakeTrello({ cards: [touched], comments: { [a24('a')]: cleanTrail() } });
  const st = store({ lastRun: SINCE });
  const seen = [];
  const r = await runMetricsReport({
    ...noop,
    t,
    now: () => d(8, 0),
    noPost: true,
    readState: st.readState,
    writeState: st.writeState,
    writeArtifacts: (rep) => seen.push(rep.window.until),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, []); // dry diagnostics: latest.json + archive untouched
  assert.deepEqual(st.get(), { lastRun: SINCE }); // state likewise untouched
  const r2 = await runMetricsReport({
    ...noop,
    t,
    now: () => d(8, 0),
    readState: st.readState,
    writeState: st.writeState,
    writeArtifacts: (rep) => seen.push(rep.window.until),
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.postCard.posted, true);
  assert.deepEqual(seen, [d(8, 0)]); // posted run persists its report
});

// ---------------------------------------------------------------------------
// Compact bounded board summary (Trello comment cap — QA bounce round).
// ---------------------------------------------------------------------------

/** Adversarial full-board-scale fixture: 300 cards (100 at the needs-human
 * park gate, 150 single-bounce, 50 clean), every card with a 4,000-char name
 * and a crash comment; asks unanswered; dispatch headers with a live cap. */
function adversarialReport() {
  const cards = [];
  const commentsByCard = {};
  for (let i = 0; i < 300; i++) {
    const id = `c${String(i).padStart(23, '0')}`;
    const name = `Long card ${i} — ${'z'.repeat(4000)}\nwith a newline`;
    const labels = i < 7 ? NEEDS_HUMAN : [];
    cards.push(card(id, name, { labels }));
    const trail = [...cleanTrail(), c(d(3, 0), '[DAEMON-CRASH] boom'), c(d(3, 1), '[ASK] help me', 'bot')];
    if (i < 100) {
      // net lifetime 3 -> gate park condition -> needsHumanRisk
      trail.push(c(d(3, 2), '[REVIEW:CHANGES] f1\nfindings'), c(d(3, 3), '[QA:FAIL] nope'), c(d(3, 4), '[SEC:FINDINGS] leak'));
    } else if (i < 250) {
      trail.push(c(d(3, 2), '[VERIFY:FAIL] red'));
    }
    commentsByCard[id] = trail;
  }
  const rep = computeMetrics({
    cards,
    commentsByCard,
    me,
    sinceIso: SINCE,
    untilIso: UNTIL,
    prodWatch: { status: 'up', incident: null },
    daemonLogs: [{ file: 'a.log', text: `# dispatch ${d(4, 0)} omp ["--max-cost","10"]\ntotal cost usd $4.20` }],
  });
  // Shell-injected degraded-read errors (300 of them, long + multiline).
  for (let k = 0; k < 300; k++) rep.errors.push(`card ${k} comments read failed:\n${'E'.repeat(3000)}`);
  return rep;
}

test('37. compact summary is bounded on a board-history-sized adversarial report', () => {
  const rep = adversarialReport();
  const body = buildMetricsComment(rep);
  assert.ok(body.startsWith('[METRICS] '), 'first-token contract');
  assert.ok(body.length <= METRICS_COMMENT_MAX_CHARS, `body ${body.length} must stay under ${METRICS_COMMENT_MAX_CHARS}`);
  assert.ok(body.length < 16_384, 'hard Trello cap');
  assert.ok(body.length < 8000, `built-in caps must keep the natural body small: ${body.length}`);
  assert.equal(body.split('\n')[0], buildMetricsHeadline(rep)); // headline preserved verbatim
  for (const tok of [
    'cards:', 'bounces:', 'needs-human risk:', 'top bounced:', 'stage times:', 'crashes:',
    'asks:', 'findings:', 'prod:', 'cost: 1 runs in window vs live cap $10 (source newest-in-window-header); spend $4.2',
    'errors:', 'caveats:',
  ]) {
    assert.ok(body.includes(tok), `summary missing "${tok}"`);
  }
  // Every free-text list is capped with a deterministic +N-more marker.
  assert.ok(body.includes('(+88 more — full list in the JSON artifact)'), 'needs-human risk list must cap at 12');
  assert.ok(body.includes('(+238 more — full list in the JSON artifact)'), 'top-bounced list must cap at 12');
  assert.ok(body.includes('(+288 more — full list in the JSON artifact)'), 'crash list must cap at 12');
  assert.ok(body.includes('(+297 more)'), 'error lines must cap at 3');
  // Names clipped, never dumped whole; no raw JSON dump anywhere.
  assert.ok(body.includes('…'), 'clipped names must carry the ellipsis marker');
  assert.ok(!body.includes('z'.repeat(100)), 'a full 4,000-char name must never reach the comment');
  assert.ok(!body.includes('"perCard"'), 'no raw JSON keys in the summary');
  assert.ok(!body.includes('```json'), 'no fenced JSON dump on the board');
  // The summary itself (without the headline) is independently bounded.
  assert.ok(buildMetricsSummary(rep).length < METRICS_COMMENT_MAX_CHARS);
});

test('38. hard length guard: pathological window strings clamp deterministically to the cap', () => {
  const rep = computeMetrics({
    cards: [card('a'.repeat(24), 'Normal')],
    commentsByCard: { [a24('a')]: cleanTrail() },
    me,
    sinceIso: SINCE,
    untilIso: UNTIL,
    prodWatch: { status: 'up' },
    daemonLogs: [],
  });
  // e.g. an absurd operator-set FACTORY_METRICS_SINCE embedded in the headline.
  rep.window.since = 'x'.repeat(30_000);
  const body = buildMetricsComment(rep);
  assert.equal(body.length, METRICS_COMMENT_MAX_CHARS); // exact deterministic clamp
  assert.ok(body.startsWith('[METRICS] x'), 'first-token contract survives the clamp');
  assert.ok(body.endsWith(SUMMARY_TAIL), 'clamp tail names the full-report artifact');
});

test('39. adversarial run posts a bounded summary while artifacts carry the FULL report', async () => {
  const cards = [];
  const comments = {};
  for (let i = 0; i < 300; i++) {
    const id = `c${String(i).padStart(23, '0')}`;
    cards.push(card(id, `Long card ${i} — ${'z'.repeat(4000)}`));
    comments[id] = [...cleanTrail(), c(d(3, 2), '[QA:FAIL] red')];
  }
  const t = fakeTrello({ cards, comments });
  const st = store(null);
  const arts = [];
  const r = await runMetricsReport({
    ...noop,
    t,
    now: () => d(8, 0),
    readState: st.readState,
    writeState: st.writeState,
    writeArtifacts: (rep) => arts.push(rep),
  });
  assert.equal(r.ok, true);
  assert.equal(t.calls.addComment.length, 1);
  const body = t.calls.addComment[0].text;
  assert.ok(body.startsWith('[METRICS] '));
  assert.ok(body.length <= METRICS_COMMENT_MAX_CHARS, `posted body ${body.length} exceeds the cap`);
  assert.ok(body.length < 16_384, 'hard Trello cap');
  assert.ok(!body.includes('```json'));
  assert.ok(body.includes('top bounced:'), 'summary lines present');
  // The artifact keeps the FULL roll-up — the comment is compact, the JSON is not.
  assert.equal(arts.length, 1);
  assert.equal(arts[0].bounces.perCard.length, 300);
  assert.ok(arts[0].bounces.perCard.some((m) => m.name.length > 4000), 'giant names survive intact in the JSON artifact');
  assert.ok(JSON.stringify(arts[0]).length > body.length * 2, 'artifact is strictly richer than the comment');
  assert.deepEqual(st.get().lastReportCardId, 'reportcard00000000000000');
});

// ---------------------------------------------------------------------------
// 40. mirror-drift guard — the metrics BOUNCE_TAGS copy vs the curator's
//     single-source list (finding #2, card 6ae9677239bb2697a13ea728: a
//     rebase resolution left the mirror on the pre-[CHECK:FAIL] formula and
//     windowTagTally silently dropped gate FAILs while the netted side,
//     reading countBounces, counted them).
// ---------------------------------------------------------------------------
test('40. BOUNCE_TAGS mirror equals the curator list exactly — no drift', () => {
  assert.deepEqual(BOUNCE_TAGS, CURATOR_BOUNCE_TAGS);
  assert.ok(BOUNCE_TAGS.includes('[CHECK:FAIL]'), 'the gate FAIL counts in the raw tally too');
  // windowTagTally must not drop the gate's FAIL (and must ignore its PASS).
  const trail = [c(d(1, 2), '[CHECK:FAIL] npm test exit 1'), c(d(1, 3), '[CHECK:PASS] green')];
  const m = computeCardMetrics(card('n'.repeat(24), 'Gate verdicts'), trail, W);
  assert.equal(m.bounces.windowTagTally, 1, 'raw tally counts exactly the [CHECK:FAIL]');
  assert.equal(m.bounces.lifetime, 1, 'netted gate (countBounces) counts it too');
});

// ---------------------------------------------------------------------------
// 41-44. askOnTop — the ask-on-top invariant guardrail (card
// 6af60d6a85947225f6ed75a0): a needs-human card's NEWEST comment must be the
// human-facing request (`[ASK]` first line, or a park comment whose SECOND
// line is the `needs you:` action).
// ---------------------------------------------------------------------------

test('41. askOnTopOk: [ASK] newest → true; park action line 2 → true; crash noise on top → false; empty/undated → false; array order never trusted', () => {
  const ask = c(d(2, 5), '[ASK] approve sha abc1234?');
  const parkTop = c(d(2, 6), '[DAEMON-CRASH] run exited 1 after 2 prior crash(es); parking needs-human where it stands (Implement)\nneeds you: reply anything (e.g. "resume") to restart at Implement.');
  const noise = c(d(2, 7), '[DAEMON-CRASH] run exited 1; stage-aware resume at Implement (crash 1/3)\n\n--- run log tail (p.log, last ≤40 lines / ≤4000 chars) ---\nboom');
  assert.equal(askOnTopOk([ask, c(d(2, 4), '[IMPL] evidence')]), true);
  assert.equal(askOnTopOk([c(d(2, 4), '[IMPL] evidence'), ask]), true); // oldest-first input — dates decide, not array order
  assert.equal(askOnTopOk([ask, parkTop].reverse()), true); // park newest → second line names the action
  assert.equal(askOnTopOk([noise, ask]), false); // forensic noise buries the ask — the card-28 shape
  assert.equal(askOnTopOk([]), false);
  assert.equal(askOnTopOk([c('not-a-date', '[ASK] undated')]), false); // undated = unprovable = violation
});

test('42. computeMetrics.askOnTop: needsHumanCards/scored/ok/offenders roll-up; unfetched trails excluded; zero needs-human → ok:null', () => {
  const good = card('g'.repeat(24), 'Waiting on ask', { labels: NEEDS_HUMAN });
  const bad = card('b'.repeat(24), 'Buried ask', { labels: NEEDS_HUMAN });
  const unpicked = card('u'.repeat(24), 'Trail unreadable', { labels: NEEDS_HUMAN });
  const clean = card('c'.repeat(24), 'Done and clean');
  const rep = computeMetrics({
    cards: [good, bad, unpicked, clean],
    commentsByCard: {
      [a24('g')]: [c(d(2, 4), '[IMPL] evidence'), c(d(2, 5), '[ASK] approve sha?')],
      [a24('b')]: [c(d(2, 5), '[ASK] approve sha?'), c(d(2, 6), '[DAEMON-CRASH] run exited 1; stage-aware resume at QA (crash 1/3)')],
      // unpicked: no trail entry at all — the fetch failed; excluded, never guessed
    },
    me,
    sinceIso: SINCE,
    untilIso: UNTIL,
    prodWatch: { status: 'up' },
    daemonLogs: [],
  });
  assert.deepEqual(rep.askOnTop, {
    needsHumanCards: 3,
    scored: 2,
    ok: false,
    offenders: [a24('b')],
  });
  // all needs-human clean → ok:true
  const ok = computeMetrics({
    cards: [good, bad],
    commentsByCard: {
      [a24('g')]: [c(d(2, 5), '[ASK] approve sha?')],
      [a24('b')]: [c(d(2, 5), '[DAEMON-CRASH] parked (Implement)\nneeds you: reply anything (e.g. "resume") to restart at Implement.')],
    },
    me, sinceIso: SINCE, untilIso: UNTIL, prodWatch: null, daemonLogs: [],
  });
  assert.deepEqual(ok.askOnTop, { needsHumanCards: 2, scored: 2, ok: true, offenders: [] });
  // zero needs-human cards → null — never a fabricated green
  const none = computeMetrics({ cards: [clean], commentsByCard: {}, me, sinceIso: SINCE, untilIso: UNTIL, prodWatch: null, daemonLogs: [] });
  assert.deepEqual(none.askOnTop, { needsHumanCards: 0, scored: 0, ok: null, offenders: [] });
});

test('43. headline + summary carry the ask-on-top guardrail (n/a / ok / VIOLATED with offenders)', () => {
  const bad = card('b'.repeat(24), 'Buried', { labels: NEEDS_HUMAN });
  const rep = computeMetrics({
    cards: [bad],
    commentsByCard: { [a24('b')]: [c(d(2, 5), '[ASK] approve?'), c(d(2, 6), '[DAEMON-CRASH] noise')] },
    me, sinceIso: SINCE, untilIso: UNTIL, prodWatch: { status: 'up' }, daemonLogs: [],
  });
  const line = buildMetricsHeadline(rep);
  assert.ok(line.includes('needs-human ask-on-top VIOLATED (1/1'), line);
  assert.ok(line.includes(`offenders ${a24('b')}`), line);
  const summary = buildMetricsSummary(rep);
  assert.ok(summary.includes('ask-on-top (needs-human): VIOLATED — scored 1/1'), summary);
  const none = computeMetrics({ cards: [card('c'.repeat(24), 'Clean')], commentsByCard: {}, me, sinceIso: SINCE, untilIso: UNTIL, prodWatch: { status: 'up' }, daemonLogs: [] });
  assert.ok(buildMetricsHeadline(none).includes('needs-human ask-on-top n/a (0/0)'));
  const good = computeMetrics({
    cards: [card('g'.repeat(24), 'Good', { labels: NEEDS_HUMAN })],
    commentsByCard: { [a24('g')]: [c(d(2, 5), '[ASK] approve?')] },
    me, sinceIso: SINCE, untilIso: UNTIL, prodWatch: { status: 'up' }, daemonLogs: [],
  });
  assert.ok(buildMetricsHeadline(good).includes('needs-human ask-on-top ok (1/1)'));
  assert.ok(buildMetricsHeadline(good).includes('ask-on-top'), 'AC: the family name is in the headline (test 27 includes-style contract)');
});

test('44. runMetricsReport fetches the newest comment for UNTOUCHED needs-human cards and errors out unfetchable ones (no fabricated scoring)', async () => {
  // A card parked long ago: its whole trail pre-dates the window.
  const parked = card(a24('p'), 'Parked in September', { labels: NEEDS_HUMAN });
  const oldTrail = [c('2025-12-20T00:00:00.000Z', '[IMPL] evidence'), c('2025-12-21T00:00:00.000Z', '[DAEMON-CRASH] run exited 1 after 2 prior crash(es); parking needs-human where it stands (QA)\nneeds you: reply anything (e.g. "resume") to restart at QA.')];
  const t = fakeTrello({ cards: [parked], comments: { [a24('p')]: oldTrail } });
  const st = store({ lastRun: SINCE });
  const r = await runMetricsReport({ t, now: () => d(8, 0), noPost: true, readState: st.readState, writeState: st.writeState, ...noop });
  assert.equal(r.ok, true);
  assert.deepEqual(r.report.askOnTop, { needsHumanCards: 1, scored: 1, ok: true, offenders: [] }); // scored OFF the limit-1 newest-comment fetch

  // Unfetchable trail → error entry, card EXCLUDED (D6 honesty): never a
  // fabricated red, ok:false only because the population is unscored.
  const broken = card('b'.repeat(24), 'Fetch fails', { labels: NEEDS_HUMAN });
  const t2 = fakeTrello({ cards: [broken], comments: {}, errors: { [`comments:${a24('b')}`]: new Error('ETIMEDOUT') } });
  const st2 = store({ lastRun: SINCE });
  const r2 = await runMetricsReport({ t: t2, now: () => d(8, 0), noPost: true, readState: st2.readState, writeState: st2.writeState, ...noop });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.report.askOnTop, { needsHumanCards: 1, scored: 0, ok: false, offenders: [] });
  assert.ok(r2.report.errors.some((e) => e.includes('ETIMEDOUT')));
});
