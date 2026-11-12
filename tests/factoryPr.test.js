/**
 * Unit tests for scripts/lib/factory-pr.js (card 6af61f32ed767688104029e0;
 * docs/factory.md "The PR as the mobile approval surface").
 *
 * Zero live GitHub/git/Trello: fetchImpl is a canned-route fake recording every
 * request, git is a recorder, trello is a stub, env/fileEnv are explicit maps.
 * Style: tests/factoryRisk.test.js (node:test, plain assert).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  parseRepoSlug,
  githubToken,
  prApprovalsEnabled,
  approversFor,
  prGateConfig,
  gh,
  ensurePr,
  checkPrApprovals,
  evaluateReviews,
  keyedShaFromBody,
  prBody,
} from '../scripts/lib/factory-pr.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARD = 'a'.repeat(24);
const SHA = 'deadbeefcafebabe1234567890abcdef12345678';
const SLUG = 'Ajohnson-1/factory';
const BRANCH = `factory/${CARD}`;

// --- Fakes ---------------------------------------------------------------------

/** Canned-route fake fetch: routes keyed by `${method} ${url}` (exact) or by
 *  URL suffix match; records every call with parsed JSON body. */
function fakeFetch(routes = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: opts.headers ?? {},
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    const hit =
      routes[`${method} ${url}`] ??
      Object.entries(routes).find(([, r]) => r.match && url.includes(r.match))?.[1];
    if (!hit) throw new Error(`unexpected fetch: ${method} ${url}`);
    if (hit.throw) throw hit.throw;
    const payload = typeof hit.json === 'function' ? hit.json({ url, method }) : hit.json ?? null;
    return {
      ok: hit.status ? hit.status < 400 : true,
      status: hit.status ?? 200,
      text: async () => (payload === null ? '' : JSON.stringify(payload)),
    };
  };
  return { calls, impl };
}

const fakeGit = (opts = {}) => {
  const argvs = [];
  const git = (argv) => {
    argvs.push(argv);
    if (argv[0] === 'push' && opts.failFirstPush && !argv.includes('--force-with-lease')) {
      if (!git._pushed) {
        git._pushed = true;
        const e = new Error('rejected');
        e.stderr = '! [rejected] non-fast-forward';
        throw e;
      }
    }
    if (argv[0] === 'push' && opts.failPush) {
      const e = new Error('fatal: push failed');
      e.stderr = 'fatal: the remote end hung up';
      throw e;
    }
    if (argv[0] === 'remote') return opts.remoteUrl ?? 'git@github.com-factory:Ajohnson-1/factory.git\n';
    return '';
  };
  git.argvs = argvs;
  return git;
};

const fakeT = {
  async getCard() {
    return { id: CARD, name: 'Create a PR when a change need to be approved.' };
  },
};
const throwingT = {
  async getCard() {
    throw new Error('trello must not be called');
  },
};

const baseMeta = { slug: SLUG, baseBranch: 'master', approvers: ['ajohnson-1'], enabled: true };
const EMPTY_ENV = { env: {}, fileEnv: {} };

// --- Slug parsing ----------------------------------------------------------------

test('parseRepoSlug: ssh-alias form (the insteadOf rewrite target)', () => {
  assert.equal(parseRepoSlug('git@github.com-factory:Ajohnson-1/factory.git'), 'Ajohnson-1/factory');
});

test('parseRepoSlug: plain ssh with and without .git', () => {
  assert.equal(parseRepoSlug('git@github.com:Ajohnson-1/factory.git'), 'Ajohnson-1/factory');
  assert.equal(parseRepoSlug('git@github.com:Ajohnson-1/factory'), 'Ajohnson-1/factory');
});

test('parseRepoSlug: https with and without .git / credentials', () => {
  assert.equal(parseRepoSlug('https://github.com/Ajohnson-1/factory.git'), 'Ajohnson-1/factory');
  assert.equal(parseRepoSlug('https://github.com/Ajohnson-1/factory'), 'Ajohnson-1/factory');
  assert.equal(parseRepoSlug('https://user:tok@github.com/Ajohnson-1/factory.git'), 'Ajohnson-1/factory');
});

