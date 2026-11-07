/**
 * Unit tests for scripts/deploy.js (card 6ae4c8763f202fc86c57ef65).
 *
 * No live SSH anywhere: the DI runner seam (scripts/lib/deploy-ssh.js makeSSH)
 * is faked in-process. The fake records the FULL {args, cmd, input, timeoutMs}
 * it is handed and returns canned {code, stdout, stderr} keyed by command
 * substring — so assertions run against the exact argv the real runner would
 * pass to `ssh`. defaultRunner/spawnSync is never used (the only CLI-level test
 * exercises the DEPLOY_HOST-missing path, which performs zero remote calls).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

import { build, deploySha, rollback, parseHistory, gitHost } from '../scripts/deploy.js';
import { makeSSH } from '../scripts/lib/deploy-ssh.js';
import { deployConfig, resolveActor } from '../scripts/lib/deploy-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_JS = path.join(ROOT, 'scripts', 'deploy.js');

const FULL_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const SHORT = 'abcdef1';
const IMG = 'ghcr.io/ajohnson-1/discord-bot';
const DIR = '/opt/discord-bot';

const CFG = {
  host: 'deploy.test',
  user: 'factory',
  key: '/home/laptop/.ssh/factory_deploy_ed25519',
  dir: DIR,
  repo: 'git@github.com:Ajohnson-1/discord-bot.git',
  actor: 'tester',
  imageRepo: IMG,
  errors: [],
};

/**
 * Fake runner: entries = [{match, code?, stdout?, stderr?, seq?:[...]}] — first
 * substring match wins; `seq` returns successive results per call (last sticks).
 */
function fake({ entries = [], defaults = {} } = {}) {
  const calls = [];
  const seqs = new Map();
  const runner = ({ args, cmd, input, timeoutMs }) => {
    calls.push({ args, cmd, input, timeoutMs });
    for (const e of entries) {
      if (!cmd.includes(e.match)) continue;
      let r = e;
      if (e.seq) {
        const n = (seqs.get(e.match) || 0) + 1;
        seqs.set(e.match, n);
        r = e.seq[Math.min(n - 1, e.seq.length - 1)];
      }
      return {
        code: 'code' in r ? r.code : defaults.code ?? 0,
        stdout: r.stdout ?? defaults.stdout ?? '',
        stderr: r.stderr ?? defaults.stderr ?? '',
      };
    }
    return { code: defaults.code ?? 0, stdout: defaults.stdout ?? '', stderr: defaults.stderr ?? '' };
  };
  return { ssh: makeSSH(CFG, runner), calls };
}

function captureOut() {
  const lines = [];
  return { out: s => lines.push(String(s)), lines };
}

// Canned happy-path responses for a full build of FULL_SHA/SHORT.
const REV_PARSE = [
  { match: 'rev-parse --short=7', stdout: `${SHORT}\n` },
  { match: 'rev-parse', stdout: `${FULL_SHA}\n` },
];

test('1. build: tag scheme sha-<7> from canned rev-parse + machine lines last', () => {
  const { ssh, calls } = fake({ entries: [...REV_PARSE] });
  const { out, lines } = captureOut();
  const res = build({ ssh, cfg: CFG, out });
  assert.equal(res.ok, true, `error=${res.error}`);
  assert.equal(res.sha, FULL_SHA);
  assert.equal(res.short, SHORT);
  assert.equal(res.image, `${IMG}:sha-${SHORT}`);
  const buildCmd = calls.map(c => c.cmd).find(c => c.includes('docker build'));
  assert.ok(
    buildCmd.includes(`docker build --platform linux/amd64 -t ${IMG}:sha-${SHORT} .`),
    `build cmd: ${buildCmd}`,
  );
  assert.deepEqual(lines.slice(-3), [`SHA=${FULL_SHA}`, `SHORT=${SHORT}`, `IMAGE=${IMG}:sha-${SHORT}`]);
  // structured argv: ssh is called with an argv ARRAY, host@cmd last, key first.
  const first = calls[0];
  assert.deepEqual(first.args, [
    '-i',
    CFG.key,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    'factory@deploy.test',
    first.cmd,
  ]);
  assert.ok(calls.every(c => c.timeoutMs >= 30000), 'per-command timeout caps present');
  assert.ok(calls.some(c => c.timeoutMs === 30000), 'default 30s cap used');
});

