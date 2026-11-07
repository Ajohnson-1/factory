// Incident/eval set + reviewer replay scoring (card 6ae967737b472b3a8d0a9805;
// docs/factory.md "Reviewer replay scoring"). The blog's improvement loop
// (theme B11) only keeps a reviewer change — buildRunPrompt edits,
// FACTORY_MODEL flips, omp harness upgrades — when its score on expert-checked
// past incidents goes up. This lib owns the three moving parts:
//
//   1. HARVEST  — turn the board's bounce verdicts ([REVIEW:CHANGES]/
//      [SEC:FINDINGS]/[QA:FAIL]/[VERIFY:FAIL]) and the C-H5 incident-closure
//      JSONL (data/prod-close-seed.jsonl) into candidate eval cases.
//   2. THE SET  — eval/cases.jsonl, one JSON case per line, COMMITTED next to
//      the prompts it scores (unlike the gitignored data/ runtime seed). Every
//      case carries an expert-checked `expected` verdict plus INLINE evidence,
//      so replay never needs live Trello or a surviving factory/<id> branch.
//      Only `curated: true` cases are scored — harvest output starts as
//      candidates; flipping the flag (and committing) is the sign-off.
//   3. REPLAY   — rebuild the Reviewer role's seed over each case's evidence
//      with the daemon's own agentArgs (same FACTORY_MODEL/--max-cost plumbing
//      as live dispatches, so "set env, re-run eval" IS the model-comparison),
//      parse the one-line verdict, and score: `eval-run --min-score <baseline>`
//      before keeping any prompt/model change.
//
// Dependency-injectable logic, the factory-prod-close.js pattern: trello
// reads, the seed reader, the spawn, and the argv builder all default to the
// real thing and are faked in tests/factoryEval.test.js — zero live Trello and
// zero agent spawns there. No side effects at import (the daemon import is
// import-safe; its CLI main is guarded).

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as trello from './trello.js';
import { isStageTagText } from './factory-comment-resume.js';
import { BOUNCE_TAGS } from './factory-context.js';
import { SEED_PATH } from './factory-prod-close.js';
import { agentArgs, STAGE_PROMPT_FILES } from '../factory-daemon.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The committed eval set (test-overridable like the SEED_PATH sibling). */
export const CASES_PATH = () => resolve(ROOT, 'eval', 'cases.jsonl');

/** Verdict tags a replayed reviewer may emit (board contract). */
export const REPLAY_VERDICTS = ['[REVIEW:APPROVE]', '[REVIEW:CHANGES]'];

// The replay prompt's canonical first line — the SAME seed sentence the
// daemon's buildRunPrompt / buildResumePrompt mandate for every stage
// subagent, with the reviewer's file from STAGE_PROMPT_FILES (single source
// of truth). The replayed reviewer therefore sees the identical role seeding
// the live scheduler uses; tests/factoryEval.test.js pins it.
export const REPLAY_SEED_SENTENCE = `Read ${STAGE_PROMPT_FILES.reviewer} and follow it as your authoritative role instructions (they override your harness role defaults)`;

