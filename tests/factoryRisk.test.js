/**
 * Unit tests for scripts/lib/factory-risk.js + scripts/factory.js risk/approve
 * wiring (card 6ae9676d0ee4189387157881; docs/factory.md
 * "Risk-tiered approval before Deploy").
 *
 * Zero live Trello/Discord/git: every dep is injected — fake trello client
 * (canned comment sequences), fake git (canned merge-base + numstat), fake
 * notify (records text), fake sleep/now (virtual clock). The only
 * process-level tests spawn the CLI on paths that die before any network call
 * (style: tests/factoryAsk.test.js).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  classifyDiff,
  getDiffStat,
  shaMentionRe,
  findApprovalComment,
  approvalGate,
  approvalAskText,
  approvalTimeoutDefault,
  HIGH_CHURN_LINES,
  HIGH_FILE_COUNT,
  ALWAYS_HUMAN,
} from '../scripts/lib/factory-risk.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');
const CARD = 'a'.repeat(24);
const SHA = 'deadbeefcafebabe1234567890abcdef12345678';
const T0 = '2026-01-01T00:00:00.000Z';

const BOT = { id: 'bot1', username: 'omp-bot' };
const HUMAN = { id: 'member-1', username: 'stirmmy', fullName: 'Andrew' };

/** commentCard action shape (trello.js getCardComments items). */
const act = (id, date, text, creator = HUMAN) => ({
  id,
  date,
  data: { text },
  memberCreator: creator,
});

/** Virtual-clock sleep/now pair: sleep advances the clock; now reads it. */
function virtualClock(startMs = Date.parse(T0)) {
  let ms = startMs;
  return {
    now: () => new Date(ms).toISOString(),
    sleep: async (d) => {
      ms += d;
    },
  };
}

/** Fake trello client for the gate. comments = seq of arrays (last sticks);
 *  records every call. addComment returns {id,date} so askHuman's flow runs. */
function fakeGateTrello({ comments = [], me = BOT, meThrows = null, cardThrows = null } = {}) {
  const seq = [...comments];
  const calls = { add: [], getComments: 0, getCard: 0, getMe: 0 };
  return {
    calls,
    async getCardComments() {
      calls.getComments += 1;
      return seq.length > 1 ? seq.shift() : seq[0] ?? [];
    },
    async getMe() {
      calls.getMe += 1;
      if (meThrows) throw meThrows;
      if (me instanceof Error) throw me;
      return me;
    },
    async addComment(cardId, text) {
      calls.add.push({ cardId, text });
      return { id: 'ask1', date: new Date(Date.now()).toISOString() };
    },
    async getCard() {
      calls.getCard += 1;
      if (cardThrows) throw cardThrows;
      return { id: CARD, name: 'Risk card', url: `https://trello.com/c/${CARD}/risk-card` };
    },
  };
}

const throwingGit = () => {
  throw new Error('git must not run in this test');
};
const throwingTrello = () => {
  const t = fakeGateTrello();
  return new Proxy(t, {
    get: (obj, prop) => async (...args) => {
      throw new Error(`unexpected trello.${String(prop)}`);
    },
  });
};

// ---------------------------------------------------------------------------
// 1. classifyDiff tiers
// ---------------------------------------------------------------------------

test('classifyDiff: docs-only diff → low', () => {
  const r = classifyDiff([
    { path: 'docs/x.md', additions: 10, deletions: 3 },
    { path: 'plans/factory/y-plan.md', additions: 50, deletions: 20 },
    { path: 'README.md', additions: 1, deletions: 1 },
  ]);
  assert.equal(r.tier, 'low');
  assert.match(r.reasons.join(' '), /docs-only/);
});

test('classifyDiff: additive-only diff (no deletions, no binary) → low', () => {
  const r = classifyDiff([
    { path: 'src/a.js', additions: 100, deletions: 0 },
    { path: 'src/b.js', additions: 200, deletions: 0 },
  ]);
  assert.equal(r.tier, 'low');
  assert.match(r.reasons.join(' '), /additive-only/);
});

test('classifyDiff: mixed code edit with deletions → medium', () => {
  const r = classifyDiff([{ path: 'src/a.js', additions: 5, deletions: 3 }]);
  assert.equal(r.tier, 'medium');
});

