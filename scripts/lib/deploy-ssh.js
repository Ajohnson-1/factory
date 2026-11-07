// SSH seam for scripts/deploy.js + scripts/verify-deploy.js
// (card 6ae4c8763f202fc86c57ef65).
//
// Design decision (plan §c): dependency-inject the runner function; the default
// runner is node child_process spawnSync('ssh', argvArray). Chosen over a
// PATH-fake `ssh` script because:
//   1. the unit under test is JS, so a native seam keeps the suite in-process —
//      deterministic, parallel-safe, no PATH mutation, no fixture executables;
//   2. ssh receives a structured argv array (no local shell interpolation), so a
//      fake that captures argv asserts exactly what the real runner passes;
//   3. the verify probe needs stdin payloads (runner `input`) which a PATH-fake
//      cannot exercise without reimplementing stdin plumbing.
// Every remote command is ONE string argument; quoting inside uses single-quoted
// literals only.

import { spawnSync } from 'node:child_process';

/**
 * Real runner: ssh with a structured argv array.
 * @param {{args:string[], input?:string, timeoutMs?:number}} spec
 * @returns {{code:number|null, stdout:string, stderr:string}} code=null on
 *          timeout/ENOENT/spawn failure (callers treat null as error).
 */
export function defaultRunner({ args, input, timeoutMs = 30000 }) {
  const r = spawnSync('ssh', args, { encoding: 'utf8', input, timeout: timeoutMs });
  if (r.status === null || r.status === undefined) {
    return { code: null, stdout: r.stdout || '', stderr: r.stderr || String(r.error?.message || 'ssh spawn failed or timed out') };
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * @param {{host:string,user:string,key:string}} cfg deployConfig() result
 * @param {(spec:{args:string[],cmd:string,input?:string,timeoutMs?:number})=>{code:number|null,stdout:string,stderr:string}} runner
 * @returns {{run(remoteCmd:string, opts?:{input?:string,timeoutMs?:number}):{code:number|null,stdout:string,stderr:string}, cfg:object}}
 */
export function makeSSH(cfg, runner = defaultRunner) {
  return {
    cfg,
    run(remoteCmd, opts = {}) {
      const args = [
        '-i',
        cfg.key,
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        `${cfg.user}@${cfg.host}`,
        remoteCmd,
      ];
      return runner({ args, cmd: remoteCmd, input: opts.input, timeoutMs: opts.timeoutMs ?? 30000 });
    },
  };
}
