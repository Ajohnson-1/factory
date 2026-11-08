#!/usr/bin/env node
// Prod watchdog for the discord-bot VM (docs/factory.md "Prod watchdog").
//
// Why: the bot VM takes its IP from DHCP (iface eth0 inet dhcp), and a reboot
// can land it on a NEW address — every ssh-based tool (deploy.js, verify-deploy.js,
// this watchdog) then reads the bot as DOWN while the VM is actually fine on a
// different IP. This script closes the loop:
//
//   1. probe: one ssh round-trip — `docker compose ps` states for bot/speck/glorb
//      + the SHIPPED classifier deploy-host-logs.sh (same exit-code contract as
//      the Verify stage: 0 clean, 2 degraded-but-running, 1 crash, 3/4 broken tool).
//      verdict: up | unhealthy (container down/crash) | unreachable (ssh failed —
//      host off OR DHCP drift).
//   2. drift sweep: on `unreachable`, ARP-sweep the LAN (parallel pings -> arp
//      table -> ssh `hostname` == expected) to find the VM's new IP and name it
//      in the alert.
//   3. incident: up->down edge sends a Discord DM to the owner (same identity
//      plumbing as factory ask/done pings) AND creates a "[PROD-WATCH]" card in
//      the factory Ready list — the daemon dispatches it, so the NEXT outage is
//      investigated automatically. down->up DMs recovery + comments on the
//      incident card. While down, repeats are silent (state file dedupes,
//      same philosophy as factory-done-ping).
//
// Subcommands:
//   once                    one probe cycle (launchd StartInterval target)
//   run [--interval ms]     forever loop (manual/debug; default 5m)
//   install                 launchd agent (RunAtLoad + StartInterval 300s)
//   uninstall               remove the agent
//   status                  launchd state + last cycle JSON
//
// State: data/prod-watch.json. First run seeds a SILENT baseline (no incident
// for a pre-existing outage); delete the file to re-baseline.

import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { deployConfig } from './lib/deploy-config.js';
import { sendOwnerPing } from './lib/factory-ask.js';
import * as trello from './lib/trello.js';
import { launchctl } from './lib/factory-launchd.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.discordbot.prodwatch';
const PLIST_PATH = join(process.env.HOME ?? '', 'Library/LaunchAgents', `${LABEL}.plist`);
const STATE_PATH = () => resolve(ROOT, 'data', 'prod-watch.json');
const LOG_DIR = resolve(ROOT, 'data', 'prod-watch');
const DEFAULT_INTERVAL_MS = 300_000;
const SUBNET = process.env.PROD_WATCH_SUBNET || '192.168.0';

const log = (msg) => process.stderr.write(`[prod-watch] ${msg}\n`);

// ---------- probe ----------

// One ssh round-trip: compose ps table + shipped classifier verdict. The
// classifier's own exit code is echoed INTO stdout (PROD_WATCH_CLS=n) because
// a non-zero exit would otherwise be indistinguishable from an ssh failure.
export function buildProbeCmd(dir, sinceMin = 10) {
  return (
    `cd ${dir} && docker compose ps && echo PROD_WATCH_SEP && ` +
    `bash deploy-host-logs.sh bot --since ${sinceMin}m; echo PROD_WATCH_CLS=$?`
  );
}

// Compose ps row for service S is any line whose container name ends in
// `-<S>-<n>` (discord-bot-bot-1 / -speck-1 / -glorb-1) AND does not belong to
// another service (the "bot" match must not swallow "discord-bot-glorb-1").
export function parseComposePs(stdout, services = ['bot', 'speck', 'glorb']) {
  const lines = stdout.split(/\r?\n/);
  const out = {};
  for (const svc of services) {
    const row = lines.find(
      (l) => new RegExp(`\\S*-${svc}-\\d+`).test(l) && services.every((o) => o === svc || !new RegExp(`\\S*-${o}-\\d+`).test(l)),
    );
    out[svc] = !row ? 'missing' : /\bUp\b/.test(row) ? 'up' : 'down';
  }
  return out;
}

