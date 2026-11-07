/**
 * Unit tests for scripts/verify-deploy.js (card 6ae4c8763f202fc86c57ef65).
 *
 * Same in-process fake-runner seam as tests/deploy.test.js — no live SSH, no
 * live docker. The 60s sample gap is driven through the injected `sleep` stub
 * (asserting the production default is 60000 without waiting on it). The CLI
 * test exercises only the DEPLOY_HOST-missing path: stdout must be pure JSON
 * (the scheduler pipes it straight into `factory.js comment -`).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

import { verifyDeploy, PROBE_SRC, embedEndpoint } from '../scripts/verify-deploy.js';
import { makeSSH } from '../scripts/lib/deploy-ssh.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY_JS = path.join(ROOT, 'scripts', 'verify-deploy.js');

const DIR = '/opt/discord-bot';
const IMG = 'ghcr.io/ajohnson-1/discord-bot';
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

const SERVICES = ['bot', 'speck', 'glorb'];

const HOST_CFG = {
  sushiHost: 'http://192.168.0.145:12345/v1',
  vmlxHost: 'http://192.168.0.145:8080/v1',
  memoryEmbeddingModel: 'mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ',
  memoryEmbeddingDimension: 1024,
  aiMemoryEnabled: true,
};

const BOT_LOGS_OK = [
  'AI: memory ready — 12 fact(s) across 3 user(s), 0 awaiting embedding, model=mlx dim=1024',
  'Ready! Bot version: 2026-10-30T00:00:00Z',
  'Build time: 2026-10-30T00:00:00Z',
].join('\n');
const READY_LINE = (svc) => `Ready! [${svc}${svc === 'speck' ? ' chat-only' : ''}] Bot version: v`;

const STARTED_AT = '2026-10-31T17:10:00Z'; // container start anchor for boot-line scans
const ZERO_STARTED_AT = '0001-01-01T00:00:00Z'; // Go zero value = never started

/**
 * v28-shape `docker inspect --format '{{json .}}'` doc: top-level RestartCount,
 * State WITHOUT RestartCount (v28 removed it). `state` overrides State fields
 * (incl. StartedAt — present by default, `undefined` removes it), `rc` sets the
 * top-level RestartCount (undefined → key omitted).
 */
function inspectDoc(id, { rc = 0, state = {} } = {}) {
  const doc = {
    Id: id,
    State: { Status: 'running', Running: true, Restarting: false, Dead: false, ExitCode: 0, OOMKilled: false, StartedAt: STARTED_AT, ...state },
  };
  if (rc !== undefined) doc.RestartCount = rc;
  return JSON.stringify(doc);
}

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

/** Canned everything-PASS matrix, overridable via extra entries (first match wins → extras go first). */
function passEntries(extra = [], opts = {}) {
  const hostCfgJson = JSON.stringify(opts.hostCfg ?? HOST_CFG);
  const botLogs = opts.botLogs ?? BOT_LOGS_OK;
  const probeOut = opts.probeOut ?? 'MODELS=2\nEMBED_DIM=1024\n';
  const probeCode = opts.probeCode ?? 0;
  const classifier = opts.classifier ?? { code: 0, stdout: 'VERDICT=clean count=0\n' };
  return [
    ...extra,
    { match: 'config --services', stdout: `${SERVICES.join('\n')}\n` },
    { match: 'ps -q bot', stdout: 'cid-bot\n' },
    { match: 'ps -q speck', stdout: 'cid-speck\n' },
    { match: 'ps -q glorb', stdout: 'cid-glorb\n' },
    { match: 'cid-bot', stdout: inspectDoc('cid-bot') },
    { match: 'cid-speck', stdout: inspectDoc('cid-speck') },
    { match: 'cid-glorb', stdout: inspectDoc('cid-glorb') },
    { match: 'exec -T bot node -', code: probeCode, stdout: probeOut },
    { match: 'exec -T bot cat', stdout: hostCfgJson },
    { match: 'logs bot --since', stdout: botLogs },
    { match: 'logs speck --since', stdout: `${READY_LINE('speck')}\n` },
    { match: 'logs glorb --since', stdout: `${READY_LINE('glorb')}\n` },
    { match: 'deploy-host-logs.sh bot', ...classifier },
    { match: 'deploy-host-logs.sh speck', ...classifier },
    { match: 'deploy-host-logs.sh glorb', ...classifier },
  ];
}

