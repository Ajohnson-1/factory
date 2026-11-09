// systemd USER units + timers for the factory runtime services (FM-5,
// card 6aee5f4d6e98279cb3ab3304; docs/factory-migration.md D7, §4.6, §6.1).
//
// The Linux branch behind install/status/uninstall of the four runtime
// CLIs (dispatch in lib/factory-platform.js; the darwin/launchd path stays
// byte-identical and default on macOS). Unit contracts come straight from
// §4.6: factory-daemon.service (Restart=always, RestartSec=30,
// WorkingDirectory=/opt/factory, Environment=PATH=…~/.local/node/bin…),
// factory-metrics.service + 6 h timer, factory-sweep.service + daily
// 03:15 timer, prod-watch.service + 300 s timer. The self driver already
// pins the daemon unit NAME: deploy-factory.js `UNIT =
// 'factory-daemon.service'` (restartLinux arms
// `systemd-run --user --on-active=2s systemctl --user restart …`) and
// verify-factory.js proves `systemctl --user is-active` +
// `journalctl -u factory-daemon.service` — so these installers MUST write
// exactly that unit.
//
// Self-restart race (same argument as scripts/lib/factory-launchd.js):
// a factory run is a CHILD of the daemon; installing the daemon from
// inside a run must never restart it inline (the SIGTERM cascade would
// kill the install itself between stop and start). After writing units, an
// ALREADY-ACTIVE daemon unit gets its restart ARMED via
// `systemd-run --user --on-active=2s` — the D7 mechanism, matching
// deploy-factory.js restartLinux.
//
// Host-fail-closed (lib/factory-platform.js assertSystemdUser): every
// lifecycle op probes `systemctl --user is-system-running` FIRST — a
// Linux host without linger/user bus (the §6.1 `loginctl enable-linger
// factory` prereq) throws loudly instead of a silent no-op.
//
// Every system touch goes through injectable seams (`run`, `systemdRun`,
// `unitDir`, `envFile`, `write`…) so the whole branch unit-tests on the
// macOS gate host with scripted runners + scratch dirs; the live-box
// enable/active assertions are the deferred FM-6 hand (no box here).

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSystemdUser } from './factory-platform.js';

/** Repo root — the default `root` every lifecycle op installs FROM. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Unit names — the daemon name is FROZEN by deploy-factory.js UNIT +
 *  verify-factory.js unitActiveLinux (FM-4). §4.6 names the rest. */
export const UNITS = {
  daemon: { service: 'factory-daemon.service' },
  metrics: { service: 'factory-metrics.service', timer: 'factory-metrics.timer' },
  sweep: { service: 'factory-sweep.service', timer: 'factory-sweep.timer' },
  prodWatch: { service: 'prod-watch.service', timer: 'prod-watch.timer' },
};

/** Cadence constants mirroring the launchd plists: metrics StartInterval
 *  21600 s (6 h), prod-watch StartInterval 300 s, sweep calendar 03:15. */
export const METRICS_INTERVAL_SEC = 6 * 3600;
export const PROD_WATCH_INTERVAL_SEC = 300;
export const SWEEP_HOUR = 3;
export const SWEEP_MINUTE = 15;

/** The 0600 baked env file (gitignored data/). Shared by all units;
 *  uninstallDaemon removes it (satellites leave it in place). */
export const ENV_FILE_REL = join('data', 'factory-env.conf');

export function unitDir({ env = process.env, home = homedir() } = {}) {
  const base = String(env.XDG_CONFIG_HOME ?? '').trim() || join(home, '.config');
  return join(base, 'systemd', 'user');
}

/** The unit PATH per §4.6 / the card's "env baking" sub-step: the node
 *  dir actually running this installer, PLUS ~/.local/node/bin baked in
 *  (the provisioned node home, docs/factory-migration.md §6.1 step 2),
 *  PLUS the standard system dirs — launchd's plist PATH shape. */
