/**
 * Unit tests for scripts/lib/factory-comment-resume.js (comment listener +
 * stage-aware resume; card 6ae89f208dab26fa65fe6b81; docs/factory.md
 * "Listening for human comments") + scripts/factory.js resume-watch wiring.
 *
 * Zero live Trello: every dep is injected — fake trello client (canned lists,
 * card snapshots, per-card comment actions, getMe results, call counters),
 * in-memory state store standing in for data/factory-comment-resume.json,
 * bounded fake sleep to end the for(;;) loop, recording spawnRun/isBusy/
 * freeSlots fakes. The process-level tests spawn the CLI only on paths that
 * die before network (parseFlags errors, help). Style mirrors
 * tests/factoryDonePing.test.js.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

import {
  STATE_PATH,
  STAGE_TAGS,
  STAGE_VERDICT_TAGS,
  isStageTagText,
  hasStageVerdict,
  decideCrashRecovery,
  crashCommentText,
  isAskPending,
  pickResumeTrigger,
  mergeResumeEvents,
  latestStageTag,
  deriveResumeStage,
  ackCommentText,
  buildResumePrompt,
  selectInFlight,
  runCommentResumeWatch,
} from '../scripts/lib/factory-comment-resume.js';
import { parseFlags } from '../scripts/lib/factory-ask.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTORY_JS = path.join(ROOT, 'scripts', 'factory.js');

const TODO = 'todo000000000000000000001';
const READY = 'ready00000000000000000001';
const PLAN = 'plan000000000000000000001';
const IMPLEMENT = 'imple00000000000000000001';
const REVIEW = 'review000000000000000001';
const QA = 'qa00000000000000000000001';
const DEPLOY = 'deploy0000000000000000001';
const VERIFY = 'verify000000000000000001';
const DONE = 'done00000000000000000001';
const CLOSED = 'closed000000000000000001';

const LISTS = [
  { id: TODO, name: 'To Do', closed: false },
  { id: READY, name: 'Ready', closed: false },
  { id: PLAN, name: 'Plan', closed: false },
  { id: IMPLEMENT, name: 'Implement', closed: false },
  { id: REVIEW, name: 'Review', closed: false },
  { id: QA, name: 'QA', closed: false },
  { id: DEPLOY, name: 'Deploy', closed: false },
  { id: VERIFY, name: 'Verify', closed: false },
  { id: DONE, name: 'Done', closed: false },
  { id: CLOSED, name: 'Plan', closed: true }, // rotated/closed list never counts
];

const BOT = { id: 'botid', username: 'factorybot', fullName: 'Factory Bot' };
const botMember = { id: 'botid', username: 'factorybot', fullName: 'Factory Bot' };
const HUMAN = { id: 'humid', username: 'andrew', fullName: 'Andrew' };

const card = (id, name, idList, labels = []) => ({
  id,
  name,
  idList,
  labels,
  url: `https://trello.com/c/${id}/name`,
});
const cmt = (id, date, text, member) => ({ id, date, data: { text }, memberCreator: member });

// The B0coTNxM shape driving the whole feature: stuck in Verify, timeline ends
// at [DEPLOY], a human asks "was going on with this card?".
const STUCK_ID = '6ae7941fdf19ee34c911f0ae';
const stuckCard = () => card(STUCK_ID, 'Ping me on discord when a card is moved to done', VERIFY);
const stuckComments = () => [
  cmt('c2', '2026-11-02T14:28:00.000Z', 'was going on with this card?', HUMAN),
  cmt('c1', '2026-11-02T04:47:00.000Z', '[DEPLOY] sha=a4e8f04 img=multibot-fix', botMember),
]; // Trello returns newest-first

/** Fake trello client. cardsSeq = sequences of card arrays (last sticks);
 * comments = per-card actions (array | Error, default []); me/meSeq = getMe
 * results (object | Error; last sticks). Records every call: totals AND
 * per-card getCardComments counts — board hygiene asserts on those. */
function fakeTrello({ lists = LISTS, cardsSeq = [[]], comments = {}, moves = {}, me = BOT, meSeq = null } = {}) {
  const cs = [...cardsSeq];
  const take = (seq) => (seq.length > 1 ? seq.shift() : seq[0]);
  const ms = meSeq ? [...meSeq] : null;
  const calls = {
    getLists: 0,
    getBoardCards: 0,
    getMe: 0,
    getCardComments: 0,
    getCardCommentsBy: {},
    getCardMoves: 0,
    getCardMovesBy: {},
    addComment: 0,
    moveCard: 0,
    addLabelToCard: 0,
    removeLabelFromCard: 0,
    fields: [],
  };
  const addCommentTexts = [];
  const addCommentCards = [];
  return {
    calls,
    addCommentTexts,
    addCommentCards,
    async getLists() {
      calls.getLists += 1;
      return lists;
    },
    async getBoardCards(fields) {
      calls.getBoardCards += 1;
      calls.fields.push(fields);
      const v = take(cs);
      if (v instanceof Error) throw v;
      return v;
    },
    async getMe() {
      calls.getMe += 1;
      const v = ms ? take(ms) : me;
      if (v instanceof Error) throw v;
      return v;
    },
    async getCardComments(id) {
      calls.getCardComments += 1;
      calls.getCardCommentsBy[id] = (calls.getCardCommentsBy[id] ?? 0) + 1;
      const v = comments[id] ?? [];
      if (v instanceof Error) throw v;
      return v;
    },
    async getCardMoves(id) {
      calls.getCardMoves += 1;
      calls.getCardMovesBy[id] = (calls.getCardMovesBy[id] ?? 0) + 1;
      const v = moves[id] ?? [];
      if (v instanceof Error) throw v;
      return v;
    },
    async addComment(id, text) {
      calls.addComment += 1;
      addCommentCards.push(id);
      addCommentTexts.push(text);
      return { id: `ack${calls.addComment}`, date: '2026-11-02T15:00:00.000Z' };
    },
    async moveCard(id) {
      calls.moveCard += 1;
      return { id };
    },
    async addLabelToCard() {
      calls.addLabelToCard += 1;
      return {};
    },
    async removeLabelFromCard() {
      calls.removeLabelFromCard += 1;
      return {};
    },
  };
}

/** In-memory stand-in for data/factory-comment-resume.json (deep copies). */
function rstore(initial = null) {
  let s = initial;
  let writes = 0;
  return {
    readState: () => (s === null || s === undefined ? null : JSON.parse(JSON.stringify(s))),
    writeState: (v) => {
      s = JSON.parse(JSON.stringify(v));
      writes += 1;
    },
    get: () => s,
    writeCount: () => writes,
  };
}

function recorder() {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
}

/** Recording spawnRun fake; results = sequence (Error → throw, else resolve;
 * last entry sticks). Pass [new Error(...), 'ok'] for fail-then-succeed. */
function spawner(results = []) {
  const seq = [...results];
  const calls = [];
  return {
    calls,
    spawnRun: async (cardArg, prompt) => {
      calls.push({ card: cardArg, prompt });
      const f = seq.length > 1 ? seq.shift() : seq[0];
      if (f instanceof Error) throw f;
      return { pid: 4242 + calls.length };
    },
  };
}

/** Watcher runner with everything faked; returns the pieces tests assert on. */
function harness({ t, state = rstore(null), sp = spawner(), isBusy = () => false, slots = () => 1, ...opts } = {}) {
  const r = recorder();
  return { t, state, sp, r, opts, run: (extra = {}) => runCommentResumeWatch({
    t,
    spawnRun: sp.spawnRun,
    isBusy,
    freeSlots: slots,
    readState: state.readState,
    writeState: state.writeState,
    log: r.log,
    ...opts,
    ...extra,
  }) };
}

// ---- pickResumeTrigger ------------------------------------------------------

// 1. human comment newer than the latest bot comment qualifies.
test('1. pickResumeTrigger: human latest-after-bot returns the trigger', () => {
  const trig = pickResumeTrigger(stuckComments(), { bot: BOT, watermark: null });
  assert.equal(trig.id, 'c2');
  assert.equal(trig.author, 'Andrew');
  assert.match(trig.text, /was going on with this card\?/);
  assert.equal(trig.latestBotText, '[DEPLOY] sha=a4e8f04 img=multibot-fix');
});