async function runVerify(entries, { hostCfg, botLogs, probeOut, probeCode, classifier, opts } = {}) {
  const { ssh, calls } = fake({ entries: passEntries(entries, { hostCfg, botLogs, probeOut, probeCode, classifier, opts }) });
  const gaps = [];
  const res = await verifyDeploy({ ssh, cfg: CFG, sleep: async ms => gaps.push(ms) });
  return { ...res, calls, gaps };
}

const checkNamed = (json, name) => json.checks.find(c => c.name === name);

test('1. all-pass matrix → verdict PASS, exit 0, six named checks in order, default 60s gap', async () => {
  const { json, exit, gaps } = await runVerify();
  assert.equal(exit, 0);
  assert.equal(json.verdict, 'PASS');
  assert.deepEqual(json.checks.map(c => c.name), [
    'health-running-s1',
    'health-running-s2',
    'memory-boot-consistency',
    'ai-hosts-probe',
    'gateway-ready',
    'logs-classifier',
  ]);
  assert.ok(json.checks.every(c => c.status === 'pass'), JSON.stringify(json.checks, null, 2));
  assert.deepEqual(json.services, SERVICES);
  assert.equal(json.host, 'factory@deploy.test');
  assert.equal(json.dir, DIR);
  assert.match(json.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof json.durationMs, 'number');
  assert.deepEqual(gaps, [60000], 'sample gap = default 60_000ms, local (one sleep between s1 and s2)');
  assert.equal(checkNamed(json, 'health-running-s1').detail, 'bot=running/0 speck=running/0 glorb=running/0');
  assert.equal(checkNamed(json, 'memory-boot-consistency').detail, 'intent=enabled observed=ready dim=1024');
  assert.equal(checkNamed(json, 'ai-hosts-probe').detail, 'MODELS=2 EMBED_DIM=1024 (expected 1024)');
  assert.equal(checkNamed(json, 'gateway-ready').detail, 'bot ✓ speck ✓ glorb ✓');
  assert.match(checkNamed(json, 'logs-classifier').detail, /bot: VERDICT=clean count=0 \(exit 0\)/);
});

test('2. JSON shape: every check carries name/status/detail strings', async () => {
  const { json } = await runVerify();
  for (const c of json.checks) {
    assert.equal(typeof c.name, 'string');
    assert.ok(['pass', 'fail', 'error'].includes(c.status), c.status);
    assert.equal(typeof c.detail, 'string');
  }
  assert.ok(['PASS', 'FAIL'].includes(json.verdict));
});

test('3. restart between samples → health-running-s2 FAIL (s1 passed), verdict FAIL exit 1', async () => {
  // bot's inspect answers RestartCount 0 in the first round, 3 in the second
  // (top-level v28 field; seq matches only `cid-bot`; speck/glorb stay canned running/0).
  const { json, exit } = await runVerify([
    { match: 'cid-bot', seq: [{ stdout: inspectDoc('cid-bot', { rc: 0 }) }, { stdout: inspectDoc('cid-bot', { rc: 3 }) }] },
  ]);
  assert.equal(checkNamed(json, 'health-running-s1').status, 'pass');
  const s2 = checkNamed(json, 'health-running-s2');
  assert.equal(s2.status, 'fail');
  assert.match(s2.detail, /running\/3/);
  assert.equal(json.verdict, 'FAIL');
  assert.equal(exit, 1);
});

test('4. acceptance FAIL path: aiMemoryEnabled string "true" → memory-boot-consistency FAIL names cause', async () => {
  const { json, exit } = await runVerify([], {
    hostCfg: { ...HOST_CFG, aiMemoryEnabled: 'true' },
    botLogs: 'AI: memory disabled (aiMemoryEnabled=false) — no database opened.\nReady! Bot version: v',
  });
  const c = checkNamed(json, 'memory-boot-consistency');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /aiMemoryEnabled/);
  assert.match(c.detail, /"true"/); // JSON.stringify(raw) in the detail
  assert.match(c.detail, /not a JSON boolean/);
  assert.match(c.detail, /config\.js:457/);
  assert.equal(json.verdict, 'FAIL');
  assert.equal(exit, 1);
});

test('5. ready line with dim=2560 → memory-boot-consistency FAIL names dim mismatch', async () => {
  const { json } = await runVerify([], {
    botLogs: 'AI: memory ready — 1 fact(s) across 1 user(s), 0 awaiting embedding, model=m dim=2560\nReady! v',
  });
  const c = checkNamed(json, 'memory-boot-consistency');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /dim=2560/);
  assert.match(c.detail, /mismatch/);
  assert.match(c.detail, /expected=1024/);
});