export function unitPath({ nodePath = process.execPath, home = homedir() } = {}) {
  return [dirname(nodePath), join(home, '.local', 'node', 'bin'), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}

/**
 * Render one unit file (services). Pure.
 * @param {{name, description, type, exec, envLines, restart?, restartSec?, workingDirectory}} o
 */
export function serviceUnit({ name, description, type = 'simple', exec, envLines = [], restart, restartSec, workingDirectory }) {
  const lines = ['[Unit]', `Description=${description}`, ''];
  if (type === 'simple') lines.push('After=network-online.target', '');
  lines.push('[Service]', `Type=${type}`);
  if (workingDirectory) lines.push(`WorkingDirectory=${workingDirectory}`);
  lines.push(...envLines);
  lines.push(`ExecStart=${exec}`);
  if (type === 'simple' && restart) {
    lines.push(`Restart=${restart}`);
    if (restartSec !== undefined) lines.push(`RestartSec=${restartSec}`);
  }
  if (type === 'simple') lines.push('', '[Install]', 'WantedBy=default.target');
  lines.push('');
  return lines.join('\n');
}

/**
 * Render one timer unit. Pure. Exactly one of `onUnitActiveSec` (interval,
 * launchd StartInterval semantics — metrics/prod-watch) or `onCalendar`
 * (calendar, StartCalendarInterval semantics — sweep). `persistent`
 * catches up missed runs (host off at 03:15 → runs on boot).
 */
export function timerUnit({ name, description, onUnitActiveSec, onCalendar, persistent = true }) {
  if (!onUnitActiveSec && !onCalendar) throw new Error(`timer ${name}: needs onUnitActiveSec or onCalendar`);
  const lines = ['[Unit]', `Description=${description}`, '', '[Timer]'];
  if (onUnitActiveSec) {
    lines.push(`OnBootSec=${onUnitActiveSec}s`, `OnUnitActiveSec=${onUnitActiveSec}s`);
  }
  if (onCalendar) lines.push(`OnCalendar=${onCalendar}`);
  if (persistent) lines.push('Persistent=true');
  lines.push('', '[Install]', 'WantedBy=timers.target', '');
  return lines.join('\n');
}

/** Sweep's OnCalendar from hour/minute (launchd StartCalendarInterval parity). */
export function sweepCalendar({ hour = SWEEP_HOUR, minute = SWEEP_MINUTE } = {}) {
  return `*-*-* ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

/** Common Environment= lines baked into every unit. */
export function envLines({ nodePath = process.execPath, home = homedir(), envFile }) {
  return [`Environment=PATH=${unitPath({ nodePath, home })}`, `EnvironmentFile=${envFile}`];
}

/**
 * Normalize the repo .env into systemd EnvironmentFile syntax: systemd's
 * parser has NO `export` prefix and no shell quoting — strip `export `,
 * drop blank/comment lines, unwrap surrounding quotes, keep KEY=value.
 */
export function normalizeEnv(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue; // comments + junk never reach the unit
    out.push(`${m[1]}=${m[2].trim().replace(/^(['"])(.*)\1$/, '$2')}`);
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

/**
 * Write the 0600 EnvironmentFile from the repo .env (secrets stay
 * machine-readable-only even if the checkout tree is world-readable).
 * Missing .env → an empty 0600 file (units still start; the CLIs' own
 * fail-closed env checks stay loud).
 */
export function bakeEnvFile({ root = ROOT, target = join(root, ENV_FILE_REL), read = readFileSync } = {}) {
  let text = '';
  try {
    text = read(join(root, '.env'), 'utf8');
  } catch {
    text = '';
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, normalizeEnv(text));
  chmodSync(tmp, 0o600);
  renameSync(tmp, target); // atomic replace; 0600 survives the rename
  chmodSync(target, 0o600); // deterministic even when target pre-existed (no-op chmod)
  return { envFile: target, keys: normalizeEnv(text).split('\n').filter(Boolean).length };
}

function defaultRunner({ args, timeoutMs = 30_000 } = {}) {
  // Same spawnSync shape as deploy-factory.js defaultSystemdRun.
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: timeoutMs });
  if (r.status === null || r.status === undefined) {
    return { code: null, stdout: r.stdout || '', stderr: String(r.error?.message ?? `${args[0]} spawn failed or timed out`) };
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function defaultSystemdRun(o = {}) {
  return defaultRunner({ args: ['systemd-run', ...o.args], timeoutMs: o.timeoutMs ?? 15_000 });
}

function writeUnit(unitDir, file, content) {
  mkdirSync(unitDir, { recursive: true });
  const tmp = join(unitDir, `${file}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, join(unitDir, file)); // byte-stable atomic replace
  return join(unitDir, file);
}

/**
 * Install/repair the daemon unit (§4.6 contract). First install: enable
 * --now. Re-install while ACTIVE (the factory-run self-restart case): the
 * restart is ARMED via systemd-run (D7), never inline — a SIGTERM cascade
 * from the restart would otherwise kill this very installer.
 */
export function installDaemon({
  nodePath = process.execPath,
  root = ROOT,
  home = homedir(),
  unitDir: dir = unitDir(),
  envFile = join(root, ENV_FILE_REL),
  run = defaultRunner,
  systemdRun = defaultSystemdRun,
  read = readFileSync,
} = {}) {
  assertSystemdUser({ run });
  const env = envLines({ nodePath, home, envFile });
  bakeEnvFile({ root, target: envFile, read });
  const unitPathFile = writeUnit(dir, UNITS.daemon.service, serviceUnit({
    name: UNITS.daemon.service,
    description: 'software factory dispatcher — sole Ready-list poller (docs/factory-migration.md §7)',
    exec: `${nodePath} ${join(root, 'scripts', 'factory-daemon.js')} run`,
    envLines: env,
    restart: 'always',
    restartSec: 30,
    workingDirectory: root,
  }));
  const reload = run({ args: ['systemctl', '--user', 'daemon-reload'] });
  if (reload.code !== 0) throw new Error(`systemctl --user daemon-reload failed: ${(reload.stderr || reload.stdout).trim()}`);
  run({ args: ['systemctl', '--user', 'enable', UNITS.daemon.service] });
  const active = run({ args: ['systemctl', '--user', 'is-active', UNITS.daemon.service] }).code === 0;
  let start;
  if (active) {
    const armed = systemdRun({ args: ['--user', '--on-active=2s', 'systemctl', '--user', 'restart', UNITS.daemon.service] });
    if (armed.code !== 0) {
      throw new Error(`systemd-run restart arm failed: ${(armed.stderr || armed.stdout || '').trim().slice(0, 300)}`);
    }
    start = `restart armed via systemd-run (2 s) — installer is a child of the daemon (lib/factory-launchd.js race, D7)`;
  } else {
    const started = run({ args: ['systemctl', '--user', 'start', UNITS.daemon.service] });
    if (started.code !== 0) throw new Error(`systemctl --user start failed: ${(started.stderr || started.stdout).trim()}`);
    start = 'started';
  }
  return { installed: true, manager: 'systemd', unit: UNITS.daemon.service, unitFile: unitPathFile, envFile, start };
}

/**
 * Install a satellite (metrics 6 h / sweep 03:15 / prod-watch 300 s):
 * service + timer pair; `enable --now` the TIMER. `runAtLoad` mirrors the
 * launchd plists' RunAtLoad=true (metrics, prod-watch fire once at
 * install); sweep stays calendar-only.
 */
export function installSatellite({
  name,
  script,
  args: scriptArgs = ['once'],
  description,
  timer,
  runAtLoad = false,
  nodePath = process.execPath,
  root = ROOT,
  home = homedir(),
  unitDir: dir = unitDir(),
  envFile = join(root, ENV_FILE_REL),
  run = defaultRunner,
  read = readFileSync,
} = {}) {
  assertSystemdUser({ run });
  const env = envLines({ nodePath, home, envFile });
  bakeEnvFile({ root, target: envFile, read });
  const svcFile = writeUnit(dir, `${name}.service`, serviceUnit({
    name: `${name}.service`,
    description,
    type: 'oneshot',
    exec: `${nodePath} ${join(root, 'scripts', script)} ${scriptArgs.join(' ')}`,
    envLines: env,
    workingDirectory: root,
  }));
  const timerFile = writeUnit(dir, `${name}.timer`, timerUnit({
    name: `${name}.timer`,
    description: `${description} timer`,
    ...timer,
  }));
  const reload = run({ args: ['systemctl', '--user', 'daemon-reload'] });
  if (reload.code !== 0) throw new Error(`systemctl --user daemon-reload failed: ${(reload.stderr || reload.stdout).trim()}`);
  const enabled = run({ args: ['systemctl', '--user', 'enable', '--now', `${name}.timer`] });
  if (enabled.code !== 0) throw new Error(`systemctl --user enable --now ${name}.timer failed: ${(enabled.stderr || enabled.stdout).trim()}`);
  if (runAtLoad) {
    // launchd RunAtLoad parity: one immediate pass (board write by design).
    run({ args: ['systemctl', '--user', 'start', `${name}.service`] });
  }
  return { installed: true, manager: 'systemd', units: [`${name}.timer`, `${name}.service`], unitFiles: [timerFile, svcFile], envFile, runAtLoad };
}

export function installMetrics(o = {}) {
  return installSatellite({
    name: 'factory-metrics',
    script: 'factory-metrics.js',
    description: 'factory metrics report pass (launchd StartInterval 21600 s parity)',
    timer: { onUnitActiveSec: o.intervalSec ?? METRICS_INTERVAL_SEC },
    runAtLoad: true,
    ...o,
  });
}
export function installSweep(o = {}) {
  return installSatellite({
    name: 'factory-sweep',
    script: 'factory-sweep.js',
    description: 'nightly standing review sweep (launchd 03:15 calendar parity)',
    timer: { onCalendar: sweepCalendar({ hour: o.hour, minute: o.minute }) },
    ...o,
  });
}
export function installProdWatch(o = {}) {
  return installSatellite({
    name: 'prod-watch',
    script: 'prod-watch.js',
    description: 'prod watchdog probe pass (launchd StartInterval 300 s parity)',
    timer: { onUnitActiveSec: o.intervalSec ?? PROD_WATCH_INTERVAL_SEC },
    runAtLoad: true,
    ...o,
  });
}

/** Parse `systemctl --user show` KEY=VALUE output into an object. */
export function parseShowProps(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Unit states + file presence for status CLIs. Units whose files are
 * absent report {installed:false}; present ones carry ActiveState/SubState/
 * UnitFileState (+ExecMainPID) from `systemctl --user show`.
 */
export function statusUnits({ units, unitDir: dir = unitDir(), run = defaultRunner, exists = existsSync } = {}) {
  const result = { manager: 'systemd', unitDir: dir, units: {} };
  const present = [];
  for (const u of units) {
    if (exists(join(dir, u))) present.push(u);
    else result.units[u] = { installed: false };
  }
  if (present.length) {
    const r = run({ args: ['systemctl', '--user', 'show', ...present, '-p', 'Id', '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState', '-p', 'ExecMainPID'] });
    // `show` prints one block of KEY=VALUE lines per unit, a new block
    // starting at Id= — regroup on it.
    let cur = null;
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.match(/^(Id|ActiveState|SubState|UnitFileState|ExecMainPID)=(.*)$/);
      if (!m) continue;
      if (m[1] === 'Id') {
        cur = m[2];
        result.units[cur] = { installed: true };
        continue;
      }
      if (!cur) continue;
      const key = { ActiveState: 'active', SubState: 'subState', UnitFileState: 'enabled', ExecMainPID: 'pid' }[m[1]];
      result.units[cur][key] = m[2];
    }
  }
  return result;
}

export function daemonStatus(o = {}) {
  return statusUnits({ units: [UNITS.daemon.service], ...o });
}

/**
 * Uninstall: disable --now each unit FIRST (the SIGTERM-cascade
 * convergence argument from factory-daemon.js's launchd uninstall: once
 * disabled+stopped, a surviving process tree can never re-load anything),
 * then remove files, then reload. The daemon uninstall also removes the
 * shared 0600 env file.
 */
export function uninstallUnits({ units, removeEnvFile = false, unitDir: dir = unitDir(), envFile, root = ROOT, run = defaultRunner } = {}) {
  assertSystemdUser({ run });
  for (const u of units) {
    run({ args: ['systemctl', '--user', 'disable', '--now', u] }); // failures (not loaded) are fine
    rmSync(join(dir, u), { force: true });
  }
  if (removeEnvFile) rmSync(envFile ?? join(root, ENV_FILE_REL), { force: true });
  const reload = run({ args: ['systemctl', '--user', 'daemon-reload'] });
  if (reload.code !== 0) throw new Error(`systemctl --user daemon-reload failed: ${(reload.stderr || reload.stdout).trim()}`);
  return { uninstalled: true, manager: 'systemd', units };
}

export function uninstallDaemon(o = {}) {
  return uninstallUnits({ units: [UNITS.daemon.service], removeEnvFile: true, ...o });
}
