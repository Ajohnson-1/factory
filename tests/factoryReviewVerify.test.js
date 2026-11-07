/**
 * Unit tests for scripts/lib/factory-review-verify.js + the `review-verify` /
 * `bounces` CLI wiring in scripts/factory.js + the [REVIEW:VERIFY] board
 * contract (card 6ae9676c5392eefe0202017f; spec: docs/factory.md "Verifying
 * reviewer findings"). node:test — registered in the `node --test` half of
 * the package.json test allowlist. Fake trello with call counters, zero live
 * Trello; CLI cases hit only pre-network paths (factoryAuditCards.test.js
 * test-8 convention).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  BOUNCE_CAP,
  SEVERITIES,
  VERDICTS,
  parseFindings,
  applyClassifications,
  tally,
  formatVerifyComment,
  parseVerifyDecision,
  countBounces,
  buildVerifierPrompt,
  runReviewVerify,
} from '../scripts/lib/factory-review-verify.js';
import { isStageTagText } from '../scripts/lib/factory-comment-resume.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');
const REAL_DOC = readFileSync(path.join(ROOT, 'docs', 'factory.md'), 'utf8');

const CARD = { id: '6ae9676c5392eefe0202017f', name: 'Verify reviewer findings' };

/** Fake trello: `comments` newest-first (live getCardComments order) + call
 * counters + the posted-comment log. */
function fakeTrello(comments = []) {
  const calls = { getCardComments: 0, addComment: 0 };
  const posted = [];
  return {
    calls,
    posted,
    async getCardComments() {
      calls.getCardComments += 1;
      return comments;
    },
    async addComment(cardId, text) {
      calls.addComment += 1;
      posted.push({ cardId, text });
      return { id: 'postedcomment000000000001' };
    },
  };
}

const cm = (text, date) => ({ date, data: { text } });

// ---- parser ----

// 1. Tagged lines in all three marker styles + extra whitespace → canonical
// severities + 1-based indexes; prose lines ignored; untagged bullet-only
// legacy body → all Important (fail-closed); empty body → [].
test('1. parseFindings: marker styles, canonical severities, 1-based indexes, prose ignored, legacy fallback', () => {
  const body = [
    '[REVIEW:CHANGES] two real issues and one inherited wart.',
    'Mergeability: clean — factory.js mergeable exits 0.',
    '- [Important] parseVerifyDecision ignores an uppercase decision token.',
    '1. [NIT]   rename `t` to `tallied` for readability.',
    '*   [Pre-Existing]  eslint noise in scripts/deploy.js predates the branch.',
    'Overall: needs another pass before QA.',
  ].join('\n');
  const fs = parseFindings(body);
  assert.equal(fs.length, 3);
  assert.deepEqual(
    fs.map((f) => [f.index, f.severity]),
    [
      [1, 'Important'],
      [2, 'Nit'],
      [3, 'Pre-existing'],
    ],
  );
  assert.equal(fs[0].text, 'parseVerifyDecision ignores an uppercase decision token.');
  assert.equal(fs[1].text, 'rename `t` to `tallied` for readability.');
  assert.ok(!fs.some((f) => /Mergeability|Overall/.test(f.text)));
  // bare tagged line (no list marker) parses too
  assert.equal(parseFindings('[nit] missing newline at EOF').length, 1);
  // legacy untagged bullet-only body → all Important, bullets only
  const legacy = parseFindings('[REVIEW:CHANGES] fix these:\n- first problem\n2. second problem\nprose tail');
  assert.deepEqual(
    legacy.map((f) => [f.index, f.severity]),
    [
      [1, 'Important'],
      [2, 'Important'],
    ],
  );
  assert.deepEqual(parseFindings(''), []);
  assert.deepEqual(parseFindings(undefined), []);
});

// ---- classification matrix ----

