/**
 * Unit tests for scripts/lib/factory-security-review.js + scripts/factory.js
 * security-check wiring (card 6ae9676cb5da50bc61241a0f; docs/security-review.md
 * + docs/factory.md "Security review pass").
 *
 * Zero live git/network in the unit tests: the `git` runner is a fake returning
 * canned per-argv responses, and the path matcher is pure. The process-level
 * tests spawn the CLI only on the help-die path (zero network/git dependency)
 * plus ONE real-repo security-check smoke that asserts only the verdict SHAPE
 * (the repo-relative diff moves between branches; don't pin the boolean).
 * Style mirrors tests/factoryAuditCards.test.js.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  SECURITY_PATH_PATTERNS,
  matchSecurityPaths,
  securityCheck,
} from '../scripts/lib/factory-security-review.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');

// ---- matchSecurityPaths (pure) ----------------------------------------------

// 1. Every seed-table concern must trigger (positives from the plan).
test('1. matchSecurityPaths: seed-table positives all trigger', () => {
  const positives = [
    '.env',
    '.env.example',
    'config/config.json',
    'config.js',
    'scripts/lib/trello.js',
    'scripts/deploy.js',
    'scripts/lib/deploy-ssh.js',
    'service/interactionAdapter.js',
    'service/ai/multiBotRouting.js',
    'service/resilience.js',
    'Dockerfile',
    'docker-compose.yml',
    'index.js',
    'scripts/lib/factory-ask.js',
    'scripts/lib/factory-done-ping.js',
    'scripts/lib/factory-comment-resume.js',
    'scripts/verify-deploy.js',
    'scripts/provision-deploy-host.sh',
    'docs/deploy-host.md',
  ];
  for (const p of positives) {
    const res = matchSecurityPaths([p]);
    assert.ok(res.securitySensitive, `expected ${p} to be security-sensitive`);
    assert.deepEqual(res.matchedPaths, [p]);
  }
});

// 2. Docs / plans / test-only diffs must NOT trigger (the no-op fast path).
test('2. matchSecurityPaths: docs/plans/test-only diffs are not sensitive', () => {
  const negatives = [
    'README.md',
    'docs/factory.md',
    'docs/factory-audit.md',
    'plans/factory/6ae9676cb5da50bc61241a0f-plan.md',
    'tests/foo.test.js',
    'tests/factoryAuditCards.test.js',
  ];
  const res = matchSecurityPaths(negatives);
  assert.equal(res.securitySensitive, false);
  assert.deepEqual(res.matchedPaths, []);
});

// 3. matchedPaths preserves input order and deduplicates.
test('3. matchSecurityPaths: order preserved, duplicates collapsed', () => {
  const res = matchSecurityPaths([
    'docs/x.md',
    'scripts/lib/trello.js',
    'Dockerfile',
    'scripts/lib/trello.js',
  ]);
  assert.equal(res.securitySensitive, true);
  assert.deepEqual(res.matchedPaths, ['scripts/lib/trello.js', 'Dockerfile']);
});

// 4. Defensive input: non-array / empty → not sensitive.
test('4. matchSecurityPaths: empty and non-array input → no-op verdict', () => {
  assert.deepEqual(matchSecurityPaths([]), { securitySensitive: false, matchedPaths: [] });
  assert.deepEqual(matchSecurityPaths(undefined), { securitySensitive: false, matchedPaths: [] });
});

// ---- securityCheck (fake git runner) ----------------------------------------

/** Fake git runner: exact-argv canned stdout + full call log. */
function fakeGit(routes) {
  const calls = [];
  return {
    calls,
    run(argv) {
      calls.push(argv);
      const key = argv.join(' ');
      for (const [match, out] of routes) {
        if (key.startsWith(match)) {
          if (out instanceof Error) throw out;
          return out;
        }
      }
      throw new Error(`fake git: unexpected argv ${key}`);
    },
  };
}

