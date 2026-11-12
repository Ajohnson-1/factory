// Risk-tiered human approval before Deploy (card 6ae9676d0ee4189387157881).
// Pipeline spec + protocol: docs/factory.md ("Risk-tiered approval before Deploy").
//
// The *change*, not the author, decides whether a human must look before
// Deploy. Every card diff classifies into a tier:
//   high   — always-human paths (deploy scripts, config/, credentials, CI,
//            Docker) OR blast radius (churn ≥ HIGH_CHURN_LINES, files ≥
//            HIGH_FILE_COUNT). Human approval REQUIRED before merge+Deploy.
//   low    — docs-only, additive-only, or an empty diff: zero-human path,
//            unchanged.
//   medium — everything else: human approval REQUIRED.
// For medium/high the scheduler run passes a gate AFTER [QA:PASS] and BEFORE
// `git merge --ff-only`: a human-authored (NEVER bot-authored) card comment
// keyed to the EXACT sha that passed QA. The merge is always `--ff-only`, so
// the QA sha and the deployed master sha are byte-identical — the comment
// keys to the deployed sha too.
//
// Waiting reuses the ask protocol (scripts/lib/factory-ask.js) verbatim:
// `askHuman({ noWait: true })` posts `[ASK]` + pings Discord once, then a
// loop of `waitForHuman` collects replies — each qualifying reply is
// re-checked for the sha; a wrong-sha reply does NOT count and does NOT
// re-post the ask (one ask post/ping, the wait window advances). Timeout →
// {approved:false, timedOut:true} → CLI exit 1 → the scheduler parks the
// card `needs-human` in QA (NOT a bounce: the gate posts no
// [REVIEW:CHANGES]/[QA:FAIL]/[VERIFY:FAIL], so bounce budget is untouched;
// recovery = approve late on the card, drag back to Ready — the re-run's
// existing-approval scan short-circuits. Comments are the state).
//
// Dependency-injectable logic, the factory-ask.js pattern: every seam
// (trello client, git, notify, sleep, clock) defaults to the real thing and
// is faked in tests/factoryRisk.test.js — zero live Trello/Discord/git in
// tests.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as trello from './trello.js';
import { askHuman, waitForHuman, extractHumanReply, sendOwnerPing, envNum, isBotMember } from './factory-ask.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- Tunables (exported so tests/tuners never hardcode) --------------------

/** Total churn (additions + deletions) at/above this is `high`. */
export const HIGH_CHURN_LINES = 1500;
/** File count at/above this is `high`. */
export const HIGH_FILE_COUNT = 25;

/** Always-human path patterns (regex on the raw numstat path string): deploy
 *  scripts, config/, credentials, CI-adjacent (.github/, Docker/compose) and
 *  the prod-host scripts. Any match → `high` regardless of diff size. */
export const ALWAYS_HUMAN = [
  /^scripts\/deploy\.js$/,
  /^scripts\/verify-deploy\.js$/,
  /^scripts\/prod-watch\.js$/,
  /^scripts\/lib\/deploy-/,
  /^scripts\/deploy-factory\.js$/,
  /^scripts\/verify-factory\.js$/,
  /(^|\/)factory-repos[^/]*\.json$/,
  /^config\//,
  /^\.github\//,
  /(^|\/)Dockerfile/,
  /(^|\/)docker-compose[^/]*\.ya?ml$/,
  /(^|\/)deploy-host-logs\.sh$/,
  /(^|\/)provision-deploy-host\.sh$/,
  /^\.env/,
  /(^|\/)[^/]*\.(pem|key)$/,
  /secret/i,
  /credential/i,
];

/** Docs-only classifier: docs/**, plans/** or any *.md file. */
export const DOCS_PATH = /^docs\/|^plans\/|\.md$/i;

/** Default approval timeout: FACTORY_APPROVAL_TIMEOUT_MS →
 *  FACTORY_ASK_TIMEOUT_MS → 1 h (mirrors the ask default). */
export const approvalTimeoutDefault = () =>
  envNum('FACTORY_APPROVAL_TIMEOUT_MS', envNum('FACTORY_ASK_TIMEOUT_MS', 3_600_000));

/** The `[ASK]` question template. Fixed shape: carries tier + reasons, the
 *  sha appears twice (display + reply instruction), and states the
 *  stale-sha rule (a rebase needs a NEW approval). */
