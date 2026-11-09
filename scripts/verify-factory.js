// scripts/verify-factory.js — the `self` driver's verify (docs/factory-migration.md
// §4.5): the daemon unit must be ACTIVE and the daemon log must show a
// SUCCESSFUL BOARD POLL after the deploy's restart — unit active alone is not
// enough (a daemon that can't reach Trello is dead weight on a board-driven
// system).
//
// Markers it greps (scripts/factory-daemon.js log output):
//   boot  — `watching "Ready" on …`          (one per boot)
//   poll  — `[poll] board <id> poll ok — first successful poll since boot`
//           (one per boot per board, after the first successful Trello fetch)
// A poll line only counts when it follows a boot line that is itself stamped
// AFTER the deploy history entry's restart ts — stale lines from before the
// restart can never satisfy the proof.
//
// The restart is ARMED (detached guard / systemd-run timer), not completed,
// when deploy exits — so verify waits: unit + markers are re-checked every
// FACTORY_VERIFY_INTERVAL_MS until proven or FACTORY_VERIFY_TIMEOUT_MS.
//
// Output contract mirrors scripts/verify-deploy.js: stdout is ONLY the verdict
// JSON (the scheduler pipes stdout into the [VERIFY:*] comment); exit 0 PASS,
// exit 1 FAIL. Platform branch (D7): darwin → `launchctl print` + the log file
// parsed out of the installed plist's StandardOutPath; linux → `systemctl
// --user is-active` + `journalctl -u factory-daemon.service --since=<restart>`.
//
// usage: node scripts/verify-factory.js [--repo <name>]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { deployTarget, readHistory, UNIT } from './deploy-factory.js';
import { LABEL, PLIST_PATH } from './factory-daemon.js';

export const BOOT_MARKER = 'watching "Ready"';
export const POLL_MARKER = 'poll ok — first successful poll since boot';