test('2. build: command sequence mkdir → keygen → sshconfig → clone → remote → seed → fetch → archive → build', () => {
  const { ssh, calls } = fake({ entries: [...REV_PARSE] });
  const res = build({ ssh, cfg: CFG, out: () => {} });
  assert.equal(res.ok, true, res.error);
  const cmds = calls.map(c => c.cmd);
  const order = [
    'mkdir -p /opt/discord-bot/src',
    'ssh-keygen -t ed25519 -N \'\' -C factory-github-deploy@host -f ~/.ssh/factory_github_deploy_ed25519',
    'grep -q github.com ~/.ssh/config',
    'git init --bare /opt/discord-bot/src/bot.git',
    `remote add origin ${CFG.repo}`,
    // known_hosts seed step: exactly between remote-add and fetch (grep probe;
    // defaults report "entry exists" so no keyscan round-trip here — test 16).
    `grep -q 'github.com' ~/.ssh/known_hosts 2>/dev/null`,
    'git -C /opt/discord-bot/src/bot.git fetch --prune origin',
    `git -C /opt/discord-bot/src/bot.git archive '${FULL_SHA}' | tar -x -C /opt/discord-bot/src/work`,
    'docker build',
  ];
  let prev = -1;
  for (const frag of order) {
    const idx = cmds.findIndex((c, i) => i > prev && c.includes(frag));
    assert.ok(idx > prev, `expected ${JSON.stringify(frag)} after position ${prev}; got:\n${cmds.join('\n')}`);
    prev = idx;
  }
  // idempotent guards + work reset + ref resolution
  assert.ok(cmds.some(c => c.includes('test -d') && c.includes('|| git init --bare')));
  assert.ok(cmds.some(c => c.includes('remote get-url origin') && c.includes('|| git -C')));
  assert.ok(cmds.some(c => c.includes('rm -rf /opt/discord-bot/src/work && mkdir -p')));
  assert.ok(cmds.some(c => c.includes(`rev-parse --verify 'master^{commit}'`)), 'default ref = master');
});

test('3. build: fetch auth failure → exit 2, prints pubkey + ADD DEPLOY KEY hint, no build', () => {
  const { ssh, calls } = fake({
    entries: [
      { match: 'cat ~/.ssh/factory_github_deploy_ed25519.pub', stdout: 'ssh-ed25519 AAAAC3NzFAKE laptop-deploy\n' },
      { match: 'fetch --prune origin', code: 255, stderr: 'git@github.com: Permission denied (publickey).' },
    ],
  });
  const { out, lines } = captureOut();
  const res = build({ ssh, cfg: CFG, out });
  assert.equal(res.ok, false);
  assert.equal(res.exit, 2);
  assert.match(res.error, /fetch auth failure|deploy key/i);
  assert.ok(calls.some(c => c.cmd.includes('cat ~/.ssh/factory_github_deploy_ed25519.pub')));
  assert.ok(lines.some(l => l.includes('ssh-ed25519 AAAAC3NzFAKE')), `pubkey printed: ${lines}`);
  assert.ok(lines.some(l => l.includes('ADD DEPLOY KEY') && l.includes('Deploy keys')), `hint printed: ${lines}`);
  assert.ok(!calls.some(c => c.cmd.includes('docker build')), 'no build attempted after auth failure');
});

test('4. build: bad ref → exit 2, zero ssh calls', () => {
  const { ssh, calls } = fake();
  const res = build({ ssh, cfg: CFG, ref: 'master; rm -rf /' });
  assert.equal(res.ok, false);
  assert.equal(res.exit, 2);
  assert.equal(calls.length, 0);
});