export const approvalAskText = ({ tier, reasons, sha }) =>
  `Approval required (risk tier ${tier}: ${reasons.join('; ')}). ` +
  `Merge+Deploy of sha ${sha} is held until a human approves THIS sha. ` +
  `To approve, post a comment containing the sha, e.g. "[HUMAN] APPROVED ${sha}". ` +
  `Comments keyed to another sha do not count — after a rebase/QA re-run a new approval is required.`;

// --- Tier classification (pure) ---------------------------------------------

/**
 * Classify pre-parsed numstat rows. Pure — no I/O.
 * `files`: [{ path, additions, deletions, binary? }].
 * First match wins, checked in this order: always-human path → blast radius
 * (churn ≥ HIGH_CHURN_LINES or files ≥ HIGH_FILE_COUNT) → low (docs-only OR
 * additive-only with no binary entries) → medium. An empty diff is low
 * ('empty diff'): nothing to approve. Binary entries NEVER satisfy
 * additive-only (they map to 0/0, so they must not slip through as
 * "additions") — a binary-only diff fails toward medium.
 * → { tier, reasons, files, additions, deletions }
 */
export function classifyDiff(files) {
  const list = Array.isArray(files) ? files : [];
  const additions = list.reduce((s, f) => s + (Number(f?.additions) || 0), 0);
  const deletions = list.reduce((s, f) => s + (Number(f?.deletions) || 0), 0);
  const base = { files: list, additions, deletions };

  if (list.length === 0) return { ...base, tier: 'low', reasons: ['empty diff'] };

  const alwaysHuman = new Set();
  for (const f of list) {
    const path = String(f?.path ?? '');
    for (const re of ALWAYS_HUMAN) {
      if (re.test(path)) alwaysHuman.add(String(re));
    }
  }
  if (alwaysHuman.size) {
    return { ...base, tier: 'high', reasons: [`always-human paths: ${[...alwaysHuman].join(', ')}`] };
  }
  if (additions + deletions >= HIGH_CHURN_LINES) {
    return { ...base, tier: 'high', reasons: [`churn ${additions + deletions} ≥ ${HIGH_CHURN_LINES} lines`] };
  }
  if (list.length >= HIGH_FILE_COUNT) {
    return { ...base, tier: 'high', reasons: [`${list.length} files ≥ ${HIGH_FILE_COUNT}`] };
  }
  const docsOnly = list.every((f) => DOCS_PATH.test(String(f?.path ?? '')));
  if (docsOnly) {
    return { ...base, tier: 'low', reasons: ['docs-only diff'] };
  }
  const hasBinary = list.some((f) => f?.binary === true);
  if (!hasBinary && list.every((f) => (Number(f?.deletions) || 0) === 0)) {
    return { ...base, tier: 'low', reasons: ['additive-only diff (no deletions)'] };
  }
  return { ...base, tier: 'medium', reasons: ['code diff with edits'] };
}

// --- Diff plumbing -----------------------------------------------------------

const realGit = (argv) =>
  execFileSync('git', argv, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Resolve a rename row's NEW path: `old.js => new.js` or `dir/{old.js =>
 *  new.js}.ext` (brace form keeps the prefix/suffix). Plain paths pass
 *  through untouched. */
function renameNewPath(path) {
  if (!path.includes(' => ')) return path;
  const brace = path.match(/^(.*)\{(.*?) => (.*?)\}(.*)$/);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`;
  return path.split(' => ').at(-1);
}

/**
 * Diff of `branch` vs merge-base with `target` (three-dot equivalent).
 * `git(argv) → stdout string` injectable (default real git at ROOT).
 * Throws when merge-base fails — same failure surface as `mergeable`.
 * numstat semantics: `-` (binary) → additions/deletions 0 with `binary: true`.
 * Raw parse only (no tiering — callers classify via `classifyDiff`).
 * → { files: [{path, additions, deletions, binary}], additions, deletions, mergeBase }
 */
