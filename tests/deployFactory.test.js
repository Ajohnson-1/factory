/**
 * Unit tests for scripts/deploy-factory.js — the FM-4 `self` deploy driver.
 *
 * No live git and no daemon restart anywhere: the git seam (defaultGitRunner,
 * the deploy-ssh.js runner precedent) and the restart seam are faked
 * in-process. The fake git runner records the FULL {args, cwd, timeoutMs} and
 * returns canned {code, stdout, stderr} keyed by the git subcommand, so
 * assertions run against the exact argv `git` would receive. The detached
 * launchd guard is exercised through an injected spawnImpl.
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  deployTarget,
  deploy,
  rollback,
  parseHistory,
  restartDarwin,
  restartLinux,
  restartFor,
  readHistory,
  UNIT,
  HISTORY_REL,
  RESTART_DELAY_MS,
} from '../scripts/deploy-factory.js';

const FULL = 'abcdef1234567890abcdef1234567890abcdef12';
const FULL2 = '9999999999999999999999999999999999999999';
const SHORT = 'abcdef1';

// --- fixtures -----------------------------------------------------------------

const REG = {
  defaultRepo: 'factory',
  repos: {
    factory: {
      name: 'factory',
      repoDir: '/home/me/GitHub/factory',
      worktreeRoot: '/home/me/GitHub/factory-factory-wt',
      baseBranch: 'master',
      board: 'LLNG5MAm',
      deploy: { driver: 'self' },
      worktreeBootstrap: [],
    },
    'discord-bot': {
      name: 'discord-bot',
      repoDir: '/home/me/GitHub/discord-bot',
      worktreeRoot: '/home/me/GitHub/discord-bot-factory-wt',
      baseBranch: 'master',
      board: 'ZHkVYBN1',
      deploy: { driver: 'docker-ssh' },
      worktreeBootstrap: [],
    },
  },
};

function tmpClone() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-factory-'));
  mkdirSync(join(dir, '.git'));
  return dir;
}

/** Fake git runner keyed by the subcommand argv after `-C <clone>`. */
function fakeGit(canned = {}) {
  const calls = [];
  const run = (spec) => {
    calls.push(spec);
    const key = spec.args.slice(2).join(' ');
    return canned[key] ?? { code: 0, stdout: '', stderr: '' };
  };
  run.calls = calls;
  run.keys = () => calls.map((c) => c.args.slice(2).join(' '));
  return run;
}

const OK_HEAD = { 'rev-parse HEAD': { code: 0, stdout: `${FULL}\n` }, 'rev-parse --short=7 abcdef1234567890abcdef1234567890abcdef12': { code: 0, stdout: `${SHORT}\n` } };
const okRestart = () => ({ calls: [], fn: (_opts) => { okRestart.last = _opts; return { ok: true, via: 'fake' }; } });

// --- deployTarget ----------------------------------------------------------------

test('deployTarget: registry self repo resolves clone=repoDir, branch=baseBranch', () => {
  const t = deployTarget({ repoName: 'factory', registry: REG });
  assert.equal(t.ok, true);
  assert.equal(t.clone, '/home/me/GitHub/factory');
  assert.equal(t.branch, 'master');
});

test('deployTarget: docker-ssh repos are rejected — wrong driver is a config error', () => {
  const t = deployTarget({ repoName: 'discord-bot', registry: REG });
  assert.equal(t.ok, false);
  assert.match(t.error, /driver is "docker-ssh"/);
  assert.match(t.error, /scripts\/deploy\.js/);
});

test('deployTarget: unknown repo names the candidate', () => {
  const t = deployTarget({ repoName: 'nope', registry: REG });
  assert.equal(t.ok, false);
  assert.match(t.error, /unknown repo "nope"/);
});

test('deployTarget: FACTORY_DEPLOY_CLONE overrides the clone path', () => {
  const t = deployTarget({ repoName: 'factory', registry: REG, env: { FACTORY_DEPLOY_CLONE: '/srv/factory' } });
  assert.equal(t.clone, '/srv/factory');
});

