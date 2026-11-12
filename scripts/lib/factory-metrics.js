// Factory + reviewer metrics reporting pass (card 6ae9676e2c38913cca053d37).
// Pipeline spec: docs/factory.md ("Metrics report").
//
// Every signal this report needs is ALREADY board state (factor 5 — comments
// are the audit log): bounces, stage boundaries, asks and replies, crashes.
// The pass therefore does ZERO new board writes except one summary comment on
// a dedicated `Factory metrics report` card parked in Done (inert to the
// daemon), and ZERO daemon changes — it never moves cards and never touches
// the dispatch path.
//
// Metrics (all derived from comment first-token tags, case-insensitively,
// matching the board contract exactly — docs/factory.md "Board contract"):
//   bounces        — the gate rule ITSELF, not an analogue: `lifetime` is
//                    `countBounces()` from factory-review-verify.js over the
//                    card's WHOLE trail — the exact netting the scheduler's
//                    needs-human >= BOUNCE_CAP park gate reads (a
//                    [REVIEW:CHANGES] nets to zero when a later
//                    [REVIEW:VERIFY] carries decision=proceed;
//                    [QA:FAIL]/[VERIFY:FAIL]/[SEC:FINDINGS] count
//                    unconditionally). `pending` applies the same function to
//                    the trail AFTER the latest [IMPL] (the open bounce
//                    round); needsHumanRisk = the gate's park condition (net
//                    total >= BOUNCE_CAP). `windowTagTally` is a separately
//                    labeled RAW tally — # bounce-tag comments dated inside
//                    the window, no netting, not the gate rule (reference).
//   stageTimes     — stage boundary = the moment that stage's tag comment
//                    lands. Comment dates mark stage COMPLETION; queue wait in
//                    Ready before dispatch is invisible to comments (honest
//                    caveat, board action history out of scope).
//   crashes        — # [DAEMON-CRASH] comments (comment-based: survives daemon
//                    restarts and log rotation, same source the crash cap
//                    itself reads).
//   askLatency     — per [ASK]: time to the EARLIEST reply authored by a
//                    member != bot, or a [HUMAN]-tagged comment when identity
//                    resolution is degraded — byte-for-byte the ask
//                    protocol's reply rule (docs/factory.md "Asking a human").
//   dispositions   — per [REVIEW:CHANGES] round: fixed (a new [IMPL] landed
//                    and a later [REVIEW:APPROVE] followed it) / dismissed-
//                    heuristic (intervening [IMPL] carries dismissal markers,
//                    or APPROVE arrived with no intervening [IMPL]) / open.
//                    Dismissal detection is KEYWORD-HEURISTIC — a structured
//                    disposition protocol is the obvious follow-up, not here.
//   prodWatch      — snapshot of data/prod-watch.json + [PROD-WATCH] incident
//                    cards opened in the window (prod-down guardrail).
//   cost           — runs started in the window from `# dispatch`/`# resume`
//                    header lines in data/factory-daemon/*.log, the LIVE
//                    --max-cost cap = the cap echoed by the NEWEST in-window
//                    header (never a hardcoded 10, never the all-time max —
//                    a lowered FACTORY_MAX_COST shows up immediately; the
//                    newest header overall is the fallback only when the
//                    window has none, labeled via costCapSource),
//                    best-effort spend regex (costObserved:false when omp
//                    prints no cost line — never fabricated).
//
// Dependency-injectable logic, the factory-done-ping.js pattern: the pure
// compute core `computeMetrics` does no IO at all; `runMetricsReport`'s every
// seam (trello client, state read/write, prod-watch + daemon-log readers,
// clock, log) defaults to the real thing and is faked in
// tests/factoryMetrics.test.js — zero live Trello/launchctl there.
// runMetricsReport NEVER rejects on internal errors — fetch/log-parse
// failures degrade to `errors: [...]` entries in the report; exit 1 is
// reserved for "the report itself could not be computed" (the board fetch
// failed — there is nothing to report).
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as trello from './trello.js';
import { parseDotEnv } from './trello.js';
import { sendOwnerPing } from './factory-ask.js';
import { countBounces, BOUNCE_CAP } from './factory-review-verify.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fileEnv = parseDotEnv();

