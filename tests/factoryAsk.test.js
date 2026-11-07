/**
 * Unit tests for scripts/lib/factory-ask.js + scripts/factory.js ask/wait wiring
 * (card 6ae736ef0f4a495c1122d2fe; docs/factory.md "Asking a human").
 * (card 6ae78bed752438bdf6f1f23d: author-based human reply detection — any
 * non-bot-authored comment after the ask counts; [HUMAN] tag = optional fast-path.)
 *
 * Zero live Trello/Discord: every dep is injected — fake trello client (canned
 * comment sequences), fake notify (records text), fake sleep/now (virtual clock),
 * fake fetchImpl (records requests, returns canned responses). The only
 * process-level tests spawn the CLI on paths that die before any network call.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

import {
  askHuman,
  waitForHuman,
  extractHumanReply,
  sendOwnerPing,
  parseFlags,
} from '../scripts/lib/factory-ask.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');
const CARD = 'a'.repeat(24);

const NOW = '2026-01-01T00:00:02.000Z';
const BOT = { id: 'bot1', username: 'omp-bot' };
const c = (id, date, text, name = 'Andrew', member = { id: 'member-1', username: 'stirmmy' }) => ({
  id,
  date,
  data: { text },
  memberCreator: { id: member.id, username: member.username, fullName: name },
});

/** Virtual-clock sleep/now pair: sleep advances the clock; now reads it. */
function virtualClock(startMs = Date.parse(NOW)) {
  let ms = startMs;
  return {
    now: () => new Date(ms).toISOString(),
    sleep: async (d) => {
      ms += d;
    },
    advance: (d) => {
      ms += d;
    },
  };
}

/** Fake trello client. comments = seq of arrays (last sticks); records calls.
 * me/meThrows/meSeq drive getMe: constant identity / always-failing / a
 * sequence of throw-or-return entries (last sticks). */
function fakeTrello({
  comments = [],
  addResult = { id: 'ask1' },
  card = undefined,
  addThrows,
  me = BOT,
  meThrows = null,
  meSeq = null,
} = {}) {
  const seq = [...comments];
  const calls = { add: [], getComments: 0, getCard: 0, getMe: 0 };
  return {
    calls,
    async addComment(cardId, text) {
      calls.add.push({ cardId, text });
      if (addThrows) throw addThrows;
      return addResult;
    },
    async getCardComments() {
      calls.getComments += 1;
      return seq.length > 1 ? seq.shift() : seq[0] ?? [];
    },
    async getMe() {
      calls.getMe += 1;
      if (meThrows) throw meThrows;
      if (meSeq?.length) {
        const next = meSeq.length > 1 ? meSeq.shift() : meSeq[0];
        if (next instanceof Error) throw next;
        return next;
      }
      return me;
    },
    async getCard() {
      calls.getCard += 1;
      if (card === undefined) return { id: CARD, name: 'Test card', url: 'https://trello.com/c/x/test' };
      if (card instanceof Error) throw card;
      return card;
    },
  };
}

// 1. ask happy path: posts [ASK], pings once, polls until reply, returns it.
test('1. askHuman happy path posts [ASK], pings, waits, returns the [HUMAN] reply', async () => {
  const askComment = c('ask1', NOW, '[ASK] Which color?');
  const t = fakeTrello({
    comments: [[askComment], [askComment, c('r1', '2026-01-01T00:00:10.000Z', '[HUMAN] blue')]],
    addResult: { id: 'ask1', date: NOW },
  });
  const pings = [];
  const res = await askHuman({
    cardId: CARD,
    question: 'Which color?',
    intervalMs: 1000,
    t,
    notify: async ({ text }) => {
      pings.push(text);
      return { sent: true };
    },
    sleep: async () => {},
    now: () => NOW,
  });
  assert.equal(t.calls.add.length, 1);
  assert.equal(t.calls.add[0].cardId, CARD);
  assert.ok(t.calls.add[0].text.startsWith('[ASK] '));
  assert.ok(t.calls.add[0].text.includes('Which color?'));
  assert.equal(pings.length, 1);
  assert.ok(pings[0].includes('Which color?'));
  assert.ok(pings[0].includes('https://trello.com/c/x/test'));
  assert.equal(res.card, CARD);
  assert.equal(res.asked, true);
  assert.equal(res.askCommentId, 'ask1');
  assert.deepEqual(res.discord, { sent: true });
  assert.equal(res.replied, true);
  assert.equal(res.reply.text, '[HUMAN] blue');
  assert.equal(res.reply.author, 'Andrew');
  assert.ok(res.polls >= 2, 'polls until the reply shows up');
});

