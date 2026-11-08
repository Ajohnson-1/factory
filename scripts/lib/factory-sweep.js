// Nightly standing review sweep for the software factory (card 6ae96774f94d31dd02bf46fe).
// CLI: `node scripts/factory-sweep.js` (docs/factory.md "Nightly review sweep").
//
// Why: the factory is purely reactive — the daemon only dispatches Ready
// arrivals, so slowly surfacing bugs in already-merged code wait for a human
// to notice. This job files ONE auto-generated `[SWEEP YYYY-MM-DD]` review
// card into Ready each night; the untouched daemon dispatches it exactly like
// a `[PROD-WATCH]` incident card (same primitive `trello.createCard(name,
// readyId, desc)`; per-card instructions live in the card description, which
// every stage agent already reads via `factory.js read`). The sweep card's
// stage agents review the recently-merged slice against the review
// ground-truth docs (docs/factory-prompts/reviewer.md + docs/security-review.md)
// and file every finding as a follow-up `[SWEEP-FINDING …]` Ready card via
// `factory.js add` + `desc` — fixes ride the normal pipeline. Zero changes to
// factory-daemon.js, the board contract, or the stage prompts.
//
// Idempotency: the deterministic date title is deduped against ALL open board
// card names (seed-audit precedent — board-is-the-state, no state file), so a
// double fire (cron + launchd, or a sleep-wake catch-up) creates 0 cards.
// An empty window (quiet repo) files NO card — a quiet night must not spam
// Ready.
//
// Dependency-injectable logic, the factory-audit-cards.js pattern: every seam
// (trello client, git fetch/log, clock, log) defaults to the real thing and
// is faked in tests/factorySweep.test.js — zero live Trello/git there.

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as trello from './trello.js';
import { ensurePriorityLabels } from './factory-audit-cards.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** launchd label for the nightly calendar job (docs/factory.md). */
export const LABEL = 'com.ajohnson.factory-sweep';

/** Commit-line marker for the `--pretty=format:%x01%H` log (see parseCommitFileLog). */
export const COMMIT_MARKER = '\x01';

/**
 * Factory paperwork excluded from the review slice: plan files and stage
 * prompts are process artifacts, not merged product code. Lockfiles stay IN
 * (they are merged dependency signal).
 */
export const EXCLUDE_RES = [/^plans\//, /^docs\/factory-prompts\//];

export const DEFAULTS = { days: 7, maxFiles: 40, maxFindings: 5, hour: 3, minute: 15 };

const posInt = (v, def, min = 1) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= min ? n : def;
};

/** Read FACTORY_SWEEP_* overrides (all optional; garbage falls back to default). */
export function readEnvConfig(env = process.env) {
  return {
    days: posInt(env.FACTORY_SWEEP_DAYS, DEFAULTS.days),
    maxFiles: posInt(env.FACTORY_SWEEP_MAX_FILES, DEFAULTS.maxFiles),
    maxFindings: posInt(env.FACTORY_SWEEP_MAX_FINDINGS, DEFAULTS.maxFindings),
    hour: (() => {
      const n = Number.parseInt(env.FACTORY_SWEEP_HOUR, 10);
      return Number.isFinite(n) && n >= 0 && n <= 23 ? n : DEFAULTS.hour;
    })(),
    minute: (() => {
      const n = Number.parseInt(env.FACTORY_SWEEP_MINUTE, 10);
      return Number.isFinite(n) && n >= 0 && n <= 59 ? n : DEFAULTS.minute;
    })(),
  };
}

/** Local calendar date `YYYY-MM-DD`. */
export function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Parse `git log --name-only --pretty=format:%x01%H` stdout into a
 * file → [commit shas that touched it, oldest→newest log order] map.
 * Commit lines start with COMMIT_MARKER; blank lines (inter-commit separators)
 * and paths seen before the first commit line are ignored. Pure — no IO.
 */
export function parseCommitFileLog(stdout) {
  const map = new Map();
  let sha = null;
  for (const raw of String(stdout ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(COMMIT_MARKER)) {
      sha = line.slice(COMMIT_MARKER.length).trim().split(/\s+/)[0];
      continue;
    }
    if (!sha) continue; // git log preface before the first formatted commit
    if (!map.has(line)) map.set(line, []);
    if (sha && !map.get(line).includes(sha)) map.get(line).push(sha);
  }
  return map;
}

/** Factory paperwork? (slice exclusion) */
export const isPaperwork = (file) => EXCLUDE_RES.some((re) => re.test(file));

/**
 * Build tonight's review slice from git log stdout: paperwork dropped,
 * files sorted, capped at maxFiles; overflow (capped-out files) named
 * separately so the card description can state what was NOT covered.
 * Returns { covered: [{file, shas}], overflow: [file], total }.
 * An empty map = empty window (quiet repo).
 */
