#!/usr/bin/env node
// Factory DEPLOY stage (card 6ae4c8763f202fc86c57ef65; docs/factory.md).
//
// Subcommands (every remote step runs over ssh -i $DEPLOY_KEY as one string arg,
// see scripts/lib/deploy-ssh.js for the DI runner seam; unit tests fake the runner
// in-process — nothing here touches live SSH unless you run the CLI):
//
//   build [ref]     default ref = master. Idempotent bootstrap on the host (bare
//                   clone ${DIR}/src/bot.git + read-only GitHub deploy key), fetch
//                   origin, resolve <ref>^{commit} to the FULL sha from REAL GitHub
//                   refs, extract the tree (bare repos have no work-tree — archive
//                   | tar is the faithful reading of "checkout <ref>"), docker build
//                   ${IMG}:sha-<short7> HOST-LOCAL (never pushed).
//                   stdout machine lines (last lines): SHA= / SHORT= / IMAGE=
//   deploy <sha>    cat-file guard (fetch-on-miss), extract tree to src/work,
//                   refresh $DIR/docker-compose.yml + $DIR/deploy-host-logs.sh from
//                   the deployed sha's tree (so host compose file AND the shipped
//                   classifier always match the running sha — the classifier never
//                   goes stale), require the built tag (loud 'run build first'),
//                   write the ONE-LINE $DIR/.deploy-env (BOT_IMAGE=), then
//                   `docker compose --env-file .deploy-env up -d --no-build` and
//                   append an entry to the append-only $DIR/.deploy-history.
//                   stdout: CONTAINER <svc> <cid> <image-ref> lines + DIGEST <id>
//   rollback        target = second-to-last .deploy-history entry; re-runs the
//                   deploy sequence with that entry's image (no rebuild), appends
//                   an action:"rollback" entry. The scheduler invokes this on
//                   [VERIFY:FAIL] (docs/factory.md, card 6ae9676d2461fd41204b507e),
//                   between the [VERIFY:FAIL] and [ROLLBACK] comments, before
//                   the fix-forward bounce.
//
// Exit codes: 0 ok; 2 config/preflight (DEPLOY_HOST unset, fetch-auth missing deploy
// key, sha missing, image missing, nothing to roll back); 1 remote command failed.

import { deployConfig } from './lib/deploy-config.js';
import { makeSSH } from './lib/deploy-ssh.js';
import { pathToFileURL } from 'node:url';

const GITHUB_KEY = '~/.ssh/factory_github_deploy_ed25519';
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// Single-quote a string for the REMOTE shell (the whole remote command is already
// one argv element; the remote sh parses it).
function shQ(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Git host derived from cfg.repo for the known_hosts seed step: scp-style
// `git@HOST:path`, URL forms (https://…, ssh://git@host:port/…), else the
// github.com default. Exported for unit tests.
export function gitHost(repo) {
  const s = String(repo ?? '');
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(s);
  if (scp) return scp[1];
  try {
    const u = new URL(s);
    if (u.hostname) return u.hostname;
  } catch {
    /* not a URL — fall through to the default */
  }
  return 'github.com';
}

function historyEntry({ ts, sha, short, image, actor, action }) {
  // Field order fixed (plan §c file formats).
  return JSON.stringify({ ts, sha, short, image, actor, action });
}

// Parse append-only JSON-lines history, tolerating a truncated tail line.
export function parseHistory(stdout) {
  const entries = [];
  for (const line of String(stdout).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const e = JSON.parse(t);
      if (e && typeof e === 'object' && typeof e.sha === 'string') entries.push(e);
    } catch {
      /* truncated / garbage line — skip (append-only truth keeps earlier lines) */
    }
  }
  return entries;
}

/**
 * build [ref] — see header. Resolves the ref to a FULL sha host-side from real
 * GitHub refs, tags sha-<short7> (7 = git's canonical default abbreviation,
 * deterministic for tests, collision-safe at this repo's size).
 * @returns {{ok:boolean, exit:number, sha?:string, short?:string, image?:string, error?:string}}
 */