test('6. config false + disabled line → PASS; config false + ready line → FAIL inconsistency', async () => {
  const { json } = await runVerify([], {
    hostCfg: { ...HOST_CFG, aiMemoryEnabled: false },
    botLogs: 'AI: memory disabled (aiMemoryEnabled=false) — no database opened.\nReady! v',
  });
  assert.equal(checkNamed(json, 'memory-boot-consistency').status, 'pass');
  assert.equal(json.verdict, 'PASS', JSON.stringify(json.checks));

  const bad = await runVerify([], {
    hostCfg: { ...HOST_CFG, aiMemoryEnabled: false },
    botLogs: BOT_LOGS_OK,
  });
  const c = checkNamed(bad.json, 'memory-boot-consistency');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /intent=disabled/);
  assert.match(c.detail, /inconsistency/i);
});

test('7. no memory boot line in logs → FAIL', async () => {
  const { json } = await runVerify([], { botLogs: 'Ready! Bot version: v\nBuild time: now' });
  const c = checkNamed(json, 'memory-boot-consistency');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /no memory boot line in last 2m logs/);
});

test('8. probe EMBED_DIM=2560 → FAIL names sushi misroute; probe exit 1 → FAIL', async () => {
  const { json } = await runVerify([], { probeOut: 'MODELS=3\nEMBED_DIM=2560\n' });
  const c = checkNamed(json, 'ai-hosts-probe');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /sushi misroute: embed host returned 2560-dim chat vectors/);

  const dead = await runVerify([], { probeCode: 1, probeOut: '', classifier: undefined });
  const d = checkNamed(dead.json, 'ai-hosts-probe');
  assert.equal(d.status, 'fail');
  assert.match(d.detail, /probe exit 1/);
});

test('9. probe ships on ssh stdin to `exec -T bot node -`; classifier invoked with bash', async () => {
  const { calls } = await runVerify();
  const probe = calls.find(c => c.cmd.includes('exec -T bot node -'));
  assert.equal(probe.cmd, `cd ${DIR} && docker compose --env-file .deploy-env exec -T bot node -`);
  assert.ok(probe.input.includes('/app/config/config.json'), 'probe reads config inside container');
  assert.ok(probe.input.includes('/v1/models'));
  assert.ok(probe.input.includes('factory-verify-probe'));
  assert.equal((probe.input.match(/AbortSignal\.timeout\(30000\)/g) || []).length, 2, '30s per-fetch cap on BOTH fetches');
  assert.ok(!probe.input.includes('10000'), 'old 10s budget is gone');
  assert.ok(/port = '12345'/.test(probe.input), 'models port forced');
  // hostUrl() parity fallback: vmlxHost verbatim + /embeddings (no port guessing)
  assert.ok(probe.input.includes(`const EMBED_TARGET = ${JSON.stringify('http://192.168.0.145:8080/v1/embeddings')};`), probe.input.slice(0, 120));
  assert.equal(probe.timeoutMs, 60000, 'probe gets the 60s ssh cap');
  const cl = calls.filter(c => c.cmd.includes('deploy-host-logs.sh'));
  assert.deepEqual(cl.map(c => c.cmd), SERVICES.map(s => `cd ${DIR} && bash deploy-host-logs.sh ${s} --since 2m`), 'bash = the script shebang interpreter (bashisms), not sh -s');
  // every docker compose invocation carries the env-file interpolation source
  for (const c of calls.filter(c => c.cmd.includes('docker compose'))) {
    assert.ok(c.cmd.includes('--env-file .deploy-env'), `missing --env-file: ${c.cmd}`);
  }
  // env-parity reads go through the same DI runner; unset var = printenv exit 1 = normal
  for (const name of ['AI_MEMORY_ENABLED', 'MEMORY_EMBEDDING_DIMENSION']) {
    const pc = calls.find(c => c.cmd.includes(`printenv ${name}`));
    assert.ok(pc, `printenv ${name} probe issued via fake runner`);
    assert.ok(pc.cmd.includes('--env-file .deploy-env') && pc.cmd.includes('exec -T bot'), pc.cmd);
  }
});

