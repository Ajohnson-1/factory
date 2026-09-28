# Handoff — Phase 2.3 (PR reviewer), carrying Phase 2.2's loose ends

Work from the repo root. Read `plan/2.3-pr-reviewer.md` first — it is the spec;
this file is what 2.2 learned about the ground underneath it. The plan of record
for 2.2's open issues is `plan/open-issues.md`; this file keeps the evidence.

Work from the repo root. Read `plan/2.2-agent-graph.md` first — it is the spec,
and it now carries the decision record and two spike sections that explain why
the code looks nothing like step 4 originally sketched. This file is what 2.2
learned about the ground underneath **2.3**, plus the loose ends 2.2 left.

## Repo state (verified, not assumed)

- HEAD `57ca83d`. Working tree clean. Nine commits since `3b8bb3d` (2.1).
- `npm test` → **413 passed, 3 skipped** (docker-gated integration tests).
  `npm run build`, `npm run typecheck` (which now runs **two** configs:
  `tsconfig.test.json` **and** `tsconfig.extension.json`) clean.
- Coverage: 93.09% lines overall. `src/agents/**` **90.14%** against an 85% gate
  added this phase (same bar as `src/agent/**`, for the same reason: token
  checks and budget checks fail silently — the code looks fine, the model just
  has more power than intended).
- `factory-agent` image rebuilt with the extension baked in; CI's image job runs
  `deploy/docker/build.sh`, so the Dockerfile's resolution guardrails are
  exercised on every push. They have already caught one of my own bugs.
- **The 2.2 definition of done is met.** `scripts/graph-smoke.ts` passed twice
  against the real stack: `ok in 315s`, 3 runs (`coder:ok, coder:ok,
  verifier:ok`), base `6339df9 -> ccdfa27`, two merge commits
  `factory: merge coder c1/c2` from separate child branches, no leaked worktrees
  or branches.

## What 2.2 actually built (the seams 2.3 must use)

| Seam | Where | Note for 2.3 |
|---|---|---|
| `runAgentInContainer(opts)` | `src/agent/container.ts` | Options object, so 2.3 adds nothing structural: it already takes `systemPrompt`, `model`, `excludeTools`, `extraEnv`, `containerName`, `timeoutMs` (which **kills by name**), `modelsFile`, `settingsFile` |
| `createAgentSpawner(deps).spawn(req)` | `src/agents/spawn.ts` | The reusable "run one role in one container, land its work" machine: semaphore, per-card merge lock, budget, timeout, `agent_runs` bookkeeping, summary text. A reviewer is **not** a merge-back role, so pass a role with `mergeBack: false, writesWork: false` |
| `ROLES` / `getRole` / `spawnableRoleIds()` | `src/agents/roles.ts` | `reviewer` is already registered, with a charter and `excludeTools`, and deliberately excluded from `spawnableRoleIds()` — 2.3 drives it from GitHub events, not from a planner |
| `createIpcServer({token, host, port, onSpawn})` | `src/agents/ipc.ts` | Generic JSONL/TCP request channel, LF-only framing, constant-time token compare, `close()` revokes. If a reviewer needs to ask the host for anything, this is the shape — do not invent a second protocol |
| `runCardGraph(deps)` | `src/agents/graph.ts` | The pattern for "one containerized agent that owns a card": mint token → listen → run container with `-e` extension + `extraEnv` → settle → **close in `finally`** |
| child worktrees + `mergeChildIntoBase` | `src/worker/worktree.ts` | `headCommit`, `changedFiles`, `diffStat`, `createChildWorktree`, `removeChildWorktree` — a reviewer's disposable checkout is `createChildWorktree(reviewId, "r1")` or a plain worktree; all git is `execFileSync`, never a shell |
| `agent_runs` | `src/state/store.ts` | `addRun/setRunDone/runsFor/countRuns/activeRuns`. Add a `review` role row the same way |
| `reportAgentEvent` + `agentStartedEmbed/agentDoneEmbed/agentLabel` | `src/worker/runner.ts`, `src/discord/embeds.ts` | `[coder-2] tool: edit`. Reuse for reviewer timeline |
| `makeGitRepo()`, `makeTempDir()` | `test/helpers/` | Real git in temp dirs is the house style. `vi.stubEnv("REPO_PATH", fixture.repoPath)` because the worktree helpers default-arg it |

