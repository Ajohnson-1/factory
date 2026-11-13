// GitHub PR as the mobile approval surface for the risk gate (card
// 6af61f32ed767688104029e0; docs/factory.md "Risk-tiered approval before
// Deploy" → "The PR as the mobile approval surface").
//
// When the risk gate must ask a human, this module — best-effort — pushes the
// card branch and opens (or updates) a GitHub pull request, so the human can
// read the REAL diff on a phone (GitHub app / mobile web, Files tab) and
// approve with Review → Approve instead of typing a 40-char sha into a Trello
// comment. Every PR-side call is best-effort: no token / kill switch / push
// failure / API error ⇒ `{ degraded: true, error }`, never thrown — the gate
// falls back to today's sha-only ask, byte-identical.
//
// The approval RULE lives gate-side in factory-risk.js; this module only
// speaks GitHub REST directly with global `fetch` (the factory-ask.js
// pattern — `gh` CLI is not installed and needs a token anyway): pinned
// `X-GitHub-Api-Version`, bearer auth, fail-closed parsing (unrecognized
// review fields ⇒ no approval).
//
// Seams, the factory-ask.js pattern: `git`, `fetchImpl`, `env`, `fileEnv`,
// `t` (trello client, for the PR body's card link/title) all default to the
// real thing and are faked in tests/factoryPr.test.js — zero live
// Trello/GitHub/git in tests.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as trello from './trello.js';
import { parseDotEnv } from './trello.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GH_API = 'https://api.github.com';

// --- Configuration (pure) ----------------------------------------------------

/**
 * Parse a GitHub `owner/repo` slug out of any origin remote URL. Handles the
 * factory box's ssh-alias form (`git@github.com-factory:owner/repo.git` —
 * the `insteadOf` rewrite target, docs/factory-migration.md §3), plain ssh
 * (`git@github.com:owner/repo.git`), and https
 * (`https://github.com/owner/repo[.git]`, with or without credentials).
 * Anything else (gitlab, ssh:// with a path prefix, garbage) → null → the
 * PR feature degrades. Pure.
 */