const envNum = (k, d) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** Process seam: args[0] = binary, rest argv; {code, stdout, stderr}. */
export function defaultRunner({ args, timeoutMs = 15000 } = {}) {
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: timeoutMs });
  if (r.status === null || r.status === undefined) {
    return { code: null, stdout: r.stdout || '', stderr: r.stderr || String(r.error?.message ?? 'spawn failed or timed out') };
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** darwin "unit active": the launchd job is loaded (launchctl print succeeds). */
export function unitActiveDarwin({ run = defaultRunner, label = LABEL, uid = process.getuid() } = {}) {
  const r = run({ args: ['launchctl', 'print', `gui/${uid}/${label}`] });
  return { active: r.code === 0, detail: r.code === 0 ? '' : `launchctl print ${label} exited ${r.code}` };
}

/** linux "unit active": systemctl --user is-active exits 0. */
export function unitActiveLinux({ run = defaultRunner, unit = UNIT } = {}) {
  const r = run({ args: ['systemctl', '--user', 'is-active', unit] });
  return { active: r.code === 0, detail: r.code === 0 ? '' : `${unit}: ${(r.stdout || 'not active').trim()}` };
}

/** The installed daemon's log path = the installed plist's StandardOutPath;
 *  null when the job isn't installed (no plist) or the key is absent. */
export function daemonLogPath({ plist = PLIST_PATH } = {}) {
  try {
    const xml = readFileSync(plist, 'utf8');
    const m = xml.match(/<key>StandardOutPath<\/key>\s*<string>([^<]+)<\/string>/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** linux log reader: journal since the restart (last 500 lines cap — the
 *  markers land right after boot; a flooded journal still shows them). */
export function journalLog({ run = defaultRunner, unit = UNIT, since } = {}) {
  const r = run({ args: ['journalctl', '-u', unit, `--since=${since}`, '--no-pager', '-n', '500'] });
  return r.code === 0 ? r.stdout : '';
}

/**
 * Scan daemon log text for the post-restart proof: a boot marker line stamped
 * strictly after `restartAtIso`, followed by a poll-ok line (its own stamp, if
 * present, must also be after — unparseable stamps inherit "after the boot").
 * @returns {{line:string}|{reason:string}}
 */
export function pollLineAfter(text, restartAtIso) {
  let bootSeen = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    const ts = line.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z/)?.[0] ?? null;
    if (line.includes(BOOT_MARKER)) {
      if (ts && ts <= restartAtIso) continue; // boot from before the restart
      bootSeen = true;
      continue;
    }
    if (bootSeen && line.includes(POLL_MARKER)) {
      if (ts && ts <= restartAtIso) continue;
      return { line: line.trim().slice(0, 300) };
    }
  }
  return { reason: bootSeen ? 'boot marker seen after restart, poll-ok not logged yet' : 'no boot marker after the restart yet' };
}

/**
 * @returns {Promise<{verdict:'PASS'|'FAIL', code:number, verdictJson:object}>}
 */
export async function verifyDeploy({
  target = deployTarget(),
  platform = process.platform,
  history = null,
  run = defaultRunner,
  readLog = null,
  now = () => new Date(),
  mono = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = envNum('FACTORY_VERIFY_TIMEOUT_MS', 180000),
  intervalMs = envNum('FACTORY_VERIFY_INTERVAL_MS', 5000),
} = {}) {
  const finish = (verdict, extra = {}) => {
    const verdictJson = {
      verdict,
      driver: 'self',
      ts: now().toISOString(),
      ...(target.ok ? { clone: target.clone, repo: target.repo.name } : {}),
      ...extra,
    };
    return { verdict, code: verdict === 'PASS' ? 0 : 1, verdictJson };
  };
  if (!target.ok) return finish('FAIL', { reason: target.error });
  const entries = (history ?? readHistory(target.clone)).filter((e) => e.action === 'deploy' || e.action === 'rollback');
  if (!entries.length) {
    return finish('FAIL', { reason: `no deploy history in ${target.clone} — run scripts/deploy-factory.js deploy first` });
  }
  const last = entries[entries.length - 1];
  const restartAt = last.ts;

  let read = readLog;
  let unitName;
  if (platform === 'darwin') {
    unitName = LABEL;
    const logPath = daemonLogPath();
    if (!read) {
      if (!logPath) return finish('FAIL', { reason: `no installed daemon plist at ${PLIST_PATH} (StandardOutPath unknown)`, unit: unitName });
      read = () => {
        try {
          return readFileSync(logPath, 'utf8');
        } catch {
          return '';
        }
      };
    }
  } else if (platform === 'linux') {
    unitName = UNIT;
    if (!read) read = () => journalLog({ run, unit: UNIT, since: restartAt });
  } else {
    return finish('FAIL', { reason: `verify unsupported on platform ${JSON.stringify(platform)} (darwin|linux)` });
  }
  const unitActive = platform === 'darwin' ? () => unitActiveDarwin({ run }) : () => unitActiveLinux({ run });

  const start = mono();
  for (;;) {
    const { active, detail } = unitActive();
    let res = { reason: detail || `unit ${unitName} not active` };
    if (active) res = pollLineAfter(String(read() ?? ''), restartAt);
    if (res.line) {
      return finish('PASS', {
        sha: last.sha,
        short: last.short,
        restartAt,
        unit: unitName,
        action: last.action,
        pollLine: res.line,
      });
    }
    if (mono() - start >= timeoutMs) {
      return finish('FAIL', {
        sha: last.sha,
        short: last.short,
        restartAt,
        unit: unitName,
        action: last.action,
        reason: `waited ${Math.round((mono() - start) / 1000)}s: ${res.reason}`,
      });
    }
    await sleep(intervalMs);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let repoName = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') repoName = argv[++i] ?? '';
    else {
      console.error(`verify-factory: unknown argument ${JSON.stringify(argv[i])}`);
      return 2;
    }
  }
  const res = await verifyDeploy({ target: deployTarget({ repoName }) });
  console.log(JSON.stringify(res.verdictJson));
  return res.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