// 2. latest comment is bot-authored → null (never act on our own comments).
test('2. pickResumeTrigger: latest comment is bot → null', () => {
  const actions = [
    cmt('c3', '2026-11-02T15:00:00.000Z', '[RESUME] Acknowledged', botMember),
    ...stuckComments(),
  ];
  assert.equal(pickResumeTrigger(actions, { bot: BOT, watermark: null }), null);
});

// 2b. A bot-authored [SEC:FINDINGS] verdict (security pass, card
// 6ae9676cb5da50bc61241a0f) must NEVER fire a resume — bot comments stay
// invisible to the listener; the STAGE_TAGS list knows [SEC:*] so
// latestStageTag reads the security verdict as pipeline bookkeeping.
test('2b. pickResumeTrigger: latest comment is bot [SEC:FINDINGS] → null', () => {
  const actions = [
    cmt('c4', '2026-11-02T16:00:00.000Z', '[SEC:FINDINGS] scripts/lib/deploy-ssh.js:42 — HIGH …', botMember),
    ...stuckComments(),
  ];
  assert.equal(pickResumeTrigger(actions, { bot: BOT, watermark: null }), null);
  assert.equal(latestStageTag(actions).tag, '[SEC:FINDINGS]');
});

// 3. trigger id equals the persisted watermark → null (never re-act, restart-safe).
test('3. pickResumeTrigger: trigger id = watermark → null', () => {
  assert.equal(
    pickResumeTrigger(stuckComments(), { bot: BOT, watermark: { lastCommentId: 'c2' } }),
    null,
  );
});

// 4. bot identity unknown → null (fail-closed degraded mode).
test('4. pickResumeTrigger: bot identity unknown → null', () => {
  assert.equal(pickResumeTrigger(stuckComments(), { bot: null, watermark: null }), null);
  assert.equal(pickResumeTrigger(stuckComments(), { watermark: null }), null);
  assert.equal(pickResumeTrigger(stuckComments(), { bot: {}, watermark: null }), null);
});

// 5. several humans after the last bot comment → the LATEST one wins.
test('5. pickResumeTrigger: multiple humans after last bot → the latest', () => {
  const actions = [
    cmt('c4', '2026-11-02T16:00:00.000Z', 'second nudge', HUMAN),
    cmt('c3', '2026-11-02T15:00:00.000Z', 'first nudge', HUMAN),
    cmt('c1', '2026-11-02T04:47:00.000Z', '[DEPLOY] sha=a4e8f04', botMember),
  ];
  const trig = pickResumeTrigger(actions, { bot: BOT, watermark: { lastCommentId: 'c3' } });
  assert.equal(trig.id, 'c4'); // c3 is watermarked AND superseded
});

// 6. id-preferred compare: a bot-lookalike username with a different member id
// is HUMAN (id wins); a renamed bot with the bot's id is still BOT.
test('6. pickResumeTrigger: member id beats username in both directions', () => {
  const lookalike = { id: 'otherid', username: 'factorybot', fullName: 'Imposter' };
  const trig = pickResumeTrigger(
    [
      cmt('c2', '2026-11-02T14:28:00.000Z', 'hello', lookalike),
      cmt('c1', '2026-11-02T04:47:00.000Z', '[DEPLOY] x', botMember),
    ],
    { bot: BOT, watermark: null },
  );
  assert.equal(trig.id, 'c2'); // different id → human despite matching username
  const renamedBot = { id: 'botid', username: 'renamed-bot-2', fullName: 'Factory Bot' };
  assert.equal(
    pickResumeTrigger(
      [
        cmt('c3', '2026-11-02T15:00:00.000Z', '[IMPL] done', renamedBot),
        cmt('c2', '2026-11-02T14:28:00.000Z', 'hello', HUMAN),
      ],
      { bot: BOT, watermark: null },
    ),
    null, // same id → bot despite the different username; latest is bot
  );
});

// 7. human comment OLDER than the latest bot comment → null (the stage trail
// moved past it; a fresh human comment always lands after the last tag).
test('7. pickResumeTrigger: human before the last bot comment → null', () => {
  const actions = [
    cmt('c2', '2026-11-02T11:00:00.000Z', '[IMPL] shipped', botMember), // latest = bot
    cmt('c1', '2026-11-02T10:00:00.000Z', 'a question', HUMAN),
  ];
  assert.equal(pickResumeTrigger(actions, { bot: BOT, watermark: null }), null);
  // …and a same-second-but-after-bot human comment needs a strictly-later date:
  const tie = [
    cmt('c2', '2026-11-02T10:00:00.000Z', 'a question', HUMAN),
    cmt('c1', '2026-11-02T10:00:00.000Z', '[IMPL] shipped', botMember),
  ];
  assert.equal(pickResumeTrigger(tie, { bot: BOT, watermark: null }), null); // second-granular fail-closed
});

// ---- deriveResumeStage ------------------------------------------------------

// 8. stage derivation incl. the stuck-Verify trap.
test('8. deriveResumeStage: stuck Verify/Deploy re-enter at Verify; others passthrough', () => {
  assert.equal(deriveResumeStage({ listName: 'Verify', comments: stuckComments() }), 'Verify');
  assert.equal(
    deriveResumeStage({
      listName: 'Deploy', // [DEPLOY] landed, the move-to-Verify step pending
      comments: stuckComments(),
    }),
    'Verify',
  );
  assert.equal(
    deriveResumeStage({
      listName: 'Review',
      comments: [cmt('r1', '2026-11-02T10:00:00.000Z', '[REVIEW:APPROVE] lgtm', botMember)],
    }),
    'Review',
  );
  assert.equal(deriveResumeStage({ listName: 'Plan', comments: [] }), 'Plan');
  assert.equal(deriveResumeStage({ listName: 'Implement', comments: stuckComments() }), 'Implement');
  assert.equal(deriveResumeStage({ listName: 'QA', comments: stuckComments() }), 'QA');
  // Verify whose trail already has a [VERIFY:*] AFTER the [DEPLOY] → plain passthrough
  // (the trap only fires when no verify verdict ever followed):
  assert.equal(
    deriveResumeStage({
      listName: 'Verify',
      comments: [
        cmt('v2', '2026-11-02T05:00:00.000Z', '[VERIFY:FAIL] {"checks":[]}', botMember),
        ...stuckComments(),
      ],
    }),
    'Verify',
  );
  assert.equal(latestStageTag(stuckComments()).tag, '[DEPLOY]');
});

// ---- selectInFlight ---------------------------------------------------------

// 9. Ready/Done/To Do never listened; needs-human excluded; closed lists not in scope.
test('9. selectInFlight: stage scope, needs-human and closed-list exclusion', () => {
  const listIds = new Set([PLAN, IMPLEMENT, REVIEW, QA, DEPLOY, VERIFY]);
  const cards = [
    stuckCard(), // Verify → in
    card('a'.repeat(24), 'queued', READY), // Ready → out
    card('b'.repeat(24), 'finished', DONE), // Done → out
    card('d'.repeat(24), 'backlog', TODO), // To Do → out
    card('e'.repeat(24), 'parked', VERIFY, [{ id: 'l1', name: 'needs-human' }]), // parked → out
    card('f'.repeat(24), 'closed-list card', CLOSED), // closed list id → out
  ];
  const picked = selectInFlight(cards, listIds);
  assert.deepEqual(picked.map((c) => c.id), [STUCK_ID]);
  assert.deepEqual(selectInFlight([], listIds), []);
});

// ---- ack text + resume prompt -------------------------------------------------

// 10. ackCommentText: first token [RESUME], names the stage, quotes the comment.
test('10. ackCommentText: [RESUME] first token, stage named, comment quoted', () => {
  const text = ackCommentText(stuckCard(), {
    stage: 'Verify',
    comment: { text: 'was going on\nwith this card?' },
  });
  assert.ok(text.startsWith('[RESUME] '));
  assert.match(text, /Verify/);
  assert.match(text, /"was going on with this card\?"/); // one-line quoted excerpt
});