export function parseProbe({ code, stdout = '', stderr = '' }) {
  if (code !== 0) {
    return { kind: 'unreachable', detail: `ssh exit ${code}: ${(stderr || stdout).trim().split('\n')[0] || 'no output'}` };
  }
  const sep = stdout.indexOf('PROD_WATCH_SEP');
  const psText = sep >= 0 ? stdout.slice(0, sep) : stdout;
  const clsText = sep >= 0 ? stdout.slice(sep) : '';
  const clsMatch = clsText.match(/PROD_WATCH_CLS=(\d+)/);
  const clsExit = clsMatch ? Number(clsMatch[1]) : null;
  const services = parseComposePs(psText);
  const down = Object.entries(services).filter(([, s]) => s !== 'up');
  if (down.length) {
    return {
      kind: 'unhealthy',
      detail: `containers not running: ${down.map(([n, s]) => `${n}=${s}`).join(', ')}`,
      services,
      clsExit,
    };
  }
  if (clsExit === 1) return { kind: 'unhealthy', detail: 'classifier VERDICT=crash (exit 1)', services, clsExit };
  if (clsExit !== null && clsExit !== 0 && clsExit !== 2) {
    return { kind: 'unhealthy', detail: `classifier tool broken (exit ${clsExit})`, services, clsExit };
  }
  return { kind: 'up', detail: clsExit === 2 ? 'classifier: degraded-but-running' : 'classifier clean', services, clsExit };
}

export function defaultRun(cmd, { timeoutMs = 60_000 } = {}) {
  const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout: timeoutMs });
  return { code: r.status ?? 127, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
}

export function sshProbe({ cfg, run = defaultRun }) {
  const r = run(
    `ssh -i ${cfg.key} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 ` +
      `factory@${cfg.host} ${JSON.stringify(buildProbeCmd(cfg.dir))}`,
    { timeoutMs: 90_000 },
  );
  return parseProbe(r);
}

// ---------- DHCP drift sweep ----------

// Live IPs on the LAN subnet: parallel pings then read the ARP table.
export async function sweepArp({ run = defaultRun, subnet = SUBNET } = {}) {
  run(
    `for i in $(seq 1 254); do ping -c1 -W 200 -n ${subnet}.$i >/dev/null 2>&1 & done; wait; sleep 1`,
    { timeoutMs: 60_000 },
  );
  const r = run('arp -an -n', { timeoutMs: 15_000 });
  // BSD arp prints `? (192.168.0.153) at <mac> ...` or `? (ip) at (incomplete)`;
  // only entries with a real MAC count as live.
  const ips = new Set();
  const re = new RegExp(`\\((${subnet.replace(/\./g, '\\.')}\\.[0-9]{1,3})\\) at (?!\\(incomplete\\))`, 'g');
  for (const m of (r.stdout || '').matchAll(re)) ips.add(m[1]);
  return [...ips];
}

// Try each live IP as the bot VM: BatchMode ssh `hostname` must equal the VM's
// hostname; a wrong host either refuses the key or answers a different name.
export async function sweepForHost({ cfg, run = defaultRun, subnet = SUBNET, logFn = log } = {}) {
  const ips = await sweepArp({ run, subnet });
  logFn(`sweep: ${ips.length} live IPs on ${subnet}.0/24`);
  for (const ip of ips) {
    if (ip === cfg.host) continue; // probe already covered the configured IP
    const r = run(
      `ssh -i ${cfg.key} -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=2 ` +
        `factory@${ip} 'hostname' 2>/dev/null`,
      { timeoutMs: 8_000 },
    );
    if (r.code === 0 && (r.stdout || '').trim() === cfg.expectedHost) return { ip, ips };
  }
  return { ip: null, ips };
}

// ---------- incident card + ping ----------

export function incidentTitle(kind, detail) {
  return `[PROD-WATCH] prod bot down: ${kind} — ${detail.slice(0, 90)}`;
}