export function parseRepoSlug(remoteUrl) {
  const url = String(remoteUrl ?? '').trim();
  if (!url) return null;
  const hostTail = (host, path) => {
    if (!/^github(\.|-)[\w.-]*$/i.test(host)) return null;
    const p = String(path ?? '').replace(/\.git$/i, '');
    const m = p.match(/^([^/]+)\/([^/]+)$/);
    return m ? `${m[1]}/${m[2]}` : null;
  };
  const ssh = url.match(/^[^@/]+@([\w.-]+):(.+)$/);
  if (ssh) return hostTail(ssh[1], ssh[2]);
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'ssh:') return null;
    return hostTail(u.hostname, u.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

/**
 * GitHub token, env → .env: FACTORY_GITHUB_TOKEN wins over GITHUB_TOKEN
 * (both names, both sources; first hit wins). Missing ⇒ PR feature off.
 * Pure over injected maps.
 */
export function githubToken({ env = process.env, fileEnv = parseDotEnv() } = {}) {
  return String(env.FACTORY_GITHUB_TOKEN || fileEnv.FACTORY_GITHUB_TOKEN || env.GITHUB_TOKEN || fileEnv.GITHUB_TOKEN || '').trim() || null;
}

/** Kill switch: FACTORY_PR_APPROVALS=0 (env or .env) disables every PR call
 *  — today's sha-only gate, byte-identical. Default ON (best-effort). */
export function prApprovalsEnabled({ env = process.env, fileEnv = parseDotEnv() } = {}) {
  const v = env.FACTORY_PR_APPROVALS ?? fileEnv.FACTORY_PR_APPROVALS;
  return String(v ?? '').trim() !== '0';
}

/** Approver logins allowed to approve via PR review: FACTORY_GITHUB_APPROVERS
 *  (comma-separated, env or .env), default = the repo OWNER parsed from the
 *  origin slug — fail-closed single-approver with zero config. */
export function approversFor({ slug = null, env = process.env, fileEnv = parseDotEnv() } = {}) {
  const v = String(env.FACTORY_GITHUB_APPROVERS || fileEnv.FACTORY_GITHUB_APPROVERS || '').trim();
  if (v) return v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const owner = slug ? String(slug).split('/')[0] : null;
  return owner ? [owner.toLowerCase()] : [];
}

/**
 * CLI-side gate config: resolve the slug from the repo's origin remote
 * (`git(['remote','get-url','origin'])`), the base branch, the approver
 * allowlist, and the enabled flag (kill switch + slug + token must all be
 * present; `disabledReason` records which one was missing). Returned object
 * rides the gate as `prMeta`. Never throws.
 */
export function prGateConfig({ git = realGit, baseBranch = 'master', env = process.env, fileEnv = parseDotEnv() } = {}) {
  let slug = null;
  try {
    slug = parseRepoSlug(String(git(['remote', 'get-url', 'origin'])));
  } catch {
    slug = null;
  }
  const enabled = prApprovalsEnabled({ env, fileEnv });
  const token = githubToken({ env, fileEnv });
  const disabledReason = !enabled
    ? 'disabled (FACTORY_PR_APPROVALS=0)'
    : !slug
      ? 'origin remote is not a GitHub repo'
      : !token
        ? 'no GitHub token (GITHUB_TOKEN / FACTORY_GITHUB_TOKEN)'
        : null;
  return {
    enabled: enabled && Boolean(slug) && Boolean(token),
    disabledReason,
    slug,
    baseBranch: String(baseBranch || 'master'),
    approvers: approversFor({ slug, env, fileEnv }),
  };
}

// --- Git seam ------------------------------------------------------------------

const realGit = (argv) =>
  execFileSync('git', argv, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// --- REST seam -------------------------------------------------------------------

/** One GitHub REST call: bearer auth, pinned API version, JSON in/out.
 *  Non-2xx throws (callers degrade); the response body is parsed best-effort. */
export async function gh({ path, method = 'GET', body, token, fetchImpl = fetch } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'factory-risk-gate',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(`${GH_API}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = typeof res?.text === 'function' ? await res.text() : String(await res?.json?.() ?? '');
  if (!res?.ok) throw new Error(`GitHub ${method} ${path} -> HTTP ${res?.status}`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Best-effort issue comment on a PR (sha-change re-ask marker). Never throws. */
export async function prComment({ slug, number, body, token, fetchImpl = fetch } = {}) {
  try {
    await gh({ path: `/repos/${slug}/issues/${number}/comments`, method: 'POST', body: { body }, token, fetchImpl });
    return { posted: true };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// --- PR body / keyed sha ----------------------------------------------------------

/** The sha the PR body is keyed to — the contract sentence is the key
 *  (`Approving at this commit approves merge+Deploy of sha <40-hex>;`).
 *  Anything else in the body (paths, branch names) never matches. */
export function keyedShaFromBody(body) {
  const m = String(body ?? '').match(/approves merge\+Deploy of sha ([0-9a-f]{7,40});/i);
  return m ? m[1].toLowerCase() : null;
}

/** The PR description: tier + reasons, the QA sha, the numstat file table
 *  already computed by classifyDiff, the Trello card link, and the contract
 *  sentence — approving at this commit approves merge+Deploy of sha X; a
 *  later push requires a fresh approval; replying on the card with the sha
 *  also works. */
export function prBody({ sha, tier, reasons = [], files = [], cardId }) {
  const table = files
    .map((f) => `| \`${f?.path ?? ''}\` | +${Number(f?.additions) || 0} | −${Number(f?.deletions) || 0}${f?.binary ? ' (binary)' : ''} |`)
    .join('\n');
  return [
    `Risk tier **${tier}**: ${reasons.join('; ')}.`,
    ``,
    `Approving at this commit approves merge+Deploy of sha ${String(sha).toLowerCase()}; a later push requires a fresh approval; or reply on the card with the sha.`,
    ``,
    `Trello card: https://trello.com/c/${cardId}`,
    ``,
    `Files (${files.length}):`,
    ``,
    '| path | + | − |',
    '| --- | --- | --- |',
    table || '| (empty diff) | 0 | 0 |',
  ].join('\n');
}

// --- ensurePr ----------------------------------------------------------------------

/**
 * Best-effort: push `branch`, then open (or update) the GitHub PR for it.
 * Every failure mode returns `{ degraded: true, error }` — never throws:
 * no token/slug ⇒ ZERO fetch (and zero git) calls; push rejection ⇒ one
 * `fetch origin <branch>` + `push --force-with-lease` retry (a merge-guard
 * rebase rewrote the branch), still failing ⇒ degraded; PR keyed to another
 * sha ⇒ PATCH the body + one issue comment naming the new sha; same sha ⇒
 * reuse as-is (zero PATCH). `prMeta`: `{ slug }` (slug pre-resolved by the
 * caller via prGateConfig).
 * → { number, url } | { degraded: true, error }
 */
export async function ensurePr({
  prMeta = {},
  branch,
  sha,
  tier,
  reasons = [],
  files = [],
  cardId,
  git = realGit,
  fetchImpl = fetch,
  env = process.env,
  fileEnv = parseDotEnv(),
  t = trello,
} = {}) {
  const slug = prMeta.slug;
  const token = githubToken({ env, fileEnv });
  if (!token) return { degraded: true, error: 'no GitHub token (GITHUB_TOKEN / FACTORY_GITHUB_TOKEN)' };
  if (!slug) return { degraded: true, error: 'origin remote is not a GitHub repo' };
  if (!branch || !sha) return { degraded: true, error: 'missing branch or sha' };
  // Push: plain first; a non-fast-forward rejection (a merge-guard rebase
  // rewrote the branch) gets exactly one fetch + --force-with-lease retry —
  // the only refs this ever force-pushes are factory/* branches, which only
  // the factory writes.
  try {
    git(['push', 'origin', branch]);
  } catch (e1) {
    try {
      git(['fetch', 'origin', branch]);
      git(['push', '--force-with-lease', 'origin', branch]);
    } catch (e2) {
      return { degraded: true, error: `push failed: ${String(e2?.stderr ?? e2?.message ?? e2).trim()}` };
    }
  }
  // Card title best-effort (the PR headline should read like the card, not a
  // bare id); fallback keeps the body's facts complete.
  let title = `factory/${cardId}`;
  try {
    const card = (await t.getCard(cardId)) ?? {};
    if (card.name) title = `${card.name} (factory ${cardId})`;
  } catch {
    /* degraded title — body still carries every fact */
  }
  const body = prBody({ sha, tier, reasons, files, cardId });
  const owner = slug.split('/')[0];
  try {
    const open = await gh({
      path: `/repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      token,
      fetchImpl,
    });
    const existing = Array.isArray(open) ? open.find((p) => p?.html_url) : null;
    if (existing?.number) {
      const keyed = keyedShaFromBody(existing.body);
      if (keyed && keyed === String(sha).toLowerCase()) {
        return { number: existing.number, url: existing.html_url };
      }
      // The branch moved since the PR was opened (rebase/QA re-run): re-key
      // the PR body to the new sha and leave a visible comment — the stale
      // approval is invalid on GitHub too, and the re-ask shows on the PR.
      await gh({ path: `/repos/${slug}/pulls/${existing.number}`, method: 'PATCH', body: { body }, token, fetchImpl });
      await prComment({
        slug,
        number: existing.number,
        body: `Factory re-ask: the branch moved to \`${String(sha).toLowerCase()}\` — previous approvals at other commits do not count. Approve THIS commit (or reply on the Trello card with the sha).`,
        token,
        fetchImpl,
      });
      return { number: existing.number, url: existing.html_url };
    }
    const created = await gh({
      path: `/repos/${slug}/pulls`,
      method: 'POST',
      body: { title, head: branch, base: prMeta.baseBranch ?? 'master', body },
      token,
      fetchImpl,
    });
    if (!created?.number) return { degraded: true, error: 'PR create returned no number' };
    return { number: created.number, url: created.html_url };
  } catch (e) {
    return { degraded: true, error: `GitHub API: ${String(e?.message ?? e)}` };
  }
}

// --- PR review approval -------------------------------------------------------------

/**
 * Pure review evaluation (fail-closed): an APPROVED review qualifies ONLY
 * when its `commit_id` equals `sha` (full sha, case-insensitive) AND the
 * reviewer login is in `approvers` (case-insensitive). The EARLIEST
 * qualifying approval wins. CHANGES_REQUESTED reviews are recorded
 * separately; COMMENTED/DISMISSED never approve. Reviews with unrecognized
 * shape (no state/login/commit_id) are recorded as `unrecognized`, NEVER
 * approve — malformed fields are a format-drift signal, not an approval.
 * → { approval: { login, reviewId, commitId, date } | null,
 *     changesRequested: [...], staleApprovals: [...], unrecognized: [...] }
 */
export function evaluateReviews(reviews, { sha, approvers = [] } = {}) {
  const want = String(sha ?? '').toLowerCase();
  const allow = (approvers ?? []).map((l) => String(l).toLowerCase());
  const out = { approval: null, changesRequested: [], staleApprovals: [], unrecognized: [] };
  const list = Array.isArray(reviews) ? [...reviews] : [];
  list.sort((x, y) => String(x?.submitted_at ?? '').localeCompare(String(y?.submitted_at ?? '')));
  for (const r of list) {
    const state = String(r?.state ?? '').toUpperCase();
    const login = String(r?.user?.login ?? '');
    const commitId = String(r?.commit_id ?? '');
    if (!state || !login || !commitId) {
      if (r != null) out.unrecognized.push({ state: state || null, login: login || null, commitId: commitId || null, date: r.submitted_at ?? null });
      continue;
    }
    const rec = { login, commitId, date: r.submitted_at ?? null, reviewId: r.id ?? null };
    if (state === 'CHANGES_REQUESTED') {
      out.changesRequested.push(rec);
      continue;
    }
    if (state !== 'APPROVED') continue; // COMMENTED / DISMISSED / PENDING — never approve
    if (commitId.toLowerCase() !== want) {
      out.staleApprovals.push({ ...rec, reason: 'wrong-commit' });
      continue;
    }
    if (!allow.includes(login.toLowerCase())) {
      out.staleApprovals.push({ ...rec, reason: 'not-allowlisted' });
      continue;
    }
    if (!out.approval) out.approval = rec; // earliest wins (list pre-sorted)
  }
  return out;
}

/**
 * The gate's per-cycle PR approval check: exactly TWO authenticated GETs —
 * the PR (must be `open`; a merged/closed PR cannot carry a live approval)
 * and its reviews list — then the pure `evaluateReviews` rule. Throws on any
 * HTTP failure: the gate degrades THAT cycle and self-heals next poll (the
 * pollForReply bot-identity precedent).
 */
export async function checkPrApprovals({ pr = {}, slug, sha, approvers = [], token, fetchImpl = fetch } = {}) {
  const tok = token ?? githubToken();
  const prData = await gh({ path: `/repos/${slug}/pulls/${pr.number}`, token: tok, fetchImpl });
  if (!prData || String(prData.state ?? '').toLowerCase() !== 'open') {
    return { approval: null, changesRequested: [], staleApprovals: [], unrecognized: [] };
  }
  const reviews = await gh({ path: `/repos/${slug}/pulls/${pr.number}/reviews`, token: tok, fetchImpl });
  return evaluateReviews(reviews, { sha, approvers });
}
