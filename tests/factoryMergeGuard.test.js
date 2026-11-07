/**
 * Unit tests for scripts/lib/factory-merge-guard.js (fresh-master merge
 * guard; card 6ae96773f672adf3d556b8ec; docs/factory.md "Scheduler loop"
 * PRE-MERGE GUARD).
 *
 * Zero network: `git` is an injected fake that records argv. Process-level
 * CLI tests spawn scripts/factory.js only on paths that die BEFORE any git
 * call (too-many-args usage, help). Doc-sync pins follow the
 * tests/factoryStagePrompts.test.js precedent — the docs, the daemon prompt
 * and this lib must not drift apart. Style mirrors
 * tests/factoryProdClose.test.js.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  assessFreshMaster,
  mergeGuard,
} from '../scripts/lib/factory-merge-guard.js';
import { DEFAULT_MAX_PARALLEL, buildRunPrompt } from '../scripts/factory-daemon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');
const readRepo = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const TIP = 'f'.repeat(40);
const BASE = 'b'.repeat(40);

// Fake git runner: records every argv, returns canned shas. `failFetch`
// makes `git fetch` throw like a dead network.
function fakeGit({ tip = TIP, base = BASE, failFetch = false } = {}) {
  const calls = [];
  const fn = (argv) => {
    calls.push(argv);
    const [step] = argv;
    if (step === 'fetch') {
      if (failFetch) throw new Error('git fetch origin master: connection reset');
      return '';
    }
    if (step === 'rev-parse') return `${tip}\n`;
    if (step === 'merge-base') return `${base}\n`;
    throw new Error(`unexpected git argv: ${argv.join(' ')}`);
  };
  return { calls, fn };
}

// ---------- pure freshness decision ----------

test('1. assessFreshMaster: equal shas → fresh, action=merge', () => {
  const v = assessFreshMaster({ testedBase: TIP, masterTip: TIP });
  assert.deepEqual(v, { stale: false, testedBase: TIP, masterTip: TIP, action: 'merge' });
});

test('2. assessFreshMaster: masterTip past testedBase → stale, action=re-gate, shas echoed', () => {
  const v = assessFreshMaster({ testedBase: BASE, masterTip: TIP });
  assert.deepEqual(v, { stale: true, testedBase: BASE, masterTip: TIP, action: 're-gate' });
});

// ---------- mergeGuard orchestration (fake git, zero network) ----------

test('3. mergeGuard: fetch runs FIRST, then rev-parse tip + merge-base, in order', async () => {
  const g = fakeGit();
  await mergeGuard({ branch: 'factory/abc', target: 'master', git: g.fn });
  assert.deepEqual(g.calls, [
    ['fetch', 'origin', 'master'],
    ['rev-parse', 'origin/master'],
    ['merge-base', 'origin/master', 'factory/abc'],
  ]);
});

test('4. mergeGuard: non-default target threads through every git call', async () => {
  const g = fakeGit();
  await mergeGuard({ branch: 'factory/abc', target: 'main', git: g.fn });
  assert.deepEqual(g.calls[0], ['fetch', 'origin', 'main']);
  assert.deepEqual(g.calls[1], ['rev-parse', 'origin/main']);
  assert.deepEqual(g.calls[2], ['merge-base', 'origin/main', 'factory/abc']);
});

test('5. mergeGuard: verdict equals assessFreshMaster on the fetched shas', async () => {
  const fresh = fakeGit({ tip: TIP, base: TIP });
  assert.deepEqual(
    await mergeGuard({ branch: 'factory/abc', git: fresh.fn }),
    assessFreshMaster({ testedBase: TIP, masterTip: TIP }),
  );
  const stale = fakeGit({ tip: TIP, base: BASE });
  assert.deepEqual(
    await mergeGuard({ branch: 'factory/abc', git: stale.fn }),
    assessFreshMaster({ testedBase: BASE, masterTip: TIP }),
  );
});

test('6. mergeGuard: a throwing fetch REJECTS (fail-closed — unproven freshness never merges)', async () => {
  const g = fakeGit({ failFetch: true });
  await assert.rejects(
    mergeGuard({ branch: 'factory/abc', git: g.fn }),
    /connection reset/,
  );
  // nothing ran after the failed fetch
  assert.equal(g.calls.length, 1);
});

test('7. mergeGuard: missing branch throws before any git call', async () => {
  const g = fakeGit();
  await assert.rejects(mergeGuard({ git: g.fn }), /branch is required/);
  assert.equal(g.calls.length, 0);
});

// ---------- CLI wiring (paths that die BEFORE git/network) ----------

test('8. CLI merge-guard: too many args → exit 1 usage, zero git calls', () => {
  const r = spawnSync(
    process.execPath,
    [FACTORY_JS, 'merge-guard', 'a', 'b', 'c'],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: factory\.js merge-guard <branch> \[target=master\]/);
});

test('9. CLI help lists merge-guard with its exit contract', () => {
  const r = spawnSync(process.execPath, [FACTORY_JS, 'help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /merge-guard <br> \[target=master\]/);
  assert.match(r.stdout, /exit 0 merge \/ exit 1 re-gate/);
});

// ---------- doc-sync pins (factoryStagePrompts.test.js precedent) ----------

test('10. docs/factory.md carries the guard contract: PRE-MERGE GUARD + merge-guard CLI + Gradual rollout', () => {
  const doc = readRepo('docs/factory.md');
  assert.match(doc, /PRE-MERGE GUARD/);
  assert.match(doc, /factory\.js merge-guard/);
  assert.match(doc, /Gradual rollout \(internal-first\)/);
  assert.match(doc, /merge-guard freshness re-check/);
  assert.match(doc, /NEVER --force-push master/);
});

test('11. daemon source pins the canary default: DEFAULT_MAX_PARALLEL = 1', () => {
  assert.equal(DEFAULT_MAX_PARALLEL, 1);
  assert.match(readRepo('scripts/factory-daemon.js'), /export const DEFAULT_MAX_PARALLEL = 1;/);
});

test('12. buildRunPrompt step 3 carries the guard flow (merge-guard before merge, bounded re-gate loop, no force-push)', () => {
  const prompt = buildRunPrompt({ id: 'abc', name: 'X' });
  assert.match(prompt, /factory\.js merge-guard/);
  assert.match(prompt, /re-run the merge gate/);
  assert.match(prompt, /git merge --ff-only/);
  assert.match(prompt, /NEVER --force-push/);
});

test('13. package.json registers this suite in BOTH runner lists', () => {
  const script = JSON.parse(readRepo('package.json')).scripts.test;
  const [jestHalf, nodeTestHalf] = script.split('&&');
  assert.match(jestHalf, /--testPathIgnorePatterns/);
  assert.ok(jestHalf.includes('tests/factoryMergeGuard.test.js'), 'jest ignore list');
  assert.ok(nodeTestHalf.includes('node --test'), 'node --test runner');
  assert.ok(nodeTestHalf.includes('tests/factoryMergeGuard.test.js'), 'node --test list');
});