test('classifyDiff: churn ≥ 500 lines → high (blast radius)', () => {
  const r = classifyDiff([{ path: 'src/a.js', additions: 300, deletions: HIGH_CHURN_LINES - 300 }]);
  assert.equal(r.tier, 'high');
  assert.match(r.reasons.join(' '), new RegExp(`churn ${HIGH_CHURN_LINES}`));
});

test('classifyDiff: file count ≥ 25 → high (blast radius)', () => {
  const files = Array.from({ length: HIGH_FILE_COUNT }, (_, i) => ({
    path: `src/f${i}.js`,
    additions: 2,
    deletions: 1,
  }));
  const r = classifyDiff(files);
  assert.equal(r.tier, 'high');
  assert.match(r.reasons.join(' '), new RegExp(`${HIGH_FILE_COUNT} files`));
});

test('classifyDiff: churn 499 + 24 files with deletions → medium (edge)', () => {
  const files = [
    { path: 'src/big.js', additions: 452, deletions: 1 },
    ...Array.from({ length: 23 }, (_, i) => ({ path: `src/f${i}.js`, additions: 1, deletions: 1 })),
  ];
  const total = files.reduce((s, f) => s + f.additions + f.deletions, 0);
  assert.equal(total, HIGH_CHURN_LINES - 1);
  assert.equal(files.length, HIGH_FILE_COUNT - 1);
  const r = classifyDiff(files);
  assert.equal(r.tier, 'medium');
});

test('classifyDiff: empty diff → low with reason "empty diff"', () => {
  const r = classifyDiff([]);
  assert.equal(r.tier, 'low');
  assert.deepEqual(r.reasons, ['empty diff']);
});

test('classifyDiff: binary entry NEVER satisfies additive-only → medium', () => {
  const r = classifyDiff([
    { path: 'img/logo.png', additions: 0, deletions: 0, binary: true },
    { path: 'docs/img/logo.png', additions: 0, deletions: 0, binary: true },
  ]);
  assert.equal(r.tier, 'medium');
});

// ---------------------------------------------------------------------------
// 2. always-human paths (criterion 4 — each pattern, even at 1 added line)
// ---------------------------------------------------------------------------

test('always-human: every pattern hits high at 1 added line', () => {
  const paths = [
    'scripts/deploy.js',
    'scripts/verify-deploy.js',
    'scripts/prod-watch.js',
    'scripts/lib/deploy-ssh.js',
    'config/config.json',
    '.github/workflows/ci.yml',
    'Dockerfile',
    'docker-compose.yml',
    // subdir forms must tier high too — (^|/) prefixes, not root-anchored
    'deploy/Dockerfile',
    'infra/docker-compose.yml',
    'apps/web/docker-compose.dev.yaml',
    'deploy-host-logs.sh',
    '.env',
    'secrets/prod.pem',
    'aws_credentials',
  ];
  assert.ok(paths.length >= 12);
  for (const p of paths) {
    const r = classifyDiff([{ path: p, additions: 1, deletions: 0 }]);
    assert.equal(r.tier, 'high', `${p} must be always-human high`);
    assert.match(r.reasons.join(' '), /always-human/);
  }
});

test('always-human: a docs PR that ALSO touches config/ is high (order matters)', () => {
  const r = classifyDiff([
    { path: 'docs/x.md', additions: 10, deletions: 2 },
    { path: 'config/config.json', additions: 1, deletions: 0 },
  ]);
  assert.equal(r.tier, 'high');
});

// ---------------------------------------------------------------------------
// 3. getDiffStat (fake git)
// ---------------------------------------------------------------------------