test('1b. an already-tagged question is not double-prefixed', async () => {
  const askComment = c('ask1', NOW, '[ASK] tagged already');
  const t = fakeTrello({
    comments: [[askComment, c('r1', '2026-01-01T00:00:09.000Z', '[HUMAN] ok')]],
    addResult: { id: 'ask1', date: NOW },
  });
  const res = await askHuman({
    cardId: CARD,
    question: '[ASK] tagged already',
    t,
    notify: async () => ({ sent: true }),
    sleep: async () => {},
    now: () => NOW,
  });
  assert.equal(t.calls.add[0].text, '[ASK] tagged already');
  assert.equal(res.replied, true);
});

// 1c. author-based detection end-to-end: an UNTAGGED comment by a non-bot member answers the ask.
test('1c. askHuman accepts an untagged reply authored by a human (no [HUMAN] tag needed)', async () => {
  const askComment = c('ask1', NOW, '[ASK] Which color?', 'OMP BOT', BOT);
  const t = fakeTrello({
    comments: [[askComment], [askComment, c('r1', '2026-01-01T00:00:10.000Z', 'blue')]],
    addResult: { id: 'ask1', date: NOW },
  });
  const pings = [];
  const res = await askHuman({
    cardId: CARD,
    question: 'Which color?',
    intervalMs: 1000,
    t,
    notify: async ({ text }) => {
      pings.push(text);
      return { sent: true };
    },
    sleep: async () => {},
    now: () => NOW,
  });
  assert.ok(pings[0].includes('Which color?'));
  assert.ok(pings[0].includes('https://trello.com/c/x/test'));
  assert.ok(!pings[0].includes('[HUMAN]'), 'ping no longer instructs a required [HUMAN] tag');
  assert.equal(res.replied, true);
  assert.equal(res.reply.text, 'blue');
  assert.equal(res.reply.via, 'author');
});

// 1d. identity lookup failure → FAIL-CLOSED: tag-only until a retry succeeds.
test('1d. fail-closed while bot identity unresolved; [HUMAN] fast-path survives; retry self-heals', async () => {
  const askComment = c('ask1', NOW, '[ASK] q', 'OMP BOT', BOT);
  const humanUntagged = c('r1', '2026-01-01T00:00:10.000Z', 'blue');
  const tagged = c('r2', '2026-01-01T00:00:10.000Z', '[HUMAN] blue');

  // (a) getMe always throws + only untagged-human comments → timeout (fail-CLOSED).
  {
    const clock = virtualClock();
    const t = fakeTrello({
      comments: [[askComment, humanUntagged]],
      addResult: { id: 'ask1', date: clock.now() },
      meThrows: new Error('Trello GET /members/me/all -> 401'),
    });
    const res = await askHuman({
      cardId: CARD,
      question: 'q',
      timeoutMs: 5000,
      intervalMs: 1000,
      t,
      notify: async () => ({ sent: true }),
      sleep: clock.sleep,
      now: clock.now,
    });
    assert.equal(res.replied, false);
    assert.equal(res.timedOut, true);
    assert.ok(t.calls.getMe >= res.polls, 'one identity attempt per unresolved poll');
  }

  // (b) getMe throws + a TAGGED reply → still answered (fast-path in degraded mode).
  {
    const t = fakeTrello({
      comments: [[askComment, tagged]],
      addResult: { id: 'ask1', date: NOW },
      meThrows: new Error('401'),
    });
    const res = await askHuman({
      cardId: CARD,
      question: 'q',
      t,
      notify: async () => ({ sent: true }),
      sleep: async () => {},
      now: () => NOW,
    });
    assert.equal(res.replied, true);
    assert.equal(res.reply.text, '[HUMAN] blue');
    assert.equal(res.reply.via, 'tag');
  }

  // (c) throw-then-succeed: retry every poll until success, then cache for the run.
  {
    const t = fakeTrello({
      comments: [[askComment], [askComment, humanUntagged]],
      addResult: { id: 'ask1', date: NOW },
      meSeq: [new Error('network down'), BOT],
    });
    const res = await askHuman({
      cardId: CARD,
      question: 'q',
      intervalMs: 1000,
      t,
      notify: async () => ({ sent: true }),
      sleep: async () => {},
      now: () => NOW,
    });
    assert.equal(res.replied, true);
    assert.equal(res.reply.via, 'author');
    assert.equal(res.polls, 2);
    assert.equal(t.calls.getMe, 2, 'one attempt per poll until resolved (cached after success)');
    assert.equal(t.calls.getComments, res.polls);
  }
});