export function getDiffStat({ branch, target = 'origin/master', git = realGit } = {}) {
  const mergeBase = String(git(['merge-base', target, branch])).trim();
  const out = String(git(['diff', '--numstat', mergeBase, branch]));
  const files = [];
  let additions = 0;
  let deletions = 0;
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    if (!binary) {
      additions += Number(m[1]);
      deletions += Number(m[2]);
    }
    files.push({
      path: renameNewPath(m[3]),
      additions: binary ? 0 : Number(m[1]),
      deletions: binary ? 0 : Number(m[2]),
      binary,
    });
  }
  return { files, additions, deletions, mergeBase };
}

// --- Approval matching --------------------------------------------------------

/** Regex matching a full sha or any ≥7-char hex prefix of `sha`
 *  (word-bounded, case-insensitive). */
export function shaMentionRe(sha) {
  const s = String(sha ?? '').toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(s)) {
    throw new Error(`Invalid sha (expected 7-40 hex chars): ${sha}`);
  }
  return new RegExp(`\\b${s.slice(0, 7)}[0-9a-f]{0,33}\\b`, 'i');
}

/**
 * Earliest sha-keyed HUMAN approval among Trello commentCard actions (items
 * carry `{ id, date, data.text, memberCreator }`; `null` items are ignored).
 * Qualification REUSES the ask protocol's `extractHumanReply` rules verbatim —
 * run per action with no date filter, then post-filter on the sha (no
 * copy-paste of author logic): the author must be a member other than `bot`
 * (isBotMember rules — prefer id, fall back to username) OR the text must
 * start with `[HUMAN]` AND not be bot-authored. Bot-authored NEVER counts,
 * even tagged `[HUMAN]` with the sha (criterion 3). `bot=null` (identity
 * lookup degraded) → tagged-only, same fail-closed trade-off as the ask
 * protocol. No date filter: an approval posted at ANY time before the scan
 * counts — "comments are the state" (the recovery path: approve late, drag
 * back to Ready, the re-run's scan short-circuits).
 * → { text, date, author, via, commentId } | null
 */
export function findApprovalComment(actions, { sha, bot } = {}) {
  const re = shaMentionRe(sha);
  const matches = [];
  for (const a of actions ?? []) {
    if (a == null) continue;
    // Bot-authored NEVER counts — criterion 3. The ask protocol's `[HUMAN]`
    // tag fast-path is author-agnostic (its bot never posts `[HUMAN]`), so
    // a bot comment tagged `[HUMAN] <sha>` would qualify there; approvals
    // are stricter. isBotMember = the ask protocol's own rules (imported).
    if (isBotMember(a?.memberCreator, bot)) continue;
    const qualified = extractHumanReply([a], { bot });
    if (!qualified) continue;
    const text = String(a?.data?.text ?? a?.text ?? '').trim();
    if (!re.test(text)) continue;
    matches.push({ ...qualified, commentId: a.id });
  }
  matches.sort((x, y) => String(x.date).localeCompare(String(y.date)));
  return matches[0] ?? null;
}

// --- The gate ------------------------------------------------------------------

/**
 * The risk gate (docs/factory.md "Risk-tiered approval before Deploy").
 * Deps injectable: t (trello client), git, notify (defaults to sendOwnerPing;
 * failure recorded, never thrown), sleep/now (clock seams).
 * Flow:
 *   tier (auto-classified via getDiffStat when not supplied) low →
 *     { required:false, approved:true } with ZERO board calls (criterion 2).
 *   else: existing sha-keyed approval (ANY date — an approval the human
 *     posted earlier, even before this run started, counts: comments are the
 *     state) → { approved:true, via:'existing-comment' }, zero addComment.
 *   else: ONE askHuman({ noWait:true }) post + Discord ping, then a loop of
 *     waitForHuman (date-based; ask once, wait many times). Each qualifying
 *     human reply is re-checked for the sha; a wrong-sha reply is skipped and
 *     the window advances past it (ONE ask post/ping for the whole window,
 *     deadline = original ask + timeoutMs). Expiry → timedOut.
 * → { tier, reasons, required, approved, via?, timedOut?, sha, askCommentId?,
 *     reply?, discord?, polls, waitedMs }
 */