// 11. buildResumePrompt: id + stage + Plan/Ready ban + quoted comment + worktree
// reuse + curated stage context (card 6ae9676f16ee4be03420c2e6: the raw trail
// is audit-only — the resumed run is seeded with `factory.js context`).
test('11. buildResumePrompt: card id, stage, Plan/Ready ban, quoted comment, worktree reuse', () => {
  const prompt = buildResumePrompt(stuckCard(), {
    stage: 'Verify',
    comment: { text: 'was going on with this card?' },
  });
  assert.ok(prompt.includes(STUCK_ID));
  assert.ok(prompt.includes('Verify'));
  assert.ok(prompt.includes('do NOT move the card back to Plan or Ready'));
  assert.ok(prompt.includes('"was going on with this card?"'));
  assert.ok(prompt.includes(`../discord-bot-factory-wt/${STUCK_ID}`));
  assert.ok(prompt.includes(`factory/${STUCK_ID}`));
  // Repo-owned stage prompt seeding (card 6ae9676f557d52cce856d1a4): the
  // resumed run must seed every subagent it spawns with its stage doc.
  assert.ok(prompt.includes('docs/factory-prompts/<stage>.md'));
  assert.ok(prompt.includes('override your harness role defaults'));
  for (const stage of ['planner', 'implementer', 'reviewer', 'security-reviewer', 'qa']) {
    assert.ok(prompt.includes(`docs/factory-prompts/${stage}.md`));
  }
  // Curated per-stage context seeding (card 6ae9676f16ee4be03420c2e6).
  assert.ok(prompt.includes(`factory.js context ${STUCK_ID} verify`));
  assert.ok(prompt.includes('audit-only'));
  assert.ok(!prompt.includes('full comment trail'));
});

// ---- runCommentResumeWatch (end-to-end, fake seams) ----------------------------

// 12. Stuck-Verify scenario, two ticks + clean stop: tick 1 posts exactly one
// [RESUME] ack, spawns ONE Verify-resume run, moves NOTHING, and advances the
// watermark; tick 2 is silent; shouldStop returns {stopped:true}.
test('12. stuck Verify: one ack + one Verify-resume spawn + zero moves; tick 2 silent', async () => {
  const t = fakeTrello({
    cardsSeq: [[stuckCard()]],
    comments: { [STUCK_ID]: stuckComments() },
  });
  const state = rstore({ cards: {} });
  const sp = spawner();
  const h = harness({ t, state, sp });
  let ticks = 0;
  let stop = false;
  const res = await h.run({
    once: false,
    sleep: async () => {
      ticks += 1;
      if (ticks >= 2) stop = true;
    },
    shouldStop: () => stop,
  });
  assert.equal(res.ok, true);
  assert.equal(res.stopped, true);
  assert.equal(res.checked, 2); // both ticks examined the card
  assert.equal(res.resumed, 1); // exactly one resume across two ticks
  assert.equal(t.calls.addComment, 1); // exactly one [RESUME] ack
  assert.ok(t.addCommentTexts[0].startsWith('[RESUME] '));
  assert.deepEqual(t.addCommentCards, [STUCK_ID]);
  assert.equal(sp.calls.length, 1); // exactly one spawn
  assert.ok(sp.calls[0].prompt.includes('do NOT move the card back to Plan or Ready'));
  assert.match(sp.calls[0].prompt, /re-enters the pipeline at Verify/); // stage-aware: Verify re-run, not replan
  assert.equal(t.calls.moveCard, 0); // NEVER moves cards itself
  assert.equal(t.calls.addLabelToCard, 0); // NEVER labels
  const entry = state.get().cards[STUCK_ID];
  assert.equal(entry.lastCommentId, 'c2'); // watermark advanced only after spawn success
  assert.equal(entry.lastCommentDate, '2026-11-02T14:28:00.000Z');
  assert.equal(entry.ackSentFor, 'c2');
  assert.equal(entry.resumes, 1);
  assert.equal(entry.lastResumeStage, 'Verify');
  assert.equal(typeof entry.lastResumeAt, 'string');
  assert.ok(h.r.lines.some((l) => l.startsWith(`RESUME ${STUCK_ID}`)));
});

// 13. Daemon restart with the persisted state → the same comment stays silent
// (watermark dedup across restarts — exactly-once).
test('13. restart with persisted watermark → silent', async () => {
  const t = fakeTrello({ cardsSeq: [[stuckCard()]], comments: { [STUCK_ID]: stuckComments() } });
  const state = rstore({
    cards: { [STUCK_ID]: { lastCommentId: 'c2', ackSentFor: 'c2', resumes: 1 } },
  });
  const sp = spawner();
  const h = harness({ t, state, sp });
  const res = await h.run({ once: true });
  assert.equal(res.ok, true);
  assert.equal(res.resumed, 0);
  assert.equal(t.calls.addComment, 0);
  assert.equal(sp.calls.length, 0);
});

// 14. Answered [ASK] whose waiter died with its run (card
// 6ae9676d0ee4189387157881 — C-H4 risk-gate approval stranded in QA for a
// day: the run posted [ASK], exited 0 mid-wait, and the poller's guard keyed
// on "latest bot comment is [ASK]" deferred to the dead waiter forever) →
// RESUME: ack + one spawn, watermark advances only after spawn success. A
// live waiter inside a daemon run is still deduped by isBusy (test 15).
test('14. answered [ASK] + dead waiter → RESUME (not silent ask skip)', async () => {
  const comments = {
    [STUCK_ID]: [
      cmt('c3', '2026-11-02T14:28:00.000Z', 'here is my answer', HUMAN),
      cmt('c2', '2026-11-02T14:00:00.000Z', '[ASK] which variant?', botMember),
      cmt('c1', '2026-11-02T04:47:00.000Z', '[DEPLOY] sha=a4e8f04', botMember),
    ],
  };
  const t = fakeTrello({ cardsSeq: [[stuckCard()]], comments });
  const state = rstore({ cards: {} });
  const sp = spawner();
  const h = harness({ t, state, sp });
  const res = await h.run({ once: true });
  assert.equal(res.ok, true);
  assert.equal(res.askSkipped, 0); // the ask is ANSWERED — the watcher owns it now
  assert.equal(res.resumed, 1);
  assert.equal(res.acked, 1);
  assert.equal(sp.calls.length, 1);
  assert.equal(state.get().cards[STUCK_ID].lastCommentId, 'c3'); // advanced on spawn success
});

// 14b. An UNANSWERED ask still defers: with no human reply after the [ASK]
// there is no qualifying trigger at all (the poller never answers over the
// ask protocol) — zero spawns, zero acks, zero watermarks written.
test('14b. unanswered [ASK] (no reply) → untouched, zero spawns', async () => {
  const comments = {
    [STUCK_ID]: [
      cmt('c2', '2026-11-02T14:00:00.000Z', '[ASK] which variant?', botMember),
      cmt('c1', '2026-11-02T04:47:00.000Z', '[DEPLOY] sha=a4e8f04', botMember),
    ],
  };
  const t = fakeTrello({ cardsSeq: [[stuckCard()]], comments });
  const state = rstore({ cards: {} });
  const sp = spawner();
  const h = harness({ t, state, sp });
  const res = await h.run({ once: true });
  assert.equal(res.ok, true);
  assert.equal(res.askSkipped, 0); // no trigger → not even counted
  assert.equal(res.resumed, 0);
  assert.equal(t.calls.addComment, 0);
  assert.equal(sp.calls.length, 0);
});

// 15. A live run owns the card → silent dedup (no ack, no second spawn).
test('15. live run (isBusy) → silent watermark advance', async () => {
  const t = fakeTrello({ cardsSeq: [[stuckCard()]], comments: { [STUCK_ID]: stuckComments() } });
  const state = rstore({ cards: {} });
  const sp = spawner();
  const h = harness({ t, state, sp, isBusy: (id) => id === STUCK_ID });
  const res = await h.run({ once: true });
  assert.equal(res.busySkipped, 1);
  assert.equal(res.resumed, 0);
  assert.equal(t.calls.addComment, 0);
  assert.equal(sp.calls.length, 0);
  assert.equal(state.get().cards[STUCK_ID].lastCommentId, 'c2');
});

