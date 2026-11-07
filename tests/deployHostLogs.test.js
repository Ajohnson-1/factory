/**
 * Unit smoke for scripts/deploy-host-logs.sh (card 6ae4c877a23c63a664b75aab).
 *
 * No live docker: every classification case runs the script in its docker-free
 * `--input FILE|-` seam (case 14 proves docker is never even executed there
 * via a PATH shim that would exit 99). Fixtures are written into mkdtemp at
 * run time — nothing is committed.
 *
 * The gate host runs the script under /bin/bash (macOS bash 3.2), so this
 * asserts the bash-3.2-compatible script behaves identically.
 *
 * Run: node --test tests/deployHostLogs.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, '..', 'scripts', 'deploy-host-logs.sh')

function run (args, envExtra = {}, input) {
  return spawnSync('/bin/bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...envExtra },
    ...(input === undefined ? {} : { input })
  })
}

function fixture (name, lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deployhostlogs-'))
  const file = path.join(dir, name)
  writeFileSync(file, lines.join('\n') + '\n')
  return { dir, file }
}

function withFixture (lines, fn) {
  const f = fixture('log.txt', lines)
  try {
    return fn(f.file)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
}

test('1. bash -n passes (syntax gate)', () => {
  const r = spawnSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `bash -n failed: ${r.stderr}`)
})

test('2. clean fixture: exit 0, stdout exactly VERDICT=clean count=0', () => {
  withFixture(
    [
      'Ready! Bot version: 1.2.3',
      'Build time: 2026-10-30T12:00:00Z',
      'AI: memory ready — 3 fact(s) across 1 user(s), 0 awaiting embedding, model=nomic-embed-text dim=768',
      'requestLog: conversation log for this bot -> /app/data/conversation-log.jsonl'
    ],
    file => {
      const r = run(['bot', '--input', file])
      assert.equal(r.status, 0, `exit ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`)
      assert.equal(r.stdout, 'VERDICT=clean count=0\n')
    }
  )
})

test('3. crash fixture [resilience] unhandled rejection: exit 1 VERDICT=crash', () => {
  withFixture(
    ["[resilience] unhandled rejection: boom TypeError: Cannot read properties of undefined (reading 'send')"],
    file => {
      const r = run(['bot', '--input', file])
      assert.equal(r.status, 1, `exit ${r.status}; stdout=${r.stdout}`)
      assert.match(r.stdout, /^VERDICT=crash count=\d+/m)
    }
  )
})

test('4. crash fixture generic Error: dump: exit 1', () => {
  withFixture(
    ["Error: Cannot find module 'discord.js'", '    at Module._resolveFilename (node:internal/modules/cjs/loader:1104:15)'],
    file => {
      const r = run(['bot', '--input', file])
      assert.equal(r.status, 1, `exit ${r.status}; stdout=${r.stdout}`)
      assert.match(r.stdout, /^VERDICT=crash count=/m)
    }
  )
})

test('5. crash fixture unhandledRejection catch-all (case-insensitive) + UnhandledPromiseRejection dump: exit 1', () => {
  withFixture(
    [
      'unhandledRejection: this error originated a promise rejection that was never handled',
      'UnhandledPromiseRejection: This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch().'
    ],
    file => {
      const r = run(['bot', '--input', file])
      assert.equal(r.status, 1, `exit ${r.status}; stdout=${r.stdout}`)
      assert.match(r.stdout, /^VERDICT=crash count=2/m)
    }
  )
})

test('6. OOMKilled text fixture (--input path of the OOM signature): exit 1', () => {
  withFixture(
    ['container abc123def killed (pid 1234)', 'docker inspect says OOMKilled=true for this container'],
    file => {
      const r = run(['bot', '--input', file])
      assert.equal(r.status, 1, `exit ${r.status}; stdout=${r.stdout}`)
      assert.match(r.stdout, /^VERDICT=crash count=/m)
    }
  )
})

test('7. memory fixture aiMemoryEnabled=false: exit 2 VERDICT=memory-degraded count=1', () => {
  withFixture(
    ['AI: memory disabled (aiMemoryEnabled=false) — no database opened.'],
    file => {
      const r = run(['bot', '--input', file])
      assert.equal(r.status, 2, `exit ${r.status}; stdout=${r.stdout}`)
      assert.equal(r.stdout, 'VERDICT=memory-degraded count=1\n')
    }
  )
})

test('8. memory fixture sushi /models unreachable: exit 2', () => {
  withFixture(
    ['sushi verifyModelId: /models unreachable (fetch failed)'],
    file => {
      const r = run(['bot', '--input', file])
      assert.equal(r.status, 2, `exit ${r.status}; stdout=${r.stdout}`)
      assert.match(r.stdout, /^VERDICT=memory-degraded count=1/m)
    }
  )
})

test('9. precedence: "AI: memory unavailable — Error: no such table: facts" is degraded (2), NOT crash (1)', () => {
  withFixture(
    ['AI: memory unavailable — Error: no such table: facts. Chat continues without it.'],
    file => {
      const r = run(['bot', '--input', file])
      assert.equal(r.status, 2, `exit ${r.status}; stdout=${r.stdout} — interpolated Error: must NOT count as crash`)
      assert.equal(r.stdout, 'VERDICT=memory-degraded count=1\n')
    }
  )
})

test('10. mixed fixture (crash + degraded): crash wins, exit 1', () => {
  withFixture(
    [
      'AI: memory disabled (aiMemoryEnabled=false) — no database opened.',
      "[resilience] uncaught exception: TypeError: Cannot read properties of undefined (reading 'id')"
    ],
    file => {
      const r = run(['bot', '--input', file])
      assert.equal(r.status, 1, `exit ${r.status}; stdout=${r.stdout}`)
      assert.match(r.stdout, /^VERDICT=crash count=1/m)
    }
  )
})

test('11. --input - reads stdin: same verdict as file form', () => {
  const lines = ["[resilience] unhandled rejection: boom from stdin"]
  const f = fixture('log.txt', lines)
  try {
    const viaFile = run(['glorb', '--input', f.file])
    const viaStdin = run(['glorb', '--input', '-'], {}, lines.join('\n') + '\n')
    assert.equal(viaStdin.status, viaFile.status)
    assert.equal(viaFile.status, 1)
    assert.match(viaStdin.stdout, /^VERDICT=crash count=1/m)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('12. unknown service: exit 3 + usage on stderr', () => {
  const r = run(['nope'])
  assert.equal(r.status, 3, `exit ${r.status}; stderr=${r.stderr}`)
  assert.match(r.stderr, /usage/i)
})

test('13. --since accepted with --input in either flag order: exit 2 (docker-free)', () => {
  withFixture(
    ['AI: memory disabled (aiMemoryEnabled=false) — no database opened.'],
    file => {
      const after = run(['bot', '--input', file, '--since', '10m'])
      assert.equal(after.status, 2, `svc-first exit ${after.status}; stdout=${after.stdout}`)
      assert.equal(after.stdout, 'VERDICT=memory-degraded count=1\n')
      const before = run(['--since', '10m', 'bot', '--input', file])
      assert.equal(before.status, 2, `since-first exit ${before.status}; stdout=${before.stdout}`)
    }
  )
})

test('14. --input mode never executes docker: PATH shim that exits 99 stays untouched', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'docker-shim-'))
  const shim = path.join(dir, 'docker')
  writeFileSync(shim, '#!/bin/sh\nexit 99\n')
  chmodSync(shim, 0o755)
  try {
    withFixture(
      ['AI: memory disabled (aiMemoryEnabled=false) — no database opened.'],
      file => {
        const r = run(['bot', '--since', '10m', '--input', file], { PATH: dir })
        assert.equal(r.status, 2, `exit ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`)
        assert.equal(r.stdout, 'VERDICT=memory-degraded count=1\n')
      }
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('15. --verbose on crash fixture prints MATCH crash lines plus the VERDICT line', () => {
  withFixture(
    ["[resilience] uncaught exception: TypeError: Cannot read properties of undefined (reading 'id')"],
    file => {
      const r = run(['bot', '--verbose', '--input', file])
      assert.equal(r.status, 1, `exit ${r.status}; stdout=${r.stdout}`)
      assert.match(r.stdout, /^MATCH crash \d+: /m)
      assert.match(r.stdout, /^VERDICT=crash count=1$/m)
    }
  )
})