export async function approvalGate({
  cardId,
  sha,
  branch,
  target = 'origin/master',
  tier,
  reasons,
  timeoutMs = approvalTimeoutDefault(),
  intervalMs = envNum('FACTORY_ASK_POLL_MS', 30_000),
  t = trello,
  git = realGit,
  notify = sendOwnerPing,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date().toISOString(),
} = {}) {
  const startMs = Date.parse(now());
  let cls = { tier, reasons: reasons ?? [] };
  if (!cls.tier) cls = classifyDiff(getDiffStat({ branch, target, git }).files);
  const out = { tier: cls.tier, reasons: cls.reasons, sha };
  if (cls.tier === 'low') {
    return { ...out, required: false, approved: true, polls: 0, waitedMs: 0 };
  }
  let polls = 0;
  let bot = null;
  try {
    if (typeof t.getMe === 'function') bot = (await t.getMe()) ?? null;
  } catch {
    /* identity degraded → tag-only, same fail-closed mode as the ask protocol */
  }
  const actions = await t.getCardComments(cardId);
  polls += 1;
  const existing = findApprovalComment(actions, { sha, bot });
  if (existing) {
    return { ...out, required: true, approved: true, via: 'existing-comment', reply: existing, polls, waitedMs: Date.parse(now()) - startMs };
  }
  // Date floor: the ask moment captured BEFORE askHuman (post + getCard +
  // Discord ping cost seconds), truncated to whole seconds — the ask
  // protocol's comment-date semantics (factory-ask.js floors at the `[ASK]`
  // comment's server date): Trello comment dates are second-granular, so
  // approvals stamped in the ask's own second or during the ping-latency
  // window survive the `ms >= sinceMs` filter instead of burning the full
  // timeout. The `[ASK]` question quotes the sha, so the bot's own echo must
  // never pass as the approval — it never does: it is bot-authored and
  // untagged, so the ask protocol's qualification (author rules + `[HUMAN]`
  // tag) drops it on every poll, never the date window.
  const askFloorIso = new Date(Math.floor(Date.parse(now()) / 1000) * 1000).toISOString();
  const asked = await askHuman({
    cardId,
    question: approvalAskText({ tier: cls.tier, reasons: cls.reasons, sha }),
    noWait: true,
    t,
    notify,
    sleep,
    now,
  });
  const out0 = {
    ...out,
    required: true,
    askCommentId: asked.askCommentId,
    discord: asked.discord,
  };
  let sinceIso = askFloorIso;
  const deadlineMs = Date.parse(sinceIso) + timeoutMs;
  let waitedMs = Date.parse(now()) - startMs;
  for (;;) {
    const remaining = deadlineMs - Date.parse(now());
    if (remaining <= 0) {
      return { ...out0, approved: false, timedOut: true, polls, waitedMs };
    }
    const res = await waitForHuman({ cardId, sinceIso, timeoutMs: remaining, intervalMs, t, sleep, now });
    polls += res.polls ?? 0;
    waitedMs = Date.parse(now()) - startMs;
    if (!res.replied) {
      return { ...out0, approved: false, timedOut: true, polls, waitedMs };
    }
    // The reply already passed the ask protocol's qualification (author rules,
    // bot exclusion, date window); all that remains is the sha keying —
    // checked directly so the reply object's author/via are preserved.
    if (shaMentionRe(sha).test(res.reply.text)) {
      return { ...out0, approved: true, via: res.reply.via, reply: res.reply, polls, waitedMs };
    }
    // Wrong-sha human reply: does not count, does NOT re-post the ask —
    // advance the window past it and keep waiting until the deadline.
    // (+1 ms: the ask protocol keeps same-second comments — without the
    // bump the window could never move past a reply dated exactly at it.)
    sinceIso = new Date(Date.parse(res.reply.date) + 1).toISOString();
  }
}

// --- The plan-approval gate ---------------------------------------------------

/** The plan-gate `[ASK]` question template (docs/factory.md "Plan approval
 *  gate before Implement"). Keys to the PLAN COMMIT sha; states the
 *  re-plan invalidation rule. */
export const planApprovalAskText = ({ cardId, sha }) =>
  `Plan approval required. Implementation of card ${cardId} is held until a ` +
  `human approves the plan on branch factory/${cardId} ` +
  `(plans/factory/${cardId}-plan.md @ sha ${sha}). ` +
  `To approve, post a comment containing the sha, e.g. "[HUMAN] APPROVED ${sha}". ` +
  `Comments keyed to another sha do not count — after a re-plan a new approval is required.`;