// 2. reply selection: earliest post-ask [HUMAN] wins; stale/untagged/self excluded.
test('2. extractHumanReply picks the earliest post-ask [HUMAN], ignores stale/untagged/self', () => {
  const actions = [
    c('a', '2026-01-01T00:00:00.000Z', '[HUMAN] stale, before the ask'), // (a) pre-existing
    c('b', '2026-01-01T00:00:05.000Z', 'plain comment, no tag'), // (b) untagged
    c('ask1', '2026-01-01T00:00:02.000Z', '[ASK] the question'),
    c('ask1h', '2026-01-01T00:00:02.000Z', '[HUMAN] same-second other id'), // same-second: INCLUDED
    c('c', '2026-01-01T00:00:04.000Z', '[HUMAN] second reply'),
    c('d', '2026-01-01T00:00:03.000Z', '[hUman] earliest reply'), // case-insensitive tag
  ];
  const reply = extractHumanReply(actions, {
    sinceDate: '2026-01-01T00:00:02.000Z',
    excludeCommentId: 'ask1h', // pretend ask1h IS the ask comment's id → excluded
  });
  assert.equal(reply.text, '[hUman] earliest reply'); // (a) and (b) ignored; earliest post-ask wins
  assert.equal(reply.date, '2026-01-01T00:00:03.000Z');
  assert.equal(reply.author, 'Andrew');

  // Same-second comment with a DIFFERENT id than the ask comment is picked…
  const r2 = extractHumanReply(actions, { sinceDate: '2026-01-01T00:00:02.000Z', excludeCommentId: 'ask1' });
  assert.equal(r2.text, '[HUMAN] same-second other id');
  // …while the ask comment's own id is always excluded.
  const selfExcluded = [
    ...actions,
    c('ask9', '2026-01-01T00:00:01.000Z', '[ASK] q'),
    c('ask9', '2026-01-01T00:00:06.000Z', '[HUMAN] impossible self-tag'),
  ];
  const r3 = extractHumanReply(selfExcluded, { sinceDate: '2026-01-01T00:00:01.000Z', excludeCommentId: 'ask9' });
  assert.equal(r3.text, '[HUMAN] same-second other id'); // not the self-tagged comment
  assert.equal(extractHumanReply([], { sinceDate: NOW }), null);
  assert.equal(extractHumanReply(undefined), null);
});

