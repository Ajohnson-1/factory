/**
 * Unit tests for scripts/lib/factory-context.js (curated per-stage context;
 * card 6ae9676f16ee4be03420c2e6; docs/factory.md "Per-stage context").
 *
 * Zero live Trello: `curateStageContext` is pure and `getContext` runs
 * against an injected fake client. Process-level CLI tests spawn
 * scripts/factory.js only on paths that die BEFORE network (missing/unknown
 * stage, help) — the factoryProdClose.test.js precedent. The core claim of
 * the card — resolved bounce verdicts collapse to one digest line each and
 * their stale bodies/JSON NEVER re-enter a stage payload — is proved by
 * test 2's JSON.stringify grep.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  CONTEXT_STAGES,
  BOUNCE_TAGS,
  curateStageContext,
  getContext,
} from '../scripts/lib/factory-context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');
const CARD_ID = 'a1b2c3d4e5f60718293a4b5c';

const BOT = { id: 'bot-1', username: 'factorybot', fullName: 'Factory Bot' };
const HUMAN = { id: 'hum-1', username: 'andrew', fullName: 'Andrew' };

const CARD = {
  id: CARD_ID,
  name: 'C-M3 — Curate per-stage context',
  desc: 'REQUIREMENTS — acceptance criteria live here (description is the requirements).',
  url: `https://trello.com/c/${CARD_ID}`,
};

// Comment factory: trello.js getCardComments item shape.
const day = (n) => new Date(Date.UTC(2026, 10, n)).toISOString();
const mk = (n, text, member = BOT) => ({
  id: `c-${n}`,
  date: day(n),
  data: { text },
  memberCreator: member,
});

// Long verdict body: the distinctive marker sits past the 140-char digest
// excerpt window, so a digest line can never leak it.
const body = (tag, marker) =>
  `${tag} itemized findings follow — ${'padding '.repeat(40)}${marker}`;

const cur = (comments, stage, extra = {}) =>
  curateStageContext({ card: CARD, comments, stage, bot: BOT, ...extra });

// Rule-7 completeness accounting: every comment maps to exactly one slot;
// aggregated bookkeeping lines carry ×N counters.
function coveredCount(result) {
  let covered = result.live.length + (result.human.ask ? 1 : 0) + (result.human.reply ? 1 : 0);
  for (const key of Object.keys(result.latest)) if (result.latest[key]) covered += 1;
  for (const line of result.digest) {
    const m = line.match(/×(\d+)/);
    covered += m ? Number(m[1]) : 1;
  }
  return covered;
}

// ---------- shape + stage taxonomy ----------

test('1. fresh card (zero comments): every stage returns description + empty slots', () => {
  for (const stage of CONTEXT_STAGES) {
    const r = cur([], stage);
    assert.equal(r.stage, stage);
    assert.deepEqual(r.card, { id: CARD_ID, name: CARD.name, url: CARD.url });
    assert.equal(r.description, CARD.desc);
    assert.deepEqual(r.live, []);
    assert.deepEqual(r.digest, []);
    assert.deepEqual(r.human, { ask: null, reply: null });
    assert.deepEqual(r.counts, { impls: 0, bounces: 0, crashes: 0 });
    for (const key of ['plan', 'impl', 'reviewApprove', 'secPass', 'qaPass', 'deploy', 'verify', 'rollback']) {
      assert.equal(r.latest[key], null, `latest.${key} must be null on a fresh card`);
    }
    assert.match(r.note, new RegExp(`factory\\.js read ${CARD_ID}`));
  }
});

// ---------- the core claim: resolved-verdict suppression ----------

test('2. resolved bounce verdicts collapse to digest lines; bodies NEVER re-enter the payload', () => {
  const trail = [
    mk(1, '[IMPL] first attempt ' + body('[IMPL]', 'IMPL1-MARKER')),
    mk(2, body('[REVIEW:CHANGES]', 'REVIEW-STALE-MARKER')),
    mk(3, '[IMPL] second attempt ' + body('[IMPL]', 'IMPL2-MARKER')),
    mk(4, body('[QA:FAIL]', 'QAFAIL-STALE-MARKER')),
    mk(5, '[IMPL] third attempt ' + body('[IMPL]', 'IMPL3-MARKER')),
  ];
  const r = cur(trail, 'implement');
  assert.deepEqual(r.live, [], 'both verdicts predate the latest [IMPL] — nothing is live');
  const resolved = r.digest.filter((l) => l.endsWith('(resolved)') && !l.startsWith('[IMPL]'));
  assert.equal(resolved.length, 2, `exactly two resolved-verdict lines: ${JSON.stringify(r.digest)}`);
  assert.ok(resolved.some((l) => /^\[REVIEW:CHANGES\] 2026-11-02 — /.test(l)));
  assert.ok(resolved.some((l) => /^\[QA:FAIL\] 2026-11-04 — /.test(l)));
  assert.ok(r.digest.some((l) => /^\[IMPL\] \S+ ×2 — superseded by latest \[IMPL\]$/.test(l)));
  assert.deepEqual(r.counts, { impls: 3, bounces: 2, crashes: 0 });
  const dumped = JSON.stringify(r);
  for (const stale of ['REVIEW-STALE-MARKER', 'QAFAIL-STALE-MARKER']) {
    assert.ok(!dumped.includes(stale), `stale verdict body leaked: ${stale}`);
  }
});

// ---------- live findings: full text + cap ----------

test('3. live finding after the latest [IMPL]: full text; maxChars caps with the read pointer', () => {
  const findings = body('[REVIEW:CHANGES]', 'REVIEW-LIVE-MARKER');
  const trail = [mk(1, '[IMPL] attempt'), mk(2, findings)];
  const r = cur(trail, 'implement');
  assert.equal(r.live.length, 1);
  assert.equal(r.live[0].tag, '[REVIEW:CHANGES]');
  assert.equal(r.live[0].date, day(2));
  assert.equal(r.live[0].author, BOT.fullName);
  assert.equal(r.live[0].text, findings, 'under the cap the FULL verdict text rides');
  const capped = cur(trail, 'implement', { maxChars: 100 });
  assert.ok(capped.live[0].text.startsWith(findings.slice(0, 100)));
  assert.ok(
    capped.live[0].text.includes(`…[truncated ${findings.length - 100} chars — full text: factory.js read ${CARD_ID}]`),
    `truncation marker missing: ${capped.live[0].text.slice(-80)}`,
  );
});

test('4. supersede boundary: the latest [IMPL] itself is never live; newer verdicts are; no [IMPL] ⇒ nothing superseded', () => {
  const trail = [mk(1, '[IMPL] the pointer itself'), mk(2, '[QA:FAIL] live finding')];
  const r = cur(trail, 'implement');
  assert.deepEqual(r.live.map((l) => l.tag), ['[QA:FAIL]']);
  assert.ok(r.latest.impl, 'the latest [IMPL] is a pointer, not a live entry');
  assert.equal(r.latest.impl.date, day(1));
  const fresh = cur([mk(1, '[PLAN] plan'), mk(2, '[REVIEW:CHANGES] early bounce')], 'implement');
  assert.deepEqual(fresh.live.map((l) => l.tag), ['[REVIEW:CHANGES]'], 'with no [IMPL] nothing is superseded');
});

// ---------- per-stage filtering ----------

test('5. review gets the FULL latest [IMPL] evidence; qa sees stale gates as null + digest', () => {
  const implEvidence = body('[IMPL]', 'IMPL-EVIDENCE-MARKER');
  const trail = [
    mk(1, '[PLAN] ' + body('[PLAN]', 'PLAN-BODY-MARKER')),
    mk(2, '[REVIEW:CHANGES] ' + 'stale. '.repeat(40) + 'REVIEW-STALE-MARKER'),
    mk(3, implEvidence),
  ];
  const review = cur(trail, 'review');
  assert.equal(review.latest.impl.text, implEvidence, 'review consumes the full [IMPL] body');
  assert.ok(review.latest.impl.excerpt);
  assert.deepEqual(review.live, [], 'review verdicts land ON the latest [IMPL] — live is implement-only');
  const dumped = JSON.stringify(review);
  assert.ok(!dumped.includes('PLAN-BODY-MARKER') && !dumped.includes('REVIEW-STALE-MARKER'));
  // QA gate freshness: approvals BEFORE the latest [IMPL] are stale.
  const gates = [
    mk(1, '[IMPL] v1'),
    mk(2, '[REVIEW:APPROVE] ok v1'),
    mk(3, '[SEC:PASS] clean v1'),
    mk(4, '[IMPL] v2 — approvals now stale'),
  ];
  const qaStale = cur(gates, 'qa');
  assert.equal(qaStale.latest.reviewApprove, null);
  assert.equal(qaStale.latest.secPass, null);
  assert.ok(qaStale.digest.some((l) => /^\[REVIEW:APPROVE\] .+ \(resolved\)$/.test(l)));
  assert.ok(qaStale.digest.some((l) => /^\[SEC:PASS\] .+ \(resolved\)$/.test(l)));
  assert.ok(qaStale.latest.impl, 'the latest [IMPL] pointer stays available to QA');
  const fresh = cur([...gates, mk(5, '[REVIEW:APPROVE] ok v2'), mk(6, '[SEC:PASS] clean v2')], 'qa');
  assert.equal(fresh.latest.reviewApprove.date, day(5));
  assert.equal(fresh.latest.secPass.date, day(6));
});

test('8. stage taxonomy: exact lists, case-insensitive match, unknown throws the valid list; live is implement-only', () => {
  assert.deepEqual(CONTEXT_STAGES, ['plan', 'implement', 'review', 'security', 'qa', 'deploy', 'verify']);
  assert.deepEqual(BOUNCE_TAGS, ['[REVIEW:CHANGES]', '[SEC:FINDINGS]', '[QA:FAIL]', '[CHECK:FAIL]', '[VERIFY:FAIL]']);
  assert.throws(
    () => cur([mk(1, '[IMPL] x')], 'testing'),
    /Unknown stage "testing" — valid stages: plan implement review security qa deploy verify/,
  );
  assert.equal(cur([], 'Implement').stage, 'implement', 'stage is case-insensitive');
  const trail = [mk(1, '[IMPL] a'), mk(2, '[QA:FAIL] live now'), mk(3, '[VERIFY:FAIL] {"json":true} live too')];
  assert.equal(cur(trail, 'implement').live.length, 2);
  assert.deepEqual(cur(trail, 'review').live, []);
  assert.deepEqual(cur(trail, 'qa').live, []);
});

test('8b. gate verdicts: [CHECK:FAIL] bounces exactly like [VERIFY:FAIL]; [CHECK:PASS] is digest-only', () => {
  // Newer than the latest [IMPL]: full text live for implement, counted in
  // counts.bounces, and never a latest.* pointer for any stage.
  const live = [mk(1, '[IMPL] v1'), mk(2, '[CHECK:FAIL] npm test exit 1 — tail: fail 2'), mk(3, '[CHECK:PASS] all 1 blocking checks green')];
  const impl = cur(live, 'implement');
  assert.deepEqual(impl.live.map((e) => e.tag), ['[CHECK:FAIL]']);
  assert.match(impl.live[0].text, /npm test exit 1/);
  assert.deepEqual(impl.counts, { impls: 1, bounces: 1, crashes: 0 });
  assert.ok(impl.digest.some((l) => /^\[CHECK:PASS\] .+ ×1 \(resolved\)$/.test(l)), 'the PASS is a bookkeeping digest line');
  assert.ok(
    cur(live, 'review').digest.some((l) => /^\[CHECK:FAIL\] .+ \(live for implement\)$/.test(l)),
    'other stages see a pointer line, not the body',
  );
  assert.deepEqual(cur(live, 'qa').live, []);
  const checkDates = [day(2), day(3)];
  for (const stage of CONTEXT_STAGES) {
    for (const v of Object.values(cur(live, stage).latest)) {
      assert.ok(!v || !checkDates.includes(v.date), `stage ${stage}: CHECK tags never become pointers`);
    }
  }
  // Superseded by a newer [IMPL]: resolved digest line, never live again.
  const fixed = [...live, mk(4, '[IMPL] v2')];
  const after = cur(fixed, 'implement');
  assert.deepEqual(after.live, []);
  assert.ok(after.digest.some((l) => /^\[CHECK:FAIL\] .+ \(resolved\)$/.test(l)));
  assert.equal(after.counts.bounces, 1);
});

// ---------- human channel ----------

test('6. human channel: [ASK] + [HUMAN] reply; pre-ask replies excluded; bot=null degrades to tag-only', () => {
  const trail = [
    mk(1, '[IMPL] running'),
    mk(2, '[HUMAN] premature answer', HUMAN),
    mk(3, '[ASK] which flag?', BOT),
    mk(4, '[HUMAN] the --flag one', HUMAN),
  ];
  const r = cur(trail, 'implement');
  assert.equal(r.human.ask.date, day(3));
  assert.match(r.human.ask.excerpt, /which flag/);
  assert.equal(r.human.reply.date, day(4));
  assert.match(r.human.reply.text, /--flag one/);
  assert.ok(r.digest.some((l) => /^\[HUMAN\] 2026-11-02 — .+ \(pre-ask\)$/.test(l)), 'the premature answer stays in the digest');
  // Author-based pending answer (no [HUMAN] tag): visible only with bot identity.
  const pending = [mk(1, '[DEPLOY] sha=abc', BOT), mk(2, 'unanswered question from the human', HUMAN)];
  assert.match(cur(pending, 'implement').human.reply.text, /unanswered question/);
  assert.equal(cur(pending, 'implement', { bot: null }).human.reply, null, 'degraded mode is tag-only');
  const tagged = [mk(1, '[ASK] q', BOT), mk(2, '[HUMAN] a', HUMAN)];
  assert.match(cur(tagged, 'plan', { bot: null }).human.reply.text, /a$/, 'tag fast path works without identity');
});

// ---------- order defense ----------

test('7. shuffled input ⇒ identical output (internal date sort)', () => {
  const trail = [
    mk(1, '[PLAN] p'), mk(2, '[IMPL] i1'), mk(3, '[REVIEW:CHANGES] f'), mk(4, '[IMPL] i2'),
    mk(5, '[DEPLOY] sha=1'), mk(6, '[DAEMON-CRASH] died'), mk(7, '[ASK] q', HUMAN), mk(8, 'answer', HUMAN),
  ];
  const a = cur(trail, 'implement');
  const b = cur([...trail].reverse(), 'implement');
  assert.deepEqual(a, b);
  const c = cur(trail, 'implement', { bot: null });
  assert.deepEqual(JSON.stringify(a) !== JSON.stringify(c), true, 'bot identity changes human detection');
});

// ---------- completeness invariant ----------

test('9. every comment maps to exactly one output slot (rule 7, all stages)', () => {
  const trail = [
    mk(1, '[PLAN] plan'),
    mk(2, '[IMPL] v1'),
    mk(3, '[REVIEW:APPROVE] stale ok'),
    mk(4, '[SEC:FINDINGS] stale finding'),
    mk(5, '[IMPL] v2'),
    mk(6, '[REVIEW:CHANGES] live finding'),
    mk(7, '[SEC:PASS] fresh pass'),
    mk(8, '[QA:FAIL] live fail'),
    mk(9, '[IMPL] v3'),
    mk(10, '[DEPLOY] sha=deadbeef'),
    mk(11, '[VERIFY:FAIL] {"json":true}'),
    mk(12, '[ROLLBACK] restored last known-good'),
    mk(13, '[RESUME] ack'),
    mk(14, '[DAEMON-CRASH] run died'),
    mk(15, '[PROD-CLOSE] layer=qa'),
    mk(16, '[ASK] parked?', BOT),
    mk(17, 'just human chatter', HUMAN),
  ];
  for (const stage of CONTEXT_STAGES) {
    const r = cur(trail, stage);
    assert.equal(coveredCount(r), trail.length, `stage ${stage} lost or double-counted a comment`);
  }
});

// ---------- bookkeeping digest ----------

test('10. bookkeeping tags collapse to digest lines + counts, never full bodies', () => {
  const trail = [
    mk(1, '[IMPL] v1'),
    mk(2, '[DAEMON-CRASH] ' + 'crash. '.repeat(40) + 'CRASH-MARKER-1'),
    mk(3, '[DAEMON-CRASH] ' + 'crash. '.repeat(40) + 'CRASH-MARKER-2'),
    mk(4, '[ROLLBACK] ' + 'rb. '.repeat(50) + 'ROLLBACK-MARKER'),
    mk(5, '[DEPLOY] ' + 'dep. '.repeat(50) + 'DEPLOY-MARKER'),
    mk(6, '[VERIFY:PASS] ' + 'vp. '.repeat(50) + 'VPASS-MARKER'),
  ];
  const r = cur(trail, 'implement');
  assert.equal(r.counts.crashes, 2);
  assert.ok(r.digest.includes('[DAEMON-CRASH] 2026-11-02 ×1 (resolved)'));
  assert.ok(r.digest.includes('[DAEMON-CRASH] 2026-11-03 ×1 (resolved)'));
  const dumped = JSON.stringify(r);
  for (const m of ['CRASH-MARKER-1', 'CRASH-MARKER-2', 'ROLLBACK-MARKER', 'DEPLOY-MARKER', 'VPASS-MARKER']) {
    assert.ok(!dumped.includes(m), `bookkeeping body leaked: ${m}`);
  }
});

// ---------- getContext IO wrapper ----------

test('11. getContext: fake client resolves; getMe rejection fails OPEN to bot=null', async () => {
  const comments = [
    mk(4, 'unanswered human question', HUMAN),
    mk(3, '[DEPLOY] sha=abc', BOT),
  ]; // newest-first, the live Trello order
  const fake = ({ failMe = false } = {}) => ({
    calls: [],
    async getCard(id) {
      this.calls.push(['getCard', id]);
      return CARD;
    },
    async getCardComments(id) {
      this.calls.push(['getCardComments', id]);
      return comments;
    },
    async getMe() {
      this.calls.push(['getMe']);
      if (failMe) throw new Error('trello 500');
      return BOT;
    },
  });
  const t = fake();
  const r = await getContext({ card: CARD_ID, stage: 'implement', t });
  assert.deepEqual(t.calls.map((c) => c[0]).sort(), ['getCard', 'getCardComments', 'getMe']);
  assert.equal(r.stage, 'implement');
  assert.match(r.human.reply.text, /unanswered human question/, 'author-based reply with identity');
  const t2 = fake({ failMe: true });
  const degraded = await getContext({ card: CARD_ID, stage: 'implement', t: t2 });
  assert.equal(degraded.human.reply, null, 'identity failure degrades to tag-only, never throws');
  assert.equal(degraded.latest.impl === null, true);
});

// ---------- CLI wiring (paths that die BEFORE network) ----------

test('12. CLI context: missing stage → usage exit 1; unknown stage → valid list exit 1; help lists context', () => {
  const missing = spawnSync(process.execPath, [FACTORY_JS, 'context', CARD_ID], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Usage: factory\.js context <card> <stage>/);
  assert.match(missing.stderr, /plan implement review security qa deploy verify/);
  const unknown = spawnSync(process.execPath, [FACTORY_JS, 'context', CARD_ID, 'testing'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown stage "testing"/);
  assert.match(unknown.stderr, /valid stages: plan implement review security qa deploy verify/);
  const badId = spawnSync(process.execPath, [FACTORY_JS, 'context', 'not-a-card', 'qa'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(badId.status, 1);
  assert.match(badId.stderr, /Not a Trello card id or URL/);
  const help = spawnSync(process.execPath, [FACTORY_JS, 'help'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /context <card> <stage> \[--max-chars <n>\]/);
});