// 2. Full matrix incl. absent-classification fail-closed; unknown verdict and
// orphan classification index throw.
test('2. applyClassifications: mapping matrix, fail-closed absence, throws on bad verdict/index', () => {
  const mk = (severity) => [{ index: 1, severity, text: 'x' }];
  const finalOf = (severity, verdict) =>
    applyClassifications(mk(severity), verdict ? [{ index: 1, verdict, why: 'w' }] : [])[0].final;
  assert.equal(finalOf('Important', 'real'), 'Important');
  assert.equal(finalOf('Important', 'style-only'), 'Nit');
  assert.equal(finalOf('Important', 'pre-existing'), 'Pre-existing');
  assert.equal(finalOf('Important', null), 'Important'); // absent → fail closed
  assert.equal(finalOf('Nit', 'real'), 'Nit'); // never promoted
  assert.equal(finalOf('Nit', 'style-only'), 'Nit');
  assert.equal(finalOf('Nit', 'pre-existing'), 'Pre-existing');
  assert.equal(finalOf('Nit', null), 'Nit');
  for (const v of ['real', 'style-only', 'pre-existing', null]) {
    assert.equal(finalOf('Pre-existing', v), 'Pre-existing');
  }
  // rows echo severity/verdict/why for the verdict comment
  const rows = applyClassifications(mk('Important'), [{ index: 1, verdict: 'style-only', why: 'cosmetic' }]);
  assert.deepEqual(rows, [
    { index: 1, severity: 'Important', verdict: 'style-only', why: 'cosmetic', final: 'Nit' },
  ]);
  assert.throws(() => applyClassifications(mk('Important'), [{ index: 1, verdict: 'real-ish', why: 'typo' }]), /unknown verdict/);
  assert.throws(() => applyClassifications(mk('Nit'), [{ index: 7, verdict: 'real', why: 'x' }]), /matches no finding/);
});

// ---- tally ----

// 3. Only final-Important drives bounce; all-Nit / all-Pre-existing net zero.
test('3. tally: only CONFIRMED Important bounces', () => {
  const row = (final) => ({ severity: 'Important', verdict: null, why: null, final });
  assert.deepEqual(tally([row('Important'), row('Nit'), row('Pre-existing')]), {
    confirmed: 1,
    nits: 1,
    preExisting: 1,
    bounce: true,
  });
  assert.deepEqual(tally([row('Nit'), row('Nit')]), { confirmed: 0, nits: 2, preExisting: 0, bounce: false });
  assert.deepEqual(tally([row('Pre-existing')]), { confirmed: 0, nits: 0, preExisting: 1, bounce: false });
  assert.deepEqual(tally([]), { confirmed: 0, nits: 0, preExisting: 0, bounce: false });
});

// ---- verdict comment format ----