test('parseRepoSlug: unexpected remotes → null (degrade)', () => {
  for (const url of ['git@gitlab.com:o/r.git', 'https://gitlab.com/o/r.git', '/srv/git/local.git', 'garbage', '', null]) {
    assert.equal(parseRepoSlug(url), null, `${url} must not parse`);
  }
});

// --- Token / enablement / approvers -------------------------------------------------

test('githubToken: FACTORY_GITHUB_TOKEN beats GITHUB_TOKEN; env beats .env; both names in both sources', () => {
  assert.equal(githubToken({ env: { FACTORY_GITHUB_TOKEN: 'a', GITHUB_TOKEN: 'b' }, fileEnv: {} }), 'a');
  assert.equal(githubToken({ env: { GITHUB_TOKEN: 'b' }, fileEnv: {} }), 'b');
  assert.equal(githubToken({ env: {}, fileEnv: { FACTORY_GITHUB_TOKEN: 'c', GITHUB_TOKEN: 'd' } }), 'c');
  assert.equal(githubToken({ env: {}, fileEnv: { GITHUB_TOKEN: 'd' } }), 'd');
  assert.equal(githubToken({ env: { FACTORY_GITHUB_TOKEN: 'env-wins' }, fileEnv: { FACTORY_GITHUB_TOKEN: 'file' } }), 'env-wins');
  assert.equal(githubToken({ env: {}, fileEnv: {} }), null);
});

test('prApprovalsEnabled: default ON; FACTORY_PR_APPROVALS=0 (env or .env) OFF', () => {
  assert.equal(prApprovalsEnabled(EMPTY_ENV), true);
  assert.equal(prApprovalsEnabled({ env: { FACTORY_PR_APPROVALS: '0' }, fileEnv: {} }), false);
  assert.equal(prApprovalsEnabled({ env: {}, fileEnv: { FACTORY_PR_APPROVALS: '0' } }), false);
  assert.equal(prApprovalsEnabled({ env: { FACTORY_PR_APPROVALS: '1' }, fileEnv: {} }), true);
});

test('approversFor: FACTORY_GITHUB_APPROVERS overrides; default = slug owner; empty slug → []', () => {
  assert.deepEqual(approversFor({ slug: 'Ajohnson-1/factory', ...EMPTY_ENV }), ['ajohnson-1']);
  assert.deepEqual(
    approversFor({ slug: 'Ajohnson-1/factory', env: { FACTORY_GITHUB_APPROVERS: 'Other, Third ' }, fileEnv: {} }),
    ['other', 'third'],
  );
  assert.deepEqual(approversFor({ slug: null, ...EMPTY_ENV }), []);
});

test('prGateConfig: slug from origin + base + approvers + enabled; records the missing piece', () => {
  const savedTok = process.env.FACTORY_GITHUB_TOKEN;
  const savedGH = process.env.GITHUB_TOKEN;
  try {
    process.env.FACTORY_GITHUB_TOKEN = 'tok';
    delete process.env.GITHUB_TOKEN;
    const cfg = prGateConfig({ git: fakeGit(), baseBranch: 'master', fileEnv: {} });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.slug, 'Ajohnson-1/factory');
    assert.equal(cfg.baseBranch, 'master');
    assert.deepEqual(cfg.approvers, ['ajohnson-1']);
    assert.equal(cfg.disabledReason, null);
    // no token → disabled with the exact reason
    delete process.env.FACTORY_GITHUB_TOKEN;
    const noTok = prGateConfig({ git: fakeGit(), baseBranch: 'master', fileEnv: {} });
    assert.equal(noTok.enabled, false);
    assert.match(noTok.disabledReason, /no GitHub token/);
    // non-GitHub origin → disabled
    const bad = prGateConfig({ git: fakeGit({ remoteUrl: 'git@example.org:o/r.git' }), baseBranch: 'master', fileEnv: {} });
    assert.equal(bad.enabled, false);
    assert.match(bad.disabledReason, /not a GitHub repo/);
    // kill switch → disabled even with slug + token
    process.env.FACTORY_GITHUB_TOKEN = 'tok';
    process.env.FACTORY_PR_APPROVALS = '0';
    const off = prGateConfig({ git: fakeGit(), baseBranch: 'master', fileEnv: {} });
    assert.equal(off.enabled, false);
    assert.match(off.disabledReason, /FACTORY_PR_APPROVALS=0/);
  } finally {
    process.env.FACTORY_PR_APPROVALS = '';
    delete process.env.FACTORY_PR_APPROVALS;
    if (savedTok === undefined) delete process.env.FACTORY_GITHUB_TOKEN;
    else process.env.FACTORY_GITHUB_TOKEN = savedTok;
    if (savedGH === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedGH;
  }
});

