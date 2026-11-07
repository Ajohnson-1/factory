/**
 * Unit tests for scripts/lib/factory-audit-cards.js + scripts/factory.js
 * seed-audit wiring (card 6ae9630ebf8a6f1275923111; docs/factory.md CLI).
 *
 * Zero live Trello: every dep is injected — fake trello client (mutable card/
 * label stores with call counters, so a second runAuditSeed against the same
 * fake sees run 1's creations), injected doc reader. Only the process-level
 * test spawns the CLI on a path that dies before any network call (help).
 * Style mirrors tests/factoryDonePing.test.js.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  PRIORITY_LABELS,
  parseSectionC,
  ensurePriorityLabels,
  runAuditSeed,
} from '../scripts/lib/factory-audit-cards.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');
const REAL_DOC = readFileSync(path.join(ROOT, 'docs', 'factory-audit.md'), 'utf8');

const TODO = 'todo000000000000000000001';
const READY = 'ready00000000000000000001';
const TODO_LIST = { id: TODO, name: 'To Do', closed: false };
const READY_LIST = { id: READY, name: 'Ready', closed: false };
const BOARD_ID = 'board0000000000000000000a';

/** Fake trello with MUTABLE card/label stores + call counters: creations
 * land in the stores, so a second run against the same fake sees run 1. */
function fakeTrello({ lists = [TODO_LIST, READY_LIST], cards = [], labels = [] } = {}) {
  const calls = {
    getLists: 0,
    getBoardCards: 0,
    getBoard: 0,
    getLabels: 0,
    createLabel: 0,
    createCard: 0,
    addLabelToCard: 0,
  };
  const cardList = [...cards];
  const labelList = [...labels];
  const labelPosts = []; // { cardId, labelId }
  let seq = 0;
  const nid = (p) => `${p}${'0'.repeat(24 - p.length - String(seq).length)}${seq++}`;
  return {
    calls,
    cardList,
    labelList,
    labelPosts,
    async getLists() {
      calls.getLists += 1;
      return lists;
    },
    async getBoardCards() {
      calls.getBoardCards += 1;
      return cardList.map((c) => ({ ...c }));
    },
    async getBoard() {
      calls.getBoard += 1;
      return { id: BOARD_ID, name: 'Fake Board' };
    },
    async getLabels() {
      calls.getLabels += 1;
      return labelList.map((l) => ({ ...l }));
    },
    async createLabel(name, color, idBoard) {
      assert.equal(idBoard, BOARD_ID, 'createLabel must target the fetched board id');
      calls.createLabel += 1;
      const label = { id: nid('lab'), name, color };
      labelList.push(label);
      return label;
    },
    async createCard(name, idList, desc = '') {
      calls.createCard += 1;
      const card = { id: nid('car'), name, idList, desc };
      cardList.push(card);
      return card;
    },
    async addLabelToCard(cardId, labelId) {
      calls.addLabelToCard += 1;
      labelPosts.push({ cardId, labelId });
      return {};
    },
  };
}

const noop = () => {};
const realFindings = () => parseSectionC(REAL_DOC);

// ---- parser on the REAL doc ----

// 1. Real docs/factory-audit.md: exactly 19 findings, priority histogram,
// combined bullet = ONE finding, scope stops at Section D, full bullet text.
test('1. real doc: 19 findings, histogram {5,11,3}, combined bullet is one card', () => {
  const findings = realFindings();
  assert.equal(findings.length, 19);
  const hist = { High: 0, Medium: 0, Low: 0 };
  for (const f of findings) hist[f.priority] += 1;
  assert.deepEqual(hist, { High: 5, Medium: 11, Low: 3 });
  assert.equal(findings[0].id, 'C-H1');
  assert.equal(findings[findings.length - 1].id, 'C-L3');
  const combined = findings.filter((f) => f.id.includes('/'));
  assert.equal(combined.length, 1);
  assert.equal(combined[0].id, 'C-H6 / C-M13');
  assert.equal(combined[0].priority, 'Medium'); // sits under ### Medium
  for (const f of findings) {
    assert.ok(f.description.includes('*Why:*'), `${f.id} description lost *Why:*`);
    assert.ok(f.description.includes('*Gap:*'), `${f.id} description lost *Gap:*`);
    assert.ok(!f.description.startsWith('- '), `${f.id} keeps the "- " bullet prefix`);
    assert.equal(f.name, `${f.id} — ${f.title}`);
    assert.ok(f.name.length <= 256);
  }
});

