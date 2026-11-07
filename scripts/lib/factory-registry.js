/**
 * Repo registry — config/factory-repos.json is the single source for the
 * repo ↔ board ↔ worktree ↔ deploy mapping
 * (docs/factory-migration.md §4.1, decision D2).
 *
 * v1 (FM-1): load + validate + expandTilde only. Board routing
 * (`repoForCard`, `boardIds`) and daemon plumbing land in FM-2 — until then
 * every entry shares the discord-bot board (single-board parity).
 *
 * Machine-local override: FACTORY_REPOS_FILE env names a different JSON
 * (same precedence pattern as lib/trello.js `.env` fallback — the committed
 * file is the laptop default; the box points it at /opt/factory/...).
 * Validation throws naming the offending key — fail-closed, never guess.
 * Dependency-injectable like every factory lib; pinned by
 * tests/factoryRegistry.test.js.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
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
      deploy: { ...r.deploy },
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