// --- gh REST wrapper -----------------------------------------------------------------

test('gh: pinned API version + bearer + JSON body; non-2xx throws', async () => {
  const f = fakeFetch({ 'GET https://api.github.com/repos/o/r': { json: { ok: 1 } } });
  const res = await gh({ path: '/repos/o/r', token: 'tk', fetchImpl: f.impl });
  assert.deepEqual(res, { ok: 1 });
  assert.equal(f.calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer tk');
  const p = fakeFetch({ 'POST https://api.github.com/repos/o/r/pulls': { json: { number: 1 } } });
  await gh({ path: '/repos/o/r/pulls', method: 'POST', body: { a: 1 }, token: 'tk', fetchImpl: p.impl });
  assert.deepEqual(p.calls[0].body, { a: 1 });
  const bad = fakeFetch({ 'GET https://api.github.com/repos/o/r/x': { status: 500, json: null } });
  await assert.rejects(() => gh({ path: '/repos/o/r/x', token: 'tk', fetchImpl: bad.impl }), /HTTP 500/);
});

// --- PR body / keyed sha ----------------------------------------------------------------

test('keyedShaFromBody: reads the contract sha; unrelated hex never matches', () => {
  const body = prBody({ sha: SHA, tier: 'medium', reasons: ['code diff with edits'], files: [{ path: 'src/a.js', additions: 5, deletions: 3 }], cardId: CARD });
  assert.equal(keyedShaFromBody(body), SHA);
  assert.equal(keyedShaFromBody('random text deadbeefcafebabe1234567890abcdef12345678'), null);
  assert.equal(keyedShaFromBody(''), null);
});

test('prBody carries tier, reasons, the QA sha, the numstat table, the card link, the contract', () => {
  const files = [
    { path: 'src/a.js', additions: 5, deletions: 3 },
    { path: 'img/x.png', additions: 0, deletions: 0, binary: true },
  ];
  const body = prBody({ sha: SHA.toUpperCase(), tier: 'high', reasons: ['always-human paths', 'churn 8'], files, cardId: CARD });
  assert.match(body, /Risk tier \*\*high\*\*: always-human paths; churn 8/);
  assert.match(body, new RegExp(`merge\\+Deploy of sha ${SHA};`, 'i'));
  assert.ok(body.includes('| `src/a.js` | +5 | −3 |'));
  assert.ok(body.includes('(binary)'));
  assert.ok(body.includes(`https://trello.com/c/${CARD}`));
  assert.match(body, /a later push requires a fresh approval/);
});

// --- ensurePr --------------------------------------------------------------------------

test('ensurePr: no token → degraded with ZERO fetch calls (and zero git)', async () => {
  const f = fakeFetch({});
  const git = fakeGit();
  const res = await ensurePr({ prMeta: baseMeta, branch: BRANCH, sha: SHA, cardId: CARD, git, fetchImpl: f.impl, ...EMPTY_ENV, t: throwingT });
  assert.equal(res.degraded, true);
  assert.match(res.error, /no GitHub token/);
  assert.equal(f.calls.length, 0);
  assert.equal(git.argvs.length, 0);
});

test('ensurePr: unknown slug → degraded before any I/O', async () => {
  const f = fakeFetch({});
  const res = await ensurePr({ prMeta: { slug: null }, branch: BRANCH, sha: SHA, cardId: CARD, git: fakeGit(), fetchImpl: f.impl, env: { GITHUB_TOKEN: 'tk' }, fileEnv: {}, t: throwingT });
  assert.equal(res.degraded, true);
  assert.match(res.error, /not a GitHub repo/);
  assert.equal(f.calls.length, 0);
});

test('ensurePr: push argv exact, lookup by head=<owner>:<branch>, create shape (title, base, body)', async () => {
  const f = fakeFetch({
    'GET lookup': { match: '/pulls?state=open', json: [] },
    'POST create': { match: '/pulls', json: { number: 42, html_url: 'https://github.com/Ajohnson-1/factory/pull/42' } },
  });
  const git = fakeGit();
  const res = await ensurePr({
    prMeta: baseMeta,
    branch: BRANCH,
    sha: SHA,
    tier: 'medium',
    reasons: ['code diff with edits'],
    files: [{ path: 'src/a.js', additions: 5, deletions: 3 }],
    cardId: CARD,
    git,
    fetchImpl: f.impl,
    env: { GITHUB_TOKEN: 'tk' },
    fileEnv: {},
    t: fakeT,
  });
  assert.deepEqual(res, { number: 42, url: 'https://github.com/Ajohnson-1/factory/pull/42' });
  assert.deepEqual(git.argvs, [['push', 'origin', BRANCH]]); // plain push, no force
  const lookup = f.calls[0];
  assert.match(lookup.url, /\/pulls\?state=open&head=Ajohnson-1%3Afactory%2F/);
  assert.equal(lookup.headers.Authorization, 'Bearer tk');
  const create = f.calls[1];
  assert.equal(create.method, 'POST');
  assert.equal(create.body.head, BRANCH);
  assert.equal(create.body.base, 'master');
  assert.equal(create.body.title, `Create a PR when a change need to be approved. (factory ${CARD})`);
  assert.ok(create.body.body.includes(SHA));
  assert.ok(create.body.body.includes(`https://trello.com/c/${CARD}`));
});

test('ensurePr: getCard failure → fallback title factory/<id>, body still complete', async () => {
  const f = fakeFetch({
    'GET x': { match: '/pulls?state=open', json: [] },
    'POST y': { match: '/pulls', json: { number: 7, html_url: 'u' } },
  });
  const res = await ensurePr({ prMeta: baseMeta, branch: BRANCH, sha: SHA, cardId: CARD, git: fakeGit(), fetchImpl: f.impl, env: { GITHUB_TOKEN: 'tk' }, fileEnv: {}, t: throwingT });
  assert.deepEqual(res, { number: 7, url: 'u' });
  assert.match(f.calls.at(-1).body.title, new RegExp(`^factory/${CARD}$`));
});

test('ensurePr: non-fast-forward push → fetch origin <branch> + --force-with-lease retry (argv order)', async () => {
  const f = fakeFetch({
    'GET x': { match: '/pulls?state=open', json: [] },
    'POST y': { match: '/pulls', json: { number: 8, html_url: 'u' } },
  });
  const git = fakeGit({ failFirstPush: true });
  const res = await ensurePr({ prMeta: baseMeta, branch: BRANCH, sha: SHA, cardId: CARD, git, fetchImpl: f.impl, env: { GITHUB_TOKEN: 'tk' }, fileEnv: {}, t: throwingT });
  assert.equal(res.number, 8);
  assert.deepEqual(git.argvs, [
    ['push', 'origin', BRANCH],
    ['fetch', 'origin', BRANCH],
    ['push', '--force-with-lease', 'origin', BRANCH],
  ]);
});

test('ensurePr: push still failing after the lease retry → degraded, zero fetch calls', async () => {
  const f = fakeFetch({});
  const git = fakeGit({ failPush: true });
  const res = await ensurePr({ prMeta: baseMeta, branch: BRANCH, sha: SHA, cardId: CARD, git, fetchImpl: f.impl, env: { GITHUB_TOKEN: 'tk' }, fileEnv: {}, t: throwingT });
  assert.equal(res.degraded, true);
  assert.match(res.error, /push failed/);
  assert.equal(f.calls.length, 0);
});

test('ensurePr: open PR keyed to the SAME sha → reused as-is, zero PATCH', async () => {
  const existingBody = prBody({ sha: SHA, tier: 'medium', reasons: ['r'], files: [], cardId: CARD });
  const f = fakeFetch({ 'GET x': { match: '/pulls?state=open', json: [{ number: 9, html_url: 'https://gh/pull/9', body: existingBody }] } });
  const res = await ensurePr({ prMeta: baseMeta, branch: BRANCH, sha: SHA, cardId: CARD, git: fakeGit(), fetchImpl: f.impl, env: { GITHUB_TOKEN: 'tk' }, fileEnv: {}, t: throwingT });
  assert.deepEqual(res, { number: 9, url: 'https://gh/pull/9' });
  assert.equal(f.calls.length, 1); // lookup only — no PATCH, no comment, no POST
});

test('ensurePr: open PR keyed to another sha → PATCH body + one sha-change issue comment', async () => {
  const staleBody = prBody({ sha: 'cafebabedeadbeefcafebabe1234567890abcdef99', tier: 'medium', reasons: ['r'], files: [], cardId: CARD });
  const f = fakeFetch({
    'GET x': { match: '/pulls?state=open', json: [{ number: 10, html_url: 'https://gh/pull/10', body: staleBody }] },
    'PATCH p': { match: '/pulls/10', json: {} },
    'POST c': { match: '/issues/10/comments', json: {} },
  });
  const res = await ensurePr({ prMeta: baseMeta, branch: BRANCH, sha: SHA, cardId: CARD, git: fakeGit(), fetchImpl: f.impl, env: { GITHUB_TOKEN: 'tk' }, fileEnv: {}, t: throwingT });
  assert.deepEqual(res, { number: 10, url: 'https://gh/pull/10' });
  const patch = f.calls[1];
  assert.equal(patch.method, 'PATCH');
  assert.equal(keyedShaFromBody(patch.body.body), SHA);
  const comment = f.calls[2];
  assert.equal(comment.method, 'POST');
  assert.ok(comment.url.endsWith('/issues/10/comments'));
  assert.match(comment.body.body, new RegExp(SHA));
});

test('ensurePr: API error → degraded, never thrown', async () => {
  const f = fakeFetch({ 'GET x': { match: '/pulls?state=open', status: 500, json: null } });
  const res = await ensurePr({ prMeta: baseMeta, branch: BRANCH, sha: SHA, cardId: CARD, git: fakeGit(), fetchImpl: f.impl, env: { GITHUB_TOKEN: 'tk' }, fileEnv: {}, t: throwingT });
  assert.equal(res.degraded, true);
  assert.match(res.error, /HTTP 500/);
});

// --- Review evaluation ---------------------------------------------------------------------

const review = (id, state, commitId, login, at) => ({
  id,
  state,
  commit_id: commitId,
  user: { login },
  submitted_at: at,
});

test('evaluateReviews: APPROVED + exact commit + allowlisted login → approval (earliest wins)', () => {
  const r = evaluateReviews(
    [
      review('r2', 'APPROVED', SHA, 'Ajohnson-1', '2026-01-01T02:00:00Z'),
      review('r1', 'APPROVED', SHA, 'ajohnson-1', '2026-01-01T01:00:00Z'),
    ],
    { sha: SHA, approvers: ['Ajohnson-1'] },
  );
  assert.ok(r.approval);
  assert.equal(r.approval.reviewId, 'r1');
  assert.equal(String(r.approval.login).toLowerCase(), 'ajohnson-1');
});

test('evaluateReviews: commit_id keyed case-insensitively; ANY other commit never counts', () => {
  const up = evaluateReviews([review('r', 'APPROVED', SHA.toUpperCase(), 'ajohnson-1', 'x')], { sha: SHA, approvers: ['ajohnson-1'] });
  assert.ok(up.approval);
  const other = evaluateReviews([review('r', 'APPROVED', 'cafebabe00000000000000000000000000000000', 'ajohnson-1', 'x')], { sha: SHA, approvers: ['ajohnson-1'] });
  assert.equal(other.approval, null);
  assert.equal(other.staleApprovals.length, 1);
  assert.equal(other.staleApprovals[0].reason, 'wrong-commit');
});

test('evaluateReviews: non-allowlisted reviewer never approves', () => {
  const r = evaluateReviews([review('r', 'APPROVED', SHA, 'someone-else', 'x')], { sha: SHA, approvers: ['ajohnson-1'] });
  assert.equal(r.approval, null);
  assert.equal(r.staleApprovals[0].reason, 'not-allowlisted');
});

test('evaluateReviews: CHANGES_REQUESTED recorded, COMMENTED/DISMISSED ignored, malformed fail-closed', () => {
  const r = evaluateReviews(
    [
      review('a', 'CHANGES_REQUESTED', SHA, 'ajohnson-1', '2026-01-01T00:00:00Z'),
      review('b', 'COMMENTED', SHA, 'ajohnson-1', 'y'),
      review('c', 'DISMISSED', SHA, 'ajohnson-1', 'z'),
      { id: 'd', state: 'APPROVED', user: { login: 'ajohnson-1' } }, // no commit_id
      null,
    ],
    { sha: SHA, approvers: ['ajohnson-1'] },
  );
  assert.equal(r.approval, null);
  assert.equal(r.changesRequested.length, 1);
  assert.equal(r.unrecognized.length, 1);
  assert.equal(r.unrecognized[0].state, 'APPROVED');
});

test('checkPrApprovals: exactly two GETs (PR + reviews); closed PR → no approval', async () => {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method ?? 'GET' });
    const json = url.includes('/reviews')
      ? [review('r', 'APPROVED', SHA, 'ajohnson-1', '2026-01-01T00:00:00Z')]
      : { state: 'open' };
    return { ok: true, status: 200, text: async () => JSON.stringify(json) };
  };
  const res = await checkPrApprovals({ pr: { number: 12 }, slug: SLUG, sha: SHA, approvers: ['ajohnson-1'], token: 'tk', fetchImpl: impl });
  assert.ok(res.approval);
  assert.equal(res.approval.login, 'ajohnson-1');
  assert.deepEqual(calls.map((c) => c.url), [
    `https://api.github.com/repos/${SLUG}/pulls/12`,
    `https://api.github.com/repos/${SLUG}/pulls/12/reviews`,
  ]);
  // closed PR → approval=null, still exactly the first GET
  const calls2 = [];
  const closed = async (url, opts = {}) => {
    calls2.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ state: 'closed' }) };
  };
  const r2 = await checkPrApprovals({ pr: { number: 12 }, slug: SLUG, sha: SHA, approvers: ['ajohnson-1'], token: 'tk', fetchImpl: closed });
  assert.equal(r2.approval, null);
  assert.equal(calls2.length, 1);
});

test('checkPrApprovals: HTTP failure throws (the gate degrades the cycle)', async () => {
  const boom = async () => ({ ok: false, status: 502, text: async () => '' });
  await assert.rejects(() => checkPrApprovals({ pr: { number: 1 }, slug: SLUG, sha: SHA, approvers: [], token: 'tk', fetchImpl: boom }), /HTTP 502/);
});

// --- package.json registration ----------------------------------------------------------

test('package.json test script runs factoryPr.test.js via node --test AND excludes it from jest', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const testScript = pkg.scripts.test;
  assert.match(testScript, /node --test [^&]*tests\/factoryPr\.test\.js/);
  assert.ok(
    testScript.includes("'tests/factoryPr.test.js'"),
    'jest --testPathIgnorePatterns allowlist must include tests/factoryPr.test.js',
  );
});