// 4. formatVerifyComment + parseVerifyDecision round-trip per the contract
// format (header fields + one #<index> [<from>→<to>] line per finding).
test('4. verdict comment round-trip: header fields, per-finding lines, decision parse', () => {
  const rows = [
    { index: 1, severity: 'Important', verdict: 'real', why: 'regex missing /i at lib.js:12', final: 'Important' },
    { index: 2, severity: 'Important', verdict: 'style-only', why: 'cosmetic', final: 'Nit' },
    { index: 3, severity: 'Pre-existing', verdict: 'pre-existing', why: 'present on origin/master', final: 'Pre-existing' },
  ];
  const text = formatVerifyComment(rows, { bounces: 1 });
  assert.ok(text.startsWith('[REVIEW:VERIFY]'));
  const header = text.split('\n')[0];
  assert.match(header, /decision=bounce/);
  assert.match(header, /confirmed=1/);
  assert.match(header, /nits=1/);
  assert.match(header, /pre-existing=1/);
  assert.match(header, /bounces=1\/3/);
  for (const r of rows) assert.ok(text.includes(`#${r.index} [${r.severity}→${r.final}] ${r.verdict}: ${r.why}`));
  assert.ok(text.includes('Nits never bounce'));
  assert.ok(text.includes('do not block this card'));
  assert.equal(parseVerifyDecision(text), 'bounce');
  const proceed = formatVerifyComment(rows.slice(1), { bounces: 0 });
  assert.match(proceed.split('\n')[0], /decision=proceed/);
  assert.equal(parseVerifyDecision(proceed), 'proceed');
  // an unverified row fails closed in the rendered line too
  const unverified = formatVerifyComment([{ index: 1, severity: 'Important', verdict: null, why: null, final: 'Important' }], {});
  assert.equal(parseVerifyDecision(unverified), 'bounce');
  assert.match(unverified, /#1 \[Important→Important\] unverified:/);
  // negatives
  assert.equal(parseVerifyDecision('[REVIEW:CHANGES] decision=bounce-ish'), null);
  assert.equal(parseVerifyDecision('prose mentioning decision=bounce'), null);
  assert.equal(parseVerifyDecision('[REVIEW:VERIFY] mangled header'), null);
});

// ---- verifier prompt ----

// 5. One finding, read-only + fresh-context instructions, the diff command,
// all three verdict tokens, the card id.
test('5. buildVerifierPrompt: finding + diff command + verdict tokens + read-only + card id', () => {
  const p = buildVerifierPrompt(CARD, { index: 2, severity: 'Important', text: 'helper shadows the import' });
  assert.ok(p.includes('helper shadows the import'));
  assert.ok(p.includes(`git diff origin/master...factory/${CARD.id}`));
  for (const v of VERDICTS) assert.ok(p.includes(v), `prompt missing verdict token ${v}`);
  assert.ok(p.includes('READ-ONLY'));
  assert.ok(p.includes('fresh-context'));
  assert.ok(p.includes(CARD.id));
  assert.deepEqual(SEVERITIES, ['Important', 'Nit', 'Pre-existing']);
  assert.equal(BOUNCE_CAP, 3);
});

// ---- bounce counting ----

// 6. Chronological pairing: proceed nets zero, legacy counts, two-CHANGES
// ordering, empty + malformed-date fail-closed.
test('6. countBounces: pairing chronology, proceed nets zero, legacy counts, park at cap', () => {
  // a. qa=2 + bounce-pair(1) + proceed-pair(0) + verify-fail=1 → review1+qa2+
  // verify1 = 4 → park (invariant bounces = review+qa+verify; the plan's
  // literal "3" mis-sums its own breakdown)
  const a = [
    cm('[REVIEW:VERIFY] decision=proceed confirmed=0 nits=1 pre-existing=0 bounces=2/3', '2025-01-05T10:00:00.000Z'),
    cm('[REVIEW:CHANGES] - [Important] rename helper', '2025-01-04T10:00:00.000Z'),
    cm('[REVIEW:VERIFY] decision=bounce confirmed=1 nits=0 pre-existing=0 bounces=2/3', '2025-01-03T10:00:00.000Z'),
    cm('[REVIEW:CHANGES] - [Important] real bug', '2025-01-02T10:00:00.000Z'),
    cm('[VERIFY:FAIL] {"down":true}', '2025-01-02T09:00:00.000Z'),
    cm('[QA:FAIL] red test', '2025-01-01T11:00:00.000Z'),
    cm('[QA:FAIL] red again', '2025-01-01T10:00:00.000Z'),
  ];
  assert.deepEqual(countBounces(a), { bounces: 4, cap: 3, park: true, breakdown: { review: 1, sec: 0, qa: 2, check: 0, verify: 1 } });
  // b. legacy: CHANGES with no paired VERIFY counts 1, park alone is false;
  // [SEC:FINDINGS] counts unconditionally (sibling security sub-pass)
  assert.deepEqual(countBounces([cm('[REVIEW:CHANGES] - [Important] x', '2025-01-02T10:00:00.000Z')]), {
    bounces: 1,
    cap: 3,
    park: false,
    breakdown: { review: 1, sec: 0, qa: 0, check: 0, verify: 0 },
  });
  assert.deepEqual(
    countBounces([
      cm('[REVIEW:CHANGES] - [Important] x', '2025-01-02T10:00:00.000Z'),
      cm('[SEC:FINDINGS] HIGH: hardcoded token', '2025-01-01T10:00:00.000Z'),
    ]),
    { bounces: 2, cap: 3, park: false, breakdown: { review: 1, sec: 1, qa: 0, check: 0, verify: 0 } },
  );
  // c. two CHANGES then ONE proceed verdict leaves exactly one counted
  const c = [
    cm('[REVIEW:VERIFY] decision=proceed confirmed=0', '2025-01-03T10:00:00.000Z'),
    cm('[REVIEW:CHANGES] round 2 findings', '2025-01-02T10:00:00.000Z'),
    cm('[REVIEW:CHANGES] round 1 findings', '2025-01-01T10:00:00.000Z'),
  ];
  assert.deepEqual(countBounces(c).breakdown, { review: 1, sec: 0, qa: 0, check: 0, verify: 0 });
  assert.equal(countBounces(c).bounces, 1);
  // c2. [CHECK:FAIL] (daemon blocking-checks gate, card 6ae9677239bb2697a13ea728)
  // counts unconditionally exactly like [VERIFY:FAIL]; [CHECK:PASS] never counts.
  assert.deepEqual(
    countBounces([
      cm('[CHECK:FAIL] npm test exit 1 — tail: 2 failed', '2025-01-02T10:00:00.000Z'),
      cm('[CHECK:PASS] all 1 blocking checks green', '2025-01-01T10:00:00.000Z'),
    ]),
    { bounces: 1, cap: 3, park: false, breakdown: { review: 0, sec: 0, qa: 0, check: 1, verify: 0 } },
  );
  // d. empty / non-array → zeros; malformed dates sort oldest and still pair
  const empty = { bounces: 0, cap: 3, park: false, breakdown: { review: 0, sec: 0, qa: 0, check: 0, verify: 0 } };
  assert.deepEqual(countBounces([]), empty);
  assert.deepEqual(countBounces(undefined), empty);
  const d = [
    cm('[REVIEW:VERIFY] decision=proceed', '2025-01-02T10:00:00.000Z'),
    cm('[REVIEW:CHANGES] undated round', 'not-a-date'),
  ];
  assert.equal(countBounces(d).bounces, 0); // undated CHANGES sorts first → pairs → nets zero
});

// ---- runReviewVerify ----

// 7. Happy path: latest [REVIEW:CHANGES] wins (older round + its verdict are
// already resolved), exactly ONE comment posted, bounce verdict + counted.
test('7. runReviewVerify: posts one [REVIEW:VERIFY] bounce verdict, returns counts', async () => {
  const t = fakeTrello([
    cm(
      [
        '[REVIEW:CHANGES] two findings + one inherited:',
        '- [Important] parseVerifyDecision ignores an uppercase decision',
        '- [Important] misleading variable name in tally',
        '- [Pre-existing] eslint noise in scripts/deploy.js',
      ].join('\n'),
      '2025-01-04T10:00:00.000Z',
    ),
    cm('[REVIEW:VERIFY] decision=proceed confirmed=0 nits=1 pre-existing=0 bounces=0/3', '2025-01-03T10:00:00.000Z'),
    cm('[REVIEW:CHANGES] - [Important] older round finding', '2025-01-02T10:00:00.000Z'),
  ]);
  const res = await runReviewVerify({
    cardId: CARD.id,
    classifications: [
      { index: 1, verdict: 'real', why: 'regex missing /i at lib.js:12' },
      { index: 2, verdict: 'style-only', why: 'cosmetic' },
      { index: 3, verdict: 'pre-existing', why: 'present on origin/master' },
    ],
    t,
  });
  assert.equal(t.calls.addComment, 1);
  assert.equal(t.posted[0].cardId, CARD.id);
  assert.ok(t.posted[0].text.startsWith('[REVIEW:VERIFY] decision=bounce'));
  assert.ok(t.posted[0].text.includes('#1 [Important→Important] real:'));
  assert.deepEqual(
    { confirmed: res.confirmed, nits: res.nits, preExisting: res.preExisting, bounce: res.bounce, decision: res.decision, bounces: res.bounces, park: res.park },
    { confirmed: 1, nits: 1, preExisting: 1, bounce: true, decision: 'bounce', bounces: 1, park: false },
  );
  assert.equal(res.card, CARD.id);
  assert.equal(res.findings.length, 3);
});

// 8. Proceed case: the lone Important classifies style-only → no bounce,
// proceed header, its tentative pair nets to zero.
test('8. runReviewVerify proceed: style-only Important → decision=proceed, bounces net zero', async () => {
  const t = fakeTrello([
    cm('[REVIEW:CHANGES] nits only after verification:\n- [Nit] extra blank line\n- [Important] extract the helper?', '2025-01-04T10:00:00.000Z'),
  ]);
  const res = await runReviewVerify({
    cardId: CARD.id,
    classifications: [{ index: 2, verdict: 'style-only', why: 'taste, not correctness' }],
    t,
  });
  assert.equal(res.decision, 'proceed');
  assert.equal(res.bounce, false);
  assert.equal(res.confirmed, 0);
  assert.equal(res.nits, 2);
  assert.equal(res.bounces, 0);
  assert.equal(res.park, false);
  assert.ok(t.posted[0].text.startsWith('[REVIEW:VERIFY] decision=proceed'));
  assert.match(t.posted[0].text.split('\n')[0], /bounces=0\/3/);
});

// 9. Misuse throws with ZERO comments on every path: no CHANGES, zero parsed
// findings, orphan classification index, non-array payload.
test('9. runReviewVerify misuse throws with zero addComment', async () => {
  const t0 = fakeTrello([cm('[REVIEW:APPROVE] clean', '2025-01-01T10:00:00.000Z')]);
  await assert.rejects(() => runReviewVerify({ cardId: CARD.id, classifications: [], t: t0 }), /no \[REVIEW:CHANGES\]/);
  assert.equal(t0.calls.addComment, 0);
  const t1 = fakeTrello([cm('[REVIEW:CHANGES] needs work; the notes are in the diff.', '2025-01-01T10:00:00.000Z')]);
  await assert.rejects(() => runReviewVerify({ cardId: CARD.id, classifications: [], t: t1 }), /no parseable findings/);
  assert.equal(t1.calls.addComment, 0);
  const t2 = fakeTrello([cm('[REVIEW:CHANGES]\n- [Important] real issue', '2025-01-01T10:00:00.000Z')]);
  await assert.rejects(
    () => runReviewVerify({ cardId: CARD.id, classifications: [{ index: 9, verdict: 'real', why: 'x' }], t: t2 }),
    /matches no finding/,
  );
  assert.equal(t2.calls.addComment, 0);
  const t3 = fakeTrello([cm('[REVIEW:CHANGES]\n- [Important] real issue', '2025-01-01T10:00:00.000Z')]);
  await assert.rejects(() => runReviewVerify({ cardId: CARD.id, classifications: undefined, t: t3 }), /JSON array/);
  assert.equal(t3.calls.addComment, 0);
});

// ---- CLI wiring (pre-network paths only) ----

const runCli = (...argv) =>
  spawnSync(process.execPath, [FACTORY_JS, ...argv], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

// 10. help advertises both commands; bad card ids exit 1 before any network.
test('10. CLI: help lists review-verify + bounces; notanid exits 1', () => {
  const h = runCli('help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /review-verify <card> <classesJson\|->/);
  assert.match(h.stdout, /bounces <card>/);
  const rv = runCli('review-verify', 'notanid', '-');
  assert.equal(rv.status, 1);
  assert.match(rv.stderr, /Not a Trello card id/);
  const b = runCli('bounces', 'notanid');
  assert.equal(b.status, 1);
  assert.match(b.stderr, /Not a Trello card id/);
});

// ---- comment-resume trail integrity ----

// 11. The resume watcher's tag vocabulary knows [REVIEW:VERIFY] (imported
// from the real module — same STAGE_TAGS list production uses).
test('11. factory-comment-resume recognizes [REVIEW:VERIFY]', () => {
  assert.equal(
    isStageTagText('[REVIEW:VERIFY] decision=proceed confirmed=0 nits=1 pre-existing=0 bounces=0/3'),
    '[REVIEW:VERIFY]',
  );
});

// ---- docs consistency (reads the REAL doc — audit-cards test-1 style) ----

// 12. Board-contract tag list, Stages Review-verify row + finding-tag
// requirement, scheduler loop block + bounce counting, CLI lines, and the
// dedicated section all exist in docs/factory.md.
test('12. docs/factory.md carries the Review-verify contract', () => {
  assert.ok(REAL_DOC.includes('[REVIEW:VERIFY]'), 'board-contract tag list');
  assert.ok(REAL_DOC.includes('Review-verify'), 'Stages row');
  assert.ok(REAL_DOC.includes('each finding on its own line tagged `[Important]` / `[Nit]` / `[Pre-existing]`'), 'Review finding tags');
  assert.ok(REAL_DOC.includes('## Verifying reviewer findings'), 'dedicated section');
  assert.ok(REAL_DOC.includes('verifier: `style-only`'), 'mapping table');
  assert.ok(REAL_DOC.includes('node scripts/factory.js review-verify <card> -'), 'scheduler loop block');
  assert.ok(REAL_DOC.includes('node scripts/factory.js bounces <card>'), 'bounce counting line');
  assert.ok(REAL_DOC.includes('scripts/lib/factory-review-verify.js'), 'lib pointer');
});