function envNum(name, fallback) {
  const n = Number(process.env[name] ?? fileEnv[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function envStr(name) {
  return process.env[name] ?? fileEnv[name] ?? null;
}

export const STATE_PATH = () => resolve(ROOT, 'data', 'factory-metrics.json');
export const REPORT_DIR = () => resolve(ROOT, 'data', 'factory-metrics');
export const DAEMON_LOG_DIR = () => resolve(ROOT, 'data', 'factory-daemon');
export const PROD_WATCH_STATE_PATH = () => resolve(ROOT, 'data', 'prod-watch.json');
export const REPORT_CARD_TITLE = 'Factory metrics report';
export const PROD_WATCH_CARD_PREFIX = '[PROD-WATCH]';
export const COMMENT_LIMIT = 50; // same bound as the daemon's crash counting
export const DEFAULT_INTERVAL_MS = envNum('FACTORY_METRICS_INTERVAL_MS', 21_600_000);
export const DEFAULT_COST_CAP_USD = 10;

// Scheduler bounce tags (docs/factory.md "Scheduler loop" bounce counting).
// MIRROR of `BOUNCE_TAGS` in scripts/lib/factory-context.js (the single
// source of truth, itself pinned to docs/factory.md by
// tests/factoryContext.test.js) — order-aligned, equality pinned by
// tests/factoryMetrics.test.js #40 so a formula extension here or there
// cannot silently drift again ([CHECK:FAIL] was missed once here after a
// rebase; the raw windowTagTally must count gate FAILs like the netted
// countBounces side).
export const BOUNCE_TAGS = ['[REVIEW:CHANGES]', '[SEC:FINDINGS]', '[QA:FAIL]', '[CHECK:FAIL]', '[VERIFY:FAIL]'];
// Dismissal markers for the disposition heuristic (documented, keyword-based).
export const DISMISS_RE = /\b(dismissed|won'?t\s+fix|will\s+not\s+fix|declined|not\s+valid|rebut\w*|disagree\w*)\b/i;
// Best-effort spend summary near the log tail; null when omp prints no line.
export const COST_RE = /(?:total\s+cost|cost\s+usd|usd\s+cost|cost\s+spent)\D{0,10}(\$?\s*)(\d+(?:\.\d+)?)/i;

const textOf = (c) => String(c?.data?.text ?? c?.text ?? '');
const dateMsOf = (c) => Date.parse(c?.date ?? '');
// Comment first token, uppercased — the board contract guarantees stage
// verdicts are the first token.
export const tagOf = (c) => textOf(c).trim().split(/\s+/)[0].toUpperCase();
const inRange = (c, since, until) => {
  const ms = dateMsOf(c);
  return Number.isFinite(ms) && ms >= since && ms <= until;
};
// True when a tag belongs to a tag FAMILY (`isTag(t, '[REVIEW:')` matches
// '[REVIEW:APPROVE]'/'[REVIEW:CHANGES]').
const isTag = (tag, prefix) => tag.startsWith(prefix);

// ---------------------------------------------------------------------------
// Pure compute core (no IO — exhaustively unit-tested)
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over an ascending array; null when empty. */
export function percentile(values, q) {
  if (!values.length) return null;
  const rank = Math.max(0, Math.ceil((q / 100) * values.length) - 1);
  return values[rank];
}

/** {n, p50, p95, max} over an array of durations (ms); null when no samples. */
export function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1] };
}

/** True when `member` is the bot account `bot` — same rule as factory-ask.js
 * (prefer immutable ids, fall back to case-insensitive username). */
function isBotMember(member, bot) {
  if (!member || !bot) return false;
  if (member.id != null && bot.id != null) return String(member.id) === String(bot.id);
  if (member.username != null && bot.username != null) {
    return String(member.username).toLowerCase() === String(bot.username).toLowerCase();
  }
  return false;
}

/** First comment date with a finite parse, else null (comments pre-sorted). */
function firstCommentDate(comments) {
  for (const c of comments) {
    const ms = dateMsOf(c);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * Ask-on-top invariant scorer (card 6af60d6a85947225f6ed75a0 — the
 * regression signal for "a card waiting on a human shows its request as the
 * NEWEST comment"). Over finite-dated items sorted ascending (never trust
 * array order), the latest comment is human-facing ⇔ its FIRST line opens
 * with `[ASK]` (pending ask top-of-card) OR its SECOND line starts with
 * `needs you:` (park comment — first line cap record, second line the human
 * action). No comments / latest undated → false (unprovable = violation,
 * same fail-toward-signal rule as the ask protocol's scoring).
 */
export function askOnTopOk(comments) {
  const items = (Array.isArray(comments) ? comments : [])
    .map((c) => ({ c, ms: dateMsOf(c) }))
    .filter((x) => Number.isFinite(x.ms))
    .sort((x, y) => x.ms - y.ms);
  if (!items.length) return false;
  const lines = textOf(items[items.length - 1].c).split('\n');
  return /^\[ASK\]/i.test(lines[0]) || /^needs you:/i.test(lines[1] ?? '');
}

/**
 * Per-card metric extraction over that card's full comment trail.
 * `since`/`until` are epoch ms bounds for the window; `me` is the bot
 * identity ({id, username} | null — null => identityDegraded).
 * Every stage interval counts ONLY when both endpoints exist AND end >= start
 * — never a fabricated 0.
 */
export function computeCardMetrics(card, comments, { since, until, me }) {
  const cs = [...comments].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const tags = cs.map((c) => ({ c, tag: tagOf(c), ms: dateMsOf(c) }));
  const needsHumanLabel = Array.isArray(card?.labels) && card.labels.some((l) => l?.name === 'needs-human');

  // --- bounces — the gate rule itself: countBounces() from
  // factory-review-verify.js, the exact netting the scheduler's needs-human
  // >= BOUNCE_CAP park gate reads (docs/factory.md "Verifying reviewer
  // findings" — "this, not LLM arithmetic"). Whole-trail net total = the
  // gate's own figure; the trail AFTER the latest [IMPL] = the open bounce
  // round. `windowTagTally` is a separate RAW window tally — NOT the gate
  // rule (no netting), labeled as such for reference only.
  let implMs = -Infinity;
  for (const t of tags) if (t.tag === '[IMPL]' && Number.isFinite(t.ms) && t.ms >= implMs) implMs = t.ms;
  const gate = countBounces(cs);
  const pendingTrail = Number.isFinite(implMs) ? cs.filter((x) => dateMsOf(x) > implMs) : cs;
  const bouncePending = countBounces(pendingTrail).bounces;
  const bounceLifetime = gate.bounces;
  const bounceWindowTagTally = tags.filter((t) => BOUNCE_TAGS.includes(t.tag) && inRange(t.c, since, until)).length;

  // --- crashes ([DAEMON-CRASH] comments; comment-based, restart-safe) ---
  const crashEntries = tags.filter((t) => t.tag === '[DAEMON-CRASH]');
  const crashLifetime = crashEntries.length;
  const crashWindow = crashEntries.filter((t) => inRange(t.c, since, until)).length;

  // --- [ASK] latency (earliest non-bot reply; [HUMAN] fast-path when
  //     identity degraded — byte-for-byte the ask protocol's reply rule) ---
  const asks = [];
  for (const t of tags) {
    if (t.tag !== '[ASK]' || !Number.isFinite(t.ms) || !inRange(t.c, since, until)) continue;
    let repliedAt = null;
    let repliedMs = null;
    for (const u of tags) {
      if (u.c === t.c || !Number.isFinite(u.ms)) continue;
      const after = u.ms > t.ms || (u.ms === t.ms && String(u.c.id) !== String(t.c.id));
      if (!after) continue;
      const qualifies = me ? !isBotMember(u.c.memberCreator, me) : u.tag === '[HUMAN]';
      if (qualifies) {
        repliedAt = u.c.date;
        repliedMs = u.ms;
        break;
      }
    }
    asks.push({
      card: card?.id ?? null,
      name: card?.name ?? null,
      askedAt: t.c.date,
      repliedAt,
      latencyMs: repliedMs === null ? null : Math.max(0, repliedMs - t.ms),
    });
  }

  // --- [REVIEW:CHANGES] round dispositions (keyword heuristic, documented) ---
  const reviewRounds = [];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (t.tag !== '[REVIEW:CHANGES]' || !Number.isFinite(t.ms) || !inRange(t.c, since, until)) continue;
    let disposition = 'open';
    let nextImpl = null;
    for (let j = i + 1; j < tags.length; j++) {
      if (tags[j].tag === '[IMPL]' && Number.isFinite(tags[j].ms)) {
        nextImpl = tags[j];
        break;
      }
    }
    let nextApprove = null;
    for (let j = i + 1; j < tags.length; j++) {
      if (tags[j].tag === '[REVIEW:APPROVE]' && Number.isFinite(tags[j].ms)) {
        nextApprove = tags[j];
        break;
      }
    }
    if (nextImpl && DISMISS_RE.test(textOf(nextImpl.c))) disposition = 'dismissed';
    else if (nextImpl && nextApprove && nextApprove.ms >= nextImpl.ms) disposition = 'fixed';
    else if (nextApprove && (!nextImpl || nextApprove.ms < nextImpl.ms))
      disposition = 'dismissed'; // reviewer withdrew — APPROVE arrived with no new [IMPL] between
    reviewRounds.push({ card: card?.id ?? null, changedAt: t.c.date, disposition });
  }

  // --- stage timing pairs (comment dates = stage COMPLETION markers) ---
  const stages = {};
  const firstMs = firstCommentDate(cs);
  const planMs = tags.find((t) => t.tag === '[PLAN]');
  if (firstMs !== null && planMs && Number.isFinite(planMs.ms)) {
    const planDur = planMs.ms - Math.max(firstMs, since); // window-clamped entry proxy
    if (planDur >= 0) stages.planMs = planDur;
  }
  const findAfter = (pred, after) => tags.find((t) => pred(t) && Number.isFinite(t.ms) && t.ms >= after);
  const lastBefore = (pred, before) => {
    let found = null;
    for (const t of tags) if (pred(t) && Number.isFinite(t.ms) && t.ms <= before) found = t;
    return found;
  };
  if (planMs && Number.isFinite(planMs.ms)) {
    const impl = findAfter((t) => t.tag === '[IMPL]', planMs.ms);
    if (impl) stages.implementMs = Math.max(0, impl.ms - planMs.ms);
  } else {
    // No [PLAN] on the card: anchor implement time at the first [IMPL] after
    // the (clamped) first-comment proxy instead of fabricating a PLAN-relative delta.
    const impl = firstMs === null ? null : findAfter((t) => t.tag === '[IMPL]', Math.max(firstMs, since));
    if (impl) stages.implementMs = Math.max(0, impl.ms - Math.max(firstMs, since));
  }
  if (Number.isFinite(implMs)) {
    const review = findAfter((t) => isTag(t.tag, '[REVIEW:'), implMs);
    if (review) {
      const prevImpl = lastBefore((t) => t.tag === '[IMPL]', review.ms);
      if (prevImpl) stages.reviewMs = Math.max(0, review.ms - prevImpl.ms);
      const qa = findAfter((t) => isTag(t.tag, '[QA:'), review.ms);
      if (qa) {
        const approve = lastBefore((t) => t.tag === '[REVIEW:APPROVE]', qa.ms);
        if (approve) stages.qaMs = Math.max(0, qa.ms - approve.ms);
        const deploy = findAfter((t) => t.tag === '[DEPLOY]', qa.ms);
        if (deploy) {
          const qaPass = lastBefore((t) => t.tag === '[QA:PASS]', deploy.ms);
          if (qaPass) stages.deployMs = Math.max(0, deploy.ms - qaPass.ms);
          const verify = findAfter((t) => isTag(t.tag, '[VERIFY:'), deploy.ms);
          if (verify) stages.verifyMs = Math.max(0, verify.ms - deploy.ms);
        }
      }
    }
  }
  const verifyPass = tags.find((t) => t.tag === '[VERIFY:PASS]');
  if (planMs && Number.isFinite(planMs.ms) && verifyPass && Number.isFinite(verifyPass.ms)) {
    stages.totalMs = Math.max(0, verifyPass.ms - planMs.ms);
  }

  return {
    card: card?.id ?? null,
    name: card?.name ?? null,
    url: card?.url ?? null,
    needsHumanLabel,
    truncated: cs.length >= COMMENT_LIMIT,
    bounces: {
      pending: bouncePending,
      lifetime: bounceLifetime, // whole-trail netted — gate-equivalent
      needsHumanRisk: gate.park, // net total >= BOUNCE_CAP, the gate's condition
      windowTagTally: bounceWindowTagTally,
    },
    crashes: { window: crashWindow, lifetime: crashLifetime },
    asks,
    reviewRounds,
    stages,
  };
}

/**
 * Full report from pure inputs. `cards` = board cards
 * ({id, name, idList, labels, url}); `commentsByCard` = cardId -> comment
 * actions ({id, date, data.text, memberCreator}); `prodWatch` = parsed
 * data/prod-watch.json or null (missing file); `daemonLogs` = {file, text}
 * contents (or {file, error} entries). Returns the report object; the shell
 * attaches `ok`/`errors`/report-card metadata.
 */
export function computeMetrics({ cards, commentsByCard, me, sinceIso, untilIso, prodWatch, daemonLogs }) {
  const since = Date.parse(sinceIso);
  const until = Date.parse(untilIso);
  const errors = [];
  const perCards = [];
  const truncated = [];
  for (const card of cards) {
    let comments = commentsByCard?.[card.id] ?? [];
    if (!(comments.length >= COMMENT_LIMIT)) {
      // Defensive: fake/real callers may pass unsorted or filtered lists.
      comments = [...comments];
    }
    const m = computeCardMetrics(card, comments, { since, until, me });
    const touched = [...comments].some((c) => inRange(c, since, until));
    m.touchedInWindow = touched; // lifetime-relevant cards stay in perCards for
    // the roll-ups, but the "cards touched" field counts ONLY cards with real
    // in-window comment activity — stale Done cards with old bounces must not
    // inflate the headline forever.
    if (m.truncated) truncated.push(card.id);
    if (touched || m.bounces.lifetime > 0 || m.crashes.lifetime > 0) perCards.push(m);
  }

  // --- bounces roll-up ---
  const perCard = perCards.map((m) => ({
    card: m.card,
    name: m.name,
    url: m.url,
    pendingBounces: m.bounces.pending,
    bouncesLifetime: m.bounces.lifetime, // netted — countBounces (gate rule)
    windowTagTally: m.bounces.windowTagTally, // raw window tally, no netting
    needsHumanRisk: m.bounces.needsHumanRisk,
    needsHumanLabel: m.needsHumanLabel,
    truncated: m.truncated,
  }));
  const withBounces = perCards.filter((m) => m.bounces.lifetime > 0 || m.bounces.pending > 0);
  const bounces = {
    perCard,
    cap: BOUNCE_CAP, // the needs-human park threshold from factory-review-verify.js
    cardsWithBounces: withBounces.length,
    maxBouncesLifetime: perCards.reduce((mx, m) => Math.max(mx, m.bounces.lifetime), 0),
    windowTagTally: perCards.reduce((s, m) => s + m.bounces.windowTagTally, 0),
    needsHumanLabeled: cards.filter(
      (c) => Array.isArray(c?.labels) && c.labels.some((l) => l?.name === 'needs-human'),
    ).length,
  };

  // --- ask-on-top invariant (card 6af60d6a85947225f6ed75a0) ---
  // Over every `needs-human` card: is its newest comment the human-facing
  // request (pending [ASK] / park action line)? A card whose trail could not
  // be fetched is EXCLUDED from scoring (never fabricate green or red — it
  // rides `errors` from the reporting shell) and `ok` is null when the board
  // has no needs-human cards at all (nothing to assert).
  const askOnTopCards = cards.filter(
    (c) => Array.isArray(c?.labels) && c.labels.some((l) => l?.name === 'needs-human'),
  );
  const askOnTopOffenders = [];
  let askOnTopScored = 0;
  for (const c of askOnTopCards) {
    const trail = commentsByCard?.[c.id];
    if (!Array.isArray(trail)) continue; // unfetched trail — excluded (D6)
    askOnTopScored += 1;
    if (!askOnTopOk(trail)) askOnTopOffenders.push(c.id);
  }
  const askOnTop = {
    needsHumanCards: askOnTopCards.length,
    scored: askOnTopScored,
    ok: askOnTopCards.length === 0 ? null : askOnTopScored === askOnTopCards.length && askOnTopOffenders.length === 0,
    offenders: askOnTopOffenders,
  };

  // --- stage times p50/p95 across cards (both endpoints required) ---
  const stageKeys = ['planMs', 'implementMs', 'reviewMs', 'qaMs', 'deployMs', 'verifyMs', 'totalMs'];
  const stageTimes = {};
  for (const key of stageKeys) {
    stageTimes[key] = summarize(perCards.map((m) => m.stages[key]).filter((v) => typeof v === 'number'));
  }

  // --- crashes roll-up ---
  const crashes = {
    inWindow: perCards.reduce((s, m) => s + m.crashes.window, 0),
    lifetime: perCards.reduce((s, m) => s + m.crashes.lifetime, 0),
    perCard: perCards
      .filter((m) => m.crashes.lifetime > 0)
      .map((m) => ({ card: m.card, name: m.name, window: m.crashes.window, lifetime: m.crashes.lifetime })),
  };

  // --- ask latency ---
  const allAsks = perCards.flatMap((m) => m.asks);
  const answered = allAsks.filter((a) => a.latencyMs !== null).map((a) => a.latencyMs).sort((a, b) => a - b);
  const askLatency = {
    asks: allAsks,
    answered: answered.length,
    unanswered: allAsks.length - answered.length,
    p50Ms: percentile(answered, 50),
    p95Ms: percentile(answered, 95),
    identityDegraded: !me,
  };

  // --- review disposition ratio ---
  const rounds = perCards.flatMap((m) => m.reviewRounds);
  const disp = { fixed: 0, dismissed: 0, open: 0 };
  for (const r of rounds) disp[r.disposition] += 1;
  const total = rounds.length;
  const reviewDisposition = {
    rounds,
    fixed: disp.fixed,
    dismissed: disp.dismissed,
    open: disp.open,
    actedRatio: total ? disp.fixed / total : null,
    dismissedRatio: total ? disp.dismissed / total : null,
    heuristic: true, // dismissal detection is keyword-based, not a protocol
  };

  // --- prod-watch guardrail ---
  const pwCards = cards.filter((c) => String(c?.name ?? '').startsWith(PROD_WATCH_CARD_PREFIX));
  let prodWatchOut = null;
  if (prodWatch) {
    prodWatchOut = {
      snapshot: {
        status: prodWatch.status ?? null,
        incident: prodWatch.incident ?? null,
        lastCheck: prodWatch.lastCheck ?? null,
        lastVerdict: prodWatch.lastVerdict ?? null,
      },
      downEventsInWindow: pwCards.filter((c) => {
        const cs = commentsByCard?.[c.id] ?? [];
        return cs.some((cm) => inRange(cm, since, until));
      }).length,
    };
  } else {
    errors.push('data/prod-watch.json missing or unreadable — prodWatch section null');
  }

  // --- cost vs cap from daemon log headers ---
  // `maxCostCapUsd` is the LIVE cap (this section is the factor-8 cost
  // guardrail): the --max-cost echoed by the NEWEST in-window dispatch/resume
  // header — never the all-time max, so a lowered FACTORY_MAX_COST shows up
  // immediately. Only when the window has NO header does it fall back to the
  // newest header seen anywhere, labeled honestly via `costCapSource`.
  let runsInWindow = 0;
  let costObserved = false;
  let costSpentUsd = 0;
  let newestInWindow = null; // { ms, costCapUsd }
  let newestAny = null; // { ms, costCapUsd }
  for (const entry of daemonLogs ?? []) {
    if (entry.error) {
      errors.push(`daemon log ${entry.file}: ${entry.error}`);
      continue;
    }
    const runs = parseDispatchHeaders(entry.text, { sinceIso, untilIso });
    runsInWindow += runs.filter((r) => r.inWindow).length;
    for (const r of runs) {
      const ms = Date.parse(r.iso);
      if (!Number.isFinite(ms)) continue; // parseDispatchHeaders already skips these
      if (r.inWindow && (!newestInWindow || ms > newestInWindow.ms)) newestInWindow = { ms, costCapUsd: r.costCapUsd };
      if (!newestAny || ms > newestAny.ms) newestAny = { ms, costCapUsd: r.costCapUsd };
    }
    const spent = extractCostSpent(entry.text);
    if (spent !== null) {
      costObserved = true;
      costSpentUsd += spent;
    }
  }
  const cost = {
    runsInWindow,
    maxCostCapUsd: newestInWindow?.costCapUsd ?? newestAny?.costCapUsd ?? DEFAULT_COST_CAP_USD,
    costCapSource: newestInWindow ? 'newest-in-window-header' : newestAny ? 'newest-header-no-in-window-runs' : 'default',
    costObserved,
    costSpentUsd: costObserved ? Number(costSpentUsd.toFixed(4)) : null,
    costCapSuspect: crashes.inWindow, // runs that ended in [DAEMON-CRASH]
  };

  return {
    window: { since: sinceIso, until: untilIso },
    generatedAt: untilIso,
    cards: {
      onBoard: cards.length,
      touchedInWindow: perCards.filter((m) => m.touchedInWindow).length,
      needsHumanLabeled: bounces.needsHumanLabeled,
    },
    bounces,
    askOnTop,
    stageTimes,
    crashes,
    askLatency,
    reviewDisposition,
    prodWatch: prodWatchOut,
    cost,
    truncated,
    caveats: [
      'comment dates mark stage completion; queue wait in Ready before daemon dispatch is invisible to comments',
      'dismissed findings are detected by keyword heuristic in the next [IMPL], not a structured protocol',
      'cost spend is best-effort from daemon logs; costObserved:false means no cost line was printed — not zero spend',
    ],
    errors,
  };
}

/**
 * Parse `# dispatch <ISO> <bin> <agentArgs JSON>` / `# resume …` header lines
 * (written by scripts/factory-daemon.js). Returns one entry per header:
 * {kind, iso, inWindow, costCapUsd}. Malformed lines are skipped (never throw).
 */
export function parseDispatchHeaders(text, { sinceIso, untilIso } = {}) {
  const since = Date.parse(sinceIso ?? 0);
  const until = Date.parse(untilIso ?? Date.now());
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.match(/^# (dispatch|resume) (\S+) (.*)$/);
    if (!m) continue;
    const iso = m[2];
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    let argv = null;
    const jsonStart = m[3].indexOf('[');
    if (jsonStart >= 0) {
      try {
        argv = JSON.parse(m[3].slice(jsonStart));
      } catch {
        argv = null;
      }
    }
    let costCapUsd = DEFAULT_COST_CAP_USD;
    const i = Array.isArray(argv) ? argv.indexOf('--max-cost') : -1;
    if (i >= 0 && Number.isFinite(Number(argv[i + 1]))) costCapUsd = Number(argv[i + 1]);
    out.push({ kind: m[1], iso, inWindow: ms >= since && ms <= until, costCapUsd });
  }
  return out;
}

/** Last cost/usage summary match in the log tail (never the dispatch header
 * echo of `--max-cost`), or null when omp printed none. */
export function extractCostSpent(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(COST_RE);
    if (m) return Number(m[2]);
  }
  return null;
}

/** Parse + normalize the prod-watch snapshot; null when missing/corrupt. */
export function readProdWatchState(path = PROD_WATCH_STATE_PATH()) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (!s || typeof s !== 'object') return null;
    return s;
  } catch {
    return null;
  }
}