// 2b. author mode (pure): non-bot authors qualify untagged; bot-authored NEVER; earliest across paths.
test('2b. extractHumanReply author mode: non-bot authors accepted, bot-authored never, earliest across tag/author', () => {
  const since = '2026-01-01T00:00:02.000Z';

  // Untagged post-ask human comment ACCEPTED via author.
  const r1 = extractHumanReply([c('h1', '2026-01-01T00:00:05.000Z', 'plain answer')], {
    sinceDate: since,
    bot: BOT,
  });
  assert.equal(r1.text, 'plain answer');
  assert.equal(r1.via, 'author');

  // Bot-authored untagged comments REJECTED even when dated LATER and with a
  // different id than excludeCommentId ([ASK] echo / stage comments).
  const r2 = extractHumanReply(
    [
      c('h1', '2026-01-01T00:00:05.000Z', 'human answer'),
      c('ask9', '2026-01-01T00:00:06.000Z', '[ASK] the question', 'OMP BOT', BOT),
      c('plan', '2026-01-01T00:00:07.000Z', '[PLAN] committed', 'OMP BOT', BOT),
    ],
    { sinceDate: since, excludeCommentId: 'ask1', bot: BOT },
  );
  assert.equal(r2.text, 'human answer');
  assert.equal(
    extractHumanReply([c('plan', '2026-01-01T00:00:07.000Z', '[PLAN] done', 'OMP BOT', BOT)], {
      sinceDate: since,
      bot: BOT,
    }),
    null,
  );

  // Username fallback matches case-insensitively when neither side has an id.
  assert.equal(
    extractHumanReply(
      [c('h1', '2026-01-01T00:00:05.000Z', 'answer', 'OMP BOT', { username: 'omp-bot' })],
      { sinceDate: since, bot: { username: 'OMP-Bot' } },
    ),
    null,
  );
  // Username fallback ACCEPTS a different username.
  const ru = extractHumanReply(
    [c('h1', '2026-01-01T00:00:05.000Z', 'answer', 'Andrew', { username: 'stirmmy' })],
    { sinceDate: since, bot: { username: 'omp-bot' } },
  );
  assert.equal(ru.via, 'author');

  // Earliest rule mixes paths: earlier untagged-human beats later tagged…
  const m1 = extractHumanReply(
    [
      c('x', '2026-01-01T00:00:06.000Z', '[HUMAN] later tagged'),
      c('y', '2026-01-01T00:00:04.000Z', 'earlier untagged'),
    ],
    { sinceDate: since, bot: BOT },
  );
  assert.equal(m1.text, 'earlier untagged');
  assert.equal(m1.via, 'author');
  // …and earlier tagged beats later untagged-human.
  const m2 = extractHumanReply(
    [
      c('y', '2026-01-01T00:00:04.000Z', '[HUMAN] earlier tagged'),
      c('x', '2026-01-01T00:00:06.000Z', 'later untagged'),
    ],
    { sinceDate: since, bot: BOT },
  );
  assert.equal(m2.text, '[HUMAN] earlier tagged');
  assert.equal(m2.via, 'tag');

  // Tagged comment from an unknown-but-non-bot author accepted via tag (fast-path is author-agnostic).
  const stranger = extractHumanReply(
    [
      c('z', '2026-01-01T00:00:05.000Z', '[HUMAN] from a stranger', 'Stranger', {
        id: 'other',
        username: 'someone-else',
      }),
    ],
    { sinceDate: since, bot: BOT },
  );
  assert.equal(stranger.via, 'tag');

  // memberCreator-less untagged comment rejected even with bot known (fail-closed).
  assert.equal(
    extractHumanReply([{ id: 'n', date: '2026-01-01T00:00:05.000Z', data: { text: 'no creator' } }], {
      sinceDate: since,
      bot: BOT,
    }),
    null,
  );

  // Degraded mode (bot null/unknown): untagged never qualifies regardless of author.
  assert.equal(
    extractHumanReply([c('h1', '2026-01-01T00:00:05.000Z', 'plain answer')], { sinceDate: since, bot: null }),
    null,
  );
});

// 3. notify failure tolerated: ping errors recorded, never thrown.
test('3. notify failure (resolved error AND rejection) never blocks the wait', async () => {
  const withReply = [c('ask1', NOW, '[ASK] q'), c('r1', '2026-01-01T00:00:04.000Z', '[HUMAN] yes')];
  for (const notify of [async () => ({ error: '403' }), async () => {
    throw new Error('boom');
  }]) {
    const t = fakeTrello({ comments: [withReply], addResult: { id: 'ask1', date: NOW } });
    const res = await askHuman({ cardId: CARD, question: 'q', t, notify, sleep: async () => {}, now: () => NOW });
    assert.equal(res.replied, true);
    assert.ok(typeof res.discord.error === 'string' && res.discord.error.length > 0);
    assert.ok(res.polls >= 1);
  }
});

