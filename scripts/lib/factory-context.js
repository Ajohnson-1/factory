// Per-stage context curation for the software factory (card
// 6ae9676f16ee4be03420c2e6; docs/factory.md "Per-stage context").
// CLI: node scripts/factory.js context <card> <stage> [--max-chars <n>]
//
// Root cause this fixes: every stage agent seeded itself with the RAW
// `factory.js read` comment dump — on a bounced card that replays stale
// verdict bodies and embedded `[VERIFY:FAIL]` JSON blobs into the context
// window of every later stage. The card asks for per-stage curation: each
// stage consumes what it needs (Implement: description + plan pointer +
// live findings; Review: the latest `[IMPL]` evidence + diff; QA: the
// acceptance criteria + fresh gate pointers) while the raw trail stays the
// audit log. The board's own "after the latest `[IMPL]`" supersede rule
// (the security gate's freshness test) decides mechanically which verdicts
// are resolved — so the digest is produced at READ time by pure, tested
// code instead of a non-deterministic `[DIGEST]` comment per bounce (the
// rejected alternative: new tag class + board writes per bounce for what
// read-time code does for free).
//
// Precedent this generalizes: `buildResumePrompt` in
// factory-comment-resume.js already quotes only the triggering comment
// instead of the trail; this lib curates for every stage the same way.
//
// Dependency-injectable logic, the factory-prod-close.js pattern: the
// trello client defaults to the real thing and is faked in
// tests/factoryContext.test.js — zero live Trello there.
// `curateStageContext` is PURE (no network imports at all — tag
// classification is the resume lib's exported `isStageTagText` +
// `STAGE_TAGS`); `getContext`'s `getMe` is BEST-EFFORT — identity fetch errors pass
// `bot = null` (fail-OPEN: curation degrades to the `[HUMAN]`-tag fast
// path, it never dies).

import { isStageTagText, STAGE_TAGS } from './factory-comment-resume.js';
import * as trello from './trello.js';

// Comment-object accessors — local copies of factory-comment-resume.js's
// private helpers (the documented local-copy precedent there keeps other
// libs' export surfaces untouched). Accept a raw string OR an
// action/comment object (`{ data: { text } }`).
const textOf = (a) =>
  typeof a === 'string' ? a : String(a?.data?.text ?? a?.text ?? '');
const authorOf = (a) => a?.memberCreator?.fullName ?? a?.memberCreator?.username ?? 'unknown';
const msOf = (a) => Date.parse(a?.date ?? '');