/** Read every *.log in the daemon state dir; unreadable files degrade to
 * {file, error} entries instead of throwing. */
export function readDaemonLogs(dir = DAEMON_LOG_DIR()) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.log'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      out.push({ file: name, text: readFileSync(file, 'utf8') });
    } catch (e) {
      out.push({ file: name, error: e.message });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// State + artifact persistence (atomic, done-ping discipline)
// ---------------------------------------------------------------------------

function defaultReadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_PATH(), 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : null;
  } catch {
    return null;
  }
}

function defaultWriteState(state) {
  const p = STATE_PATH();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, p);
}

function defaultWriteArtifacts(report) {
  const dir = REPORT_DIR();
  mkdirSync(join(dir, 'archive'), { recursive: true });
  const latest = join(dir, 'latest.json');
  const tmp = `${latest}.tmp`;
  const body = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(tmp, body);
  renameSync(tmp, latest);
  const stamp = String(report.window?.until ?? new Date().toISOString()).replace(/[:.]/g, '-');
  writeFileSync(join(dir, 'archive', `${stamp}.json`), body);
}

// ---------------------------------------------------------------------------
// Reporting shell (the only IO)
// ---------------------------------------------------------------------------

/** One-line headline for the [METRICS] comment. */
export function buildMetricsHeadline(r) {
  const b = r.bounces;
  const rd = r.reviewDisposition;
  const pw = r.prodWatch?.snapshot?.status ?? 'unknown';
  const ao = r.askOnTop ?? {};
  const aoState = ao.ok === null || ao.ok === undefined ? 'n/a' : ao.ok ? 'ok' : 'VIOLATED';
  const aoOffenders =
    Array.isArray(ao.offenders) && ao.offenders.length
      ? `; offenders ${ao.offenders.slice(0, 3).join(',')}${ao.offenders.length > 3 ? ` +${ao.offenders.length - 3} more` : ''}`
      : '';
  const stageBit = (k) => (r.stageTimes[k] ? `${k}:p50 ${Math.round(r.stageTimes[k].p50 / 60000)}m` : null);
  const stages = ['implementMs', 'reviewMs', 'qaMs'].map(stageBit).filter(Boolean).join(', ');
  return (
    `[METRICS] ${r.window.since} .. ${r.window.until} — cards touched ${r.cards.touchedInWindow}; ` +
    `bounced cards ${b.cardsWithBounces} (max netted lifetime ${b.maxBouncesLifetime}); crashes ${r.crashes.inWindow}; ` +
    `asks answered ${r.askLatency.answered}/${r.askLatency.answered + r.askLatency.unanswered}; ` +
    `findings fixed/dismissed/open ${rd.fixed}/${rd.dismissed}/${rd.open}; prod ${pw}; ` +
    `runs ${r.cost.runsInWindow} vs cap $${r.cost.maxCostCapUsd}` +
    (stages ? `; ${stages}` : '') +
    `; needs-human ask-on-top ${aoState} (${ao.scored ?? 0}/${ao.needsHumanCards ?? 0}${aoOffenders})` +
    `; errors ${r.errors.length}`
  );
}

