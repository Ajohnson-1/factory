/**
 * Unit tests for scripts/lib/factory-eval.js (incident/eval set + reviewer
 * replay scoring; card 6ae967737b472b3a8d0a9805). Zero live Trello, zero
 * agent spawns: the board reader, the seed reader, the spawn and the argv
 * builder are all DI'd with fakes here, mirroring tests/factoryProdClose.test.js.
 * Run under `node --test` (registered in both package.json runner lists).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  CASES_PATH,
  REPLAY_SEED_SENTENCE,
  deriveExpectedVerdict,
  harvestBoard,
  harvestSeed,
  mergeCases,
  buildReviewerPrompt,
  spawnReviewerRun,
  parseVerdict,
  scoreCases,
  formatReport,
} from '../scripts/lib/factory-eval.js';
import { STAGE_PROMPT_FILES } from '../scripts/factory-daemon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');
const CASES_FILE = path.join(ROOT, 'eval', 'cases.jsonl');

const CARD_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CARD_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const CARD_C = 'cccccccccccccccccccccccc';
const NOW = () => '2026-11-04T00:00:00.000Z';

// Canned comment action (Trello's shape): newest runs carry later dates.
const c = (text, date, id) => ({ id, date, data: { text } });

// ---------- expected-verdict derivation (the curator's proposal rule) ----------

test('1. deriveExpectedVerdict: reviewer verdicts CHANGES; layer-reviewed CHANGES; other layers APPROVE', () => {
  assert.equal(deriveExpectedVerdict({ kind: 'REVIEW:CHANGES' }), '[REVIEW:CHANGES]');
  assert.equal(deriveExpectedVerdict({ kind: 'SEC:FINDINGS' }), '[REVIEW:CHANGES]');
  assert.equal(deriveExpectedVerdict({ kind: 'QA:FAIL', layer: 'review' }), '[REVIEW:CHANGES]');
  assert.equal(deriveExpectedVerdict({ kind: 'PROD-CLOSE', layer: 'Review' }), '[REVIEW:CHANGES]');
  for (const layer of ['deploy', 'verify', 'prod-watch', 'infra', 'qa', 'plan', 'implement', 'unknown'])
    assert.equal(deriveExpectedVerdict({ kind: 'QA:FAIL', layer }), '[REVIEW:APPROVE]');
  // No layer ⇒ APPROVE: a replay must not guess findings (no over-flagging).
  assert.equal(deriveExpectedVerdict({ kind: 'VERIFY:FAIL' }), '[REVIEW:APPROVE]');
  assert.equal(deriveExpectedVerdict({}), '[REVIEW:APPROVE]');
});

// ---------- harvestBoard ----------

test('2. harvestBoard: unresolved bounce harvested with kind/expected/impl-evidence; curated:false', async () => {
  const cards = [{ id: CARD_A, name: 'Fix the widget', url: 'https://trello.com/c/x' }];
  const commentsOf = () => [
    c('[IMPL] npm test → 42 passed, exit 0', '2026-11-01T10:00:00.000Z', 'c1'),
    c('[REVIEW:CHANGES] scripts/w.js:47 — missing timeout guard', '2026-11-01T11:00:00.000Z', 'c2'),
  ];
  const cases = await harvestBoard({ cards, commentsOf, now: NOW });
  assert.equal(cases.length, 1);
  const k = cases[0];
  assert.equal(k.id, CARD_A);
  assert.equal(k.source, 'board-verdict');
  assert.equal(k.kind, 'REVIEW:CHANGES');
  assert.equal(k.title, 'Fix the widget');
  assert.match(k.verdictText, /missing timeout guard/);
  assert.match(k.evidence.impl, /npm test → 42 passed/);
  assert.equal(k.expected.verdict, '[REVIEW:CHANGES]');
  assert.deepEqual(k.expected.findingsMustInclude, []);
  assert.equal(k.curated, false);
  assert.equal(k.added, '2026-11-04T00:00:00.000Z');
});

test('3. harvestBoard: latest unresolved bounce wins; SEC:FINDINGS harvested; async commentsOf awaited', async () => {
  const cards = [{ id: CARD_A, name: 'a', url: 'u' }];
  const commentsOf = async () => [
    c('[IMPL] shipped', '2026-11-01T10:00:00.000Z', 'c1'),
    c('[QA:FAIL] suite red', '2026-11-01T11:00:00.000Z', 'c2'),
    c('[SEC:FINDINGS] high: token logged', '2026-11-01T12:00:00.000Z', 'c3'),
  ];
  const cases = await harvestBoard({ cards, commentsOf, now: NOW });
  assert.equal(cases.length, 1);
  assert.equal(cases[0].kind, 'SEC:FINDINGS'); // latest bounce
  assert.equal(cases[0].expected.verdict, '[REVIEW:CHANGES]'); // security pass is inside Review
});

test('4. harvestBoard: [IMPL] newer than the bounce ⇒ resolved ⇒ skipped (context-lib semantics)', async () => {
  const cards = [{ id: CARD_A, name: 'a', url: 'u' }];
  const commentsOf = () => [
    c('[REVIEW:CHANGES] fix it', '2026-11-01T10:00:00.000Z', 'c1'),
    c('[IMPL] bounce pass: fixed — commit deadbeef', '2026-11-01T12:00:00.000Z', 'c2'),
  ];
  assert.deepEqual(await harvestBoard({ cards, commentsOf, now: NOW }), []);
});

test('5. harvestBoard: bounce-free cards, comment-fetch errors and junk input yield nothing', async () => {
  const cards = [
    { id: CARD_A, name: 'clean', url: 'u' },
    { id: CARD_B, name: 'boom', url: 'u' },
    null,
    { name: 'no id' },
  ];
  const commentsOf = (id) => {
    if (id === CARD_B) throw new Error('board unreachable');
    return [c('[IMPL] all good', '2026-11-01T10:00:00.000Z', 'c1'), c('[REVIEW:APPROVE] lgtm', '2026-11-01T11:00:00.000Z', 'c2')];
  };
  assert.deepEqual(await harvestBoard({ cards, commentsOf, now: NOW }), []);
  assert.deepEqual(await harvestBoard({ cards: undefined, commentsOf, now: NOW }), []);
});

test('6. harvestBoard: newest-first sort from unordered/dated comments; raw-string comments work', async () => {
  const cards = [{ id: CARD_A, name: 'a', url: 'u' }];
  const commentsOf = () => [
    '[REVIEW:CHANGES] second bounce wins',
    '[IMPL] first impl',
  ];
  const cases = await harvestBoard({ cards, commentsOf, now: NOW });
  assert.equal(cases.length, 1);
  assert.equal(cases[0].kind, 'REVIEW:CHANGES');
  assert.match(cases[0].evidence.impl, /first impl/);
});

// ---------- harvestSeed ----------

test('7. harvestSeed: parses JSONL, skips malformed/blank lines, maps layer/why/fix, derives expected', () => {
  const lines = [
    JSON.stringify({ ts: '2026-11-03T00:00:00.000Z', card: CARD_A, url: 'u1', title: '[PROD-WATCH] x', layer: 'review', why: 'reviewer missed the retry-storm', fix: 'add the guard' }),
    'this is not json',
    '',
    JSON.stringify({ ts: '2026-11-03T01:00:00.000Z', url: 'u2', title: 'no card id', layer: 'infra', why: 'power strip', fix: '' }),
  ];
  const cases = harvestSeed({ seedPath: 'ignored', readLine: () => lines.join('\n') });
  assert.equal(cases.length, 2);
  assert.equal(cases[0].id, CARD_A);
  assert.equal(cases[0].kind, 'PROD-CLOSE');
  assert.equal(cases[0].source, 'prod-close-seed');
  assert.equal(cases[0].layer, 'review');
  assert.equal(cases[0].why, 'reviewer missed the retry-storm');
  assert.equal(cases[0].fix, 'add the guard');
  assert.equal(cases[0].expected.verdict, '[REVIEW:CHANGES]'); // layer review ⇒ reviewer should have caught
  assert.equal(cases[0].added, '2026-11-03T00:00:00.000Z');
  assert.equal(cases[0].curated, false);
  // malformed line still consumed a line number ⇒ the cardless line is seed-3
  assert.equal(cases[1].id, 'seed-3');
  assert.equal(cases[1].card, null);
  assert.equal(cases[1].expected.verdict, '[REVIEW:APPROVE]'); // infra ⇒ not the reviewer's fault
});

test('8. harvestSeed: missing file (ENOENT) yields [] — fresh worktrees have no seed', () => {
  assert.deepEqual(harvestSeed({ seedPath: '/nonexistent/seed.jsonl' }), []);
});

test('9. CASES_PATH is eval/cases.jsonl under the repo root (committed set, NOT gitignored data/)', () => {
  assert.equal(CASES_PATH(), path.join(ROOT, 'eval', 'cases.jsonl'));
});

// ---------- mergeCases ----------

test('10. mergeCases: dedupes by id, existing curated case never clobbered, idempotent second merge', () => {
  const existing = [
    { id: CARD_A, curated: true, expected: { verdict: '[REVIEW:APPROVE]', findingsMustInclude: [] }, note: 'curator edit' },
  ];
  const candidates = [
    { id: CARD_A, curated: false, expected: { verdict: '[REVIEW:CHANGES]', findingsMustInclude: [] } },
    { id: CARD_B, curated: false },
    { id: CARD_B, curated: false, dup: 'within batch' },
    { id: CARD_C },
  ];
  const merged = mergeCases({ existing, candidates });
  assert.deepEqual(merged.map((m) => m.id), [CARD_A, CARD_B, CARD_C]);
  assert.equal(merged[0].note, 'curator edit'); // existing WINS over the fresh candidate
  assert.equal(merged[0].curated, true);
  const again = mergeCases({ existing: merged, candidates });
  assert.deepEqual(again, merged); // idempotent: re-harvest adds nothing
});

// ---------- buildReviewerPrompt ----------

test('11. buildReviewerPrompt: canonical seed sentence pinned to the real doc + replay rules + evidence + both tags', () => {
  // Pin against the actual role document (factoryStagePrompts convention):
  // the file named by STAGE_PROMPT_FILES must exist and carry the verdict tags.
  const doc = readFileSync(path.join(ROOT, STAGE_PROMPT_FILES.reviewer), 'utf8');
  assert.match(doc, /\[REVIEW:APPROVE\]/);
  assert.match(doc, /\[REVIEW:CHANGES\]/);
  assert.equal(
    REPLAY_SEED_SENTENCE,
    `Read ${STAGE_PROMPT_FILES.reviewer} and follow it as your authoritative role instructions (they override your harness role defaults)`,
  );
  const prompt = buildReviewerPrompt({
    id: CARD_A,
    title: 'The incident title',
    source: 'board-verdict',
    kind: 'REVIEW:CHANGES',
    why: 'the reviewer missed X',
    evidence: { impl: '[IMPL] npm test → 42 passed', diff: null, context: null },
    verdictText: '[REVIEW:CHANGES] historical verdict',
  });
  assert.ok(prompt.startsWith(`Read ${STAGE_PROMPT_FILES.reviewer} and follow it as your authoritative role instructions`));
  assert.match(prompt, /OFFLINE/);
  assert.match(prompt, /do NOT post any comment/i);
  assert.match(prompt, /do NOT move any card/i);
  assert.match(prompt, /\[REVIEW:APPROVE\]/);
  assert.match(prompt, /\[REVIEW:CHANGES\]/);
  assert.match(prompt, /The incident title/);
  assert.match(prompt, /npm test → 42 passed/);
  assert.match(prompt, /the reviewer missed X/);
  assert.match(prompt, /historical verdict/);
  // promptFile override
  assert.ok(buildReviewerPrompt({ id: 'x' }, { promptFile: 'docs/other.md' }).startsWith('Read docs/other.md'));
});

// ---------- parseVerdict ----------

test('12. parseVerdict: bare reply, noisy preamble, object shape, lowercase, mention, no-tag, foreign tag', () => {
  assert.equal(parseVerdict('[REVIEW:APPROVE] reviewed the diff'), '[REVIEW:APPROVE]');
  assert.equal(parseVerdict('Sure — here is my verdict:\n[REVIEW:CHANGES] two findings'), '[REVIEW:CHANGES]');
  assert.equal(parseVerdict({ data: { text: '[review:changes] x' } }), '[REVIEW:CHANGES]');
  assert.equal(parseVerdict({ text: '[Review:Approve] y' }), '[REVIEW:APPROVE]');
  assert.equal(parseVerdict('we would otherwise [REVIEW:APPROVE] this'), '[REVIEW:APPROVE]'); // tolerant mention
  assert.equal(parseVerdict('[REVIEW:APPROVE] or [REVIEW:CHANGES]? first token wins'), '[REVIEW:APPROVE]');
  assert.equal(parseVerdict('no verdict here'), null);
  assert.equal(parseVerdict('[QA:FAIL] not the reviewer tag'), null);
  assert.equal(parseVerdict(undefined), null);
});

// ---------- scoreCases + formatReport ----------

test('13. scoreCases: math, uncurated exclusion, findings substrings, min-score gate, perCase completeness', () => {
  const cases = [
    { id: 'ap', curated: true, expected: { verdict: '[REVIEW:APPROVE]', findingsMustInclude: [] } },
    { id: 'ch', curated: true, expected: { verdict: '[REVIEW:CHANGES]', findingsMustInclude: ['timeout guard'] } },
    { id: 'ch2', curated: true, expected: { verdict: '[REVIEW:CHANGES]', findingsMustInclude: ['startdat'] } },
    { id: 'uncurated', curated: false, expected: { verdict: '[REVIEW:CHANGES]', findingsMustInclude: [] } },
  ];
  const verdicts = {
    ap: '[REVIEW:APPROVE] lgtm',
    ch: '[REVIEW:CHANGES] scripts/w.js:47 missing Timeout Guard here', // case-insensitive substring hit
    ch2: '[REVIEW:CHANGES] something else entirely', // right verdict, missing finding ⇒ incorrect
    uncurated: '[REVIEW:CHANGES] would be right but is not scored',
  };
  const s = scoreCases({ cases, verdicts });
  assert.equal(s.total, 3); // uncurated excluded
  assert.equal(s.correct, 2);
  assert.equal(s.score, 2 / 3);
  assert.equal(s.pass, undefined); // no gate set
  assert.equal(s.perCase.length, 4); // every case appears
  assert.deepEqual(
    s.perCase.map((p) => [p.id, p.scored, p.correct]),
    [['ap', true, true], ['ch', true, true], ['ch2', true, false], ['uncurated', false, false]],
  );
  assert.deepEqual(s.perCase.find((p) => p.id === 'ch2').findingsMissing, ['startdat']);
  // wrong parsed verdict ⇒ incorrect even when findings text is present
  const wrong = scoreCases({
    cases: [{ id: 'ap', curated: true, expected: { verdict: '[REVIEW:CHANGES]', findingsMustInclude: [] } }],
    verdicts: { ap: '[REVIEW:APPROVE] nope' },
  });
  assert.equal(wrong.correct, 0);
  assert.equal(wrong.perCase[0].got, '[REVIEW:APPROVE]');
  // gate: pass at/below score, fail above; empty curated set gates 0 < min
  const gate = scoreCases({ cases, verdicts, minScore: 2 / 3 });
  assert.equal(gate.pass, true);
  assert.equal(gate.minScore, 2 / 3);
  assert.equal(scoreCases({ cases, verdicts, minScore: 0.9 }).pass, false);
  const empty = scoreCases({ cases: [{ id: 'u', curated: false }], verdicts: {}, minScore: 0.5 });
  assert.equal(empty.total, 0);
  assert.equal(empty.pass, false); // never a vacuous pass above zero
  // formatReport: stable key-sorted JSON (two runs diff cleanly)
  const r1 = formatReport(s);
  assert.equal(r1, formatReport(JSON.parse(r1)));
  assert.ok(r1.startsWith('{\n  "correct"')); // keys sorted
  assert.match(r1, /"perCase"/);
});

// ---------- spawnReviewerRun (DI — proves the env→argv plumbing under test) ----------

test('14. spawnReviewerRun: DI spawnFn + agentArgsFrom; FACTORY_OMP_BIN/FACTORY_MODEL reach the argv', async () => {
  const seen = [];
  const fakeSpawn = (bin, argv) => {
    seen.push({ bin, argv });
    return Promise.resolve({ code: 0, stdout: '[REVIEW:APPROVE] canned reply' });
  };
  const savedBin = process.env.FACTORY_OMP_BIN;
  const savedModel = process.env.FACTORY_MODEL;
  try {
    delete process.env.FACTORY_OMP_BIN;
    const res = await spawnReviewerRun('the replay prompt', {
      spawnFn: fakeSpawn,
      agentArgsFrom: (p) => ['-p', p],
    });
    assert.deepEqual(res, { code: 0, stdout: '[REVIEW:APPROVE] canned reply' });
    assert.equal(seen[0].bin, 'omp'); // default
    assert.deepEqual(seen[0].argv, ['-p', 'the replay prompt']);
    process.env.FACTORY_OMP_BIN = 'my-omp';
    await spawnReviewerRun('p2', { spawnFn: fakeSpawn, agentArgsFrom: (p) => [p] });
    assert.equal(seen[1].bin, 'my-omp');
    // the whole point: a model switch must reach the spawned argv —
    // real daemon agentArgs, env set, fake spawn captures argv.
    process.env.FACTORY_MODEL = 'probe-model';
    await spawnReviewerRun('p3', { spawnFn: fakeSpawn });
    assert.ok(seen[2].argv.includes('--model'), '--model flag missing');
    assert.equal(seen[2].argv[seen[2].argv.indexOf('--model') + 1], 'probe-model');
    assert.ok(seen[2].argv.includes('--auto-approve'));
    assert.ok(seen[2].argv.includes('--max-cost'));
    assert.equal(seen[2].argv[seen[2].argv.length - 1], 'p3'); // prompt last
  } finally {
    if (savedBin === undefined) delete process.env.FACTORY_OMP_BIN;
    else process.env.FACTORY_OMP_BIN = savedBin;
    if (savedModel === undefined) delete process.env.FACTORY_MODEL;
    else process.env.FACTORY_MODEL = savedModel;
  }
});

// ---------- CLI wiring (pre-network die paths) ----------

test('15. CLI eval-run: missing/invalid --min-score and unknown flag die before any spawn', () => {
  const run = (...extra) =>
    spawnSync(process.execPath, [FACTORY_JS, 'eval-run', ...extra], { encoding: 'utf8', timeout: 30_000 });
  let r = run('--min-score');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing value for --min-score/);
  r = run('--min-score', '5');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid --min-score value: 5/);
  r = run('--bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown flag "--bogus"/);
});

test('16. CLI eval-seed: unknown flag dies BEFORE the network; --limit must be a positive integer', () => {
  const run = (...extra) =>
    spawnSync(process.execPath, [FACTORY_JS, 'eval-seed', ...extra], { encoding: 'utf8', timeout: 30_000 });
  let r = run('--bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown flag "--bogus"/);
  r = run('--limit', 'zero');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid --limit value/);
});

test('17. CLI eval-run: missing cases file and unknown --case id exit 1', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'evalexc-'));
  const missing = path.join(dir, 'nope.jsonl');
  let r = spawnSync(process.execPath, [FACTORY_JS, 'eval-run', '--cases', missing, '--no-spawn'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No eval cases in/);
  const one = path.join(dir, 'cases.jsonl');
  writeFileSync(one, `${JSON.stringify({ id: 'ap', curated: true, expected: { verdict: '[REVIEW:APPROVE]', findingsMustInclude: [] } })}\n`);
  r = spawnSync(process.execPath, [FACTORY_JS, 'eval-run', '--cases', one, '--no-spawn', '--case', 'nosuchcase'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No case with id "nosuchcase"/);
});

test('18. CLI help lists eval-seed + eval-run with their gating flags', () => {
  const r = spawnSync(process.execPath, [FACTORY_JS, 'help'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /eval-seed/);
  assert.match(r.stdout, /eval-run/);
  assert.match(r.stdout, /--min-score <0\.\.1>/);
  assert.match(r.stdout, /--no-spawn/);
});

// ---------- the committed initial set (plan §4 contract) ----------

test('19. eval/cases.jsonl: committed, non-empty, BOTH expected verdicts present, curated', () => {
  assert.ok(existsSync(CASES_FILE));
  const cases = readFileSync(CASES_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  assert.ok(cases.length >= 3, `expected a meaningful set, got ${cases.length}`);
  const byVerdict = { '[REVIEW:CHANGES]': 0, '[REVIEW:APPROVE]': 0 };
  for (const c of cases) {
    assert.ok(c.id, 'every case carries an id');
    assert.ok(Object.hasOwn(byVerdict, c.expected?.verdict), `case ${c.id} has an invalid expected verdict`);
    byVerdict[c.expected.verdict] += 1;
    assert.equal(c.curated, true, `case ${c.id} must be expert-checked (curated:true) to be scored`);
  }
  assert.ok(byVerdict['[REVIEW:CHANGES]'] > 0, 'set must include a CHANGES case (under-flagging fails)');
  assert.ok(byVerdict['[REVIEW:APPROVE]'] > 0, 'set must include APPROVE cases (over-flagging fails)');
});
