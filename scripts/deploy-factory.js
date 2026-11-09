// scripts/deploy-factory.js — the `self` deploy driver (docs/factory-migration.md
// §4.5, D6): deploying the FACTORY repo = fast-forward the runtime clone to
// origin/<baseBranch> and restart the daemon that runs from it. There is no
// build: pushing to master IS the artifact.
//
// WHY THE RESTART IS DETACHED: this deploy runs as a child of the daemon being
// restarted. `bootout` SIGTERMs the daemon, whose shutdown handler forwards to
// the active run — possibly killing THIS process. So the restart is handed to a
// detached guard in its own session (the bootstrap-guard precedent,
// scripts/lib/factory-launchd.js + factory-daemon.js `bootstrapGuard()`) and
// deploy returns IMMEDIATELY: restart = ARMED; prove-it-yourself is
// verify-factory.js (unit active + a board poll logged after the restart). If
// the SIGTERM cascade does kill this run, crash recovery resumes the card and
// the deploy is idempotent — an ff-pull of the same sha is a no-op and the
// guard re-arm is harmless.
//
// The comment contract stays identical to docker-ssh: the scheduler posts
// [DEPLOY] sha=… / [ROLLBACK] / [VERIFY:*] from these exit codes + stdout.
//
//   deploy   — dirty runtime clone → exit 2 (fail-closed: never clobber local
//              work); fetch + checkout base branch + `merge --ff-only`
//              origin/<branch> (a non-ff merge = divergence → exit 1, human
//              reconcile), then arm the restart and append deploy history.
//   rollback — second-to-last history entry (deterministic two-sha bounce, the
//              .deploy-history precedent): `checkout --detach` that sha + arm
//              restart + append rollback history.
//
// Platform restart branch (process.platform, D7):
//   darwin — detached guard: sleep → launchctl bootout → ensureBootstrapped.
//   linux  — systemd-run --user --on-active=2s systemctl --user restart
//            factory-daemon.service (the FM-5 user unit; D7).
//
// usage: node scripts/deploy-factory.js deploy   [--repo <name>]
//        node scripts/deploy-factory.js rollback [--repo <name>]
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { detectRepo, loadRegistry } from './lib/factory-registry.js';
import { LABEL, PLIST_PATH } from './factory-daemon.js';
import { unitActiveDarwin, unitActiveLinux } from './verify-factory.js';

const LAUNCHD_LIB_URL = pathToFileURL(join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'scripts/lib/factory-launchd.js')).href;

/** systemd user unit installed by FM-5 (docs/factory-migration.md D7). */
export const UNIT = 'factory-daemon.service';
/** Deploy history inside the runtime clone (`data/` is gitignored). */
export const HISTORY_REL = join('data', 'factory-deploy-history.jsonl');
/** Head start before the detached guard boots the daemon out (ms). */
export const RESTART_DELAY_MS = 2000;

/**
 * Local git seam (the deploy-ssh.js runner precedent): argv array in,
 * {code, stdout, stderr} out; code=null on spawn failure/timeout.
 */
