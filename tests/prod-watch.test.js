/**
 * Unit tests for scripts/prod-watch.js (docs/factory.md "Prod watchdog").
 *
 * Zero live ssh/Trello/Discord: fake run (canned ssh/arp/ssh-hostname outputs
 * keyed by command substring), fake probe verdicts, fake trello client (call
 * counters), fake ping (recorded texts), captured save sink. The only
 * process-level test is the usage error path (dies before any network call).
 * Style mirrors tests/factoryDonePing.test.js.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  buildProbeCmd,
  parseComposePs,
  parseProbe,
  sweepArp,
  sweepForHost,
  runCycle,
  incidentTitle,
  incidentBody,
  plistXml,
} from '../scripts/prod-watch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'prod-watch.js');

const cfg = { host: '192.168.0.157', dir: '/opt/discord-bot', key: '/tmp/k', expectedHost: 'DiscordBot' };

const PS_UP = `NAME                  IMAGE                     COMMAND   CREATED   STATUS    PORTS
discord-bot-bot-1     ghcr.io/x:sha-a             "node i…"   16h ago   Up 3 minutes
discord-bot-glorb-1   ghcr.io/x:sha-a             "node i…"   16h ago   Up 3 minutes
discord-bot-speck-1   ghcr.io/x:sha-a             "node i…"   16h ago   Up 3 minutes
PROD_WATCH_SEP
VERDICT=clean count=0
PROD_WATCH_CLS=0`;

// ---------- parseComposePs ----------

test('parseComposePs: all Up rows -> up', () => {
  assert.deepEqual(parseComposePs(PS_UP), { bot: 'up', speck: 'up', glorb: 'up' });
});

test('parseComposePs: exited bot row -> bot down, others up', () => {
  const out = PS_UP.replace('discord-bot-bot-1     ghcr.io/x:sha-a             "node i…"   16h ago   Up 3 minutes',
    'discord-bot-bot-1     ghcr.io/x:sha-a             "node i…"   16h ago   Exited (1) 5 minutes ago');
  assert.deepEqual(parseComposePs(out), { bot: 'down', speck: 'up', glorb: 'up' });
});

test('parseComposePs: missing row -> missing', () => {
  const out = PS_UP.replace(/^discord-bot-speck-1.*$/m, '');
  assert.equal(parseComposePs(out).speck, 'missing');
});

test('parseComposePs: glorb row is never read as bot', () => {
  // Only a glorb row exists: bot must be missing, NOT matched via "discord-bot-".
  const out = 'discord-bot-glorb-1   ghcr.io/x   "e"   1h ago   Up 2 minutes\nPROD_WATCH_SEP\n';
  const parsed = parseComposePs(out, ['bot', 'glorb']);
  assert.equal(parsed.glorb, 'up');
  assert.equal(parsed.bot, 'missing');
});

// ---------- parseProbe ----------

test('parseProbe: ssh failure -> unreachable with first stderr line', () => {
  const v = parseProbe({ code: 255, stdout: '', stderr: 'ssh: connect to host 1.2.3.4 port 22: Operation timed out\n' });
  assert.equal(v.kind, 'unreachable');
  assert.match(v.detail, /timed out/);
});

test('parseProbe: clean compose + classifier 0 -> up', () => {
  const v = parseProbe({ code: 0, stdout: PS_UP });
  assert.equal(v.kind, 'up');
  assert.equal(v.clsExit, 0);
});

test('parseProbe: classifier 2 (degraded-but-running) -> up', () => {
  const v = parseProbe({ code: 0, stdout: PS_UP.replace('PROD_WATCH_CLS=0', 'PROD_WATCH_CLS=2') });
  assert.equal(v.kind, 'up');
});

test('parseProbe: classifier 1 (crash) -> unhealthy even with containers up', () => {
  const v = parseProbe({ code: 0, stdout: PS_UP.replace('PROD_WATCH_CLS=0', 'PROD_WATCH_CLS=1') });
  assert.equal(v.kind, 'unhealthy');
  assert.match(v.detail, /crash/);
});

test('parseProbe: classifier exit 4 (tool broken) -> unhealthy', () => {
  const v = parseProbe({ code: 0, stdout: PS_UP.replace('PROD_WATCH_CLS=0', 'PROD_WATCH_CLS=4') });
  assert.equal(v.kind, 'unhealthy');
  assert.match(v.detail, /tool broken/);
});

test('parseProbe: down container wins over clean classifier', () => {
  const down = PS_UP.replace(/discord-bot-bot-1(.*?)Up 3 minutes/, 'discord-bot-bot-1$1Restarting (1) 2 seconds ago');
  const v = parseProbe({ code: 0, stdout: down });
  assert.equal(v.kind, 'unhealthy');
  assert.match(v.detail, /bot=down/);
});

// ---------- drift sweep ----------

const ARP_TABLE = `? (192.168.0.1) at 4c:ba:7d:22:21:94 on en0 ifscope [ethernet]
? (192.168.0.157) at (incomplete) on en0 ifscope [ethernet]
? (192.168.0.153) at ee:b1:86:40:9e:7d on en0 ifscope permanent [ethernet]
? (192.168.0.99) at bc:24:11:5b:77:87 on en0 ifscope [ethernet]
? (10.0.0.5) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]`;

test('sweepArp: live entries only, subnet only', async () => {
  const run = () => ({ code: 0, stdout: ARP_TABLE });
  const ips = await sweepArp({ run });
  assert.ok(ips.includes('192.168.0.1'));
  assert.ok(ips.includes('192.168.0.99'));
  assert.ok(!ips.includes('192.168.0.157'), 'incomplete ARP entry must be filtered');
  assert.ok(!ips.includes('10.0.0.5'), 'off-subnet entry must be filtered');
});

test('sweepForHost: returns new IP when hostname matches, null when absent', async () => {
  const mkRun = (sshTable) => (cmd) => {
    if (cmd.includes('seq 1 254')) return { code: 0, stdout: '' };
    if (cmd.includes('arp')) return { code: 0, stdout: ARP_TABLE };
    for (const [ip, out] of Object.entries(sshTable)) {
      if (cmd.includes(`@${ip}`)) return out;
    }
    return { code: 255, stdout: '' };
  };
  const found = await sweepForHost({ cfg, run: mkRun({ '192.168.0.99': { code: 0, stdout: 'DiscordBot\n' } }) });
  assert.equal(found.ip, '192.168.0.99');
  const gone = await sweepForHost({ cfg, run: mkRun({ '192.168.0.99': { code: 0, stdout: 'something-else\n' } }) });
  assert.equal(gone.ip, null);
});

// ---------- cycle state machine ----------

function harness({ state = undefined, verdict = { kind: 'up', detail: 'ok', services: {} }, foundIp = null } = {}) {
  const saved = [];
  const pings = [];
  const cards = [];
  const comments = [];
  let sweepCalls = 0;
  const deps = {
    cfg,
    state,
    probe: async () => verdict,
    sweep: async () => {
      sweepCalls++;
      return { ip: foundIp, ips: [] };
    },
    save: (s) => saved.push(s),
    ping: async ({ text }) => {
      pings.push(text);
      return { sent: true };
    },
    t: {
      getLists: async () => [{ id: 'ready1', name: 'Ready', closed: false }],
      createCard: async (name, list, desc) => {
        cards.push({ name, list, desc });
        return { id: 'card1', url: 'https://trello.com/c/card1/x' };
      },
      addComment: async (id, text) => {
        comments.push({ id, text });
      },
    },
    now: () => '2026-11-02T00:00:00.000Z',
  };
  return { deps, saved, pings, cards, comments, sweepCalls: () => sweepCalls };
}

test('runCycle: first run is a silent baseline (no ping, no card)', async () => {
  const h = harness({ state: null });
  const r = await runCycle(h.deps);
  assert.equal(r.action, 'baseline');
  assert.equal(h.pings.length, 0);
  assert.equal(h.cards.length, 0);
  assert.equal(h.saved[0].status, 'up');
});

test('runCycle: steady up is silent', async () => {
  const h = harness({ state: { status: 'up' } });
  const r = await runCycle(h.deps);
  assert.equal(r.action, 'steady-up');
  assert.equal(h.pings.length, 0);
  assert.equal(h.saved[0].lastCheck, '2026-11-02T00:00:00.000Z');
});

test('runCycle: up -> unhealthy opens incident (card + DM), sweep skipped', async () => {
  const h = harness({ state: { status: 'up' }, verdict: { kind: 'unhealthy', detail: 'bot=down', services: { bot: 'down' } } });
  const r = await runCycle(h.deps);
  assert.equal(r.action, 'incident-opened');
  assert.equal(h.sweepCalls(), 0, 'container-down must not LAN-sweep');
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0].list, 'ready1', 'investigation card lands in Ready for the daemon');
  assert.match(h.cards[0].name, /\[PROD-WATCH\] prod bot down: unhealthy/);
  assert.match(h.pings[0], /prod down: unhealthy/);
  assert.equal(h.saved[0].status, 'down');
  assert.equal(h.saved[0].incident.cardId, 'card1');
});

test('runCycle: up -> unreachable sweeps and names the moved IP', async () => {
  const h = harness({
    state: { status: 'up' },
    verdict: { kind: 'unreachable', detail: 'ssh exit 255: timed out' },
    foundIp: '192.168.0.99',
  });
  const r = await runCycle(h.deps);
  assert.equal(r.action, 'incident-opened');
  assert.equal(h.sweepCalls(), 1);
  assert.equal(r.foundIp, '192.168.0.99');
  assert.match(h.pings[0], /moved to 192\.168\.0\.99 \(was 192\.168\.0\.157\)/);
  assert.match(h.cards[0].desc, /VM RELOCATED \(DHCP drift\)/);
  assert.match(h.cards[0].desc, /DHCP reservation/);
});

test('runCycle: unreachable + not found says powered off', async () => {
  const h = harness({ state: { status: 'up' }, verdict: { kind: 'unreachable', detail: 'no route' }, foundIp: null });
  await runCycle(h.deps);
  assert.match(h.cards[0].desc, /VM likely powered off/);
  assert.match(h.pings[0], /prod down: unreachable/);
});

test('runCycle: still-down is deduped (no second card or DM)', async () => {
  const h = harness({
    state: { status: 'down', incident: { cardId: 'card0' }, foundIp: null },
    verdict: { kind: 'unreachable', detail: 'ssh exit 255: timed out' },
  });
  const r = await runCycle(h.deps);
  assert.equal(r.action, 'still-down');
  assert.equal(h.cards.length, 0);
  assert.equal(h.pings.length, 0);
  assert.equal(h.saved[0].lastCheck, '2026-11-02T00:00:00.000Z');
});

test('runCycle: down -> up comments the card, DMs recovery, clears incident', async () => {
  const h = harness({
    state: { status: 'down', incident: { cardId: 'card0' }, foundIp: '192.168.0.99' },
    verdict: { kind: 'up', detail: 'clean', services: {} },
  });
  const r = await runCycle(h.deps);
  assert.equal(r.action, 'recovered');
  assert.equal(h.comments[0].id, 'card0');
  assert.match(h.comments[0].text, /\[PRODWATCH:RECOVERED\]/);
  // closure pointer (card 6ae9676d2461fd41204b507e): the recovered comment
  // must tell the closer how to answer "which layer should have caught this":
  assert.match(h.comments[0].text, /prod-close/);
  assert.match(h.comments[0].text, /--layer/);
  assert.match(h.comments[0].text, /Leave the card for root-cause closure/);
  assert.match(h.pings[0], /prod recovered.*it had moved to 192\.168\.0\.99/);
  assert.equal(h.saved[0].status, 'up');
  assert.equal(h.saved[0].incident, null);
});

// ---------- misc units ----------

test('buildProbeCmd: compose ps + shipped classifier + echoed exit code', () => {
  const cmd = buildProbeCmd('/opt/discord-bot', 10);
  assert.match(cmd, /cd \/opt\/discord-bot && docker compose ps/);
  assert.match(cmd, /bash deploy-host-logs\.sh bot --since 10m/);
  assert.match(cmd, /echo PROD_WATCH_CLS=\$\?/);
});

test('incidentTitle: bracket tag + kind + bounded detail', () => {
  const t = incidentTitle('unreachable', 'x'.repeat(200));
  assert.ok(t.startsWith('[PROD-WATCH] prod bot down: unreachable — '));
  assert.ok(t.length <= '[PROD-WATCH] prod bot down: unreachable — '.length + 90);
});

// closure pointer (card 6ae9676d2461fd41204b507e): the incident body footer
// must carry the prod-close protocol so the which-layer answer lands before
// the Done move (the gate refuses without it).
test('incidentBody: footer carries the prod-close closure pointer', () => {
  const body = incidentBody({
    cfg,
    verdict: { kind: 'unreachable', detail: 'ssh exit 255: timed out' },
    foundIp: null,
  });
  assert.match(body, /prod-close/);
  assert.match(body, /--layer/);
  assert.match(body, /which layer should have caught this/i);
  assert.match(body, /C-M11/);
});

test('plistXml: launches `once` every 300s under the prodwatch label', () => {
  const xml = plistXml({ nodePath: '/usr/local/bin/node' });
  assert.match(xml, /<key>Label<\/key><string>com\.discordbot\.prodwatch<\/string>/);
  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(xml, /prod-watch\.js<\/string>\s*<string>once<\/string>/s);
  assert.match(xml, /<key>StartInterval<\/key><integer>300<\/integer>/);
});

test('CLI: unknown subcommand exits 3 with usage, no network', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'frobnicate'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /usage: node scripts\/prod-watch\.js/);
});