export function buildSlice(stdout, { maxFiles = DEFAULTS.maxFiles } = {}) {
  const entries = [...parseCommitFileLog(stdout).entries()]
    .filter(([file]) => !isPaperwork(file))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const covered = entries.slice(0, maxFiles).map(([file, shas]) => ({ file, shas }));
  const overflow = entries.slice(maxFiles).map(([file]) => file);
  return { covered, overflow, total: entries.length };
}

/** Deterministic dedup key doubling as the card title (seed-audit precedent). */
export function sweepTitle(dateStr, fileCount, days) {
  return `[SWEEP ${dateStr}] Standing review — ${fileCount} files merged in the last ${days} days`;
}

/** First open-board card whose name starts with `[SWEEP <dateStr>]` (or null). */
export function findSweepCard(cards, dateStr) {
  const prefix = `[SWEEP ${dateStr}]`;
  return cards.find((c) => String(c.name).trim().startsWith(prefix)) ?? null;
}

/**
 * The machine-written requirements the sweep card's own stage agents act on.
 * Same precedent as prod-watch incident cards: card description =
 * requirements, agents never edit it. Includes the file slice with merge
 * SHAs, both ground-truth doc paths, the finding-filing commands, the cap
 * (overflow recorded, never silently dropped), the commits-no-code rule, and
 * the clean-sweep statement. Pure — no IO.
 */
export function sweepDescription({ dateStr, days, maxFiles = DEFAULTS.maxFiles, maxFindings, covered, overflow = [], filedAt = new Date().toISOString() }) {
  const lines = [
    `Automated nightly standing review sweep (scripts/factory-sweep.js — card 6ae96774f94d31dd02bf46fe) filed ${filedAt}.`,
    ``,
    `This card has NO feature diff: review EXISTING recently-merged code.`,
    ``,
    `## Review ground truth`,
    ``,
    `- Read \`docs/factory-prompts/reviewer.md\` (review mindset, full-pass rules) and \`docs/security-review.md\` (security checklist) FIRST, then apply both to the current state of every file in the slice below. This is a whole-file review of merged code, not a diff review — the diff-approval framing in the reviewer prompt does not apply; the mindset, checklist depth, and severity discipline do.`,
    ``,
    `## Slice: files merged into origin/master in the last ${days} days (${covered.length} of ${covered.length + overflow.length} touched files tonight)`,
    ``,
  ];
  for (const { file, shas } of covered) {
    lines.push(`- \`${file}\` — merged in ${shas.map((s) => s.slice(0, 10)).join(', ')}`);
  }
  if (overflow.length) {
    lines.push(``, `Cap ${maxFiles} files/night — NOT covered tonight (later windows will pick them up): ${overflow.map((f) => `\`${f}\``).join(', ')}.`);
  }
  lines.push(
    ``,
    `## Findings → follow-up Ready cards`,
    ``,
    `Every finding (a real defect or security issue in the slice, not a style preference) becomes its OWN card in Ready, so the daemon dispatches the fix through the normal pipeline:`,
    ``,
    `1. \`node scripts/factory.js add Ready "[SWEEP-FINDING ${dateStr} <n>] <one-line summary>"\` (n = 1,2,3…)`,
    `2. \`node scripts/factory.js desc <new-card-id> -\` — full detail: file:line, why it matters, suggested fix, severity HIGH/MEDIUM/LOW.`,
    ``,
    `Cap: file at most ${maxFindings} finding cards this run (highest severity first; ties → newer merge). The overflow is recorded in THIS card's [IMPL] comment — never silently dropped. Do not file findings in files outside the slice.`,
    ``,
    `## Rules for this card itself`,
    ``,
    `- This card commits NO code: its only commit is its own plan file (risk tier \`low\` → quick review pass; security-check sees only \`plans/**\` → no-op [SEC:PASS]).`,
    `- [IMPL] evidence = the review trail: exact commands/checks run + observed output, plus the ids/urls of every filed finding card and any findings beyond the cap (Board contract evidence rule).`,
    `- Clean sweep: zero findings → the [IMPL] comment states "no findings — slice reviewed against both ground-truth docs" and lists the files covered; the pipeline proceeds normally.`,
  );
  return lines.join('\n');
}