export function build({ ssh, cfg, ref = 'master', out = s => console.log(s) }) {
  if (!REF_RE.test(ref)) {
    return { ok: false, exit: 2, error: `invalid ref ${JSON.stringify(ref)} — expected a plain branch/sha name` };
  }
  const { dir: DIR, repo: REPO, imageRepo: IMG } = cfg;
  const fail = (r, step) => ({ ok: false, exit: 1, error: `${step} failed (code ${r.code}): ${(r.stderr || r.stdout || '').trim().slice(0, 400)}` });

  let r;

  r = ssh.run(`mkdir -p ${DIR}/src`);
  if (r.code !== 0) return fail(r, 'mkdir src');

  // GitHub deploy key bootstrap: generate once, wire ~/.ssh/config idempotently
  // (grep instead of failing — a re-deploy must not clobber a hand-added key).
  r = ssh.run(
    `test -f ${GITHUB_KEY} || ssh-keygen -t ed25519 -N '' -C factory-github-deploy@host -f ${GITHUB_KEY}`,
  );
  if (r.code !== 0) return fail(r, 'ssh-keygen');

  r = ssh.run(
    `grep -q github.com ~/.ssh/config 2>/dev/null || { printf 'Host github.com\\n  IdentityFile ${GITHUB_KEY}\\n  IdentitiesOnly yes\\n' >> ~/.ssh/config && chmod 600 ~/.ssh/config; }`,
  );
  if (r.code !== 0) return fail(r, 'ssh config');

  r = ssh.run(`test -d ${DIR}/src/bot.git || git init --bare ${DIR}/src/bot.git`);
  if (r.code !== 0) return fail(r, 'git init --bare');

  r = ssh.run(
    `git -C ${DIR}/src/bot.git remote get-url origin 2>/dev/null >/dev/null || git -C ${DIR}/src/bot.git remote add origin ${REPO}`,
  );
  if (r.code !== 0) return fail(r, 'remote add');

  // Fresh-host seed: the git host key MUST be in factory's ~/.ssh/known_hosts
  // before fetch, or ssh dies with 'Host key verification failed'. The grep
  // probe skips keyscan when an entry already exists; the seed command itself
  // re-checks and only ever appends (`>>` — never clobbers). NEVER fail() here:
  // keyscan trouble prints a warning and continues to fetch, which produces
  // the real error message.
  const HOST = gitHost(REPO);
  r = ssh.run(`grep -q ${shQ(HOST)} ~/.ssh/known_hosts 2>/dev/null`);
  if (r.code !== 0) {
    r = ssh.run(
      `grep -q ${shQ(HOST)} ~/.ssh/known_hosts 2>/dev/null || { mkdir -p ~/.ssh && chmod 700 ~/.ssh; k=$(ssh-keyscan -t rsa,ecdsa,ed25519 ${shQ(HOST)} 2>/dev/null); if [ -n "$k" ]; then printf '%s\\n' "$k" >> ~/.ssh/known_hosts; else echo KEYSCAN-FAILED; fi; }`,
    );
    if ((r.stdout || '').includes('KEYSCAN-FAILED')) {
      out(`ERROR: ssh-keyscan ${HOST} returned no keys — fetch will likely fail with a host-key error`);
    }
  }

  r = ssh.run(`git -C ${DIR}/src/bot.git fetch --prune origin`, { timeoutMs: 120000 });
  if (r.code !== 0) {
    // Host-key failure: the seed above could not establish the key (keyscan
    // returned nothing / host network or DNS down). The deploy key is not the
    // problem here — no pubkey dump, no ADD DEPLOY KEY wording on this path.
    if (/Host key verification failed/.test(r.stderr || '')) {
      out(`fetch failed (code ${r.code}): ${(r.stderr || '').trim().slice(0, 400)}`);
      out(
        `HOST KEY: ${HOST} missing/broken in factory ~/.ssh/known_hosts (keyscan seed above failed). ` +
          `Check host network/DNS to ${HOST}, then re-run build.`,
      );
      return { ok: false, exit: 2, error: `git fetch host-key failure for ${HOST} (see HOST KEY hint)` };
    }
    // Almost-always cause: the public key has not been pasted into the repo's
    // Deploy keys settings yet. Print the key + the one-time instruction instead
    // of hanging or looping — the single human action in the whole flow.
    const pub = ssh.run(`cat ${GITHUB_KEY}.pub`);
    out(`fetch failed (code ${r.code}): ${(r.stderr || '').trim().slice(0, 400)}`);
    out(pub.stdout.trim());
    out(
      `ADD DEPLOY KEY: paste the public key above into GitHub → ${REPO} → Settings → ` +
        'Deploy keys (check "Read-only"), then re-run build.',
    );
    return { ok: false, exit: 2, error: 'git fetch auth failure — GitHub deploy key missing (see ADD DEPLOY KEY hint)' };
  }

  // Ref resolution: this clone was created `git init --bare` + `git remote add
  // origin`, whose fetch refspec stores branches ONLY under
  // refs/remotes/origin/<name> (refs/heads/* stays empty), so a bare rev-parse of
  // the ref dies exit 128. One compound rev-parse (remote-side `||`
  // short-circuit, same contract as the known_hosts seed step) costs exactly 1
  // round-trip on EVERY success path: refs/remotes/origin/<ref> → refs/tags/<ref>
  // → raw ref (tolerates clone --bare hosts + raw shas). --verify on EVERY form
  // is mandatory: plain rev-parse echoes args it cannot resolve VERBATIM to
  // stdout on failure (2>/dev/null cannot suppress that), which would prepend
  // the missed form names ahead of the winner's sha and break SHA_RE (false
  // all-miss on tag/raw-sha deploys); --verify suppresses that echo-back, so a
  // failed form prints its diagnostics to stderr only and stdout = the winner's
  // full sha. First hit wins; last stderr kept for the all-miss hint.
  r = ssh.run(
    `git -C ${DIR}/src/bot.git rev-parse --verify ${shQ(`refs/remotes/origin/${ref}^{commit}`)} 2>/dev/null` +
      ` || git -C ${DIR}/src/bot.git rev-parse --verify ${shQ(`refs/tags/${ref}^{commit}`)} 2>/dev/null` +
      ` || git -C ${DIR}/src/bot.git rev-parse --verify ${shQ(`${ref}^{commit}`)}`,
  );
  const sha = r.stdout.trim();
  if (r.code !== 0 || !SHA_RE.test(sha)) {
    // All-miss: unambiguous (nonzero code or stdout failing SHA_RE). Dump the
    // refs that actually exist so the operator sees the layout (an empty repo
    // dumps empty — harmless), name all three attempted forms, exit 2 mirroring
    // deploySha's host-error shape (never fail()'s exit 1). Nothing downstream
    // (short/archive/docker) runs.
    const d = ssh.run(`git -C ${DIR}/src/bot.git show-ref`);
    out(`ATTEMPTED: refs/remotes/origin/${ref}^{commit} | refs/tags/${ref}^{commit} | ${ref}^{commit}`);
    out(`show-ref:\n${d.stdout || d.stderr}`);
    return {
      ok: false,
      exit: 2,
      error: `cannot resolve ref ${ref} — tried refs/remotes/origin/${ref}, refs/tags/${ref}, ${ref} (show-ref dumped above)`,
    };
  }

  r = ssh.run(`git -C ${DIR}/src/bot.git rev-parse --short=7 ${shQ(sha)}`);
  const short = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{7}$/.test(short)) return fail(r, 'rev-parse --short=7');

  // rm -rf before extract: no stale files leak between shas. config/ and data/
  // live OUTSIDE the extract (gitignored → absent from the archive) and are
  // never rewritten (live-truth rule, deploy-host.md §3).
  r = ssh.run(`rm -rf ${DIR}/src/work && mkdir -p ${DIR}/src/work`);
  if (r.code !== 0) return fail(r, 'work reset');

  r = ssh.run(`git -C ${DIR}/src/bot.git archive ${shQ(sha)} | tar -x -C ${DIR}/src/work`);
  if (r.code !== 0) return fail(r, 'archive extract');

  const image = `${IMG}:sha-${short}`;
  r = ssh.run(`cd ${DIR}/src/work && docker build --platform linux/amd64 -t ${image} .`, { timeoutMs: 1800000 });
  if (r.code !== 0) return fail(r, 'docker build');

  // Machine lines — scheduler parses these; they MUST be the last lines.
  out(`SHA=${sha}`);
  out(`SHORT=${short}`);
  out(`IMAGE=${image}`);
  return { ok: true, exit: 0, sha, short, image };
}

