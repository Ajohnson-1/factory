// Deploy-target config loader for scripts/deploy.js + scripts/verify-deploy.js
// (card 6ae4c8763f202fc86c57ef65; docs/factory.md, docs/deploy-host.md).
//
// Same env-loading pattern as scripts/lib/trello.js: parseDotEnv() reads the repo
// .env (gitignored), process env wins over the file. No dotenv dependency.
// Every key has a hard-coded default EXCEPT DEPLOY_HOST — the VM address is unknown
// at merge time, so an empty/missing value lands in `errors` and the CLIs exit 2
// (loud, zero remote calls) instead of guessing.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseDotEnv() {
  let txt = '';
  try {
    txt = readFileSync(resolve(ROOT, '.env'), 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export const DEPLOY_DEFAULTS = {
  user: 'factory',
  key: '~/.ssh/factory_deploy_ed25519',
  dir: '/opt/discord-bot',
  repo: 'git@github.com:Ajohnson-1/discord-bot.git',
  imageRepo: 'ghcr.io/ajohnson-1/discord-bot',
};

// `~`-expansion for DEPLOY_KEY (the VM path `~/.ssh/...` in docs stays literal on the
// remote; this expands the laptop-side identity file for `ssh -i`).
export function expandTilde(p) {
  if (p === '~' || p.startsWith('~/')) return resolve(homedir(), p.slice(1).replace(/^\//, ''));
  return p;
}

function defaultGitUserProbe() {
  // `git config user.name` in the repo; empty/unknown → throw → next fallback.
  return execFileSync('git', ['config', 'user.name'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim();
}

// actor = who gets recorded in .deploy-history. Resolution order (plan §c):
// DEPLOY_ACTOR env → laptop `git config user.name` → OS username. The VM has no
// identity of its own, so this resolves laptop-side and rides inside the history JSON.
export function resolveActor(env = process.env, gitProbe = defaultGitUserProbe) {
  if (env.DEPLOY_ACTOR && env.DEPLOY_ACTOR.trim()) return env.DEPLOY_ACTOR.trim();
  try {
    const name = gitProbe();
    if (name) return name;
  } catch {
    /* git unavailable / unset user.name → OS username */
  }
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {Record<string,string>} [fileEnv] parsed repo .env (injectable for tests)
 * @returns {{host:string,user:string,key:string,dir:string,repo:string,actor:string,
 *            imageRepo:string,errors:string[]}}
 */
export function deployConfig(env = process.env, fileEnv = parseDotEnv()) {
  // Explicit empty string (e.g. `DEPLOY_HOST=` copied from .env.example) = unset.
  const pick = name => {
    const v = env[name] ?? fileEnv[name] ?? '';
    return String(v).trim();
  };

  const errors = [];
  const host = pick('DEPLOY_HOST');
  if (!host) {
    errors.push(
      'DEPLOY_HOST unset — set the deploy host address in .env or the environment (no default; docs/deploy-host.md)',
    );
  }
  const user = pick('DEPLOY_USER') || DEPLOY_DEFAULTS.user;
  const key = expandTilde(pick('DEPLOY_KEY') || DEPLOY_DEFAULTS.key);
  const dir = pick('DEPLOY_DIR') || DEPLOY_DEFAULTS.dir;
  const repo = pick('DEPLOY_REPO') || DEPLOY_DEFAULTS.repo;
  const imageRepo = pick('DEPLOY_IMAGE_REPO') || DEPLOY_DEFAULTS.imageRepo;
  // .env DEPLOY_ACTOR is documented in .env.example — process env still wins.
  const actor = resolveActor({ ...fileEnv, ...env });
  return { host, user, key, dir, repo, actor, imageRepo, errors };
}
