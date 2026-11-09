/**
 * Scratch-DESTDIR tests for scripts/provision-factory-host.sh (FM-5, card
 * 6aee5f4d6e98279cb3ab3304; docs/factory-migration.md §6.1).
 *
 * PROVISION_MODE=test folds every system adapter onto a scratch tree
 * (linger/node/omp markers, stub node binary — no root, no network, no
 * systemd), same seam as tests/provisionDeployHost.test.js. Proves: the
 * self-check gate IS the exit code; .env + key land 0600; the local
 * registry validates through lib/factory-registry.js with box paths;
 * re-runs are byte-stable idempotents.
 *
 * Run: node --test tests/provisionFactoryHost.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawnSync as sync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRegistry } from '../scripts/lib/factory-registry.js'

const SCRIPT = fileURLToPath(new URL('../scripts/provision-factory-host.sh', import.meta.url))
const mode = (p) => statSync(p).mode & 0o777

function scratch () {
  const dest = mkdtempSync(join(tmpdir(), 'fm5-provision-'))
  const key = join(dest, 'srckey')
  writeFileSync(key, 'PRIVATE-KEY-BYTES\n')
  chmodSync(key, 0o600)
  return { dest, key }
}

function run (dest, { role = 'user', env = {} } = {}) {
  return spawnSync('/bin/bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROVISION_MODE: 'test',
      DESTDIR: dest,
      FACTORY_PROVISION_ROLE: role,
      ...env,
    },
  })
}

const secrets = (key) => ({
  FACTORY_TRELLO_KEY: 'tk', FACTORY_TRELLO_TOKEN: 'tt', FACTORY_BOT_TOKEN: 'bt',
  FACTORY_DEPLOY_HOST: 'box.example', FACTORY_SSH_PRIVKEY_FILE: key,
})

test('1. root session: linger marker + self-check gate PASS = exit 0', () => {
  const s = scratch()
  const r = run(s.dest, { role: 'root' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /PASS linger enabled for factory user/)
  assert.match(r.stdout, /SELF-CHECK: 1\/1 PASS/)
  assert.ok(existsSync(join(s.dest, 'state', 'linger')))
  rmSync(s.dest, { recursive: true, force: true })
})

test('2. user session: all 8 self-checks PASS = exit 0; artifacts + modes', () => {
  const s = scratch()
  const r = run(s.dest, { env: secrets(s.key) })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /SELF-CHECK: 8\/8 PASS/)
  assert.ok(!/FAIL /.test(r.stdout))

  const home = join(s.dest, 'home', process.env.USER ?? '')
  const factoryDir = join(s.dest, 'opt', 'factory')
  const envFile = join(factoryDir, '.env')
  const registry = join(factoryDir, 'config', 'factory-repos.local.json')
  const keyDest = join(home, '.ssh', 'factory_deploy_ed25519')

  // node marker + omp marker + clones with the deploy-history actor
  assert.equal(sync(join(home, '.local', 'node', 'bin', 'node'), ['--version'], { encoding: 'utf8' }).stdout.trim(), 'v22.14.0')
  assert.ok(existsSync(join(s.dest, 'state', 'omp')))
  for (const dir of [join(s.dest, 'opt', 'repos', 'discord-bot'), factoryDir]) {
    assert.ok(existsSync(join(dir, '.git')), dir)
    assert.match(readFileSync(join(dir, '.git', 'config'), 'utf8'), /user = factory/)
  }
  assert.ok(existsSync(join(s.dest, 'opt', 'factory-worktrees')))
  assert.ok(existsSync(join(s.dest, 'opt', 'repos', 'discord-bot-worktrees')))

  // secrets: 0600, required keys, the D2 registry pointer; same bytes at ~/.env
  assert.equal(mode(envFile), 0o600)
  const envText = readFileSync(envFile, 'utf8')
  for (const line of ['TRELLO_KEY=tk', 'TRELLO_TOKEN=tt', 'BOT_TOKEN=bt', 'DEPLOY_HOST=box.example', 'DEPLOY_USER=factory', 'DEPLOY_KEY=~/.ssh/factory_deploy_ed25519', `FACTORY_REPOS_FILE=${registry}`]) {
    assert.ok(envText.includes(line), `missing ${line}`)
  }
  assert.equal(readFileSync(join(home, '.env'), 'utf8'), envText)

  // registry: validates through the real loader with box paths + boards + drivers
  const reg = loadRegistry({ file: registry })
  assert.equal(reg.defaultRepo, 'factory')
  assert.equal(reg.repos.factory.repoDir, factoryDir)
  assert.equal(reg.repos.factory.board, 'LLNG5MAm')
  assert.equal(reg.repos.factory.deploy.driver, 'self')
  assert.equal(reg.repos['discord-bot'].repoDir, join(s.dest, 'opt', 'repos', 'discord-bot'))
  assert.equal(reg.repos['discord-bot'].board, 'ZHkVYBN1')
  assert.equal(reg.repos['discord-bot'].deploy.driver, 'docker-ssh')

  // ssh key: copied byte-identical, 600 under a 700 .ssh
  assert.equal(readFileSync(keyDest, 'utf8'), 'PRIVATE-KEY-BYTES\n')
  assert.equal(mode(keyDest), 0o600)
  assert.equal(mode(join(home, '.ssh')), 0o700)
  rmSync(s.dest, { recursive: true, force: true })
})

test('3. re-run is a byte-stable idempotent (identical bytes, still 8/8 PASS)', () => {
  const s = scratch()
  const first = run(s.dest, { env: secrets(s.key) })
  assert.equal(first.status, 0, first.stdout + first.stderr)
  const factoryDir = join(s.dest, 'opt', 'factory')
  const envBefore = readFileSync(join(factoryDir, '.env'))
  const regBefore = readFileSync(join(factoryDir, 'config', 'factory-repos.local.json'))
  const second = run(s.dest, { env: secrets(s.key) })
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /SELF-CHECK: 8\/8 PASS/)
  assert.deepEqual(readFileSync(join(factoryDir, '.env')), envBefore)
  assert.deepEqual(readFileSync(join(factoryDir, 'config', 'factory-repos.local.json')), regBefore)
  rmSync(s.dest, { recursive: true, force: true })
})

test('4. self-check FAIL gates the exit: no key source → 7/8 PASS + exit 1', () => {
  const s = scratch()
  const r = run(s.dest, { env: { FACTORY_TRELLO_KEY: 'tk', FACTORY_TRELLO_TOKEN: 'tt', FACTORY_BOT_TOKEN: 'bt', FACTORY_DEPLOY_HOST: 'box.example' } })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL private key/)
  assert.match(r.stdout, /SELF-CHECK: 7\/8 PASS/)
  rmSync(s.dest, { recursive: true, force: true })
})

test('5. FACTORY_SSH_PRIVKEY_FILE pointing at a missing file is a loud error', () => {
  const s = scratch()
  const r = run(s.dest, { env: { ...secrets(join(s.dest, 'nope')), FACTORY_SSH_PRIVKEY_FILE: join(s.dest, 'nope') } })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /FACTORY_SSH_PRIVKEY_FILE=.* missing/)
  rmSync(s.dest, { recursive: true, force: true })
})

test('6. --source-lib hook loads the library without running main', () => {
  const s = scratch()
  const r = spawnSync('/bin/bash', ['-c', `source '${SCRIPT}' --source-lib && type ensure_node >/dev/null && type write_dotenv >/dev/null && echo LOADED`], {
    encoding: 'utf8',
    env: { ...process.env, PROVISION_MODE: 'test', DESTDIR: s.dest },
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /LOADED/)
  rmSync(s.dest, { recursive: true, force: true })
})
