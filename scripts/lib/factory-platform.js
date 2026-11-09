// Service-manager platform branch for install/status/uninstall (FM-5,
// card 6aee5f4d6e98279cb3ab3304; docs/factory-migration.md D7, §4.6).
//
// The four runtime CLIs (factory-daemon / factory-metrics / factory-sweep /
// prod-watch) keep their launchd implementations byte-identical and call
// through this dispatch: darwin → 'launchd' (zero probing — the laptop
// dispatcher path must not regress), linux → 'systemd' (user units +
// timers via lib/factory-platform-systemd.js). Anything else throws —
// fail closed, never guess a manager on an unknown platform.
//
// Host-fail-closed on linux: a machine whose systemd *user* bus is
// unusable (no linger, no XDG_RUNTIME_DIR — the D7 prereq is `loginctl
// enable-linger factory`, docs/factory-migration.md §6.1) gets a loud
// throw from assertSystemdUser before any unit file is written, never a
// silent no-op that leaves the operator believing the timer is installed.

import { spawnSync } from 'node:child_process';

const MANAGER_ENV = 'FACTORY_SERVICE_MANAGER'; // test/diagnostic override: launchd | systemd

/**
 * Which service manager owns this host's runtime units.
 * @param {{platform?: string, env?: NodeJS.ProcessEnv}} [opts] injectable for tests
 * @returns {'launchd'|'systemd'}
 * @throws on any platform without a supported manager
 */
export function detectServiceManager({ platform = process.platform, env = process.env } = {}) {
  const override = String(env[MANAGER_ENV] ?? '').trim();
  if (override) {
    if (override === 'launchd' || override === 'systemd') return override;
    throw new Error(`${MANAGER_ENV}="${override}" is invalid (want launchd | systemd)`);
  }
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  throw new Error(
    `unsupported platform "${platform}": install/status/uninstall are supported on macOS (launchd) and Linux (systemd user units) only`,
  );
}

function defaultRunner({ args, timeoutMs = 15_000 } = {}) {
  // Same spawnSync shape as deploy-factory.js defaultSystemdRun.
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: timeoutMs });
  if (r.status === null || r.status === undefined) {
    return { code: null, stdout: r.stdout || '', stderr: String(r.error?.message ?? `${args[0]} spawn failed or timed out`) };
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Host-fail-closed probe: is a usable systemd USER session (manager +
 * linger + bus) available? `systemctl --user is-system-running` is
 * read-only and exits non-zero with "Failed to connect to bus" (or no
 * manager at all) when the session is unusable.
 * @param {{run?: (o:{args:string[]})=>{code:number,stdout:string,stderr:string}}} [opts]
 * @throws with the §6.1 remedies named
 */
export function assertSystemdUser({ run = defaultRunner } = {}) {
  const r = run({ args: ['systemctl', '--user', 'is-system-running'] });
  if (r.code === 0) return true;
  const detail = (r.stdout || r.stderr || `exit ${r.code}`).trim().split('\n')[0];
  throw new Error(
    `systemd user session unavailable (${detail}) — run \`loginctl enable-linger $(whoami)\` as root and re-enter the shell with XDG_RUNTIME_DIR set (docs/factory-migration.md §6.1)`,
  );
}
