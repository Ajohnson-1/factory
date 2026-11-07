/**
 * Unit tests for scripts/lib/factory-prod-close.js (which-layer-failed
 * incident closure for [PROD-WATCH] cards; card 6ae9676d2461fd41204b507e;
 * docs/factory.md "Incident closure: which layer should have caught this").
 *
 * Zero live Trello: the trello client and the seed append are injected fakes;
 * defaultAppendSeed is exercised against a real temp dir. Process-level CLI
 * tests spawn scripts/factory.js only on paths that die BEFORE network
 * (unknown layer, missing flags, help). Style mirrors
 * tests/factoryCommentResume.test.js.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  PROD_LAYERS,
  SEED_PATH,
  isProdWatchCard,
  prodCloseText,
  closeProdCard,
  hasProdClose,
  moveDoneGate,
  defaultAppendSeed,
} from '../scripts/lib/factory-prod-close.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');
const CARD_ID = 'a1b2c3d4e5f60718293a4b5c';

// Fake trello client: records calls, returns canned payloads.
function fakeTrello({ card, comments = [], failCardFetch = false } = {}) {
  const calls = { addComment: [], getCard: [] };
  return {
    calls,
    async getCard(id, fields) {
      calls.getCard.push({ id, fields });
      if (failCardFetch) throw new Error('trello 500');
      return card;
    },
    async addComment(id, text) {
      calls.addComment.push({ id, text });
      return { id: `c-${calls.addComment.length}`, text };
    },
    async getCardComments() {
      return comments;
    },
  };
}

// ---------- taxonomy + title detection ----------

test('1. PROD_LAYERS is the exact shared enum (docs/CLI/C-M11 contract)', () => {
  assert.deepEqual(PROD_LAYERS, [
    'plan',
    'implement',
    'review',
    'security',
    'qa',
    'deploy',
    'verify',
    'prod-watch',
    'infra',
    'unknown',
  ]);
});

test('2. isProdWatchCard: [PROD-WATCH] title prefix, case-insensitive', () => {
  assert.equal(isProdWatchCard('[PROD-WATCH] prod bot down: unreachable — ssh failed'), true);
  assert.equal(isProdWatchCard('[prod-watch] lowercase title'), true);
  assert.equal(isProdWatchCard('  [Prod-Watch] padded  '), true);
  assert.equal(isProdWatchCard('C-H5 — wire rollback'), false);
  assert.equal(isProdWatchCard('fix the [PROD-WATCH] string mid-title'), false);
  assert.equal(isProdWatchCard(undefined), false);
});

// ---------- comment text ----------

test('3. prodCloseText: [PROD-CLOSE] first token, layer + why + fix shape', () => {
  const text = prodCloseText({
    layer: 'qa',
    why: 'the suite mocks the DB, so the migration-drift crash only surfaced in prod',
    fix: 'run migrations against a prod-shaped fixture in CI',
  });
  assert.equal(
    text,
    '[PROD-CLOSE] which-layer=qa — the suite mocks the DB, so the migration-drift crash only surfaced in prod (fix: run migrations against a prod-shaped fixture in CI)',
  );
});

test('4. prodCloseText: fix defaults to n/a, whitespace collapses, layer case-normalizes', () => {
  assert.equal(
    prodCloseText({ layer: 'Infra', why: 'DHCP  moved   the VM' }),
    '[PROD-CLOSE] which-layer=infra — DHCP moved the VM (fix: n/a)',
  );
});

test('5. prodCloseText: unknown layer THROWS naming the valid layers; missing why throws', () => {
  assert.throws(() => prodCloseText({ layer: 'testing', why: 'x' }), (e) =>
    /Unknown layer "testing"/.test(e.message) && e.message.includes('prod-watch'),
  );
  assert.throws(() => prodCloseText({ layer: '', why: 'x' }), /Unknown layer/);
  assert.throws(() => prodCloseText({ layer: 'qa', why: '   ' }), /one-line --why/);
});

// ---------- hasProdClose ----------

test('6. hasProdClose: first-token match on strings AND action objects; negatives reject', () => {
  assert.equal(hasProdClose(['[PROD-CLOSE] which-layer=qa — …']), true);
  assert.equal(hasProdClose([{ data: { text: '[prod-close] which-layer=infra — x' } }]), true);
  assert.equal(hasProdClose(['[IMPL] shipped', '[PROD-CLOSE] which-layer=verify — x']), true);
  assert.equal(hasProdClose(['[IMPL] shipped', '[REVIEW:APPROVE] lgtm']), false);
  // not at the first token → no match (mentions never count):
  assert.equal(hasProdClose(['we should add a [PROD-CLOSE] comment later']), false);
  // [PRODWATCH:RECOVERED] is NOT a closure:
  assert.equal(hasProdClose([{ text: '[PRODWATCH:RECOVERED] back up' }]), false);
  assert.equal(hasProdClose([]), false);
  assert.equal(hasProdClose(undefined), false);
});

// ---------- pure Done-move gate ----------

test('7. moveDoneGate: [PROD-WATCH] without [PROD-CLOSE] refuses; all other shapes allow', () => {
  const watchTitle = '[PROD-WATCH] prod bot down: unhealthy — bot exited 137';
  const refuse = moveDoneGate({ title: watchTitle, comments: ['[IMPL] investigating'] });
  assert.equal(refuse.allow, false);
  assert.match(refuse.reason, /prod-close/);
  assert.match(refuse.reason, /--layer/);
  assert.match(refuse.reason, /--no-close-check/);
  assert.equal(
    moveDoneGate({ title: watchTitle, comments: ['[PROD-CLOSE] which-layer=deploy — x'] }).allow,
    true,
  );
  assert.equal(moveDoneGate({ title: watchTitle, comments: [], noCloseCheck: true }).allow, true);
  assert.equal(
    moveDoneGate({ title: 'C-H5 — wire rollback', comments: [] }).allow,
    true,
  );
});

// ---------- closeProdCard ----------

test('8. closeProdCard: validates layer, posts [PROD-CLOSE], appends exact JSONL seed', async () => {
  const t = fakeTrello({
    card: { id: CARD_ID, name: '[PROD-WATCH] prod bot down: unreachable', url: 'https://trello.com/c/x' },
  });
  const appended = [];
  const seedPath = path.join(mkdtempSync(path.join(tmpdir(), 'prodclose-')), 'seed.jsonl');
  const res = await closeProdCard({
    card: CARD_ID,
    layer: 'verify',
    why: 'the classifier missed OOM kills',
    fix: 'ship the updated deploy-host-logs.sh',
    ts: '2026-11-03T00:00:00.000Z',
    t,
    appendSeed: (p, line) => appended.push({ p, line }),
    seedPath,
  });
  assert.equal(t.calls.addComment.length, 1);
  assert.match(t.calls.addComment[0].text, /^\[PROD-CLOSE\] which-layer=verify — /);
  assert.deepEqual(appended, [
    {
      p: seedPath,
      line: JSON.stringify({
        ts: '2026-11-03T00:00:00.000Z',
        card: CARD_ID,
        url: 'https://trello.com/c/x',
        title: '[PROD-WATCH] prod bot down: unreachable',
        layer: 'verify',
        why: 'the classifier missed OOM kills',
        fix: 'ship the updated deploy-host-logs.sh',
      }),
    },
  ]);
  assert.equal(res.commentId, 'c-1');
  assert.equal(res.seed.layer, 'verify');
});

test('9. closeProdCard: unknown layer throws BEFORE any board write; fix omitted → empty seed fix', async () => {
  const t = fakeTrello({ card: { id: CARD_ID, name: 'x', url: 'u' } });
  await assert.rejects(
    closeProdCard({ card: CARD_ID, layer: 'bogus', why: 'w', t, appendSeed: () => {} }),
    /Unknown layer "bogus"/,
  );
  assert.equal(t.calls.addComment.length, 0);
  const appended = [];
  const res = await closeProdCard({
    card: { id: CARD_ID, name: 'y', url: 'u2' },
    layer: 'infra',
    why: 'power strip flipped',
    t: fakeTrello(),
    appendSeed: (p, line) => appended.push(JSON.parse(line)),
    seedPath: '/dev/null',
  });
  assert.equal(appended[0].fix, '');
  assert.equal(res.seed.layer, 'infra');
});

test('10. defaultAppendSeed: creates data dir, appends one line per call', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prodclose-'));
  const p = path.join(dir, 'nested', 'seed.jsonl');
  defaultAppendSeed(p, '{"a":1}');
  defaultAppendSeed(p, '{"a":2}');
  assert.equal(readFileSync(p, 'utf8'), '{"a":1}\n{"a":2}\n');
});

test('11. SEED_PATH is data/prod-close-seed.jsonl under the repo root', () => {
  assert.equal(SEED_PATH(), path.join(ROOT, 'data', 'prod-close-seed.jsonl'));
});

// ---------- CLI wiring (paths that die BEFORE network) ----------

test('12. CLI prod-close: unknown layer → exit 1, stderr names the valid layers', () => {
  const r = spawnSync(
    process.execPath,
    [FACTORY_JS, 'prod-close', CARD_ID, '--layer', 'testing', '--why', 'x'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown layer "testing"/);
  assert.match(r.stderr, /prod-watch/);
});

test('13. CLI prod-close: missing --why → exit 1 usage', () => {
  const r = spawnSync(
    process.execPath,
    [FACTORY_JS, 'prod-close', CARD_ID, '--layer', 'qa'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: factory\.js prod-close/);
});

test('14. CLI prod-close: bad card id → exit 1 before anything else', () => {
  const r = spawnSync(
    process.execPath,
    [FACTORY_JS, 'prod-close', 'not-a-card', '--layer', 'qa', '--why', 'x'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Not a Trello card id or URL/);
});

test('15. CLI help lists prod-close + the move --no-close-check flag', () => {
  const r = spawnSync(process.execPath, [FACTORY_JS, 'help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /prod-close <card> --layer <name> --why/);
  assert.match(r.stdout, /--no-close-check/);
});
