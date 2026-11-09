/**
 * Unit tests for scripts/lib/factory-platform.js (FM-5, card
 * 6aee5f4d6e98279cb3ab3304; docs/factory-migration.md D7).
 *
 * The dispatch must keep darwin on the launchd path with ZERO probing
 * (the laptop dispatcher cannot regress) and fail closed everywhere else.
 * assertSystemdUser is host-fail-closed: a broken user bus throws with the
 * §6.1 remedies named — never a silent no-op on the box.
 *
 * Run: node --test tests/factoryPlatform.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertSystemdUser, detectServiceManager } from '../scripts/lib/factory-platform.js'

test('1. darwin dispatches to launchd (the laptop default, unchanged)', () => {
  assert.equal(detectServiceManager({ platform: 'darwin', env: {} }), 'launchd')
  // the real host right now is the gate (macOS): no env, no injection = launchd
  assert.equal(detectServiceManager({ env: {} }), process.platform === 'linux' ? 'systemd' : 'launchd')
})

test('2. linux dispatches to systemd user units (D7)', () => {
  assert.equal(detectServiceManager({ platform: 'linux', env: {} }), 'systemd')
})

test('3. unsupported platform throws fail-closed (never guess a manager)', () => {
  assert.throws(
    () => detectServiceManager({ platform: 'win32', env: {} }),
    /unsupported platform "win32".*launchd.*systemd/i,
  )
  assert.throws(
    () => detectServiceManager({ platform: 'freebsd', env: {} }),
    /unsupported platform/,
  )
})

test('4. FACTORY_SERVICE_MANAGER override (test/diagnostic seam)', () => {
  assert.equal(detectServiceManager({ platform: 'darwin', env: { FACTORY_SERVICE_MANAGER: 'systemd' } }), 'systemd')
  assert.equal(detectServiceManager({ platform: 'linux', env: { FACTORY_SERVICE_MANAGER: 'launchd' } }), 'launchd')
  assert.throws(() => detectServiceManager({ platform: 'darwin', env: { FACTORY_SERVICE_MANAGER: 'runit' } }), /FACTORY_SERVICE_MANAGER="runit"/)
})

test('5. assertSystemdUser passes on a working user bus (exit 0)', () => {
  const calls = []
  const ok = assertSystemdUser({
    run: ({ args }) => {
      calls.push(args)
      return { code: 0, stdout: 'running\n', stderr: '' }
    },
  })
  assert.equal(ok, true)
  assert.deepEqual(calls, [['systemctl', '--user', 'is-system-running']]) // read-only probe, nothing else
})

test('6. assertSystemdUser fail-closed: no user session throws naming both §6.1 remedies', () => {
  assert.throws(
    () => assertSystemdUser({ run: () => ({ code: 1, stdout: '', stderr: 'Failed to connect to bus: No such file or directory' }) }),
    /loginctl enable-linger.*XDG_RUNTIME_DIR/s,
  )
  assert.throws(
    () => assertSystemdUser({ run: () => ({ code: null, stdout: '', stderr: 'systemctl spawn failed or timed out' }) }),
    /systemd user session unavailable/,
  )
})