const INSPECT_FMT = '{{.Id}} {{.State.Status}} {{.Image}} {{.Config.Image}} {{index .Config.Labels "com.docker.compose.service"}}';

/**
 * deploy <sha> — full sequence (see header). `image` override selects the tag
 * (rollback passes the history entry's tag; its existence is still guarded by
 * `docker image inspect` → loud 'run build first', never a stray build because
 * every compose call runs `--no-build`).
 * @returns {{ok:boolean, exit:number, sha?:string, short?:string, image?:string,
 *            containers?:Array<{svc:string,cid:string,ref:string}>, digest?:string, error?:string}}
 */
export function deploySha({ ssh, cfg, sha, image, action = 'deploy', out = s => console.log(s) }) {
  if (!SHA_RE.test(String(sha))) {
    return { ok: false, exit: 2, error: `invalid sha ${JSON.stringify(sha)} — expected 7-40 hex (scheduler passes the full sha from build)` };
  }
  const { dir: DIR, imageRepo: IMG, actor } = cfg;
  const fail = (r, step) => ({ ok: false, exit: 1, error: `${step} failed (code ${r.code}): ${(r.stderr || r.stdout || '').trim().slice(0, 400)}` });

  let r;
  // Fresh-host preflight: the bare clone is created by `build`; deploying against
  // a host that never built must give the loud exit-2 hint, not a code-128 surprise.
  r = ssh.run(`test -d ${DIR}/src/bot.git`);
  if (r.code !== 0) {
    return { ok: false, exit: 2, error: `host clone ${DIR}/src/bot.git missing — run build <ref> first` };
  }
  // Local-first lookup; fetch only when the object is unknown to the clone.
  r = ssh.run(
    `git -C ${DIR}/src/bot.git cat-file -e ${shQ(`${sha}^{commit}`)} 2>/dev/null || git -C ${DIR}/src/bot.git fetch --prune origin`,
    { timeoutMs: 120000 },
  );
  if (r.code !== 0) return fail(r, 'cat-file/fetch');
  r = ssh.run(`git -C ${DIR}/src/bot.git cat-file -e ${shQ(`${sha}^{commit}`)}`);
  if (r.code !== 0) {
    return { ok: false, exit: 2, error: `sha ${sha} not on the host clone — run build <ref> first` };
  }

  r = ssh.run(`git -C ${DIR}/src/bot.git rev-parse ${shQ(`${sha}^{commit}`)}`);
  const full = r.stdout.trim();
  if (r.code !== 0 || !SHA_RE.test(full)) return fail(r, 'rev-parse full sha');
  r = ssh.run(`git -C ${DIR}/src/bot.git rev-parse --short=7 ${shQ(full)}`);
  const short = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{7}$/.test(short)) return fail(r, 'rev-parse --short=7');
  const tag = image || `${IMG}:sha-${short}`;

  r = ssh.run(`rm -rf ${DIR}/src/work && mkdir -p ${DIR}/src/work`);
  if (r.code !== 0) return fail(r, 'work reset');
  r = ssh.run(`git -C ${DIR}/src/bot.git archive ${shQ(full)} | tar -x -C ${DIR}/src/work`);
  if (r.code !== 0) return fail(r, 'archive extract');

  // The host compose file + the shipped classifier always match the deployed
  // sha's tree: this cp IS how deploy-host-logs.sh reaches the host (verify runs
  // the copy here via `bash`, its shebang interpreter — never a stale scp).
  r = ssh.run(`cp ${DIR}/src/work/docker-compose.yml ${DIR}/docker-compose.yml`);
  if (r.code !== 0) return fail(r, 'cp compose');
  r = ssh.run(`cp ${DIR}/src/work/scripts/deploy-host-logs.sh ${DIR}/deploy-host-logs.sh`);
  if (r.code !== 0) return fail(r, 'cp deploy-host-logs.sh');

  r = ssh.run(`docker image inspect ${tag} >/dev/null 2>&1`);
  if (r.code !== 0) {
    return { ok: false, exit: 2, error: `image ${tag} not built on host — run build <ref> first` };
  }

  // .deploy-env: exactly one line — the compose --env-file interpolation source
  // for ${BOT_IMAGE:-…}. Single-key by design so hand-added secrets can never be
  // clobbered by another deploy.
  r = ssh.run(`printf 'BOT_IMAGE=${tag}\\n' > ${DIR}/.deploy-env`);
  if (r.code !== 0) return fail(r, 'write .deploy-env');

  r = ssh.run(`cd ${DIR} && docker compose --env-file .deploy-env up -d --no-build --remove-orphans`, {
    timeoutMs: 120000,
  });
  if (r.code !== 0) return fail(r, 'compose up');

  r = ssh.run(`cd ${DIR} && docker compose --env-file .deploy-env ps -q`);
  const ids = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  if (r.code !== 0 || ids.length === 0) return fail(r, 'compose ps -q');

  r = ssh.run(`docker inspect -f ${shQ(INSPECT_FMT)} ${ids.join(' ')}`);
  if (r.code !== 0) return fail(r, 'docker inspect');
  const containers = [];
  let digest = '';
  for (const line of r.stdout.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length !== 5) continue;
    const [cid, status, imageId, ref, svc] = f;
    containers.push({ svc, cid, ref, status });
    if (!digest) digest = imageId; // same image across services; sha256 id = running-image digest
  }
  for (const c of containers) out(`CONTAINER ${c.svc} ${c.cid} ${c.ref}`);
  if (digest) out(`DIGEST ${digest}`);

  const entry = historyEntry({
    ts: new Date().toISOString(),
    sha: full,
    short,
    image: tag,
    actor,
    action,
  });
  r = ssh.run(`printf '%s\\n' ${shQ(entry)} >> ${DIR}/.deploy-history`);
  if (r.code !== 0) return fail(r, 'append .deploy-history');

  return { ok: true, exit: 0, sha: full, short, image: tag, containers, digest };
}