const DEPLOY_OK = [
  { match: 'rev-parse --short=7', stdout: `${SHORT}\n` },
  { match: 'rev-parse', stdout: `${FULL_SHA}\n` },
  {
    match: 'compose --env-file .deploy-env ps -q',
    stdout: 'cid-aaa\ncid-bbb\ncid-ccc\n',
  },
  {
    match: 'docker inspect -f',
    stdout:
      `cid-aaa running sha256:111 ${IMG}:sha-${SHORT} bot\n` +
      `cid-bbb running sha256:111 ${IMG}:sha-${SHORT} speck\n` +
      `cid-ccc running sha256:111 ${IMG}:sha-${SHORT} glorb\n`,
  },
];

test('5. deploy: .deploy-env exactly one BOT_IMAGE line; every compose argv carries --env-file; history entry fields', () => {
  const { ssh, calls } = fake({ entries: DEPLOY_OK });
  const { out, lines } = captureOut();
  const res = deploySha({ ssh, cfg: CFG, sha: FULL_SHA, out });
  assert.equal(res.ok, true, `error=${res.error}`);
  assert.equal(res.image, `${IMG}:sha-${SHORT}`);

  const envCmd = calls.map(c => c.cmd).find(c => c.includes('.deploy-env') && c.startsWith("printf"));
  assert.ok(envCmd, 'printf .deploy-env cmd emitted');
  assert.equal(envCmd, `printf 'BOT_IMAGE=${IMG}:sha-${SHORT}\\n' > ${DIR}/.deploy-env`);
  assert.equal(envCmd.split('BOT_IMAGE=').length - 1, 1, 'exactly one BOT_IMAGE= line');

  const composeCmds = calls.map(c => c.cmd).filter(c => c.includes('docker compose'));
  assert.ok(composeCmds.length >= 2);
  for (const c of composeCmds) assert.ok(c.includes('--env-file .deploy-env'), `missing flag: ${c}`);
  assert.ok(composeCmds.some(c => c.includes('up -d --no-build --remove-orphans')));

  // host compose file + classifier shipped from the deployed sha's tree
  const shipped = calls.map(c => c.cmd);
  assert.ok(shipped.includes(`cp ${DIR}/src/work/docker-compose.yml ${DIR}/docker-compose.yml`));
  assert.ok(shipped.includes(`cp ${DIR}/src/work/scripts/deploy-host-logs.sh ${DIR}/deploy-host-logs.sh`));

  const histCmd = shipped.find(c => c.includes('.deploy-history'));
  const m = histCmd.match(/^printf '%s\\n' '(.+)' >> \/opt\/discord-bot\/\.deploy-history$/);
  assert.ok(m, `history cmd shape: ${histCmd}`);
  const entry = JSON.parse(m[1].replace(/'\\''/g, "'"));
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['action', 'actor', 'image', 'sha', 'short', 'ts'].sort(),
  );
  assert.equal(entry.sha, FULL_SHA);
  assert.equal(entry.short, SHORT);
  assert.equal(entry.image, `${IMG}:sha-${SHORT}`);
  assert.equal(entry.actor, 'tester');
  assert.equal(entry.action, 'deploy');
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);

  assert.deepEqual(lines.filter(l => l.startsWith('CONTAINER ')), [
    `CONTAINER bot cid-aaa ${IMG}:sha-${SHORT}`,
    `CONTAINER speck cid-bbb ${IMG}:sha-${SHORT}`,
    `CONTAINER glorb cid-ccc ${IMG}:sha-${SHORT}`,
  ]);
  assert.ok(lines.includes('DIGEST sha256:111'), `DIGEST line: ${lines}`);
});

