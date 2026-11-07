/**
 * CI smoke for scripts/provision-deploy-host.sh (card 6ae4c864efac38f57798699e).
 *
 * No live docker, no root, no network: every case runs the script with
 * PROVISION_MODE=test DESTDIR=<mkdtemp> FACTORY_USER=$(id -un)
 * FACTORY_GROUP=$(id -gn), so all system adapters collapse onto the scratch
 * tree. Live-mode wrappers (apt-get/systemctl/useradd/passwd -l) execute
 * exactly once on the real Debian 12 VM (human acceptance).
 *
 * The gate host runs the script under /bin/bash — macOS bash 3.2 — so the
 * script stays bash-3.2 compatible and this file asserts nothing GNU-only:
 * modes/owners are read with fs.statSync (uid compared to process.getuid()).
 *
 * Run: node --test tests/provisionDeployHost.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync, appendFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'scripts', 'provision-deploy-host.sh')
const PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMPqgmwDze4Ojo7hgGR0m1xjPVc6JEzUQM8ZBINsgEEO factory-deploy@laptop'
// docker-compose-plugin ships only in Docker's CE apt repo (not Debian 12
// main) — the script must add the repo and install this exact set.
const CE_PKGS = ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin']
const USER = process.env.USER || spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim()
const GROUP = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim()
const UID = process.getuid()

function mkDest () {
  return mkdtempSync(path.join(tmpdir(), 'provision-test-'))
}

function runScript (destdir, envExtra = {}) {
  return spawnSync('/bin/bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROVISION_MODE: 'test',
      DESTDIR: destdir,
      FACTORY_USER: USER,
      FACTORY_GROUP: GROUP,
      ...envExtra
    }
  })
}

function runSourced (destdir, body, envExtra = {}) {
  return spawnSync('/bin/bash', ['-c', `source '${SCRIPT}' --source-lib && ${body}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROVISION_MODE: 'test',
      DESTDIR: destdir,
      FACTORY_USER: USER,
      FACTORY_GROUP: GROUP,
      ...envExtra
    }
  })
}

const sshDir = d => path.join(d, 'home', USER, '.ssh')
const authKeys = d => path.join(sshDir(d), 'authorized_keys')
const appDir = d => path.join(d, 'opt', 'discord-bot')
const mode = p => statSync(p).mode & 0o777
const uidOf = p => statSync(p).uid
const daemonJson = d => path.join(d, 'etc', 'docker', 'daemon.json')
const restartsLog = d => path.join(d, 'state', 'docker-restarts.log')
const journalDir = d => path.join(d, 'var', 'log', 'journal')
const journalDropin = d => path.join(d, 'etc', 'systemd', 'journald.conf.d', '10-factory.conf')
const restartCount = d =>
  existsSync(restartsLog(d))
    ? readFileSync(restartsLog(d), 'utf8').split('\n').filter(l => l === 'restart').length
    : 0
// Byte-exact output of python3 json.dumps(obj, sort_keys=True, indent=2)+'\n'
// (the script's merge tool): sort_keys fixes key order; max-file is a STRING
// (docker rejects numeric 5).
const DAEMON_BYTES = '{\n  "log-driver": "json-file",\n  "log-opts": {\n    "max-file": "5",\n    "max-size": "10m"\n  }\n}\n'
const preWriteDaemon = (d, text) => {
  mkdirSync(path.dirname(daemonJson(d)), { recursive: true })
  writeFileSync(daemonJson(d), text)
}

function assertAllPass (r, ctx = '') {
  assert.equal(r.signal, null, `killed by ${r.signal}; stderr=${r.stderr}`)
  assert.equal(r.status, 0, `exit ${r.status}; stdout=\n${r.stdout}\nstderr=${r.stderr}${ctx}`)
  assert.doesNotMatch(r.stdout, /^FAIL /m, `unexpected FAIL lines:\n${r.stdout}${ctx}`)
  const passes = r.stdout.match(/^PASS /gm) || []
  assert.ok(passes.length >= 12, `expected >=12 PASS lines, got ${passes.length}:\n${r.stdout}${ctx}`)
  assert.match(r.stdout, /^SELF-CHECK: (\d+)\/\1 PASS$/m, `missing all-PASS summary:\n${r.stdout}${ctx}`)
}

test('1. bash -n passes (syntax gate)', () => {
  const r = spawnSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `bash -n failed: ${r.stderr}`)
})

test('2. first run on fresh DESTDIR: exit 0, all PASS, key file and dirs correct', () => {
  const d = mkDest()
  try {
    assertAllPass(runScript(d))
    assert.equal(readFileSync(authKeys(d), 'utf8'), `${PUBKEY}\n`)
    assert.equal(mode(sshDir(d)), 0o700)
    assert.equal(mode(authKeys(d)), 0o600)
    assert.equal(uidOf(authKeys(d)), UID)
    assert.equal(uidOf(sshDir(d)), UID)
    assert.ok(statSync(appDir(d)).isDirectory())
    assert.equal(uidOf(appDir(d)), UID)
    // package expectations are test-seam driven: the scratch apt.log must
    // list the Docker CE set and the repo marker (no network was touched).
    const aptLog = readFileSync(path.join(d, 'state', 'apt.log'), 'utf8').split('\n')
    for (const p of CE_PKGS) assert.ok(aptLog.includes(p), `apt.log missing ${p}: ${aptLog}`)
    assert.ok(existsSync(path.join(d, 'state', 'apt-repo')), 'docker CE repo seam marker missing')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('3. idempotent: re-runs exit 0 all-PASS, bytes stable, no tmp residue', () => {
  const d = mkDest()
  try {
    assertAllPass(runScript(d))
    const bytes = readFileSync(authKeys(d))
    assertAllPass(runScript(d))
    assertAllPass(runScript(d))
    assert.deepEqual(readFileSync(authKeys(d)), bytes, 'authorized_keys changed across re-runs')
    const residue = readdirSync(sshDir(d)).filter(f => f.startsWith('authorized_keys.tmp.'))
    assert.deepEqual(residue, [], `tmp residue after runs: ${residue}`)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('4. atomic replace repairs corrupted authorized_keys (content + mode)', () => {
  const d = mkDest()
  try {
    assertAllPass(runScript(d))
    appendFileSync(authKeys(d), 'garbage\n')
    chmodSync(authKeys(d), 0o644)
    assertAllPass(runScript(d))
    assert.equal(readFileSync(authKeys(d), 'utf8'), `${PUBKEY}\n`)
    assert.equal(mode(authKeys(d)), 0o600)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('5. install_authorized_keys unit (--source-lib) creates dir 0700 and key 0600', () => {
  const d = mkDest()
  try {
    const target = path.join(d, 'direct', 'keys')
    assert.equal(existsSync(target), false)
    const r = runSourced(d, `install_authorized_keys '${target}' "$FACTORY_SSH_PUBKEY"`)
    assert.equal(r.status, 0, `source-lib run failed: ${r.stdout}${r.stderr}`)
    assert.ok(existsSync(target), 'dest dir was not created')
    assert.equal(mode(target), 0o700)
    assert.equal(readFileSync(path.join(target, 'authorized_keys'), 'utf8'), `${PUBKEY}\n`)
    assert.equal(mode(path.join(target, 'authorized_keys')), 0o600)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('6. self-check is not vacuous: chmod 0644 then check -> exit 1 + FAIL authorized_keys', () => {
  const d = mkDest()
  try {
    assertAllPass(runScript(d))
    chmodSync(authKeys(d), 0o644)
    const r = runSourced(d, 'self_check')
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stdout=\n${r.stdout}`)
    assert.match(r.stdout, /^FAIL .*authorized_keys.*$/m, `no FAIL line naming authorized_keys:\n${r.stdout}`)
    assert.match(r.stdout, /SELF-CHECK: 11\/12 PASS/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('7. missing/invalid key guard: non-zero exit, no mutation before validation', () => {
  const d = mkDest()
  try {
    const r = runScript(d, { FACTORY_SSH_PUBKEY: '' })
    assert.notEqual(r.status, 0, 'empty key must fail')
    assert.equal(existsSync(path.join(d, 'home')), false, 'home tree created despite key failure')
    const bad = runScript(d, { FACTORY_SSH_PUBKEY: 'ssh-rsa AAAA bogus multi word key' })
    assert.notEqual(bad.status, 0, 'multi-word junk key must fail')
    assert.equal(existsSync(path.join(d, 'home')), false)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('8. static paste-block greps: pipefail, exact pre-filled key line, no bare delimiter', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  assert.ok(src.includes('set -euo pipefail'), 'missing set -euo pipefail')
  assert.ok(
    src.includes(`FACTORY_SSH_PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMPqgmwDze4Ojo7hgGR0m1xjPVc6JEzUQM8ZBINsgEEO factory-deploy@laptop'`),
    'missing exact pre-filled key assignment line'
  )
  for (const p of CE_PKGS) assert.ok(src.includes(p), `script missing package ${p}`)
  assert.ok(src.includes('https://download.docker.com/linux/debian/gpg'), 'missing Docker CE key URL')
  assert.ok(src.includes('/etc/apt/keyrings/docker.gpg'), 'missing keyring path')
  assert.ok(src.includes('/etc/apt/sources.list.d/docker.list'), 'missing sources list path')
  assert.equal(src.includes('docker.io'), false, 'stale docker.io reference (not shipped with docker-compose-plugin)')
  assert.equal(
    src.split('\n').some(line => line === 'FACTORY_PROVISION_EOF'),
    false,
    'a line equal to the heredoc delimiter would break the paste block'
  )
  // card 6ae4c877a23c63a664b75aab additions: docs must match the 12-check
  // reality + carry the classifier command; script must carry the machinery.
  const docs = readFileSync(path.join(HERE, '..', 'docs', 'deploy-host.md'), 'utf8')
  assert.ok(docs.includes('SELF-CHECK: 12/12 PASS'), 'docs still advertise the old 9-check summary')
  assert.ok(docs.includes('deploy-host-logs.sh bot --since 10m'), 'docs missing the classifier command')
  assert.ok(src.includes('ensure_daemon_json'), 'script missing ensure_daemon_json')
  assert.ok(src.includes('SystemMaxUse=2G'), 'script missing the journald SystemMaxUse cap')
  assert.ok(src.includes('docker-restarts.log'), 'script missing the test-mode docker-restart seam')
  assert.ok(src.includes('journald-restarted'), 'script missing the test-mode journald restart seam')
})

test('9. daemon.json created on first run: exact sorted bytes + exactly ONE docker restart', () => {
  const d = mkDest()
  try {
    assertAllPass(runScript(d))
    assert.equal(readFileSync(daemonJson(d), 'utf8'), DAEMON_BYTES, 'daemon.json bytes not the expected merged doc')
    assert.equal(restartCount(d), 1, 'docker must restart exactly once when daemon.json is created')
    const resid = readdirSync(path.dirname(daemonJson(d))).filter(f => f.startsWith('daemon.json.tmp.'))
    assert.deepEqual(resid, [], `tmp residue after run: ${resid}`)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('10. daemon.json idempotent: re-runs keep bytes AND do NOT restart docker again', () => {
  const d = mkDest()
  try {
    assertAllPass(runScript(d))
    assertAllPass(runScript(d))
    assertAllPass(runScript(d))
    assert.equal(readFileSync(daemonJson(d), 'utf8'), DAEMON_BYTES, 'daemon.json bytes changed across re-runs')
    assert.equal(restartCount(d), 1, 'cmp -s equal bytes must NOT trigger another docker restart')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('11. merge preserves unrelated keys: data-root + live-restore survive; restart once, never again', () => {
  const d = mkDest()
  try {
    preWriteDaemon(d, '{"data-root":"/srv/docker","live-restore":true}')
    assertAllPass(runScript(d))
    const obj = JSON.parse(readFileSync(daemonJson(d), 'utf8'))
    assert.equal(obj['log-driver'], 'json-file')
    assert.deepEqual(obj['log-opts'], { 'max-size': '10m', 'max-file': '5' })
    assert.equal(obj['data-root'], '/srv/docker', 'human data-root was clobbered')
    assert.equal(obj['live-restore'], true, 'human live-restore was clobbered')
    assert.equal(restartCount(d), 1, 'content changed => exactly one restart expected')
    assertAllPass(runScript(d))
    assert.equal(restartCount(d), 1, 'no-change re-run must not restart docker again')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('12. unparseable daemon.json: refuse (clobber guard), exit 1, both daemon checks FAIL, bytes untouched', () => {
  const d = mkDest()
  try {
    const garbage = '{not json'
    preWriteDaemon(d, garbage)
    const r = runScript(d)
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stdout=\n${r.stdout}`)
    assert.match(r.stdout, /^FAIL docker logging limits \(daemon\.json\)$/m, `limits check must FAIL:\n${r.stdout}`)
    assert.match(r.stdout, /^FAIL daemon\.json unrelated keys preserved$/m, `extras check must FAIL on the INVALID sentinel:\n${r.stdout}`)
    assert.match(r.stderr, /is not valid JSON; refusing to overwrite/, `missing refusal on stderr:\n${r.stderr}`)
    assert.equal(readFileSync(daemonJson(d), 'utf8'), garbage, 'garbage file was clobbered')
    assert.equal(restartCount(d), 0, 'a refused merge must not restart docker')
    assert.doesNotMatch(r.stdout, /^FAIL journald persistence configured$/m, 'journald check must still PASS')
    const sc = runSourced(d, 'self_check')
    assert.equal(sc.status, 1)
    assert.match(sc.stdout, /^FAIL docker logging limits \(daemon\.json\)$/m, `sourced self_check must FAIL limits:\n${sc.stdout}`)
    assert.match(sc.stdout, /^FAIL daemon\.json unrelated keys preserved$/m, `sourced self_check must FAIL extras:\n${sc.stdout}`)
    assert.match(sc.stdout, /^PASS journald persistence configured$/m, `journald must PASS sourced:\n${sc.stdout}`)
    assert.match(sc.stdout, /SELF-CHECK: 10\/12 PASS/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('13. tampered daemon.json (max-size 1g): self-check FAILs 11/12, next run repairs + restarts (2 total)', () => {
  const d = mkDest()
  try {
    assertAllPass(runScript(d))
    assert.equal(restartCount(d), 1)
    writeFileSync(daemonJson(d), JSON.stringify({ 'log-driver': 'json-file', 'log-opts': { 'max-size': '1g', 'max-file': '5' } }))
    const sc = runSourced(d, 'self_check')
    assert.equal(sc.status, 1, `tampered file must fail self-check, got ${sc.status}; stdout=\n${sc.stdout}`)
    assert.match(sc.stdout, /^FAIL docker logging limits \(daemon\.json\)$/m, `limits check must catch the tamper:\n${sc.stdout}`)
    assert.match(sc.stdout, /SELF-CHECK: 11\/12 PASS/)
    assertAllPass(runScript(d))
    assert.equal(readFileSync(daemonJson(d), 'utf8'), DAEMON_BYTES, 'repair did not restore the 10m cap')
    assert.equal(restartCount(d), 2, 'repair changed bytes => exactly one more restart expected')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('14. journald persistence: dir + drop-in SystemMaxUse=2G + restart marker; idempotent re-run', () => {
  const d = mkDest()
  try {
    assertAllPass(runScript(d))
    assert.ok(statSync(journalDir(d)).isDirectory(), '/var/log/journal dir not created under DESTDIR')
    assert.equal(readFileSync(journalDropin(d), 'utf8'), '[Journal]\nSystemMaxUse=2G\n', 'drop-in bytes wrong')
    assert.ok(existsSync(path.join(d, 'state', 'journald-restarted')), 'journald restart marker missing')
    const bytes = readFileSync(journalDropin(d))
    assertAllPass(runScript(d))
    assert.deepEqual(readFileSync(journalDropin(d)), bytes, 'drop-in bytes changed across re-runs')
    assert.ok(existsSync(path.join(d, 'state', 'journald-restarted')), 'restart marker lost on re-run')
  } finally { rmSync(d, { recursive: true, force: true }) }
})