// --- deploy ------------------------------------------------------------------------

test('deploy: ff-pulls the clone then arms restart and appends history', () => {
  const clone = tmpClone();
  try {
    const git = fakeGit(OK_HEAD);
    const lines = [];
    const res = deploy({
      target: { ok: true, repo: REG.repos.factory, clone, branch: 'master' },
      restart: () => ({ ok: true, via: 'launchd-guard pid 4242' }),
      git,
      out: (s) => lines.push(s),
    });
    assert.equal(res.ok, true);
    assert.equal(res.sha, FULL);
    assert.equal(res.short, SHORT);
    // exact argv sequence, in order
    assert.deepEqual(git.keys(), [
      'status --porcelain',
      'fetch origin',
      'symbolic-ref -q HEAD',
      'merge --ff-only origin/master',
      'rev-parse HEAD',
      `rev-parse --short=7 ${FULL}`,
    ]);
    assert.equal(git.calls[1].timeoutMs, 120000);
    const hist = readFileSync(join(clone, HISTORY_REL), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(
      { sha: hist[0].sha, short: hist[0].short, action: hist[0].action, restart: hist[0].restart },
      { sha: FULL, short: SHORT, action: 'deploy', restart: 'launchd-guard pid 4242' },
    );
    assert.match(hist[0].ts, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assert.match(lines.join('\n'), new RegExp(`DEPLOYED ${SHORT} sha=${FULL}`));
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test('deploy: detached HEAD (post-rollback) checks the branch out before ff-ing', () => {
  const clone = tmpClone();
  try {
    const git = fakeGit({ 'symbolic-ref -q HEAD': { code: 1, stdout: '', stderr: '' }, ...OK_HEAD });
    const res = deploy({
      target: { ok: true, repo: REG.repos.factory, clone, branch: 'master' },
      restart: () => ({ ok: true, via: 'x' }),
      git,
      out: () => {},
    });
    assert.equal(res.ok, true);
    assert.equal(git.keys()[3], 'checkout -q master');
    assert.equal(git.keys()[4], 'merge --ff-only origin/master');
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test('deploy: dirty clone is a fail-closed exit 2 before any fetch', () => {
  const clone = tmpClone();
  try {
    const git = fakeGit({ 'status --porcelain': { code: 0, stdout: ' M scripts/x.js\n' } });
    const res = deploy({
      target: { ok: true, repo: REG.repos.factory, clone, branch: 'master' },
      restart: () => ({ ok: true, via: 'x' }),
      git,
      out: () => {},
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 2);
    assert.match(res.error, /uncommitted changes/);
    assert.deepEqual(git.keys(), ['status --porcelain']);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test('deploy: non-ff merge exits 1 (divergence) — no restart, no history entry', () => {
  const clone = tmpClone();
  try {
    const git = fakeGit({ 'merge --ff-only origin/master': { code: 1, stdout: '', stderr: "fatal: Not possible to fast-forward, aborting." } });
    let restarted = 0;
    const res = deploy({
      target: { ok: true, repo: REG.repos.factory, clone, branch: 'master' },
      restart: () => { restarted++; return { ok: true, via: 'x' }; },
      git,
      out: () => {},
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
    assert.match(res.error, /diverged from origin\/master/);
    assert.equal(restarted, 0);
    assert.equal(existsSync(join(clone, HISTORY_REL)), false);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test('deploy: failed restart exits 1 and writes no history (a re-deploy is idempotent)', () => {
  const clone = tmpClone();
  try {
    const git = fakeGit(OK_HEAD);
    const res = deploy({
      target: { ok: true, repo: REG.repos.factory, clone, branch: 'master' },
      restart: () => ({ ok: false, error: 'systemd-run failed (code 1): Failed to start unit' }),
      git,
      out: () => {},
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 1);
    assert.match(res.error, /daemon restart failed/);
    assert.equal(existsSync(join(clone, HISTORY_REL)), false);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test('deploy: missing runtime clone is a loud exit 2 (no silent clone creation)', () => {
  const res = deploy({
    target: { ok: true, repo: REG.repos.factory, clone: '/nonexistent/clone', branch: 'master' },
    restart: () => ({ ok: true, via: 'x' }),
    git: fakeGit(),
    out: () => {},
  });
  assert.equal(res.exit, 2);
  assert.match(res.error, /not a git checkout/);
});

test('deploy: unsupported platform never arms a restart', () => {
  const clone = tmpClone();
  try {
    const res = deploy({
      target: { ok: true, repo: REG.repos.factory, clone, branch: 'master' },
      restart: restartFor('win32'),
      platform: 'win32',
      git: fakeGit(OK_HEAD),
      out: () => {},
    });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 2);
    assert.match(res.error, /platform "win32"/);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

// --- rollback ------------------------------------------------------------------------

function seededHistory(clone, entries) {
  mkdirSync(join(clone, 'data'), { recursive: true });
  appendFileSync(join(clone, HISTORY_REL), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('rollback: checks out the second-to-last sha detached + restarts + appends history', () => {
  const clone = tmpClone();
  try {
    seededHistory(clone, [
      { ts: '2026-11-07T00:00:00.000Z', sha: FULL2, short: '9999999', action: 'deploy', restart: 'fake' },
      { ts: '2026-11-08T00:00:00.000Z', sha: FULL, short: SHORT, action: 'deploy', restart: 'fake' },
    ]);
    const git = fakeGit(); // cat-file -e succeeds by default
    const res = rollback({
      target: { ok: true, repo: REG.repos.factory, clone, branch: 'master' },
      restart: () => ({ ok: true, via: 'fake' }),
      git,
      out: () => {},
    });
    assert.equal(res.ok, true);
    assert.equal(res.sha, FULL2);
    assert.equal(git.keys()[1], `cat-file -e ${FULL2}^{commit}`);
    assert.equal(git.keys()[2], `checkout --detach -q ${FULL2}`);
    const hist = readHistory(clone);
    assert.deepEqual(
      { sha: hist.at(-1).sha, action: hist.at(-1).action },
      { sha: FULL2, action: 'rollback' },
    );
    // deterministic two-sha bounce: rolling back again targets the newer sha
    const res2 = rollback({
      target: { ok: true, repo: REG.repos.factory, clone, branch: 'master' },
      restart: () => ({ ok: true, via: 'fake' }),
      git: fakeGit(),
      out: () => {},
    });
    assert.equal(res2.sha, FULL);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test('rollback: fewer than 2 entries is exit 2 (nothing to roll back to)', () => {
  const clone = tmpClone();
  try {
    seededHistory(clone, [{ ts: 'x', sha: FULL, short: SHORT, action: 'deploy' }]);
    const res = rollback({
      target: { ok: true, repo: REG.repos.factory, clone, branch: 'master' },
      restart: () => ({ ok: true, via: 'x' }),
      git: fakeGit(),
      out: () => {},
    });
    assert.equal(res.exit, 2);
    assert.match(res.error, /nothing to roll back to/);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test('rollback: missing target sha fetches once, still missing is exit 2', () => {
  const clone = tmpClone();
  try {
    seededHistory(clone, [
      { ts: '2026-11-07T00:00:00.000Z', sha: FULL2, short: '9999999', action: 'deploy' },
      { ts: '2026-11-08T00:00:00.000Z', sha: FULL, short: SHORT, action: 'deploy' },
    ]);
    const git = fakeGit({ [`cat-file -e ${FULL2}^{commit}`]: { code: 1, stdout: '', stderr: 'missing' } });
    const res = rollback({
      target: { ok: true, repo: REG.repos.factory, clone, branch: 'master' },
      restart: () => ({ ok: true, via: 'x' }),
      git,
      out: () => {},
    });
    assert.equal(res.exit, 2);
    assert.match(res.error, /not present in/);
    const keys = git.keys();
    assert.equal(keys.filter((k) => k.startsWith('cat-file')).length, 2); // checked, fetched, re-checked
    assert.ok(keys.includes('fetch origin'));
    assert.ok(!keys.some((k) => k.startsWith('checkout')));
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test('rollback: dirty clone fail-closes before touching anything', () => {
  const clone = tmpClone();
  try {
    seededHistory(clone, [
      { ts: '2026-11-07T00:00:00.000Z', sha: FULL2, short: '9999999', action: 'deploy' },
      { ts: '2026-11-08T00:00:00.000Z', sha: FULL, short: SHORT, action: 'deploy' },
    ]);
    const git = fakeGit({ 'status --porcelain': { code: 0, stdout: ' M local\n' } });
    const res = rollback({
      target: { ok: true, repo: REG.repos.factory, clone, branch: 'master' },
      restart: () => ({ ok: true, via: 'x' }),
      git,
      out: () => {},
    });
    assert.equal(res.exit, 2);
    assert.deepEqual(git.keys(), ['status --porcelain']);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test('parseHistory skips garbage lines (append-only truth)', () => {
  const text = `not json\n{"sha":"abc","action":"deploy"}\n{trunc\n{"sha":"def","action":"rollback"}\n`;
  assert.deepEqual(parseHistory(text).map((e) => e.sha), ['abc', 'def']);
});

// --- restart seams ----------------------------------------------------------------------

test('restartLinux passes the exact systemd-run argv (D7 user unit)', () => {
  const seen = [];
  const r = restartLinux({ run: (spec) => { seen.push(spec); return { code: 0, stdout: 'Running as unit: run-r1.scope', stderr: '' }; } });
  assert.deepEqual(seen[0].args, ['--user', '--on-active=2s', 'systemctl', '--user', 'restart', 'factory-daemon.service']);
  assert.equal(r.ok, true);
  assert.match(r.via, /systemd-run factory-daemon\.service in 2s/);
});

test('restartLinux surfaces a systemd-run failure', () => {
  const r = restartLinux({ run: () => ({ code: 1, stdout: '', stderr: 'Failed to delay job: Unit factory-daemon.service not loaded.' }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /not loaded/);
});

test('restartDarwin arms a detached guard (survives the SIGTERM cascade) and returns immediately', () => {
  const seen = [];
  const fakeChild = { pid: 4242, unref: () => { fakeChild.unrefCalled = true; } };
  const r = restartDarwin({
    label: 'com.test.daemon',
    plist: '/tmp/test.plist',
    delayMs: 1234,
    uid: 501,
    nodePath: '/bin/node',
    libUrl: 'file:///lib/factory-launchd.js',
    spawnImpl: (cmd, argv, opts) => { seen.push({ cmd, argv, opts }); return fakeChild; },
  });
  assert.equal(r.ok, true);
  assert.match(r.via, /launchd-guard pid 4242/);
  assert.equal(fakeChild.unrefCalled, true);
  assert.equal(seen[0].cmd, '/bin/node');
  assert.deepEqual(seen[0].opts, { detached: true, stdio: 'ignore' });
  const script = seen[0].argv[2];
  assert.match(script, /setTimeout\(r, 1234\)/);
  assert.match(script, /bootout.*gui\/501\/com\.test\.daemon/);
  assert.match(script, /ensureBootstrapped/);
  assert.match(script, /"plist":"\/tmp\/test\.plist"|plist: "\/tmp\/test\.plist"/);
  assert.match(script, /import\(.*factory-launchd/);
});

test('restartFor: darwin/linux branch, null elsewhere', () => {
  assert.equal(typeof restartFor('darwin'), 'function');
  assert.equal(typeof restartFor('linux'), 'function');
  assert.equal(restartFor('freebsd'), null);
});
