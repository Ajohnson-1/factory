#!/usr/bin/env node
// Factory VERIFY stage (card 6ae4c8763f202fc86c57ef65; docs/factory.md).
//
// Five gates against the deployed host, services discovered from the host's own
// compose file (`config --services` — honors "and speck/glorb if defined"), all
// remote compose calls carrying `--env-file .deploy-env` (the one-line BOT_IMAGE
// source deploy.js wrote; unset everywhere = today's :latest default):
//
//   health-running-s1 / health-running-s2 — per service `compose ps -q` →
//     `docker inspect --format '{{json .}}'`; pass ⇔ every service reports
//     `running` + RestartCount 0 (version-agnostic parse: v28 REMOVED
//     State.RestartCount, pre-v25 lacks the top-level field — chain
//     top-level → State → 0 with a detail note). Sampled TWICE with a 60s local
//     gap (no ssh `sleep` holding a session); two named entries make a
//     restart-in-between visible.
//   memory-boot-consistency — bot logs (`AI: memory ready … dim=<n>` / disabled /
//     unavailable) vs the STRICT intent mirrored from config.js:457/465 — env
//     vars read via `compose exec -T bot printenv` (AI_MEMORY_ENABLED === 'true'
//     overrides; MEMORY_EMBEDDING_DIMENSION ?? file value), file value through
//     `compose exec -T bot cat /app/config/config.json` (the card's exact read
//     path). config.js accepts only a JSON boolean `true` — a STRING "true"
//     silently disables memory, so a non-boolean file value with no env override
//     FAILS loudly here (the acceptance FAIL path). dim is asserted against
//     Number(env ?? file ?? 1024) || 1024 (embedder.js:114).
//   ai-hosts-probe — a node probe delivered on SSH STDIN to
//     `compose exec -T bot node -` (the image has no curl; node 22 global fetch):
//     GET :12345/v1/models, POST to the embedder.js hostUrl()-parity endpoint
//     (memoryEmbeddingHost || vmlxHost, verbatim, + '/embeddings'); EMBED_DIM
//     must equal the expected dim — 2560 means the sushi chat endpoint is
//     answering /v1/embeddings (embedder.js DIM_FAILURE_NOTE misroute).
//     INFRA RETRY (card 6aeab42bc4759702f8df2835): HTTP 429/500/502/503/504 on
//     either endpoint (incl. the embeddings gateway's 503 `model_load_failed`
//     with `retry_after`) or a connect-level failure (ECONNREFUSED/EHOSTDOWN/
//     …, fetch timeout) is TRANSIENT — the probe prints a `RETRYABLE=1` marker
//     line and exits 75, and verifyDeploy re-probes up to 3x with 30/60/120s
//     backoff BEFORE recording fail. A FAIL (and the scheduler's rollback) now
//     requires the retry budget to be exhausted; dim mismatch and other config
//     defects stay fail-fast on a single attempt.
//   gateway-ready — `Ready!` in each service's logs SINCE the container's own
//     StartedAt from health sample 1 (boot lines are one-time writes — a fixed
//     2m window false-FAILs verify runs >2min post-startup; `--since 2m` is the
//     fallback when StartedAt is unknown; index.js:229); any miss gets ONE
//     recheck after a 20s local sleep (cold-start grace) — scan 2 is
//     authoritative, retried service names ride in the detail.
//   logs-classifier — the SHIPPED copy $DIR/deploy-host-logs.sh (deploy.js cp's it
//     from the deployed sha's tree, so it can never go stale; invoked with `bash`,
//     its shebang interpreter — the script is bash-only: arrays, set -euo pipefail).
//     exit 0 → PASS; exit 2 → PASS (degraded-but-running is a legitimate steady
//     state; memory-boot-consistency owns the intent verdict); exit 1 → FAIL
//     (crash); exit 3/4 → FAIL (the gate itself broke); unparseable stdout → FAIL.
//
// Output contract: stdout is ONLY the verdict JSON (the scheduler pipes it
// straight into `factory.js comment -`); the human summary goes to stderr.
// Exit 0 on PASS; 1 on any fail/error check; 2 (same JSON shape + top-level
// "error") when DEPLOY_HOST is unset — zero remote calls.
//
// Unit tests fake the runner in-process (scripts/lib/deploy-ssh.js DI seam).

import { deployConfig } from './lib/deploy-config.js';
import { makeSSH } from './lib/deploy-ssh.js';
import { pathToFileURL } from 'node:url';

