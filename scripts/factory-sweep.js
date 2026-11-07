#!/usr/bin/env node
// Nightly standing review sweep CLI (card 6ae96774f94d31dd02bf46fe;
// docs/factory.md "Nightly review sweep"). Semantics: scripts/lib/factory-sweep.js.
//
// Subcommands:
//   once [--date YYYY-MM-DD]      one sweep (launchd/cron target; stdout = JSON)
//   dry-run [--date YYYY-MM-DD]   the identical plan with ZERO board writes
//   install [--hour H --minute M] launchd calendar agent (default 03:15 local)
//   uninstall                     remove the agent
//   status                        launchd state + schedule JSON
//
// stdout is the JSON contract; progress/log lines go to stderr. Crontab
// alternative (date-dedup makes running both harmless):
//   15 3 * * * cd <repo> && node scripts/factory-sweep.js once

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as sweep from './lib/factory-sweep.js';
import { launchctl } from './lib/factory-launchd.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = sweep.LABEL;
const PLIST_PATH = join(process.env.HOME ?? '', 'Library/LaunchAgents', `${LABEL}.plist`);
const LOG_DIR = resolve(ROOT, 'data', 'factory-sweep');

const log = (msg) => process.stderr.write(`[factory-sweep] ${msg}\n`);
const out = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
const die = (msg) => {
  log(msg);
  return 1;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse shared flags; throws on bad input (main turns that into exit 1). */
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') {
      const v = argv[++i];
      if (!v || !DATE_RE.test(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) {
        throw new Error(`--date wants a real YYYY-MM-DD date (got "${v ?? ''}")`);
      }
      flags.dateStr = v;
    } else if (a === '--hour') {
      flags.hour = argv[++i];
    } else if (a === '--minute') {
      flags.minute = argv[++i];
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag ${a}`);
    }
  }
  return flags;
}

// One sweep (once|dry-run share everything; dry-run also skips the
// best-effort fetch so the preview has ZERO side effects anywhere).
async function cmdSweep(flags, cfg, { dryRun }) {
  try {
    const res = await sweep.runSweepOnce({
      days: cfg.days,
      maxFiles: cfg.maxFiles,
      maxFindings: cfg.maxFindings,
      ...(flags.dateStr ? { dateStr: flags.dateStr } : {}),
      dryRun,
      fetch: !dryRun,
    });
    out(res);
    return 0;
  } catch (e) {
    out({ action: 'error', error: e.message });
    return 1;
  }
}

// prod-watch's bootout-then-bootstrap shape; no detached bootstrap-guard
// needed: a one-shot calendar job is not the daemon's child, so a run that
// installs mid-flight cannot SIGTERM-kill its own bootstrap.
async function cmdInstall(flags, cfg) {
  const hour = flags.hour !== undefined ? Number(flags.hour) : cfg.hour;
  const minute = flags.minute !== undefined ? Number(flags.minute) : cfg.minute;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return die('--hour must be 0-23 and --minute 0-59');
  }
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const xml = sweep.plistXml({ nodePath: process.execPath, hour, minute, days: cfg.days, maxFiles: cfg.maxFiles, maxFindings: cfg.maxFindings });
  writeFileSync(PLIST_PATH, xml);
  const uid = process.getuid();
  await launchctl(['bootout', `gui/${uid}/${LABEL}`]).catch(() => {});
  try {
    await launchctl(['bootstrap', `gui/${uid}`, PLIST_PATH]);
  } catch (e) {
    return die(`bootstrap failed: ${e.message}`);
  }
  out({ installed: true, label: LABEL, plist: PLIST_PATH, schedule: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` });
  return 0;
}

async function cmdUninstall() {
  const uid = process.getuid();
  await launchctl(['bootout', `gui/${uid}/${LABEL}`]).catch((e) => log(`bootout: ${e.message}`));
  rmSync(PLIST_PATH, { force: true });
  out({ installed: false, label: LABEL });
  return 0;
}

async function cmdStatus(cfg) {
  const uid = process.getuid();
  let launchd = 'not loaded';
  try {
    await launchctl(['print', `gui/${uid}/${LABEL}`]);
    launchd = 'loaded';
  } catch {
    /* print exits non-zero when unloaded */
  }
  out({
    label: LABEL,
    launchd,
    plist: PLIST_PATH,
    schedule: `${String(cfg.hour).padStart(2, '0')}:${String(cfg.minute).padStart(2, '0')}`,
    env: { FACTORY_SWEEP_DAYS: cfg.days, FACTORY_SWEEP_MAX_FILES: cfg.maxFiles, FACTORY_SWEEP_MAX_FINDINGS: cfg.maxFindings },
    logs: { out: join(LOG_DIR, 'launchd.out.log'), err: join(LOG_DIR, 'launchd.err.log') },
  });
  return 0;
}

const USAGE = 'usage: node scripts/factory-sweep.js [once|dry-run|install|uninstall|status] [--date YYYY-MM-DD] [--hour H --minute M]';

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  let flags;
  try {
    flags = parseFlags(argv.slice(1));
  } catch (e) {
    return die(`${e.message}\n${USAGE}`);
  }
  const cfg = sweep.readEnvConfig(process.env);
  if (cmd === 'once') return cmdSweep(flags, cfg, { dryRun: false });
  if (cmd === 'dry-run') return cmdSweep(flags, cfg, { dryRun: true });
  if (cmd === 'install') return cmdInstall(flags, cfg);
  if (cmd === 'uninstall') return cmdUninstall();
  if (cmd === 'status') return cmdStatus(cfg);
  process.stderr.write(`${USAGE}\n`);
  return 3;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main();
}
