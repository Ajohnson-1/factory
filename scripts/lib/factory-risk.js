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
// The human approves from EITHER surface (card 6af61f32ed767688104029e0 —
// "mobile friendly way to see what is changing"):
//   1. the board — a sha-keyed human comment, exactly the rule above, and
//   2. a GitHub PR review at the EXACT sha — when the gate must ask it
//      best-effort pushes the branch and opens/updates a PR
//      (scripts/lib/factory-pr.js) so the phone shows the real diff, puts the
//      PR URL in the `[ASK]` + ping, and accepts Review → Approve (commit_id
//      keyed like the board path; reviewer must be allowlisted). Observing it
//      posts a bot-authored mirror comment `[HUMAN] APPROVED <sha> — GitHub
//      PR #<n> …` (board shows the decision; the board scan drops bot
//      comments, so no self-approval; the GitHub source stays independently
//      re-checkable). Every PR-side failure — no token, kill switch
//      FACTORY_PR_APPROVALS=0, push/API error — degrades to today's sha-only
//      ask, byte-identical, recorded as `pr:{degraded:true,error}`.
//
// Waiting reuses the ask protocol (scripts/lib/factory-ask.js) verbatim:
// `askHuman({ noWait: true })` posts `[ASK]` + pings Discord once, then a
// loop of `waitForHuman` collects replies — each qualifying reply is
// re-checked for the sha; a wrong-sha reply does NOT count and does NOT
// re-post the ask (one ask post/ping, the wait window advances). With a live
// PR the single blocking wait becomes bounded `intervalMs` slices and each
// cycle also re-checks the PR reviews (wrong-sha reviews likewise never
// re-post the ask). Timeout →
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
import { ensurePr as defaultEnsurePr, checkPrApprovals as defaultCheckPrApprovals } from './factory-pr.js';

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
 *  stale-sha rule (a rebase needs a NEW approval). With a live PR the link
 *  line leads — the ping brief is `question.slice(0, 300)`
 *  (factory-ask.js), so the mobile link must sit inside the first ~180
 *  chars; without a PR the text is byte-identical to today's. */
export const approvalAskText = ({ tier, reasons, sha, prUrl }) =>
  (prUrl ? `Review the diff & approve from your phone: ${prUrl}\n` : '') +
  `Approval required (risk tier ${tier}: ${reasons.join('; ')}). ` +
  `Merge+Deploy of sha ${sha} is held until a human approves THIS sha. ` +
  `To approve, post a comment containing the sha, e.g. "[HUMAN] APPROVED ${sha}". ` +
  `Comments keyed to another sha do not count — after a rebase/QA re-run a new approval is required.`;

/** Board mirror of a GitHub PR review approval (docs/factory.md "Gate
 *  protocol"): the PR-side decision rides the board — comments are the
 *  state. Bot-authored, so `findApprovalComment` ignores it (no
 *  self-approval, no double-count); the GitHub review stays the source. */
export const prMirrorText = ({ sha, number, login }) =>
  `[HUMAN] APPROVED ${sha} — GitHub PR #${number} review approved by ${login}`;

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

// --- Re-ask dedup -------------------------------------------------------------

/**
 * The card's NEWEST dated `[ASK]` comment quoting `sha` (≥7-char prefix, the
 * `shaMentionRe` matcher approvals use) that is still inside its approval
 * window (dated after `now − timeoutMs`), else null. Re-ask dedup for BOTH
 * gates: a gate re-invoked by a resumed run with the SAME sha must not
 * duplicate the ask — the sha keying makes any ask quoting THIS sha the ask
 * of the current era (a re-plan/rebase changes the sha → null → fresh post).
 * An ask OLDER than the window is stale — its wait died with its run and the
 * human may have walked away → null → fresh post + ping (card 6af67602dd513e15f44f4d10,
 * 2026-11-13: ONE plan approval, THREE identical `[ASK]` comments, each from
 * a fresh gate call after a crash-resume).
 */