**Graph vs single agent:** `runCard` branches on `deps.graph !== undefined ||
(!deps.runAgent && config.factory.agentGraph)`. `AGENT_GRAPH=0` is the MVP path,
and an injected `deps.runAgent` always wins. The push → PR → CI → Review tail is
shared. 2.3 hooks the **GitHub webhook**, not `runCard`.

## Facts about pi that cost real verification in 2.2 — do not re-derive

1. **`--tools` / `-t` is an allowlist that ALSO drops extension-registered custom
   tools**, even when you name them in the list. Verified: `-t
   read,grep,find,ls,spike_wait` → the model reported only
   `read, grep, find, ls` and refused the call. So any role with a custom tool
   cannot use `--tools`. The workaround is to ship the active set as data
   (`FACTORY_ACTIVE_TOOLS`) and have the extension call `pi.setActiveTools()` at
   `session_start` — verified to work, and it keeps custom tools.
2. **`pi.setActiveTools()` is not callable during extension loading.** Doing it in
   the factory aborts pi: `"Extension runtime not initialized. Action methods
   cannot be called during extension loading."` It belongs in `session_start`.
3. **`defineTool` is a no-op identity** (`dist/core/extensions/types.js:17-19`,
   `return tool`). A plain object passed to `pi.registerTool()` is equivalent, so
   an extension needs no runtime import of pi at all — only `Type` from
   `@earendil-works/pi-ai`.
4. **Extensions load in JSON mode, and `-e` is NOT blocked by `--no-approve`.**
   `--no-approve` only sets `projectTrustOverride=false` (`dist/cli/args.js:218`),
   which skips *project* `.pi/` files. Explicit command-line extensions load.
5. **There is no tool-execution timeout in pi.** The only timeouts are provider
   HTTP ones. A 25-second custom tool ran fine; sibling tool calls in one
   assistant message run **concurrently** (two 3 s calls started 9 ms apart and
   both ended ~3.02 s later).
6. **`httpIdleTimeoutMs` defaults to 300000 and `retry.provider.timeoutMs`
   inherits it.** A slow model is cut off inside pi long before
   `AGENT_TIMEOUT_MS`, and it looks like a broken agent. There is **no CLI flag
   and no env var** — `<agent-dir>/settings.json` is the only way in, hence
   `FACTORY_AGENT_SETTINGS_FILE`.
7. **A mounted extension cannot resolve pi's dependencies.** Imports resolve from
   the extension's own directory upward, and `@earendil-works/pi-ai` is nested at
   `$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works/`,
   not in the global root. From an arbitrary mount point: `ERR_MODULE_NOT_FOUND`.
   Hence the image bakes `/opt/factory/node_modules` symlinks and copies the
   extension in. Do not "simplify" this by mounting the extension file.
8. **Never write to stdout from an extension in JSON mode** — stdout *is* the event
   protocol. Diagnostics go to stderr (`createAgentEventCollector` ignores it).
9. **A container reaches a host listener bound to `127.0.0.1` on Docker Desktop**
   (verified), but on Linux `--add-host=host.docker.internal:host-gateway` arrives
   at the **bridge** address. `FACTORY_IPC_BIND` defaults to loopback, so **a real
   Linux deploy must widen it** — and then a per-run token is the only thing
   gating an endpoint that can start containers. This is still untested on Linux.
10. `pi --model` accepts `provider/id`, and ids containing `/` are fine
    (`vmlx/pxleng/Swift-Qwen3.8-…`). Verified against the local vmlx box;
    `models.json` is mounted per-agent, and a LAN base URL is reachable from the
    container (bridge NAT, not the host netfilter — 2.1 note 9 still applies).

## The lesson of BUG-1 (read this before writing your next fake)