// Probe executed INSIDE the bot container via `node -` on ssh stdin (CommonJS:
// stdin scripts are CJS regardless of package.json type). Reads the bind-mounted
// host config for the model list (sushi origin, port forced to 12345 — plan §d);
// the embeddings endpoint arrives baked-in as EMBED_TARGET by embedEndpoint() so
// it mirrors embedder.js hostUrl() EXACTLY (memoryEmbeddingHost || vmlxHost,
// trailing-slash strip, + '/embeddings' — never a port guess). 30s per fetch
// (cold embedder first call observed ~13s).
// Infra classification (card 6aeab42bc4759702f8df2835): the Nov-3 145 outage —
// persistent 503 `Session is already running` (code=model_load_failed,
// retry_after 30) under sushi load — rolled back 5 healthy builds because the
// probe had no notion of a TRANSIENT dependency. Now: HTTP 429/500/502/503/504
// on EITHER endpoint, or a network-level fetch failure (ECONNREFUSED/…/
// AbortSignal timeout), prints a machine marker on STDOUT and exits 75
// (EX_TEMPFAIL) so verifyDeploy retries IN PLACE. Everything else keeps today's
// fail-fast exit 1: dim mismatch (a 2560 sushi-misroute is a CONFIG defect —
// retrying it wastes the whole backoff budget), empty models list, missing
// vector, config-read failures, unparseable body-shape.
export const PROBE_SRC = `'use strict';
const fs = require('fs');
const RETRY_STATUSES = [429, 500, 502, 503, 504];
const NET_CODES = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENOTFOUND', 'ETIMEDOUT'];
function marker(http, code, retryAfter) {
  return 'RETRYABLE=1 HTTP=' + http + ' CODE=' + code + ' RETRY_AFTER=' + retryAfter;
}
// Best-effort code/retry_after pull from an error body; observed shape:
// {"error":{"code":"model_load_failed","message":"Session is already running","retry_after":30}}
function bodyInfra(text) {
  try {
    const b = JSON.parse(text);
    const src = b && typeof b.error === 'object' && b.error ? b.error : b;
    const code = src && typeof src.code === 'string' ? src.code : '-';
    const ra = src && src.retry_after;
    const retry = typeof ra === 'number' && isFinite(ra) ? String(ra) : typeof ra === 'string' && ra !== '' ? ra : '-';
    return { code: code, retry: retry };
  } catch (e) {
    return { code: '-', retry: '-' };
  }
}
// Network-level fetch failure? Node fetch wraps syscalls as a TypeError whose
// cause carries the errno (ECONNREFUSED …); AbortSignal.timeout throws a
// TimeoutError DOMException. Anything else (JSON parse etc.) returns null =
// fail fast, today's behavior.
function netCode(e) {
  const cause = (e && e.cause) || {};
  const code = cause.code || (e && e.code) || '';
  if (NET_CODES.indexOf(code) !== -1) return code;
  const msg = String(cause.message || (e && e.message) || e);
  for (const n of NET_CODES) { if (msg.indexOf(n) !== -1) return n; }
  const name = (e && e.name) || '';
  return name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : null;
}
// Non-OK response: retryable statuses emit the marker + exit 75; other statuses
// keep the historical stderr line (+ code/body when the body carried one).
async function nonOk(label, r) {
  let text = '';
  try { text = await r.text(); } catch (e) {}
  const b = bodyInfra(text);
  if (RETRY_STATUSES.indexOf(r.status) !== -1) {
    console.log(marker(String(r.status), b.code, b.retry));
    process.exit(75);
  }
  console.error('probe: ' + label + ' -> HTTP ' + r.status + (b.code !== '-' ? ' code=' + b.code : '') + (text ? ' body=' + text.slice(0, 120) : ''));
}
(async () => {
  const cfg = JSON.parse(fs.readFileSync('/app/config/config.json', 'utf8'));
  if (!cfg.sushiHost) { console.error('probe: config missing sushiHost'); process.exit(1); }
  if (!cfg.memoryEmbeddingModel) { console.error('probe: config missing memoryEmbeddingModel'); process.exit(1); }
  if (!EMBED_TARGET) { console.error('probe: no embedding host configured (memoryEmbeddingHost/vmlxHost)'); process.exit(1); }
  const models = new URL(cfg.sushiHost); models.port = '12345'; models.pathname = '/v1/models';
  const embed = EMBED_TARGET;
  try {
    const r1 = await fetch(models, { signal: AbortSignal.timeout(30000) });
    if (!r1.ok) { await nonOk('GET ' + models, r1); process.exit(1); }
    const j1 = await r1.json();
    if (!Array.isArray(j1.data) || j1.data.length === 0) { console.error('probe: models list empty'); process.exit(1); }
    console.log('MODELS=' + j1.data.length);
    const r2 = await fetch(embed, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.memoryEmbeddingModel, input: 'factory-verify-probe' }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r2.ok) { await nonOk('POST ' + embed, r2); process.exit(1); }
    const j2 = await r2.json();
    const v = j2.data && j2.data[0] && j2.data[0].embedding;
    if (!Array.isArray(v)) { console.error('probe: embeddings response carries no vector'); process.exit(1); }
    console.log('EMBED_DIM=' + v.length);
    process.exit(0);
  } catch (e) {
    const nc = netCode(e);
    if (nc) { console.log(marker('-', nc, '-')); process.exit(75); }
    console.error('probe: ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  }
})();
`;

