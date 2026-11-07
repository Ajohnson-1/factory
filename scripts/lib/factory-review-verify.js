// Review-finding verifier for the software factory (card 6ae9676c5392eefe0202017f).
// Pipeline spec: docs/factory.md ("Verifying reviewer findings").
//
// Root cause this fixes: one reviewer's `[REVIEW:CHANGES]` used to be
// authoritative — every finding, whether a real defect, a stylistic nit, or a
// condition inherited from master, drove a full Implement re-run counted
// against the 3-bounce cap. A false-positive finding could burn a whole slot.
// Now a Review-verify sub-step runs between Review and bounce: the scheduler
// spawns one fresh-context READ-ONLY verifier per finding (prompt from
// `buildVerifierPrompt` here) which classifies the finding `real` /
// `style-only` / `pre-existing`; the collected classifications are piped to
// `factory.js review-verify <card> -` and this lib applies the authoritative
// mapping matrix, posts exactly ONE `[REVIEW:VERIFY]` verdict comment, and
// returns the routing decision. Only CONFIRMED Important findings bounce;
// Nits never consume a bounce; Pre-existing findings are logged, never block.
//
// Bounce counting moves out of LLM arithmetic into `countBounces` (exposed as
// `factory.js bounces <card>`): a `[REVIEW:CHANGES]` counts iff its paired
// `[REVIEW:VERIFY]` says `decision=bounce` (a `proceed` verdict nets the pair
// to zero) or, legacy/fail-closed, iff no `[REVIEW:VERIFY]` ever followed it;
// `[SEC:FINDINGS]` (the blocking security sub-pass), `[QA:FAIL]` and
// `[VERIFY:FAIL]` count unconditionally. Absent classifications fail closed
// too — an unverified Important finding keeps its bounce (verification only
// ever REMOVES bounce power).
//
// Dependency-injectable logic, the factory-audit-cards.js pattern: every seam
// (trello client) defaults to the real thing and is faked in
// tests/factoryReviewVerify.test.js — zero live Trello there.

import * as trello from './trello.js';

/** Needs-human parking threshold (docs/factory.md "Scheduler loop"). */
export const BOUNCE_CAP = 3;

/** Reviewer finding-severity tags (board contract). */
export const SEVERITIES = ['Important', 'Nit', 'Pre-existing'];

/** Verifier classification tokens. */
export const VERDICTS = ['real', 'style-only', 'pre-existing'];

// A finding line carries a severity marker: `[-] [Important] …`, `1. [NIT] …`,
// `* [Pre-Existing] …` (list markers optional — a bare tagged line counts).
// Canonicalizes `pre-existing` / `pre existing` → `Pre-existing`.
const FINDING_RE = /^\s*(?:[-*]|\d+\.)?\s*\[(important|nit|pre[-\s]existing)\]\s*(.+)$/i;

// Legacy fallback marker: a `-`/`*`/`N.` bullet in a comment with ZERO tagged
// lines (pre-convention reviewer) — severity Important (fail-closed).
const BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+\S/;

const severityRe = (sev) => new RegExp(`^\\s*(?:[-*]|\\d+\\.)?\\s*\\[${sev}\\]`, 'i');
const tagRe = (tag) => new RegExp(`^\\[${tag}\\]`, 'i');

/** Comment body text: raw string OR an action/comment object (resume-lib convention). */
const textOf = (a) =>
  typeof a === 'string' ? a : String(a?.data?.text ?? a?.text ?? '');

/**
 * Chronological ascending order, same comparator family as `latestStageTag`
 * (factory-comment-resume.js): newest-first Trello input becomes oldest-first;
 * same-date ties keep chronology (Trello list order reversed); malformed/absent
 * dates sort oldest (fail-closed: they precede every verdict they might pair
 * with). `getCardComments` returns newest-first — this sorts.
 */
function chrono(comments) {
  return (Array.isArray(comments) ? comments : [])
    .map((c, i) => ({ c, i, ms: Date.parse(c?.date ?? '') }))
    .sort((x, y) => {
      const xm = Number.isFinite(x.ms) ? x.ms : Number.NEGATIVE_INFINITY;
      const ym = Number.isFinite(y.ms) ? y.ms : Number.NEGATIVE_INFINITY;
      return xm - ym || y.i - x.i;
    })
    .map((e) => e.c);
}

/**
 * Findings out of a full `[REVIEW:CHANGES]` comment body. Findings are lines
 * carrying a `[Important]` / `[Nit]` / `[Pre-existing]` severity marker (all
 * list-marker styles, case-insensitive). Prose lines (verdict sentence,
 * mergeability note) are not findings. A non-empty body with ZERO tagged lines
 * falls back to one finding per bullet, severity `Important` — the fail-closed
 * default for legacy untagged comments (they then get a verifier too).
 * `index` is the 1-based ordinal over parsed findings. Pure — no IO.
 */