// 4. timeout: clean {replied:false, timedOut:true}, bounded polls, no hang.
test('4. askHuman timeout → {replied:false,timedOut:true} with bounded polls', async () => {
  const clock = virtualClock();
  const t = fakeTrello({
    comments: [[c('old', '2025-12-31T23:00:00.000Z', '[HUMAN] long before the ask')]],
    addResult: { id: 'ask1', date: clock.now() },
  });
  const res = await askHuman({
    cardId: CARD,
    question: 'q',
    timeoutMs: 60_000,
    intervalMs: 10_000,
    t,
    notify: async () => ({ sent: true }),
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(res.replied, false);
  assert.equal(res.timedOut, true);
  assert.ok(res.polls >= 5 && res.polls <= 8, `polls=${res.polls} not in [5,8]`);
  assert.ok(res.waitedMs >= 60_000);
});

// 5. --no-wait: zero comment reads, immediate return.
test('5. askHuman --no-wait returns immediately after post+ping', async () => {
  const t = fakeTrello({ addResult: { id: 'ask1', date: NOW } });
  const res = await askHuman({
    cardId: CARD,
    question: 'q',
    noWait: true,
    t,
    notify: async () => ({ sent: true }),
    now: () => NOW,
  });
  assert.equal(t.calls.getComments, 0);
  assert.equal(res.replied, false);
  assert.equal(res.noWait, true);
  assert.equal(res.askCommentId, 'ask1');
  assert.deepEqual(res.discord, { sent: true });
});

// 6. waitForHuman since filter + resume detection of comments that predate polling.
test('6. waitForHuman ignores replies before --since, finds ones after', async () => {
  const clock = virtualClock(Date.parse('2026-01-01T00:00:05.000Z'));
  const t = fakeTrello({
    comments: [[
      c('ask1', '2026-01-01T00:00:01.000Z', '[ASK] q'),
      c('early', '2026-01-01T00:00:02.000Z', '[HUMAN] before since'),
      c('late', '2026-01-01T00:00:06.000Z', '[HUMAN] after since'),
    ]],
  });
  const res = await waitForHuman({
    cardId: CARD,
    sinceIso: '2026-01-01T00:00:04.000Z',
    t,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(res.replied, true);
  assert.equal(res.reply.text, '[HUMAN] after since');
  assert.equal(res.polls, 1);
});

// 6b. wait-mode author filtering: post-since BOT-authored untagged comments must not answer the ask
// (waitForHuman has no excludeCommentId — the author rule protects what the date filter alone cannot).
test('6b. waitForHuman rejects bot-authored untagged comments, picks the human one', async () => {
  const clock = virtualClock(Date.parse('2026-01-01T00:00:05.000Z'));
  const t = fakeTrello({
    comments: [[
      c('ask1', '2026-01-01T00:00:01.000Z', '[ASK] q', 'OMP BOT', BOT),
      c('plan', '2026-01-01T00:00:06.000Z', '[PLAN] plan commit abc1234', 'OMP BOT', BOT),
      c('ans', '2026-01-01T00:00:07.000Z', 'use the blue variant'),
    ]],
  });
  const res = await waitForHuman({
    cardId: CARD,
    sinceIso: '2026-01-01T00:00:04.000Z',
    t,
    sleep: clock.sleep,
    now: clock.now,
  });
  assert.equal(res.replied, true);
  assert.equal(res.reply.text, 'use the blue variant');
  assert.equal(res.reply.via, 'author');
  assert.equal(res.polls, 1);
});

// 7. sendOwnerPing: webhook override, DM default path, non-ok, missing token, throw.
test('7a. sendOwnerPing prefers FACTORY_DISCORD_WEBHOOK (single POST, {content})', async () => {
  const calls = [];
  const res = await sendOwnerPing({
    text: 'hello',
    env: { FACTORY_DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/1/abc' },
    fileEnv: {},
    configDir: path.join(tmpdir(), 'factory-ask-does-not-exist'),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(res, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://discord.com/api/webhooks/1/abc');
  assert.deepEqual(JSON.parse(calls[0].init.body), { content: 'hello' });
});

test('7b. sendOwnerPing default path opens a DM then sends, Authorization Bot <token>', async () => {
  const calls = [];
  const res = await sendOwnerPing({
    text: 'ping',
    env: { DISCORD_BOT_TOKEN: 'tok', FACTORY_DISCORD_USER_ID: '42' },
    fileEnv: {},
    configDir: path.join(tmpdir(), 'factory-ask-does-not-exist'),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ id: 'dm1' }) };
    },
  });
  assert.deepEqual(res, { sent: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://discord.com/api/v10/users/@me/channels');
  assert.equal(calls[0].init.headers.Authorization, 'Bot tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { recipient_id: '42' });
  assert.equal(calls[1].url, 'https://discord.com/api/v10/channels/dm1/messages');
  assert.deepEqual(JSON.parse(calls[1].init.body), { content: 'ping' });
});

test('7c. sendOwnerPing falls back to config/config.json BOT_TOKEN + superUserId', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'factory-ask-cfg-'));
  try {
    mkdirSync(path.join(dir, 'config'));
    writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify({ BOT_TOKEN: 'cfgtok', superUserId: '77' }));
    const calls = [];
    const res = await sendOwnerPing({
      text: 'ping',
      env: {},
      fileEnv: {},
      configDir: dir,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ id: 'dm2' }) };
      },
    });
    assert.deepEqual(res, { sent: true });
    assert.equal(calls[0].init.headers.Authorization, 'Bot cfgtok');
    assert.deepEqual(JSON.parse(calls[0].init.body), { recipient_id: '77' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('7d. sendOwnerPing: non-OK replies and throws → {error}, never throws', async () => {
  const missing = path.join(tmpdir(), 'factory-ask-does-not-exist');
  const r1 = await sendOwnerPing({
    text: 't',
    env: { DISCORD_BOT_TOKEN: 'tok', FACTORY_DISCORD_USER_ID: '42' },
    fileEnv: {},
    configDir: missing,
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'Cannot send messages to this user' }),
  });
  assert.equal(r1.sent, undefined);
  assert.match(r1.error, /403/);

  const r2 = await sendOwnerPing({
    text: 't',
    env: {},
    fileEnv: {},
    configDir: missing,
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
  });
  assert.match(r2.error, /missing Discord/); // no token, no recipient → error without fetch

  const r3 = await sendOwnerPing({
    text: 't',
    env: { BOT_TOKEN: 'tok', FACTORY_DISCORD_USER_ID: '42' },
    fileEnv: {},
    configDir: missing,
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.match(r3.error, /network down/); // rejections are captured, not thrown
});

// Extra: parseFlags unit coverage (used by the CLI wiring below).
test('8a. parseFlags splits value/boolean flags from positionals', () => {
  const { flags, positional } = parseFlags([
    CARD,
    'What',
    'color?',
    '--timeout',
    '5000',
    '--interval',
    '1000',
    '--no-wait',
  ]);
  assert.deepEqual(positional, [CARD, 'What', 'color?']);
  assert.deepEqual(flags, { timeoutMs: 5000, intervalMs: 1000, noWait: true });
  assert.deepEqual(parseFlags([CARD, '--since', '2026-01-01T00:00:00Z']).flags, {
    sinceIso: '2026-01-01T00:00:00.000Z',
  });
  assert.throws(() => parseFlags([CARD, '--timeout']), /timeout/i);
  assert.throws(() => parseFlags([CARD, '--timeout', 'abc']), /timeout/i);
  assert.throws(() => parseFlags([CARD, '--since', 'not-a-date']), /since/i);
});

// 8. CLI wiring via spawnSync — usage paths die BEFORE any network call.
const runCli = (...argv) =>
  spawnSync(process.execPath, [FACTORY_JS, ...argv], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

test('8b. CLI ask with only a card → exit 1 usage before any network', () => {
  const r = runCli('ask', CARD);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: factory\.js ask/);
});

test('8c. CLI wait with no card → exit 1', () => {
  const r = runCli('wait');
  assert.equal(r.status, 1);
});

test('8d. CLI help lists ask and wait', () => {
  const r = runCli('help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\s+ask <card>/m);
  assert.match(r.stdout, /^\s+wait <card>/m);
});

test('8e. CLI unknown command behavior unchanged', () => {
  const r = runCli('bogus-command');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown command "bogus-command"/);
});
