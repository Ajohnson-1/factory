/**
 * Repo registry — config/factory-repos.json is the single source for the
 * repo ↔ board ↔ worktree ↔ deploy mapping
 * (docs/factory-migration.md §4.1, decision D2).
 *
 * FM-1 shipped load + validate + expandTilde only (single-board parity).
 * FM-2 adds the routing surface (§4.1–§4.4): `boardIds` (the daemon's poll
 * set), `repoForCard` (card→repo: `repo:<name>` label over board default,
 * fail-closed with a reason on unknown/ambiguous — D3, the caller posts the
 * `[ASK]`), cwd worktree detection (`repoForPath` / `detectRepo`), and the
 * per-repo prompt context (`repoContextBlock`: exact worktree path +
 * bootstrap recipe + deploy command lines for the REPO CONTEXT block).
 *
 * Machine-local override: FACTORY_REPOS_FILE env names a different JSON
 * (same precedence pattern as lib/trello.js `.env` fallback — the committed
 * file is the laptop default; the box points it at /opt/factory/...).
 * Validation throws naming the offending key — fail-closed, never guess.
 * Dependency-injectable like every factory lib; pinned by
 * tests/factoryRegistry.test.js.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Same precedent as lib/deploy-config.js:44 — '~' and '~/' expand against homedir().
export function expandTilde(p) {
  if (p === '~' || p.startsWith('~/')) return resolve(homedir(), p.slice(1).replace(/^\//, ''));
  return p;
}

const DEPLOY_DRIVERS = ['docker-ssh', 'self'];

function bad(key, problem) {
  return new Error(`factory-repos.json: ${key}: ${problem}`);
}

/**
 * Validate a parsed registry object; throws Error naming the offending key.
 * Returns the normalized registry (paths tilde-expanded, worktreeBootstrap
 * defaulted to []). Pure — no fs, no env.
 */
export function validateRegistry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad('<root>', 'must be an object with defaultRepo + repos');
  }
  const { defaultRepo, repos } = raw;
  if (typeof defaultRepo !== 'string' || !defaultRepo) {
    throw bad('defaultRepo', 'must be a non-empty string');
  }
  if (!repos || typeof repos !== 'object' || Array.isArray(repos)) {
    throw bad('repos', 'must be an object keyed by repo name');
  }
  const names = Object.keys(repos);
  if (names.length === 0) throw bad('repos', 'must not be empty');
  if (!names.includes(defaultRepo)) {
    throw bad('defaultRepo', `"${defaultRepo}" is not a key of repos (${names.join(', ')})`);
  }
  const out = { defaultRepo, repos: {} };
  for (const name of names) {
    const r = repos[name];
    const at = (field) => `repos.${name}.${field}`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad(`repos.${name}`, 'must be an object');
    for (const field of ['repoDir', 'baseBranch', 'board']) {
      if (typeof r[field] !== 'string' || !r[field]) throw bad(at(field), 'must be a non-empty string');
    }
    if (r.worktreeRoot !== undefined && (typeof r.worktreeRoot !== 'string' || !r.worktreeRoot)) {
      throw bad(at('worktreeRoot'), 'must be a non-empty string when present');
    }
    if (!r.deploy || typeof r.deploy !== 'object' || Array.isArray(r.deploy)) {
      throw bad(at('deploy'), 'must be an object with driver');
    }
    if (!DEPLOY_DRIVERS.includes(r.deploy.driver)) {
      throw bad(at('deploy.driver'), `must be one of ${DEPLOY_DRIVERS.join('|')} (got ${JSON.stringify(r.deploy.driver)})`);
    }
    if (r.deploy.runtimeClone !== undefined && (typeof r.deploy.runtimeClone !== 'string' || !r.deploy.runtimeClone)) {
      throw bad(at('deploy.runtimeClone'), 'must be a non-empty string when present');
    }
    if (r.worktreeBootstrap !== undefined) {
      if (!Array.isArray(r.worktreeBootstrap) || r.worktreeBootstrap.some((s) => typeof s !== 'string')) {
        throw bad(at('worktreeBootstrap'), 'must be an array of strings when present');
      }
    }
    out.repos[name] = {
      name,
      repoDir: expandTilde(r.repoDir),
      worktreeRoot: expandTilde(r.worktreeRoot ?? `~/${name}-factory-wt`),
      baseBranch: r.baseBranch,
      board: r.board,
      deploy: {
        ...r.deploy,
        ...(r.deploy.runtimeClone ? { runtimeClone: expandTilde(r.deploy.runtimeClone) } : {}),
      },
      worktreeBootstrap: r.worktreeBootstrap ?? [],
    };
  }
  return out;
}

/**
 * Load + validate the registry. Precedence: explicit `file` → env
 * FACTORY_REPOS_FILE → <repoRoot>/config/factory-repos.json. JSON syntax
 * errors name the file. DI'd `read` for tests.
 */