/** Collapse text to a one-line bounded excerpt (local copy of excerptOf). */
function excerpt(text, max = 200) {
  const oneLine = textOf(text ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

/**
 * True when `member` is the bot account `bot`. Local copy of
 * factory-ask.js / factory-comment-resume.js's private helper (same
 * rationale as the local `excerpt` above: those libs' export surfaces stay
 * untouched). `bot = null` ⇒ always false — the degraded tag-only mode.
 */
function isBotMember(member, bot) {
  if (!member || !bot) return false;
  if (member.id != null && bot.id != null) return String(member.id) === String(bot.id);
  if (member.username != null && bot.username != null) {
    return String(member.username).toLowerCase() === String(bot.username).toLowerCase();
  }
  return false;
}

/** The per-stage spec — single source of truth (docs/factory.md mirrors it). */
export const CONTEXT_STAGES = ['plan', 'implement', 'review', 'security', 'qa', 'deploy', 'verify'];

/**
 * First-token stage tag of a comment (canonical form), or null. Reuses the
 * resume lib's `isStageTagText` (the single source of truth for tag parse +
 * the STAGE_TAGS list) and additionally recognizes the hyphenated
 * bookkeeping tags (`[DAEMON-CRASH]`, `[PROD-CLOSE]`) that its
 * `[A-Z0-9_]`-only regex skips — the resume watcher deliberately ignores
 * them; the curator must count them. Unknown first tokens (a `[DIGEST]`-
 * like tag from the future) are NOT tags: untagged ⇒ digest line (rule 7).
 */
function tagOf(text) {
  const viaResume = isStageTagText(text);
  if (viaResume) return viaResume;
  const m = textOf(text).trim().match(/^\[([^\]]+)\]/i);
  if (!m) return null;
  const upper = `[${m[1].toUpperCase()}]`;
  return STAGE_TAGS.includes(upper) ? upper : null;
}

/** Bounce tags = the exact 3-bounce-rule formula (docs/factory.md). */
// [CHECK:FAIL] joins the formula (card 6ae9677239bb2697a13ea728;
// docs/factory.md "Independent blocking checks"): the daemon gate's FAIL is
// treated EXACTLY like [VERIFY:FAIL] — live for implement, resolved digest
// after a newer [IMPL], counted in counts.bounces.
export const BOUNCE_TAGS = ['[REVIEW:CHANGES]', '[SEC:FINDINGS]', '[QA:FAIL]', '[CHECK:FAIL]', '[VERIFY:FAIL]'];

// Tags whose LATEST instance becomes a latest.* pointer for the stages that
// want it (per-stage spec table, docs/factory.md "Per-stage context").
const POINTER_TAGS = {
  '[PLAN]': 'plan',
  '[IMPL]': 'impl',
  '[REVIEW:APPROVE]': 'reviewApprove',
  '[SEC:PASS]': 'secPass',
  '[QA:PASS]': 'qaPass',
  '[DEPLOY]': 'deploy',
  '[VERIFY:PASS]': 'verify',
  '[ROLLBACK]': 'rollback',
};

// Gate verdicts: FRESH = after the latest [IMPL] (the security gate's rule,
// docs/factory.md "Security review pass"). A stale gate verdict is a digest
// line with "(resolved)" — the stale-gate becomes visible to QA as null.
const GATE_TAGS = new Set(['[REVIEW:APPROVE]', '[SEC:PASS]', '[QA:PASS]']);

// Pure bookkeeping tags → digest lines only (never dropped; crash counts
// stay visible for the 3-bounce rule). [VERIFY:FAIL] is NOT here — it is a
// bounce tag by the supersede rule. [CHECK:PASS] joins it (card
// 6ae9677239bb2697a13ea728): the gate's PASS is the daemon's bookkeeping
// verdict — digest line only, never a pointer; its FAIL sibling is a
// bounce tag above.
const BOOKKEEPING_TAGS = new Set(['[RESUME]', '[DAEMON-CRASH]', '[PROD-CLOSE]', '[CHECK:PASS]']);

// Which latest.* keys each stage consumes (the spec table, mechanized).
const STAGE_POINTER_KEYS = {
  plan: [],
  implement: ['plan', 'impl', 'rollback'],
  review: ['impl'],
  security: ['impl'],
  qa: ['impl', 'reviewApprove', 'secPass'],
  deploy: ['deploy'],
  verify: ['verify', 'rollback'],
};

const DIGEST_MAX = 140;
const capText = (text, maxChars, id) => {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…[truncated ${s.length - maxChars} chars — full text: factory.js read ${id}]`;
};

// Date ascending (defends Trello's newest-first actions order); unparseable
// dates sort FIRST (can't be placed; they still land in the digest, never
// dropped). Array.prototype.sort is stable, so same-date ties keep input
// order — deterministic either way (test 7: shuffled input ⇒ same output).
function sortByDate(comments) {
  return [...(Array.isArray(comments) ? comments : [])].sort((a, b) => {
    const ma = msOf(a);
    const mb = msOf(b);
    const badA = Number.isNaN(ma);
    const badB = Number.isNaN(mb);
    if (badA && badB) return 0;
    if (badA) return -1;
    if (badB) return 1;
    return ma - mb;
  });
}

// `YYYY-MM-DD` from a comment date; unparseable dates digest as `?`.
const dayOf = (c) => {
  const m = msOf(c);
  return Number.isNaN(m) ? '?' : new Date(m).toISOString().slice(0, 10);
};

/**
 * Pure curator — the testable core. `card` = `{ id, name, desc, url }` (the
 * shape `trello.getCard` returns); `comments` = trello.js `getCardComments`
 * items (`{ id, date, data.text, memberCreator }`) in ANY order (sorted
 * internally by date ascending); `stage` (case-insensitive) MUST be in
 * CONTEXT_STAGES or this throws naming the valid list; `bot` = `getMe`
 * shape or null (null degrades human detection to the `[HUMAN]`-tag fast
 * path — the ask protocol's degraded-mode precedent); `maxChars` caps FULL
 * live/latest text (default 4000).
 *
 * Supersede rule = the security gate's rule already in the contract: let
 * `i` = index of the latest `[IMPL]` (date-sorted). A bounce verdict at
 * index < `i` is RESOLVED (the newer `[IMPL]` addressed it) → one digest
 * line, never the body; at index > `i` it is LIVE → full text in `live[]`
 * (implement stage only — the table marks every other stage live "—"). No
 * `[IMPL]` on the card ⇒ nothing is superseded ⇒ every bounce verdict is
 * live. The `[IMPL]` at index `i` itself is never live (test 4).
 *
 * Nothing vanishes (rule 7): every raw comment maps to exactly one of
 * `live` / `latest.*` / `human` / `digest`.
 */
export function curateStageContext({ card, comments, stage, bot = null, maxChars = 4000 } = {}) {
  const s = String(stage ?? '').toLowerCase();
  if (!CONTEXT_STAGES.includes(s)) {
    throw new Error(`Unknown stage "${stage}" — valid stages: ${CONTEXT_STAGES.join(' ')}`);
  }
  const id = String(card?.id ?? '');
  const sorted = sortByDate(comments);
  const n = sorted.length;

  const lastIndex = (pred) => {
    for (let i = n - 1; i >= 0; i--) if (pred(sorted[i], i)) return i;
    return -1;
  };
  const implIdx = lastIndex((c) => tagOf(textOf(c)) === '[IMPL]');
  const askIdx = lastIndex((c) => tagOf(textOf(c)) === '[ASK]');
  // A comment is "bot-side" when authored by the bot OR stage-tagged (bot
  // tags are bot-authored by contract; with bot=null the tag is the only
  // signal — the ask protocol's degraded-mode fast path).
  const botIdx = lastIndex(
    (c) => isBotMember(c?.memberCreator, bot) || tagOf(textOf(c)) != null,
  );

  const wantKeys = new Set(STAGE_POINTER_KEYS[s]);
  // Human-channel reply, decided UP FRONT so the main pass can route every
  // other comment to the digest (rule 7 completeness). Preference: the
  // latest `[HUMAN]` after the latest `[ASK]`; else — with bot identity —
  // the latest non-bot comment after the latest bot-side comment (a pending
  // answer the resume watcher would also see). With bot=null only
  // `[HUMAN]`-tagged replies qualify (the ask protocol's degraded mode).
  const replyIdx = lastIndex(
    (c, i) => tagOf(textOf(c)) === '[HUMAN]' && i > askIdx,
  );
  const pendingIdx = replyIdx >= 0
    ? -1
    : bot
      ? lastIndex(
          (c, i) =>
            !isBotMember(c?.memberCreator, bot) &&
            i > botIdx &&
            tagOf(textOf(c)) == null,
        )
      : -1;
  const live = [];
  const digest = [];
  const latest = {
    plan: null,
    impl: null,
    reviewApprove: null,
    secPass: null,
    qaPass: null,
    deploy: null,
    verify: null,
    rollback: null,
  };
  const counts = { impls: 0, bounces: 0, crashes: 0 };
  let supersededImpls = 0;
  let supersededImplDay = null;

  // Per-key latest index, gate tags gated on freshness (computed up front
  // so the main pass can tell "the pointer" from "an older instance").
  const latestIdxFor = {};
  for (const [tag, key] of Object.entries(POINTER_TAGS)) {
    const gate = GATE_TAGS.has(tag);
    latestIdxFor[key] = lastIndex((c, i) => {
      if (tagOf(textOf(c)) !== tag) return false;
      return !gate || implIdx < 0 || i > implIdx;
    });
  }

  for (let i = 0; i < n; i++) {
    const c = sorted[i];
    const text = textOf(c);
    const tag = tagOf(text);
    const day = dayOf(c);

    if (tag && POINTER_TAGS[tag]) {
      const key = POINTER_TAGS[tag];
      if (tag === '[IMPL]') counts.impls += 1;
      const isPointer = i === latestIdxFor[key];
      if (isPointer && wantKeys.has(key)) continue; // → the pointer pass below
      if (isPointer) {
        // Latest instance of this class, but THIS stage doesn't consume it:
        // a pointer line keeps the audit complete without a verdict body.
        digest.push(`${tag} ${day} — ${excerpt(text, DIGEST_MAX)}`);
      } else if (tag === '[IMPL]') {
        supersededImpls += 1;
        supersededImplDay = day;
      } else if (GATE_TAGS.has(tag) && implIdx >= 0 && i < implIdx) {
        digest.push(`${tag} ${day} — ${excerpt(text, DIGEST_MAX)} (resolved)`);
      } else {
        digest.push(`${tag} ${day} — ${excerpt(text, DIGEST_MAX)} (superseded)`);
      }
    } else if (tag && BOUNCE_TAGS.includes(tag)) {
      counts.bounces += 1;
      if (implIdx >= 0 && i < implIdx) {
        digest.push(`${tag} ${day} — ${excerpt(text, DIGEST_MAX)} (resolved)`);
      } else if (s === 'implement') {
        live.push({ tag, date: c.date, author: authorOf(c), text: capText(text, maxChars, id) });
      } else {
        // Live for Implement, not this stage's payload: a digest pointer
        // keeps the trail complete (rule 7) without replaying the body.
        digest.push(`${tag} ${day} — ${excerpt(text, DIGEST_MAX)} (live for implement)`);
      }
    } else if (tag && BOOKKEEPING_TAGS.has(tag)) {
      if (tag === '[DAEMON-CRASH]') counts.crashes += 1;
      digest.push(`${tag} ${day} ×1 (resolved)`);
    } else if (tag === '[ASK]') {
      if (i === askIdx) continue; // → the human-channel pass below
      digest.push(`[ASK] ${day} — ${excerpt(text, DIGEST_MAX)} (superseded)`);
    } else if (tag === '[HUMAN]') {
      if (i === replyIdx) continue; // → the reply slot below
      digest.push(`[HUMAN] ${day} — ${excerpt(text, DIGEST_MAX)}${i > askIdx ? '' : ' (pre-ask)'}`);
    } else if (i === pendingIdx) {
      continue; // → the reply slot below (author-based pending answer)
    } else {
      // Untagged comment (human chatter / unknown tag): digest line only —
      // the raw text stays one `read` away.
      digest.push(`${tag ?? 'comment'} ${day} — ${excerpt(text, DIGEST_MAX)}`);
    }
  }

  if (supersededImpls > 0) {
    digest.push(
      `[IMPL] ${supersededImplDay} ×${supersededImpls} — superseded by latest [IMPL]`,
    );
  }

  // Pointer pass: fill the wanted keys from the latest (fresh) instances.
  for (const key of wantKeys) {
    const idx = latestIdxFor[key];
    if (idx == null || idx < 0) continue;
    const c = sorted[idx];
    latest[key] = { date: c.date, excerpt: excerpt(textOf(c)) };
    // Review consumes the FULL latest [IMPL]: the evidence IS the review
    // target (missing evidence = automatic finding per Board contract).
    if (key === 'impl' && s === 'review') {
      latest.impl.text = capText(textOf(c), maxChars, id);
    }
  }

  // Human channel: latest [ASK] excerpt + the reply (precomputed index —
  // `replyIdx` = `[HUMAN]` after the ask, `pendingIdx` = author-based
  // pending answer; degraded bot=null mode only sees the tagged one).
  const ask = askIdx >= 0 ? { date: sorted[askIdx].date, excerpt: excerpt(textOf(sorted[askIdx])) } : null;
  const replyIdxFinal = replyIdx >= 0 ? replyIdx : pendingIdx;
  const reply =
    replyIdxFinal >= 0
      ? { date: sorted[replyIdxFinal].date, text: capText(textOf(sorted[replyIdxFinal]), maxChars, id) }
      : null;

  return {
    card: { id, name: card?.name ?? '', url: card?.url ?? '' },
    stage: s,
    description: card?.desc ?? '',
    live,
    latest,
    human: { ask, reply },
    digest,
    counts,
    note: `raw trail is audit-only: node scripts/factory.js read ${id}`,
  };
}

/**
 * IO wrapper (the closeProdCard pattern): fetches card + comments (+ bot
 * identity, BEST-EFFORT — a `getMe` failure passes `bot = null`, fail-OPEN:
 * curation degrades to the `[HUMAN]`-tag fast path, it never dies) and
 * returns `curateStageContext`'s shape. `t` is the injectable trello
 * client; `card` the card id.
 */
export async function getContext({ card, stage, t = trello, maxChars = 4000 } = {}) {
  const id = String(card ?? '');
  const [cardData, comments] = await Promise.all([t.getCard(id), t.getCardComments(id)]);
  let bot = null;
  try {
    if (typeof t.getMe === 'function') bot = await t.getMe();
  } catch {
    /* identity lookup failed — fail-OPEN: curation degrades, never dies */
  }
  return curateStageContext({ card: cardData, comments, stage, bot, maxChars });
}
