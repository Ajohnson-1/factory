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
import {
  boardIds,
  repoForCard,
  repoForPath,
  detectRepo,
  worktreeFor,
  renderWorktreeBootstrap,
  repoContextBlock,
  deployCommands,
} from '../scripts/lib/factory-registry.js';

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

// ── FM-2 routing surface (docs/factory-migration.md §4.1–§4.4, D3) ─────────

// Two repos, two distinct boards — the shape FM-3+ ships (factory entry
// flipped to LLNG5MAm). The committed config (test 11) keeps BOTH on
// ZHkVYBN1 until then, which is what the ambiguous-board path models.
function twoRepo(overrides = {}) {
  return validateRegistry({
    defaultRepo: 'factory',
    repos: {
      factory: {
        repoDir: '~/GitHub/factory',
        worktreeRoot: '~/GitHub/factory-factory-wt',
        baseBranch: 'master',
        board: 'LLNG5MAm',
        deploy: { driver: 'self' },
      },
      'discord-bot': {
        repoDir: '~/GitHub/discord-bot',
        worktreeRoot: '~/GitHub/discord-bot-factory-wt',
        baseBranch: 'master',
        board: 'ZHkVYBN1',
        deploy: { driver: 'docker-ssh' },
        worktreeBootstrap: [
          'ln -s ../../discord-bot/node_modules node_modules',
          'cp .env version.json <wt>/',
          'mkdir -p <wt>/config <wt>/data && cp config/config.json <wt>/config/',
          'test -f <wt>/.env || cp <factoryRoot>/.env <wt>/.env',
        ],
      },
    },
    ...overrides,
  });
}

const CARD = '6ae4b88307df4b89018e8d7f';

// ── boardIds ───────────────────────────────────────────────────────────────

test('12. boardIds: distinct boards, defaultRepo first; same-board repos dedup to one poll id (FM-1 parity config)', () => {
  const reg = twoRepo();
  assert.deepEqual(boardIds(reg), ['LLNG5MAm', 'ZHkVYBN1']); // defaultRepo=factory first, then registry order
  const parity = loadRegistry({ env: {} }); // both entries ZHkVYBN1
  assert.deepEqual(boardIds(parity), ['ZHkVYBN1']); // deduped — today's daemon polls ONE board
});

// ── repoForCard (D3 precedence) ────────────────────────────────────────────

test('13. repoForCard: repo: label beats the board default; duplicate same-name labels dedup', () => {
  const reg = twoRepo();
  const r = repoForCard(reg, { labels: [{ name: 'needs-human' }, { name: 'repo:discord-bot' }], board: 'LLNG5MAm' });
  assert.equal(r.ok, true);
  assert.equal(r.repo.name, 'discord-bot'); // label overrides the factory board default
  assert.equal(r.source, 'label');
  const dup = repoForCard(reg, { labels: ['repo:discord-bot', 'repo:discord-bot'], board: 'LLNG5MAm' }); // strings too
  assert.equal(dup.ok && dup.repo.name, 'discord-bot');
});