test('getDiffStat: parses numstat incl. binary rows, rename rows, mergeBase', () => {
  const argvs = [];
  const git = (argv) => {
    argvs.push(argv);
    if (argv[0] === 'merge-base') return 'abc1234567890abc1234567890abc1234567890\n';
    assert.deepEqual(argv.slice(0, 3), ['diff', '--numstat', 'abc1234567890abc1234567890abc1234567890']);
    return [
      '12\t4\tsrc/a.js',
      '-\t-\timg.png',
      '3\t0\told.js => new.js',
      '5\t2\tdir/{old.js => renamed.js}.test',
      'garbage line without tabs',
    ].join('\n');
  };
  const r = getDiffStat({ branch: 'factory/x', target: 'origin/master', git });
  assert.equal(r.mergeBase, 'abc1234567890abc1234567890abc1234567890');
  assert.equal(r.files.length, 4);
  assert.deepEqual(r.files[0], { path: 'src/a.js', additions: 12, deletions: 4, binary: false });
  assert.deepEqual(r.files[1], { path: 'img.png', additions: 0, deletions: 0, binary: true });
  assert.equal(r.files[2].path, 'new.js');
  assert.equal(r.files[3].path, 'dir/renamed.js.test');
  assert.equal(r.additions, 20);
  assert.equal(r.deletions, 6);
  assert.deepEqual(argvs[0], ['merge-base', 'origin/master', 'factory/x']);
});

test('getDiffStat: git failure (bad refs) is rethrown', () => {
  const git = () => {
    throw new Error('fatal: not something we can merge');
  };
  assert.throws(() => getDiffStat({ branch: 'nope', git }), /not something we can merge/);
});

// ---------------------------------------------------------------------------
// 4. shaMentionRe
// ---------------------------------------------------------------------------

test('shaMentionRe: full sha, ≥7-char prefix; rejects shorter/mid-word; case-insensitive', () => {
  const re = shaMentionRe(SHA);
  assert.ok(re.test(`[HUMAN] APPROVED ${SHA}`));
  assert.ok(re.test(`approved deadbee please`)); // exactly 7 chars
  assert.ok(re.test(`approved DEADBEEF cafe`)); // case-insensitive, 12-hex word
  assert.ok(!re.test(`approved deadbe`)); // 6-char prefix
  assert.ok(!re.test(`xxdeadbeefcafebabe`)); // embedded mid-word
  assert.throws(() => shaMentionRe('not-hex'), /Invalid sha/);
});

// ---------------------------------------------------------------------------
// 5. findApprovalComment
// ---------------------------------------------------------------------------

test('findApprovalComment: non-bot author + full sha → match', () => {
  const m = findApprovalComment([act('c1', T0, `shipped ${SHA}`)], { sha: SHA, bot: BOT });
  assert.ok(m);
  assert.equal(m.via, 'author');
  assert.equal(m.commentId, 'c1');
});

test('findApprovalComment: non-bot + [HUMAN] tag + 7-char prefix → match', () => {
  const m = findApprovalComment([act('c2', T0, '[HUMAN] APPROVED deadbee')], { sha: SHA, bot: BOT });
  assert.ok(m);
  assert.equal(m.via, 'tag');
});

test('findApprovalComment: bot id + [HUMAN]-tagged sha → NEVER counts (criterion 3)', () => {
  const m = findApprovalComment(
    [act('c3', T0, `[HUMAN] APPROVED ${SHA}`, { id: 'bot1', username: 'someone-else' })],
    { sha: SHA, bot: BOT },
  );
  assert.equal(m, null);
});

test('findApprovalComment: username-fallback bot match → null', () => {
  const m = findApprovalComment(
    [act('c4', T0, `[HUMAN] APPROVED ${SHA}`, { username: 'OMP-BOT' })],
    { sha: SHA, bot: BOT },
  );
  assert.equal(m, null);
});

test('findApprovalComment: non-bot but wrong (stale) sha → null', () => {
  const stale = 'cafebabedeadbeefcafebabe1234567890abcdef99';
  const m = findApprovalComment([act('c5', T0, `[HUMAN] APPROVED ${stale}`)], { sha: SHA, bot: BOT });
  assert.equal(m, null);
});

test('findApprovalComment: bot=null degraded → tagged+sha counts, author-only does not', () => {
  const tagged = findApprovalComment([act('c6', T0, `[HUMAN] APPROVED ${SHA}`)], { sha: SHA, bot: null });
  assert.ok(tagged);
  const untagged = findApprovalComment([act('c7', T0, `looks fine ${SHA}`)], { sha: SHA, bot: null });
  assert.equal(untagged, null);
});