// ---------------------------------------------------------------------------
// Compact board summary (Trello comment-length cap — QA bounce round)
// ---------------------------------------------------------------------------
// Trello caps comment text at ~16,384 chars (a full-history pretty-printed
// report JSON hit ~30KB and 400'd `invalid value for text` on EVERY run —
// a deterministic post failure that froze the window watermark forever,
// since the state advances only after a successful post). The board comment
// is therefore a COMPACT human-readable summary with PROVABLE bounds: every
// free-text list (card names are human-editable, arbitrary length) is capped
// at SUMMARY_LIST_MAX items of SUMMARY_ITEM_MAX_CHARS each and error lines
// at SUMMARY_ERRORS_MAX × SUMMARY_ERROR_MAX_CHARS, so the natural body is a
// few KB; a final hard guard clamps ANY report to
// METRICS_COMMENT_MAX_CHARS (15,000 — well under the cap; QA proved a
// 15,983-char post lands). The full JSON stays in the local artifacts:
// data/factory-metrics/latest.json + archive/<ISO>.json, written on every
// posted run. The first token stays `[METRICS]` (board-contract pin).

export const METRICS_COMMENT_MAX_CHARS = 15_000;
export const SUMMARY_ITEM_MAX_CHARS = 48; // per card-name cap
export const SUMMARY_LIST_MAX = 12; // items per card list
export const SUMMARY_ERROR_MAX_CHARS = 160; // per error-message cap
export const SUMMARY_ERRORS_MAX = 3; // error lines shown
export const SUMMARY_TAIL = '\n… (summary truncated — full report: data/factory-metrics/latest.json)';