// 2. Parser negatives: missing Section C / zero bullets / duplicate titles all
// throw (fail loud, never seed 0 cards silently); Section D bullets and
// non-finding bullets are out of scope.
test('2. parser negatives: no Section C, zero bullets, duplicate title, scope end', () => {
  assert.throws(() => parseSectionC('# Nothing\n\n## Section D — fine\n'), /Section C/);
  assert.throws(
    () => parseSectionC('## Section C — Prioritized improvement list\n\n### High\n\nprose only\n\n## Section D\n'),
    /no .* finding bullets/i,
  );
  const dup = [
    '## Section C — x',
    '### High',
    '- **C-H1 — Same title** (r). *Why:* w. *Gap:* g.',
    '- **C-H2 — Same title** (r). *Why:* w. *Gap:* g.', // different id → same derived title? No: title key includes id prefix…
    '## Section D',
  ].join('\n');
  // different ids → different names, must NOT throw:
  assert.equal(parseSectionC(dup).length, 2);
  const dupName = [
    '## Section C — x',
    '### High',
    '- **C-H1 — Same title** (r). *Why:* w. *Gap:* g.',
    '- **C-H1 — Same title** (r). *Why:* w. *Gap:* g. (second copy)',
    '## Section D',
  ].join('\n');
  assert.throws(() => parseSectionC(dupName), /Duplicate/);
  // scope + noise handling: bullet before any ### subsection ignored; bullets
  // after `## Section D` out of scope; non-C- bullets ignored.
  const scoped = [
    '## Section C — x',
    '- **C-H0 — before any subsection** (r). *Why:* w.',
    '### Low',
    '- **C-L1 — Real one** (r). *Why:* w.',
    '- plain bullet, not a finding',
    '## Section D — nope',
    '- **C-X9 — out of scope** (r). *Why:* w.',
  ].join('\n');
  const found = parseSectionC(scoped);
  assert.deepEqual(found.map((f) => f.id), ['C-L1']);
});

// ---- labels ----

// 3. ensurePriorityLabels: reuse exact-name labels; create missing ones with
// the per-priority colors; all-present run = zero createLabel calls.
test('3. labels: High reused, Medium/Low created orange/green, full set = 0 creates', async () => {
  const high = { id: 'highlabel0000000000000000', name: 'High', color: 'red' };
  const t1 = fakeTrello({ labels: [high] });
  const ids1 = await ensurePriorityLabels({ t: t1, boardId: BOARD_ID });
  assert.equal(ids1.High, high.id); // reused, not re-created
  assert.equal(t1.calls.createLabel, 2); // only Medium + Low
  const colors = Object.fromEntries(t1.labelList.map((l) => [l.name, l.color]));
  assert.deepEqual(colors, { High: 'red', Medium: 'orange', Low: 'green' });
  const t2 = fakeTrello({ labels: t1.labelList });
  const ids2 = await ensurePriorityLabels({ t: t2, boardId: BOARD_ID });
  assert.equal(t2.calls.createLabel, 0);
  assert.deepEqual(ids2, ids1);
  assert.deepEqual(PRIORITY_LABELS, { High: 'red', Medium: 'orange', Low: 'green' });
});

// ---- seed flow ----

