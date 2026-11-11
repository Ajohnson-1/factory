// Scheduling invariants for the factory auto-start daemon (docs/factory.md).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRegistry, repoForCard } from '../scripts/lib/factory-registry.js'
import {
  planDispatch,
  buildRunPrompt,
  agentArgs,
  plistXml,
  superviseDoneWatch,
  superviseCommentWatch,
  superviseBlockingChecks,
  STAGE_PROMPT_FILES,
  DEFAULT_MAX_PARALLEL,
  CRASH_TAG,
  RESTART_TAG,
  MAX_CRASH_RETRIES,
  CRASH_TAIL_LINES,
  CRASH_TAIL_CHARS,
  MAX_CRASH_COMMENT_CHARS,
  crashTail,
  crashCommentText,
  sigtermStopped,
  handleRunCrash,
  exitCodeStr,
  isStallCode,
  STALL_EXIT_CODE,
} from '../scripts/factory-daemon.js'
import { ensureBootstrapped } from '../scripts/lib/factory-launchd.js'
import { install as daemonInstall, uninstall as daemonUninstall, status as daemonStatus } from '../scripts/factory-daemon.js'
import { detectServiceManager } from '../scripts/lib/factory-platform.js'

describe('planDispatch (FM-2: board-keyed entries {board, cardId}, global cap)', () => {
  const E = (board, cardId) => ({ board, cardId })
  const B1 = 'Bboard1'
  const B2 = 'Bboard2'
  it('dispatches backlog up to the cap and queues the rest', () => {
    const { queue, dispatch } = planDispatch([], [E(B1, 'a'), E(B1, 'b'), E(B1, 'c')], new Set(), 2)
    expect(dispatch.map((e) => e.cardId)).toEqual(['a', 'b'])
    expect(queue.map((e) => e.cardId)).toEqual(['c'])
  })

  it('respects existing in-flight runs against the cap', () => {
    const { queue, dispatch } = planDispatch([], [E(B1, 'a'), E(B1, 'b')], new Set(['x', 'y']), 3)
    expect(dispatch.map((e) => e.cardId)).toEqual(['a'])
    expect(queue.map((e) => e.cardId)).toEqual(['b'])
  })

  it('never re-dispatches a card whose run is still alive', () => {
    const { queue, dispatch } = planDispatch([], [E(B1, 'a')], new Set(['a']), 3)
    expect(dispatch).toEqual([])
    expect(queue).toEqual([]) // left in Ready while running, not double-tracked
  })

  it('keeps queued cards in arrival order ahead of new arrivals', () => {
    const { queue, dispatch } = planDispatch([E(B1, 'c')], [E(B1, 'b'), E(B1, 'c')], new Set(), 3)
    expect(dispatch.map((e) => e.cardId)).toEqual(['c', 'b'])
    expect(queue).toEqual([])
  })

  it('drops a queued card once it leaves Ready (cancel)', () => {
    const { queue, dispatch } = planDispatch([E(B1, 'a')], [], new Set(), 3)
    expect(dispatch).toEqual([])
    expect(queue).toEqual([])
  })

  it('dispatches a waiting card when a slot frees', () => {
    const { queue, dispatch } = planDispatch([E(B1, 'z')], [E(B1, 'z')], new Set(), 3)
    expect(dispatch.map((e) => e.cardId)).toEqual(['z'])
    expect(queue).toEqual([])
  })

  it('is idempotent for a card already queued this tick', () => {
    const { queue, dispatch } = planDispatch([E(B1, 'a')], [E(B1, 'a')], new Set(), 3)
    expect(dispatch.map((e) => e.cardId)).toEqual(['a'])
    expect(queue).toEqual([])
  })

  // FM-2 acceptance: two boards polled concurrently — one global queue, one
  // global cap (FACTORY_MAX_PARALLEL bounds total in-flight runs ACROSS
  // boards, docs/factory-migration.md §4.3).
  it('interleaves two boards into one queue, cap stays global', () => {
    const { queue, dispatch } = planDispatch(
      [],
      [E(B1, 'a'), E(B2, 'b'), E(B1, 'c')],
      new Set(),
      1,
    )
    expect(dispatch).toEqual([E(B1, 'a')])
    expect(queue).toEqual([E(B2, 'b'), E(B1, 'c')]) // board order preserved, both boards queued
  })

  it('cancels a queued entry only when the card leaves ITS board (same id on another board is a different entry)', () => {
    const { queue, dispatch } = planDispatch([E(B2, 'a')], [E(B1, 'a')], new Set(), 3)
    expect(dispatch.map((e) => e.board)).toEqual([B1]) // B1/a is fresh; B2/a vanished from B2's Ready
    expect(queue).toEqual([])
  })

  it('queued entries from one board keep their place ahead of fresh arrivals on the other', () => {
    const { queue, dispatch } = planDispatch([E(B2, 'old')], [E(B1, 'new'), E(B2, 'old')], new Set(), 3)
    expect(dispatch.map((e) => e.cardId)).toEqual(['old', 'new'])
    expect(queue).toEqual([])
  })
})

describe('buildRunPrompt', () => {
  const prompt = buildRunPrompt({ id: '6ae4b88307df4b89018e8d7f', name: 'Add frobnicator' })

  it('scopes the run to the one card and the written contract', () => {
    expect(prompt).toContain('6ae4b88307df4b89018e8d7f')
    expect(prompt).toContain('docs/factory.md')
    expect(prompt).toContain('do not touch any other card')
  })

  it('forbids ending a headless session with pending subagents (FM-6 exit-0-no-verdict class)', () => {
    expect(prompt).toContain('HEADLESS')
    expect(prompt).toContain('NO next turn')
    expect(prompt).toContain('NEVER spawn one asynchronously and end the session')
  })

  it('names the branch after the card', () => {
    expect(prompt).toContain('factory/6ae4b88307df4b89018e8d7f')
  })

  it('runs the blocking security pass between review and QA', () => {
    expect(prompt).toContain('[SEC:PASS')
    expect(prompt).toContain('[SEC:FINDINGS]')
    expect(prompt).toContain('security-check')
    expect(prompt).toContain('docs/security-review.md')
    expect(prompt).toContain('REVIEW:APPROVE AND [SEC:PASS] after the latest [IMPL]')
  })

  it('seeds every stage subagent with its repo-owned prompt doc', () => {
    for (const stage of ['planner', 'implementer', 'reviewer', 'security-reviewer', 'qa']) {
      expect(prompt).toContain(STAGE_PROMPT_FILES[stage])
    }
    expect(prompt).toContain('override your harness role defaults')
    expect(prompt).toContain('docs/factory-prompts/<stage>.md')
  })

  it('seeds stage subagents with the curated per-stage context (card 6ae9676f16ee4be03420c2e6)', () => {
    expect(prompt).toContain('factory.js context')
    expect(prompt).toContain('<stage>')
    expect(prompt).toContain('audit-only')
    expect(prompt).toContain('Per-stage context')
  })

  it('gates the QA:PASS merge on the fresh-master guard, bounded re-gate loop, never force-push (card 6ae96773f672adf3d556b8ec)', () => {
    expect(prompt).toContain('node scripts/factory.js merge-guard factory/<id> master BEFORE merging')
    expect(prompt).toContain('re-run the merge gate')
    expect(prompt).toContain('loop ≤3')
    expect(prompt).toContain('needs-human park')
    expect(prompt).toContain('git merge --ff-only into master and run npm test')
    expect(prompt).toContain('combined re-test')
    expect(prompt).toContain('git reset --hard origin/master')
    expect(prompt).toContain('NEVER --force-push master')
  })

  it('instructs the pre-merge risk gate with needs-human park (no merge)', () => {
    expect(prompt).toContain('RISK GATE before merge')
    expect(prompt).toContain('factory.js approve')
    expect(prompt).toContain('[ASK]')
    expect(prompt).toContain('needs-human')
    expect(prompt).toContain('leave the card in QA, do NOT merge')
    expect(prompt).toContain('only ever happens post-gate')
  })

  it('re-keys the risk gate after a merge-guard re-gate rebase (post-rebase sha is the approved sha)', () => {
    expect(prompt).toContain('RE-RUN THE RISK GATE on the new tip')
    expect(prompt).toContain('the rebase changed the sha')
    expect(prompt).toContain('tier medium/high re-asks and blocks before merge')
    // the re-approve must sit inside the stale-master loop, before the merge
    const loop = prompt.slice(prompt.indexOf('re-run the merge gate'), prompt.indexOf('Then git merge --ff-only'))
    expect(loop).toContain('RE-RUN THE RISK GATE')
    expect(loop.indexOf('RE-RUN THE RISK GATE')).toBeLessThan(loop.indexOf('merge-guard again'))
  })

  it('names the Review-verify sub-step and the bounce counter', () => {
    expect(prompt).toContain('review-verify')
    expect(prompt).toContain('[REVIEW:VERIFY]')
    expect(prompt).toContain('bounces')
  })

  // FM-2 (docs/factory-migration.md §4.3): the REPO CONTEXT block — exact
  // paths and commands from config/factory-repos.json, so a run never has to
  // guess where its repo lives.
  const reg = loadRegistry({ env: {} })
  const BOT = reg.repos['discord-bot']

  it('embeds the REPO CONTEXT block from the effective registry default (factory)', () => {
    // buildRunPrompt's default repo resolves through loadRegistry()'s env
    // chain (FACTORY_REPOS_FILE machine-local override → committed config);
    // the expectation must read the SAME effective registry the prompt
    // renders from — on the box the daemon exports FACTORY_REPOS_FILE
    // (repoDir /opt/factory), so a committed-only compare failed every
    // blocking-check gate there. Routed repos below stay committed-registry
    // because they are passed to buildRunPrompt explicitly.
    const eff = loadRegistry()
    const p = buildRunPrompt({ id: '6ae4b88307df4b89018e8d7f', name: 'X' })
    expect(p).toContain('REPO CONTEXT (repo registry: config/factory-repos.json')
    expect(p).toContain('- repo: factory')
    expect(p).toContain(`- repoDir: ${eff.repos.factory.repoDir} (all git operations for this repo run here)`)
    expect(p).toContain('- deploy driver: self')
    expect(p).toContain('- All factory CLI invocations (node scripts/factory.js …) run from the FACTORY repo checkout, not the card worktree.')
    expect(p).toContain('Worktree bootstrap per the REPO CONTEXT block below (branch factory/6ae4b88307df4b89018e8d7f cut from origin/master)')
  })

  it('renders the routed repo: worktree path, worktree-add line, and the exact bootstrap recipe (discord-bot)', () => {
    const id = '6ae4b88307df4b89018e8d7f'
    const p = buildRunPrompt({ id, name: 'X' }, { repo: BOT })
    const wt = join(BOT.worktreeRoot, id)
    expect(p).toContain('- repo: discord-bot')
    expect(p).toContain(`- worktree: ${wt}`)
    expect(p).toContain(`  create: git -C ${BOT.repoDir} worktree add ${wt} -b factory/${id} origin/master`)
    expect(p).toContain('ln -s ../../discord-bot/node_modules node_modules')
    expect(p).toContain(`cp .env version.json ${wt}/`)
    expect(p).toContain(`test -f ${wt}/.env || cp `) // <factoryRoot> substituted
    expect(p).not.toContain('<wt>')
    expect(p).toContain('build: node scripts/deploy.js build master')
    expect(p).toContain('deploy: node scripts/deploy.js deploy <sha>')
    expect(p).toContain('rollback (after [VERIFY:FAIL]): node scripts/deploy.js rollback')
    expect(p).toContain('verify: node scripts/verify-deploy.js')
    expect(p).toContain('- deploy driver: docker-ssh')
  })
})