/** Collapse whitespace + clip free text to `max` chars (deterministic). */
function clipText(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
}
const mins = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? `${Math.round(ms / 60000)}m` : 'n/a');
const pctStr = (x) => (typeof x === 'number' && Number.isFinite(x) ? `${Math.round(x * 1000) / 10}%` : 'n/a');

/** Condensed per-signal lines under the headline — bounded by construction:
 * fixed numeric lines + at most SUMMARY_LIST_MAX capped-name items per list +
 * SUMMARY_ERRORS_MAX capped error lines + capped caveats (≈4 KB worst case;
 * buildMetricsComment clamps the rest). */
export function buildMetricsSummary(r) {
  const b = r.bounces ?? {};
  const rd = r.reviewDisposition ?? {};
  const cost = r.cost ?? {};
  const a = r.askLatency ?? {};
  const capList = (items, fmt) => {
    const shown = items.slice(0, SUMMARY_LIST_MAX).map(fmt);
    if (items.length > SUMMARY_LIST_MAX) shown.push(`(+${items.length - SUMMARY_LIST_MAX} more — full list in the JSON artifact)`);
    return shown.join(', ');
  };
  const perCard = Array.isArray(b.perCard) ? b.perCard : [];
  const risk = perCard.filter((m) => m.needsHumanRisk);
  const bounced = perCard
    .filter((m) => (m.bouncesLifetime ?? 0) > 0 || (m.pendingBounces ?? 0) > 0)
    .sort(
      (x, y) =>
        (y.bouncesLifetime ?? 0) - (x.bouncesLifetime ?? 0) ||
        (y.pendingBounces ?? 0) - (x.pendingBounces ?? 0) ||
        String(x.name ?? '').localeCompare(String(y.name ?? '')),
    );
  const crashCards = (Array.isArray(r.crashes?.perCard) ? r.crashes.perCard : [])
    .filter((m) => (m.window ?? 0) > 0 || (m.lifetime ?? 0) > 0)
    .sort((x, y) => (y.window ?? 0) - (x.window ?? 0) || (y.lifetime ?? 0) - (x.lifetime ?? 0));
  const st = r.stageTimes ?? {};
  const stageBits = ['planMs', 'implementMs', 'reviewMs', 'qaMs', 'deployMs', 'verifyMs', 'totalMs']
    .filter((k) => st[k]?.n > 0)
    .map((k) => `${k.replace(/Ms$/, '')}: p50 ${mins(st[k].p50)} p95 ${mins(st[k].p95)} max ${mins(st[k].max)} (n=${st[k].n})`);
  const pw = r.prodWatch?.snapshot?.status ?? 'unknown';
  const ao = r.askOnTop ?? {};
  const aoState = ao.ok === null || ao.ok === undefined ? 'n/a' : ao.ok ? 'ok' : 'VIOLATED';
  const errs = Array.isArray(r.errors) ? r.errors : [];
  const lines = [
    `cards: ${r.cards?.onBoard ?? 0} on board; ${r.cards?.touchedInWindow ?? 0} touched in window; needs-human labeled ${b.needsHumanLabeled ?? 0}; comment-capped trails ${(Array.isArray(r.truncated) ? r.truncated : []).length}`,
    `bounces: ${b.cardsWithBounces ?? 0} cards (max netted lifetime ${b.maxBouncesLifetime ?? 0}; gate cap ${b.cap ?? '?'}; raw window tag tally ${b.windowTagTally ?? 0})`,
    `needs-human risk: ${risk.length ? capList(risk, (m) => `${clipText(m.name, SUMMARY_ITEM_MAX_CHARS)} (net ${m.bouncesLifetime ?? 0})`) : 'none'}`,
    `ask-on-top (needs-human): ${aoState} — scored ${ao.scored ?? 0}/${ao.needsHumanCards ?? 0}${Array.isArray(ao.offenders) && ao.offenders.length ? `; offenders ${capList(ao.offenders, (id) => String(id))}` : ''}`,
    `top bounced: ${bounced.length ? capList(bounced, (m) => `${clipText(m.name, SUMMARY_ITEM_MAX_CHARS)} [net ${m.bouncesLifetime ?? 0}, pending ${m.pendingBounces ?? 0}, raw window ${m.windowTagTally ?? 0}]`) : 'none'}`,
    `stage times: ${stageBits.length ? stageBits.join('; ') : 'no complete stage intervals in window'}`,
    `crashes: ${r.crashes?.inWindow ?? 0} in window / ${r.crashes?.lifetime ?? 0} lifetime${crashCards.length ? `; top: ${capList(crashCards, (m) => `${clipText(m.name, SUMMARY_ITEM_MAX_CHARS)} (window ${m.window ?? 0}, lifetime ${m.lifetime ?? 0})`)}` : ''}`,
    `asks: answered ${a.answered ?? 0}/${(a.answered ?? 0) + (a.unanswered ?? 0)}${a.unanswered ? `; unanswered ${a.unanswered}` : ''}; latency p50 ${mins(a.p50Ms)} p95 ${mins(a.p95Ms)}${a.identityDegraded ? ' (identity degraded — [HUMAN]-tag fallback)' : ''}`,
    `findings: fixed ${rd.fixed ?? 0} / dismissed ${rd.dismissed ?? 0} / open ${rd.open ?? 0}; acted ${pctStr(rd.actedRatio)} dismissed ${pctStr(rd.dismissedRatio)} (keyword heuristic)`,
    `prod: ${pw}; incident cards opened in window ${r.prodWatch?.downEventsInWindow ?? 0}${r.prodWatch?.snapshot?.incident ? `; active incident ${clipText(r.prodWatch.snapshot.incident, 80)}` : ''}`,
    `cost: ${cost.runsInWindow ?? 0} runs in window vs live cap $${cost.maxCostCapUsd ?? '?'} (source ${cost.costCapSource ?? 'unknown'}); ${cost.costObserved ? `spend $${cost.costSpentUsd}` : 'spend not observed (no cost line printed — not zero)'}`,
    `errors: ${errs.length}${errs.length ? `; ${errs.slice(0, SUMMARY_ERRORS_MAX).map((e) => `"${clipText(e, SUMMARY_ERROR_MAX_CHARS)}"`).join(' ')}${errs.length > SUMMARY_ERRORS_MAX ? ` (+${errs.length - SUMMARY_ERRORS_MAX} more)` : ''}` : ''}`,
    `caveats: ${(Array.isArray(r.caveats) ? r.caveats : []).slice(0, 3).map((cv) => clipText(cv, 140)).join(' | ')}`,
  ];
  return lines.map((l) => `- ${l}`).join('\n');
}