test('6. deploy: aborts when sha missing after fetch (exit 2 run build) / image not built (exit 2)', () => {
  {
    // cat-file -e fails; the `|| git fetch` half succeeds; the standalone
    // re-check still fails → exit 2 'run build first'.
    const { ssh } = fake({ entries: [{ match: '|| git', code: 0 }, { match: 'cat-file', code: 1 }] });
    const res = deploySha({ ssh, cfg: CFG, sha: FULL_SHA });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 2);
    assert.match(res.error, /run build .* first/);
  }
  {
    const { ssh, calls } = fake({
      entries: [...DEPLOY_OK, { match: 'docker image inspect', code: 1 }],
    });
    const res = deploySha({ ssh, cfg: CFG, sha: FULL_SHA });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 2);
    assert.match(res.error, /run build .* first/);
    assert.ok(!calls.map(c => c.cmd).some(c => c.includes('compose --env-file .deploy-env up')), 'no compose up after missing image');
  }
});

test('7. deploy: compose up failure → exit 1, history NOT appended', () => {
  const { ssh, calls } = fake({
    entries: [...DEPLOY_OK, { match: 'up -d --no-build', code: 17, stderr: 'error: no such image' }],
  });
  const res = deploySha({ ssh, cfg: CFG, sha: FULL_SHA });
  assert.equal(res.ok, false);
  assert.equal(res.exit, 1);
  assert.match(res.error, /compose up failed/);
  assert.ok(!calls.map(c => c.cmd).some(c => c.includes('.deploy-history')), 'history untouched on failure');
});

const histLine = (o) => JSON.stringify({ ts: '2026-10-30T00:00:00.000Z', ...o });

test('8. rollback: picks SECOND-TO-LAST entry, re-runs deploy with its image, appends action rollback', () => {
  const older = { sha: '1111111111111111111111111111111111111111', short: '1111111', image: `${IMG}:sha-1111111`, actor: 'tester', action: 'deploy' };
  const current = { sha: FULL_SHA, short: SHORT, image: `${IMG}:sha-${SHORT}`, actor: 'tester', action: 'deploy' };
  const entries = [
    { match: 'tail -n 2', stdout: `${histLine(older)}\n${histLine(current)}\n` },
    { match: 'rev-parse --short=7', stdout: '1111111\n' },
    { match: 'rev-parse', stdout: `${older.sha}\n` },
    { match: 'compose --env-file .deploy-env ps -q', stdout: 'cid-x\n' },
    { match: 'docker inspect -f', stdout: `cid-x running sha256:222 ${older.image} bot\n` },
  ];
  const { ssh, calls } = fake({ entries });
  const { out, lines } = captureOut();
  const res = rollback({ ssh, cfg: CFG, out });
  assert.equal(res.ok, true, `error=${res.error}`);
  const cmds = calls.map(c => c.cmd);
  assert.ok(cmds.some(c => c.includes(`cat-file -e '${older.sha}^{commit}'`)), 'target = older entry sha');
  assert.ok(!cmds.some(c => c.includes(`cat-file -e '${FULL_SHA}`)), 'current entry NOT redeployed');
  const envCmd = cmds.find(c => c.startsWith('printf') && c.includes('.deploy-env'));
  assert.equal(envCmd, `printf 'BOT_IMAGE=${older.image}\\n' > ${DIR}/.deploy-env`, 'rollback uses history image');
  const histCmd = cmds.find(c => c.includes('>> /opt/discord-bot/.deploy-history'));
  const entry = JSON.parse(histCmd.match(/printf '%s\\n' '(.+)' >>/)[1]);
  assert.equal(entry.action, 'rollback');
  assert.equal(entry.sha, older.sha);
  assert.ok(lines.includes('DIGEST sha256:222'));
});

test('9. rollback: fewer than 2 entries (incl. truncated tail) → exit 2, no redeploy', () => {
  {
    const { ssh } = fake({ entries: [{ match: 'tail -n 2', code: 1, stderr: 'No such file' }] });
    const res = rollback({ ssh, cfg: CFG });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 2);
    assert.match(res.error, /nothing to roll back to/);
  }
  {
    const { ssh } = fake({
      entries: [{ match: 'tail -n 2', stdout: `${histLine({ sha: FULL_SHA, short: SHORT, image: `${IMG}:sha-${SHORT}`, actor: 't', action: 'deploy' })}\n{"ts":"2026-10-30T00:0` }],
    });
    const res = rollback({ ssh, cfg: CFG });
    assert.equal(res.ok, false);
    assert.equal(res.exit, 2);
    assert.match(res.error, /fewer than 2/);
  }
});

