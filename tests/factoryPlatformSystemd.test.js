/**
 * Unit tests for scripts/lib/factory-platform-systemd.js (FM-5, card
 * 6aee5f4d6e98279cb3ab3304; docs/factory-migration.md §4.6, §6.1, D7).
 *
 * No Linux box on the gate host: this suite IS the FM-5 acceptance for the
 * systemd branch — unit-render assertions (every §4.6 contract pinned
 * verbatim) + injected-runner lifecycle sequences (install/status/
 * uninstall call shapes + the D7 self-restart arm). The live-box hands
 * (units enabled+active; one manual pass per timer) land at FM-6.
 *
 * Run: node --test tests/factoryPlatformSystemd.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as sys from '../scripts/lib/factory-platform-systemd.js'

// ---------- harness ----------

function mkScratch () {
  const dir = mkdtempSync(join(tmpdir(), 'fm5-systemd-'))
  const root = join(dir, 'repo')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'data'), { recursive: true })
  const unitDir = join(dir, 'unitdir')
  const envFile = join(root, 'data', 'factory-env.conf')
  return { dir, root, unitDir, envFile }
}

function writeRepoEnv (root, text) {
  writeFileSync(join(root, '.env'), text)
}

/** Scripted systemctl runner: `active` toggles is-active; records argv. */
function mkRun ({ active = false, failProbe = false, failReload = false, calls = [] } = {}) {
  return function run ({ args }) {
    calls.push(args)
    const joined = args.join(' ')
    if (joined.includes('is-system-running')) {
      return failProbe ? { code: 1, stdout: '', stderr: 'Failed to connect to bus: No such file or directory' } : { code: 0, stdout: 'running\n', stderr: '' }
    }
    if (joined.includes('is-active')) {
      return active ? { code: 0, stdout: 'active\n', stderr: '' } : { code: 3, stdout: 'inactive\n', stderr: '' }
    }
    if (joined.includes('daemon-reload')) {
      return failReload ? { code: 1, stdout: '', stderr: 'Reload failed.' } : { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

function mkSystemdRun (calls = []) {
  return function systemdRun ({ args }) {
    calls.push(['systemd-run', ...args])
    return { code: 0, stdout: 'Running as unit: fm5-arm.service\n', stderr: '' }
  }
}

const NODE = '/home/factory/.local/node/bin/node'
const HOME = '/home/factory'

// ---------- unit rendering (§4.6 contracts, verbatim) ----------

test('1. daemon unit carries the §4.6 contract + baked PATH with ~/.local/node/bin', () => {
  const s = mkScratch()
  const unit = sys.serviceUnit({
    name: sys.UNITS.daemon.service,
    description: 'factory dispatcher',
    type: 'simple',
    exec: `${NODE} ${join(s.root, 'scripts/factory-daemon.js')} run`,
    envLines: sys.envLines({ nodePath: NODE, home: HOME, envFile: s.envFile }),
    restart: 'always',
    restartSec: 30,
    workingDirectory: '/opt/factory',
  })
  assert.match(unit, /^\[Unit\]/m)
  assert.match(unit, /^Type=simple$/m)
  assert.match(unit, /^Restart=always$/m)
  assert.match(unit, /^RestartSec=30$/m)
  assert.match(unit, /^WorkingDirectory=\/opt\/factory$/m)
  assert.match(unit, new RegExp(`^ExecStart=${NODE.replace(/\./g, '\\.')} .+/scripts/factory-daemon\\.js run$`, 'm'))
  assert.match(unit, /^Environment=PATH=\/home\/factory\/\.local\/node\/bin:\/home\/factory\/\.local\/node\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m)
  assert.match(unit, new RegExp(`^EnvironmentFile=${s.envFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  assert.match(unit, /^WantedBy=default\.target$/m)
})

test('2. unitPath bakes ~/.local/node/bin + the node dir + system dirs', () => {
  const p = sys.unitPath({ nodePath: '/usr/local/bin/node', home: HOME })
  const parts = p.split(':')
  assert.equal(parts[0], '/usr/local/bin')
  assert.ok(parts.includes(join(HOME, '.local', 'node', 'bin')))
  for (const d of ['/usr/local/bin', '/usr/bin', '/bin']) assert.ok(parts.includes(d))
})

test('3. metrics timer = 6 h interval pair (launchd StartInterval parity)', () => {
  const svc = sys.serviceUnit({ name: 'factory-metrics.service', description: 'm', type: 'oneshot', exec: 'x once', envLines: [] })
  assert.match(svc, /^Type=oneshot$/m)
  assert.ok(!svc.includes('[Install]')) // timer-pulled oneshot: no WantedBy
  const t = sys.timerUnit({ name: 'factory-metrics.timer', description: 'm', onUnitActiveSec: sys.METRICS_INTERVAL_SEC })
  assert.equal(sys.METRICS_INTERVAL_SEC, 21600)
  assert.match(t, /^OnBootSec=21600s$/m)
  assert.match(t, /^OnUnitActiveSec=21600s$/m)
  assert.match(t, /^Persistent=true$/m)
  assert.match(t, /^WantedBy=timers\.target$/m)
})

test('4. sweep timer = daily 03:15 calendar (launchd StartCalendarInterval parity) + overrides', () => {
  assert.equal(sys.sweepCalendar(), '*-*-* 03:15:00')
  assert.equal(sys.sweepCalendar({ hour: 4, minute: 5 }), '*-*-* 04:05:00')
  const t = sys.timerUnit({ name: 'factory-sweep.timer', description: 's', onCalendar: sys.sweepCalendar() })
  assert.match(t, new RegExp('^OnCalendar=\\*-\\*-\\* 03:15:00$', 'm'))
  assert.match(t, /^Persistent=true$/m)
})

test('5. prod-watch timer = 300 s interval', () => {
  const t = sys.timerUnit({ name: 'prod-watch.timer', description: 'p', onUnitActiveSec: sys.PROD_WATCH_INTERVAL_SEC })
  assert.equal(sys.PROD_WATCH_INTERVAL_SEC, 300)
  assert.match(t, /^OnBootSec=300s$/m)
  assert.match(t, /^OnUnitActiveSec=300s$/m)
})

test('6. timerUnit fail-closed without a schedule', () => {
  assert.throws(() => sys.timerUnit({ name: 'x.timer', description: '' }), /needs onUnitActiveSec or onCalendar/)
})

// ---------- env baking ----------

test('7. normalizeEnv: systemd syntax — export stripped, quotes unwrapped, comments dropped', () => {
  const out = sys.normalizeEnv([
    '# comment',
    '',
    'export TRELLO_KEY=abc123',
    'DEPLOY_KEY="~/.ssh/factory_deploy_ed25519"',
    "FACTORY_MODEL='gpt-4o'",
    'BROKEN line without equals',
    'BOT_TOKEN=tok en',
  ].join('\n'))
  assert.equal(out, 'TRELLO_KEY=abc123\nDEPLOY_KEY=~/.ssh/factory_deploy_ed25519\nFACTORY_MODEL=gpt-4o\nBOT_TOKEN=tok en\n')
})

test('8. bakeEnvFile writes 0600 with normalized keys; missing .env = empty 0600 file', () => {
  const s = mkScratch()
  writeRepoEnv(s.root, 'export TRELLO_KEY=k1\nTRELLO_TOKEN="t1"\n# c\n')
  const r = sys.bakeEnvFile({ root: s.root, target: s.envFile })
  assert.equal(readFileSync(s.envFile, 'utf8'), 'TRELLO_KEY=k1\nTRELLO_TOKEN=t1\n')
  assert.equal(statSync(s.envFile).mode & 0o777, 0o600)
  assert.equal(r.keys, 2)
  const s2 = mkScratch()
  const r2 = sys.bakeEnvFile({ root: s2.root, target: s2.envFile })
  assert.equal(readFileSync(s2.envFile, 'utf8'), '')
  assert.equal(statSync(s2.envFile).mode & 0o777, 0o600)
  assert.equal(r2.keys, 0)
})

// ---------- install sequences (injected runners — the dry-run proof) ----------

test('9. installDaemon first install: probe → render → reload → enable → start', () => {
  const s = mkScratch()
  writeRepoEnv(s.root, 'TRELLO_KEY=k\n')
  const calls = []
  const sCalls = []
  const r = sys.installDaemon({
    nodePath: NODE, root: s.root, home: HOME, unitDir: s.unitDir, envFile: s.envFile,
    run: mkRun({ active: false, calls }), systemdRun: mkSystemdRun(sCalls),
  })
  assert.equal(r.installed, true)
  assert.equal(r.unit, 'factory-daemon.service') // the name deploy-factory.js + verify-factory.js pin
  assert.equal(r.start, 'started')
  assert.ok(existsSync(join(s.unitDir, 'factory-daemon.service')))
  const unit = readFileSync(join(s.unitDir, 'factory-daemon.service'), 'utf8')
  assert.match(unit, /^Restart=always$/m)
  assert.match(unit, /^RestartSec=30$/m)
  assert.match(unit, new RegExp(`^WorkingDirectory=${s.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  assert.match(unit, new RegExp(`^Environment=PATH=.*${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\.local\\/node\\/bin`, 'm'))
  assert.equal(readFileSync(s.envFile, 'utf8'), 'TRELLO_KEY=k\n')
  assert.equal(statSync(s.envFile).mode & 0o777, 0o600)
  const joined = calls.map(a => a.join(' '))
  assert.deepEqual(joined.slice(1), [
    'systemctl --user daemon-reload',
    'systemctl --user enable factory-daemon.service',
    'systemctl --user is-active factory-daemon.service',
    'systemctl --user start factory-daemon.service',
  ])
  assert.deepEqual(sCalls, []) // not active → no arm
})

test('10. installDaemon re-install while ACTIVE arms the restart via systemd-run (D7 self-restart race)', () => {
  const s = mkScratch()
  writeRepoEnv(s.root, 'TRELLO_KEY=k\n')
  const calls = []
  const sCalls = []
  const r = sys.installDaemon({
    nodePath: NODE, root: s.root, home: HOME, unitDir: s.unitDir, envFile: s.envFile,
    run: mkRun({ active: true, calls }), systemdRun: mkSystemdRun(sCalls),
  })
  assert.match(r.start, /restart armed via systemd-run/)
  assert.match(r.start, /child of the daemon/)
  assert.deepEqual(sCalls, [['systemd-run', '--user', '--on-active=2s', 'systemctl', '--user', 'restart', 'factory-daemon.service']])
  const joined = calls.map(a => a.join(' '))
  assert.ok(!joined.some(c => /^systemctl --user (restart|start) /.test(c))) // never inline
})

test('11. installSatellite writes service+timer, enables the TIMER; runAtLoad mirrors launchd', () => {
  const s = mkScratch()
  writeRepoEnv(s.root, 'TRELLO_KEY=k\n')
  const calls = []
  const r = sys.installMetrics({ nodePath: NODE, root: s.root, home: HOME, unitDir: s.unitDir, envFile: s.envFile, run: mkRun({ calls }) })
  assert.equal(r.installed, true)
  assert.deepEqual(r.units, ['factory-metrics.timer', 'factory-metrics.service'])
  const svc = readFileSync(join(s.unitDir, 'factory-metrics.service'), 'utf8')
  const timer = readFileSync(join(s.unitDir, 'factory-metrics.timer'), 'utf8')
  assert.match(svc, /^Type=oneshot$/m)
  assert.match(svc, new RegExp(`^ExecStart=.*factory-metrics\\.js once$`, 'm'))
  assert.match(timer, /^OnUnitActiveSec=21600s$/m)
  const joined = calls.map(a => a.join(' '))
  assert.ok(joined.includes('systemctl --user enable --now factory-metrics.timer'))
  assert.ok(joined.includes('systemctl --user start factory-metrics.service')) // RunAtLoad parity
})

test('12. installProdWatch = 300 s pair + RunAtLoad; installSweep = 03:15 calendar, no RunAtLoad', () => {
  const s = mkScratch()
  const pwCalls = []
  sys.installProdWatch({ nodePath: NODE, root: s.root, home: HOME, unitDir: s.unitDir, envFile: s.envFile, run: mkRun({ calls: pwCalls }) })
  assert.match(readFileSync(join(s.unitDir, 'prod-watch.timer'), 'utf8'), /^OnUnitActiveSec=300s$/m)
  assert.match(readFileSync(join(s.unitDir, 'prod-watch.service'), 'utf8'), /prod-watch\.js once/)
  assert.ok(pwCalls.map(a => a.join(' ')).includes('systemctl --user start prod-watch.service'))
  const swCalls = []
  sys.installSweep({ nodePath: NODE, root: s.root, home: HOME, unitDir: s.unitDir, envFile: s.envFile, run: mkRun({ calls: swCalls }) })
  assert.match(readFileSync(join(s.unitDir, 'factory-sweep.timer'), 'utf8'), /^OnCalendar=\*-\*-\* 03:15:00$/m)
  assert.ok(!swCalls.map(a => a.join(' ')).some(c => c.includes('start factory-sweep.service'))) // calendar-only
})

test('13. installSweep honors --hour/--minute overrides into OnCalendar', () => {
  const s = mkScratch()
  sys.installSweep({ hour: 4, minute: 5, nodePath: NODE, root: s.root, home: HOME, unitDir: s.unitDir, envFile: s.envFile, run: mkRun({}) })
  assert.match(readFileSync(join(s.unitDir, 'factory-sweep.timer'), 'utf8'), /^OnCalendar=\*-\*-\* 04:05:00$/m)
})

test('14. host-fail-closed: broken user bus throws BEFORE any unit file is written', () => {
  const s = mkScratch()
  assert.throws(() => sys.installDaemon({ root: s.root, unitDir: s.unitDir, envFile: s.envFile, run: mkRun({ failProbe: true }) }), /systemd user session unavailable/)
  assert.ok(!existsSync(join(s.unitDir, 'factory-daemon.service')))
  assert.throws(() => sys.installMetrics({ root: s.root, unitDir: s.unitDir, envFile: s.envFile, run: mkRun({ failProbe: true }) }), /loginctl enable-linger/)
  assert.throws(() => sys.uninstallDaemon({ root: s.root, unitDir: s.unitDir, run: mkRun({ failProbe: true }) }), /systemd user session unavailable/)
})

test('15. daemon-reload failure aborts install loudly (no half-installed enable)', () => {
  const s = mkScratch()
  assert.throws(() => sys.installDaemon({ root: s.root, unitDir: s.unitDir, envFile: s.envFile, run: mkRun({ failReload: true }) }), /daemon-reload failed/)
})

// ---------- status ----------

test('16. statusUnits: missing files report not-installed without touching systemctl', () => {
  const s = mkScratch()
  const calls = []
  const st = sys.statusUnits({ units: ['factory-daemon.service'], unitDir: s.unitDir, run: mkRun({ calls }) })
  assert.deepEqual(st.units['factory-daemon.service'], { installed: false })
  assert.equal(calls.length, 0) // status never shells out when no unit file exists
})

test('17. statusUnits parses multi-unit `show` blocks; daemonStatus keys the daemon unit', () => {
  const s = mkScratch()
  mkdirSync(s.unitDir, { recursive: true })
  writeFileSync(join(s.unitDir, 'factory-daemon.service'), '[Service]')
  const out = [
    'Id=factory-daemon.service',
    'ActiveState=active',
    'SubState=running',
    'UnitFileState=enabled',
    'ExecMainPID=4242',
  ].join('\n') + '\n'
  const st = sys.daemonStatus({ unitDir: s.unitDir, run: () => ({ code: 0, stdout: out, stderr: '' }) })
  assert.deepEqual(st.units['factory-daemon.service'], {
    installed: true, active: 'active', subState: 'running', enabled: 'enabled', pid: '4242',
  })
})

// ---------- uninstall ----------

test('18. uninstallDaemon: disable --now first, files removed, env file removed, reload last', () => {
  const s = mkScratch()
  mkdirSync(s.unitDir, { recursive: true })
  writeFileSync(join(s.unitDir, 'factory-daemon.service'), 'x')
  writeFileSync(s.envFile, 'secret')
  const calls = []
  const r = sys.uninstallDaemon({ root: s.root, unitDir: s.unitDir, run: mkRun({ calls }) })
  assert.equal(r.uninstalled, true)
  assert.ok(!existsSync(join(s.unitDir, 'factory-daemon.service')))
  assert.ok(!existsSync(s.envFile))
  const joined = calls.map(a => a.join(' '))
  assert.deepEqual(joined.slice(1), [
    'systemctl --user disable --now factory-daemon.service',
    'systemctl --user daemon-reload',
  ])
})

test('19. satellite uninstall leaves the shared env file in place', () => {
  const s = mkScratch()
  mkdirSync(s.unitDir, { recursive: true })
  writeFileSync(join(s.unitDir, 'factory-metrics.timer'), 'x')
  writeFileSync(join(s.unitDir, 'factory-metrics.service'), 'x')
  writeFileSync(s.envFile, 'secret')
  sys.uninstallUnits({ root: s.root, unitDir: s.unitDir, envFile: s.envFile, units: ['factory-metrics.timer', 'factory-metrics.service'], run: mkRun({}) })
  assert.ok(!existsSync(join(s.unitDir, 'factory-metrics.timer')))
  assert.ok(existsSync(s.envFile))
})

test('20. install is byte-stable idempotent (re-install rewrites identical unit bytes)', () => {
  const s = mkScratch()
  writeRepoEnv(s.root, 'TRELLO_KEY=k\n')
  const a = sys.installDaemon({ nodePath: NODE, root: s.root, home: HOME, unitDir: s.unitDir, envFile: s.envFile, run: mkRun({}) })
  const bytes = readFileSync(a.unitFile)
  const b = sys.installDaemon({ nodePath: NODE, root: s.root, home: HOME, unitDir: s.unitDir, envFile: s.envFile, run: mkRun({}) })
  assert.equal(readFileSync(b.unitFile, 'utf8'), bytes.toString())
  rmSync(s.dir, { recursive: true, force: true })
})