/** The full [METRICS] board comment: headline + compact bounded summary.
 * Provable bound: length <= METRICS_COMMENT_MAX_CHARS for ANY report — the
 * summary is bounded by construction; the final guard slices deterministically
 * (headline + first-token contract survive — the window strings are operator
 * ISO inputs, and even a pathological one cannot push past the clamp). */
export function buildMetricsComment(r) {
  const body = `${buildMetricsHeadline(r)}\n\n${buildMetricsSummary(r)}`;
  if (body.length <= METRICS_COMMENT_MAX_CHARS) return body;
  return `${body.slice(0, METRICS_COMMENT_MAX_CHARS - SUMMARY_TAIL.length)}${SUMMARY_TAIL}`;
}

/**
 * One reporting pass. `t` is the trello client (all reads exist: getMe,
 * getLists, getBoardCards, getCardComments, createCard, addComment). Never
 * rejects; degraded reads land in `report.errors`. `postCard` describes the
 * [METRICS] card touched (`{created:false}` when reused; absent when the Done
 * list is missing / noPost). `discordPing` reports the owner summary DM
 * (same identity plumbing as ask/done pings — `sendOwnerPing` from
 * factory-ask.js): `{sent:true}` / `{error}` / null when skipped; a Discord
 * failure NEVER fails the run or blocks the state advance — it lands in
 * `report.errors` only (best-effort, at-least-once board reporting unchanged).
 * Returns { ok, report, postCard, discordPing } — `ok:false` only when the
 * board fetch failed (nothing to report; exit 1 territory).
 */
