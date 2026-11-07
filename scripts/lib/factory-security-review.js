// Security footprint probe for the software factory (card 6ae9676cb5da50bc61241a0f).
// CLI: `node scripts/factory.js security-check <branch> <target>` (docs/factory.md
// "Security review pass"; checklist + tag contract: docs/security-review.md).
//
// The scheduler runs this after `[REVIEW:APPROVE]` while the card sits in
// Review. `securitySensitive: true` → spawn the security-reviewer subagent
// (its verdict is a `[SEC:PASS]`/`[SEC:FINDINGS]` comment); false → the
// scheduler posts the no-op `[SEC:PASS]` itself. The probe is a TRIGGER, not
// a gate — it never decides the card's fate, so the CLI always exits 0 (apart
// from usage/git errors) and prints a JSON verdict.
//
// Dependency-injectable logic, the factory-audit-cards.js pattern: `git`
// defaults to the real execFileSync runner and is faked in
// tests/factorySecurityReview.test.js — zero network/git there.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Seed trigger patterns (mirrored in docs/security-review.md — this constant
 * is the single source of truth; the docs describe it). Matched
 * case-insensitively against repo-relative paths from
 * `git diff --name-only <merge-base> <branch>`. Docs-only / plans-only /
 * tests-only diffs match nothing → the no-op path stays cheap.
 */
export const SECURITY_PATH_PATTERNS = [
  // Secrets/env/config files: .env (+ variants), config/config.json, config.js.
  { concern: 'secrets-env-config', re: /(^|\/)\.env(\.|$)/i },
  { concern: 'secrets-env-config', re: /(^|\/)config(\.js|\/config\.json$)/i },
  // Credential plumbing: the Trello client and the ping/ask/resume paths.
  // Scoped to scripts/ per the seed table (a "trello" mention in docs/tests
  // paths is not credential plumbing).
  { concern: 'credential-plumbing', re: /^scripts\/.*\b(trello|factory-(ask|done-ping|comment-resume))\b/i },
  { concern: 'credential-plumbing', re: /\b(secret|credential|auth|token)\b/i },
  // SSH/deploy paths: deploy scripts + docs, ssh helpers, container defs.
  { concern: 'ssh-deploy', re: /deploy/i },
  { concern: 'ssh-deploy', re: /\bssh\b/i },
  { concern: 'ssh-deploy', re: /(^|\/)(Dockerfile|docker-compose\.yml)$/i },
  // Inbound Discord/Trello input: the bot entrypoint, the interaction/
  // routing/resilience layer, and the Trello API client (inbound board input).
  { concern: 'inbound-input', re: /(^|\/)index\.js$/i },
  { concern: 'inbound-input', re: /service\/(interactionAdapter|ai\/(multiBotRouting|requestLog)|resilience)\.js/i },
  { concern: 'inbound-input', re: /\/trello\.js/i },
];

/**
 * Pure footprint matcher. `paths` = repo-relative changed-file paths (the
 * output of `git diff --name-only`). Returns
 * `{ securitySensitive, matchedPaths }` — matchedPaths = the paths that hit
 * at least one pattern, in input order, deduplicated.
 */
export function matchSecurityPaths(paths) {
  const list = Array.isArray(paths) ? paths : [];
  const seen = new Set();
  const matchedPaths = [];
  for (const p of list) {
    const path = String(p ?? '');
    if (!path || seen.has(path)) continue;
    if (SECURITY_PATH_PATTERNS.some(({ re }) => re.test(path))) {
      seen.add(path);
      matchedPaths.push(path);
    }
  }
  return { securitySensitive: matchedPaths.length > 0, matchedPaths };
}

const defaultGit = (argv) =>
  execFileSync('git', argv, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * Diff `branch` against `target` and classify the footprint. `git` is an
 * injectable runner (argv → stdout string). Throws with a message when the
 * two refs share no merge-base (same shape as `factory.js mergeable`).
 * Resolves `{ securitySensitive, matchedPaths, totalFiles }`.
 */
export async function securityCheck({ branch, target = 'master', git = defaultGit } = {}) {
  if (!branch) throw new Error('securityCheck: branch is required');
  let base;
  try {
    base = git(['merge-base', target, branch]).trim();
  } catch (e) {
    throw new Error(`no merge-base between "${target}" and "${branch}": ${String(e.stderr ?? e.message).trim()}`);
  }
  const changed = git(['diff', '--name-only', base, branch])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const { securitySensitive, matchedPaths } = matchSecurityPaths(changed);
  return { securitySensitive, matchedPaths, totalFiles: changed.length };
}