export function parseFindings(changesText) {
  const lines = String(changesText ?? '').split('\n');
  const findings = [];
  const canon = (raw) => {
    const s = raw.toLowerCase();
    if (s.startsWith('important')) return 'Important';
    if (s.startsWith('nit')) return 'Nit';
    return 'Pre-existing';
  };
  for (const line of lines) {
    const m = line.match(FINDING_RE);
    if (m) findings.push({ index: findings.length + 1, severity: canon(m[1]), text: m[2].trim() });
  }
  if (findings.length > 0) return findings;
  for (const line of lines) {
    if (BULLET_RE.test(line)) {
      findings.push({ index: findings.length + 1, severity: 'Important', text: line.trim() });
    }
  }
  return findings;
}

// Authoritative classification → final-severity matrix (docs/factory.md
// "Verifying reviewer findings"): verifier authority only ever REMOVES bounce
// power — `real` never promotes a Nit, `pre-existing` never bounces regardless
// of reviewer tag. Absent classification: reviewer severity stands
// (fail-closed — dropping findings because verification was skipped is the
// failure mode this card fixes, not reintroduced in reverse).
const MATRIX = {
  Important: { real: 'Important', 'style-only': 'Nit', 'pre-existing': 'Pre-existing' },
  Nit: { real: 'Nit', 'style-only': 'Nit', 'pre-existing': 'Pre-existing' },
  'Pre-existing': { real: 'Pre-existing', 'style-only': 'Pre-existing', 'pre-existing': 'Pre-existing' },
};

/**
 * Apply `{ index, verdict, why }` classifications to parsed findings. A
 * verdict outside VERDICTS throws (a typo'd classification must not silently
 * fall through); a classification index with no matching finding throws.
 * Returns one row per finding: `{ index, severity, verdict|null, why|null,
 * final }`. Pure — no IO.
 */
export function applyClassifications(findings, classes) {
  const byIndex = new Map((findings ?? []).map((f) => [f.index, f]));
  const cls = new Map();
  for (const c of classes ?? []) {
    if (!byIndex.has(c?.index)) {
      throw new Error(`classification index ${String(c?.index)} matches no finding`);
    }
    if (!VERDICTS.includes(c.verdict)) {
      throw new Error(`unknown verdict "${String(c.verdict)}" for finding #${c.index} (expected one of: ${VERDICTS.join(', ')})`);
    }
    cls.set(c.index, c);
  }
  return (findings ?? []).map((f) => {
    const c = cls.get(f.index) ?? null;
    const final = c ? MATRIX[f.severity][c.verdict] : f.severity;
    return { index: f.index, severity: f.severity, verdict: c?.verdict ?? null, why: c?.why ?? null, final };
  });
}

/**
 * Bounce-relevant counts from classified rows: ONLY final severity Important
 * (a CONFIRMED finding) drives `bounce` — Nits and Pre-existing never do.
 * Pure — no IO.
 */
export function tally(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const confirmed = list.filter((r) => r.final === 'Important').length;
  const nits = list.filter((r) => r.final === 'Nit').length;
  const preExisting = list.filter((r) => r.final === 'Pre-existing').length;
  return { confirmed, nits, preExisting, bounce: confirmed > 0 };
}

/**
 * The `[REVIEW:VERIFY]` verdict comment (docs/factory.md format): parseable
 * header + one `#<index> [<from>→<to>]` line per finding + the standing
 * disposition notes. Exactly one comment per Review-verify execution, posted
 * by the scheduler run via `factory.js review-verify` — verifier subagents
 * post nothing themselves.
 */
