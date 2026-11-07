// Fresh-master merge guard for the software factory (card
// 6ae96773f672adf3d556b8ec; docs/factory.md "Scheduler loop" PRE-MERGE GUARD).
// CLI: `node scripts/factory.js merge-guard <branch> [target=master]`.
//
// The race this closes: the MERGE GATE rebases onto `origin/master` fetched at
// gate time, but with more than one card in flight a sibling card's push can
// advance `master` between the gate and this card's `git merge --ff-only` +
// push — so the post-merge `npm test` would run against a tree QA never saw.
// The guard re-checks freshness immediately before the merge: a fresh
// `git fetch origin <target>`, then `merge-base(origin/<target>, <branch>) ===
// origin/<target>` tip means the branch sits directly on current master, the
// `--ff-only` produces the byte-identical tree QA tested, and the merge is
// race-free. Any sibling push makes the two differ → `re-gate` (re-run the
// MERGE GATE rebase + mergeable, then this guard).
//
// Fail-closed by design: fetch/rev-parse/merge-base failures THROW, and the
// CLI maps any throw to exit 1 — unproven freshness must never merge.
//
// Dependency-injectable logic, the factory-security-review.js pattern: `git`
// defaults to the real execFileSync runner and is faked in
// tests/factoryMergeGuard.test.js — zero network/git there. The CLI resolves
// the omitted-branch default (`HEAD`) exactly like `mergeable`/`security-check`
// do in scripts/factory.js.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Pure freshness decision. The branch's merge-base with the freshly fetched
 * target equals the sha the branch last rebased onto — i.e. the exact base QA
 * tested against — iff target has not advanced. Returns
 * `{ stale, testedBase, masterTip, action }` with `action` = `'merge'` when
 * fresh, `'re-gate'` when `masterTip` moved past the tested base.
 */
export function assessFreshMaster({ testedBase, masterTip } = {}) {
  const stale = testedBase !== masterTip;
  return { stale, testedBase, masterTip, action: stale ? 're-gate' : 'merge' };
}

const defaultGit = (argv) =>
  execFileSync('git', argv, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * Fetch `origin/<target>` FIRST (the fresh fetch is the point — mirrors
 * "target = origin/master fetched fresh each loop"), then compare
 * `merge-base(origin/<target>, branch)` (the tested base) against
 * `rev-parse origin/<target>` (the current tip). `git` is an injectable
 * runner (argv → stdout string), same shape as `factory.js`'s helper.
 * Throws when `branch` is missing or any git step fails — fail-closed;
 * the CLI turns any throw into exit 1. Resolves the assessFreshMaster
 * verdict.
 */
export async function mergeGuard({ branch, target = 'master', git = defaultGit } = {}) {
  if (!branch) throw new Error('mergeGuard: branch is required');
  git(['fetch', 'origin', target]);
  const masterTip = git(['rev-parse', `origin/${target}`]).trim();
  const testedBase = git(['merge-base', `origin/${target}`, branch]).trim();
  return assessFreshMaster({ testedBase, masterTip });
}
