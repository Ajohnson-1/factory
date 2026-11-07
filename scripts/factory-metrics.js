#!/usr/bin/env node
// Periodic factory + reviewer metrics report (card 6ae9676e2c38913cca053d37).
// Pipeline spec: docs/factory.md ("Metrics report"); logic + semantics in
// scripts/lib/factory-metrics.js.
//
// Pure read-only counting pass over board state + daemon/prod-watch logs that
// posts ONE `[METRICS]` summary comment onto a dedicated `Factory metrics
// report` card parked in Done (created on first run, reused after — never a
// new card, so the Done pinger stays quiet). Scheduled as its own launchd
// StartInterval agent — the exact prod-watch.js pattern — NOT in-process
// inside factory-daemon: a report bug then rides launchd's respawn instead of
// the daemon's, and the daemon's crash-free 15 s poller never gates on a
// 6-hourly tick. A Ready-card pipeline cycle per report would burn a full
// $10-capped agent run every 6 h for deterministic counting (factor 8 — code
// owns it).
//
// Subcommands:
//   once                    one pass (launchd StartInterval target; JSON to stdout)
//   run [--interval ms]     forever loop (manual/debug; default 6 h)
//   install                 launchd agent (RunAtLoad + StartInterval 21600 s)
//   uninstall               remove the agent
//   status                  launchd state + last stored report + last cycle state
//
// Exit codes: 0 = report produced (degraded reads land in report.errors);
// 1 = the report itself could not be computed (board fetch failed); 3 = bad
// subcommand.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DEFAULT_INTERVAL_MS, REPORT_DIR, STATE_PATH, runMetricsReport } from './lib/factory-metrics.js';
import { launchctl } from './lib/factory-launchd.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.discordbot.factory-metrics';
const PLIST_PATH = join(process.env.HOME ?? '', 'Library/LaunchAgents', `${LABEL}.plist`);
const INTERVAL_SEC = Math.round(DEFAULT_INTERVAL_MS / 1000);

const log = (msg) => process.stderr.write(`[factory-metrics] ${msg}\n`);

// ---------- launchd (prod-watch.js plistXml shape verbatim) ----------

export function plistXml({ nodePath = process.execPath, intervalSec = INTERVAL_SEC } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${join(ROOT, 'scripts', 'factory-metrics.js')}</string>
    <string>once</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StandardOutPath</key><string>${join(REPORT_DIR(), 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(REPORT_DIR(), 'launchd.err.log')}</string>
</dict>
</plist>
`;
}

async function cmdInstall({ plistPath = PLIST_PATH, uid = process.getuid() } = {}) {
  mkdirSync(REPORT_DIR(), { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, plistXml());
  await launchctl(['bootout', `gui/${uid}/${LABEL}`]).catch(() => {});
  await launchctl(['bootstrap', `gui/${uid}`, plistPath]);
  console.log(JSON.stringify({ installed: true, label: LABEL, plist: plistPath, intervalSec: INTERVAL_SEC }));
  return 0;
}

async function cmdUninstall({ plistPath = PLIST_PATH, uid = process.getuid() } = {}) {
  await launchctl(['bootout', `gui/${uid}/${LABEL}`]).catch((e) => log(`bootout: ${e.message}`));
  rmSync(plistPath, { force: true });
  console.log(JSON.stringify({ installed: false, label: LABEL }));
  return 0;
}

function readLatestReport() {
  try {
    return JSON.parse(readFileSync(join(REPORT_DIR(), 'latest.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function cmdStatus({ plistPath = PLIST_PATH, uid = process.getuid(), report = readLatestReport() } = {}) {
  let launchd = 'not loaded';
  try {
    await launchctl(['print', `gui/${uid}/${LABEL}`]);
    launchd = 'loaded';
  } catch {
    /* print exits non-zero when unloaded */
  }
  let state = null;
  try {
    state = JSON.parse(readFileSync(STATE_PATH(), 'utf8'));
  } catch {
    /* no state yet — first run pending */
  }
  console.log(JSON.stringify({ label: LABEL, launchd, intervalSec: INTERVAL_SEC, plist: plistPath, state, lastReport: report }, null, 2));
  return 0;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { interval: Number(process.env.FACTORY_METRICS_INTERVAL_MS || DEFAULT_INTERVAL_MS) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--interval') out.interval = Number(argv[++i]) || out.interval;
    else if (argv[i] === '--since') out.since = argv[++i];
    else if (argv[i] === '--no-post') out.noPost = true;
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] ?? 'once';
  const opts = parseArgs(argv.slice(1));
  if (cmd === 'install') return cmdInstall();
  if (cmd === 'uninstall') return cmdUninstall();
  if (cmd === 'status') return cmdStatus();
  if (cmd !== 'once' && cmd !== 'run') {
    process.stderr.write('usage: node scripts/factory-metrics.js [once|run [--interval ms]|install|uninstall|status]  (once/run accept [--since <ISO>] [--no-post])\n');
    return 3;
  }
  for (;;) {
    try {
      const res = await runMetricsReport({ since: opts.since, noPost: opts.noPost, log });
      console.log(JSON.stringify({ ok: res.ok, postCard: res.postCard ?? null, report: res.report }, null, 2));
      if (!res.ok) return 1; // board fetch failed — nothing to report
    } catch (e) {
      // runMetricsReport never rejects; this guards its seams against future
      // regressions: log, keep looping (launchd respawns `once` anyway).
      log(`pass failed: ${e.message}`);
      console.log(JSON.stringify({ ok: false, error: e.message }));
      if (cmd === 'once') return 1;
    }
    if (cmd === 'once') return 0;
    await new Promise((r) => setTimeout(r, opts.interval));
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main();
}