describe('DEFAULT_MAX_PARALLEL', () => {
  it('defaults to 1 — internal-first canary: the prod-watch window is the deploy canary interval (card 6ae96773f672adf3d556b8ec)', () => {
    expect(DEFAULT_MAX_PARALLEL).toBe(1)
    expect(buildRunPrompt({ id: 'x', name: 'Y' })).toContain('merge-guard')
  })
})

describe('agentArgs', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('runs unattended with time and cost guards', () => {
    delete process.env.FACTORY_MAX_TIME
    delete process.env.FACTORY_MAX_COST
    delete process.env.FACTORY_MODEL
    const argv = agentArgs('PROMPT')
    expect(argv.slice(0, 5)).toEqual(['-p', '--auto-approve', '--max-time', '12h', '--max-cost'])
    expect(argv[5]).toBe('100')
    expect(argv.at(-1)).toBe('PROMPT')
  })

  it('honors model/time/cost overrides', () => {
    process.env.FACTORY_MODEL = 'opus'
    process.env.FACTORY_MAX_TIME = '4h'
    process.env.FACTORY_MAX_COST = '25'
    const argv = agentArgs('P')
    expect(argv).toEqual(
      expect.arrayContaining(['--model', 'opus', '--max-time', '4h', '--max-cost', '25']),
    )
  })
})

describe('plistXml', () => {
  const xml = plistXml({ nodePath: '/Users/me/.local/bin/node' })

  it('launches the daemon via absolute paths launchd can resolve', () => {
    expect(xml).toContain('<string>/Users/me/.local/bin/node</string>')
    expect(xml).toContain('<string>run</string>')
    expect(xml).toContain('/scripts/factory-daemon.js')
  })

  it('extends PATH so git/omp/ssh resolve outside the shell profile', () => {
    expect(xml).toMatch(/<key>PATH<\/key><string>\/Users\/me\/\.local\/bin:\/usr\/local\/bin/)
  })

  it('starts at load and respawns on crash', () => {
    expect(xml).toContain('<key>RunAtLoad</key><true/>')
    expect(xml).toContain('<key>KeepAlive</key><true/>')
  })
})

describe('superviseDoneWatch', () => {
  // Fake sleep: records the restart delays, never touches real timers.
  const harness = ({ runWatch, shouldStop = () => false, restartMs = 5000 }) => {
    const logLines = []
    const sleepArgs = []
    const promise = superviseDoneWatch({
      runWatch,
      log: (m) => logLines.push(m),
      shouldStop,
      restartMs,
      sleep: async (ms) => {
        sleepArgs.push(ms)
      },
    })
    return { logLines, sleepArgs, promise }
  }

  it('starts the watcher exactly once and forwards log/shouldStop', async () => {
    const calls = []
    const { promise, sleepArgs } = harness({
      runWatch: async (opts) => {
        calls.push(opts)
        return { ok: true, stopped: true } // honored stop → supervisor exits cleanly
      },
    })
    await promise
    expect(calls).toHaveLength(1)
    expect(typeof calls[0].log).toBe('function')
    expect(typeof calls[0].shouldStop).toBe('function')
    expect(calls[0].shouldStop()).toBe(false) // daemon default: never stop
    expect(sleepArgs).toEqual([]) // clean stop ⇒ no restart sleep
  })

  it('restarts after runWatch rejects, logging the crash + sleeping restartMs', async () => {
    let n = 0
    const { promise, logLines, sleepArgs } = harness({
      runWatch: async () => {
        n += 1
        if (n === 1) throw new Error('fetch exploded')
        return { ok: true, stopped: true }
      },
      restartMs: 500,
    })
    await promise
    expect(n).toBe(2)
    expect(sleepArgs).toEqual([500])
    expect(logLines.some((l) => l.includes('crashed') && l.includes('fetch exploded'))).toBe(true)
    expect(logLines.some((l) => l.includes('restarting in 500ms'))).toBe(true)
  })

  it('restarts after an unexpected resolve without stopped:true', async () => {
    let n = 0
    const { promise, sleepArgs } = harness({
      runWatch: async () => {
        n += 1
        return n === 1 ? { ok: true } : { ok: true, stopped: true }
      },
      restartMs: 250,
    })
    await promise
    expect(n).toBe(2)
    expect(sleepArgs).toEqual([250]) // a resolve must not end supervision silently
  })

  it('returns promptly when runWatch honors shouldStop with stopped:true', async () => {
    const { promise, sleepArgs } = harness({
      runWatch: async () => ({ ok: true, stopped: true }),
    })
    await promise // resolves rather than looping forever
    expect(sleepArgs).toEqual([])
  })

  it('returns promptly when shouldStop flips true (runWatch still running)', async () => {
    let stop = false
    let n = 0
    const { promise, sleepArgs } = harness({
      runWatch: async () => {
        n += 1
        if (n === 2) stop = true // the poller observed shutdown between ticks
        return { ok: true } // a poller that never returns stopped:true itself
      },
      shouldStop: () => stop,
      restartMs: 50,
    })
    await promise // supervisor notices the flip at the next check, no third start
    expect(n).toBe(2)
    expect(sleepArgs).toEqual([50])
  })

  it('never rejects even when runWatch throws a non-Error', async () => {
    let n = 0
    const { promise, logLines } = harness({
      runWatch: async () => {
        n += 1
        if (n === 1) throw 'a bare string' // non-Error throw
        return { ok: true, stopped: true }
      },
      restartMs: 10,
    })
    await expect(promise).resolves.toBeUndefined()
    expect(n).toBe(2)
    expect(logLines.some((l) => l.includes('crashed') && l.includes('a bare string'))).toBe(true)
  })
})