// embedder.js hostUrl() parity (service/ai/memory/embedder.js:67-71):
// raw = memoryEmbeddingHost || vmlxHost — verbatim, trailing slashes stripped,
// '/embeddings' appended. No port/path guessing.
export function embedEndpoint(cfg) {
  const raw = cfg.memoryEmbeddingHost || cfg.vmlxHost || '';
  if (!raw) return null;
  return raw.replace(/\/+$/, '') + '/embeddings';
}

// In-container env var via `compose exec -T bot printenv <VAR>`. printenv exits 1
// for an unset variable — that is the NORMAL answer, not an error. Empty value or
// transport hiccup = unset (config.js treats '' the same way: !== 'true', NaN/0
// dimension falls through to the file value via embedder's Number()||1024).
function envVar(ssh, DIR, name) {
  const r = ssh.run(`cd ${DIR} && docker compose --env-file .deploy-env exec -T bot printenv ${name}`);
  if (r.code !== 0) return undefined;
  const v = String(r.stdout).trim();
  return v === '' ? undefined : v;
}

const INSPECT_FMT = "'{{json .}}'";
const GATEWAY_RETRY_MS = 20000;

// Infra backoff schedule for the ai-hosts-probe retry loop (card
// 6aeab42bc4759702f8df2835): 3 retries matching the embeddings gateway's own
// `retry_after 30`; max +210s on verify's already-slow path. Injectable — unit
// tests assert the schedule through the `sleep` seam without waiting.
export const PROBE_RETRY_MS_DEFAULT = [30_000, 60_000, 120_000];

// A retryable probe run announces itself: RETRYABLE=1 marker on probe STDOUT
// (robust through the ssh seam — stderr/exit-code can be laundered by the
// transport) and exit 75 EX_TEMPFAIL (belt). code=null is an ssh transport
// failure — the probe never spoke; today's `error` status, never retried here.
function classifyInfraRetry(probe) {
  if (probe.code === null) return null;
  const m = /RETRYABLE=1 HTTP=(\S+) CODE=(\S+) RETRY_AFTER=(\S+)/.exec(String(probe.stdout || ''));
  if (!m && probe.code !== 75) return null;
  return {
    http: m ? m[1] : '-',
    code: m ? m[2] : 'exit75',
    line: m ? m[0] : 'RETRYABLE=1 (no marker line; exit 75)',
  };
}

// Human-parseable infra label for the recovered-after-retry narrative.
function infraLabel(infra) {
  if (!infra) return 'infra';
  if (infra.http !== '-') return `HTTP ${infra.http}${infra.code !== '-' ? ` ${infra.code}` : ''}`;
  return `NET ${infra.code}`;
}