export function recentApprovalAsk(actions, { sha, timeoutMs = approvalTimeoutDefault(), now = () => new Date().toISOString() } = {}) {
  const re = shaMentionRe(sha);
  const floorMs = Date.parse(now()) - timeoutMs;
  let best = null;
  let bestMs = -Infinity;
  for (const a of Array.isArray(actions) ? actions : []) {
    const text = String(a?.data?.text ?? a?.text ?? '').trim();
    if (!/^\[ASK\]/i.test(text)) continue;
    if (!re.test(text)) continue;
    const ms = Date.parse(a?.date ?? '');
    if (!Number.isFinite(ms) || ms <= floorMs || ms <= bestMs) continue;
    best = a;
    bestMs = ms;
  }
  return best;
}

// --- The gate ------------------------------------------------------------------

/**
 * The risk gate (docs/factory.md "Risk-tiered approval before Deploy").
 * Deps injectable: t (trello client), git, notify (defaults to sendOwnerPing;
 * failure recorded, never thrown), sleep/now (clock seams), ensurePr /
 * checkPrApprovals (GitHub PR surface, scripts/lib/factory-pr.js) + prMeta
 * (CLI-resolved `{ enabled, slug, baseBranch, approvers }`; null/undefined ⇒
 * the PR feature is off for this run, zero PR calls, result identical to
 * today's).
 * Flow:
 *   tier (auto-classified via getDiffStat when not supplied) low →
 *     { required:false, approved:true } with ZERO board calls (criterion 2)
 *     and ZERO GitHub calls (the PR machinery runs only after this check).
 *   else: existing sha-keyed approval (ANY date — an approval the human
 *     posted earlier, even before this run started, counts: comments are the
 *     state) → { approved:true, via:'existing-comment' }, zero addComment,
 *     short-circuiting BEFORE ensurePr.
 *   else: best-effort ensurePr (push + open/update the PR) → best-effort PR
 *     approval scan (late-approve recovery: a review already at the sha
 *     mirrors `[HUMAN] APPROVED <sha> — GitHub PR #<n> …` to the board and
 *     exits approved, no ask).
 *   else: ONE askHuman({ noWait:true }) post + Discord ping (the ask leads
 *     with the PR URL when live; degraded ⇒ today's text byte-identical),
 *     then the wait. Without a PR: the exact old loop of waitForHuman
 *     (date-based; ask once, wait many times) — each qualifying human reply
 *     is re-checked for the sha; a wrong-sha reply is skipped and the window
 *     advances past it (ONE ask post/ping for the whole window, deadline =
 *     original ask + timeoutMs). With a PR: the same wait in bounded
 *     intervalMs slices, and each cycle also re-checks the PR reviews (two
 *     GETs; an API failure degrades that cycle and self-heals next poll;
 *     wrong-sha / non-allowlisted reviews never re-post the ask). Expiry →
 *     timedOut.
 * → { tier, reasons, required, approved, via?, timedOut?, sha, askCommentId?,
 *     reply?, discord?, pr?, reviews?, polls, waitedMs }
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
  prMeta = null,
  ensurePr = defaultEnsurePr,
  checkPrApprovals = defaultCheckPrApprovals,
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
  // --- Best-effort GitHub PR surface (docs/factory.md "The PR as the mobile
  // approval surface"). Every failure here is recorded, never thrown: the
  // gate's exit semantics and the sha-only ask text stay exactly today's.
  let pr = null; // { number, url } while live
  let prReviews = null; // non-qualifying reviews seen while waiting
  let prSeenMs = 0; // reviews at/ before this are already recorded — never re-processed
  if (prMeta) {
    if (prMeta.enabled && prMeta.slug) {
      try {
        const res = await ensurePr({
          prMeta,
          branch,
          sha,
          tier: cls.tier,
          reasons: cls.reasons,
          files: cls.files ?? [],
          cardId,
          git,
          t,
        });
        if (res?.number) pr = { number: res.number, url: res.url };
        else out.pr = { degraded: true, error: res?.error ?? 'ensurePr returned no PR' };
      } catch (e) {
        out.pr = { degraded: true, error: String(e?.message ?? e) };
      }
    } else {
      out.pr = { degraded: true, error: prMeta.disabledReason ?? 'PR approvals disabled' };
    }
  }
  if (pr) {
    // Existing PR approval scan (covers late-approve recovery: timeout →
    // needs-human park → the human approves the still-open PR on their phone
    // → drag back to Ready → this scan finds the review, mirrors it, exits
    // 0). A check failure degrades the scan only — the ask below still runs.
    let scan = null;
    try {
      scan = await checkPrApprovals({ pr, slug: prMeta.slug, sha, approvers: prMeta.approvers ?? [] });
    } catch {
      /* API failure → today's sha-only wait; self-heals in the loop */
    }
    if (scan) {
      const merged = collectReviews(prReviews, scan, prSeenMs);
      prReviews = merged.reviews;
      prSeenMs = merged.seenMs;
    }
    if (scan?.approval) {
      const mirror = prMirrorText({ sha, number: pr.number, login: scan.approval.login });
      const posted = await t.addComment(cardId, mirror);
      return {
        ...out,
        required: true,
        approved: true,
        via: 'github-pr-review',
        reply: { text: mirror, date: posted?.date ?? now(), author: scan.approval.login, via: 'github' },
        pr,
        ...(prReviews ? { reviews: prReviews } : {}),
        polls,
        waitedMs: Date.parse(now()) - startMs,
      };
    }
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
  // Re-ask dedup: a fresh gate call from a RESUMED run must not duplicate an
  // ask still inside its window for THIS sha (the trail of card
  // 6af67602dd513e15f44f4d10: one approval, three identical `[ASK]`s). The
  // board keeps the wait visible on its own — the daemon's ask-lift re-posts
  // the pending ask top-of-card after every bookkeeping post — so skip the
  // comment AND the ping (the original ping already reached the owner; the
  // timeout park DM is the final escalation). Waiting proceeds unchanged.
  const dupAsk = recentApprovalAsk(actions, { sha, timeoutMs, now });
  const asked = dupAsk
    ? { askCommentId: dupAsk.id, askDeduped: true }
    : await askHuman({
        cardId,
        question: approvalAskText({ tier: cls.tier, reasons: cls.reasons, sha, prUrl: pr?.url }),
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
    ...(asked.askDeduped ? { askDeduped: true } : { discord: asked.discord }),
  };
  let sinceIso = askFloorIso;
  const deadlineMs = Date.parse(sinceIso) + timeoutMs;
  let waitedMs = Date.parse(now()) - startMs;
  const prReturn = (extra) => ({
    ...out0,
    ...(pr ? { pr } : {}),
    ...(prReviews ? { reviews: prReviews } : {}),
    ...extra,
  });
  // One PR review cycle: two authenticated GETs; failures degrade THIS cycle
  // and self-heal next poll. Returns the approval (mirror posted) or null.
  const prCycle = async () => {
    let scan = null;
    try {
      scan = await checkPrApprovals({ pr, slug: prMeta.slug, sha, approvers: prMeta.approvers ?? [] });
    } catch {
      return null;
    }
    if (!scan) return null;
    const merged = collectReviews(prReviews, scan, prSeenMs);
    prReviews = merged.reviews;
    prSeenMs = merged.seenMs;
    if (!scan.approval) return null;
    const mirror = prMirrorText({ sha, number: pr.number, login: scan.approval.login });
    const posted = await t.addComment(cardId, mirror);
    return prReturn({
      approved: true,
      via: 'github-pr-review',
      reply: { text: mirror, date: posted?.date ?? now(), author: scan.approval.login, via: 'github' },
      polls,
      waitedMs,
    });
  };
  for (;;) {
    const remaining = deadlineMs - Date.parse(now());
    if (remaining <= 0) {
      return prReturn({ approved: false, timedOut: true, polls, waitedMs });
    }
    if (pr) {
      // PR live: bounded intervalMs slices (NOT one blocking wait to the
      // deadline) so each cycle can also poll the PR reviews; the deadline
      // check above preserves timeout/park semantics exactly.
      const res = await waitForHuman({ cardId, sinceIso, timeoutMs: Math.min(intervalMs, remaining), intervalMs, t, sleep, now });
      polls += res.polls ?? 0;
      waitedMs = Date.parse(now()) - startMs;
      if (res.replied) {
        // The reply already passed the ask protocol's qualification (author
        // rules, bot exclusion, date window); all that remains is the sha
        // keying — checked directly so the reply object's author/via are
        // preserved.
        if (shaMentionRe(sha).test(res.reply.text)) {
          return prReturn({ approved: true, via: res.reply.via, reply: res.reply, polls, waitedMs });
        }
        // Wrong-sha human reply: does not count, does NOT re-post the ask —
        // advance the window past it and keep waiting until the deadline.
        // (+1 ms: the ask protocol keeps same-second comments — without the
        // bump the window could never move past a reply dated exactly at it.)
        sinceIso = new Date(Date.parse(res.reply.date) + 1).toISOString();
      }
      const ok = await prCycle();
      if (ok) return ok;
      continue;
    }
    // No PR (disabled/degraded): the exact old single-call loop — poll-count
    // behavior byte-identical to before the PR surface existed.
    const res = await waitForHuman({ cardId, sinceIso, timeoutMs: remaining, intervalMs, t, sleep, now });
    polls += res.polls ?? 0;
    waitedMs = Date.parse(now()) - startMs;
    if (!res.replied) {
      return prReturn({ approved: false, timedOut: true, polls, waitedMs });
    }
    // The reply already passed the ask protocol's qualification (author rules,
    // bot exclusion, date window); all that remains is the sha keying —
    // checked directly so the reply object's author/via are preserved.
    if (shaMentionRe(sha).test(res.reply.text)) {
      return prReturn({ approved: true, via: res.reply.via, reply: res.reply, polls, waitedMs });
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
 * deadline; a re-invoke with the SAME sha while an ask quoting it is still
 * inside its window dedups to ZERO new posts/pings (recentApprovalAsk —
 * resumed runs never stack identical asks); wrong-sha replies don't count,
 * don't re-post, window advances;
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
  // Re-ask dedup (same rule as approvalGate — this gate produced the THREE
  // identical plan asks on card 6af67602dd513e15f44f4d10): an ask quoting
  // THIS plan sha inside its window means the wait is alive on the board →
  // skip the post + ping, keep waiting.
  const dupAsk = recentApprovalAsk(actions, { sha, timeoutMs, now });
  const asked = dupAsk
    ? { askCommentId: dupAsk.id, askDeduped: true }
    : await askHuman({
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
    ...(asked.askDeduped ? { askDeduped: true } : { discord: asked.discord }),
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

/** Merge one PR review scan into the recorded `reviews` list, honoring the
 *  seen-window (`seenMs`): wrong-sha and non-allowlisted reviews advance the
 *  window too, so each is recorded once, never re-processed, and the ask is
 *  NEVER re-posted for them. Pure.
 * → { reviews: [...] | null, seenMs } */
function collectReviews(acc, scan, seenMs = 0) {
  const records = [...(scan?.changesRequested ?? []), ...(scan?.staleApprovals ?? []), ...(scan?.unrecognized ?? [])];
  const fresh = [];
  let maxMs = seenMs;
  for (const r of records) {
    const ms = Date.parse(r?.date ?? '');
    if (Number.isFinite(ms) && ms <= seenMs) continue; // already recorded
    if (Number.isFinite(ms) && ms + 1 > maxMs) maxMs = ms + 1;
    fresh.push({ login: r?.login ?? null, state: r?.state ?? 'review', commitId: r?.commitId ?? null, reason: r?.reason ?? null, date: r?.date ?? null });
  }
  return { reviews: fresh.length ? [...(acc ?? []), ...fresh] : acc ?? null, seenMs: maxMs };
}