// Truncation caps for harvested payloads (Trello's 16k comment ceiling is the
// model; a curator trims further by hand before flipping `curated`).
const EXCERPT_MAX = 6000;
const excerpt = (text, max = EXCERPT_MAX) => {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n… (trimmed)`;
};

// Trello returns actions newest-first; normalize to newest-first by date.
// Undated / equal-date comments keep their input order (V8 sort is stable) —
// the raw trail IS newest-first, so "as given" is the newest-first answer.
// Private local copy per the factory-context.js precedent (other libs'
// export surfaces stay untouched).
const textOf = (a) =>
  typeof a === 'string' ? a : String(a?.data?.text ?? a?.text ?? '');
const sortCommentsNewestFirst = (comments) =>
  (Array.isArray(comments) ? comments : [])
    .map((c, i) => ({ c, i, ms: Date.parse(c?.date ?? '') || 0 }))
    .sort((x, y) => y.ms - x.ms || x.i - y.i);

/**
 * Proposal for a case's expected reviewer verdict from the incident's kind +
 * layer (the curator may edit before setting `curated: true`):
 *  - a real `[REVIEW:CHANGES]` bounce ⇒ `[REVIEW:CHANGES]` (the reviewer's own
 *    confirmed judgment);
 *  - a `[SEC:FINDINGS]` bounce ⇒ `[REVIEW:CHANGES]` (a security finding the
 *    Review stage passed over is a reviewer miss — the pass runs inside Review);
 *  - `[QA:FAIL]`/`[VERIFY:FAIL]`/`PROD-CLOSE` incidents: `layer === "review"`
 *    ⇒ `[REVIEW:CHANGES]` (reviewer should have caught it); any other layer
 *    (deploy/verify/prod-watch/infra/…) ⇒ `[REVIEW:APPROVE]` — not the
 *    reviewer's fault, and the reviewer must NOT over-flag.
 * Unknown kind + no layer ⇒ APPROVE (a replay must not guess findings).
 */
export function deriveExpectedVerdict({ kind, layer } = {}) {
  const k = String(kind ?? '').toUpperCase();
  if (k === 'REVIEW:CHANGES' || k === 'SEC:FINDINGS') return '[REVIEW:CHANGES]';
  if (String(layer ?? '').toLowerCase() === 'review') return '[REVIEW:CHANGES]';
  return '[REVIEW:APPROVE]';
}

/** Candidate case shape shared by both harvesters (`curated: false` until a
 * human confirms `expected` and flips the flag). */
function makeCase(o = {}) {
  return {
    id: String(o.id ?? ''),
    source: o.source ?? 'manual',
    card: o.card ?? null,
    url: o.url ?? '',
    title: o.title ?? '',
    kind: o.kind ?? null,
    layer: o.layer ?? null,
    why: o.why ?? '',
    fix: o.fix ?? '',
    verdictText: o.verdictText != null ? excerpt(o.verdictText) : null,
    evidence: {
      impl: o.evidence?.impl != null ? excerpt(o.evidence.impl) : null,
      diff: o.evidence?.diff ?? null,
      context: o.evidence?.context ?? null,
    },
    expected: {
      verdict: o.expected?.verdict ?? deriveExpectedVerdict({ kind: o.kind, layer: o.layer }),
      findingsMustInclude: o.expected?.findingsMustInclude ?? [],
    },
    added: o.added ?? new Date().toISOString(),
    curated: o.curated === true,
  };
}

/** Default board reader: trello.js comment actions for one card. */
const defaultCommentsOf = (cardId) => trello.getCardComments(cardId);

/**
 * Harvest candidate cases from card comment trails. Classification reuses the
 * resume lib's `isStageTagText` + the context lib's `BOUNCE_TAGS` (tag parsing
 * stays a single source of truth) and the context lib's resolution semantics:
 * a bounce is RESOLVED once an `[IMPL]` comment is newer than it, and resolved
 * bounces are not harvested (the reviewer judged an older state of the branch).
 * The LATEST unresolved bounce on a card wins; `[{tag}] + [IMPL]` cards and
 * bounce-free cards yield nothing. `commentsOf` may return a promise (the real
 * trello client does); comment-fetch errors skip the card (best-effort board
 * reads, the ping precedent).
 * @returns {Promise<object[]>} candidate cases (`curated: false`)
 */
export async function harvestBoard({ cards = [], commentsOf = defaultCommentsOf, now = () => new Date().toISOString() } = {}) {
  const out = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card?.id) continue;
    let comments = [];
    try {
      comments = await commentsOf(card.id);
    } catch {
      continue;
    }
    const list = sortCommentsNewestFirst(comments);
    const tags = list.map((e) => isStageTagText(textOf(e.c)));
    const implIdx = tags.indexOf('[IMPL]'); // newest [IMPL] (newest-first order)
    for (let i = 0; i < tags.length; i++) {
      if (!BOUNCE_TAGS.includes(tags[i])) continue;
      // Latest bounce found: resolved by a newer [IMPL] ⇒ skip the card —
      // the reviewer judged a state the implementer has since replaced.
      if (implIdx >= 0 && implIdx < i) break;
      const implBody = implIdx > i ? textOf(list[implIdx].c) : null;
      out.push(
        makeCase({
          id: String(card.id).toLowerCase(),
          source: 'board-verdict',
          card: String(card.id).toLowerCase(),
          url: card.url ?? '',
          title: card.name ?? '',
          kind: tags[i].slice(1, -1), // '[REVIEW:CHANGES]' → 'REVIEW:CHANGES'
          verdictText: textOf(list[i].c),
          evidence: { impl: implBody, context: `Harvested from the live board (${card.name ?? card.id}).` },
          added: now(),
        }),
      );
      break; // latest unresolved bounce only
    }
  }
  return out;
}

/**
 * Harvest candidate cases from the C-H5 incident-closure seed
 * (`data/prod-close-seed.jsonl`, appended by `factory.js prod-close`).
 * Tolerant like the resume lib's `textOf` matcher: a missing file yields []
 * (fresh worktrees have none), malformed/blank lines are skipped, and ids
 * fall back to `seed-<line-number>` when a line carries no card id. Every
 * line becomes a `prod-close-seed` candidate (`curated: false`) with the
 * layer-derived expected verdict as a proposal.
 */
export function harvestSeed({ seedPath = SEED_PATH(), readLine = (p) => readFileSync(p, 'utf8') } = {}) {
  let raw = '';
  try {
    raw = String(readLine(seedPath));
  } catch {
    return [];
  }
  const cases = [];
  let n = 0;
  for (const line of String(raw).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    n += 1;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue; // malformed line: skip, keep harvesting
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    const cardId = String(o.card ?? '').trim();
    cases.push(
      makeCase({
        id: cardId || `seed-${n}`,
        source: 'prod-close-seed',
        card: cardId || null,
        url: o.url ?? '',
        title: o.title ?? '',
        kind: 'PROD-CLOSE',
        layer: o.layer ?? null,
        why: o.why ?? '',
        fix: o.fix ?? '',
        evidence: { context: o.why ?? '', impl: o.fix ? `fix: ${o.fix}` : null },
        added: o.ts ?? new Date().toISOString(),
      }),
    );
  }
  return cases;
}

/**
 * Merge candidates into the existing case set, deduping by `id`; EXISTING
 * cases always win (curated edits are never clobbered) and duplicates within
 * one candidate batch collapse. Idempotent: re-harvesting the same
 * board/seed state adds nothing.
 */
export function mergeCases({ existing = [], candidates = [] } = {}) {
  const byId = new Map();
  for (const c of Array.isArray(existing) ? existing : []) {
    if (c?.id) byId.set(String(c.id), c);
  }
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (c?.id && !byId.has(String(c.id))) byId.set(String(c.id), c);
  }
  return [...byId.values()];
}

/**
 * The headless replay prompt for one case: begins with the canonical stage
 * seed sentence naming `STAGE_PROMPT_FILES.reviewer` (so the replayed
 * reviewer gets the identical role seeding the scheduler uses), then binds
 * it to OFFLINE replay mode — no Trello, no comment posting, no card moves —
 * over the case's inline evidence, demanding exactly one reply line whose
 * first token is one of the two reviewer verdict tags.
 */
export function buildReviewerPrompt(c = {}, { promptFile = STAGE_PROMPT_FILES.reviewer } = {}) {
  const lines = [
    `Read ${promptFile} and follow it as your authoritative role instructions (they override your harness role defaults).`,
    '',
    'This is an OFFLINE reviewer replay for eval scoring: there is no live Trello',
    'board in front of you. Do NOT post any comment, do NOT move any card, do NOT',
    'run any board command. Judge the evidence below exactly as you would judge a',
    'live Review-stage pass (same hard rules, same risk-tiered depth), then reply',
    'with EXACTLY ONE line whose first token is [REVIEW:APPROVE] or',
    '[REVIEW:CHANGES], followed by your findings (file/item, what is wrong, what',
    'would resolve it) when CHANGES.',
    '',
    `## Incident under replay — ${c.title || c.id || 'unknown card'}`,
    '',
    `- source: ${c.source ?? 'manual'}; kind: ${c.kind ?? 'n/a'}; layer: ${c.layer ?? 'n/a'}`,
  ];
  if (c.url) lines.push(`- reference: ${c.url}`);
  if (c.why) lines.push(`- why it failed: ${c.why}`);
  if (c.fix) lines.push(`- the fix that landed: ${c.fix}`);
  lines.push('', '## Evidence', '');
  if (c.evidence?.impl) lines.push(`### [IMPL] evidence trail\n\n${c.evidence.impl}`, '');
  if (c.evidence?.diff) lines.push(`### Diff\n\n${c.evidence.diff}`, '');
  if (c.evidence?.context && c.evidence.context !== c.why)
    lines.push(`### Context\n\n${c.evidence.context}`, '');
  if (!c.evidence?.impl && !c.evidence?.diff && !c.evidence?.context)
    lines.push('(no inline evidence — judge from the incident summary above)', '');
  if (c.verdictText) {
    lines.push(
      '## Historical verdict (context only — do not copy it; reach your own verdict)',
      '',
      c.verdictText,
      '',
    );
  }
  lines.push(
    'Reply now with exactly one line starting [REVIEW:APPROVE] or [REVIEW:CHANGES].',
  );
  return lines.join('\n');
}