test('14. repoForCard: unknown repo label fails closed (unknown-repo), never guesses', () => {
  const reg = twoRepo();
  const r = repoForCard(reg, { labels: [{ name: 'repo:ghost-repo' }], board: 'ZHkVYBN1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-repo');
  assert.deepEqual(r.candidates, ['ghost-repo']);
});

test('15. repoForCard: two repo: labels fail closed (ambiguous-repo-label) even when both known', () => {
  const reg = twoRepo();
  const r = repoForCard(reg, { labels: [{ name: 'repo:factory' }, { name: 'repo:discord-bot' }], board: 'LLNG5MAm' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous-repo-label');
  assert.deepEqual(r.candidates.sort(), ['discord-bot', 'factory']);
});

test('16. repoForCard: no label → board default; several repos on one board → ambiguous-board; unregistered board → defaultRepo', () => {
  const reg = twoRepo();
  assert.equal(repoForCard(reg, { labels: [], board: 'ZHkVYBN1' }).repo.name, 'discord-bot'); // unique board owner
  assert.equal(repoForCard(reg, { labels: [], board: 'LLNG5MAm' }).repo.name, 'factory');
  assert.equal(repoForCard(reg, { labels: [], board: 'UnknownBd' }).repo.name, 'factory'); // default fallback
  assert.equal(repoForCard(reg, { labels: [] }).repo.name, 'factory'); // no board either
  const shared = loadRegistry({ env: {} }); // FM-1 parity: BOTH repos claim ZHkVYBN1
  const amb = repoForCard(shared, { labels: [], board: 'ZHkVYBN1' });
  assert.equal(amb.ok, false);
  assert.equal(amb.reason, 'ambiguous-board');
  assert.deepEqual(amb.candidates.sort(), ['discord-bot', 'factory']);
  assert.equal(amb.board, 'ZHkVYBN1');
});

// ── repoForPath / detectRepo (§4.4) ────────────────────────────────────────

test('17. repoForPath: exact repoDir or strictly under worktreeRoot/; siblings and strangers are null', () => {
  const reg = twoRepo();
  assert.equal(repoForPath(reg, join(HOME, 'GitHub/discord-bot')).name, 'discord-bot');
  assert.equal(repoForPath(reg, join(HOME, 'GitHub/discord-bot-factory-wt', CARD)).name, 'discord-bot');
  assert.equal(repoForPath(reg, join(HOME, 'GitHub/discord-bot-factory-wt')), reg.repos['discord-bot']); // worktreeRoot itself counts
  assert.equal(repoForPath(reg, join(HOME, 'GitHub/discord-bot-factory-wt-fake', CARD)), null); // prefix WITHOUT separator is not a child
  assert.equal(repoForPath(reg, '/somewhere/else'), null);
  assert.equal(repoForPath(reg, ''), null);
});

test('18. detectRepo: --repo flag wins; bad flag fails closed; cwd toplevel matches a registered dir; else defaultRepo', () => {
  const reg = twoRepo();
  assert.equal(detectRepo(reg, { repo: 'discord-bot' }).repo.name, 'discord-bot');
  const bad = detectRepo(reg, { repo: 'ghost' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unknown-repo');
  const cwd = detectRepo(reg, { cwd: '/wt', toplevelOf: () => join(HOME, 'GitHub/factory-factory-wt', CARD) });
  assert.equal(cwd.ok && cwd.repo.name, 'factory');
  assert.equal(cwd.source, 'cwd');
  const def = detectRepo(reg, { cwd: '/nowhere', toplevelOf: () => '/nowhere' });
  assert.equal(def.ok && def.repo.name, 'factory');
  assert.equal(def.source, 'default');
  const notRepo = detectRepo(reg, { cwd: '/tmp', toplevelOf: () => '' }); // git fails → ''
  assert.equal(notRepo.repo.name, 'factory');
});

// ── worktree + bootstrap rendering ─────────────────────────────────────────

test('19. worktreeFor joins the registry worktreeRoot; renderWorktreeBootstrap substitutes <wt>/<factoryRoot>', () => {
  const reg = twoRepo();
  const db = reg.repos['discord-bot'];
  const wt = join(HOME, 'GitHub/discord-bot-factory-wt', CARD);
  assert.equal(worktreeFor(db, CARD), wt);
  const steps = renderWorktreeBootstrap(db, { cardId: CARD, factoryRoot: '/opt/factory' });
  assert.deepEqual(steps, [
    'ln -s ../../discord-bot/node_modules node_modules',
    `cp .env version.json ${wt}/`,
    `mkdir -p ${wt}/config ${wt}/data && cp config/config.json ${wt}/config/`,
    `test -f ${wt}/.env || cp /opt/factory/.env ${wt}/.env`,
  ]);
  assert.deepEqual(renderWorktreeBootstrap(reg.repos.factory, { cardId: CARD }), []); // empty recipe → no steps
});

test('20. deployCommands: docker-ssh = the existing runners; self = FM-4 command lines', () => {
  const reg = twoRepo();
  assert.deepEqual(deployCommands(reg.repos['discord-bot']), [
    'build: node scripts/deploy.js build master',
    'deploy: node scripts/deploy.js deploy <sha>',
    'rollback (after [VERIFY:FAIL]): node scripts/deploy.js rollback',
    'verify: node scripts/verify-deploy.js',
  ]);
  const self = deployCommands(reg.repos.factory).join('\n');
  assert.match(self, /deploy-factory\.js/);
  assert.match(self, /git pull --ff-only origin master/);
});

test('21. repoContextBlock: REPO CONTEXT header, repoDir/baseBranch/worktree, exact worktree-add + bootstrap lines, deploy lines, factory-CLI rule', () => {
  const reg = twoRepo();
  const db = reg.repos['discord-bot'];
  const wt = join(HOME, 'GitHub/discord-bot-factory-wt', CARD);
  const block = repoContextBlock(db, { cardId: CARD, factoryRoot: '/opt/factory' });
  assert.match(block, /^REPO CONTEXT \(repo registry: config\/factory-repos\.json/);
  assert.ok(block.includes(`- repo: discord-bot`));
  assert.ok(block.includes(`- repoDir: ${join(HOME, 'GitHub/discord-bot')} (all git operations for this repo run here)`));
  assert.ok(block.includes('- baseBranch: master'));
  assert.ok(block.includes(`- worktree: ${wt}`));
  assert.ok(block.includes(`- branch: factory/${CARD} cut from origin/master`));
  assert.ok(block.includes(`  create: git -C ${join(HOME, 'GitHub/discord-bot')} worktree add ${wt} -b factory/${CARD} origin/master`));
  assert.ok(block.includes(`    cp .env version.json ${wt}/`));
  assert.ok(block.includes(`    test -f ${wt}/.env || cp /opt/factory/.env ${wt}/.env`));
  assert.ok(block.includes('- deploy driver: docker-ssh'));
  assert.ok(block.includes('build: node scripts/deploy.js build master'));
  assert.ok(block.includes('- All factory CLI invocations (node scripts/factory.js …) run from the FACTORY repo checkout, not the card worktree.'));
});