export function formatVerifyComment(rows, { bounces = 0 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const t = tally(list);
  const decision = t.bounce ? 'bounce' : 'proceed';
  const lines = [
    `[REVIEW:VERIFY] decision=${decision} confirmed=${t.confirmed} nits=${t.nits} pre-existing=${t.preExisting} bounces=${bounces}/${BOUNCE_CAP}`,
  ];
  for (const r of list) {
    const why = r.why ?? 'no verifier classification — reviewer severity stands (fail-closed)';
    const verdict = r.verdict ?? 'unverified';
    lines.push(`#${r.index} [${r.severity}→${r.final}] ${verdict}: ${why}`);
  }
  lines.push(
    'Nits never bounce; they are fixed on the next Implement re-run if one happens.',
    'Pre-existing findings do not block this card — log them for a follow-up card.',
  );
  return lines.join('\n');
}

/**
 * The routing decision inside a `[REVIEW:VERIFY]` comment text:
 * `'bounce' | 'proceed'`, or null for non-verdict / unreadable text.
 */
export function parseVerifyDecision(verifyText) {
  const text = textOf(verifyText).trim();
  if (!tagRe('REVIEW:VERIFY').test(text)) return null;
  const m = text.match(/decision=(bounce|proceed)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Bounce count over a card's comment trail — the needs-human ≥3 gate reads
 * this, not LLM arithmetic. One chronological pass (date-ascending,
 * `chrono()`): `[QA:FAIL]`, `[VERIFY:FAIL]`, `[CHECK:FAIL]` (the daemon's
 * blocking-checks gate, card 6ae9677239bb2697a13ea728 — counted exactly like
 * `[VERIFY:FAIL]` per the board contract) and `[SEC:FINDINGS]` (the blocking
 * security sub-pass, card 6ae9676cb5da50bc61241a0f) count unconditionally;
 * `[REVIEW:CHANGES]` counts tentatively; a later `[REVIEW:VERIFY]` resolves
 * the YOUNGEST unresolved pair — `proceed` nets it to zero, `bounce` keeps
 * the count. An unresolved `[REVIEW:CHANGES]` stays counted (legacy in-flight
 * cards + fail-closed). Orphan `[REVIEW:VERIFY]` comments (no pending pair)
 * change nothing. Returns
 * `{ bounces, cap, park, breakdown: { review, sec, qa, check, verify } }`. Pure — no IO.
 */
export function countBounces(comments) {
  const breakdown = { review: 0, sec: 0, qa: 0, check: 0, verify: 0 };
  let unresolved = 0;
  for (const c of chrono(comments)) {
    const text = textOf(c).trim();
    if (tagRe('QA:FAIL').test(text)) breakdown.qa += 1;
    else if (tagRe('VERIFY:FAIL').test(text)) breakdown.verify += 1;
    else if (tagRe('CHECK:FAIL').test(text)) breakdown.check += 1;
    else if (tagRe('SEC:FINDINGS').test(text)) breakdown.sec += 1;
    else if (tagRe('REVIEW:CHANGES').test(text)) {
      breakdown.review += 1;
      unresolved += 1;
    } else if (tagRe('REVIEW:VERIFY').test(text)) {
      if (unresolved > 0) {
        unresolved -= 1;
        if (parseVerifyDecision(text) === 'proceed') breakdown.review -= 1;
      }
    }
  }
  const bounces = breakdown.review + breakdown.sec + breakdown.qa + breakdown.check + breakdown.verify;
  return { bounces, cap: BOUNCE_CAP, park: bounces >= BOUNCE_CAP, breakdown };
}

/**
 * Headless prompt for ONE fresh-context verifier subagent (per finding —
 * docs/factory.md "Verifying reviewer findings"). Read-only: classify the
 * finding `real` | `style-only` | `pre-existing` with a one-line rationale;
 * the scheduler run collects the N answers into the classifications JSON and
 * pipes it to `factory.js review-verify <card> -`.
 */
export function buildVerifierPrompt(card, { index, severity, text }) {
  return [
    `You are a fresh-context, READ-ONLY verifier for Trello card ${card.id} "${card.name}".`,
    `Verify exactly ONE reviewer finding — finding #${index} (reviewer tagged it [${severity}]):`,
    text,
    'Verify against the code, not the reviewer\'s prose: read the diff (`git diff origin/master...factory/' + card.id + '`), the worktree files, and origin/master (`git show origin/master:<path>`) to check whether the condition predates this branch.',
    'HARD CONSTRAINT: you are READ-ONLY — no edits, no commits, no comments on the card, no moving the card, no npm installs.',
    'Answer with EXACTLY one classification token and a one-line rationale:',
    '`real` — a genuine defect introduced by this branch;',
    '`style-only` — cosmetic/style preference, no correctness impact (downgrades to a Nit);',
    '`pre-existing` — the condition already exists on origin/master, not introduced here.',
  ].join('\n');
}

/**
 * One Review-verify execution (the scheduler's `review-verify` command core):
 * fetch the trail, parse the LATEST `[REVIEW:CHANGES]` (newest round wins —
 * older rounds' verdicts are already posted), apply classifications, count
 * bounces INCLUDING the verdict about to land (proceed nets its tentative
 * pair to zero; bounce keeps it — a lone orphan verdict never counts, so
 * re-verifying a resolved round adds 0 either way), post exactly ONE
 * `[REVIEW:VERIFY]` comment, return the routing verdict.
 * Throws (CLI: exit 1) on misuse: no `[REVIEW:CHANGES]`, zero parseable
 * findings, malformed classification payload. A `decision` is routing, not
 * failure — `bounce` still returns normally (CLI exit 0).
 */
export async function runReviewVerify({ cardId, classifications, t = trello } = {}) {
  const comments = await t.getCardComments(cardId);
  const changes = [...chrono(comments)]
    .reverse()
    .find((c) => tagRe('REVIEW:CHANGES').test(textOf(c).trim()));
  if (!changes) throw new Error('no [REVIEW:CHANGES] comment to verify');
  const findings = parseFindings(textOf(changes));
  if (findings.length === 0) throw new Error('[REVIEW:CHANGES] comment has no parseable findings');
  if (classifications == null || !Array.isArray(classifications)) {
    throw new Error('classifications payload must be a JSON array');
  }
  const rows = applyClassifications(findings, classifications);
  const counts = tally(rows);
  const base = countBounces(comments);
  const bounces = counts.bounce ? base.bounces : base.bounces - 1;
  const comment = formatVerifyComment(rows, { bounces });
  await t.addComment(cardId, comment);
  return {
    card: cardId,
    findings: rows,
    confirmed: counts.confirmed,
    nits: counts.nits,
    preExisting: counts.preExisting,
    bounce: counts.bounce,
    decision: counts.bounce ? 'bounce' : 'proceed',
    bounces,
    park: bounces >= BOUNCE_CAP,
  };
}