// 16. resumes ≥ FACTORY_RESUME_MAX → log-only: watermark advances, no ack,
// no spawn, no labels, no moves.
test('16. resume cap reached → log-only silent advance', async () => {
  const t = fakeTrello({ cardsSeq: [[stuckCard()]], comments: { [STUCK_ID]: stuckComments() } });
  const state = rstore({ cards: { [STUCK_ID]: { resumes: 2 } } });
  const sp = spawner();
  const h = harness({ t, state, sp, resumeMax: 2 });
  const res = await h.run({ once: true });
  assert.equal(res.capSkipped, 1);
  assert.equal(res.resumed, 0);
  assert.equal(t.calls.addComment, 0);
  assert.equal(sp.calls.length, 0);
  assert.equal(t.calls.addLabelToCard, 0); // never parks on cap alone
  assert.equal(state.get().cards[STUCK_ID].lastCommentId, 'c2');
  assert.ok(h.r.lines.some((l) => /resume cap 2 reached/.test(l)));
});

// 17. Ack-before-spawn + spawn failure: the ack lands and its dedup key
// persists; the watermark does NOT advance; next tick retries the spawn with
// exactly ONE ack total.
test('17. spawn failure → watermark not advanced; retry spawns again, one ack only', async () => {
  const t = fakeTrello({ cardsSeq: [[stuckCard()]], comments: { [STUCK_ID]: stuckComments() } });
  const state = rstore({ cards: {} });
  const sp = spawner([new Error('omp not found'), 'ok']); // tick 1 fails, tick 2 succeeds
  const h = harness({ t, state, sp });
  let ticks = 0;
  let stop = false;
  const res = await h.run({
    sleep: async () => {
      ticks += 1;
      if (ticks >= 2) stop = true;
    },
    shouldStop: () => stop,
  });
  assert.equal(res.stopped, true);
  assert.equal(t.calls.addComment, 1); // acked BEFORE the spawn, exactly once ever
  assert.equal(sp.calls.length, 2); // retried next tick
  const entry = state.get().cards[STUCK_ID];
  assert.equal(entry.lastCommentId, 'c2'); // advanced only on the successful retry
  assert.equal(entry.resumes, 1);
  assert.equal(entry.ackSentFor, 'c2');
  assert.ok(h.r.lines.some((l) => /omp not found/.test(l) && /will retry/.test(l)));
});

// 18. No free concurrency slot → NOT advanced (retry next tick); when slots
// free, the ack is NOT re-posted when already sent and exactly one ack total.
test('18. no free slot defers; after slots free the resume proceeds with one ack', async () => {
  const t = fakeTrello({ cardsSeq: [[stuckCard()]], comments: { [STUCK_ID]: stuckComments() } });
  const state = rstore({ cards: {} });
  const sp = spawner();
  let slots = 0;
  const h = harness({ t, state, sp, slots: () => slots });
  const first = await h.run({ once: true });
  assert.equal(first.resumed, 0);
  assert.equal(t.calls.addComment, 0); // deferred before acking
  assert.equal(sp.calls.length, 0);
  assert.equal(state.get().cards[STUCK_ID]?.lastCommentId, undefined); // watermark kept pending
  assert.ok(h.r.lines.some((l) => /no free slot/.test(l)));
  slots = 1;
  const second = await h.run({ once: true });
  assert.equal(second.resumed, 1);
  assert.equal(t.calls.addComment, 1); // exactly one ack across the whole story
  assert.equal(sp.calls.length, 1);
  assert.equal(state.get().cards[STUCK_ID].lastCommentId, 'c2');
});

// 19. First run with a genuinely pending comment → PROCESSED (no silent
// baseline swallow — the deliberate difference from done-ping's baseline).
test('19. missing state file → pending comment is processed, not baselined', async () => {
  const t = fakeTrello({ cardsSeq: [[stuckCard()]], comments: { [STUCK_ID]: stuckComments() } });
  const state = rstore(null); // no state file at all
  const sp = spawner();
  const h = harness({ t, state, sp });
  const res = await h.run({ once: true });
  assert.equal(res.ok, true);
  assert.equal(res.resumed, 1); // answered on the FIRST tick after deploy
  assert.equal(t.calls.addComment, 1);
  assert.equal(sp.calls.length, 1);
});

// 20. Cards vanished from the board are pruned from state (bounds growth).
test('20. vanished cards pruned from the state file', async () => {
  const t = fakeTrello({ cardsSeq: [[stuckCard()]], comments: { [STUCK_ID]: stuckComments() } });
  const state = rstore({ cards: { gone1: { lastCommentId: 'x' }, gone2: { lastCommentId: 'y' } } });
  const h = harness({ t, state, sp: spawner() });
  const res = await h.run({ once: true });
  assert.deepEqual(res.pruned.sort(), ['gone1', 'gone2']);
  const cards = state.get().cards;
  assert.equal(cards.gone1, undefined);
  assert.equal(cards.gone2, undefined);
});

// 21. getMe throws → tick SKIPPED with a log (fail-closed); a good identity
// next tick resumes normally (self-healing lookup).
test('21. getMe throw → skipped tick, next good tick resumes', async () => {
  const t = fakeTrello({
    cardsSeq: [[stuckCard()]],
    comments: { [STUCK_ID]: stuckComments() },
    meSeq: [new Error('trello 500'), BOT],
  });
  const state = rstore({ cards: {} });
  const sp = spawner();
  const h = harness({ t, state, sp });
  let ticks = 0;
  let stop = false;
  const res = await h.run({
    sleep: async () => {
      ticks += 1;
      if (ticks >= 2) stop = true;
    },
    shouldStop: () => stop,
  });
  assert.equal(res.stopped, true);
  assert.equal(t.calls.getMe, 2); // retried next tick
  assert.equal(t.calls.getCardCommentsBy[STUCK_ID], 1); // only the good tick fetched comments
  assert.equal(res.resumed, 1); // the good tick resumed
  assert.ok(h.r.lines.some((l) => /bot identity unavailable/.test(l)));
});

// 22. Identity permanently unusable (no id/username) → fail-closed once-run.
test('22. unusable getMe payload → fail-closed tick, zero comment fetches', async () => {
  const t = fakeTrello({ cardsSeq: [[stuckCard()]], comments: { [STUCK_ID]: stuckComments() }, me: {} });
  const h = harness({ t, state: rstore({ cards: {} }), sp: spawner() });
  const res = await h.run({ once: true });
  assert.equal(res.ok, false);
  assert.equal(t.calls.getCardComments, 0);
  assert.ok(h.r.lines.some((l) => /fail-closed/.test(l)));
});

// 23. shouldStop: pre-cycle stop → {stopped:true} with ZERO fetches; flip
// during the inter-tick sleep → clean stop carrying the last counts.
test('23. shouldStop: pre-cycle exit with zero fetch; mid-run flip stops cleanly', async () => {
  const t1 = fakeTrello({ cardsSeq: [[stuckCard()]] });
  const h1 = harness({ t: t1 });
  const r1 = await h1.run({ shouldStop: () => true });
  assert.equal(r1.ok, true);
  assert.equal(r1.stopped, true);
  assert.equal(t1.calls.getLists, 0); // exited before the first fetch

  const t2 = fakeTrello({ cardsSeq: [[stuckCard()]], comments: { [STUCK_ID]: stuckComments() } });
  const state2 = rstore({ cards: {} });
  const sp2 = spawner();
  let stop = false;
  const h2 = harness({ t: t2, state: state2, sp: sp2 });
  const r2 = await h2.run({ sleep: async () => { stop = true; }, shouldStop: () => stop });
  assert.equal(r2.stopped, true);
  assert.equal(r2.resumed, 1); // lastCounts carry the resume tick
});