// 5. Happy path: merge-base → diff --name-only → classified verdict + totals.
test('5. securityCheck: merge-base + diff argv sequence, JSON verdict shape', async () => {
  const g = fakeGit([
    ['merge-base master factory/card1', 'a'.repeat(40) + '\n'],
    ['diff --name-only ' + 'a'.repeat(40) + ' factory/card1', 'README.md\nscripts/lib/trello.js\nplans/x.md\n'],
  ]);
  const res = await securityCheck({ branch: 'factory/card1', target: 'master', git: g.run });
  assert.deepEqual(g.calls, [
    ['merge-base', 'master', 'factory/card1'],
    ['diff', '--name-only', 'a'.repeat(40), 'factory/card1'],
  ]);
  assert.deepEqual(res, {
    securitySensitive: true,
    matchedPaths: ['scripts/lib/trello.js'],
    totalFiles: 3,
  });
});

// 6. Non-sensitive branch: full diff counts, zero matches.
test('6. securityCheck: docs-only diff → securitySensitive false + totalFiles', async () => {
  const g = fakeGit([
    ['merge-base', 'base-sha\n'],
    ['diff --name-only', 'docs/factory.md\nplans/factory/x-plan.md\n'],
  ]);
  const res = await securityCheck({ branch: 'factory/card2', git: g.run });
  assert.equal(res.securitySensitive, false);
  assert.deepEqual(res.matchedPaths, []);
  assert.equal(res.totalFiles, 2);
});

// 7. Missing merge-base throws with a readable message (same shape as mergeable;
// the CLI turns it into exit 1 — usage/git errors are the probe's only non-zero path).
test('7. securityCheck: no merge-base → throws with named refs + git stderr', async () => {
  const err = Object.assign(new Error('Command failed'), {
    stderr: 'fatal: not something... and unrelated\n',
  });
  const g = fakeGit([['merge-base', err]]);
  await assert.rejects(
    () => securityCheck({ branch: 'factory/gone', target: 'master', git: g.run }),
    /no merge-base between "master" and "factory\/gone"/,
  );
});

// 8. Missing branch argument fails loud (usage error).
test('8. securityCheck: branch required', async () => {
  await assert.rejects(() => securityCheck({ git: fakeGit([]).run }), /branch is required/);
});

// 9. SECURITY_PATH_PATTERNS is the documented shape: every entry is a
// labelled case-insensitive regex (docs/security-review.md mirrors it).
test('9. SECURITY_PATH_PATTERNS: labelled {concern, re} regexes', () => {
  assert.ok(Array.isArray(SECURITY_PATH_PATTERNS));
  assert.ok(SECURITY_PATH_PATTERNS.length >= 10);
  for (const p of SECURITY_PATH_PATTERNS) {
    assert.equal(typeof p.concern, 'string');
    assert.ok(p.re instanceof RegExp);
    assert.ok(p.re.flags.includes('i'), `${p.re} must be case-insensitive`);
  }
});

// ---- CLI wiring (pre-network paths + one shape-only real-repo smoke) --------

const runCli = (...argv) =>
  spawnSync(process.execPath, [FACTORY_JS, ...argv], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

// 10. help advertises security-check with its verdict keys.
test('10. CLI help lists security-check', () => {
  const r = runCli('help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /security-check/);
  assert.match(r.stdout, /securitySensitive/);
});

// 11. Real-repo smoke: exit 0 + verdict SHAPE only (the diff moves as branches
// move — never pin securitySensitive here).
test('11. CLI security-check against real git: exit 0, shape-only verdict', () => {
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const r = runCli('security-check', branch, 'master');
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const verdict = JSON.parse(r.stdout);
  assert.equal(typeof verdict.securitySensitive, 'boolean');
  assert.ok(Array.isArray(verdict.matchedPaths));
  assert.equal(typeof verdict.totalFiles, 'number');
});