export function defaultGitRunner({ args, cwd, timeoutMs = 120000 } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  if (r.status === null || r.status === undefined) {
    return { code: null, stdout: r.stdout || '', stderr: r.stderr || String(r.error?.message ?? 'git spawn failed or timed out') };
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Resolve the self-deploy target: registry entry via the §4.4 resolver
 * (`--repo` flag → cwd match → defaultRepo), driver must be `self`, clone =
 * `deploy.runtimeClone` ?? `repoDir` (FACTORY_DEPLOY_CLONE overrides —
 * smoke/staging escape hatch).
 * @returns {{ok:true, repo:object, clone:string, branch:string}|{ok:false, error:string}}
 */
export function deployTarget({ repoName = null, env = process.env, cwd = process.cwd(), registry } = {}) {
  let reg;
  try {
    reg = registry ?? loadRegistry({ env });
  } catch (e) {
    return { ok: false, error: `registry unavailable: ${e.message}` };
  }
  const d = detectRepo(reg, { repo: repoName, cwd });
  if (!d.ok) {
    return { ok: false, error: `unknown repo ${JSON.stringify(d.candidates?.[0])} — see config/factory-repos.json` };
  }
  if (d.repo.deploy?.driver !== 'self') {
    return { ok: false, error: `repo ${d.repo.name} deploy driver is ${JSON.stringify(d.repo.deploy?.driver)} — deploy-factory.js serves the "self" driver only (docker-ssh repos use scripts/deploy.js)` };
  }
  const clone = env.FACTORY_DEPLOY_CLONE || d.repo.deploy.runtimeClone || d.repo.repoDir;
  return { ok: true, repo: d.repo, clone, branch: d.repo.baseBranch };
}

/** Append-only deploy history lines (JSONL, `.deploy-history` precedent). */
export function historyPath(clone) {
  return join(clone, HISTORY_REL);
}
export function parseHistory(text) {
  const entries = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = JSON.parse(t);
      if (e && typeof e === 'object' && typeof e.sha === 'string') entries.push(e);
    } catch {
      /* truncated / garbage line — skip (append-only truth keeps earlier lines) */
    }
  }
  return entries;
}
export function readHistory(clone) {
  try {
    return parseHistory(readFileSync(historyPath(clone), 'utf8'));
  } catch {
    return [];
  }
}
function appendHistory(clone, entry) {
  mkdirSync(dirname(historyPath(clone)), { recursive: true });
  appendFileSync(historyPath(clone), `${JSON.stringify(entry)}\n`);
}

/**
 * Darwin restart: detached guard in its own session (mirrors the daemon's
 * bootstrapGuard) — sleep, bootout, then ensureBootstrapped's retry loop.
 * Returns once ARMED; completion is verify-factory.js's proof.
 */