// 24. once:true → one-cycle JSON summary; dry-run → would-resume reported with
// ZERO board writes and ZERO state writes (safe alongside the daemon).
test('24. once summary + dry-run zero board/state side effects', async () => {
  const t = fakeTrello({ cardsSeq: [[stuckCard()]], comments: { [STUCK_ID]: stuckComments() } });
  const state = rstore({ cards: {} });
  const sp = spawner();
  const h = harness({ t, state, sp });
  const res = await h.run({ once: true });
  assert.equal(res.ok, true);
  assert.equal(res.checked, 1);
  assert.equal(res.resumed, 1);
  assert.equal(res.acked, 1);
  assert.deepEqual(Object.keys(state.get().cards), [STUCK_ID]); // state written

  const t2 = fakeTrello({ cardsSeq: [[stuckCard()]], comments: { [STUCK_ID]: stuckComments() } });
  const state2 = rstore({ cards: {} });
  const sp2 = spawner();
  const h2 = harness({ t: t2, state: state2, sp: sp2 });
  const dr = await h2.run({ once: true, dryRun: true });
  assert.equal(dr.ok, true);
  assert.deepEqual(dr.wouldResume, [
    { card: STUCK_ID, name: stuckCard().name, stage: 'Verify', comment: 'c2', author: 'Andrew' },
  ]);
  assert.ok(h2.r.lines.some((l) => l.startsWith(`WOULD-RESUME ${STUCK_ID}`)));
  assert.equal(t2.calls.addComment, 0); // zero board comments
  assert.equal(sp2.calls.length, 0); // zero spawns
  assert.equal(state2.writeCount(), 0); // zero state writes
});

// 25. Board hygiene: Ready/Done/To Do/needs-human cards are NEVER fetched for
// comments and never touched (call counters).
test('25. Ready/Done/To Do/needs-human never fetched-for-comments nor touched', async () => {
  const cards = [
    stuckCard(),
    card('a'.repeat(24), 'queued', READY),
    card('b'.repeat(24), 'finished', DONE),
    card('d'.repeat(24), 'backlog', TODO),
    card('e'.repeat(24), 'parked', VERIFY, [{ id: 'l1', name: 'needs-human' }]),
  ];
  const t = fakeTrello({
    cardsSeq: [cards],
    comments: { [STUCK_ID]: stuckComments() }, // others would throw if fetched
  });
  const state = rstore({ cards: {} });
  const sp = spawner();
  const h = harness({ t, state, sp });
  const res = await h.run({ once: true });
  assert.equal(res.checked, 1);
  assert.equal(t.calls.getCardCommentsBy[STUCK_ID], 1);
  assert.equal(t.calls.getCardComments, 1); // exactly one fetch: the in-flight card
  assert.deepEqual(Object.keys(t.calls.getCardCommentsBy), [STUCK_ID]);
  assert.equal(t.calls.addComment, 1); // only the resume ack
  assert.deepEqual(t.calls.fields, ['id,name,idList,labels,url']);
});

// 26. Comment fetch failure on one card is logged and skipped; the tick
// survives and the NEXT card still gets its resume (never rejects).
test('26. per-card comment fetch failure → logged, tick continues', async () => {
  const other = card('f'.repeat(24), 'other stuck card', VERIFY);
  const t = fakeTrello({
    cardsSeq: [[{ ...stuckCard(), id: 'e'.repeat(24) }, other]],
    comments: { ['e'.repeat(24)]: new Error('Trello 502'), [other.id]: stuckComments() },
  });
  const state = rstore({ cards: {} });
  const sp = spawner();
  const h = harness({ t, state, sp });
  const res = await h.run({ once: true });
  assert.equal(res.checked, 2);
  assert.equal(res.resumed, 1); // the healthy card resumed
  assert.equal(sp.calls.length, 1);
  assert.ok(h.r.lines.some((l) => /Trello 502/.test(l) && /will retry/.test(l)));
});

// 27. getLists fetch failure (missing creds class) → logged skip; once → {ok:false}.
test('27. lists fetch failure → logged skip, once returns ok:false', async () => {
  const t = fakeTrello({ lists: [], cardsSeq: [[stuckCard()]] }); // no in-flight lists at all
  const h = harness({ t });
  const res = await h.run({ once: true });
  assert.equal(res.ok, false);
  assert.ok(h.r.lines.some((l) => /poll failed/.test(l)));
});

// 28. parseFlags learns --dry-run without disturbing the existing flags.
test('28. parseFlags: --dry-run flag', () => {
  assert.deepEqual(parseFlags(['--dry-run']).flags, { dryRun: true });
  assert.deepEqual(parseFlags(['--once', '--dry-run', '--interval', '1000']).flags, {
    once: true,
    dryRun: true,
    intervalMs: 1000,
  });
});

// 29. State path is the canonical data/ file (gitignored dir, never a worktree path).
test('29. STATE_PATH is data/factory-comment-resume.json under the repo root', () => {
  assert.equal(STATE_PATH(), path.join(ROOT, 'data', 'factory-comment-resume.json'));
});

// 30. CLI wiring via spawnSync — usage paths die BEFORE any network call.
const runCli = (...argv) =>
  spawnSync(process.execPath, [FACTORY_JS, ...argv], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

test('30a. CLI resume-watch --interval x → exit 1 parseFlags error before any network', () => {
  const r = runCli('resume-watch', '--interval', 'x');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--interval/);
});