describe('crashTail', () => {
  it('keeps every line when the log has fewer than maxLines', () => {
    expect(crashTail('alpha\nbeta\ngamma')).toBe('alpha\nbeta\ngamma')
  })

  it('keeps only the last maxLines lines when the log is longer', () => {
    const log = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n')
    const all = crashTail(log)
    expect(all.split('\n')).toHaveLength(CRASH_TAIL_LINES)
    expect(all.startsWith(`line${50 - CRASH_TAIL_LINES}\n`)).toBe(true)
    expect(all.endsWith('line49')).toBe(true)
    expect(crashTail('1\n2\n3\n4\n5', { maxLines: 2 })).toBe('4\n5') // option override
  })

  it('char-trims a huge line keeping the newest end behind a … (trimmed) marker', () => {
    const huge = 'a'.repeat(CRASH_TAIL_CHARS + 500) + 'BOOM-END'
    const tail = crashTail(huge)
    expect(tail.startsWith('… (trimmed)')).toBe(true)
    expect(tail.length).toBe('… (trimmed)'.length + CRASH_TAIL_CHARS)
    expect(tail.endsWith('BOOM-END')).toBe(true) // most recent content survives
  })

  it('drops trailing blank lines', () => {
    expect(crashTail('a\nb\n\n   \n')).toBe('a\nb')
  })

  it('returns empty string for empty or whitespace-only input', () => {
    expect(crashTail('')).toBe('')
    expect(crashTail('   \n\t\n \n')).toBe('')
  })
})

describe('crashCommentText', () => {
  // Unified builder (C-M4 tail + C-M5 stage-aware modes): the exit-code-only
  // head per mode, quoted verbatim (docs/factory.md "Auto-start daemon");
  // with no usable log text the comment is byte-identical to that head for
  // EVERY mode. The old resume "leave-in-place" branch became the
  // stage-aware resume head (its Ready re-queue exception is superseded).
  const branches = [
    [
      'park at cap',
      1,
      MAX_CRASH_RETRIES,
      { mode: 'park' },
      `[DAEMON-CRASH] run exited 1 after ${MAX_CRASH_RETRIES} prior crash(es); parking needs-human where it stands`,
    ],
    [
      're-queue',
      1,
      0,
      { mode: 'requeue', crashRetries: MAX_CRASH_RETRIES },
      `[DAEMON-CRASH] run exited 1; re-queueing to Ready (crash 1/${MAX_CRASH_RETRIES + 1})`,
    ],
    [
      'stage-aware resume',
      'SIGTERM',
      1,
      { mode: 'resume', stage: 'Verify', crashRetries: MAX_CRASH_RETRIES },
      `[DAEMON-CRASH] run exited SIGTERM; stage-aware resume at Verify (crash 2/${MAX_CRASH_RETRIES + 1})`,
    ],
  ]
  const emptyLogTexts = ['', '   \n\n  \n', undefined] // missing/unreadable/empty log

  it.each(branches)('no-tail comment is byte-identical to the head: %s', (_name, code, prior, shape, expected) => {
    for (const logText of emptyLogTexts) {
      expect(crashCommentText(code, prior, { ...shape, logPath: 'data/factory-daemon/abc123.log', logText })).toBe(expected)
      expect(crashCommentText(code, prior, { ...shape, logText })).toBe(expected) // missing logPath too
    }
  })

  it('keeps the [DAEMON-CRASH] tag first and the first line byte-identical when a tail is present', () => {
    for (const [, code, prior, shape, expected] of branches) {
      const text = crashCommentText(code, prior, { ...shape, logPath: 'data/factory-daemon/abc123.log', logText: 'TypeError: boom\n  at run' })
      expect(text.startsWith(`${CRASH_TAG} `)).toBe(true) // startsWith counting stays intact
      expect(text.split('\n')[0]).toBe(expected) // append-after-first-line, never replace
    }
  })

  it('names the log path and embeds the tail lines verbatim', () => {
    const text = crashCommentText(
      1,
      0,
      {
        mode: 'requeue',
        crashRetries: MAX_CRASH_RETRIES,
        logPath: 'data/factory-daemon/abc123.log',
        logText: 'start\nmiddle\nTypeError: Cannot read properties of undefined\nexit 1',
      },
    )
    expect(text).toContain(`--- run log tail (data/factory-daemon/abc123.log, last ≤${CRASH_TAIL_LINES} lines / ≤${CRASH_TAIL_CHARS} chars) ---`)
    expect(text).toContain('TypeError: Cannot read properties of undefined\nexit 1')
  })

  it('carries the tail on every stage-aware recovery mode', () => {
    for (const mode of ['requeue', 'park', 'hold']) {
      const text = crashCommentText(1, 0, { mode, logPath: 'data/factory-daemon/abc.log', logText: 'the failure line' })
      expect(text).toContain('the failure line')
      expect(text).toContain('--- run log tail (')
    }
    const resume = crashCommentText(1, 0, { mode: 'resume', stage: 'QA', logPath: 'data/factory-daemon/abc.log', logText: 'the failure line' })
    expect(resume).toContain('the failure line')
    expect(resume.split('\n')[0]).toBe(`[DAEMON-CRASH] run exited 1; stage-aware resume at QA (crash 1/${MAX_CRASH_RETRIES + 1})`)
  })

  it('never exceeds the Trello comment-size guard on a pathological log', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `${'x'.repeat(95)}${String(i).padStart(5, '0')}`)
    const logText = `${lines.join('\n')}\n`
    const text = crashCommentText(1, 0, { logPath: 'data/factory-daemon/abc.log', logText })
    expect(text.length).toBeLessThanOrEqual(MAX_CRASH_COMMENT_CHARS)
    expect(text.endsWith(lines[lines.length - 1])).toBe(true) // newest line still present
  })

  it('falls back to the plain comment when even the tail section cannot fit', () => {
    const text = crashCommentText(1, 0, { logPath: 'p'.repeat(20000), logText: 'boom' })
    expect(text.length).toBeLessThanOrEqual(MAX_CRASH_COMMENT_CHARS)
    expect(text).toBe(`[DAEMON-CRASH] run exited 1; re-queueing to Ready (crash 1/${MAX_CRASH_RETRIES + 1})`)
  })
})

describe('ensureBootstrapped', () => {
  const LABEL = 'com.example.guard-test'
  const PLIST = '/tmp/guard-test.plist'
  const uid = process.getuid()

  // Scripted launchctl: `steps` is a list of { argv0: 'ok' | 'fail' } maps
  // consumed in call order; every call's argv is recorded.
  const harness = (steps) => {
    const calls = []
    const launch = async (argv) => {
      calls.push(argv)
      const step = steps[Math.min(calls.length - 1, steps.length - 1)]
      if (step[argv[0]] === 'fail') throw new Error(`launchctl ${argv[0]} failed`)
    }
    const sleep = async () => {}
    const promise = ensureBootstrapped({ label: LABEL, plist: PLIST, launch, sleep })
    return { calls, promise }
  }

  it('exits as soon as the job is visible, never bootstrapping', async () => {
    const { calls, promise } = harness([{ print: 'ok' }])
    await expect(promise).resolves.toBe(true)
    expect(calls).toEqual([['print', `gui/${uid}/${LABEL}`]])
  })

  it('bootstraps once when the caller died before bootstrap', async () => {
    const { calls, promise } = harness([{ print: 'fail' }, { print: 'ok' }])
    await expect(promise).resolves.toBe(true)
    expect(calls[1]).toEqual(['bootstrap', `gui/${uid}`, PLIST])
    expect(calls.filter((a) => a[0] === 'bootstrap')).toHaveLength(1)
  })

  it('survives a bootstrap rejected by a half-finished inline bootstrap', async () => {
    // print still missing → our bootstrap races the still-running inline one
    // ("already bootstrapped" error) → next print sees the loaded job.
    const { calls, promise } = harness([
      { print: 'fail' },
      { bootstrap: 'fail' },
      { print: 'ok' },
    ])
    await expect(promise).resolves.toBe(true)
    expect(calls.filter((a) => a[0] === 'bootstrap')).toHaveLength(1)
  })

  it('reports failure after exhausting retries', async () => {
    const calls = []
    const launch = async (argv) => {
      calls.push(argv)
      throw new Error('no such job')
    }
    await expect(
      ensureBootstrapped({ label: LABEL, plist: PLIST, launch, sleep: async () => {}, retries: 3 }),
    ).resolves.toBe(false)
    expect(calls.filter((a) => a[0] === 'bootstrap')).toHaveLength(3)
    expect(calls.at(-1)[0]).toBe('print') // final verdict is a fresh check
  })
})