`land()` measured a child with `git diff <base>...HEAD` **before** the host had
committed anything. A child container's `.git` is read-only, so a finished
child's work is *always* uncommitted, and its HEAD *is* its fork point — the
range was always empty, every successful coder was reported "changed no files",
and its work was discarded with zero merges.

**413 unit tests were green over this.** The reason was `committingFake`, which
made its own commits so the host path was reachable at all — it modelled a child
that cannot exist. A fake like that does not merely hide a bug; it converts
passing tests into evidence the bug is absent. Fixed in `4200c29`; every fake now
writes files and leaves them there, and two tests pin the regression.

**Consequence for 2.3:** the real-LLM smoke is not a nice-to-have, it is the only
thing so far that has caught an integration-level lie. If you add a flow, add the
smoke line for it.

## Open issues worth doing (2.2 leftovers, ranked)

**Plan of record: `plan/open-issues.md`** — that file has the steps, tests and
definition of done. What follows here is the *evidence*: the reproductions and the
mechanism, so the next session does not re-derive them.

1. **The run budget never resets, so a card can permanently lose its ability to
   spawn.** `countRuns(cardId)` is `COUNT(*) WHERE card_id=?` over all history,
   `agent_runs` has no attempt/generation column, and nothing anywhere issues a
   `DELETE` on it (grepped). `enqueue` is `INSERT OR IGNORE`, so re-dragging a card
   to Ready reuses the same row and the same count.

   **Reproduced, not inferred** — one attempt that spends all 12 runs, then a
   re-trigger:

   ```
   attempt 2, first spawn -> rejected
     summary: run budget exhausted for this card (12). Summarise what has landed
              and stop; do not spawn again.
   countRuns(CARD) = 12 | activeRuns = 0
   ```

   The second attempt can never spawn a single child. Needs an attempt column on
   `agent_runs` (budget counted per attempt) or a `resetRuns(cardId)` on the
   queued→running transition. There is also **no `/factory retry` command** despite
   PLAN.md listing one, so the webhook is currently the only re-trigger path — and
   it walks straight into this. Worth a test that fails before the fix: "a card
   re-queued after a failed attempt can spawn again".
2. **A wedged orchestrator can hold the factory for hours.**
   `orchestratorTimeoutMs = AGENT_TIMEOUT_MS * (maxAgentRuns + 1)` = 20 min × 13 =
   **260 minutes** at defaults, and `queue.ts` gates on a *global*
   `store.isRunning()`. One hung planner therefore blocks every other card for
   4.3 hours. Either cap the orchestrator independently (`ORCHESTRATOR_TIMEOUT_MS`)
   or make the worker gate per-card.
3. **Nothing reaps stale `agent_runs`.** If the process dies mid-card, rows stay
   `status='running'` forever: `/factory status` shows children that will never
   finish, and it feeds problem 1's count. A startup sweep (any `running` row whose
   card has no live job → mark `failed`) is small and removes a class of confusing
   operator reports.
4. **`deploy/setup-factory.sh` and `README.md` mention none of the 2.2 knobs**
   (`AGENT_GRAPH`, `MAX_PARALLEL_AGENTS`, `AGENT_TIMEOUT_MS`, `MAX_AGENT_RUNS`,
   `FACTORY_IPC_*`, `AGENT_MEMORY`, `AGENT_CPUS`, `FACTORY_AGENT_*_FILE`). Only
   `.env.example` documents them. The Linux `FACTORY_IPC_BIND` requirement in
   particular belongs in the deploy script, not just a comment.
5. **2.1 carry-overs still open:** the exfiltration canary has never run with a
   real provider key in the env (2 of 4 integration tests self-skip without one),
   and the live VPS check (amd64 image build, `--user` + writable `~/.pi/agent`,
   Discord embeds from a real container stream) has never been observed on a real
   Linux host.
6. **Unmeasured:** token spend per card, and whether the planner actually
   serialises tasks that touch the same file — both smoke runs were given two
   *independent* tasks, so the conflict-and-respawn path has unit coverage only.
   A card that deliberately overlaps two tasks is the test for it.

## The one 2.3 decision that needs a decision before code