/**
 * rollback — target = second-to-last .deploy-history entry (the one before the
 * current). Rollbacks therefore bounce deterministically between the two shas;
 * history stays append-only truth.
 */
export function rollback({ ssh, cfg, out = s => console.log(s) }) {
  const DIR = cfg.dir;
  const r = ssh.run(`tail -n 2 ${DIR}/.deploy-history`);
  if (r.code !== 0) {
    return { ok: false, exit: 2, error: `nothing to roll back to (${DIR}/.deploy-history missing)` };
  }
  const entries = parseHistory(r.stdout);
  if (entries.length < 2) {
    return { ok: false, exit: 2, error: 'nothing to roll back to (fewer than 2 history entries)' };
  }
  const target = entries[entries.length - 2];
  return deploySha({ ssh, cfg, sha: target.sha, image: target.image, action: 'rollback', out });
}

// ---- CLI ------------------------------------------------------------------------

export function usage() {
  console.error('usage: node scripts/deploy.js build [ref] | deploy <sha> | rollback');
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, arg] = argv;
  if (!['build', 'deploy', 'rollback'].includes(cmd)) {
    usage();
    return 2;
  }
  const cfg = deployConfig();
  if (cfg.errors.length) {
    for (const e of cfg.errors) console.error(e);
    return 2;
  }
  const ssh = makeSSH(cfg);
  let res;
  if (cmd === 'build') res = build({ ssh, cfg, ref: arg || 'master' });
  else if (cmd === 'deploy') {
    if (!arg) {
      usage();
      return 2;
    }
    res = deploySha({ ssh, cfg, sha: arg });
  } else res = rollback({ ssh, cfg });

  if (!res.ok) {
    console.error(`deploy ${cmd}: ${res.error}`);
    return res.exit;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main();
}