export function incidentBody({ cfg, verdict, foundIp, cls }) {
  const drift =
    verdict.kind === 'unreachable'
      ? foundIp
        ? `VM RELOCATED (DHCP drift): reachable again as ${foundIp} (configured DEPLOY_HOST=${cfg.host}). Update .env DEPLOY_HOST and set a DHCP reservation for its MAC on the router.`
        : `Host unreachable at ${cfg.host} AND not found elsewhere on the LAN sweep — VM likely powered off.`
      : '';
  return [
    `Automated prod-watch incident at ${new Date().toISOString()}.`,
    ``,
    `verdict: ${verdict.kind}`,
    `detail: ${verdict.detail}`,
    verdict.services ? `services: ${JSON.stringify(verdict.services)}` : '',
    drift,
    ``,
    `Investigate: ssh -i ~/.ssh/factory_deploy_ed25519 factory@${foundIp ?? cfg.host}`,
    `cd /opt/discord-bot && docker compose ps && bash deploy-host-logs.sh bot --since 30m --verbose`,
    `docs/deploy-host.md §4 = signature table. Comment your findings on this card.`,
    `After root cause, close this card with: node scripts/factory.js prod-close <card> --layer <name> --why "…" [--fix "…"] — the answer to "which layer should have caught this" seeds the C-M11 eval set; move … Done refuses without the [PROD-CLOSE] comment.`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------- cycle state machine ----------

export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH(), 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(s) {
  mkdirSync(dirname(STATE_PATH()), { recursive: true });
  writeFileSync(STATE_PATH(), JSON.stringify(s, null, 2) + '\n');
}

const isDown = (kind) => kind === 'unreachable' || kind === 'unhealthy';

export async function runCycle({
  cfg,
  run,
  t = trello,
  board, // FM-2 (§4.3): the board-scoped Ready-list lookup targets this board; undefined = default (byte-identical)
  ping = sendOwnerPing,
  state = readState(),
  sweep = sweepForHost,
  probe = sshProbe,
  save = writeState,
  now = () => new Date().toISOString(),
} = {}) {
  const verdict = await probe({ cfg, run });
  const wasDown = state?.status && state.status !== 'up';

  if (!wasDown && state && state.status === 'up' && !isDown(verdict.kind)) {
    save({ ...state, status: 'up', lastCheck: now(), lastVerdict: verdict.kind });
    return { action: 'steady-up', verdict: verdict.kind };
  }

  if (!state) {
    // Silent baseline: record current reality without paging.
    save({
      status: isDown(verdict.kind) ? 'down' : 'up',
      incident: null,
      baseline: true,
      lastCheck: now(),
      lastVerdict: verdict.kind,
    });
    return { action: 'baseline', verdict: verdict.kind };
  }

  if (!wasDown && isDown(verdict.kind)) {
    // NEW incident.
    let foundIp = null;
    if (verdict.kind === 'unreachable') {
      ({ ip: foundIp } = await sweep({ cfg, run }));
    }
    const lists = await t.getLists({ board });
    const ready = lists.find((l) => l.name === 'Ready' && !l.closed);
    if (!ready) throw new Error('Ready list missing (run factory.js init)');
    const card = await t.createCard(incidentTitle(verdict.kind, verdict.detail), ready.id, incidentBody({ cfg, verdict, foundIp }));
    const pingText = foundIp
      ? `🔴 prod down: ${verdict.kind} — bot VM moved to ${foundIp} (was ${cfg.host}). Investigating on Trello.`
      : `🔴 prod down: ${verdict.kind} — ${verdict.detail}. Investigating on Trello.`;
    const dm = await ping({ text: pingText });
    save({
      status: 'down',
      kind: verdict.kind,
      incident: { cardId: card.id, url: card.url },
      foundIp,
      lastCheck: now(),
      lastVerdict: verdict.kind,
    });
    log(`incident opened: ${card.url} dm=${dm.sent ? 'sent' : dm.error}`);
    return { action: 'incident-opened', verdict: verdict.kind, foundIp, card: card.url, dm };
  }

  if (wasDown && !isDown(verdict.kind)) {
    // Recovery.
    const cardId = state.incident?.cardId;
    if (cardId) {
      await t.addComment(cardId, `[PRODWATCH:RECOVERED] host reachable again, services up + classifier clean — ${new Date().toISOString()}. Leave the card for root-cause closure, then close it with: node scripts/factory.js prod-close <card> --layer <name> --why "…" [--fix "…"] (which layer should have caught this — the answer seeds the C-M11 eval set).`).catch((e) => log(`comment: ${e.message}`));
    }
    const dm = await ping({ text: `✅ prod recovered: bot up on ${cfg.host}${state.foundIp ? ` (it had moved to ${state.foundIp})` : ''}.` });
    save({ status: 'up', incident: null, lastCheck: now(), lastVerdict: 'up' });
    log(`recovery pinged dm=${dm.sent ? 'sent' : dm.error}`);
    return { action: 'recovered', dm };
  }

  // Still down: dedupe (one ping + one card per incident).
  save({ ...state, lastCheck: now(), lastVerdict: verdict.kind });
  return { action: 'still-down', verdict: verdict.kind };
}

// ---------- launchd ----------

export function plistXml({ nodePath = process.execPath, intervalSec = 300 } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${join(ROOT, 'scripts', 'prod-watch.js')}</string>
    <string>once</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${intervalSec}</integer>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StandardOutPath</key><string>${join(LOG_DIR, 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(LOG_DIR, 'launchd.err.log')}</string>
</dict>
</plist>
`;
}

async function cmdInstall() {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(PLIST_PATH, plistXml());
  await launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]).catch(() => {});
  await launchctl(['bootstrap', `gui/${process.getuid()}`, PLIST_PATH]);
  console.log(JSON.stringify({ installed: true, label: LABEL, plist: PLIST_PATH, intervalSec: 300 }));
  return 0;
}

async function cmdUninstall() {
  await launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]).catch((e) => log(`bootout: ${e.message}`));
  rmSync(PLIST_PATH, { force: true });
  console.log(JSON.stringify({ installed: false, label: LABEL }));
  return 0;
}

async function cmdStatus() {
  const uid = process.getuid();
  let launchd = 'not loaded';
  try {
    launchctl && (await launchctl(['print', `gui/${uid}/${LABEL}`]));
    launchd = 'loaded';
  } catch {
    /* print exits non-zero when unloaded */
  }
  console.log(JSON.stringify({ label: LABEL, launchd, state: readState(), plist: PLIST_PATH }, null, 2));
  return 0;
}

function parseArgs(argv) {
  const out = { interval: Number(process.env.PROD_WATCH_INTERVAL_MS || DEFAULT_INTERVAL_MS) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--interval') out.interval = Number(argv[++i]) || out.interval;
  }
  return out;
}

function loadCfg() {
  const cfg = deployConfig();
  if (cfg.errors?.length) {
    process.stderr.write(`DEPLOY_HOST unset (see .env) — nothing to watch\n`);
    process.exitCode = 2;
    return null;
  }
  return {
    host: cfg.host,
    dir: cfg.dir,
    key: cfg.key, // deployConfig already tilde-expands DEPLOY_KEY
    expectedHost: process.env.PROD_WATCH_HOSTNAME || 'DiscordBot',
  };
}

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0] ?? 'once';
  const { interval } = parseArgs(argv.slice(1));
  if (cmd === 'install') return cmdInstall();
  if (cmd === 'uninstall') return cmdUninstall();
  if (cmd === 'status') return cmdStatus();
  if (cmd !== 'once' && cmd !== 'run') {
    process.stderr.write('usage: node scripts/prod-watch.js [once|run [--interval ms]|install|uninstall|status]\n');
    return 3;
  }
  const cfg = loadCfg();
  if (!cfg) return 2;
  for (;;) {
    try {
      const r = await runCycle({ cfg });
      console.log(JSON.stringify(r));
    } catch (e) {
      log(`cycle failed: ${e.message}`);
      console.log(JSON.stringify({ action: 'error', error: e.message }));
    }
    if (cmd === 'once') return 0;
    await new Promise((r) => setTimeout(r, interval));
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main();
}