describe('superviseCommentWatch', () => {
  // Comment-resume supervision (card 6ae89f208dab26fa65fe6b81) — the
  // structural twin of the superviseDoneWatch suite above.
  // Fake sleep: records the restart delays, never touches real timers.
  const harness = ({ runWatch, shouldStop = () => false, restartMs = 5000, isBusy, freeSlots, spawnRun }) => {
    const logLines = []
    const sleepArgs = []
    const promise = superviseCommentWatch({
      runWatch,
      log: (m) => logLines.push(m),
      shouldStop,
      restartMs,
      sleep: async (ms) => {
        sleepArgs.push(ms)
      },
      ...(isBusy ? { isBusy } : {}),
      ...(freeSlots ? { freeSlots } : {}),
      ...(spawnRun ? { spawnRun } : {}),
    })
    return { logLines, sleepArgs, promise }
  }

  it('starts the watcher exactly once and forwards log/shouldStop plus the daemon seams', async () => {
    const calls = []
    const isBusy = () => false
    const freeSlots = () => 2
    const spawnRun = async () => {}
    const { promise, sleepArgs } = harness({
      runWatch: async (opts) => {
        calls.push(opts)
        return { ok: true, stopped: true } // honored stop → supervisor exits cleanly
      },
      isBusy,
      freeSlots,
      spawnRun,
    })
    await promise
    expect(calls).toHaveLength(1)
    expect(typeof calls[0].log).toBe('function')
    expect(typeof calls[0].shouldStop).toBe('function')
    expect(calls[0].shouldStop()).toBe(false) // daemon default: never stop
    expect(calls[0].isBusy).toBe(isBusy) // runs-map dedup seam forwarded
    expect(calls[0].freeSlots).toBe(freeSlots) // concurrency-cap seam forwarded
    expect(calls[0].spawnRun).toBe(spawnRun) // spawn seam forwarded (daemon runs map registers resumes)
    expect(sleepArgs).toEqual([]) // clean stop ⇒ no restart sleep
  })

  it('restarts after runWatch rejects, logging the crash + sleeping restartMs', async () => {
    let n = 0
    const { promise, logLines, sleepArgs } = harness({
      runWatch: async () => {
        n += 1
        if (n === 1) throw new Error('fetch exploded')
        return { ok: true, stopped: true }
      },
      restartMs: 500,
    })
    await promise
    expect(n).toBe(2)
    expect(sleepArgs).toEqual([500])
    expect(logLines.some((l) => l.includes('crashed') && l.includes('fetch exploded'))).toBe(true)
    expect(logLines.some((l) => l.includes('restarting in 500ms'))).toBe(true)
  })

  it('restarts after an unexpected resolve without stopped:true', async () => {
    let n = 0
    const { promise, sleepArgs } = harness({
      runWatch: async () => {
        n += 1
        return n === 1 ? { ok: true } : { ok: true, stopped: true }
      },
      restartMs: 250,
    })
    await promise
    expect(n).toBe(2)
    expect(sleepArgs).toEqual([250]) // a resolve must not end supervision silently
  })

  it('returns promptly when runWatch honors shouldStop with stopped:true', async () => {
    const { promise, sleepArgs } = harness({
      runWatch: async () => ({ ok: true, stopped: true }),
    })
    await promise // resolves rather than looping forever
    expect(sleepArgs).toEqual([])
  })

  it('returns promptly when shouldStop flips true (runWatch still running)', async () => {
    let stop = false
    let n = 0
    const { promise, sleepArgs } = harness({
      runWatch: async () => {
        n += 1
        if (n === 2) stop = true // the watcher observed shutdown between ticks
        return { ok: true } // a watcher that never returns stopped:true itself
      },
      shouldStop: () => stop,
      restartMs: 50,
    })
    await promise // supervisor notices the flip at the next check, no third start
    expect(n).toBe(2)
    expect(sleepArgs).toEqual([50])
  })

  it('never rejects even when runWatch throws a non-Error', async () => {
    let n = 0
    const { promise, logLines } = harness({
      runWatch: async () => {
        n += 1
        if (n === 1) throw 'a bare string' // non-Error throw
        return { ok: true, stopped: true }
      },
      restartMs: 10,
    })
    await expect(promise).resolves.toBeUndefined()
    expect(n).toBe(2)
    expect(logLines.some((l) => l.includes('crashed') && l.includes('a bare string'))).toBe(true)
  })
})