test('10. parseHistory tolerates garbage/truncated lines', () => {
  const entries = parseHistory(
    `${histLine({ sha: FULL_SHA, short: SHORT, image: 'x', actor: 'a', action: 'deploy' })}\nnot json\n{"sha":"trunc\n`,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].sha, FULL_SHA);
});

test('11. actor resolution order: DEPLOY_ACTOR > git user.name > OS username', () => {
  assert.equal(resolveActor({ DEPLOY_ACTOR: 'Env Actor' }, () => 'Git Name'), 'Env Actor');
  assert.equal(resolveActor({}, () => 'Git Name'), 'Git Name');
  const fallback = resolveActor({}, () => {
    throw new Error('no git');
  });
  // falls through to os.userInfo().username — assert a non-empty string.
  assert.equal(typeof fallback, 'string');
  assert.ok(fallback.length > 0);
});

test('12. deployConfig: defaults + explicit-empty DEPLOY_HOST is unset + .env DEPLOY_ACTOR honored', () => {
  const cfg = deployConfig({ DEPLOY_HOST: 'h.example', DEPLOY_ACTOR: 'a' }, {});
  assert.deepEqual(cfg.errors, []);
  assert.equal(cfg.user, 'factory');
  assert.equal(cfg.dir, '/opt/discord-bot');
  assert.equal(cfg.repo, 'git@github.com:Ajohnson-1/discord-bot.git');
  assert.equal(cfg.imageRepo, 'ghcr.io/ajohnson-1/discord-bot');
  assert.ok(!cfg.key.startsWith('~'), `tilde expanded: ${cfg.key}`);
  assert.match(cfg.key, /factory_deploy_ed25519$/);
  const missing = deployConfig({ DEPLOY_HOST: '' });
  assert.equal(missing.errors.length, 1);
  assert.match(missing.errors[0], /DEPLOY_HOST unset/);
  // .env fileEnv carries DEPLOY_ACTOR (documented in .env.example) …
  const fromFile = deployConfig({ DEPLOY_HOST: 'h.example' }, { DEPLOY_ACTOR: 'EnvFile Actor' });
  assert.equal(fromFile.actor, 'EnvFile Actor');
  // … but process env wins over the file.
  const overridden = deployConfig({ DEPLOY_HOST: 'h.example', DEPLOY_ACTOR: 'Proc Actor' }, { DEPLOY_ACTOR: 'EnvFile Actor' });
  assert.equal(overridden.actor, 'Proc Actor');
});

test('14. deploy on fresh host (no bare clone) → exit 2 run-build hint, no cat-file round-trip', () => {
  const { ssh, calls } = fake({ entries: [{ match: 'test -d /opt/discord-bot/src/bot.git', code: 1, stderr: '' }] });
  const res = deploySha({ ssh, cfg: CFG, sha: FULL_SHA });
  assert.equal(res.ok, false);
  assert.equal(res.exit, 2);
  assert.match(res.error, /host clone .* missing — run build .* first/);
  const cmds = calls.map(c => c.cmd);
  assert.ok(cmds.some(c => c === 'test -d /opt/discord-bot/src/bot.git'), 'standalone preflight probe');
  assert.ok(!cmds.some(c => c.includes('cat-file')), 'no cat-file/fetch attempt against a fresh host');
});

test('13. CLI with DEPLOY_HOST empty → exit 2, loud, zero ssh calls (no spawnSync ssh)', () => {
  const r = spawnSync(process.execPath, [DEPLOY_JS, 'deploy', FULL_SHA], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, DEPLOY_HOST: '', DEPLOY_HOST_UNSET_PROBE: '1' },
  });
  assert.equal(r.status, 2, `stderr=${r.stderr}`);
  assert.match(r.stderr, /DEPLOY_HOST unset/);
});

// ---- known_hosts seed step + host-key failure path (card 6ae4f687baf7fc92bd72d4da) --