const defaultGitFetch = () =>
  execFileSync('git', ['-C', ROOT, 'fetch', 'origin', 'master'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const defaultGitLog = (days) =>
  execFileSync(
    'git',
    ['-C', ROOT, 'log', `--since=${days} days`, '--name-only', `--pretty=format:${COMMIT_MARKER}%H`, 'origin/master'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );

/**
 * One nightly sweep tick. Order: best-effort freshness fetch (fail-open to
 * local refs on network failure — logged) → slice → empty-window guard →
 * date-dedup vs all open board cards → file card into Ready with the
 * existing `Low` priority label. Sequential writes (rate-limit-friendly).
 * `dryRun` computes the identical plan with ZERO board writes.
 * Returns one of:
 *   {action:'skipped-empty-window', days, files:0}
 *   {action:'deduped', title}
 *   {action:'would-file', dryRun:true, title, list:'Ready', files, overflow, chars}
 *   {action:'filed', card, url, title, list:'Ready', files, overflow}
 * Rejects on missing Ready list (the CLI turns that into exit 1).
 */
export async function runSweepOnce({
  t = trello,
  days = DEFAULTS.days,
  maxFiles = DEFAULTS.maxFiles,
  maxFindings = DEFAULTS.maxFindings,
  dateStr = todayStr(),
  dryRun = false,
  fetch = true,
  gitFetch = defaultGitFetch,
  gitLog = defaultGitLog,
  now = () => new Date(),
  log = console.error,
  board, // FM-2 (§4.3): board-scoped reads (getLists/getBoardCards/label lookup) target this board; undefined = default (byte-identical)
} = {}) {
  if (fetch) {
    // Best-effort freshness: on network failure sweep local refs instead
    // (fail-open — a stale-by-one-fetch slice still beats a skipped night).
    try {
      await Promise.resolve().then(() => gitFetch());
      log('fetched origin/master');
    } catch (e) {
      log(`fetch failed (sweeping local refs): ${e.message}`);
    }
  }
  const slice = buildSlice(await Promise.resolve(gitLog(days)), { maxFiles });
  if (slice.covered.length === 0) {
    return { action: 'skipped-empty-window', days, files: 0 };
  }
  const lists = await t.getLists({ board });
  const ready = lists.find((l) => !l.closed && l.name.toLowerCase() === 'ready');
  if (!ready) throw new Error('Ready list missing (run factory.js init)');
  const boardCards = await t.getBoardCards('id,name,idList', { board });
  const dupe = findSweepCard(boardCards, dateStr);
  if (dupe) {
    // Double-fire guard (cron+launchd coexistence, sleep-wake catch-up).
    log(`deduped: open card "${dupe.name}" already exists`);
    return { action: 'deduped', title: String(dupe.name).trim() };
  }
  const title = sweepTitle(dateStr, slice.covered.length, days);
  const desc = sweepDescription({ dateStr, days, maxFiles, maxFindings, covered: slice.covered, overflow: slice.overflow, filedAt: now().toISOString() });
  if (dryRun) {
    return { action: 'would-file', dryRun: true, title, list: 'Ready', files: slice.covered.length, overflow: slice.overflow, chars: desc.length };
  }
  const card = await t.createCard(title, ready.id, desc);
  // Existing precedent: the audit seeder's label helper (reuse-by-name, so
  // zero creates once the board's priority labels exist after seed-audit).
  // `boardId` follows the scoped board (undefined ⇒ t.BOARD, today's value).
  const labels = await ensurePriorityLabels({ t, boardId: board ?? t.BOARD, board });
  await t.addLabelToCard(card.id, labels.Low);
  log(`filed: ${card.url}`);
  return { action: 'filed', card: card.id, url: card.url, title, list: 'Ready', files: slice.covered.length, overflow: slice.overflow };
}

/**
 * launchd plist XML: one-shot calendar job (StartCalendarInterval = launchd's
 * cron), RunAtLoad=false so `install` never fires an immediate sweep. The
 * PATH dict mirrors the daemon's (launchd's default PATH has no node/git).
 * FACTORY_SWEEP_* values are baked in so launchd's env-less runs honor them.
 */
export function plistXml({
  label = LABEL,
  nodePath = process.execPath,
  repo = ROOT,
  scriptPath = join(ROOT, 'scripts', 'factory-sweep.js'),
  logDir = join(ROOT, 'data', 'factory-sweep'),
  hour = DEFAULTS.hour,
  minute = DEFAULTS.minute,
  days = DEFAULTS.days,
  maxFiles = DEFAULTS.maxFiles,
  maxFindings = DEFAULTS.maxFindings,
} = {}) {
  const envPath = [dirname(nodePath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>once</string>
  </array>
  <key>WorkingDirectory</key><string>${repo}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${envPath}</string>
    <key>FACTORY_SWEEP_DAYS</key><string>${days}</string>
    <key>FACTORY_SWEEP_MAX_FILES</key><string>${maxFiles}</string>
    <key>FACTORY_SWEEP_MAX_FINDINGS</key><string>${maxFindings}</string>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key><string>${join(logDir, 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(logDir, 'launchd.err.log')}</string>
</dict>
</plist>
`;
}