export function restartDarwin({
  label = LABEL,
  plist = PLIST_PATH,
  delayMs = RESTART_DELAY_MS,
  nodePath = process.execPath,
  libUrl = LAUNCHD_LIB_URL,
  spawnImpl = spawn,
  uid = process.getuid(),
} = {}) {
  const script =
    `await new Promise((r) => setTimeout(r, ${Number(delayMs) || 0}));\n` +
    `const { launchctl, ensureBootstrapped } = await import(${JSON.stringify(String(libUrl))});\n` +
    `await launchctl(['bootout', ${JSON.stringify(`gui/${uid}/${label}`)}]).catch(() => {});\n` +
    `const ok = await ensureBootstrapped({ label: ${JSON.stringify(String(label))}, plist: ${JSON.stringify(String(plist))} });\n` +
    `process.exit(ok ? 0 : 1);`;
  const child = spawnImpl(String(nodePath), ['--input-type=module', '-e', script], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref?.();
  return { ok: true, via: `launchd-guard pid ${child.pid}`, detached: true };
}

/** Linux restart: systemd-run arms `systemctl --user restart <unit>` on a
 *  timer, so the restarting unit can't die mid-call (D7 user units). */
export function restartLinux({
  unit = UNIT,
  onActiveSec = 2,
  run = defaultSystemdRun,
} = {}) {
  const r = run({ args: ['--user', `--on-active=${onActiveSec}s`, 'systemctl', '--user', 'restart', unit] });
  if (r.code !== 0) {
    return { ok: false, error: `systemd-run failed (code ${r.code}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}` };
  }
  return { ok: true, via: `systemd-run ${unit} in ${onActiveSec}s` };
}
function defaultSystemdRun({ args, timeoutMs = 15000 } = {}) {
  const r = spawnSync('systemd-run', args, { encoding: 'utf8', timeout: timeoutMs });
  if (r.status === null || r.status === undefined) {
    return { code: null, stdout: r.stdout || '', stderr: r.stderr || String(r.error?.message ?? 'systemd-run spawn failed or timed out') };
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Platform branch (D7): the restart function for this host, or null. */
export function restartFor(platform = process.platform) {
  if (platform === 'darwin') return (opts) => restartDarwin(opts);
  if (platform === 'linux') return (opts) => restartLinux(opts);
  return null;
}

/**
 * deploy — ff the runtime clone to origin/<branch>, then arm the restart.
 * @returns {{ok:boolean, exit:number, sha?:string, short?:string, via?:string, error?:string}}
 */
export function deploy({ target, restart = restartFor(), platform = process.platform, git = defaultGitRunner, unitActive = undefined, env = process.env, out = (s) => console.log(s) } = {}) {
  if (!target.ok) return { ok: false, exit: 2, error: target.error };
  const { clone, branch } = target;
  const fail = (exit, error) => ({ ok: false, exit, error });
  if (!restart) return fail(2, `no detached daemon restart for platform ${JSON.stringify(platform)} (darwin|linux)`);
  if (!existsSync(join(clone, '.git'))) {
    return fail(2, `runtime clone ${clone} is not a git checkout — clone it first (git clone origin ${clone})`);
  }
  const g = (args, opts) => git({ args: ['-C', clone, ...args], ...opts });

  const dirty = g(['status', '--porcelain']);
  if (dirty.code !== 0) return fail(1, `git status failed (code ${dirty.code}): ${(dirty.stderr || dirty.stdout || '').trim().slice(0, 300)}`);
  if (dirty.stdout.trim() !== '') {
    return fail(2, `runtime clone ${clone} has uncommitted changes — commit/stash first (fail-closed: deploy never clobbers local work)`);
  }
  const fetched = g(['fetch', 'origin'], { timeoutMs: 120000 });
  if (fetched.code !== 0) return fail(1, `git fetch origin failed (code ${fetched.code}): ${(fetched.stderr || fetched.stdout || '').trim().slice(0, 300)}`);
  // Rollback leaves a detached HEAD; get back onto the branch before ff-ing.
  const attached = g(['symbolic-ref', '-q', 'HEAD']);
  if (attached.code !== 0) {
    const co = g(['checkout', '-q', branch]);
    if (co.code !== 0) return fail(1, `checkout ${branch} failed (code ${co.code}): ${(co.stderr || co.stdout || '').trim().slice(0, 300)}`);
  }
  const merged = g(['merge', '--ff-only', `origin/${branch}`]);
  if (merged.code !== 0) {
    return fail(1, `merge --ff-only origin/${branch} failed — the runtime clone diverged from origin/${branch}; reconcile by hand (${(merged.stderr || merged.stdout || '').trim().slice(0, 300)})`);
  }
  const head = g(['rev-parse', 'HEAD']);
  const sha = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return fail(1, `rev-parse HEAD returned ${JSON.stringify(sha)}`);
  const short = g(['rev-parse', '--short=7', sha]);
  if (short.code !== 0 || !/^[0-9a-f]{7}$/.test(short.stdout.trim())) return fail(1, `rev-parse --short=7 failed: ${JSON.stringify(short.stdout.trim())}`);

  // FM-4 idempotent redeploy: the unit is ALREADY ACTIVE on the target sha
  // (last deploy-history entry = this sha) → arming another restart only
  // kills the caller's own run a second time; crash-resume would re-run
  // deploy, self-kill again, and bounce into the crash cap. No-op exit 0,
  // NO history append — verify-factory checks the ORIGINAL restart's
  // boot+poll markers against its ts. Unit INACTIVE → arm the guard anyway
  // (its bootstrap revives a dead unit). FACTORY_DEPLOY_FORCE=1 bypasses
  // (real config change landing on an unchanged sha).
  const last = readHistory(clone).filter((e) => e.action === 'deploy' || e.action === 'rollback').slice(-1)[0];
  if (last && last.sha === sha && !env.FACTORY_DEPLOY_FORCE) {
    const check = unitActive ?? (platform === 'linux' ? () => unitActiveLinux({}) : () => unitActiveDarwin({}));
    if (check().active) {
      out(`DEPLOYED ${short.stdout.trim()} sha=${sha} clone=${clone} restart skipped — unit already active on this sha since ${last.ts}`);
      return { ok: true, exit: 0, sha, short: short.stdout.trim(), clone, via: 'restart skipped (unit active on this sha)' };
    }
  }

  const r = restart({});
  if (!r.ok) return fail(1, `daemon restart failed: ${r.error}`);
  const ts = new Date().toISOString();
  appendHistory(clone, { ts, sha, short: short.stdout.trim(), action: 'deploy', restart: r.via });
  out(`DEPLOYED ${short.stdout.trim()} sha=${sha} clone=${clone} restart armed via ${r.via}`);
  return { ok: true, exit: 0, sha, short: short.stdout.trim(), clone, via: r.via };
}

/**
 * rollback — checkout the sha deployed BEFORE the current entry + restart
 * (the docker-ssh rollback semantics: history is append-only truth, rollbacks
 * bounce between the last two shas).
 */
export function rollback({ target, restart = restartFor(), platform = process.platform, git = defaultGitRunner, out = (s) => console.log(s) } = {}) {
  if (!target.ok) return { ok: false, exit: 2, error: target.error };
  const { clone } = target;
  const fail = (exit, error) => ({ ok: false, exit, error });
  if (!restart) return fail(2, `no detached daemon restart for platform ${JSON.stringify(platform)} (darwin|linux)`);
  const entries = readHistory(clone).filter((e) => e.action === 'deploy' || e.action === 'rollback');
  if (entries.length < 2) {
    return fail(2, `nothing to roll back to (fewer than 2 deploy-history entries in ${historyPath(clone)})`);
  }
  const targetEntry = entries[entries.length - 2];
  const g = (args, opts) => git({ args: ['-C', clone, ...args], ...opts });
  const dirty = g(['status', '--porcelain']);
  if (dirty.code !== 0) return fail(1, `git status failed (code ${dirty.code}): ${(dirty.stderr || dirty.stdout || '').trim().slice(0, 300)}`);
  if (dirty.stdout.trim() !== '') {
    return fail(2, `runtime clone ${clone} has uncommitted changes — commit/stash first (fail-closed)`);
  }
  // Present? Fetch once, then re-check (the deploy-ssh cat-file pattern).
  let has = g(['cat-file', '-e', `${targetEntry.sha}^{commit}`]);
  if (has.code !== 0) {
    g(['fetch', 'origin'], { timeoutMs: 120000 });
    has = g(['cat-file', '-e', `${targetEntry.sha}^{commit}`]);
  }
  if (has.code !== 0) {
    return fail(2, `rollback target ${targetEntry.short ?? targetEntry.sha} not present in ${clone} — fetch it or pick another sha`);
  }
  const co = g(['checkout', '--detach', '-q', targetEntry.sha]);
  if (co.code !== 0) return fail(1, `checkout --detach ${targetEntry.sha} failed (code ${co.code}): ${(co.stderr || co.stdout || '').trim().slice(0, 300)}`);
  const r = restart({});
  if (!r.ok) return fail(1, `daemon restart failed: ${r.error}`);
  const ts = new Date().toISOString();
  appendHistory(clone, { ts, sha: targetEntry.sha, short: targetEntry.short, action: 'rollback', restart: r.via });
  out(`ROLLED BACK to ${targetEntry.short ?? targetEntry.sha} clone=${clone} restart armed via ${r.via}`);
  return { ok: true, exit: 0, sha: targetEntry.sha, short: targetEntry.short, clone, via: r.via };
}

export function usage() {
  console.error('usage: node scripts/deploy-factory.js deploy [--repo <name>] | rollback [--repo <name>]');
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!['deploy', 'rollback'].includes(cmd)) {
    usage();
    return 2;
  }
  let repoName = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--repo') {
      repoName = rest[++i] ?? '';
    } else {
      console.error(`deploy-factory: unknown argument ${JSON.stringify(rest[i])}`);
      usage();
      return 2;
    }
  }
  const target = deployTarget({ repoName });
  const fn = cmd === 'deploy' ? deploy : rollback;
  const res = fn({ target });
  if (!res.ok) {
    console.error(`deploy-factory ${cmd}: ${res.error}`);
    return res.exit;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