// Final classification of a probe run that ended WITHOUT the retryable marker
// (exhaustion is handled by the caller). Byte-compatible with pre-retry detail
// strings so existing consumers/tests see the same text on today's fail paths.
function probeOutcome(probe, expectedDim, retries, maxRetries, lastInfra) {
  if (probe.code === null) return { status: 'error', detail: `ssh error: ${String(probe.stderr).slice(0, 300)}` };
  if (probe.code !== 0) return { status: 'fail', detail: `probe exit ${probe.code}: ${(probe.stderr || '').trim().slice(0, 300)}` };
  const mm = String(probe.stdout).match(/MODELS=(\d+)/);
  const em = String(probe.stdout).match(/EMBED_DIM=(\d+)/);
  if (!mm || !em) return { status: 'fail', detail: `probe output unparseable: ${String(probe.stdout).trim().slice(0, 200)}` };
  const nModels = Number(mm[1]);
  const embedDim = Number(em[1]);
  if (embedDim !== expectedDim) {
    return {
      status: 'fail',
      detail: `MODELS=${nModels} EMBED_DIM=${embedDim} expected=${expectedDim} — ${embedDim === 2560 ? `sushi misroute: embed host returned ${embedDim}-dim chat vectors` : 'embedding dimension mismatch'}`,
    };
  }
  const base = `MODELS=${nModels} EMBED_DIM=${embedDim} (expected ${expectedDim})`;
  return {
    status: 'pass',
    detail: retries > 0 ? `${base} — recovered after retry ${retries} of ${maxRetries} (infra: ${infraLabel(lastInfra)})` : base,
  };
}

// One parse path for `docker inspect --format '{{json .}}'` docs (healthSample
// is the sole caller, so both samples read fields identically). Version-agnostic
// field chain: v28 REMOVED .State.RestartCount; pre-v25 has no top-level
// RestartCount — top-level (v25+) → State (pre-v25) → 0 + missing flag.
function parseInspect(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    return { err: String((e && e.message) || e) };
  }
  const st = j.State ?? {};
  let rc;
  let rcMissing = false;
  if (typeof j.RestartCount === 'number') rc = j.RestartCount;
  else if (typeof st.RestartCount === 'number') rc = st.RestartCount;
  else { rc = 0; rcMissing = true; }
  // Boot-line scan window anchor: Ready!/memory lines are one-time boot writes,
  // so log fetches should start at the container's own start, not a fixed 2m.
  // "0001-01-01T00:00:00Z" = Go zero value (never started) → unavailable.
  const rawStarted = typeof st.StartedAt === 'string' && !st.StartedAt.startsWith('0001-01-01') ? st.StartedAt : null;
  return {
    j,
    running: st.Running === true,
    restarting: st.Restarting === true,
    dead: st.Dead === true,
    exitCode: st.ExitCode,
    oom: st.OOMKilled === true,
    rc,
    rcMissing,
    startedAt: rawStarted,
  };
}

function lastLineWith(lines, marker) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(marker)) return lines[i];
  }
  return null;
}

async function healthSample({ ssh, DIR, services }) {
  const parts = [];
  const missingRc = [];
  // svc → container StartedAt (ISO) or null (absent/zero/unknown) — sample 1's
  // map feeds the boot-line scans (memory-boot-consistency, gateway-ready).
  const startedAt = {};
  let allOk = true;
  for (const svc of services) {
    const r = ssh.run(`cd ${DIR} && docker compose --env-file .deploy-env ps -q ${svc}`);
    if (r.code === null) return { status: 'error', detail: `${svc}: ssh error: ${r.stderr}`, startedAt };
    if (r.code !== 0) return { status: 'error', detail: `${svc}: compose ps -q failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`, startedAt };
    const cid = r.stdout.trim().split('\n').map(s => s.trim()).filter(Boolean)[0];
    if (!cid) {
      parts.push(`${svc}=absent/-`);
      startedAt[svc] = null;
      allOk = false;
      continue;
    }
    const ins = ssh.run(`docker inspect --format ${INSPECT_FMT} ${cid}`);
    if (ins.code === null) return { status: 'error', detail: `${svc}: ssh error: ${ins.stderr}`, startedAt };
    if (ins.code !== 0) return { status: 'error', detail: `${svc}: docker inspect failed (exit ${ins.code}): ${ins.stderr.trim().slice(0, 200)}`, startedAt };
    const p = parseInspect(ins.stdout);
    if (p.err) return { status: 'error', detail: `${svc}: inspect output is not JSON: ${ins.stdout.trim().slice(0, 120)}`, startedAt };
    if (p.rcMissing) missingRc.push(svc);
    startedAt[svc] = p.startedAt;
    // Restarting/Dead imply Running=false → the same FAIL path as exited.
    const label = p.running ? 'running' : p.restarting ? 'restarting' : p.dead ? 'dead' : 'exited';
    let part = `${svc}=${label}/${p.rc}`;
    if (!p.running) part += ` exit=${p.exitCode}${p.oom ? ',oom' : ''}`;
    parts.push(part);
    if (!p.running || p.rc !== 0) allOk = false;
  }
  let detail = parts.join(' ');
  if (missingRc.length) detail += ` — RestartCount absent for: ${missingRc.join(', ')} (treated 0)`;
  return { status: allOk ? 'pass' : 'fail', detail, startedAt };
}