test('30b. CLI help lists resume-watch', () => {
  const r = runCli('help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\s+resume-watch /m);
  assert.match(r.stdout, /--dry-run/);
});

// ---- rollback wiring (card 6ae9676d2461fd41204b507e) ------------------------

// 31. [ROLLBACK] is registry-recognized (the [VERIFY:FAIL]→rollback→bounce
// sequence posts it; latestStageTag must read it as pipeline bookkeeping).
// [PROD-CLOSE] joins the registry as declaration; the hyphenated-token regex
// does not match it (pre-existing limitation shared with [DAEMON-CRASH] —
// its first-token matching lives in factory-prod-close.js hasProdClose).
test('31. isStageTagText: [ROLLBACK] canonical match; hyphenated tags unmatched', () => {
  assert.equal(
    isStageTagText('[ROLLBACK] ok — restored last known-good sha=a4e8f04 img=multibot-fix'),
    '[ROLLBACK]',
  );
  assert.equal(isStageTagText('[rollback] lowercase ok'), '[ROLLBACK]');
  assert.equal(isStageTagText('[PROD-CLOSE] which-layer=qa — …'), null); // hyphen regex (same as [DAEMON-CRASH])
  assert.equal(STAGE_TAGS.includes('[ROLLBACK]'), true);
  assert.equal(STAGE_TAGS.includes('[PROD-CLOSE]'), true);
});

// 32. The rollback trap: last stage tag [ROLLBACK] on a Verify/Deploy card
// resumes at Implement (the fix-forward bounce is the pending action); every
// other shape unchanged — the [DEPLOY]-last trap and passthroughs stay.
test('32. deriveResumeStage: [ROLLBACK]-last on Verify/Deploy → Implement; others unchanged', () => {
  const trail = () => [
    cmt('c5', '2026-11-03T06:00:00.000Z', '[ROLLBACK] ok — restored last known-good sha=deadbeef', botMember),
    cmt('c4', '2026-11-03T05:00:00.000Z', '[VERIFY:FAIL] {"checks":[]}', botMember),
    cmt('c1', '2026-11-03T04:47:00.000Z', '[DEPLOY] sha=a4e8f04 img=multibot-fix', botMember),
  ];
  assert.equal(deriveResumeStage({ listName: 'Verify', comments: trail() }), 'Implement');
  assert.equal(deriveResumeStage({ listName: 'Deploy', comments: trail() }), 'Implement');
  assert.equal(
    deriveResumeStage({ listName: 'Implement', comments: trail() }),
    'Implement', // name passthrough (the bounce move already landed)
  );
  // a NEWER tag supersedes the trap:
  assert.equal(
    deriveResumeStage({
      listName: 'Verify',
      comments: [
        cmt('c6', '2026-11-03T07:00:00.000Z', '[DEPLOY] sha=cafe123', botMember),
        ...trail(),
      ],
    }),
    'Verify',
  );
  // the stuck-Verify trap still fires when [DEPLOY] is last (regression):
  assert.equal(deriveResumeStage({ listName: 'Verify', comments: stuckComments() }), 'Verify');
  assert.equal(
    deriveResumeStage({ listName: 'QA', comments: trail() }),
    'QA', // only Verify/Deploy carry the pending bounce
  );
  assert.equal(latestStageTag(trail()).tag, '[ROLLBACK]');
});

// 33. Board-contract ↔ STAGE_TAGS lockstep (docs/factory.md is the contract;
// this test is the mechanical sync — any new contract tag without a registry
// entry fails here): every non-hyphenated tag enumerated in the Board
// contract's "every stage posts exactly one comment" bullet must be
// registry-recognized, and the two new tags of this card must appear in BOTH
// the docs enumeration and the registry.
test('33. docs Board-contract tag list stays in lockstep with STAGE_TAGS', () => {
  const docs = readFileSync(path.join(ROOT, 'docs', 'factory.md'), 'utf8');
  const start = docs.indexOf('Every stage posts exactly one comment, first token is a tag:');
  const end = docs.indexOf('audit-only** trail');
  assert.ok(start !== -1 && end > start, 'board-contract tag bullet must exist');
  const region = docs.slice(start, end);
  for (const tag of [...region.matchAll(/\[([A-Z][A-Z0-9_]*(?::[A-Z0-9_]+)?)\]/g)].map((m) => `[${m[1]}]`)) {
    assert.ok(STAGE_TAGS.includes(tag), `docs contract tag ${tag} missing from STAGE_TAGS`);
    assert.equal(isStageTagText(`${tag} trailing text`), tag);
  }
  for (const tag of ['[ROLLBACK]', '[PROD-CLOSE]']) {
    assert.ok(region.includes(`\`${tag}\``), `docs contract enumeration must list ${tag}`);
    assert.ok(STAGE_TAGS.includes(tag), `registry must declare ${tag}`);
  }
});

// ---- stage-aware crash recovery (card 6ae96770d68eed22d6069c6e) -------------

// 34. The verdict registry crash recovery reads: STAGE_TAGS minus scheduler
// bookkeeping. Bookkeeping comments alone prove NOTHING was committed.
test('34. STAGE_VERDICT_TAGS / hasStageVerdict: verdicts count, bookkeeping does not', () => {
  const bookkeeping = ['[ASK]', '[HUMAN]', '[RESUME]', '[DAEMON-CRASH]', '[METRICS]'];
  for (const tag of bookkeeping) assert.equal(STAGE_VERDICT_TAGS.includes(tag), false);
  for (const tag of [
    '[PLAN]', '[IMPL]', '[REVIEW:APPROVE]', '[REVIEW:CHANGES]', '[SEC:PASS]', '[SEC:FINDINGS]',
    '[QA:PASS]', '[QA:FAIL]', '[DEPLOY]', '[VERIFY:PASS]', '[VERIFY:FAIL]', '[ROLLBACK]', '[PROD-CLOSE]',
  ]) assert.ok(STAGE_VERDICT_TAGS.includes(tag), `verdict registry must include ${tag}`);
  assert.equal(STAGE_VERDICT_TAGS.length, STAGE_TAGS.length - bookkeeping.length);

  assert.equal(hasStageVerdict([cmt('a', '2026-11-03T01:00:00.000Z', '[DAEMON-CRASH] run exited 1; …', botMember)]), false);
  assert.equal(
    hasStageVerdict([
      cmt('a', '2026-11-03T01:00:00.000Z', '[DAEMON-CRASH] run exited 1; …', botMember),
      cmt('b', '2026-11-03T01:01:00.000Z', '[RESUME] Acknowledged …', botMember),
      cmt('c', '2026-11-03T01:02:00.000Z', '[ASK] which env?', botMember),
    ]),
    false,
  );
  assert.equal(hasStageVerdict([cmt('a', '2026-11-03T01:00:00.000Z', '[PLAN] approved plan.', botMember)]), true);
  assert.equal(hasStageVerdict([cmt('a', '2026-11-03T01:00:00.000Z', '  [impl] lowercase + leading space', botMember)]), true);
  assert.equal(hasStageVerdict(['[DEPLOY] sha=abc123 img=multibot-fix']), true); // raw strings accepted
  assert.equal(hasStageVerdict([{ text: '[IMPL] done' }]), true);
  assert.equal(hasStageVerdict([cmt('a', '2026-11-03T01:00:00.000Z', '[PROD-CLOSE] which-layer=qa', botMember)]), true); // hyphen tag counts via literal prefix
  assert.equal(hasStageVerdict([cmt('a', '2026-11-03T01:00:00.000Z', 'plain human comment', HUMAN)]), false);
  assert.equal(hasStageVerdict([]), false);
  assert.equal(hasStageVerdict(undefined), false);
});

// 35. decideCrashRecovery: the card's log picks the recovery — resume (never
// redo committed work; the stuck-Verify and [ROLLBACK] traps inherited for
// free), requeue (ONLY before the first stage verdict), park (cap, anywhere),
// hold (card left the in-flight lists / unreadable board state).
test('35. decideCrashRecovery: park / resume / requeue / hold from the card log', () => {
  const implVerdict = [
    cmt('v1', '2026-11-03T01:00:00.000Z', '[IMPL] evidence…', botMember),
    cmt('k1', '2026-11-03T02:00:00.000Z', '[DAEMON-CRASH] run exited 1; …', botMember),
  ];
  // resume: verdict + in-flight → the card's current list
  assert.deepEqual(
    decideCrashRecovery({ comments: implVerdict, listName: 'Implement', crashRetries: 2 }),
    { mode: 'resume', stage: 'Implement' },
  );
  // the stuck-Verify trap applies to crash recovery: [DEPLOY]-last Verify → Verify
  assert.deepEqual(
    decideCrashRecovery({ comments: stuckComments(), listName: 'Verify', crashRetries: 2 }),
    { mode: 'resume', stage: 'Verify' },
  );
  // the rollback trap applies too: [ROLLBACK]-last Deploy → Implement
  assert.deepEqual(
    decideCrashRecovery({
      comments: [cmt('r1', '2026-11-03T01:00:00.000Z', '[ROLLBACK] ok — restored last known-good', botMember)],
      listName: 'Deploy',
      crashRetries: 2,
    }),
    { mode: 'resume', stage: 'Implement' },
  );
  // case-insensitive in-flight list names (boards vary)
  assert.deepEqual(
    decideCrashRecovery({ comments: implVerdict, listName: 'implement', crashRetries: 2 }),
    { mode: 'resume', stage: 'implement' },
  );
  // requeue: in-flight but bookkeeping-only trail — crashed in Plan before [PLAN]
  assert.deepEqual(
    decideCrashRecovery({
      comments: [cmt('k1', '2026-11-03T01:00:00.000Z', '[DAEMON-CRASH] run exited 1; …', botMember)],
      listName: 'Plan',
      crashRetries: 2,
    }),
    { mode: 'requeue', stage: 'Plan' },
  );
  // park: prior crash count ≥ cap wins over resume/hold; names where it stands
  const atCap = [
    cmt('k2', '2026-11-03T03:00:00.000Z', '[DAEMON-CRASH] run exited 1; stage-aware resume at Implement (crash 2/3)', botMember),
    cmt('k0', '2026-11-03T01:30:00.000Z', '[DAEMON-CRASH] run exited 1; re-queueing to Ready (crash 1/3)', botMember),
    ...implVerdict,
  ];
  assert.deepEqual(decideCrashRecovery({ comments: atCap, listName: 'Implement', crashRetries: 2 }), { mode: 'park', stage: 'Implement' });
  assert.deepEqual(decideCrashRecovery({ comments: atCap, listName: 'Done', crashRetries: 2 }), { mode: 'park', stage: 'Done' });
  // hold: verdict exists but the card left the pipeline (finished, died on exit)
  assert.deepEqual(decideCrashRecovery({ comments: implVerdict, listName: 'Done', crashRetries: 2 }), { mode: 'hold', stage: 'Done' });
  assert.deepEqual(decideCrashRecovery({ comments: implVerdict, listName: 'Ready', crashRetries: 2 }), { mode: 'hold', stage: 'Ready' });
  assert.deepEqual(decideCrashRecovery({ comments: implVerdict, listName: '', crashRetries: 2 }), { mode: 'hold', stage: '' }); // degraded/unknown
});

// 36. crashCommentText: first token [DAEMON-CRASH] for EVERY mode (the
// comment-derived cap depends on it); requeue keeps the pre-C-M5 wording
// byte-for-byte; resume names the stage; park/hold name where the card stands.
test('36. crashCommentText: [DAEMON-CRASH] first token + mode shapes', () => {
  assert.equal(
    crashCommentText(1, 0, { mode: 'requeue', crashRetries: 2 }),
    '[DAEMON-CRASH] run exited 1; re-queueing to Ready (crash 1/3)',
  );
  const resume = crashCommentText('SIGKILL', 1, { mode: 'resume', stage: 'Verify', crashRetries: 2 });
  assert.ok(resume.startsWith('[DAEMON-CRASH] '));
  assert.match(resume, /stage-aware resume at Verify \(crash 2\/3\)/);
  const park = crashCommentText('spawn-failed', 2, { mode: 'park', stage: 'Review', crashRetries: 2 });
  assert.ok(park.startsWith('[DAEMON-CRASH] '));
  assert.match(park, /after 2 prior crash\(es\); parking needs-human where it stands \(Review\)/);
  const hold = crashCommentText(1, 0, { mode: 'hold', stage: 'Done', crashRetries: 2 });
  assert.ok(hold.startsWith('[DAEMON-CRASH] '));
  assert.match(hold, /Done — outside the in-flight pipeline, left untouched \(crash 1\/3\)/);
  // C-M4 tail contract riding the unified builder: append-after-head with the
  // path/caps header, byte-identical first line, ≤16000 clamp, no-log fallback.
  const tailText = crashCommentText(1, 0, {
    mode: 'requeue',
    crashRetries: 2,
    logPath: 'data/factory-daemon/abc.log',
    logText: 'start\nTypeError: boom\nexit 1',
  });
  assert.equal(tailText.split('\n')[0], '[DAEMON-CRASH] run exited 1; re-queueing to Ready (crash 1/3)');
  assert.ok(tailText.includes('--- run log tail (data/factory-daemon/abc.log, last ≤40 lines / ≤4000 chars) ---'));
  assert.ok(tailText.includes('TypeError: boom\nexit 1'));
  const hugeLines = Array.from({ length: 5000 }, (_, i) => `${'x'.repeat(95)}${String(i).padStart(5, '0')}`);
  const huge = crashCommentText(1, 0, {
    mode: 'resume',
    stage: 'QA',
    crashRetries: 2,
    logPath: 'p.log',
    logText: hugeLines.join('\n'),
  });
  assert.ok(huge.length <= 16000);
  assert.ok(huge.endsWith(hugeLines[hugeLines.length - 1])); // newest line survives the clamp
  assert.ok(huge.startsWith('[DAEMON-CRASH] ')); // first-token counting intact with a tail
});

// 37. buildResumePrompt crash variant: the crash line replaces the
// human-comment line; EVERY other line is byte-identical to the comment
// variant (test 11 regression-guards that variant itself).
test('37. buildResumePrompt crash variant: contract lines identical, human line swapped', () => {
  const prompt = buildResumePrompt(stuckCard(), { stage: 'Verify', crash: 'SIGKILL' });
  assert.ok(prompt.includes(STUCK_ID));
  assert.ok(prompt.includes('exited abnormally (SIGKILL) before completing this card'));
  assert.ok(prompt.includes('find the last stage verdict, and continue from Verify'));
  assert.ok(!prompt.includes('A human just commented'));
  assert.ok(prompt.includes('do NOT move the card back to Plan or Ready'));
  assert.ok(prompt.includes(`../discord-bot-factory-wt/${STUCK_ID}`));
  assert.ok(prompt.includes('never recreate it from master or redo committed work'));
  assert.ok(prompt.includes('docs/factory-prompts/<stage>.md'));
  assert.ok(prompt.includes('[ASK] comment asking the human'));
  const commentPrompt = buildResumePrompt(stuckCard(), { stage: 'Verify', comment: { text: 'hi' } });
  const cp = commentPrompt.split('\n');
  const xp = prompt.split('\n');
  assert.equal(cp.length, xp.length);
  const swapped = cp.findIndex((l) => l.startsWith('A human just commented'));
  assert.ok(swapped !== -1);
  assert.ok(xp[swapped].startsWith('The previous scheduler run exited abnormally'));
  cp.forEach((l, i) => {
    if (i !== swapped) assert.equal(xp[i], l);
  });
  assert.ok(commentPrompt.includes('A human just commented'));
  assert.ok(!commentPrompt.includes('exited abnormally'));
});

// 38. decideCrashRecovery askPending input (card 6aebab9a65613358f4ca333a —
// D2): a pending [ASK] holds an IN-FLIGHT card (zero move/spawn) — the exit-0
// stall path must never resume under the human's feet; the park cap still
// out-ranks it; the default keeps every existing decision byte-identical.
test('38. decideCrashRecovery: askPending holds in-flight; park still wins; default unchanged', () => {
  const implVerdict = [
    cmt('v1', '2026-11-03T01:00:00.000Z', '[IMPL] evidence…', botMember),
    cmt('a1', '2026-11-03T02:00:00.000Z', '[ASK] which sha?', botMember),
  ];
  // verdict + in-flight would RESUME, but askPending holds at the current list
  assert.deepEqual(
    decideCrashRecovery({ comments: implVerdict, listName: 'QA', crashRetries: 2, askPending: true }),
    { mode: 'hold', stage: 'QA' },
  );
  // requeue shape too: a bookkeeping-only trail + pending ask → hold, no re-run
  assert.deepEqual(
    decideCrashRecovery({
      comments: [cmt('a2', '2026-11-03T02:00:00.000Z', '[ASK] ok to deploy?', botMember)],
      listName: 'Plan',
      crashRetries: 2,
      askPending: true,
    }),
    { mode: 'hold', stage: 'Plan' },
  );
  // park (cap) out-ranks askPending — stall/ask loops still escalate
  const atCap = [
    cmt('k1', '2026-11-03T03:00:00.000Z', '[DAEMON-CRASH] … (crash 1/3)', botMember),
    cmt('k2', '2026-11-03T04:00:00.000Z', '[DAEMON-CRASH] … (crash 2/3)', botMember),
    ...implVerdict,
  ];
  assert.deepEqual(
    decideCrashRecovery({ comments: atCap, listName: 'QA', crashRetries: 2, askPending: true }),
    { mode: 'park', stage: 'QA' },
  );
  // default (omitted) → every existing decision unchanged
  assert.deepEqual(
    decideCrashRecovery({ comments: implVerdict, listName: 'QA', crashRetries: 2 }),
    { mode: 'resume', stage: 'QA' },
  );
});

// 39. isAskPending (D2's board-derived signal): the latest [ASK] waits on its
// human until an UNTAGGED comment or a [HUMAN] relay answers it, or a stage
// VERDICT supersedes it; bot bookkeeping after the ask keeps it pending;
// no ask / undated ask → false.
test('39. isAskPending: pending until answered or superseded', () => {
  const ask = cmt('a1', '2026-11-03T01:00:00.000Z', '[ASK] re-approve the post-rebase sha?', botMember);
  assert.equal(isAskPending([ask, cmt('v1', '2026-11-02T01:00:00.000Z', '[IMPL] x', botMember)]), true);
  // a human reply answers it
  assert.equal(isAskPending([cmt('h1', '2026-11-03T02:00:00.000Z', 'yes go ahead', HUMAN), ask]), false);
  assert.equal(isAskPending([cmt('h2', '2026-11-03T02:00:00.000Z', '[HUMAN] yes go ahead', botMember), ask]), false);
  // bot bookkeeping after the ask does NOT erase it
  assert.equal(isAskPending([cmt('k1', '2026-11-03T02:00:00.000Z', '[DAEMON-CRASH] run exited 1; …', botMember), ask]), true);
  assert.equal(isAskPending([cmt('r1', '2026-11-03T02:00:00.000Z', '[RESUME] ack', botMember), ask]), true);
  assert.equal(isAskPending([cmt('a2', '2026-11-03T02:00:00.000Z', '[ASK] still waiting?', botMember), ask]), true);
  // a stage verdict supersedes it (the pipeline moved on)
  assert.equal(isAskPending([cmt('v2', '2026-11-03T02:00:00.000Z', '[IMPL] done', botMember), ask]), false);
  assert.equal(isAskPending([cmt('v3', '2026-11-03T02:00:00.000Z', '[PROD-CLOSE] layer=qa', botMember), ask]), false);
  // no ask / undated ask → false; a reply BEFORE the ask stays pending
  assert.equal(isAskPending([cmt('v4', '2026-11-03T02:00:00.000Z', '[IMPL] x', botMember)]), false);
  assert.equal(isAskPending([{ id: 'x', data: { text: '[ASK] q' }, memberCreator: botMember }]), false);
  assert.equal(isAskPending([ask, cmt('h3', '2026-11-02T01:00:00.000Z', 'earlier note', HUMAN)]), true);
  // case-insensitive tag + leading whitespace tolerant
  assert.equal(isAskPending([cmt('a3', '2026-11-03T03:00:00.000Z', ' [ask] lowercase still counts', botMember)]), true);
});

// 40. crashCommentText holdReason='ask-pending': the RC4-visible hold shape;
// the default hold wording stays byte-identical (test 36 regression).
test('40. crashCommentText: ask-pending hold names the wait; default hold unchanged', () => {
  const askHold = crashCommentText('stalled (exit 0 with no verdict)', 0, {
    mode: 'hold',
    stage: 'QA',
    crashRetries: 2,
    holdReason: 'ask-pending',
  });
  assert.ok(askHold.startsWith('[DAEMON-CRASH] '));
  assert.equal(
    askHold,
    '[DAEMON-CRASH] run exited stalled (exit 0 with no verdict); a pending [ASK] owns the reply — left waiting on the human (QA) (crash 1/3)',
  );
  assert.equal(
    crashCommentText(1, 0, { mode: 'hold', stage: 'Done', crashRetries: 2 }),
    '[DAEMON-CRASH] run exited 1; card sits in Done — outside the in-flight pipeline, left untouched (crash 1/3)',
  );
});

// ---- human list-moves as resume triggers ------------------------------------

// Raw updateCard:idList action shape (Trello /cards/{id}/actions?filter=updateCard:idList).
const mv = (id, date, before, after, member) => ({
  id,
  date,
  memberCreator: member,
  data: { listBefore: { name: before }, listAfter: { name: after } },
});

// 41. a human drag newer than the latest bot comment IS the trigger — kind
// 'move', destination list under listName, synthesized quoted text.
test('41. pickResumeTrigger: human move latest-after-bot → move trigger', () => {
  const events = mergeResumeEvents(
    [cmt('c1', '2026-11-02T04:47:00.000Z', '[DEPLOY] sha=a4e8f04 img=multibot-fix', botMember)],
    [mv('m1', '2026-11-02T14:28:00.000Z', 'Review', 'QA', HUMAN)],
  );
  const trig = pickResumeTrigger(events, { bot: BOT, watermark: null });
  assert.equal(trig.id, 'm1');
  assert.equal(trig.kind, 'move');
  assert.equal(trig.listName, 'QA');
  assert.match(trig.text, /Moved the card from "Review" to "QA"/);
});

// 42. a scheduler (bot) move never triggers, and it counts as a bot event:
// a human comment BEFORE the bot's move stays unqualified (the move is newer).
test('42. pickResumeTrigger: bot move latest → null; bot move supersedes older human comment', () => {
  const botMove = mergeResumeEvents([], [mv('m1', '2026-11-02T15:00:00.000Z', 'Deploy', 'Verify', botMember)]);
  assert.equal(pickResumeTrigger(botMove, { bot: BOT, watermark: null }), null);
  const movedAfterHuman = mergeResumeEvents(
    [cmt('c2', '2026-11-02T14:28:00.000Z', 'please continue', HUMAN)],
    [mv('m1', '2026-11-02T15:00:00.000Z', 'Deploy', 'Verify', botMember)],
  );
  assert.equal(pickResumeTrigger(movedAfterHuman, { bot: BOT, watermark: null }), null);
});

// 43. the watermark stores the move's action id — a processed drag never re-fires.
test('43. pickResumeTrigger: move id = watermark → null', () => {
  const events = mergeResumeEvents(
    [cmt('c1', '2026-11-02T04:47:00.000Z', '[DEPLOY] sha=a4e8f04', botMember)],
    [mv('m1', '2026-11-02T14:28:00.000Z', 'Review', 'QA', HUMAN)],
  );
  assert.equal(pickResumeTrigger(events, { bot: BOT, watermark: { lastCommentId: 'm1' } }), null);
});

// 44. end-to-end: a human drag into QA resumes the run AT QA with the
// move-flavored ack + prompt; tick 2 is silent (watermark = move action id).
test('44. tick: human move → move-ack + resume at destination stage; tick 2 silent', async () => {
  const qaCard = card(STUCK_ID, 'Move-advance card', QA);
  const t = fakeTrello({
    cardsSeq: [[qaCard]],
    comments: { [STUCK_ID]: [cmt('c1', '2026-11-02T04:00:00.000Z', '[REVIEW:APPROVE] lgtm', botMember)] },
    moves: { [STUCK_ID]: [mv('m1', '2026-11-02T14:28:00.000Z', 'Review', 'QA', HUMAN)] },
  });
  const h = harness({ t });
  const r1 = await h.run({ once: true });
  assert.equal(r1.resumed, 1);
  assert.equal(r1.acked, 1);
  assert.match(t.addCommentTexts[0], /^\[RESUME\] Acknowledged — your move into "QA"/);
  assert.match(t.addCommentTexts[0], /The move is taken as your instruction/);
  assert.match(h.sp.calls[0].prompt, /A human just moved the card into the "QA" list/);
  assert.match(h.sp.calls[0].prompt, /re-enters the pipeline at QA/);
  assert.equal(h.state.get().cards[STUCK_ID].lastCommentId, 'm1');
  const r2 = await h.run({ once: true });
  assert.equal(r2.resumed, 0);
  assert.equal(r2.checked, 1);
});

// 45. a drag past a pending [ASK] gate ANSWERS it (untagged human event) —
// resume proceeds, the ask-skip must NOT swallow the drag.
test('45. tick: pending [ASK] + human move → RESUME at destination, not ask-skipped', async () => {
  const verifyCard = card(STUCK_ID, 'Gate-drag card', VERIFY);
  const t = fakeTrello({
    cardsSeq: [[verifyCard]],
    comments: { [STUCK_ID]: [cmt('c1', '2026-11-02T04:00:00.000Z', '[ASK] approve sha=abc?', botMember)] },
    moves: { [STUCK_ID]: [mv('m1', '2026-11-02T14:28:00.000Z', 'Deploy', 'Verify', HUMAN)] },
  });
  const h = harness({ t });
  const r = await h.run({ once: true });
  assert.equal(r.resumed, 1);
  assert.equal(r.askSkipped, 0);
});

// 46. move fetch failure degrades to comment-only — the comment resume still
// fires and the tick logs the degradation (never silently loses the drag).
test('46. tick: getCardMoves throw → comment resume still proceeds + log', async () => {
  const t = fakeTrello({
    cardsSeq: [[stuckCard()]],
    comments: { [STUCK_ID]: stuckComments() },
    moves: { [STUCK_ID]: new Error('boom') },
  });
  const h = harness({ t });
  const r = await h.run({ once: true });
  assert.equal(r.resumed, 1);
  assert.ok(h.r.lines.some((l) => /move fetch failed/.test(l) && /comment-only/.test(l)));
});