test('findApprovalComment: multiple approvals → earliest by date', () => {
  const m = findApprovalComment(
    [
      act('late', '2026-01-01T05:00:00.000Z', `[HUMAN] APPROVED ${SHA}`),
      act('early', '2026-01-01T01:00:00.000Z', `[HUMAN] ship ${SHA}`),
    ],
    { sha: SHA, bot: BOT },
  );
  assert.equal(m.commentId, 'early');
});

test('findApprovalComment: untagged comment without memberCreator → not counted (bot known)', () => {
  const m = findApprovalComment(
    [{ id: 'c8', date: T0, data: { text: `ok ${SHA}` }, memberCreator: null }],
    { sha: SHA, bot: BOT },
  );
  assert.equal(m, null);
});

// ---------------------------------------------------------------------------
// 6-10. approvalGate
// ---------------------------------------------------------------------------

test('approvalGate low tier: pass-through with ZERO board + git calls (criterion 2)', async () => {
  const clock = virtualClock();
  const res = await approvalGate({
    cardId: CARD,
    sha: SHA,
    tier: 'low',
    reasons: ['docs-only diff'],
    t: throwingTrello(),
    git: throwingGit,
    notify: async () => {
      throw new Error('no ping');
    },
    ...clock,
  });
  assert.equal(res.required, false);
  assert.equal(res.approved, true);
  assert.equal(res.tier, 'low');
  assert.equal(res.polls, 0);
});

test('approvalGate: existing sha-keyed approval → via existing-comment, zero addComment', async () => {
  const clock = virtualClock();
  const t = fakeGateTrello({
    comments: [[act('pre', '2025-12-31T23:00:00.000Z', `[HUMAN] APPROVED ${SHA}`)]],
  });
  const res = await approvalGate({
    cardId: CARD,
    sha: SHA,
    tier: 'high',
    reasons: ['always-human paths'],
    t,
    git: throwingGit,
    ...clock,
  });
  assert.equal(res.approved, true);
  assert.equal(res.required, true);
  assert.equal(res.via, 'existing-comment');
  assert.equal(t.calls.add.length, 0); // no [ASK] posted
});

test('approvalGate: no approval → ONE [ASK]+ping, human replies with sha → approved', async () => {
  const clock = virtualClock();
  const pings = [];
  const t = fakeGateTrello({
    comments: [
      [], // scan: nothing yet
      [], // poll 1: nothing yet
      [act('r1', '2026-01-01T00:00:01.000Z', `[HUMAN] APPROVED ${SHA}`)], // poll 2: the approval
    ],
  });
  const res = await approvalGate({
    cardId: CARD,
    sha: SHA,
    tier: 'medium',
    reasons: ['code diff with edits'],
    timeoutMs: 60_000,
    intervalMs: 1000,
    t,
    git: throwingGit,
    notify: async ({ text }) => {
      pings.push(text);
      return { sent: true };
    },
    ...clock,
  });
  assert.equal(res.approved, true);
  assert.equal(res.askCommentId, 'ask1');
  assert.equal(t.calls.add.length, 1); // exactly ONE ask post
  assert.match(t.calls.add[0].text, /^\[ASK\] Approval required \(risk tier medium: code diff with edits\)/);
  assert.match(t.calls.add[0].text, new RegExp(SHA, 'i'));
  assert.equal(pings.length, 1); // exactly one ping
  assert.match(pings[0], /Factory needs you/);
  assert.match(pings[0], new RegExp(SHA, 'i')); // ask question quoted into the ping
  assert.ok(res.polls >= 1);
  assert.ok(res.waitedMs >= 0 && res.waitedMs <= 60_000);
  assert.equal(res.discord?.sent, true);
});