export async function verifyDeploy({ ssh, cfg, sampleGapMs = 60000, probeRetryMs = PROBE_RETRY_MS_DEFAULT, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const start = Date.now();
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const DIR = cfg.dir;
  let services = [];

  // ---- discovery ----------------------------------------------------------------
  const disc = ssh.run(`cd ${DIR} && docker compose --env-file .deploy-env config --services`);
  if (disc.code !== 0) {
    services = [];
    add('services-discovery', 'error', `compose config --services failed (exit ${disc.code}): ${(disc.stderr || disc.stdout || '').trim().slice(0, 300)}`);
  } else {
    services = disc.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  }

  if (services.length > 0) {
    // ---- 1. health, two samples ---------------------------------------------------
    const s1 = await healthSample({ ssh, DIR, services });
    add('health-running-s1', s1.status, s1.detail);
    // Sample 1's container StartedAt map anchors the two boot-line scans below:
    // Ready!/memory lines are one-time boot writes, so a fixed 2m window
    // false-FAILs any verify run >2min after startup. Unknown/never-started
    // (absent container, zero-value StartedAt, inspect failure) → '2m' fallback.
    const started = s1.startedAt ?? {};
    const logSince = (svc) => started[svc] ?? '2m';
    await sleep(sampleGapMs);
    const s2 = await healthSample({ ssh, DIR, services });
    add('health-running-s2', s2.status, s2.detail);

    // ---- 2. memory boot vs strict config intent -----------------------------------
    const logsR = ssh.run(`cd ${DIR} && docker compose --env-file .deploy-env logs bot --since ${logSince('bot')}`);
    const cfgR = ssh.run(`cd ${DIR} && docker compose --env-file .deploy-env exec -T bot cat /app/config/config.json`);
    let hostCfg = null;
    if (logsR.code === null || cfgR.code === null) {
      add('memory-boot-consistency', 'error', `ssh error: ${(logsR.stderr || cfgR.stderr || '').slice(0, 300)}`);
    } else if (cfgR.code !== 0) {
      add('memory-boot-consistency', 'error', `read /app/config/config.json failed (exit ${cfgR.code}): ${cfgR.stderr.trim().slice(0, 200)}`);
    } else {
      try {
        hostCfg = JSON.parse(cfgR.stdout);
      } catch {
        add('memory-boot-consistency', 'error', `config.json is not parseable JSON: ${cfgR.stdout.trim().slice(0, 120)}`);
      }
    }
    let expectedDim = null;
    if (hostCfg) {
      // config.js precedence mirrored literally (config.js:457/465):
      //   enabled ⇔ env AI_MEMORY_ENABLED === 'true' || file aiMemoryEnabled === true (STRICT JSON boolean)
      //   dim     ⇔ parseNumber(env MEMORY_EMBEDDING_DIMENSION) ?? file ?? 1024   (parseNumber: Number(val), NaN → unset)
      // then embedder.js:114: Number(value) || 1024. printenv exit 1 (unset) is the NORMAL answer.
      const envMem = envVar(ssh, DIR, 'AI_MEMORY_ENABLED');
      const envDimRaw = envVar(ssh, DIR, 'MEMORY_EMBEDDING_DIMENSION');
      const envEnabled = envMem === 'true';
      let envDim;
      if (envDimRaw !== undefined) {
        const n = Number(envDimRaw);
        envDim = Number.isNaN(n) ? undefined : n;
      }
      expectedDim = Number(envDim ?? hostCfg.memoryEmbeddingDimension ?? 1024) || 1024;

      const lines = logsR.stdout.split('\n');
      const raw = hostCfg.aiMemoryEnabled; // absent → undefined → file intent = disabled
      const intent = envEnabled || raw === true;
      const ready = lastLineWith(lines, 'AI: memory ready');
      const disabled = lastLineWith(lines, 'AI: memory disabled');
      const unavailable = lastLineWith(lines, 'AI: memory unavailable');
      if (!envEnabled && raw !== undefined && typeof raw !== 'boolean') {
        // The silent-disable footgun (config.js:457 strict === true): string "true"
        // DISABLES memory at boot yet reads as enabled here — never let it pass.
        add(
          'memory-boot-consistency',
          'fail',
          `aiMemoryEnabled=${JSON.stringify(raw)} is not a JSON boolean — index.js/config.js:457 treat only strict true as enabled (a string value silently disables memory; env AI_MEMORY_ENABLED=${JSON.stringify(envMem ?? null)} is not 'true')`,
        );
      } else if (intent) {
        if (ready) {
          const m = ready.match(/dim=(\d+)/);
          const dim = m ? Number(m[1]) : null;
          if (dim === null) {
            add('memory-boot-consistency', 'fail', `intent=enabled ready line carries no dim= field: ${ready.trim().slice(0, 200)}`);
          } else if (dim !== expectedDim) {
            add('memory-boot-consistency', 'fail', `intent=enabled observed=ready dim=${dim} expected=${expectedDim} — dimension mismatch (embedder.js:114 asserts ${expectedDim})`);
          } else {
            add('memory-boot-consistency', 'pass', `intent=enabled${envEnabled && raw !== true ? ' (env AI_MEMORY_ENABLED=true)' : ''} observed=ready dim=${dim}`);
          }
        } else if (disabled) {
          add('memory-boot-consistency', 'fail', `intent=enabled but observed disabled line — inconsistency: ${disabled.trim().slice(0, 200)}`);
        } else if (unavailable) {
          add('memory-boot-consistency', 'fail', `intent=enabled but booted degraded: ${unavailable.trim().slice(0, 200)}`);
        } else {
          add('memory-boot-consistency', 'fail', 'no memory boot line in last 2m logs');
        }
      } else if (disabled) {
        add('memory-boot-consistency', 'pass', 'intent=disabled observed=disabled');
      } else if (ready) {
        add('memory-boot-consistency', 'fail', `intent=disabled but observed ready line — inconsistency: ${ready.trim().slice(0, 200)}`);
      } else {
        add('memory-boot-consistency', 'fail', 'no memory boot line in last 2m logs');
      }
    }

    // ---- 3. in-container AI hosts probe (ssh stdin payload) ------------------------
    // Infra retry loop (card 6aeab42bc4759702f8df2835): a RETRYABLE=1 marker on
    // probe stdout (429/5xx on either endpoint, or a connect-level failure —
    // see PROBE_SRC) means a TRANSIENT dependency, not a broken build: sleep
    // the backoff schedule and re-probe IN PLACE. Only budget exhaustion fails
    // the deploy (rollback storm of Nov-3 was the healthy-build case this
    // fixes). Non-retryable fail paths (dim mismatch / empty models /
    // unparseable output / ssh transport error) run exactly once — today's
    // behavior. A FAIL after exhaustion still triggers the scheduler's
    // [VERIFY:FAIL] → rollback contract unchanged.
    const embedTarget = hostCfg ? embedEndpoint(hostCfg) : null;
    const probeInput = `const EMBED_TARGET = ${JSON.stringify(embedTarget)};\n${PROBE_SRC}`;
    const runProbe = () => ssh.run(`cd ${DIR} && docker compose --env-file .deploy-env exec -T bot node -`, {
      input: probeInput,
      timeoutMs: 60000, // embeddings may be slow on the Mac host
    });
    if (hostCfg === null) {
      runProbe(); // kept for call-parity; the config verdict owns this failure
      add('ai-hosts-probe', 'error', 'skipped: host config unreadable (see memory-boot-consistency)');
    } else {
      let probe = runProbe();
      let infra = classifyInfraRetry(probe);
      let lastInfra = infra;
      let retries = 0;
      while (infra !== null && retries < probeRetryMs.length) {
        await sleep(probeRetryMs[retries]);
        retries += 1;
        probe = runProbe();
        infra = classifyInfraRetry(probe);
        if (infra) lastInfra = infra;
      }
      const outcome = infra !== null
        ? {
            status: 'fail',
            detail: `infra retries exhausted (${probeRetryMs.map((m) => Math.round(m / 1000)).join('/')}s): ${infra.line}`,
          }
        : probeOutcome(probe, expectedDim, retries, probeRetryMs.length, lastInfra);
      add('ai-hosts-probe', outcome.status, outcome.detail);
    }

    // ---- 4. gateway ready, per service ----------------------------------------------
    // Single recheck: Ready! can land just after the first scan (cold start);
    // sleep 20s locally, rescan ALL services once — scan 2 is authoritative.
    // Each scan uses the same per-service window (container StartedAt, else 2m).
    const scanReady = () => {
      const gw = [];
      let gwOk = true;
      for (const svc of services) {
        const r = ssh.run(`cd ${DIR} && docker compose --env-file .deploy-env logs ${svc} --since ${logSince(svc)}`);
        if (r.code === null) {
          gwOk = false;
          gw.push(`${svc} ssh-error`);
        } else {
          const ok = r.stdout.includes('Ready!');
          gw.push(`${svc} ${ok ? '✓' : '✗'}`);
          if (!ok) gwOk = false;
        }
      }
      return { gw, gwOk };
    };
    let { gw, gwOk } = scanReady();
    const retried = gw.filter(p => !p.endsWith('✓')).map(p => p.split(' ')[0]);
    if (retried.length > 0) {
      await sleep(GATEWAY_RETRY_MS);
      ({ gw, gwOk } = scanReady());
    }
    add('gateway-ready', gwOk ? 'pass' : 'fail', gw.join(' ') + (retried.length > 0 ? ` (retry after 20s: ${retried.join(', ')})` : ''));

    // ---- 5. shipped log classifier, per service --------------------------------------
    const cl = [];
    let clOk = true;
    for (const svc of services) {
      const r = ssh.run(`cd ${DIR} && bash deploy-host-logs.sh ${svc} --since 2m`);
      if (r.code === null) {
        clOk = false;
        cl.push(`${svc}: ssh-error`);
        continue;
      }
      const vm = String(r.stdout).match(/^VERDICT=(\S+) count=(\d+)$/m);
      if (r.code === 0 && vm && vm[1] === 'clean') {
        cl.push(`${svc}: ${vm[0]} (exit 0)`);
      } else if (r.code === 2 && vm && vm[1] === 'memory-degraded') {
        // degraded-but-running is the legitimate steady state of a memory-disabled
        // host (deploy-host.md §4); check 2 owns the config-intent verdict.
        cl.push(`${svc}: ${vm[0]} (exit 2)`);
      } else if (r.code === 1) {
        clOk = false;
        cl.push(`${svc}: ${vm ? vm[0] : 'VERDICT unparseable'} (exit 1 — crash signatures)`);
      } else if (r.code === 3 || r.code === 4) {
        clOk = false;
        cl.push(`${svc}: exit ${r.code} — classifier gate itself failed: ${(r.stderr || '').trim().slice(0, 120)}`);
      } else {
        clOk = false;
        cl.push(`${svc}: exit ${r.code} with unparseable stdout: ${String(r.stdout).trim().slice(0, 120)}`);
      }
    }
    add('logs-classifier', clOk ? 'pass' : 'fail', cl.join('; '));
  }

  const verdict = checks.some(c => c.status !== 'pass') ? 'FAIL' : 'PASS';
  const json = {
    verdict,
    host: `${cfg.user}@${cfg.host}`,
    dir: cfg.dir,
    services,
    ts: new Date().toISOString(),
    durationMs: Date.now() - start,
    checks,
  };
  return { json, exit: verdict === 'PASS' ? 0 : 1 };
}

export function errorVerdictJson(cfg, errors) {
  return {
    verdict: 'FAIL',
    error: errors.join('; '),
    host: cfg.host ? `${cfg.user}@${cfg.host}` : '',
    dir: cfg.dir,
    services: [],
    ts: new Date().toISOString(),
    durationMs: 0,
    checks: [],
  };
}

export async function main() {
  const cfg = deployConfig();
  if (cfg.errors.length) {
    console.log(JSON.stringify(errorVerdictJson(cfg, cfg.errors), null, 2)); // stdout stays pure JSON
    for (const e of cfg.errors) console.error(e);
    return 2;
  }
  const ssh = makeSSH(cfg);
  const { json, exit } = await verifyDeploy({ ssh, cfg });
  console.log(JSON.stringify(json, null, 2)); // stdout: ONLY the verdict JSON
  for (const c of json.checks) console.error(`${c.name}: ${c.status} — ${c.detail}`);
  console.error(`VERDICT ${json.verdict} (${json.host} ${json.dir})`);
  return exit;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main();
}