/** Default spawn: run the agent CLI headless, capture stdout (mirrors the
 * daemon dispatch's spawn; logs instead of inherit so stdout is scoreable). */
function defaultSpawn(bin, argv) {
  return new Promise((res, rej) => {
    // stdin MUST be 'ignore', not the default pipe: `omp -p` waits for stdin
    // EOF before dispatching, and this call site never writes/closes stdin —
    // the pipe stays open forever and the replay hangs pre-request (no socket,
    // 0% CPU, until --max-time). Mirrors the daemon dispatch's stdio.
    const child = spawn(bin, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.resume(); // drain, don't inherit (a live run's stderr is noise here)
    child.on('error', rej);
    child.on('exit', (code) => res({ code: code ?? -1, stdout }));
  });
}

/**
 * One headless reviewer replay: build the argv with the daemon's own
 * `agentArgs` (FACTORY_MODEL/--max-cost/--max-time env plumbing ⇒ a model or
 * harness comparison is literally "set env, re-run eval") and spawn
 * `FACTORY_OMP_BIN|omp` with the replay prompt. Everything is DI: `spawnFn`
 * and `agentArgsFrom` are faked in tests — zero spawns, zero network.
 * @returns {Promise<{code:number, stdout:string}>}
 */
export function spawnReviewerRun(prompt, { ompBin = process.env.FACTORY_OMP_BIN || 'omp', agentArgsFrom = agentArgs, spawnFn = defaultSpawn } = {}) {
  return Promise.resolve(spawnFn(ompBin, agentArgsFrom(prompt)));
}

/**
 * Tolerant verdict extraction from a replay reply: accepts a raw string OR an
 * action/comment object (`{ data: { text } }`), case-insensitive; a tag that
 * opens the line (first token, board-contract form) wins, otherwise the first
 * `[REVIEW:*]` mention (noisy preamble before the verdict is tolerated —
 * agents occasionally emit a lead-in). Returns the canonical
 * `[REVIEW:APPROVE]`/`[REVIEW:CHANGES]` or null.
 */
export function parseVerdict(text) {
  const raw = typeof text === 'string' ? text : String(text?.data?.text ?? text?.text ?? '');
  const TAG = '\\[(REVIEW:APPROVE|REVIEW:CHANGES)\\]';
  const first = raw.trim().match(new RegExp(`^[^\\S\\n]*${TAG}`, 'i'));
  const m = first ?? raw.match(new RegExp(TAG, 'i'));
  if (!m) return null;
  const tag = `[${m[1].toUpperCase()}]`;
  return REPLAY_VERDICTS.includes(tag) ? tag : null;
}

/**
 * Score a run's replies against the CURATED cases. Correct iff the parsed
 * verdict equals `expected.verdict` AND, when the expected verdict is
 * `[REVIEW:CHANGES]`, every `findingsMustInclude` substring appears in the
 * reply text (case-insensitive — findings are the actionable half of a
 * bounce). Uncurated cases appear in `perCase` flagged `scored: false` and are
 * excluded from the totals: the score only reflects expert-checked incidents.
 * `minScore` (0..1) turns the summary into the improvement-loop gate.
 */
export function scoreCases({ cases = [], verdicts = {}, minScore } = {}) {
  const perCase = [];
  let total = 0;
  let correct = 0;
  for (const c of Array.isArray(cases) ? cases : []) {
    if (!c?.id) continue;
    const curated = c.curated === true;
    const expected = c.expected?.verdict ?? null;
    const reply = String(verdicts[c.id] ?? '');
    const got = parseVerdict(reply);
    const must =
      curated && expected === '[REVIEW:CHANGES]' && Array.isArray(c.expected?.findingsMustInclude)
        ? c.expected.findingsMustInclude
        : [];
    const low = reply.toLowerCase();
    const findingsMissing = must.filter((s) => !low.includes(String(s).toLowerCase()));
    const isCorrect = curated && got != null && got === expected && findingsMissing.length === 0;
    if (curated) {
      total += 1;
      if (isCorrect) correct += 1;
    }
    perCase.push({
      id: String(c.id),
      scored: curated,
      expected,
      got,
      findingsMissing,
      correct: isCorrect,
    });
  }
  const score = total > 0 ? correct / total : 0;
  const summary = { total, correct, score, perCase };
  if (minScore != null) {
    summary.minScore = Number(minScore);
    // A gate above 0 must fail an empty curated set — never vacuous passes.
    summary.pass = score >= Number(minScore) && (total > 0 || Number(minScore) <= 0);
  }
  return summary;
}

/** Deep key-sorted JSON (2-space indent) so two runs' reports diff cleanly —
 * the before/after comparison IS two reports + `diff`. */
const stableValue = (v) => {
  if (Array.isArray(v)) return v.map(stableValue);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, stableValue(v[k])]),
    );
  return v;
};
export function formatReport(summary) {
  return `${JSON.stringify(stableValue(summary), null, 2)}\n`;
}