test('10. classifier exit 2 = PASS (degraded detail); exit 1 / exit 4 = FAIL', async () => {
  const degraded = await runVerify([], { classifier: { code: 2, stdout: 'VERDICT=memory-degraded count=2\n' } });
  const c = checkNamed(degraded.json, 'logs-classifier');
  assert.equal(c.status, 'pass');
  assert.match(c.detail, /bot: VERDICT=memory-degraded count=2 \(exit 2\)/);
  assert.equal(degraded.json.verdict, 'PASS');

  const crash = await runVerify([], { classifier: { code: 1, stdout: 'VERDICT=crash count=1\n' } });
  const cc = checkNamed(crash.json, 'logs-classifier');
  assert.equal(cc.status, 'fail');
  assert.match(cc.detail, /exit 1/);
  assert.match(cc.detail, /crash/);

  const broken = await runVerify([], { classifier: { code: 4, stdout: '' } });
  assert.equal(checkNamed(broken.json, 'logs-classifier').status, 'fail');
});

test('11. classifier unparseable stdout → FAIL', async () => {
  const { json } = await runVerify([], { classifier: { code: 0, stdout: 'bash: command not found\n' } });
  assert.equal(checkNamed(json, 'logs-classifier').status, 'fail');
});

test('12. gateway Ready! missing on speck → gateway-ready FAIL names it', async () => {
  const { json } = await runVerify([{ match: 'logs speck --since', stdout: 'starting up...\n' }]);
  const c = checkNamed(json, 'gateway-ready');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /speck ✗/);
  assert.match(c.detail, /bot ✓/);
});

test('13. ssh transport error → status error, verdict FAIL exit 1', async () => {
  const { json, exit } = await runVerify([
    { match: 'ps -q', code: null, stderr: 'ssh: connect to host timed out' },
  ]);
  const c = checkNamed(json, 'health-running-s1');
  assert.equal(c.status, 'error');
  assert.match(c.detail, /ssh error/);
  assert.equal(json.verdict, 'FAIL');
  assert.equal(exit, 1);
});

test('14. services discovered from compose config --services; 1-service host passes', async () => {
  const entries = [
    { match: 'config --services', stdout: 'bot\n' },
    { match: 'ps -q bot', stdout: 'cid-bot\n' },
    { match: 'cid-bot', stdout: inspectDoc('cid-bot') },
    { match: 'exec -T bot node -', stdout: 'MODELS=1\nEMBED_DIM=1024\n' },
    { match: 'exec -T bot cat', stdout: JSON.stringify(HOST_CFG) },
    { match: 'logs bot --since', stdout: BOT_LOGS_OK },
    { match: 'deploy-host-logs.sh bot', stdout: 'VERDICT=clean count=0\n' },
  ];
  const { ssh, calls } = fake({ entries });
  const res = await verifyDeploy({ ssh, cfg: CFG, sleep: async () => {} });
  assert.equal(res.exit, 0, JSON.stringify(res.json.checks, null, 2));
  assert.deepEqual(res.json.services, ['bot']);
  assert.ok(!calls.some(c => c.cmd.includes('speck')), 'no speck/glorb calls on a 1-service host');
});

test('15. discovery failure → services-discovery error check, FAIL exit 1, no further probes', async () => {
  const { ssh, calls } = fake({ entries: [{ match: 'config --services', code: 15, stderr: 'yaml error' }] });
  const res = await verifyDeploy({ ssh, cfg: CFG, sleep: async () => {} });
  const c = checkNamed(res.json, 'services-discovery');
  assert.equal(c.status, 'error');
  assert.equal(res.json.verdict, 'FAIL');
  assert.equal(res.exit, 1);
  assert.equal(res.json.services.length, 0);
  assert.ok(!calls.some(x => x.cmd.includes('ps -q')), 'checks skipped when discovery fails');
});