export function loadRegistry({ file, env = process.env, read = readFileSync } = {}) {
  const path = file || env.FACTORY_REPOS_FILE || resolve(ROOT, 'config', 'factory-repos.json');
  let text;
  try {
    text = read(path, 'utf8');
  } catch (err) {
    throw new Error(`factory-repos.json: cannot read ${path}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`factory-repos.json: ${path}: invalid JSON: ${err.message}`);
  }
  return validateRegistry(raw);
}

// ---------------------------------------------------------------------------
// FM-2 board routing (docs/factory-migration.md §4.1–§4.4, decision D3)
// ---------------------------------------------------------------------------

/**
 * The distinct board ids the daemon must poll (FM-2, §4.3). One board per
 * registered repo, deduped — since FM-3 the committed config is split
 * (`factory` → `LLNG5MAm`, `discord-bot` → `ZHkVYBN1`), so this returns two
 * ids; a legacy single-board config (both entries on `ZHkVYBN1`) returns one.
 * The `defaultRepo`'s board leads; the rest keep registry order.
 */
export function boardIds(registry) {
  const ids = [];
  const push = (id) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  push(registry.repos[registry.defaultRepo]?.board);
  for (const name of Object.keys(registry.repos)) push(registry.repos[name].board);
  return ids;
}

/** Card label prefix that pins a card's repo (D3): `repo:discord-bot`. */
export const REPO_LABEL_PREFIX = 'repo:';

function labelNames(labels) {
  const list = Array.isArray(labels) ? labels : [];
  const names = [];
  for (const l of list) {
    const n = typeof l === 'string' ? l : l?.name;
    if (typeof n === 'string' && n.trim()) names.push(n.trim());
  }
  return names;
}

/**
 * Card→repo routing (D3 precedence, fail-closed — never guess):
 *   1. exactly one distinct `repo:<name>` label → that repo (unknown name →
 *      `{ ok: false, reason: 'unknown-repo' }`);
 *   2. ≥2 distinct `repo:` labels → `{ ok: false, reason:
 *      'ambiguous-repo-label', candidates }` (even when both are known —
 *      two named repos is still an ambiguity only a human can resolve);
 *   3. no label → the unique repo whose `board` equals `board`; several repos
 *      sharing a board → `{ ok: false, reason: 'ambiguous-board' }` (the
 *      FM-1/FM-2 interim shape while both entries carried `ZHkVYBN1` —
 *      FM-3's board split resolved it; the fail-closed path stays for any
 *      config that maps two repos to one board);
 *   4. no board match at all → `defaultRepo` (a board outside the registry
 *      — the CLI's `--board` can name one — routes to the default).
 * `labels` accepts Trello label objects (`{name}`) or plain strings. The
 * daemon turns `ok:false` into an `[ASK]` + needs-human + leave-in-Ready
 * (zero spawn); the CLI turns it into an exit-1 die. Pure.
 */
export function repoForCard(registry, { labels = [], board = null } = {}) {
  const repos = registry.repos ?? {};
  const wanted = [];
  for (const n of labelNames(labels)) {
    if (n.toLowerCase().startsWith(REPO_LABEL_PREFIX)) {
      const name = n.slice(REPO_LABEL_PREFIX.length).trim();
      if (name && !wanted.includes(name)) wanted.push(name);
    }
  }
  if (wanted.length === 1) {
    const repo = repos[wanted[0]];
    return repo
      ? { ok: true, repo, source: 'label' }
      : { ok: false, reason: 'unknown-repo', candidates: wanted };
  }
  if (wanted.length > 1) {
    return { ok: false, reason: 'ambiguous-repo-label', candidates: wanted };
  }
  if (board) {
    const matches = Object.values(repos).filter((r) => r && r.board === board);
    if (matches.length > 1) {
      return { ok: false, reason: 'ambiguous-board', candidates: matches.map((r) => r.name), board };
    }
    if (matches.length === 1) return { ok: true, repo: matches[0], source: 'board' };
  }
  const fallback = repos[registry.defaultRepo];
  return fallback
    ? { ok: true, repo: fallback, source: 'default' }
    : { ok: false, reason: 'unknown-repo', candidates: [registry.defaultRepo] };
}

/**
 * Registry repo owning `dir`: exact `repoDir` match, or `dir` strictly under
 * `worktreeRoot/` (a card worktree). `null` = unregistered path (the CLI
 * falls back to `defaultRepo`, §4.4). Path-exact, no prefix slop:
 * `<worktreeRoot>-suffix` is NOT under `<worktreeRoot>`.
 */
export function repoForPath(registry, dir) {
  if (typeof dir !== 'string' || !dir.trim()) return null;
  const norm = resolve(dir);
  for (const r of Object.values(registry.repos ?? {})) {
    if (!r) continue;
    if (norm === r.repoDir) return r;
    const root = r.worktreeRoot;
    if (root && (norm === root || norm.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) return r;
  }
  return null;
}

/** Real cwd→git-toplevel probe (the §4.4 detection); '' when not a repo. */
function defaultToplevel(cwd) {
  try {
    return String(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }) ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * CLI/daemon repo resolution (§4.4 precedence): `--repo <name>` flag → else
 * cwd's git toplevel matches a registry `repoDir`/`worktreeRoot` prefix →
 * else `defaultRepo`. A bad `--repo` name is the ONLY failure (`ok:false,
 * reason:'unknown-repo'`) — cwd detection is best-effort by design (the
 * documented default covers running outside any registered repo). `toplevelOf`
 * is the DI seam tests use instead of a real git call.
 */
export function detectRepo(registry, { repo, cwd = process.cwd(), toplevelOf = defaultToplevel } = {}) {
  if (repo != null && String(repo).trim() !== '') {
    const name = String(repo).trim();
    const r = registry.repos?.[name];
    return r
      ? { ok: true, repo: r, source: 'flag' }
      : { ok: false, reason: 'unknown-repo', candidates: [name] };
  }
  const top = toplevelOf(cwd);
  const byDir = repoForPath(registry, top);
  return byDir
    ? { ok: true, repo: byDir, source: 'cwd' }
    : { ok: true, repo: registry.repos[registry.defaultRepo], source: 'default' };
}

/** The card's worktree path under its repo's registry root (§4.1). */
export function worktreeFor(repo, cardId) {
  return join(repo.worktreeRoot ?? join(repo.repoDir, '..', `${repo.name}-factory-wt`), String(cardId));
}

/**
 * The repo's exact deploy/verify command lines (docs/factory-migration.md
 * §4.5). docker-ssh = the existing runners unchanged; self = no build (the
 * push to master IS the artifact), `git pull --ff-only` + a detached daemon
 * restart, previous-sha rollback + restart, verify = the daemon unit active
 * with a successful board poll logged after the restart.
 */
export function deployCommands(repo) {
  if (repo.deploy?.driver === 'self') {
    return [
      'build: none — pushing to ' + repo.baseBranch + ' IS the artifact',
      'deploy: node scripts/deploy-factory.js deploy (git pull --ff-only origin ' + repo.baseBranch + ' in the runtime clone + detached daemon restart)',
      'rollback (after [VERIFY:FAIL]): node scripts/deploy-factory.js rollback (checkout the previous sha + restart)',
      'verify: node scripts/verify-factory.js (daemon unit active + a board poll logged after the restart)',
    ];
  }
  return [
    'build: node scripts/deploy.js build master',
    'deploy: node scripts/deploy.js deploy <sha>',
    'rollback (after [VERIFY:FAIL]): node scripts/deploy.js rollback',
    'verify: node scripts/verify-deploy.js',
  ];
}

/**
 * Render the repo's worktree bootstrap recipe to exact commands: `<wt>` →
 * the card worktree path, `<factoryRoot>` → this factory checkout (e.g.
 * `test -f <wt>/.env || cp <factoryRoot>/.env <wt>/.env`). Run from the
 * repo's `repoDir` after the `git worktree add` (cwd matters: the recipe's
 * relative sources like `cp .env version.json <wt>/` are repo-rooted).
 */
export function renderWorktreeBootstrap(repo, { cardId, factoryRoot = ROOT } = {}) {
  const wt = worktreeFor(repo, cardId);
  return (repo.worktreeBootstrap ?? []).map((line) =>
    String(line).replaceAll('<wt>', wt).replaceAll('<factoryRoot>', factoryRoot),
  );
}

/**
 * The REPO CONTEXT block (FM-2, §4.3): repo, repoDir, baseBranch, exact
 * worktree path + worktree-add line + rendered bootstrap recipe, deploy
 * driver + command lines, and the factory-CLI-cwd rule. Both prompt builders
 * (`buildRunPrompt`, `buildResumePrompt`) embed this verbatim; pinned by
 * tests/factoryStagePrompts.test.js. `cardId` may be absent (generic context:
 * the `<wt>` placeholders stay literal).
 */
export function repoContextBlock(repo, { cardId = null, factoryRoot = ROOT } = {}) {
  const wt = cardId == null ? '<worktreeRoot>/<card-id>' : worktreeFor(repo, cardId);
  const branch = `factory/${cardId ?? '<card-id>'}`;
  const lines = [
    'REPO CONTEXT (repo registry: config/factory-repos.json — docs/factory-migration.md §4.1):',
    `- repo: ${repo.name}`,
    `- repoDir: ${repo.repoDir} (all git operations for this repo run here)`,
    `- baseBranch: ${repo.baseBranch}`,
    `- worktree: ${wt}`,
    `- branch: ${branch} cut from origin/${repo.baseBranch}`,
    `  create: git -C ${repo.repoDir} worktree add ${wt} -b ${branch} origin/${repo.baseBranch}`,
  ];
  const bootstrap = renderWorktreeBootstrap(repo, { cardId, factoryRoot });
  if (bootstrap.length) {
    lines.push(`  bootstrap (run from ${repo.repoDir}, exactly):`);
    for (const step of bootstrap) lines.push(`    ${step}`);
  }
  lines.push(`- deploy driver: ${repo.deploy?.driver ?? 'none'}`);
  for (const step of deployCommands(repo)) lines.push(`  ${step}`);
  lines.push('- All factory CLI invocations (node scripts/factory.js …) run from the FACTORY repo checkout, not the card worktree.');
  return lines.join('\n');
}
