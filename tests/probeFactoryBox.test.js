/**
 * Unit tests for scripts/probe-factory-box.js (FM-5, card
 * 6aee5f4d6e98279cb3ab3304; docs/factory-migration.md §4.6, §6.1 step 4).
 *
 * The from-box prod-watch preflight must run EXACTLY the ssh transport
 * prod-watch.js runs (same flags, same probe command, same verdict parser),
 * exit 0/1/2 by verdict class (config errors loud, zero remote calls), and
 * write nothing to the board/state — safe as the FM-6 cutover preflight.
 *
 * Run: node --test tests/probeFactoryBox.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { probeCfg, runProbeBox, parseProbe } from '../scripts/probe-factory-box.js'
import { buildProbeCmd } from '../scripts/prod-watch.js'

const KEY = '/home/factory/.ssh/factory_deploy_ed25519'
// DEPLOY_HOST='' (explicit empty) beats the gate host's repo .env inside
// deployConfig's `env[name] ?? fileEnv[name]` — deterministic unset.
const ENV = { DEPLOY_HOST: 'box.example', DEPLOY_KEY: KEY, DEPLOY_DIR: '/opt/discord-bot' }
const NO_HOST = { DEPLOY_HOST: '', DEPLOY_KEY: KEY, DEPLOY_DIR: '/opt/discord-bot' }

const UP_TABLE =
  'NAME                STATUS\ndiscord-bot-bot-1   Up 3 hours\ndiscord-bot-speck-1 Up 3 hours\ndiscord-bot-glorb-1 Up 3 hours\n'

function mkRun (result, calls = []) {
  return function run (cmd, opts = {}) {
    calls.push({ cmd, opts })
    return result
  }
}

test('1. exact prod-watch transport: same ssh flags, probe command, timeout', () => {
  const calls = []
  const r = runProbeBox({ env: ENV, exists: () => true, run: mkRun({ code: 0, stdout: `${UP_TABLE}PROD_WATCH_SEP\nVERDICT=clean\nPROD_WATCH_CLS=0\n`, stderr: '' }, calls) })
  assert.equal(calls.length, 1)
  const { cmd, opts } = calls[0]
  assert.ok(cmd.startsWith(`ssh -i ${KEY} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 factory@box.example `), cmd)
  assert.ok(cmd.includes(JSON.stringify(buildProbeCmd('/opt/discord-bot'))), cmd)
  assert.equal(opts.timeoutMs, 90_000)
  assert.equal(r.ok, true)
  assert.equal(r.exitCode, 0)
  assert.equal(r.selfProbe, true) // §4.6: on the box DEPLOY_HOST is the box itself
})

test('2. clean and degraded-but-running verdicts both exit 0', () => {
  const ok = runProbeBox({ env: ENV, exists: () => true, run: mkRun({ code: 0, stdout: `${UP_TABLE}PROD_WATCH_SEP\nVERDICT=clean\nPROD_WATCH_CLS=0\n`, stderr: '' }) })
  assert.equal(ok.exitCode, 0)
  assert.equal(ok.probe.kind, 'up')
  const degraded = runProbeBox({ env: ENV, exists: () => true, run: mkRun({ code: 0, stdout: `${UP_TABLE}PROD_WATCH_SEP\nVERDICT=degraded\nPROD_WATCH_CLS=2\n`, stderr: '' }) })
  assert.equal(degraded.exitCode, 0)
  assert.equal(degraded.ok, true)
  assert.equal(degraded.probe.clsExit, 2)
})

test('3. containers down / classifier crash → unhealthy → exit 1', () => {
  const down = runProbeBox({ env: ENV, exists: () => true, run: mkRun({ code: 0, stdout: 'NAME STATUS\ndiscord-bot-bot-1 Up 3 hours\ndiscord-bot-speck-1 Restarting (1) 5 seconds ago\ndiscord-bot-glorb-1 Up 3 hours\nPROD_WATCH_SEP\nPROD_WATCH_CLS=2\n', stderr: '' }) })
  assert.equal(down.ok, false)
  assert.equal(down.exitCode, 1)
  assert.equal(down.probe.kind, 'unhealthy')
  assert.match(down.probe.detail, /speck=/)
})

test('4. ssh transport failure → unreachable → exit 1', () => {
  const r = runProbeBox({ env: ENV, exists: () => true, run: mkRun({ code: 255, stdout: '', stderr: 'ssh: connect to host box.example port 22: Connection timed out' }) })
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, 1)
  assert.equal(r.probe.kind, 'unreachable')
})

test('5. DEPLOY_HOST unset → exit 2, probe:null, ZERO remote calls', () => {
  const run = () => assert.fail('config error must not touch the network')
  const r = runProbeBox({ env: NO_HOST, exists: () => true, run })
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, 2)
  assert.equal(r.probe, null)
  assert.match(r.errors.join('\n'), /DEPLOY_HOST unset/)
})

test('6. missing identity file is named with the §6.1 step-4 remedy (exit 2, no ssh)', () => {
  const r = runProbeBox({ env: ENV, exists: () => false, run: () => assert.fail('missing key must not ssh') })
  assert.equal(r.exitCode, 2)
  assert.match(r.errors.join('\n'), new RegExp(`DEPLOY_KEY identity file missing \\(${KEY.replace(/\./g, '\\.')}\\)`))
  assert.match(r.errors.join('\n'), /§6\.1 step 4/)
})

test('7. parseProbe is prod-watch\'s parser, not a re-implementation', () => {
  assert.equal(parseProbe({ code: 0, stdout: `${UP_TABLE}PROD_WATCH_SEP\nPROD_WATCH_CLS=0\n` }).kind, 'up')
  assert.equal(parseProbe({ code: 1 }).kind, 'unreachable')
})