// 4. Empty fake board: 19 createCard calls — name/idList/desc exact per the
// parse — each card gets exactly one label, matching its priority.
test('4. seed on empty board: 19 cards into To Do with full bullet desc + priority label', async () => {
  const t = fakeTrello();
  const res = await runAuditSeed({ t, log: noop });
  assert.ok(res.ok);
  assert.equal(res.list, 'To Do');
  assert.equal(res.parsed, 19);
  assert.equal(res.created.length, 19);
  assert.deepEqual(res.skipped, []);
  assert.equal(t.calls.createCard, 19);
  const byName = Object.fromEntries(realFindings().map((f) => [f.name, f]));
  assert.equal(t.cardList.length, 19);
  for (const c of t.cardList) {
    const f = byName[c.name];
    assert.ok(f, `unexpected card name: ${c.name}`);
    assert.equal(c.idList, TODO, `${f.id} landed outside To Do`);
    assert.equal(c.desc, f.description, `${f.id} description mismatch`);
    const posts = t.labelPosts.filter((p) => p.cardId === c.id);
    assert.equal(posts.length, 1, `${f.id} got ${posts.length} labels`);
    assert.equal(t.labelList.find((l) => l.id === posts[0].labelId).name, f.priority);
  }
});

// 5. Idempotency: second run against the SAME fake board (run 1's cards are
// now board cards) → created 0, skipped 19, zero create/label POSTs.
test('5. re-run is a no-op: created 0, skipped 19, zero POSTs', async () => {
  const t = fakeTrello();
  await runAuditSeed({ t, log: noop });
  const { createCard, addLabelToCard, createLabel } = t.calls;
  const res = await runAuditSeed({ t, log: noop });
  assert.equal(res.created.length, 0);
  assert.equal(res.skipped.length, 19);
  assert.deepEqual(res.skipped, realFindings().map((f) => f.name));
  assert.deepEqual(res.counts, { created: 0, skipped: 19 });
  assert.equal(t.calls.createCard, createCard);
  assert.equal(t.calls.addLabelToCard, addLabelToCard);
  assert.equal(t.calls.createLabel, createLabel);
});

// 6. Cross-list dedup: a finding title already sitting in Ready (a human moved
// it out of To Do) is skipped, not re-created.
test('6. title already in Ready is skipped (whole-board dedup)', async () => {
  const moved = realFindings().find((f) => f.id === 'C-L1');
  const t = fakeTrello({ cards: [{ id: 'moved000000000000000000001', name: moved.name, idList: READY }] });
  const res = await runAuditSeed({ t, log: noop });
  assert.equal(res.created.length, 18);
  assert.deepEqual(res.skipped, [moved.name]);
  assert.ok(!t.cardList.some((c) => c.idList === TODO && c.name === moved.name));
});

// 7. dryRun on an empty board: plan says wouldCreate 19 with ZERO board writes.
test('7. --dry-run: full plan, zero createCard/createLabel/addLabelToCard calls', async () => {
  const t = fakeTrello();
  const res = await runAuditSeed({ t, dryRun: true, log: noop });
  assert.ok(res.ok && res.dryRun);
  assert.equal(res.parsed, 19);
  assert.equal(res.wouldCreate.length, 19);
  assert.deepEqual(res.wouldSkip, []);
  assert.equal(t.calls.createCard, 0);
  assert.equal(t.calls.createLabel, 0);
  assert.equal(t.calls.addLabelToCard, 0);
  assert.equal(t.cardList.length, 0);
});

// 7b. missing target list → reject (the CLI turns it into exit 1).
test('7b. missing target list rejects before any write', async () => {
  const t = fakeTrello({ lists: [READY_LIST] });
  await assert.rejects(() => runAuditSeed({ t, log: noop }), /No open list named "To Do"/);
  assert.equal(t.calls.createCard, 0);
});

// ---- CLI wiring (pre-network paths only) ----

const runCli = (...argv) =>
  spawnSync(process.execPath, [FACTORY_JS, ...argv], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

// 8. help advertises seed-audit with its flags.
test('8. CLI help lists seed-audit', () => {
  const r = runCli('help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /seed-audit/);
  assert.match(r.stdout, /--dry-run/);
});
