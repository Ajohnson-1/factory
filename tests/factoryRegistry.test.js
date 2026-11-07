/**
 * Unit tests for scripts/lib/factory-registry.js (FM-1, card 4e7nwL3J;
 * docs/factory-migration.md §4.1 / decision D2).
 *
 * v1 scope: load + validate + expandTilde. Zero network, zero launchd; the
 * only fs access is mkdtemp'd JSON files (or an injected fake `read`).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { expandTilde, validateRegistry, loadRegistry } from '../scripts/lib/factory-registry.js';

const HOME = process.env.HOME ?? '~';

function validRaw(overrides = {}, repoOverrides = {}) {
  return {
    defaultRepo: 'factory',
    repos: {
      factory: {
        repoDir: '~/GitHub/factory',
        baseBranch: 'master',
        board: 'ZHkVYBN1',
        deploy: { driver: 'self' },
        ...repoOverrides,
      },
    },
    ...overrides,
  };
}

// ── expandTilde ────────────────────────────────────────────────────────────

test('1. expandTilde: ~ and ~/ expand against HOME; absolute and relative pass through', () => {
  assert.equal(expandTilde('~'), HOME);
  assert.equal(expandTilde('~/GitHub/factory'), join(HOME, 'GitHub/factory'));
  assert.equal(expandTilde('~/'), HOME);
  assert.equal(expandTilde('/opt/factory'), '/opt/factory');
  assert.equal(expandTilde('relative/path'), 'relative/path');
  // '~user' is NOT expanded (only bare ~ / ~/ are) — same as deploy-config precedent.
  assert.equal(expandTilde('~user/x'), '~user/x');
});

// ── validateRegistry ───────────────────────────────────────────────────────

test('2. validate: happy path normalizes — tilde-expanded paths, worktreeRoot default, bootstrap []', () => {
  const r = validateRegistry(validRaw());
  const f = r.repos.factory;
  assert.equal(r.defaultRepo, 'factory');
  assert.equal(f.name, 'factory');
  assert.equal(f.repoDir, join(HOME, 'GitHub/factory'));
  assert.equal(f.worktreeRoot, join(HOME, 'factory-factory-wt')); // default "~/<name>-factory-wt"
  assert.equal(f.baseBranch, 'master');
  assert.equal(f.board, 'ZHkVYBN1');
  assert.deepEqual(f.deploy, { driver: 'self' });
  assert.deepEqual(f.worktreeBootstrap, []);
});

test('3. validate: explicit worktreeRoot + bootstrap array are kept (expanded where path-shaped)', () => {
  const raw = validRaw({}, {
    worktreeRoot: '~/GitHub/factory-factory-wt',
    worktreeBootstrap: ['ln -s ../x node_modules', 'cp <factoryRoot>/.env <wt>/.env'],
  });
  const f = validateRegistry(raw).repos.factory;
  assert.equal(f.worktreeRoot, join(HOME, 'GitHub/factory-factory-wt'));
  assert.equal(f.worktreeBootstrap.length, 2);
});

test('4. validate: every failure names the offending key', () => {
  const cases = [
    [null, '<root>'],
    [[], '<root>'],
    [{ repos: {} }, 'defaultRepo'],
    [{ defaultRepo: '', repos: {} }, 'defaultRepo'],
    [{ defaultRepo: 'x', repos: { y: validRaw().repos.factory } }, 'defaultRepo'], // not in repos
    [{ defaultRepo: 'f', repos: {} }, 'repos'], // empty
    [{ defaultRepo: 'f', repos: 'nope' }, 'repos'],
    [{ defaultRepo: 'f', repos: { f: 'nope' } }, 'repos.f'],
    [validRaw({}, { repoDir: '' }), 'repos.factory.repoDir'],
    [validRaw({}, { repoDir: 42 }), 'repos.factory.repoDir'],
    [validRaw({}, { board: '' }), 'repos.factory.board'],
    [validRaw({}, { baseBranch: undefined }), 'repos.factory.baseBranch'],
    [validRaw({}, { deploy: 'self' }), 'repos.factory.deploy'],
    [validRaw({}, { deploy: {} }), 'repos.factory.deploy.driver'],
    [validRaw({}, { deploy: { driver: 'k8s' } }), 'repos.factory.deploy.driver'],
    [validRaw({}, { worktreeRoot: '' }), 'repos.factory.worktreeRoot'],
    [validRaw({}, { worktreeBootstrap: 'ln -s …' }), 'repos.factory.worktreeBootstrap'],
    [validRaw({}, { worktreeBootstrap: [1] }), 'repos.factory.worktreeBootstrap'],
  ];
  for (const [raw, key] of cases) {
    assert.throws(
      () => validateRegistry(raw),
      (err) => err.message.includes(`factory-repos.json: ${key}:`),
      `expected offending key ${key} for ${JSON.stringify(raw)}`,
    );
  }
});

// ── loadRegistry ───────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'registry-test-'));
const writeJson = (name, obj) => {
  const p = join(dir, name);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return p;
};

test('5. loadRegistry: explicit file arg loads + normalizes', () => {
  const p = writeJson('ok.json', validRaw());
  const reg = loadRegistry({ file: p });
  assert.equal(reg.repos.factory.repoDir, join(HOME, 'GitHub/factory'));
});

test('6. loadRegistry: env FACTORY_REPOS_FILE wins over default path (D2 machine-local override)', () => {
  const p = writeJson('env.json', validRaw({}, { repoDir: '/opt/factory', board: 'LLNG5MAm' }));
  const reg = loadRegistry({ env: { FACTORY_REPOS_FILE: p } });
  assert.equal(reg.repos.factory.repoDir, '/opt/factory');
  assert.equal(reg.repos.factory.board, 'LLNG5MAm');
});

test('7. loadRegistry: explicit file arg beats FACTORY_REPOS_FILE', () => {
  const a = writeJson('a.json', validRaw({}, { repoDir: '/a' }));
  const b = writeJson('b.json', validRaw({}, { repoDir: '/b' }));
  assert.equal(loadRegistry({ file: a, env: { FACTORY_REPOS_FILE: b } }).repos.factory.repoDir, '/a');
});

test('8. loadRegistry: unreadable file and bad JSON name the file path', () => {
  assert.throws(
    () => loadRegistry({ file: join(dir, 'missing.json') }),
    (err) => err.message.includes('cannot read') && err.message.includes('missing.json'),
  );
  const p = writeJson('bad.json', '{ "defaultRepo": ');
  assert.throws(
    () => loadRegistry({ file: p }),
    (err) => err.message.includes(p) && err.message.includes('invalid JSON'),
  );
});

test('9. loadRegistry: validation errors propagate through load', () => {
  const p = writeJson('invalid.json', { defaultRepo: 'ghost', repos: { factory: validRaw().repos.factory } });
  assert.throws(() => loadRegistry({ file: p }), /defaultRepo/);
});

test('10. loadRegistry: DI read supplies the file content (no fs)', () => {
  const reg = loadRegistry({
    file: 'virtual.json',
    read: () => JSON.stringify(validRaw({}, { repoDir: 'C:/factory', board: 'ABCdef1' })),
  });
  assert.equal(reg.repos.factory.repoDir, 'C:/factory');
});

test('11. the committed config/factory-repos.json itself validates (FM-1 single-board parity)', () => {
  const reg = loadRegistry({ env: {} }); // default path → repo's own config file
  assert.equal(reg.defaultRepo, 'factory');
  for (const name of ['factory', 'discord-bot']) {
    assert.ok(reg.repos[name], `registry must contain ${name}`);
    assert.equal(reg.repos[name].board, 'ZHkVYBN1'); // FM-1: single board until FM-3 flips factory
  }
  assert.equal(reg.repos['discord-bot'].deploy.driver, 'docker-ssh');
  assert.equal(reg.repos.factory.deploy.driver, 'self');
});