2.3's reviewer is described as "containerized per 2.1, reviews the diff in a
disposable worktree, posts PR comments". Two things that does not yet answer:

- **Where do the comments get posted from?** Posting needs `GITHUB_TOKEN`, which
  by 2.1's rule must never enter a container. So the reviewer either (a) emits a
  structured report as text/JSON and the **host** parses and posts it — same shape
  as the graph's `spawn_agent` round-trip, and the host already has an IPC server
  to reuse — or (b) registers a `post_review` custom tool through the baked
  extension and posts per-tool-call over IPC. (b) is nicer for the model (it can
  post as it goes) and reuses `src/agents/ipc.ts` almost unchanged; (a) is less
  machinery. Do not solve this with a token in the container.
- **Triggering and de-duplication.** `opened` + `synchronized` on `factory/*`
  means a PR pushed 5 times gets reviewed 5 times, each a fresh model spend.
  Needs a decision: review every push, or coalesce (e.g. skip if a review for that
  commit SHA exists — which argues for recording reviews in a table rather than
  only in `agent_runs`).

Ask the user which before implementing. Also confirm whether the reviewer runs
through the graph (`spawn_agent` is closed to it by design) or standalone via the
webhook — 2.2's `spawnableRoleIds()` deliberately excludes it, so the second is
what the current code supports.

## How to re-run the real smoke

```
TEST_LLM=1 AGENT_MODEL=vmlx/<provider-model-id> FACTORY_AGENT_MODELS_FILE=$PWD/models.json MAX_PARALLEL_AGENTS=3 MAX_AGENT_RUNS=4 AGENT_TIMEOUT_MS=900000 npm run test:graph-smoke
```

- **Skip trap:** `TEST_LLM=1 FOO=bar \` with a trailing space after the backslash
  makes line 1 a bare, **unexported** assignment, so `npm` on line 2 never sees
  `TEST_LLM` and the smoke self-skips with no error. Keep them on one line.
- The smoke pre-flights the endpoint by reading the base URL out of the **same**
  `models.json` the container mounts. A dead or glacial endpoint produced the same
  all-red check list as a broken graph, which cost a debugging pass to separate.
- `AGENT_TIMEOUT_MS` above 5 minutes makes it write a matching `settings.json`
  itself (pi's 5-minute default would otherwise cut a slow model off mid-request).
- The vmlx box has been intermittent (`500 Internal gateway error` on raw
  `/v1/chat/completions`, port closed at times). Check it with a direct request
  before blaming `src/agents/`.

## Working rules that applied this phase

- **Verify, don't assume — and verify the thing the plan asserts.** Two of 2.2's
  three design changes came from testing a plan assumption rather than reading it:
  `--tools` and custom tools (would have shipped a planner with no spawn tool),
  and `factory/<card>/<run>` alongside `factory/<card>` (git refuses: refs are
  files, both directions). The plan said "verify exact built-in tool names at
  implementation time" and that one sentence led to the Option A tool model.
- **A green suite is not proof.** See BUG-1. Prefer real git fixtures and
  `stopReason`-accurate fakes over convenient ones, and when a fake has to do
  something a real component cannot, say so in the comment.
- When a plan step turns out wrong, implement the correction **and** write the
  deviation into the plan file (`plan/2.2-agent-graph.md` has "Status —
  implemented, with these deviations", eight numbered items, plus the two spike
  sections; copy that shape for 2.3).
- Keep `npm test` hermetic: no docker, no network, no real credentials. Anything
  needing docker goes behind `TEST_DOCKER=1`; anything needing a model behind
  `TEST_LLM=1`; both must report *why* they skipped.
- Commit messages are imperative and scoped, and say what was verified:
  `fix: commit a child's work on the host before measuring it`.
- Subagents have no shell in this setup: a worker cannot run `vitest` or `git`.
  Run their commands yourself, and be suspicious of a worker that reports success
  without saying it could not execute anything. One worker this phase found the
  git ref limitation on its own and flagged it rather than coding around it
  silently — that report was worth more than the tests it wrote.