test('15. build: missing known_hosts entry → keyscan seed cmd issued BEFORE fetch, build continues', () => {
  // grep probe reports "entry absent" (code 1) → JS issues the keyscan
  // round-trip; the seed cmd MUST sit before the fetch cmd in the sequence.
  const { ssh, calls } = fake({ entries: [...REV_PARSE, { match: 'known_hosts', code: 1 }] });
  const res = build({ ssh, cfg: CFG, out: () => {} });
  assert.equal(res.ok, true, `error=${res.error}`);
  const cmds = calls.map(c => c.cmd);
  const seedIdx = cmds.findIndex(c => c.includes('ssh-keyscan -t rsa,ecdsa,ed25519'));
  const fetchIdx = cmds.findIndex(c => c.includes('git -C /opt/discord-bot/src/bot.git fetch --prune origin'));
  assert.ok(seedIdx >= 0, `keyscan seed cmd issued:\n${cmds.join('\n')}`);
  assert.ok(fetchIdx >= 0);
  assert.ok(seedIdx < fetchIdx, `seed cmd ${seedIdx} must precede fetch cmd ${fetchIdx}`);
});

test('16. build: known_hosts entry exists (grep → 0) → zero ssh-keyscan cmd, fetch proceeds', () => {
  // default fake codes: the grep probe exits 0 → keyscan round-trip skipped.
  const { ssh, calls } = fake({ entries: [...REV_PARSE] });
  const res = build({ ssh, cfg: CFG, out: () => {} });
  assert.equal(res.ok, true, res.error);
  const cmds = calls.map(c => c.cmd);
  assert.ok(cmds.includes(`grep -q 'github.com' ~/.ssh/known_hosts 2>/dev/null`), 'grep probe issued');
  assert.ok(!cmds.some(c => c.includes('ssh-keyscan')), `no keyscan round-trip:\n${cmds.join('\n')}`);
  assert.ok(cmds.some(c => c.includes('fetch --prune origin')), 'fetch proceeds');
});

test('17. build: keyscan returns no keys → ERROR line names host, fetch still issued, build proceeds', () => {
  // probe → code 1 (entry absent); the keyscan cmd then reports the
  // KEYSCAN-FAILED sentinel → warning line, NEVER fail(), fetch runs anyway.
  const { ssh, calls } = fake({
    entries: [
      { match: 'ssh-keyscan', stdout: 'KEYSCAN-FAILED\n' }, // must come first: seed cmd matches both
      { match: 'known_hosts', code: 1 },
      ...REV_PARSE,
    ],
  });
  const { out, lines } = captureOut();
  const res = build({ ssh, cfg: CFG, out });
  assert.ok(lines.some(l => l.startsWith('ERROR:') && l.includes('github.com')), `ERROR line naming host: ${lines}`);
  const cmds = calls.map(c => c.cmd);
  assert.ok(cmds.some(c => c.includes('fetch --prune origin')), 'fetch still issued after keyscan trouble');
  assert.equal(res.ok, true, `build proceeds through canned rev-parse: ${res.error}`);
});

test('18. build: fetch "Host key verification failed" → exit 2 + HOST KEY hint, no deploy-key wording, no pubkey dump, no build', () => {
  const { ssh, calls } = fake({
    entries: [{ match: 'fetch --prune origin', code: 255, stderr: 'git@github.com: Host key verification failed.' }],
  });
  const { out, lines } = captureOut();
  const res = build({ ssh, cfg: CFG, out });
  assert.equal(res.ok, false);
  assert.equal(res.exit, 2);
  assert.match(res.error, /host-key failure for github\.com/);
  assert.ok(lines.some(l => l.includes('Host key verification failed')), `raw stderr echoed: ${lines}`);
  assert.ok(lines.some(l => l.includes('HOST KEY') && l.includes('github.com')), `HOST KEY hint naming host: ${lines}`);
  assert.ok(!lines.some(l => l.includes('ADD DEPLOY KEY')), 'no ADD DEPLOY KEY wording');
  assert.ok(!lines.some(l => /deploy key/i.test(l)), 'no deploy-key wording anywhere');
  assert.ok(!calls.some(c => c.cmd.includes('cat ~/.ssh/factory_github_deploy_ed25519.pub')), 'no pubkey dump on this path');
  assert.ok(!calls.map(c => c.cmd).some(c => c.includes('docker build')), 'no build attempted');
});

