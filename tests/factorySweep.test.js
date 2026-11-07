/**
 * Unit tests for scripts/lib/factory-sweep.js + scripts/factory-sweep.js CLI
 * (card 6ae96774f94d31dd02bf46fe; docs/factory.md "Nightly review sweep").
 *
 * Zero live Trello/git: every dep is injected — fake trello client (mutable
 * card/label stores + write counters), fake git fetch/log, fixed clock. CLI
 * tests spawn the real CLI only on paths that die before any network call
 * (unknown subcommand, bad flags). Style mirrors tests/factoryAuditCards.test.js.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  LABEL,
  DEFAULTS,
  COMMIT_MARKER,
  readEnvConfig,
  todayStr,
  parseCommitFileLog,
  isPaperwork,
  buildSlice,
  sweepTitle,
  findSweepCard,
  sweepDescription,
  runSweepOnce,
  plistXml,
} from '../scripts/lib/factory-sweep.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'factory-sweep.js');

const READY = 'ready00000000000000000001';
const READY_LIST = { id: READY, name: 'Ready', closed: false };
const BOARD_ID = 'board0000000000000000000a';
const DATE = '2026-11-03';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const NOW = () => new Date('2026-11-03T03:15:00.000Z');

// Real `git log --name-only --pretty=format:%x01%H` shape: a preface line
// before the first commit, commit lines start with \x01, blank line per commit.
const LOG = [
  'preamble-not-a-file',
  `${COMMIT_MARKER}${SHA_A}`,
  'src/bot.js',
  'plans/factory/deadbeef-plan.md',
  '',
  `${COMMIT_MARKER}${SHA_B}`,
  'src/bot.js',
  'src/aiClient.js',
  'docs/factory-prompts/reviewer.md',
  '',
].join('\n');

/** Fake trello with MUTABLE stores + write counters (audit-test shape). */
function fakeTrello({ lists = [READY_LIST], cards = [], labels = [] } = {}) {
  const calls = { createCard: 0, createLabel: 0, addLabelToCard: 0 };
  const t = {
    BOARD: BOARD_ID,
    getLists: async () => lists.slice(),
    getBoardCards: async () => cards.map((c) => ({ id: c.id, name: c.name, idList: c.idList })),
    getLabels: async () => labels.slice(),
    createLabel: async (name, color, idBoard) => {
      const label = { id: `lbl-${name}`, name, color, idBoard };
      labels.push(label);
      calls.createLabel++;
      return label;
    },
    createCard: async (name, idList, desc) => {
      const card = { id: `card-${calls.createCard + 1}`, name, idList, desc, labels: [], url: `https://trello.com/c/FAKE/${name}` };
      cards.push(card);
      calls.createCard++;
      return card;
    },
    addLabelToCard: async (cardId, labelId) => {
      cards.find((c) => c.id === cardId).labels.push(labelId);
      calls.addLabelToCard++;
      return {};
    },
  };
  return { t, cards, labels, calls };
}

const noopFetch = async () => '';
const failFetch = async () => {
  throw new Error('ssh: connect to host port 22: Operation timed out');
};
const logOut = (stdout) => async () => stdout;
const collect = () => {
  const lines = [];
  return { log: (m) => lines.push(String(m)), lines };
};

// ---- 1. log parser ----

test('1. parseCommitFileLog: shas per file, order kept, blanks/preamble ignored', () => {
  const map = parseCommitFileLog(LOG);
  // Parser keeps EVERY path (paperwork exclusion is buildSlice's job).
  assert.deepEqual([...map.keys()].sort(), ['docs/factory-prompts/reviewer.md', 'plans/factory/deadbeef-plan.md', 'src/aiClient.js', 'src/bot.js']);
  assert.deepEqual(map.get('src/bot.js'), [SHA_A, SHA_B]); // both commits, log order
  assert.deepEqual(map.get('src/aiClient.js'), [SHA_B]);
  assert.equal(map.has('preamble-not-a-file'), false);
  assert.equal(map.has(''), false);
  assert.deepEqual(parseCommitFileLog(''), new Map());
});

// ---- 2. slice builder ----

test('2. buildSlice: paperwork excluded, sorted, capped, overflow named, empty ok', () => {
  const s = buildSlice(LOG, { maxFiles: 40 });
  assert.deepEqual(s.covered.map((f) => f.file), ['src/aiClient.js', 'src/bot.js']);
  assert.deepEqual(s.overflow, []);
  assert.equal(s.total, 2); // plans/** + docs/factory-prompts/** dropped
  assert.equal(isPaperwork('plans/factory/x-plan.md'), true);
  assert.equal(isPaperwork('docs/factory-prompts/reviewer.md'), true);
  assert.equal(isPaperwork('package-lock.json'), false); // lockfiles stay IN
  const capped = buildSlice(LOG, { maxFiles: 1 });
  assert.deepEqual(capped.covered.map((f) => f.file), ['src/aiClient.js']);
  assert.deepEqual(capped.overflow, ['src/bot.js']);
  const empty = buildSlice('', { maxFiles: 40 });
  assert.deepEqual(empty.covered, []);
  assert.equal(empty.total, 0);
});