/**
 * The plan-approval gate (docs/factory.md "Plan approval gate before
 * Implement"): unconditional human approval keyed to the PLAN COMMIT sha,
 * between the [PLAN] verdict and the move to Implement. Same primitives as
 * approvalGate, no tiering and NO git (the sha arrives as argv; the CLI runs
 * from the factory checkout): required for every card — a docs-only plan
 * diff gets NO low-tier auto-pass (that would defeat the gate); scan-first
 * (findApprovalComment, any date — comments are the state); else ONE
 * askHuman({noWait:true}) post + Discord ping, then waitForHuman until the
 * deadline; wrong-sha replies don't count, don't re-post, window advances;
 * timeout → {required:true, approved:false, timedOut:true} → CLI exit 1 →
 * scheduler parks needs-human IN PLAN (a park, not a bounce).
 * Deps injectable: t (trello client), notify (defaults to sendOwnerPing;
 * failure recorded, never thrown), sleep/now (clock seams) — the same fakes
 * as the approvalGate tests (tests/factoryRisk.test.js).
 * → { required:true, approved, via?, timedOut?, sha, askCommentId?, discord?,
 *     reply?, polls, waitedMs }
 */
export async function planApprovalGate({
  cardId,
  sha,
  timeoutMs = approvalTimeoutDefault(),
  intervalMs = envNum('FACTORY_ASK_POLL_MS', 30_000),
  board = undefined,
  t = trello,
  notify = sendOwnerPing,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => new Date().toISOString(),
} = {}) {
  const startMs = Date.parse(now());
  const out = { sha };
  let polls = 0;
  let bot = null;
  try {
    if (typeof t.getMe === 'function') bot = (await t.getMe()) ?? null;
  } catch {
    /* identity degraded → tag-only, same fail-closed mode as the ask protocol */
  }
  const actions = await t.getCardComments(cardId);
  polls += 1;
  const existing = findApprovalComment(actions, { sha, bot });
  if (existing) {
    return { ...out, required: true, approved: true, via: 'existing-comment', reply: existing, polls, waitedMs: Date.parse(now()) - startMs };
  }
  // Date floor: the ask moment captured BEFORE askHuman (post + getCard +
  // Discord ping cost seconds), truncated to whole seconds — same ask-date
  // semantics as approvalGate above: approvals stamped in the ask's own
  // second survive the `ms >= sinceMs` filter instead of burning the full
  // timeout. The `[ASK]` question quotes the sha, so the bot's own echo must
  // never pass as the approval — it never does: bot-authored, so the ask
  // protocol's qualification drops it on every poll, never the date window.
  const askFloorIso = new Date(Math.floor(Date.parse(now()) / 1000) * 1000).toISOString();
  const asked = await askHuman({
    cardId,
    question: planApprovalAskText({ cardId, sha }),
    noWait: true,
    board,
    t,
    notify,
    sleep,
    now,
  });
  const out0 = {
    ...out,
    required: true,
    askCommentId: asked.askCommentId,
    discord: asked.discord,
  };
  let sinceIso = askFloorIso;
  const deadlineMs = Date.parse(sinceIso) + timeoutMs;
  let waitedMs = Date.parse(now()) - startMs;
  for (;;) {
    const remaining = deadlineMs - Date.parse(now());
    if (remaining <= 0) {
      return { ...out0, approved: false, timedOut: true, polls, waitedMs };
    }
    const res = await waitForHuman({ cardId, sinceIso, timeoutMs: remaining, intervalMs, board, t, sleep, now });
    polls += res.polls ?? 0;
    waitedMs = Date.parse(now()) - startMs;
    if (!res.replied) {
      return { ...out0, approved: false, timedOut: true, polls, waitedMs };
    }
    // The reply already passed the ask protocol's qualification (author rules,
    // bot exclusion, date window); all that remains is the sha keying —
    // checked directly so the reply object's author/via are preserved.
    if (shaMentionRe(sha).test(res.reply.text)) {
      return { ...out0, approved: true, via: res.reply.via, reply: res.reply, polls, waitedMs };
    }
    // Wrong-sha human reply: does not count, does NOT re-post the ask —
    // advance the window past it and keep waiting until the deadline.
    sinceIso = new Date(Date.parse(res.reply.date) + 1).toISOString();
  }
}