test('16. CLI with DEPLOY_HOST empty → exit 2, stdout is pure JSON with top-level error', () => {
  const r = spawnSync(process.execPath, [VERIFY_JS], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, DEPLOY_HOST: '' },
  });
  assert.equal(r.status, 2, `stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout); // stdout must stay machine-parseable
  assert.equal(parsed.verdict, 'FAIL');
  assert.match(parsed.error, /DEPLOY_HOST unset/);
  assert.ok(Array.isArray(parsed.checks));
  assert.deepEqual(parsed.services, []);
});

test('17. PROBE_SRC shape (exported): models+embeddings+exit codes', () => {
  assert.ok(PROBE_SRC.includes("require('fs')"), 'stdin script is CJS — node - reads stdin as CJS');
  assert.ok(PROBE_SRC.includes('process.exit(1)'));
  assert.ok(PROBE_SRC.includes('MODELS='));
  assert.ok(PROBE_SRC.includes('EMBED_DIM='));
  assert.ok(PROBE_SRC.includes('memoryEmbeddingModel'));
  assert.ok(PROBE_SRC.includes('EMBED_TARGET'), 'embed endpoint is injected, not guessed');
  // card 6aeab42bc4759702f8df2835 — infra classification lives in the probe:
  assert.ok(PROBE_SRC.includes('RETRYABLE=1 HTTP='), 'machine retry marker on stdout');
  assert.ok(PROBE_SRC.includes('process.exit(75)'), 'EX_TEMPFAIL exit for retryable runs');
  assert.ok(PROBE_SRC.includes('429') && PROBE_SRC.includes('503') && PROBE_SRC.includes('504'), 'retryable status set');
  assert.ok(PROBE_SRC.includes('retry_after'), 'gateway retry_after pulled out of the body');
  assert.ok(PROBE_SRC.includes('ECONNREFUSED') && PROBE_SRC.includes('EHOSTDOWN'), 'connect-level failures classified');
});

test('18. env AI_MEMORY_ENABLED=true overrides JSON false → intent enabled, ready dim=1024 → PASS', async () => {
  const { json } = await runVerify([{ match: 'printenv AI_MEMORY_ENABLED', stdout: 'true\n' }], {
    hostCfg: { ...HOST_CFG, aiMemoryEnabled: false },
  });
  const c = checkNamed(json, 'memory-boot-consistency');
  assert.equal(c.status, 'pass', c.detail);
  assert.equal(c.detail, 'intent=enabled (env AI_MEMORY_ENABLED=true) observed=ready dim=1024');
  assert.equal(json.verdict, 'PASS', JSON.stringify(json.checks));
});

test('19. env MEMORY_EMBEDDING_DIMENSION overrides file value for boot line AND probe expectation', async () => {
  const entries = [{ match: 'printenv MEMORY_EMBEDDING_DIMENSION', stdout: '2048\n' }];
  const ok = await runVerify(entries, {
    botLogs: 'AI: memory ready — 1 fact(s), model=m dim=2048\nReady! v',
    probeOut: 'MODELS=1\nEMBED_DIM=2048\n',
  });
  assert.equal(checkNamed(ok.json, 'memory-boot-consistency').status, 'pass');
  assert.equal(checkNamed(ok.json, 'ai-hosts-probe').detail, 'MODELS=1 EMBED_DIM=2048 (expected 2048)');
  assert.equal(ok.json.verdict, 'PASS', JSON.stringify(ok.json.checks));

  // file says 1024, env says 2048 → a 1024-dim probe answer is now the mismatch
  const bad = await runVerify(entries, {
    botLogs: 'AI: memory ready — 1 fact(s), model=m dim=2048\nReady! v',
    probeOut: 'MODELS=1\nEMBED_DIM=1024\n',
  });
  const b = checkNamed(bad.json, 'ai-hosts-probe');
  assert.equal(b.status, 'fail');
  assert.match(b.detail, /EMBED_DIM=1024 expected=2048/);
});

test('20. embed target: memoryEmbeddingHost verbatim (trailing slashes stripped) beats vmlxHost', () => {
  assert.equal(embedEndpoint({ memoryEmbeddingHost: 'http://embed.local:9999/custom/v1///', vmlxHost: 'http://x' }), 'http://embed.local:9999/custom/v1/embeddings');
  assert.equal(embedEndpoint({ vmlxHost: 'http://192.168.0.145:8080/v1' }), 'http://192.168.0.145:8080/v1/embeddings');
  assert.equal(embedEndpoint({}), null);
});

test('21. memoryEmbeddingHost set → baked verbatim into probe stdin; unset → vmlx fallback', async () => {
  const { calls } = await runVerify([], {
    hostCfg: { ...HOST_CFG, memoryEmbeddingHost: 'http://embed.local:9999/custom/v1' },
  });
  const probe = calls.find(c => c.cmd.includes('exec -T bot node -'));
  assert.ok(probe.input.includes(`const EMBED_TARGET = ${JSON.stringify('http://embed.local:9999/custom/v1/embeddings')};`), probe.input.slice(0, 160));
});


// ---- card 6ae63608584981c6b5b89cb8: version-agnostic inspect / 30s probe / gateway retry ----

test('22. probe fetch budget = 30s ×2 (10s gone); ssh probe cap still 60s', async () => {
  assert.equal((PROBE_SRC.match(/AbortSignal\.timeout\(30000\)/g) || []).length, 2, 'both fetches capped at 30s');
  assert.ok(!PROBE_SRC.includes('10000'), 'old 10s budget is gone');
  const { calls } = await runVerify();
  const probe = calls.find(c => c.cmd.includes('exec -T bot node -'));
  assert.equal(probe.timeoutMs, 60000, 'probe ssh call keeps the 60s overall cap');
});

test('23. v28 schema pass: top-level RestartCount, State WITHOUT it → bot=running/0, no note', async () => {
  const { json } = await runVerify(); // passEntries is v28-shape by construction
  const c = checkNamed(json, 'health-running-s1');
  assert.equal(c.status, 'pass');
  assert.match(c.detail, /bot=running\/0/);
  assert.ok(!c.detail.includes('RestartCount absent'), c.detail);
});

test('24. v24 schema pass: RestartCount only inside State (no top-level) → identical semantics', async () => {
  const v24 = JSON.stringify({
    Id: 'cid-bot',
    State: { Status: 'running', Running: true, Restarting: false, Dead: false, ExitCode: 0, OOMKilled: false, RestartCount: 0 },
  });
  const { json } = await runVerify([{ match: 'cid-bot', stdout: v24 }]);
  const c = checkNamed(json, 'health-running-s1');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /bot=running\/0/);
  assert.ok(!c.detail.includes('RestartCount absent'), 'State-carried rc is NOT treated as missing');
});

test('25. RestartCount absent everywhere → pass with rc 0 + detail note names the services', async () => {
  const noRc = JSON.stringify({
    Id: 'x',
    State: { Status: 'running', Running: true, Restarting: false, Dead: false, ExitCode: 0, OOMKilled: false },
  });
  const { json } = await runVerify([
    { match: 'cid-bot', stdout: noRc },
    { match: 'cid-speck', stdout: noRc },
  ]);
  const c = checkNamed(json, 'health-running-s1');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /bot=running\/0 speck=running\/0/);
  assert.match(c.detail, /RestartCount absent for: bot, speck \(treated 0\)/);
});

test('26. exited + OOM: Running=false ExitCode=137 OOMKilled=true → FAIL detail carries exit/oom', async () => {
  const doc = inspectDoc('cid-bot', { rc: 0, state: { Status: 'exited', Running: false, ExitCode: 137, OOMKilled: true } });
  const { json, exit } = await runVerify([{ match: 'cid-bot', stdout: doc }]);
  const c = checkNamed(json, 'health-running-s1');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /bot=exited\/0 exit=137,oom/);
  assert.equal(json.verdict, 'FAIL');
  assert.equal(exit, 1);
});

test('27. Restarting=true → FAIL (Running=false path intact)', async () => {
  const doc = inspectDoc('cid-bot', { rc: 2, state: { Status: 'restarting', Running: false, Restarting: true, ExitCode: 1 } });
  const { json } = await runVerify([{ match: 'cid-bot', stdout: doc }]);
  const c = checkNamed(json, 'health-running-s1');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /bot=restarting\/2 exit=1/);
});

test('28. non-JSON inspect stdout → error check names the service', async () => {
  const { json } = await runVerify([{ match: 'cid-glorb', stdout: 'Cannot connect to the Docker daemon\n' }]);
  const c = checkNamed(json, 'health-running-s1');
  assert.equal(c.status, 'error');
  assert.match(c.detail, /glorb: inspect output is not JSON/);
});

// NOTE: retry targets are speck/glorb — `logs bot --since` is consumed first by
// memory-boot-consistency, so bot seq indices would be offset by one.

test('29. gateway retry PASS: speck Ready! lands on scan 2 → gateway-ready PASS names retry', async () => {
  const { json, gaps } = await runVerify([
    { match: 'logs speck --since', seq: [{ stdout: 'starting up...\n' }, { stdout: `${READY_LINE('speck')}\n` }] },
  ]);
  const c = checkNamed(json, 'gateway-ready');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /speck ✓/, 'scan-2 result is authoritative');
  assert.match(c.detail, /\(retry after 20s: speck\)/);
  assert.deepEqual(gaps, [60000, 20000], 'sample gap + one 20s retry sleep');
});

test('30. gateway retry single-shot: static miss → FAIL, exactly 2 speck scans, gaps has 20000 ONCE', async () => {
  const { json, calls, gaps } = await runVerify([{ match: 'logs speck --since', stdout: 'starting up...\n' }]);
  const c = checkNamed(json, 'gateway-ready');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /speck ✗/);
  assert.match(c.detail, /bot ✓/);
  assert.match(c.detail, /\(retry after 20s: speck\)/);
  assert.deepEqual(gaps, [60000, 20000], 'one retry sleep only — no retry loop');
  assert.equal(
    calls.filter(x => x.cmd.includes('logs speck --since')).length,
    2,
    'exactly one recheck (scan 1 + scan 2)',
  );
  assert.equal(
    calls.filter(x => x.cmd.includes(`logs speck --since ${STARTED_AT}`)).length,
    2,
    'both scans reuse the same container StartedAt window',
  );
});

test('31. boot-line scans use the container StartedAt window when known (memory + all gateway services)', async () => {
  const { calls } = await runVerify(); // default inspectDoc carries State.StartedAt
  // docker compose log scans only (classifier is a shipped script — stays on --since 2m)
  const logCmds = calls.filter(c => c.cmd.includes('docker compose') && /logs (bot|speck|glorb) --since/.test(c.cmd));
  assert.ok(logCmds.length >= 4, `memory scan + three gateway scans present, got ${logCmds.length}`);
  assert.ok(logCmds.some(c => c.cmd.includes('logs bot --since')), 'memory-boot-consistency log scan present');
  for (const s of ['bot', 'speck', 'glorb']) {
    assert.ok(logCmds.some(c => c.cmd.includes(`logs ${s} --since ${STARTED_AT}`)), `gateway ${s} scan scoped`);
  }
  for (const c of logCmds) {
    assert.ok(c.cmd.endsWith(`--since ${STARTED_AT}`), `window not scoped to StartedAt: ${c.cmd}`);
  }
  // the shipped classifier keeps its own fixed window
  assert.ok(calls.every(c => !c.cmd.includes('deploy-host-logs.sh') || c.cmd.includes('--since 2m')), 'classifier untouched');
});

test('32. StartedAt absent/zero-value → those services fall back to --since 2m; known stays scoped', async () => {
  const { calls } = await runVerify([
    { match: 'cid-bot', stdout: inspectDoc('cid-bot', { state: { StartedAt: undefined } }) },
    { match: 'cid-speck', stdout: inspectDoc('cid-speck', { state: { StartedAt: ZERO_STARTED_AT } }) },
  ]);
  const windows = (svc) => [
    ...new Set(
      calls
        .filter(c => c.cmd.includes('docker compose') && c.cmd.includes(`logs ${svc} --since`))
        .map(c => c.cmd.match(/--since (\S+)/)[1]),
    ),
  ];
  assert.deepEqual(windows('bot'), ['2m'], 'no StartedAt key → 2m (memory + gateway scans)');
  assert.deepEqual(windows('speck'), ['2m'], 'zero-value 0001-01-01 = never started → 2m');
  assert.deepEqual(windows('glorb'), [STARTED_AT], 'known container keeps its scoped window');
});


// ---- card 6aeab42bc4759702f8df2835: ai-hosts-probe infra retry in place ----
// A 503 model_load_failed / connect-level failure is a TRANSIENT dependency
// (Nov-3: five healthy builds rolled back over it). The probe signals retryable
// runs with a RETRYABLE=1 marker + exit 75; verifyDeploy sleeps the
// 30/60/120s schedule and re-probes BEFORE recording a fail. These run through
// the fake runner + injected sleep — deterministic, zero wall-clock waits.

const INFRA_503 = {
  code: 75,
  stdout: 'RETRYABLE=1 HTTP=503 CODE=model_load_failed RETRY_AFTER=30\n',
  stderr: 'probe: POST http://192.168.0.145:8080/v1/embeddings -> HTTP 503\n',
};
const INFRA_REFUSED = {
  code: 75,
  stdout: 'RETRYABLE=1 HTTP=- CODE=ECONNREFUSED RETRY_AFTER=-\n',
  stderr: 'probe: fetch failed\n',
};
const PROBE_OK = { code: 0, stdout: 'MODELS=2\nEMBED_DIM=1024\n' };
const probeCalls = calls => calls.filter(c => c.cmd.includes('exec -T bot node -')).length;

test('33. 503 model_load_failed → 200 on attempt 2 → PASS with recovered narrative + one 30s sleep', async () => {
  const { json, exit, calls, gaps } = await runVerify([
    { match: 'exec -T bot node -', seq: [INFRA_503, PROBE_OK] },
  ]);
  const c = checkNamed(json, 'ai-hosts-probe');
  assert.equal(c.status, 'pass', c.detail);
  assert.equal(c.detail, 'MODELS=2 EMBED_DIM=1024 (expected 1024) — recovered after retry 1 of 3 (infra: HTTP 503 model_load_failed)');
  assert.equal(json.verdict, 'PASS');
  assert.equal(exit, 0);
  assert.equal(probeCalls(calls), 2, 'exactly two probe attempts');
  assert.deepEqual(gaps, [60000, 30000], 'sample gap + ONE 30s backoff (matches gateway retry_after 30)');
});

test('34. persistent 503 → FAIL only after 4 attempts / 3 sleeps, exhaustion prefix names schedule + last marker', async () => {
  const { json, exit, calls, gaps } = await runVerify([
    { match: 'exec -T bot node -', ...INFRA_503 },
  ]);
  const c = checkNamed(json, 'ai-hosts-probe');
  assert.equal(c.status, 'fail');
  assert.ok(c.detail.startsWith('infra retries exhausted (30/60/120s): RETRYABLE=1 HTTP=503 CODE=model_load_failed RETRY_AFTER=30'), c.detail);
  assert.equal(json.verdict, 'FAIL');
  assert.equal(exit, 1, 'FAIL after the budget — the [VERIFY:FAIL] → rollback contract is unchanged');
  assert.equal(probeCalls(calls), 4, 'initial attempt + 3 retries');
  assert.deepEqual(gaps, [60000, 30000, 60000, 120000], 'production default backoff 30/60/120s, all local sleeps');
});

test('35. ECONNREFUSED connect failure → same retry path, NET label in the recovered narrative', async () => {
  const { json, calls, gaps } = await runVerify([
    { match: 'exec -T bot node -', seq: [INFRA_REFUSED, PROBE_OK] },
  ]);
  const c = checkNamed(json, 'ai-hosts-probe');
  assert.equal(c.status, 'pass', c.detail);
  assert.match(c.detail, /recovered after retry 1 of 3 \(infra: NET ECONNREFUSED\)/);
  assert.equal(probeCalls(calls), 2);
  assert.deepEqual(gaps, [60000, 30000]);
});

test('36. dim 2560 misroute + plain probe exit 1 → FAIL FAST: one attempt, zero retry sleeps', async () => {
  const mis = await runVerify([], { probeOut: 'MODELS=3\nEMBED_DIM=2560\n' });
  const c = checkNamed(mis.json, 'ai-hosts-probe');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /sushi misroute/);
  assert.equal(probeCalls(mis.calls), 1, 'config defect is never retried — the retry window stays 0s');
  assert.deepEqual(mis.gaps, [60000], 'no infra sleeps');

  const dead = await runVerify([], { probeCode: 1, probeOut: '' });
  assert.match(checkNamed(dead.json, 'ai-hosts-probe').detail, /probe exit 1/);
  assert.equal(probeCalls(dead.calls), 1, 'unclassified non-zero exit = today\'s single attempt');
  assert.deepEqual(dead.gaps, [60000]);
});

test('37. exit 75 WITHOUT marker (belt path) → still retried; marker is stdout-authoritative (belt-and-braces)', async () => {
  const { json, calls } = await runVerify([
    { match: 'exec -T bot node -', seq: [{ code: 75, stdout: '' }, PROBE_OK] },
  ]);
  assert.equal(checkNamed(json, 'ai-hosts-probe').status, 'pass');
  assert.equal(probeCalls(calls), 2);
});

test('38. happy path stays single-attempt, detail byte-compatible, zero infra sleeps', async () => {
  const { json, calls, gaps } = await runVerify();
  assert.equal(checkNamed(json, 'ai-hosts-probe').detail, 'MODELS=2 EMBED_DIM=1024 (expected 1024)');
  assert.equal(probeCalls(calls), 1);
  assert.deepEqual(gaps, [60000], 'only the health sample gap — retry loop adds nothing when the probe passes');
});