test('19. gitHost: scp-style → github.com; https/ssh URLs → hostname; empty/garbage → github.com', () => {
  assert.equal(gitHost('git@github.com:owner/repo.git'), 'github.com');
  assert.equal(gitHost('https://gitlab.example.com/o/r.git'), 'gitlab.example.com');
  assert.equal(gitHost('ssh://git@code.example.org:22/o/r.git'), 'code.example.org');
  assert.equal(gitHost(''), 'github.com');
  assert.equal(gitHost('total garbage!!'), 'github.com');
});

// ---- ref resolution: compound rev-parse, origin→tags→raw (card 6ae50196e332d07398d15399) --

test('20. build: compound rev-parse — ONE non-short call, forms ordered origin→tags→raw, build proceeds', () => {
  // Default REV_PARSE fake returns FULL_SHA on the compound cmd → first form
  // wins; the whole build must proceed exactly as before.
  const { ssh, calls } = fake({ entries: [...REV_PARSE] });
  const res = build({ ssh, cfg: CFG, out: () => {} });
  assert.equal(res.ok, true, `error=${res.error}`);
  const cmds = calls.map(c => c.cmd);
  const revParseCmds = cmds.filter(c => c.includes('rev-parse') && !c.includes('rev-parse --short=7'));
  assert.equal(revParseCmds.length, 1, `exactly one non-short rev-parse round-trip:\n${cmds.join('\n')}`);
  const cmd = revParseCmds[0];
  const f1 = cmd.indexOf(`'refs/remotes/origin/master^{commit}'`);
  const f2 = cmd.indexOf(`'refs/tags/master^{commit}'`);
  const f3 = cmd.indexOf(`'master^{commit}'`);
  assert.ok(f1 >= 0 && f2 >= 0 && f3 >= 0, `all three attempted forms present:\n${cmd}`);
  assert.ok(f1 < f2 && f2 < f3, `origin→tags→raw fallback order:\n${cmd}`);
  assert.equal(res.sha, FULL_SHA, 'stdout of the compound = winner full sha');
});

test('21. build: tag deploy ref=v1.2.3 — tags form after origin form in compound; archive uses resolved sha', () => {
  const { ssh, calls } = fake({ entries: [...REV_PARSE] });
  const res = build({ ssh, cfg: CFG, ref: 'v1.2.3', out: () => {} });
  assert.equal(res.ok, true, `error=${res.error}`);
  const compound = calls.map(c => c.cmd).find(c => c.includes('rev-parse') && !c.includes('rev-parse --short=7'));
  assert.ok(compound.includes(`'refs/remotes/origin/v1.2.3^{commit}'`));
  const originIdx = compound.indexOf(`'refs/remotes/origin/v1.2.3^{commit}'`);
  const tagsIdx = compound.indexOf(`'refs/tags/v1.2.3^{commit}'`);
  assert.ok(tagsIdx > originIdx, `tags form must follow origin form:\n${compound}`);
  assert.ok(compound.includes(`'v1.2.3^{commit}'`), 'raw fallback form present');
  const archive = calls.map(c => c.cmd).find(c => c.includes('git archive'));
  assert.ok(archive.includes(`archive '${FULL_SHA}'`), `archive consumes resolved sha: ${archive}`);

  // Echo-back concatenation protection (review bounce #1): plain rev-parse
  // prints args it cannot resolve VERBATIM to stdout on failure — stderr
  // redirection cannot suppress that — so pre-fix a tag deploy got stdout
  // 'refs/remotes/origin/<ref>^{commit}\n<sha>' and SHA_RE saw garbage (false
  // all-miss). The guard is --verify on every form (real git prints nothing to
  // stdout for an invalid arg); assert the compound carries it three times.
  // The fake cannot emulate the echo, so ALSO hand it exactly the concatenated
  // stdout the echo would produce: the SHA_RE gate must reject it — all-miss
  // exit 2, never a garbage sha passed downstream.
  {
    const { ssh, calls } = fake({
      entries: [
        { match: 'show-ref', stdout: '628efcb1234567890abcdef1234567890abcdef12 refs/remotes/origin/master\n' },
        { match: 'rev-parse', stdout: `refs/remotes/origin/v9.9.9^{commit}\n${FULL_SHA}\n` },
      ],
    });
    const res = build({ ssh, cfg: CFG, ref: 'v9.9.9', out: () => {} });
    const compound = calls.map(c => c.cmd).find(c => c.includes('rev-parse') && !c.includes('rev-parse --short=7'));
    assert.equal(
      compound.split('rev-parse --verify ').length - 1,
      3,
      `--verify guard on all three forms:\n${compound}`,
    );
    assert.equal(res.ok, false, 'concatenated stdout must NOT be accepted as a sha');
    assert.equal(res.exit, 2);
    assert.match(res.error, /cannot resolve ref v9\.9\.9/);
    assert.ok(!calls.map(c => c.cmd).some(c => c.includes('git archive')), 'no archive on concatenated-stdout miss');
  }
});