// ---- 3. title + dedup key ----

test('3. sweepTitle + findSweepCard: exact-date prefix matches, other dates do not', () => {
  const title = sweepTitle(DATE, 2, 7);
  assert.equal(title, '[SWEEP 2026-11-03] Standing review — 2 files merged in the last 7 days');
  const cards = [
    { id: '1', name: title },
    { id: '2', name: sweepTitle('2026-11-02', 2, 7) },
    { id: '3', name: 'C-L1 — something else' },
  ];
  assert.equal(findSweepCard(cards, DATE).id, '1'); // suffix differences still match
  assert.equal(findSweepCard([{ id: '3', name: 'C-L1 — x' }], DATE), null);
  assert.equal(findSweepCard([], DATE), null);
});

// ---- 4. machine-written description ----

test('4. sweepDescription: slice+shas, both ground-truth docs, filing cmds, cap, no-code rule', () => {
  const slice = buildSlice(LOG, { maxFiles: 1 });
  const desc = sweepDescription({
    dateStr: DATE, days: 7, maxFiles: 1, maxFindings: 5,
    covered: slice.covered, overflow: slice.overflow, filedAt: NOW().toISOString(),
  });
  assert.match(desc, /docs\/factory-prompts\/reviewer\.md/);
  assert.match(desc, /docs\/security-review\.md/);
  assert.match(desc, /src\/aiClient\.js/);
  assert.match(desc, new RegExp(SHA_B.slice(0, 10))); // merge SHA per file (shortened)
  assert.match(desc, /factory\.js add Ready "\[SWEEP-FINDING 2026-11-03 <n>\]/);
  assert.match(desc, /factory\.js desc <new-card-id> -/);
  assert.match(desc, /at most 5 finding cards/);
  assert.match(desc, /Cap 1 files\/night — NOT covered tonight .*`src\/bot\.js`\./);
  assert.match(desc, /commits NO code/);
  assert.match(desc, /no findings — slice reviewed against both ground-truth docs/);
  assert.match(desc, /HIGH\/MEDIUM\/LOW/);
});

// ---- 5. runSweepOnce: filed ----

test('5. runSweepOnce files one date-titled card into Ready with Low label', async () => {
  const { t, cards, labels, calls } = fakeTrello();
  const { log, lines } = collect();
  const res = await runSweepOnce({
    t, dateStr: DATE, gitFetch: noopFetch, gitLog: logOut(LOG), now: NOW, log,
  });
  assert.equal(res.action, 'filed');
  assert.equal(res.files, 2);
  assert.deepEqual(res.overflow, []);
  assert.equal(res.list, 'Ready');
  assert.equal(calls.createCard, 1);
  const card = cards[0];
  assert.equal(card.idList, READY);
  assert.equal(card.name, '[SWEEP 2026-11-03] Standing review — 2 files merged in the last 7 days');
  assert.match(card.desc, /docs\/security-review\.md/);
  assert.equal(labels.length, 3); // High/Medium/Low ensured (empty board → created)
  assert.deepEqual(card.labels, ['lbl-Low']); // exactly the Low priority label
  assert.equal(calls.addLabelToCard, 1);
  assert.match(lines.join('\n'), /filed: /);
  assert.match(lines.join('\n'), /fetched origin\/master/);
});

// ---- 6. dedup + empty window + fetch fail-open ----

test('6a. deduped: same-date sweep card already open → zero writes', async () => {
  const existing = { id: 'x', name: sweepTitle(DATE, 2, 7), idList: READY };
  const { t, cards, calls } = fakeTrello({ cards: [existing] });
  const res = await runSweepOnce({ t, dateStr: DATE, gitFetch: noopFetch, gitLog: logOut(LOG), now: NOW, log: () => {} });
  assert.equal(res.action, 'deduped');
  assert.equal(res.title, existing.name);
  assert.equal(calls.createCard, 0);
  assert.equal(cards.length, 1);
});

test('6b. other-date sweep cards do not collide: still files', async () => {
  const { t, calls } = fakeTrello({ cards: [{ id: 'x', name: sweepTitle('2026-11-02', 2, 7), idList: READY }] });
  const res = await runSweepOnce({ t, dateStr: DATE, gitFetch: noopFetch, gitLog: logOut(LOG), now: NOW, log: () => {} });
  assert.equal(res.action, 'filed');
  assert.equal(calls.createCard, 1);
});

test('6c. empty window: quiet repo files nothing, touches nothing on the board', async () => {
  const { t, calls } = fakeTrello();
  let listsRead = 0;
  t.getLists = async () => (listsRead++, [READY_LIST]);
  const res = await runSweepOnce({ t, dateStr: DATE, gitFetch: noopFetch, gitLog: logOut(''), now: NOW, log: () => {} });
  assert.deepEqual(res, { action: 'skipped-empty-window', days: DEFAULTS.days, files: 0 });
  assert.equal(calls.createCard, 0);
  assert.equal(listsRead, 0); // empty-window guard runs BEFORE any board read
});

test('6d. fetch failure fails open: sweep proceeds on local refs, still files', async () => {
  const { t, calls } = fakeTrello();
  const { log, lines } = collect();
  const res = await runSweepOnce({ t, dateStr: DATE, gitFetch: failFetch, gitLog: logOut(LOG), now: NOW, log });
  assert.equal(res.action, 'filed');
  assert.equal(calls.createCard, 1);
  assert.match(lines.join('\n'), /fetch failed \(sweeping local refs\)/);
});

test('6e. missing Ready list rejects (CLI turns that into exit 1)', async () => {
  const { t } = fakeTrello({ lists: [] });
  await assert.rejects(
    () => runSweepOnce({ t, dateStr: DATE, gitFetch: noopFetch, gitLog: logOut(LOG), now: NOW, log: () => {} }),
    /Ready list missing/,
  );
});

// ---- 7. dry-run: identical plan, zero board writes ----

test('7. dryRun: would-file JSON with title/overflow, zero create/label calls', async () => {
  const { t, calls } = fakeTrello();
  const res = await runSweepOnce({
    t, dateStr: DATE, maxFiles: 1, gitFetch: noopFetch, gitLog: logOut(LOG), now: NOW,
    dryRun: true, fetch: false, log: () => {},
  });
  assert.equal(res.action, 'would-file');
  assert.equal(res.dryRun, true);
  assert.equal(res.title, sweepTitle(DATE, 1, DEFAULTS.days));
  assert.deepEqual(res.overflow, ['src/bot.js']);
  assert.equal(res.list, 'Ready');
  assert.equal(calls.createCard, 0);
  assert.equal(calls.createLabel, 0);
  assert.equal(calls.addLabelToCard, 0);
});

// ---- 8. plist ----

test('8. plistXml: daily calendar, RunAtLoad false, `once` argv, PATH + sweep env baked', () => {
  const xml = plistXml({ nodePath: '/opt/homebrew/Cellar/node/25/bin/node', hour: 2, minute: 5, days: 10, maxFiles: 30, maxFindings: 2 });
  assert.match(xml, new RegExp(`<string>${LABEL}</string>`));
  assert.match(xml, /<string>\/opt\/homebrew\/Cellar\/node\/25\/bin\/node<\/string>/);
  assert.match(xml, /<string>.*scripts\/factory-sweep\.js<\/string>/);
  assert.match(xml, /<string>once<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key><false\/>/);
  assert.match(xml, /<key>StartCalendarInterval<\/key>\s*<dict>\s*<key>Hour<\/key><integer>2<\/integer>\s*<key>Minute<\/key><integer>5<\/integer>/);
  assert.match(xml, /<key>PATH<\/key><string>\/opt\/homebrew\/Cellar\/node\/25\/bin:\/usr\/local\/bin:/);
  assert.match(xml, /<key>FACTORY_SWEEP_DAYS<\/key><string>10<\/string>/);
  assert.match(xml, /<key>FACTORY_SWEEP_MAX_FILES<\/key><string>30<\/string>/);
  assert.match(xml, /<key>FACTORY_SWEEP_MAX_FINDINGS<\/key><string>2<\/string>/);
  assert.match(xml, /data\/factory-sweep\/launchd\.out\.log/);
  assert.match(xml, /data\/factory-sweep\/launchd\.err\.log/);
});

// ---- 9. env config ----

test('9. readEnvConfig: defaults, overrides, garbage falls back, hour 0 allowed', () => {
  assert.deepEqual(readEnvConfig({}), DEFAULTS);
  assert.deepEqual(
    readEnvConfig({ FACTORY_SWEEP_DAYS: '14', FACTORY_SWEEP_MAX_FILES: '20', FACTORY_SWEEP_MAX_FINDINGS: '3', FACTORY_SWEEP_HOUR: '0', FACTORY_SWEEP_MINUTE: '59' }),
    { days: 14, maxFiles: 20, maxFindings: 3, hour: 0, minute: 59 },
  );
  assert.deepEqual(
    readEnvConfig({ FACTORY_SWEEP_DAYS: 'abc', FACTORY_SWEEP_MAX_FILES: '-5', FACTORY_SWEEP_HOUR: '25', FACTORY_SWEEP_MINUTE: '99' }),
    DEFAULTS,
  );
});

test('9b. todayStr pads month/day', () => {
  assert.equal(todayStr(new Date(2026, 0, 5)), '2026-01-05');
});

// ---- CLI (pre-network paths only) ----

const runCli = (...argv) =>
  spawnSync(process.execPath, [SCRIPT, ...argv], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

test('10. CLI: unknown subcommand exits 3 with usage, stdout empty, no network', () => {
  const r = runCli('frobnicate');
  assert.equal(r.status, 3);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /usage: node scripts\/factory-sweep\.js/);
});

test('10b. CLI: bad --date exits 1 before any board call', () => {
  const r = runCli('once', '--date', '2026-13-45');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--date/);
  const r2 = runCli('dry-run', '--date', 'yesterday');
  assert.equal(r2.status, 1);
});

test('10c. CLI: unknown flag exits 1', () => {
  const r = runCli('once', '--bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--bogus/);
});