export async function runMetricsReport({
  t = trello,
  board, // FM-2 (§4.3): board-scoped reads (getBoardCards/getLists/getMe) target this board; undefined = default (byte-identical)
  since = null,
  noPost = false,
  notify = sendOwnerPing,
  readState = defaultReadState,
  writeState = defaultWriteState,
  writeArtifacts = defaultWriteArtifacts,
  readProdWatch = readProdWatchState,
  readDaemonLogs: readLogs = readDaemonLogs,
  now = () => new Date().toISOString(),
  log = (msg) => process.stderr.write(`[factory-metrics] ${msg}\n`),
} = {}) {
  const untilIso = now();
  const until = Date.parse(untilIso);
  const state = readState() ?? {};
  // Window start precedence: explicit arg → FACTORY_METRICS_SINCE → state
  // lastRun → board start (full-history window on first run).
  let sinceIso = since ?? envStr('FACTORY_METRICS_SINCE') ?? state.lastRun ?? null;
  if (sinceIso && !Number.isFinite(Date.parse(sinceIso))) sinceIso = null;

  const cards = await t.getBoardCards(undefined, { board }).catch((e) => {
    log(`board fetch failed: ${e.message}`);
    return null;
  });
  if (!cards) return { ok: false, report: null, errors: [`board fetch failed — no report this cycle`] };

  const me = await t.getMe({ board }).catch((e) => {
    log(`identity lookup failed: ${e.message} — reply matching falls back to [HUMAN]-tag-only`);
    return null;
  });

  const listName = envStr('FACTORY_METRICS_LIST') || 'Done';
  const lists = await t.getLists({ board }).catch(() => []);
  const targetList =
    lists.find((l) => !l.closed && l.name?.toLowerCase() === String(listName).toLowerCase()) ?? null;

  let prodWatch = null;
  try {
    prodWatch = readProdWatch();
  } catch (e) {
    log(`prod-watch state unreadable: ${e.message}`);
  }
  let daemonLogs = [];
  try {
    daemonLogs = readLogs() ?? [];
  } catch (e) {
    log(`daemon logs unreadable: ${e.message}`);
  }

  // Pre-window comment probe decides which cards are touched (window start
  // known by now); only touched cards fetch their FULL trail — bounce/ask
  // disposition semantics are the daemon's own: latest-[IMPL] lifetime counts
  // must not be truncated by window filtering.
  const commentsByCard = {};
  let probeLimit = 1;
  if (sinceIso === null) {
    sinceIso = new Date(0).toISOString(); // first run = full-board window
    probeLimit = COMMENT_LIMIT;
  }
  const errors = [];
  for (const card of cards) {
    let acts = [];
    try {
      acts = await t.getCardComments(card.id, probeLimit);
    } catch (e) {
      errors.push(`comments ${card.id}: ${e.message}`);
      continue;
    }
    const probe = (acts ?? []).filter((c) => {
      const ms = dateMsOf(c);
      return Number.isFinite(ms) && ms >= Date.parse(sinceIso) && ms <= until;
    });
    if (!probe.length) continue; // untouched in window
    let full = acts;
    if (probeLimit !== COMMENT_LIMIT) {
      try {
        full = await t.getCardComments(card.id, COMMENT_LIMIT);
      } catch (e) {
        errors.push(`comments ${card.id}: ${e.message}`);
        full = acts;
      }
    }
    commentsByCard[card.id] = full ?? [];
  }

  // Ask-on-top scoring (card 6af60d6a85947225f6ed75a0) must cover EVERY
  // needs-human card, even one untouched in the window (parked long ago).
  // `getCardComments(id, 1)` suffices: the API returns newest-first and the
  // scorer re-sorts by parsed date. A fetch failure lands in `errors` and
  // EXCLUDES the card from scoring — no fabricated green or red (D6).
  for (const card of cards) {
    if (!(Array.isArray(card?.labels) && card.labels.some((l) => l?.name === 'needs-human'))) continue;
    if (card.id in commentsByCard) continue; // already fetched (touched in window)
    try {
      commentsByCard[card.id] = (await t.getCardComments(card.id, 1)) ?? [];
    } catch (e) {
      errors.push(`comments ${card.id}: ${e.message}`);
    }
  }

  const report = computeMetrics({ cards, commentsByCard, me, sinceIso, untilIso, prodWatch, daemonLogs });
  for (const e of errors) report.errors.push(e);
  if (since === null && !envStr('FACTORY_METRICS_SINCE') && !state.lastRun) {
    report.window.note = 'first run — window spans full board history';
  }

  let postCard = undefined;
  let discordPing = null;
  if (!noPost) {
    try {
      if (!targetList) {
        errors.push(`open "${listName}" list not found — no summary comment posted this cycle`);
        report.errors.push(`open "${listName}" list not found — no summary comment posted this cycle`);
      } else {
        let reportCard = null;
        if (state.lastReportCardId) {
          reportCard = { id: state.lastReportCardId, url: null };
        } else {
          reportCard = cards.find((c) => c.idList === targetList.id && c.name === REPORT_CARD_TITLE) ?? null;
        }
        if (!reportCard) {
          reportCard = await t.createCard(REPORT_CARD_TITLE, targetList.id, 'Automated factory metrics report card — edited in place by scripts/factory-metrics.js; do not move.');
          log(`created report card ${reportCard.url ?? reportCard.id}`);
          postCard = { id: reportCard.id, url: reportCard.url ?? null, created: true };
        } else {
          postCard = { id: reportCard.id, url: reportCard.url ?? null, created: false };
        }
        try {
          // Compact bounded summary (NEVER the full JSON — Trello caps
          // comment text ~16,384 chars and a full-history report 400s every
          // run, deadlocking the watermark). Full report lives in
          // data/factory-metrics/latest.json + archive (written below).
          await t.addComment(reportCard.id, buildMetricsComment(report));
        } catch (e) {
          // Self-heal a human archive/delete of the pinned report card: the
          // stale lastReportCardId used to short-circuit find-or-create every
          // cycle, so the 404 froze BOTH the pin and the window watermark
          // forever. Clear the pin + persist state (lastRun watermark kept
          // untouched!) so the next run rediscovers or recreates the card;
          // rethrow so the window is still NOT advanced — the same
          // at-least-once retry semantics apply to the recreated card.
          if (e.status === 404 && state.lastReportCardId) {
            state.lastReportCardId = undefined;
            const note = `report card ${reportCard.id} not found (404) — cleared the stale lastReportCardId pin; next run will find-or-create the report card`;
            errors.push(note);
            report.errors.push(note);
            try {
              writeState({ ...state, lastReportCardId: undefined });
            } catch (e2) {
              log(`state write failed: ${e2.message}`);
            }
          }
          throw e;
        }
        // State advances ONLY after a successful post — at-least-once
        // reporting: a failed post retries the same window next run. A state
        // write failure costs a re-report next cycle, never a rejection.
        try {
          writeState({ ...state, lastRun: untilIso, lastReportCardId: reportCard.id });
        } catch (e) {
          log(`state write failed: ${e.message}`);
        }
        postCard.posted = true;
        // Best-effort Discord summary (human request on the card): the same
        // owner ping as ask/done pings. AFTER the board post + state advance,
        // in its OWN try/catch — a Discord failure (or even a throwing fake)
        // never fails the run, never rolls back the window watermark, and
        // never reaches the outer catch that would suppress postCard.
        try {
          const res = await notify({ text: `📊 ${buildMetricsHeadline(report).replace('[METRICS] ', '')}` });
          discordPing = res && res.sent ? { sent: true } : { error: res?.error ?? 'unknown ping result' };
        } catch (e) {
          discordPing = { error: e.message };
        }
        if (discordPing.error) {
          report.errors.push(`discord summary failed: ${discordPing.error} — board post succeeded, next run unaffected`);
          log(`discord summary failed: ${discordPing.error}`);
        }
      }
    } catch (e) {
      errors.push(`summary comment failed: ${e.message} — window will be retried next run`);
      report.errors.push(`summary comment failed: ${e.message} — window will be retried next run`);
    }
  }

  // Artifacts record POSTED reports for `factory-metrics.js status` + the
  // archive audit trail. `--no-post` is zero-write dry diagnostics: skipping
  // them keeps the last real report honest (a dry run must not overwrite
  // latest.json nor forge archive entries that were never posted).
  if (!noPost) {
    try {
      writeArtifacts(report);
    } catch (e) {
      log(`report artifact write failed: ${e.message}`);
      report.errors.push(`report artifact write failed: ${e.message}`);
    }
  }

  return { ok: true, report, postCard, discordPing };
}
