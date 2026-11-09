/**
 * Unit tests for scripts/verify-factory.js — the FM-4 `self` driver's health
 * check. No live daemon: the process seam (`run` — launchctl/systemctl/
 * journalctl), the log reader, and BOTH clocks (wall `now` + monotone `mono`
 * behind the fake sleep) are injected, so the wait loop, marker freshness,
 * and the JSON-only output contract are all exercised in-process.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  verifyDeploy,
  pollLineAfter,
  daemonLogPath,
  unitActiveDarwin,
  unitActiveLinux,
  BOOT_MARKER,
  POLL_MARKER,
} from '../scripts/verify-factory.js';

const FULL = 'abcdef1234567890abcdef1234567890abcdef12';
const RESTART_AT = '2026-11-08T15:00:00.000Z';
const TARGET = { ok: true, repo: { name: 'factory' }, clone: '/home/me/GitHub/factory', branch: 'master' };
const HISTORY = [{ ts: RESTART_AT, sha: FULL, short: 'abcdef1', action: 'deploy', restart: 'launchd-guard pid 1' }];

const stamped = (iso, s) => `${iso}Z ${s}`;
const bootLine = (iso = '2026-11-08T15:00:05') => stamped(iso, 'watching "Ready" on 1 board(s) (LLNG5MAm) every 15000ms, cap 1, agent "omp"');
const pollLine = (iso = '2026-11-08T15:00:06') => stamped(iso, `[poll] board LLNG5MAm ${POLL_MARKER}`);

const activeRun = (active) => ({ run: () => ({ code: active ? 0 : 3, stdout: active ? '' : 'inactive\n', stderr: '' }) });

// --- marker scanning -------------------------------------------------------------

test('markers are the exact daemon log lines', () => {
  assert.equal(BOOT_MARKER, 'watching "Ready"');
  assert.ok(pollLineAfter(`${bootLine()}\n${pollLine()}\n`, '2026-11-08T14:59:00.000Z').line);
});

test('pollLineAfter: boot + poll both after the restart → PASS line', () => {
  const res = pollLineAfter(
    [`old ${bootLine('2026-11-08T14:00:00')} noise-before`, bootLine(), pollLine()].join('\n'),
    RESTART_AT,
  );
  assert.match(res.line, /poll ok/);
});

test('pollLineAfter: pre-restart boot + poll can never satisfy the proof', () => {
  const res = pollLineAfter(`${bootLine('2026-11-08T14:00:00')}\n${pollLine('2026-11-08T14:00:01')}\n`, RESTART_AT);
  assert.equal(res.line, undefined);
  assert.match(res.reason, /no boot marker after the restart/);
});

test('pollLineAfter: post-restart boot without a poll line is a named wait reason', () => {
  const res = pollLineAfter(`${bootLine()}\n`, RESTART_AT);
  assert.equal(res.line, undefined);
  assert.match(res.reason, /poll-ok not logged yet/);
});

test('pollLineAfter: boot after restart, then OLD-then-NEW poll stamps — only post-boot line counts', () => {
  const text = [bootLine('2026-11-08T14:30:00'), pollLine('2026-11-08T14:30:01'), bootLine(), pollLine()].join('\n');
  const res = pollLineAfter(text, RESTART_AT);
  assert.match(res.line, /15:00:06/);
});

// --- unit-active seams -------------------------------------------------------------

test('unitActiveDarwin: launchctl print success = active; failure names the label', () => {
  const ok = unitActiveDarwin({ uid: 501, label: 'com.x', ...activeRun(true) });
  assert.deepEqual(ok, { active: true, detail: '' });
  const no = unitActiveDarwin({
    uid: 501,
    label: 'com.x',
    run: (spec) => {
      assert.deepEqual(spec.args, ['launchctl', 'print', 'gui/501/com.x']);
      return { code: 113, stdout: '', stderr: 'Could not find service' };
    },
  });
  assert.equal(no.active, false);
  assert.match(no.detail, /launchctl print com\.x exited 113/);
});

test('unitActiveLinux: is-active argv + stdout surfaces the unit state', () => {
  const no = unitActiveLinux({
    run: (spec) => {
      assert.deepEqual(spec.args, ['systemctl', '--user', 'is-active', 'factory-daemon.service']);
      return { code: 3, stdout: 'inactive\n', stderr: '' };
    },
  });
  assert.equal(no.active, false);
  assert.match(no.detail, /inactive/);
});

test('daemonLogPath parses StandardOutPath from the plist, null when absent/unreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-factory-plist-'));
  try {
    const p = join(dir, 'job.plist');
    writeFileSync(p, '<plist><dict><key>StandardOutPath</key><string>/tmp/factory/logs/launchd.out.log</string></dict></plist>');
    assert.equal(daemonLogPath({ plist: p }), '/tmp/factory/logs/launchd.out.log');
    writeFileSync(p, '<plist><dict><key>Label</key><string>x</string></dict></plist>');
    assert.equal(daemonLogPath({ plist: p }), null);
    assert.equal(daemonLogPath({ plist: join(dir, 'nope.plist') }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the verify wait loop -------------------------------------------------------------

function fakeClock() {
  let t = 0;
  return {
    mono: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => new Date(1762600000000 + t),
  };
}

test('PASS: unit active + boot + poll after restart (first iteration)', async () => {
  const c = fakeClock();
  const res = await verifyDeploy({
    target: TARGET,
    platform: 'darwin',
    history: HISTORY,
    ...activeRun(true),
    readLog: () => `${bootLine()}\n${pollLine()}\n`,
    now: c.now,
    mono: c.mono,
    sleep: c.sleep,
    timeoutMs: 20000,
    intervalMs: 1000,
  });
  assert.equal(res.verdict, 'PASS');
  assert.equal(res.code, 0);
  assert.equal(res.verdictJson.restartAt, RESTART_AT);
  assert.equal(res.verdictJson.sha, FULL);
  assert.match(res.verdictJson.pollLine, /poll ok/);
});

test('Waits for the restart: not-active first, active+markers on the second check', async () => {
  const c = fakeClock();
  let checks = 0;
  const res = await verifyDeploy({
    target: TARGET,
    platform: 'darwin',
    history: HISTORY,
    run: () => {
      checks++;
      return { code: checks >= 2 ? 0 : 113, stdout: '', stderr: '' };
    },
    readLog: () => (checks >= 2 ? `${bootLine()}\n${pollLine()}\n` : ''),
    now: c.now,
    mono: c.mono,
    sleep: c.sleep,
    timeoutMs: 20000,
    intervalMs: 1000,
  });
  assert.equal(res.verdict, 'PASS');
  assert.equal(checks, 2);
});

test('FAIL after timeout names the wait and the missing marker', async () => {
  const c = fakeClock();
  const res = await verifyDeploy({
    target: TARGET,
    platform: 'darwin',
    history: HISTORY,
    ...activeRun(true),
    readLog: () => bootLine(), // restart never completed a poll
    now: c.now,
    mono: c.mono,
    sleep: c.sleep,
    timeoutMs: 5000,
    intervalMs: 1000,
  });
  assert.equal(res.verdict, 'FAIL');
  assert.equal(res.code, 1);
  assert.match(res.verdictJson.reason, /waited 5s/);
  assert.match(res.verdictJson.reason, /poll-ok not logged yet/);
});

test('unit not active → FAIL without reading the log', async () => {
  const c = fakeClock();
  let logReads = 0;
  const res = await verifyDeploy({
    target: TARGET,
    platform: 'darwin',
    history: HISTORY,
    ...activeRun(false),
    readLog: () => {
      logReads++;
      return '';
    },
    now: c.now,
    mono: c.mono,
    sleep: c.sleep,
    timeoutMs: 3000,
    intervalMs: 1000,
  });
  assert.equal(res.verdict, 'FAIL');
  assert.match(res.verdictJson.reason, /launchctl print .* exited 3/);
  assert.equal(logReads, 0);
});

test('no deploy history → FAIL telling the operator to deploy first', async () => {
  const c = fakeClock();
  const res = await verifyDeploy({
    target: TARGET,
    platform: 'darwin',
    history: [],
    ...activeRun(true),
    readLog: () => '',
    now: c.now,
    mono: c.mono,
    sleep: c.sleep,
    timeoutMs: 1000,
    intervalMs: 1000,
  });
  assert.match(res.verdictJson.reason, /no deploy history/);
});

test('unresolved target (driver mismatch) → FAIL with the registry error', async () => {
  const res = await verifyDeploy({
    target: { ok: false, error: 'repo discord-bot deploy driver is "docker-ssh"' },
    platform: 'darwin',
    history: HISTORY,
    now: () => new Date(),
    mono: () => 0,
    sleep: async () => {},
  });
  assert.equal(res.verdict, 'FAIL');
  assert.match(res.verdictJson.reason, /docker-ssh/);
  assert.equal(res.verdictJson.clone, undefined);
});

test('linux branch reads journal since the restart (argv assertion)', async () => {
  const c = fakeClock();
  const seen = [];
  const res = await verifyDeploy({
    target: TARGET,
    platform: 'linux',
    history: HISTORY,
    run: (spec) => {
      seen.push(spec.args);
      if (spec.args[0] === 'systemctl') return { code: 0, stdout: 'active\n', stderr: '' };
      return { code: 0, stdout: `${bootLine()}\n${pollLine()}\n`, stderr: '' };
    },
    now: c.now,
    mono: c.mono,
    sleep: c.sleep,
    timeoutMs: 5000,
    intervalMs: 1000,
  });
  assert.equal(res.verdict, 'PASS');
  assert.deepEqual(res.verdictJson.unit, 'factory-daemon.service');
  const j = seen.find((a) => a[0] === 'journalctl');
  assert.deepEqual(j, ['journalctl', '-u', 'factory-daemon.service', `--since=${RESTART_AT}`, '--no-pager', '-n', '500']);
});

test('rollback entries verify exactly like deploys (last entry decides)', async () => {
  const c = fakeClock();
  const rb = [...HISTORY, { ts: '2026-11-08T16:00:00.000Z', sha: FULL, short: 'abcdef1', action: 'rollback' }];
  const res = await verifyDeploy({
    target: TARGET,
    platform: 'darwin',
    history: rb,
    ...activeRun(true),
    readLog: () => `${bootLine('2026-11-08T16:00:05')}\n${pollLine('2026-11-08T16:00:06')}\n`,
    now: c.now,
    mono: c.mono,
    sleep: c.sleep,
    timeoutMs: 5000,
    intervalMs: 1000,
  });
  assert.equal(res.verdict, 'PASS');
  assert.equal(res.verdictJson.restartAt, '2026-11-08T16:00:00.000Z');
  assert.equal(res.verdictJson.action, 'rollback');
});