test('approvalGate: wrong-sha reply skipped, ask NOT re-posted, later approval counts', async () => {
  const clock = virtualClock();
  const wrong = act('w1', '2026-01-01T00:00:01.000Z', '[HUMAN] looks great');
  const right = act('w2', '2026-01-01T00:00:02.000Z', `[HUMAN] APPROVED ${SHA}`);
  const t = fakeGateTrello({
    comments: [
      [], // scan
      [wrong], // poll 1: human reply WITHOUT the sha
      [wrong, right], // poll 2: the real approval
    ],
  });
  const res = await approvalGate({
    cardId: CARD,
    sha: SHA,
    tier: 'high',
    reasons: ['always-human paths'],
    timeoutMs: 60_000,
    intervalMs: 1000,
    t,
    git: throwingGit,
    notify: async () => ({ sent: true }),
    ...clock,
  });
  assert.equal(res.approved, true);
  assert.equal(t.calls.add.length, 1); // still ONE ask post — wrong-sha reply does not re-ask
  assert.match(res.reply.text, new RegExp(SHA)); // the accepted reply carries the sha
  assert.ok(Date.parse(res.reply.date) > Date.parse(wrong.date)); // window advanced past the wrong reply
});

// Regression (review finding #2): the wait-window floor must be the ask
// MOMENT, not the post-ping clock — `sinceIso = now()` captured after
// askHuman returned (post + getCard + Discord ping = seconds of latency)
// dropped same-second / latency-window approvals from every poll and burned
// the full timeout despite a valid approval on the board.

test('approvalGate: approval same-second as the ask (posted during ping latency) is matched, not floor-dropped', async () => {
  const clock = virtualClock(Date.parse('2026-01-01T00:00:05.700Z')); // ask fires mid-second :05
  const t = fakeGateTrello({
    comments: [
      [], // scan: nothing yet
      [
        act('ask1', '2026-01-01T00:00:05.000Z', '[ASK] Approval required (risk tier high)', BOT), // the ask itself (bot echo, same second)
        act('r1', '2026-01-01T00:00:05.000Z', `[HUMAN] APPROVED ${SHA}`), // approval in the ask's OWN second
      ],
    ],
  });
  const res = await approvalGate({
    cardId: CARD,
    sha: SHA,
    tier: 'high',
    reasons: ['always-human paths'],
    timeoutMs: 60_000,
    intervalMs: 1000,
    t,
    git: throwingGit,
    notify: async () => {
      await clock.sleep(4000); // Discord ping burns 4 s of clock before askHuman returns
      return { sent: true };
    },
    ...clock,
  });
  // Pre-fix the floor was now() after the ping (:09.700) → both comments were
  // date-filtered from every poll → timeout despite the valid approval.
  assert.equal(res.approved, true);
  assert.equal(res.timedOut, undefined);
  assert.equal(t.calls.add.length, 1); // one ask post; the bot echo never counts as approval
  assert.match(res.reply.text, new RegExp(SHA));
});

test('approvalGate: wrong-sha reply advances the floor past itself only — an approval dated before the ping returned still matches', async () => {
  const clock = virtualClock(Date.parse('2026-01-01T00:00:05.700Z'));
  const wrong = act('w1', '2026-01-01T00:00:06.000Z', '[HUMAN] APPROVED 1111111122222222333333334444444455555555'); // wrong sha, ping window
  const right = act('w2', '2026-01-01T00:00:07.000Z', `[HUMAN] APPROVED ${SHA}`); // still inside the ping window
  const t = fakeGateTrello({
    comments: [
      [], // scan
      [wrong], // poll 1: wrong-sha reply dated BEFORE the ping returned
      [wrong, right], // poll 2: the real approval — also dated before the ping returned
    ],
  });
  const res = await approvalGate({
    cardId: CARD,
    sha: SHA,
    tier: 'high',
    reasons: ['always-human paths'],
    timeoutMs: 60_000,
    intervalMs: 1000,
    t,
    git: throwingGit,
    notify: async () => {
      await clock.sleep(4000); // post-ping clock is :09.700 — past BOTH comment dates
      return { sent: true };
    },
    ...clock,
  });
  // The floor advances to the wrong reply's date + 1 ms — NOT to the clock at
  // discovery — so `right` (:07.000, before the ping returned) stays inside
  // the window. Pre-fix both comments sat below the post-ping floor → timeout.
  assert.equal(res.approved, true);
  assert.equal(t.calls.add.length, 1); // wrong-sha reply does not re-post the ask
  assert.match(res.reply.text, new RegExp(SHA));
  assert.equal(res.reply.date, '2026-01-01T00:00:07.000Z');
});