describe('handleRunCrash (stage-aware crash recovery — card 6ae96770d68eed22d6069c6e)', () => {
  const READY = { id: 'L-ready', name: 'Ready', closed: false }
  const IMPL = { id: 'L-impl', name: 'Implement', closed: false }
  const VERIFY = { id: 'L-verify', name: 'Verify', closed: false }
  const DONE = { id: 'L-done', name: 'Done', closed: false }
  const NEEDS_HUMAN = { id: 'L-needs', name: 'needs-human' }
  const card = { id: '6ae96770d68eed22d6069c6e', name: 'Crash test card' }

  const cmt = (date, text) => ({ id: `c-${date}`, date, data: { text }, memberCreator: { id: 'botid' } })
  const crashCmt = (date, n) => cmt(date, `${CRASH_TAG} run exited 1; stage-aware resume at Implement (crash ${n}/3)`)
  const implVerdict = cmt('2026-11-03T01:00:00.000Z', '[IMPL] evidence — commit abc123')

  // Fake board: every trello call the crash path makes, scripted + recorded.
  const fakeT = ({ comments = [], idList = IMPL.id, getCardThrows = false, getListsThrows = false } = {}) => {
    const calls = { comments: [], getCard: [], getLists: 0, listsOpts: [], commentsWritten: [], moves: [], labels: 0, labelAdded: [] }
    return {
      calls,
      getCardComments: async (id) => {
        calls.comments.push(id)
        return comments
      },
      getCard: async (id) => {
        calls.getCard.push(id)
        if (getCardThrows) throw new Error('404: card gone')
        return { id, idList }
      },
      getLists: async (opts) => {
        calls.getLists += 1
        calls.listsOpts.push(opts)
        if (getListsThrows) throw new Error('429: rate limited')
        return [READY, IMPL, VERIFY, DONE, { id: 'L-closed', name: 'Archive', closed: true }]
      },
      addComment: async (id, text) => {
        calls.commentsWritten.push({ id, text })
      },
      moveCard: async (id, listId) => {
        calls.moves.push([id, listId])
      },
      getLabels: async () => {
        calls.labels += 1
        return [NEEDS_HUMAN]
      },
      addLabelToCard: async (id, labelId) => {
        calls.labelAdded.push([id, labelId])
      },
    }
  }
  const noop = () => {}

  it('re-queues to Ready when the card is in-flight with NO stage verdict (nothing committed to redo)', async () => {
    const t = fakeT({ comments: [crashCmt('2026-11-03T01:00:00.000Z', 1)] }) // 1 prior < cap 2
    const spawned = []
    await handleRunCrash({
      readRunLog: () => '',
      card,
      code: 1,
      t,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    expect(t.calls.getCard).toEqual([card.id]) // fresh board read — the closure card is stale
    expect(t.calls.moves).toEqual([[card.id, READY.id]])
    expect(spawned).toHaveLength(0)
    expect(t.calls.commentsWritten[0].text).toBe(
      '[DAEMON-CRASH] run exited 1; re-queueing to Ready (crash 2/3)',
    )
  })

  it('resumes at the card\'s CURRENT list with the crash prompt once a verdict exists — never a Ready re-queue', async () => {
    const t = fakeT({ comments: [implVerdict] })
    const spawned = []
    await handleRunCrash({
      readRunLog: () => '',
      card,
      code: 'SIGKILL',
      t,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    expect(t.calls.moves).toEqual([]) // committed work must not be redone
    expect(t.calls.labelAdded).toEqual([])
    expect(spawned).toHaveLength(1)
    const [c, prompt] = spawned[0]
    expect(c.id).toBe(card.id)
    expect(prompt).toContain('exited abnormally (SIGKILL)')
    expect(prompt).toContain('continue from Implement')
    expect(prompt).toContain('do NOT move the card back to Plan or Ready')
    expect(prompt).toContain(`../discord-bot-factory-wt/${card.id}`)
    expect(t.calls.commentsWritten[0].text).toContain('stage-aware resume at Implement (crash 1/3)')
  })

  it('inherits the resume-stage traps: [ROLLBACK]-last card in Verify resumes at Implement', async () => {
    const t = fakeT({
      comments: [cmt('2026-11-03T01:00:00.000Z', '[ROLLBACK] ok — restored last known-good')],
      idList: VERIFY.id,
    })
    const spawned = []
    await handleRunCrash({ readRunLog: () => '', card, code: 2, t, readyList: READY, log: noop, crashRetries: 2, spawnResumeRun: (c, p) => spawned.push([c, p]) })
    expect(spawned).toHaveLength(1)
    expect(spawned[0][1]).toContain('continue from Implement')
    expect(t.calls.commentsWritten[0].text).toContain('stage-aware resume at Implement')
  })

  it('inherits the stuck-Verify trap: [DEPLOY]-last card in Verify resumes at Verify', async () => {
    const t = fakeT({
      comments: [cmt('2026-11-03T01:00:00.000Z', '[DEPLOY] sha=a4e8f04 img=multibot-fix')],
      idList: VERIFY.id,
    })
    const spawned = []
    await handleRunCrash({ readRunLog: () => '', card, code: 1, t, readyList: READY, log: noop, crashRetries: 2, spawnResumeRun: (c, p) => spawned.push([c, p]) })
    expect(spawned[0][1]).toContain('continue from Verify')
  })

  it('parks needs-human WHERE IT STANDS at the crash cap — no move, no spawn', async () => {
    const t = fakeT({ comments: [implVerdict, crashCmt('2026-11-03T02:00:00.000Z', 1), crashCmt('2026-11-03T03:00:00.000Z', 2)] })
    const spawned = []
    await handleRunCrash({ readRunLog: () => '', card, code: 1, t, readyList: READY, log: noop, crashRetries: 2, spawnResumeRun: (c, p) => spawned.push([c, p]) })
    expect(t.calls.moves).toEqual([])
    expect(spawned).toHaveLength(0)
    expect(t.calls.labelAdded).toEqual([[card.id, NEEDS_HUMAN.id]])
    expect(t.calls.commentsWritten[0].text).toContain('parking needs-human where it stands (Implement)')
  })

  it('holds a Done card untouched — an agent that died AFTER finishing never re-runs', async () => {
    const t = fakeT({ comments: [implVerdict], idList: DONE.id })
    const spawned = []
    await handleRunCrash({ readRunLog: () => '', card, code: 1, t, readyList: READY, log: noop, crashRetries: 2, spawnResumeRun: (c, p) => spawned.push([c, p]) })
    expect(t.calls.moves).toEqual([])
    expect(t.calls.labelAdded).toEqual([])
    expect(spawned).toHaveLength(0)
    expect(t.calls.commentsWritten[0].text).toContain('Done — outside the in-flight pipeline, left untouched')
  })

  it('degrades to zero-move hold when the fresh board read throws (getCard / getLists)', async () => {
    for (const broken of [{ getCardThrows: true }, { getListsThrows: true }]) {
      const t = fakeT({ comments: [implVerdict], ...broken })
      const spawned = []
      const logLines = []
      await handleRunCrash({
        card,
        code: 1,
        t,
        readyList: READY,
        log: (m) => logLines.push(m),
        crashRetries: 2,
        spawnResumeRun: (c, p) => spawned.push([c, p]),
      })
      expect(t.calls.moves).toEqual([])
      expect(t.calls.labelAdded).toEqual([])
      expect(spawned).toHaveLength(0)
      expect(t.calls.commentsWritten).toHaveLength(1) // the crash comment still lands
      expect(t.calls.commentsWritten[0].text.startsWith(`${CRASH_TAG} `)).toBe(true)
      expect(logLines.some((l) => l.includes('board state unavailable') && l.includes('card untouched'))).toBe(true)
    }
  })

  it('defers the respawn when deferResume reports the entry is queued; spawns now when a slot is free', async () => {
    const t = fakeT({ comments: [implVerdict] })
    const spawned = []
    const deferred = []
    await handleRunCrash({
      readRunLog: () => '',
      card,
      code: 1,
      t,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
      deferResume: (entry) => {
        deferred.push(entry)
        return true // queued for the poll-loop drain
      },
    })
    expect(spawned).toHaveLength(0) // no slot — the drain owns the respawn
    expect(deferred).toHaveLength(1)
    expect(deferred[0].card.id).toBe(card.id)
    expect(deferred[0].prompt).toContain('exited abnormally (1)')
    expect(t.calls.commentsWritten[0].text).toContain('stage-aware resume at Implement') // comment lands either way

    const t2 = fakeT({ comments: [implVerdict] })
    const spawned2 = []
    await handleRunCrash({
      readRunLog: () => '',
      card,
      code: 1,
      t: t2,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned2.push([c, p]),
      deferResume: () => false, // slot free — spawn immediately
    })
    expect(spawned2).toHaveLength(1)
  })

  it('is a no-op while the daemon is shutting down', async () => {
    const t = fakeT({ comments: [implVerdict] })
    await handleRunCrash({
      readRunLog: () => '',
      card,
      code: null,
      t,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: () => {
        throw new Error('must not spawn during shutdown')
      },
      shuttingDown: () => true,
    })
    expect(t.calls.comments).toHaveLength(0) // not even fetched
    expect(t.calls.commentsWritten).toHaveLength(0)
    expect(t.calls.moves).toEqual([])
  })

  it('counts retries from the comment FIRST TOKEN only — prose mentions never spend the cap', async () => {
    const t = fakeT({
      comments: [
        cmt('2026-11-03T01:00:00.000Z', 'a human asks about the [DAEMON-CRASH] tag mid-sentence'),
        crashCmt('2026-11-03T02:00:00.000Z', 1), // the one genuine prior crash
        implVerdict,
      ],
    })
    const spawned = []
    await handleRunCrash({ readRunLog: () => '', card, code: 1, t, readyList: READY, log: noop, crashRetries: 2, spawnResumeRun: (c, p) => spawned.push([c, p]) })
    expect(t.calls.moves).toEqual([])
    expect(spawned).toHaveLength(1) // prior=1 < cap=2 → resume, not park
    expect(t.calls.labelAdded).toEqual([])
    expect(t.calls.commentsWritten[0].text).toContain('(crash 2/3)')
  })
  it('embeds the capped run-log tail in the crash comment through the unified path (C-M4 contract)', async () => {
    const t = fakeT({ comments: [implVerdict] })
    const spawned = []
    await handleRunCrash({
      readRunLog: () => 'start\nTypeError: boom\nexit 1',
      card,
      code: 1,
      t,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    const text = t.calls.commentsWritten[0].text
    expect(text.split('\n')[0]).toBe('[DAEMON-CRASH] run exited 1; stage-aware resume at Implement (crash 1/3)') // first line byte-identical
    expect(text).toContain('--- run log tail (')
    expect(text).toContain('TypeError: boom\nexit 1') // newest failure text travels with the comment
    expect(spawned).toHaveLength(1) // the tail never blocks the recovery respawn
  })

  it('a run-log read failure never blocks the comment or the recovery (byte-identical fallback)', async () => {
    const t = fakeT({ comments: [implVerdict] })
    const spawned = []
    await handleRunCrash({
      readRunLog: () => {
        throw new Error('EACCES: log unreadable')
      },
      card,
      code: 1,
      t,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    expect(t.calls.commentsWritten[0].text).toBe('[DAEMON-CRASH] run exited 1; stage-aware resume at Implement (crash 1/3)')
    expect(spawned).toHaveLength(1)
  })

  // ---- stall recovery (card 6aebab9a65613358f4ca333a — D1/D2/D4) ----

  it('D1: exit-0 stall on an IN-FLIGHT card recovers stage-aware — never silently ignored', async () => {
    const t = fakeT({ comments: [implVerdict] })
    const spawned = []
    await handleRunCrash({
      readRunLog: () => 'start\nWaiting on the job result\n',
      card,
      code: STALL_EXIT_CODE,
      t,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    expect(t.calls.getCard).toEqual([card.id])
    expect(t.calls.moves).toEqual([])
    expect(spawned).toHaveLength(1)
    expect(spawned[0][1]).toContain(`exited abnormally (${STALL_EXIT_CODE})`)
    expect(spawned[0][1]).toContain('continue from Implement')
    expect(t.calls.commentsWritten[0].text.split('\n')[0]).toBe(
      '[DAEMON-CRASH] run exited stalled (exit 0 with no verdict); stage-aware resume at Implement (crash 1/3)',
    )
    expect(t.calls.commentsWritten[0].text).toContain('Waiting on the job result') // C-M4 tail rides stalls too
  })

  it('D4: exit-0 stall on a DONE card holds SILENTLY — a healthy finish posts nothing', async () => {
    const t = fakeT({ comments: [implVerdict], idList: DONE.id })
    const spawned = []
    const logLines = []
    await handleRunCrash({
      readRunLog: () => '',
      card,
      code: STALL_EXIT_CODE,
      t,
      readyList: READY,
      log: (m) => logLines.push(m),
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    expect(t.calls.commentsWritten).toHaveLength(0) // done-watch owns the Done announcement
    expect(t.calls.moves).toEqual([])
    expect(t.calls.labelAdded).toEqual([])
    expect(spawned).toHaveLength(0)
    expect(logLines.some((l) => l.includes('comment suppressed') && l.includes('Done'))).toBe(true)
  })

  it('D4: a NON-ZERO crash on a DONE card still posts the byte-for-byte crash comment', async () => {
    const t = fakeT({ comments: [implVerdict], idList: DONE.id })
    await handleRunCrash({ readRunLog: () => '', card, code: 1, t, readyList: READY, log: noop, crashRetries: 2, spawnResumeRun: () => {} })
    expect(t.calls.commentsWritten).toHaveLength(1)
    expect(t.calls.commentsWritten[0].text).toBe(
      '[DAEMON-CRASH] run exited 1; card sits in Done — outside the in-flight pipeline, left untouched (crash 1/3)',
    )
  })

  it('D2: a pending [ASK] holds the card waiting on its human — silently; the [ASK] IS the board-visible wait', async () => {
    const asked = [
      cmt('2026-11-03T02:00:00.000Z', '[ASK] re-approve the post-rebase sha?'),
      implVerdict,
    ]
    const t = fakeT({ comments: asked, idList: VERIFY.id })
    const spawned = []
    const logLines = []
    await handleRunCrash({
      readRunLog: () => '',
      card,
      code: STALL_EXIT_CODE,
      t,
      readyList: READY,
      log: (m) => logLines.push(m),
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    expect(spawned).toHaveLength(0) // a resume would run under the human's feet
    expect(t.calls.moves).toEqual([])
    expect(t.calls.labelAdded).toEqual([])
    expect(t.calls.commentsWritten).toHaveLength(0) // card 6aee77a4db0dd0de45c77d7c: the pending [ASK] owns the trail — no stall report on top of it
    expect(logLines.some((l) => l.includes('pending [ASK] owns the reply'))).toBe(true)
  })

  it('D2: at the crash cap the ask-pending card still parks — silently; the crash comment is suppressed while the [ASK] owns the trail', async () => {
    // Example replay: card 6aee5f4d6e98279cb3ab3304 comment
    // 6af1ed5c4b3dd164aeeee2e0 — pending [ASK] (15:56), 2 prior [DAEMON-CRASH]
    // ⇒ park ⇒ stall report posted 74 s into an approval wait. Under the fix
    // the park decision stands but the comment could not have posted.
    const asked = [
      cmt('2026-11-03T02:00:00.000Z', '[ASK] still waiting?'),
      crashCmt('2026-11-03T03:00:00.000Z', 1),
      crashCmt('2026-11-03T04:00:00.000Z', 2),
      implVerdict,
    ]
    const t = fakeT({ comments: asked })
    const spawned = []
    const logLines = []
    await handleRunCrash({ readRunLog: () => '', card, code: STALL_EXIT_CODE, t, readyList: READY, log: (m) => logLines.push(m), crashRetries: 2, spawnResumeRun: (c, p) => spawned.push([c, p]) })
    expect(t.calls.labelAdded).toEqual([[card.id, NEEDS_HUMAN.id]]) // park beats ask-hold — decision unchanged
    expect(t.calls.commentsWritten).toHaveLength(0) // only the comment is silenced
    expect(t.calls.moves).toEqual([])
    expect(spawned).toHaveLength(0)
    expect(logLines.some((l) => l.includes('crash comment suppressed') && l.includes('pending [ASK] owns the reply'))).toBe(true)
  })

  it('a NON-ZERO crash under a pending [ASK] still posts the ask-pending hold comment byte-for-byte', async () => {
    const asked = [
      cmt('2026-11-03T02:00:00.000Z', '[ASK] Approval required — approve the deploy sha?'),
      implVerdict,
    ]
    const t = fakeT({ comments: asked, idList: VERIFY.id })
    await handleRunCrash({ readRunLog: () => '', card, code: 1, t, readyList: READY, log: noop, crashRetries: 2, spawnResumeRun: () => {} })
    expect(t.calls.commentsWritten).toHaveLength(1) // a true failure is new information the [ASK] cannot carry
    expect(t.calls.commentsWritten[0].text).toContain('a pending [ASK] owns the reply')
    expect(t.calls.commentsWritten[0].text).toContain('(Verify)')
  })

  it("'spawn-failed' under a pending [ASK] posts — the non-stall family is never suppressed", async () => {
    const asked = [cmt('2026-11-03T02:00:00.000Z', '[ASK] still waiting?'), implVerdict]
    const t = fakeT({ comments: asked })
    await handleRunCrash({ readRunLog: () => '', card, code: 'spawn-failed', t, readyList: READY, log: noop, crashRetries: 2, spawnResumeRun: () => {} })
    expect(t.calls.commentsWritten).toHaveLength(1)
  })

  it('a sweep orphan stall at the cap under a pending [ASK] parks silently (the sweep-race mirror of the example comment)', async () => {
    const asked = [
      cmt('2026-11-09T15:56:02.821Z', '[ASK] Approval required — approve deploy 539e8a4?'),
      crashCmt('2026-11-09T14:26:00.000Z', 1),
      crashCmt('2026-11-09T14:38:00.000Z', 2),
      implVerdict,
    ]
    const t = fakeT({ comments: asked, idList: VERIFY.id })
    const spawned = []
    await handleRunCrash({ readRunLog: () => '', card, code: 'stalled (orphan, silent 195 min)', t, readyList: READY, log: noop, crashRetries: 2, spawnResumeRun: (c, p) => spawned.push([c, p]) })
    expect(t.calls.labelAdded).toEqual([[card.id, NEEDS_HUMAN.id]]) // park decision stands
    expect(t.calls.commentsWritten).toHaveLength(0) // comment 6af1ed5c4b3dd164aeeee2e0 could not have posted
    expect(t.calls.moves).toEqual([])
    expect(spawned).toHaveLength(0)
  })

  it('a SIGTERM restart-stop under a pending [ASK] posts [DAEMON-RESTART] — the excluded class stays byte-identical', async () => {
    const asked = [cmt('2026-11-03T02:00:00.000Z', '[ASK] Approval required — approve the deploy sha?'), implVerdict]
    const t = fakeT({ comments: asked })
    await handleRunCrash({ readRunLog: () => restartLog, card, code: STALL_EXIT_CODE, t, readyList: READY, log: noop, crashRetries: 2, spawnResumeRun: () => {} })
    expect(t.calls.commentsWritten).toHaveLength(1)
    expect(t.calls.commentsWritten[0].text.startsWith(RESTART_TAG)).toBe(true)
  })

  it('a degraded hold with a pending [ASK] still posts the stall comment — board-state uncertainty deserves the record', async () => {
    const asked = [cmt('2026-11-03T02:00:00.000Z', '[ASK] still waiting?'), implVerdict]
    const t = fakeT({ comments: asked, getCardThrows: true })
    await handleRunCrash({ readRunLog: () => '', card, code: STALL_EXIT_CODE, t, readyList: READY, log: noop, crashRetries: 2, spawnResumeRun: () => {} })
    expect(t.calls.commentsWritten).toHaveLength(1) // degraded ⇒ !degraded fails ⇒ never suppressed
  })

  it('the healthy-exit silence NEVER leaks into sweep codes deciding resume (stall family posts)', async () => {
    const t = fakeT({ comments: [implVerdict] })
    const spawned = []
    await handleRunCrash({
      readRunLog: () => '',
      card,
      code: 'stalled (orphan, silent 195 min)',
      t,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    expect(t.calls.commentsWritten).toHaveLength(1) // resume mode always posts
    expect(t.calls.commentsWritten[0].text).toBe(
      '[DAEMON-CRASH] run exited stalled (orphan, silent 195 min); stage-aware resume at Implement (crash 1/3)',
    )
    expect(spawned).toHaveLength(1)
  })

  it('FM-2: board scopes the fresh board read; repo embeds the REPO CONTEXT in the resume prompt', async () => {
    const t = fakeT({ comments: [implVerdict] })
    const spawned = []
    const repo = {
      name: 'discord-bot',
      repoDir: '/srv/discord-bot',
      worktreeRoot: '/srv/discord-bot-factory-wt',
      baseBranch: 'master',
      board: 'ZZboard',
      deploy: { driver: 'docker-ssh' },
      worktreeBootstrap: ['cp .env <wt>/'],
    }
    await handleRunCrash({
      readRunLog: () => '',
      card,
      code: 'SIGKILL',
      t,
      readyList: READY,
      board: 'ZZboard',
      repo,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    expect(t.calls.listsOpts).toEqual([{ board: 'ZZboard' }]) // the per-board pass reads ITS board
    const [, prompt] = spawned[0]
    expect(prompt).toContain('REPO CONTEXT (repo registry: config/factory-repos.json')
    expect(prompt).toContain(`Reuse the existing worktree and branch factory/${card.id} if present (git worktree at ${join('/srv/discord-bot-factory-wt', card.id)})`)
    expect(prompt).toContain(`cp .env ${join('/srv/discord-bot-factory-wt', card.id)}/`)
    expect(prompt).not.toContain('../discord-bot-factory-wt/') // no stale hard-coded path
  })

  // --- the self-deploy class (card 6af1fa46fecb634350948a5d) ---------------
  // A `factory` run deploys by restarting the daemon it runs under; the
  // daemon's shutdown forwards SIGTERM to the run, so EVERY self-deploy ends
  // the same way — omp dies mid-Verify writing its `[Stopped by SIGTERM]` +
  // `[Recovery]` block. That stop is EXPECTED: RESTART_TAG comments track it
  // invisibly to the crash cap, the card resumes at once at its own stage.
  const restartLog = '# dispatch 2026-11-10T05:17:40.000Z omp ["-p","--auto-approve","--max-time","12h"]\nWorking...\n\n[Stopped by SIGTERM]\n[Recovery]\n  Main: omp --resume 01a1c35b-3e57-754a-a523-ef0cbe7dfd17\n'
  const cleanLog = '# dispatch 2026-11-10T05:17:40.000Z omp ["-p","--auto-approve","--max-time","12h"]\nWorking...\n'
  const restartCmt = (date, n) => cmt(date, `${RESTART_TAG} run stopped by SIGTERM (daemon restart); stage-aware resume at Verify (restart ${n}/3)`)

  it('sigtermStopped reads ONLY the last dispatch section', () => {
    expect(sigtermStopped('')).toBe(false)
    expect(sigtermStopped(cleanLog)).toBe(false)
    expect(sigtermStopped(restartLog)).toBe(true)
    // historical markers in older sections must not classify a fresh death
    expect(sigtermStopped(`# dispatch 2026-11-09T22:02:04Z old\nWorking...\n[Stopped by SIGTERM]\n[Recovery]\n${cleanLog.trimEnd()}`)).toBe(false)
    expect(sigtermStopped('[Stopped by SIGTERM]')).toBe(true) // headerless text → whole log
    expect(sigtermStopped(undefined)).toBe(false)
  })

  it('SIGTERM stop ignores the crash cap: RESTART_TAG comment + stage-aware resume (canary repro at Verify)', async () => {
    // The canary's exact shape: 2 prior [DAEMON-CRASH] (≥ cap 2) + [IMPL]
    // verdict + card in Verify + SIGTERM-killed run log. Old behavior: park
    // (crash 9, needs-human, 2026-11-10T05:17:52Z). New: resume at Verify.
    const t = fakeT({
      comments: [implVerdict, crashCmt('2026-11-03T02:00:00.000Z', 1), crashCmt('2026-11-03T03:00:00.000Z', 2)],
      idList: VERIFY.id,
    })
    const spawned = []
    await handleRunCrash({
      readRunLog: () => restartLog,
      card,
      code: 'stalled (orphan, silent 0 min)',
      t,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    expect(t.calls.labelAdded).toEqual([]) // never parked
    expect(t.calls.moves).toEqual([]) // committed stage work
    expect(spawned).toHaveLength(1)
    expect(spawned[0][1]).toContain('continue from Verify')
    expect(t.calls.commentsWritten[0].text.split('\n')[0]).toBe(
      '[DAEMON-RESTART] run stopped by SIGTERM (daemon restart); stage-aware resume at Verify (restart 1/3)',
    ) // the Factor-9 log tail follows below the head
    expect(t.calls.commentsWritten[0].text).toContain('[Stopped by SIGTERM]') // tail embedded for the resume
  })

  it('a CONSECUTIVE restart-stop storm parks needs-human (daemon flap = operator territory)', async () => {
    const t = fakeT({
      comments: [implVerdict, restartCmt('2026-11-03T04:00:00.000Z', 1), restartCmt('2026-11-03T05:00:00.000Z', 2)],
      idList: IMPL.id,
    })
    const spawned = []
    await handleRunCrash({
      readRunLog: () => restartLog,
      card,
      code: 'stalled (orphan, silent 0 min)',
      t,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    expect(t.calls.labelAdded).toEqual([[card.id, NEEDS_HUMAN.id]])
    expect(spawned).toHaveLength(0)
    expect(t.calls.commentsWritten[0].text.split('\n')[0]).toBe(
      '[DAEMON-RESTART] run stopped by SIGTERM (daemon restart) after 2 prior restart-stop(s); parking needs-human where it stands (Implement)',
    )
  })

  it('progress between stops breaks the storm — self-deploy #2 after a [DEPLOY] still resumes', async () => {
    const t = fakeT({
      comments: [
        implVerdict,
        restartCmt('2026-11-03T04:00:00.000Z', 1),
        cmt('2026-11-03T05:00:00.000Z', '[DEPLOY] sha=7d048ab — self driver'),
      ],
      idList: VERIFY.id,
    })
    const spawned = []
    await handleRunCrash({
      readRunLog: () => restartLog,
      card,
      code: 'stalled (orphan, silent 0 min)',
      t,
      readyList: READY,
      log: noop,
      crashRetries: 2,
      spawnResumeRun: (c, p) => spawned.push([c, p]),
    })
    expect(spawned).toHaveLength(1) // [DEPLOY]-last Verify resumes at Verify (trap inherited)
    expect(spawned[0][1]).toContain('continue from Verify')
    expect(t.calls.commentsWritten[0].text.split('\n')[0]).toBe(
      '[DAEMON-RESTART] run stopped by SIGTERM (daemon restart); stage-aware resume at Verify (restart 1/3)',
    )
  })

  it('crashCommentText restartStopped: identical shapes under RESTART_TAG', () => {
    expect(crashCommentText(1, 0, { mode: 'requeue', crashRetries: 2, restartStopped: true })).toBe(
      '[DAEMON-RESTART] run stopped by SIGTERM (daemon restart); re-queueing to Ready (restart 1/3)',
    )
    expect(crashCommentText('SIGTERM', 1, { mode: 'hold', stage: 'QA', crashRetries: 2, holdReason: 'ask-pending', restartStopped: true })).toBe(
      '[DAEMON-RESTART] run stopped by SIGTERM (daemon restart); a pending [ASK] owns the reply — left waiting on the human (QA) (restart 2/3)',
    )
    // crash wording stays byte-identical when the flag is absent (existing
    // byte tests above; this pins the default-off branch of the refactor)
    expect(crashCommentText(1, 0, { mode: 'requeue', crashRetries: 2 })).toBe(
      '[DAEMON-CRASH] run exited 1; re-queueing to Ready (crash 1/3)',
    )
  })
})

// FM-2 card acceptance: a `repo:discord-bot`-labelled card on the softwarefactory
// board must get a discord-bot worktree — label → registry repo → worktree path
// in the dispatched prompt (dispatch itself uses exactly this chain).
describe('FM-2 dispatch routing (repo: label → registry repo → worktree prompt)', () => {
  const reg = loadRegistry({ env: {} })

  it('routes the labelled card past the softwarefactory board default into discord-bot', () => {
    const card = {
      id: '6ae4b88307df4b89018e8d7f',
      name: 'FM-2 canary',
      labels: [{ name: 'Factory Migrations' }, { name: 'repo:discord-bot' }],
    }
    const routing = repoForCard(reg, { labels: card.labels, board: 'LLNG5MAm' }) // softwarefactory board default = factory
    expect(routing.ok).toBe(true)
    expect(routing.source).toBe('label')
    expect(routing.repo.name).toBe('discord-bot')
    const prompt = buildRunPrompt(card, { repo: routing.repo })
    expect(prompt).toContain(`- worktree: ${join(routing.repo.worktreeRoot, card.id)}`)
    expect(prompt).toContain('- deploy driver: docker-ssh')
    // worktree bootstrap recipe for the discord-bot worktree
    expect(prompt).toContain('ln -s ../../discord-bot/node_modules node_modules')
  })

  it('an unknown repo label fails closed (the daemon [ASK]s + leaves the card in Ready — zero spawn)', () => {
    const routing = repoForCard(reg, { labels: [{ name: 'repo:nope-bot' }], board: 'LLNG5MAm' })
    expect(routing.ok).toBe(false)
    expect(routing.reason).toBe('unknown-repo')
  })
})

describe('exitCodeStr / isStallCode (D1 stall codes — card 6aebab9a65613358f4ca333a)', () => {
  it('maps exit 0 to the stall code; non-zero/sig/null keep the old shapes', () => {
    expect(exitCodeStr(0, null)).toBe('stalled (exit 0 with no verdict)')
    expect(exitCodeStr(1, null)).toBe(1)
    expect(exitCodeStr(2, null)).toBe(2)
    expect(exitCodeStr(null, 'SIGKILL')).toBe('SIGKILL')
    expect(exitCodeStr(null, null)).toBe('null')
  })

  it('recognizes stall-family codes only', () => {
    expect(isStallCode(STALL_EXIT_CODE)).toBe(true)
    expect(isStallCode('stalled (orphan, silent 195 min)')).toBe(true)
    expect(isStallCode(1)).toBe(false)
    expect(isStallCode('SIGKILL')).toBe(false)
    expect(isStallCode('spawn-failed')).toBe(false)
    expect(isStallCode(null)).toBe(false)
  })
})

describe('daemon stall-sweep wiring pins (card 6aebab9a65613358f4ca333a)', () => {
  const src = readFileSync(new URL('../scripts/factory-daemon.js', import.meta.url), 'utf8')

  it('both exit handlers route EVERY exit through crashRecovery (no code !== 0 gate left)', () => {
    expect(src.match(/crashRecovery\(card, exitCodeStr\(code, sig\), (runCtx|ctx)\)/g)).toHaveLength(2)
    expect(src).not.toMatch(/if \(code !== 0\) crashRecovery/)
  })

  it('boot runs one sweep tick and supervision keeps it alive', () => {
    expect(src).toMatch(/await bootStallSweep\(\{/)
    expect(src).toMatch(/void superviseStallSweep\(\{/)
    expect(src).toMatch(/recover: \(orphanCard, code\) => crashRecovery/)
    expect(src).toMatch(/recover: \(stalledCard, code\) => crashRecovery/)
  })

  it('FM-2: every registered board gets its own boot sweep + supervised pollers (§4.3)', () => {
    expect(src).toMatch(/for \(const ctx of ctxs\) \{[\s\S]*?await bootStallSweep\(\{[\s\S]*?board: ctx\.board/)
    expect(src).toMatch(/for \(const ctx of ctxs\) \{[\s\S]*?runDoneWatch\(\{ \.\.\.opts, board: ctx\.board \}\)/)
    expect(src).toMatch(/runCommentResumeWatch\(\{ \.\.\.opts, board: ctx\.board, repoFor/)
    expect(src).toMatch(/runStallSweepWatch\(\{ \.\.\.opts, board: ctx\.board \}\)/)
    expect(src).toMatch(/runBlockingChecksWatch\(\{[\s\S]*?board: ctx\.board,[\s\S]*?worktreeOf:[\s\S]*?gitFor/)
    expect(src).toMatch(/boardIds\(repos\)/)
  })

  it('FM-4: the poll loop logs the first-successful-poll marker verify-factory greps (D6)', () => {
    expect(src).toMatch(/polledOk\.add\(ctx\.board\)[\s\S]{0,120}first successful poll since boot/)
    // verify-factory.js resolves the installed daemon's log via these exports
    expect(src).toMatch(/export const LABEL = 'com\.ajjohnson\.factory-daemon'/)
    expect(src).toMatch(/export const PLIST_PATH =/)
  })

  it('FM-4: boot orphan recovery uses zero silence — the `self` deploy restart resumes its own run at boot', () => {
    // A fresh daemon owns no children: every in-flight card without an owned
    // run is stranded (the self driver's restart kills its own caller run).
    // The periodic sweep keeps the max-time+grace window; boot must not wait.
    expect(src).toMatch(/bootStallSweep\(\{[\s\S]{0,120}silenceMs: 0,/)
  })
})

describe('superviseBlockingChecks', () => {
  // Blocking-checks gate supervision (card 6ae9677239bb2697a13ea728) — the
  // structural twin of the superviseCommentWatch suite, WITHOUT the
  // isBusy/freeSlots/spawnRun seams (the poller runs the suite itself; no
  // omp spawn). Fake sleep: records restart delays, never real timers.
  const harness = ({ runWatch, shouldStop = () => false, restartMs = 5000 }) => {
    const logLines = []
    const sleepArgs = []
    const promise = superviseBlockingChecks({
      runWatch,
      log: (m) => logLines.push(m),
      shouldStop,
      restartMs,
      sleep: async (ms) => {
        sleepArgs.push(ms)
      },
    })
    return { logLines, sleepArgs, promise }
  }

  it('starts the gate exactly once and forwards only log/shouldStop', async () => {
    const calls = []
    const { promise, sleepArgs } = harness({
      runWatch: async (opts) => {
        calls.push(opts)
        return { ok: true, stopped: true } // honored stop → supervisor exits cleanly
      },
    })
    await promise
    expect(calls).toHaveLength(1)
    expect(typeof calls[0].log).toBe('function')
    expect(typeof calls[0].shouldStop).toBe('function')
    expect(calls[0].shouldStop()).toBe(false) // daemon default: never stop
    expect(Object.keys(calls[0]).sort()).toEqual(['log', 'shouldStop']) // no spawn seams
    expect(sleepArgs).toEqual([]) // clean stop ⇒ no restart sleep
  })

  it('restarts after the gate crashes, logging the crash + sleeping restartMs', async () => {
    let n = 0
    const { promise, logLines, sleepArgs } = harness({
      runWatch: async () => {
        n += 1
        if (n === 1) throw new Error('suite poller exploded')
        return { ok: true, stopped: true }
      },
      restartMs: 500,
    })
    await promise
    expect(n).toBe(2)
    expect(sleepArgs).toEqual([500])
    expect(logLines.some((l) => l.includes('blocking-checks') && l.includes('crashed') && l.includes('suite poller exploded'))).toBe(true)
    expect(logLines.some((l) => l.includes('restarting in 500ms'))).toBe(true)
  })

  it('restarts after an unexpected resolve without stopped:true', async () => {
    let n = 0
    const { promise, sleepArgs } = harness({
      runWatch: async () => {
        n += 1
        return n === 1 ? { ok: true } : { ok: true, stopped: true }
      },
      restartMs: 250,
    })
    await promise
    expect(n).toBe(2)
    expect(sleepArgs).toEqual([250]) // a resolve must not end supervision silently
  })

  it('returns promptly when runWatch honors shouldStop with stopped:true', async () => {
    const { promise, sleepArgs } = harness({
      runWatch: async () => ({ ok: true, stopped: true }),
    })
    await promise
    expect(sleepArgs).toEqual([])
  })

  it('returns promptly when shouldStop flips true (gate still running)', async () => {
    let stop = false
    let n = 0
    const { promise, sleepArgs } = harness({
      runWatch: async () => {
        n += 1
        if (n === 2) stop = true // the gate observed shutdown between ticks
        return { ok: true } // a watcher that never returns stopped:true itself
      },
      shouldStop: () => stop,
      restartMs: 50,
    })
    await promise // supervisor notices the flip at the next check, no third start
    expect(n).toBe(2)
    expect(sleepArgs).toEqual([50])
  })

  it('never rejects even when runWatch throws a non-Error', async () => {
    let n = 0
    const { promise, logLines } = harness({
      runWatch: async () => {
        n += 1
        if (n === 1) throw 'a bare string' // non-Error throw
        return { ok: true, stopped: true }
      },
      restartMs: 10,
    })
    await expect(promise).resolves.toBeUndefined()
    expect(n).toBe(2)
    expect(logLines.some((l) => l.includes('crashed') && l.includes('a bare string'))).toBe(true)
  })
})

describe('FM-5 install/status/uninstall platform dispatch (docs/factory-migration.md D7)', () => {
  const mkSystemd = () => {
    const calls = []
    const rec = (name, result) => (...args) => { calls.push({ name, args }); return result }
    return {
      calls,
      installDaemon: rec('installDaemon', { installed: true, manager: 'systemd', unit: 'factory-daemon.service', unitFile: '/scratch/factory-daemon.service', envFile: '/scratch/factory-env.conf', start: 'started' }),
      uninstallDaemon: rec('uninstallDaemon', { uninstalled: true, manager: 'systemd', units: ['factory-daemon.service'] }),
      daemonStatus: rec('daemonStatus', { manager: 'systemd', units: [{ unit: 'factory-daemon.service', installed: true, active: 'active', sub: 'running', unitFileState: 'enabled' }] }),
    }
  }
  const count = (systemd, name) => systemd.calls.filter((c) => c.name === name).length
  let printed
  let realLog
  beforeEach(() => {
    printed = []
    realLog = console.log
    console.log = (...a) => printed.push(a.map(String).join(' '))
  })
  afterEach(() => { console.log = realLog })

  it('linux install delegates to the systemd unit installer (launchd untouched)', async () => {
    const systemd = mkSystemd()
    await daemonInstall({ platform: 'linux', systemd })
    expect(count(systemd, 'installDaemon')).toBe(1)
    expect(printed.some((l) => l.includes('"unit":"factory-daemon.service"'))).toBe(true)
  })

  it('linux uninstall delegates to systemd unit removal', async () => {
    const systemd = mkSystemd()
    await daemonUninstall({ platform: 'linux', systemd })
    expect(count(systemd, 'uninstallDaemon')).toBe(1)
    expect(printed.some((l) => l.includes('"uninstalled":true'))).toBe(true)
  })

  it('linux status delegates to systemd unit status', async () => {
    const systemd = mkSystemd()
    await daemonStatus({ platform: 'linux', systemd })
    expect(count(systemd, 'daemonStatus')).toBe(1)
    expect(printed[0]).toMatch(/"manager": "systemd"/)
  })

  it('unsupported platform: status prints the fail-closed message, never throws', async () => {
    const systemd = mkSystemd()
    await expect(daemonStatus({ platform: 'win32', systemd })).resolves.toBeUndefined()
    expect(printed.join('\n')).toMatch(/unsupported platform "win32"/)
    expect(count(systemd, 'daemonStatus')).toBe(0)
  })

  it('darwin dispatches to launchd with zero probing — the launchd suites above are the UNCHANGED proof', () => {
    expect(detectServiceManager({ platform: 'darwin', env: {} })).toBe('launchd')
  })
})