test('22. build: all forms miss → exit 2, ATTEMPTED names three forms, show-ref dumped, zero downstream cmds', () => {
  const dump = '628efcb1234567890abcdef1234567890abcdef12 refs/remotes/origin/master\n';
  const { ssh, calls } = fake({
    entries: [
      { match: 'show-ref', stdout: dump },
      { match: 'rev-parse', code: 128, stderr: 'fatal: ambiguous argument' },
    ],
  });
  const { out, lines } = captureOut();
  const res = build({ ssh, cfg: CFG, out });
  assert.equal(res.ok, false);
  assert.equal(res.exit, 2, 'exit-2 host-error shape, not fail() exit 1');
  assert.match(res.error, /cannot resolve ref master/);
  assert.ok(lines.some(l => l.startsWith('ATTEMPTED:') &&
    l.includes('refs/remotes/origin/master^{commit}') &&
    l.includes('refs/tags/master^{commit}') &&
    l.includes('master^{commit}')), `ATTEMPTED line names all three forms: ${lines}`);
  assert.ok(lines.some(l => l.startsWith('show-ref:') && l.includes(dump.trim())), `show-ref dump round-tripped: ${lines}`);
  const cmds = calls.map(c => c.cmd);
  assert.ok(cmds.some(c => c === 'git -C /opt/discord-bot/src/bot.git show-ref'), 'dump round-trip issued');
  assert.ok(!cmds.some(c => c.includes('git archive')), 'no archive after all-miss');
  assert.ok(!cmds.some(c => c.includes('docker build')), 'no docker build after all-miss');
  assert.ok(!cmds.some(c => c.includes('rev-parse --short=7')), 'no short-sha round-trip after all-miss');
});

test('23. build: archive + machine lines consume the RESOLVED sha, never the bare ref', () => {
  const { ssh, calls } = fake({ entries: [...REV_PARSE] });
  const { out, lines } = captureOut();
  const res = build({ ssh, cfg: CFG, out });
  assert.equal(res.ok, true, res.error);
  const cmds = calls.map(c => c.cmd);
  assert.ok(cmds.some(c => c.includes(`archive '${FULL_SHA}' | tar -x -C /opt/discord-bot/src/work`)));
  assert.ok(!cmds.some(c => c.includes(`archive 'master'`)), 'bare ref never archived');
  assert.ok(!cmds.some(c => c.includes(`rev-parse --short=7 'master'`)), 'short form takes the sha, not the ref');
  assert.deepEqual(lines.slice(-3), [`SHA=${FULL_SHA}`, `SHORT=${SHORT}`, `IMAGE=${IMG}:sha-${SHORT}`]);
});
