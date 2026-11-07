// launchd plumbing for the factory daemon (docs/factory.md).
//
// Self-restart race this guards against: a factory run is a CHILD of the
// daemon. When the run's ops step executes `factory-daemon.js install`, the
// `bootout` makes launchd SIGTERM the daemon, the daemon's shutdown handler
// forwards SIGTERM to the active run, and the run's tool process — the
// `install` itself — dies between `bootout` and `bootstrap`. The launchd job
// ends up unloaded and NEVER returns (KeepAlive only revives already-loaded
// jobs), so the factory silently stops dispatching. A detached child armed
// BEFORE the bootout survives the SIGTERM cascade (its own session escapes
// group kills) and retries until the job is loaded again.
import { execFile } from 'node:child_process';

export const launchctl = (argv) =>
  new Promise((res, rej) => execFile('launchctl', argv, (e) => (e ? rej(e) : res())));

/**
 * Retry until the launchd job is loaded, bootstrapping whenever absent.
 * Converges no matter which sibling survived: an inline bootstrap that
 * completed (first `print` succeeds), one that was killed mid-flight
 * (bootstrap re-runs), or a half-finished inline bootstrap still holding
 * launchd (bootstrap fails with "already bootstrapped", retried next tick).
 * @returns {Promise<boolean>} true once the job is visible in launchd
 */
export async function ensureBootstrapped({
  label,
  plist,
  launch = launchctl,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  retries = 12,
  delayMs = 1500,
} = {}) {
  const uid = process.getuid();
  const job = `gui/${uid}/${label}`;
  for (let i = 0; i < retries; i++) {
    await sleep(delayMs);
    if (await launch(['print', job]).then(() => true, () => false)) return true;
    await launch(['bootstrap', `gui/${uid}`, plist]).catch(() => {});
  }
  return launch(['print', job]).then(() => true, () => false);
}