test('approvalGate: timeout → {approved:false, timedOut:true}, clock ≥ timeout, ONE ask', async () => {
  const clock = virtualClock();
  const t = fakeGateTrello({
    comments: [[act('n1', '2026-01-01T00:00:01.000Z', '[HUMAN] no sha here')]],
  });
  const res = await approvalGate({
    cardId: CARD,
    sha: SHA,
    tier: 'high',
    reasons: ['churn 999'],
    timeoutMs: 5000,
    intervalMs: 1000,
    t,
    git: throwingGit,
    notify: async () => ({ sent: true }),
    ...clock,
  });
  assert.equal(res.approved, false);
  assert.equal(res.timedOut, true);
  assert.equal(res.required, true);
  assert.ok(res.waitedMs >= 5000, `waitedMs ${res.waitedMs} ≥ 5000`);
  assert.equal(t.calls.add.length, 1);
});

test('approvalGate: tier auto-classified from git when not supplied (medium → gate runs)', async () => {
  const clock = virtualClock();
  const git = (argv) =>
    argv[0] === 'merge-base' ? 'base123\n' : '10\t5\tsrc/a.js\n';
  const t = fakeGateTrello({
    comments: [[act('auto', T0, `[HUMAN] APPROVED ${SHA}`)]],
  });
  const res = await approvalGate({
    cardId: CARD,
    sha: SHA,
    branch: 'factory/x',
    t,
    git,
    ...clock,
  });
  assert.equal(res.tier, 'medium');
  assert.equal(res.approved, true);
  assert.equal(t.calls.add.length, 0);
});

test('approvalAskText: tier, reasons, and sha (twice) present', () => {
  const text = approvalAskText({ tier: 'high', reasons: ['always-human paths: /^config\\//'], sha: SHA });
  assert.match(text, /risk tier high: always-human paths/);
  assert.equal((text.match(new RegExp(SHA, 'g')) ?? []).length, 2);
});

test('approvalTimeoutDefault: env chain FACTORY_APPROVAL_TIMEOUT_MS → ASK → 3600000', () => {
  const saved = { ...process.env };
  try {
    delete process.env.FACTORY_APPROVAL_TIMEOUT_MS;
    delete process.env.FACTORY_ASK_TIMEOUT_MS;
    assert.equal(approvalTimeoutDefault(), 3_600_000);
    process.env.FACTORY_ASK_TIMEOUT_MS = '123456';
    assert.equal(approvalTimeoutDefault(), 123456);
    process.env.FACTORY_APPROVAL_TIMEOUT_MS = '999999';
    assert.equal(approvalTimeoutDefault(), 999999);
  } finally {
    process.env = saved;
  }
});

// ---------------------------------------------------------------------------
// 11. CLI wiring via spawnSync — usage paths die BEFORE any network call.
// ---------------------------------------------------------------------------

const runCli = (...argv) =>
  spawnSync(process.execPath, [FACTORY_JS, ...argv], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

test('CLI help lists risk and approve', () => {
  const r = runCli('help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\s+risk <branch>/m);
  assert.match(r.stdout, /^\s+approve <card> <sha>/m);
});

test('CLI approve without sha → exit 1 usage before any network', () => {
  const r = runCli('approve', CARD);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: factory\.js approve/);
});

test('CLI approve with malformed sha → exit 1 usage', () => {
  const r = runCli('approve', CARD, 'zzzzz');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /7-40 hex/);
});

test('CLI risk with unresolvable refs → exit 1 (git failure) before any board call', () => {
  const r = runCli('risk', 'no-such-branch-xyz', 'no-such-target-xyz');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /risk diff failed/);
});

// ---------------------------------------------------------------------------
// 12. package.json allowlist — the new test MUST run under npm test.
// ---------------------------------------------------------------------------

test('package.json test script runs factoryRisk.test.js via node --test AND excludes it from jest', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const testScript = pkg.scripts.test;
  assert.match(testScript, /node --test [^&]*tests\/factoryRisk\.test\.js/);
  assert.ok(
    testScript.includes("'tests/factoryRisk.test.js'"),
    'jest --testPathIgnorePatterns allowlist must include tests/factoryRisk.test.js',
  );
});
