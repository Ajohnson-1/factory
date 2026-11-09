#!/usr/bin/env node
// prod-watch-from-box preflight probe (FM-5, card 6aee5f4d6e98279cb3ab3304;
// docs/factory-migration.md §4.6, §6.1 step 4).
//
// On the box, prod-watch probes DEPLOY_HOST — which IS the box itself —
// over ssh using the copied private key (`factory_deploy_ed25519`;
// ssh-to-self works because the public half is already in authorized_keys).
// This CLI verifies THAT EXACT transport BEFORE the prod-watch timer is
// enabled: it runs the identical ssh probe command prod-watch.js would run
// (reusing its sshProbe/buildProbeCmd/parseProbe — not a re-implementation)
// and reports the verdict. Zero board writes, zero state writes: safe
// alongside a live daemon, and the FM-6 preflight check for the
// "prod-watch once" acceptance hand.
//
// usage: node scripts/probe-factory-box.js
// exit:  0 = up (classifier clean or degraded-but-running)
//        1 = unreachable / unhealthy (probe transport or services)
//        2 = config error (DEPLOY_HOST unset — loud, zero remote calls,
//            same convention as prod-watch.js loadCfg)

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { deployConfig } from './lib/deploy-config.js';
import { parseProbe, sshProbe } from './prod-watch.js';

/**
 * Build the prod-watch cfg from .env/env exactly like loadCfg, plus the
 * box-local preflight errors (missing host, missing identity file).
 * @param {{env?: NodeJS.ProcessEnv, exists?: (p:string)=>boolean}} [opts]
 */
export function probeCfg({ env = process.env, exists = existsSync } = {}) {
  const cfg = deployConfig(env);
  const errors = [...(cfg.errors ?? [])];
  if (!exists(cfg.key)) {
    errors.push(`DEPLOY_KEY identity file missing (${cfg.key}) — copy the private half of factory_deploy_ed25519 into ~/.ssh (docs/factory-migration.md §6.1 step 4)`);
  }
  return {
    cfg: { host: cfg.host, dir: cfg.dir, key: cfg.key, expectedHost: env.PROD_WATCH_HOSTNAME || 'DiscordBot' },
    errors,
  };
}

/**
 * One from-box probe pass. `run` is prod-watch.js's command runner seam
 * (string command + timeout) so tests script the ssh round-trip.
 */
export function runProbeBox({ env = process.env, exists = existsSync, run } = {}) {
  const { cfg, errors } = probeCfg({ env, exists });
  if (errors.length) {
    return { ok: false, exitCode: 2, errors, probe: null };
  }
  // Exact prod-watch.js transport: same ssh flags, same probe command,
  // same verdict parser (sshProbe already wraps parseProbe).
  const probe = run ? sshProbe({ cfg, run }) : sshProbe({ cfg });
  const down = probe.kind === 'unreachable' || probe.kind === 'unhealthy';
  return {
    ok: !down,
    exitCode: down ? 1 : 0,
    host: cfg.host,
    selfProbe: true, // §4.6: from the box DEPLOY_HOST is the box itself
    probe,
  };
}

export async function main() {
  const r = runProbeBox();
  console.log(JSON.stringify(r, null, 2));
  return r.exitCode;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main();
}

// parseProbe re-exported for evidence/inspection symmetry with prod-watch.
export { parseProbe };
