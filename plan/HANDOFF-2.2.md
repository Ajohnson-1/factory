# Handoff — Phase 2.2 (agent graphs), carrying Phase 2.1's loose ends

Work from the repo root. Read `plan/2.2-agent-graph.md` first — it is the spec; this file
is what 2.1 learned about the ground underneath it.

## Repo state (verified, not assumed)

- HEAD `3b8bb3d` = phase 2.1 (secret isolation). Working tree clean.
- `npm test` → **251 passed, 3 skipped** (the skips are the docker-gated integration
  tests). `npm run build` and `npm run typecheck` clean.
- Coverage thresholds in `vitest.config.ts`: `src/agent/**` 85 lines (currently 99.2%),
  `src/worker/**` 70 (currently 87.0). 2.2 adds `src/agents/**` — add a threshold for it.
- `TEST_DOCKER=1 npx vitest run test/integration` → 3 pass against the real
  `factory-agent` image (built locally, pi 0.84.4).

## Seams 2.2 must build on

| Seam | Where | Note for 2.2 |
|---|---|---|
| `runAgentInContainer(opts): Promise<AgentRunResult>` | `src/agent/container.ts` | Takes a single **options object**, so adding `systemPrompt` / `model` / `tools` per role is additive, not a signature break |
| `AgentRunOptions`, `RunAgent`, `AgentRunResult` | `src/agent/types.ts` (re-exported from `runner.ts`) | Lives in `src/agent/` on purpose: runtimes must not import the worker |
| `WorktreeOps {create, remove, gitDir, commit, push}` | `src/worker/runner.ts` | 2.2's detached child worktrees + `merge --no-ff` belong **here**, as new methods with real-git tests — do not call `execFileSync` from the runner or the spawn tool |
| `createWorktree / worktreeDir / commonGitDir / commitWork / pushBranch` | `src/worker/worktree.ts` | All git is `execFileSync` (card ids are untrusted input; never interpolate into a shell string) |
| `createStore(dbPath)` | `src/state/store.ts` | The module-level `store` singleton **opens SQLite at import time** (bottom of the file). Anything that must stay import-cheap cannot reach `runner.ts` |
| `config.factory.*` | `src/config.ts` | Getters, not import-time snapshots, so `vi.stubEnv` works per test. Add `MAX_PARALLEL_AGENTS`, `AGENT_TIMEOUT_MS`, `MAX_AGENT_RUNS` the same way |
| `makeGitRepo() / remoteBranches() / log()` , `makeTempDir()` | `test/helpers/git.ts`, `test/helpers/tmp.ts` | Real git in temp dirs is the house style for worktree/merge tests |
| `vi.mock("node:child_process", …)` + a `PassThrough` fake child | `test/agent/container.test.ts` | Copy this pattern for `spawn.test.ts` / `graph-smoke`: it drives NDJSON, chunk splits, exit codes and spawn errors without Docker |

## Facts about pi that cost real verification in 2.1 — do not re-derive

1. **`pi --mode json` always exits 0**, even when the provider request failed. The
   `stopReason` check in `runPrintMode` is inside `if (mode === "text")`. Failure is only
   observable from `message_end` → `message.stopReason === "error" | "aborted"` +
   `message.errorMessage`. 2.2's per-child status and the orchestrator's "child failed,
   re-plan" signal must come from events, not the exit code.
2. JSONL framing: **split on LF only, never `node:readline`** — U+2028/U+2029 are legal
   inside JSON strings and readline splits on them (pi's own docs say this). Also handle a
   final record with no trailing LF, and records split across read chunks.
3. Tool flags (verified in `docs/cli.md`, 0.84.4): `-t/--tools` (allowlist),
   `-xt/--exclude-tools`, `-nbt/--no-builtin-tools`, `-nt/--no-tools`. Built-ins are
   `read, bash, edit, write, grep, find, ls`; **default enabled are `read, bash, edit,
   write`** unless `defaultTools` changes them. 2.2 step 4 asks to "verify exact built-in
   tool names" — done, use those.
4. Also available for roles: `--system-prompt <text|path>`, `--append-system-prompt`
   (repeatable), `--model <pattern>` / `--provider` / `--thinking`, `--no-session`,
   `--session-dir`, `-nc/--no-context-files` (skips `AGENTS.md`/`CLAUDE.md` discovery),
   `--offline`.
5. `--` (end of pi options) exists only in **pi ≥ 0.84.3**; 0.84.2 rejects it with
   `Error: Unknown option: --`. `deploy/docker/build.sh` therefore pins `PI_VERSION` from
   `package-lock.json`, not the caret range. If 2.2 introduces new CLI flags, check the
   minimum version the same way.
6. **A git worktree is not a repository.** Its `.git` is a one-line `gitdir:` pointer into
   the main clone, so an agent container needs `<repo>/.git` mounted **read-only at its
   own absolute path** or `git log/status/diff` all die with "not a git repository". That
   read-only mount is what makes commits impossible for the agent — which is why the
   **host** commits (`commitWork`) and why 2.2's child branches must be created and merged
   on the host, never inside the container.
7. Env into a container comes from `buildAgentEnv()` in `src/agent/env.ts`: container-side
   `PATH`/`HOME` + only provider keys that are set. OAuth state (`~/.pi/agent`) is never
   mounted. A container with no provider key fails with "No API key found for the selected
   model" (exit 1) — 2.2's parallel children multiply this cost, so keep the key set small
   and note per-child token spend in `agent_runs`.
8. `assertGitDirSafeToMount()` refuses to spawn when the mounted git config embeds
   credentials (`https://user:token@…`, `http.extraHeader`). It runs **before** every
   container. 2.2 spawns N containers per card — keep calling it, and don't cache a
   positive result across a `git remote set-url`.
9. Container network egress is **not** covered by the deploy script's nftables filter
   (container traffic is forwarded through docker's bridge, not locally generated by uid
   `pi`). Accepted risk; relevant if 2.2's `researcher` role gets web access.

## The one 2.2 design decision that needs a decision before code

2.2 specifies the **orchestrator agent runs in-process on the host**
(`createAgentSession({ cwd: baseDir, customTools: [spawnAgentTool], excludeTools: [...] })`)
justified by "it holds no write tools and never needs secrets". Phase 2.1's threat model
does not support that: an in-process pi session inherits the full orchestrator
`process.env` — the same thing 2.1 was built to prevent — and `excludeTools` only removes
tools from the model's reach, not from the process. Two options, both viable, different
work:

- **A. Orchestrator in a container too.** Needs custom tools to work across the JSON/RPC
  boundary (pi's RPC mode or an extension), so children are spawned by the *host* on the
  orchestrator's tool calls. More plumbing; keeps the boundary uniform.
- **B. Accept an in-process orchestrator, and shrink what it can see.** Run the
  orchestrator session in a child process with `buildAgentEnv()`-style scrubbed env (no
  Trello/GitHub/Discord/webhook vars), `--no-approve`, and read-only tools. Keeps
  `customTools` easy (in-process SDK), and the spawn tool becomes an IPC hop.

Ask the user which before implementing step 4. Do not assume "read-only tools" is a
security boundary — that is exactly the claim 2.1 exists to disallow.

## What 2.2's `customTools` assumption actually checks out as

Verified against the installed package (0.84.4):

- `customTools?: ToolDefinition[]` **is** on `AgentSessionConfig`
  (`dist/core/agent-session.d.ts:122`) and on the SDK options (`dist/core/sdk.d.ts:47`);
  `defineTool` is exported and documented (`docs/sdk.md:583-607`). So the **in-process**
  orchestrator in 2.2 step 4 is real.
- There is **no CLI flag** for custom tools (`grep custom-tool dist/cli/args.js` → nothing).
  The only way to get a custom tool into `pi --mode json` is an **extension** loaded with
  `-e <path>`, which registers it via `pi.registerTool()` (`docs/extensions.md:10`).
  Extensions run *inside* the pi process — so option A means the orchestrator's
  `spawn_agent` extension has to talk back out to the host (socket or an RPC-style file
  handshake) to start sibling containers. That is the real cost of option A, and it is
  worth knowing before committing to it.

Still unknown and worth a spike before implementing step 3: whether an extension's
custom tool can run long-lived/parallel (the `spawn_agent` semaphore + 4 concurrent
children) without tripping pi's tool timeout or serialising the session loop. Test it with
a dummy 20-second tool before wiring roles to it.

## Carry-over items from 2.1 (do these first, they're small)

1. **Run the pi-prompt exfiltration canary.** `TEST_DOCKER=1 npx vitest run
   test/integration` currently self-skips 2 of 4 tests because no provider API key is in
   the env (this box uses `~/.pi/agent/auth.json` OAuth, which by design never reaches a
   container). Needs one run with e.g. `ANTHROPIC_API_KEY` exported: it asserts the canary
   never appears in the full NDJSON and that the run really happened
   (`"type":"session"`, `tool_execution_start`, `agent_settled`). 2.1's Definition of Done
   is not complete until that passes.
2. **Live VPS check.** Run `deploy/setup-factory.sh` (installs `docker.io`, waits on
   `/run/docker.sock` with a Proxmox `nesting=1` pointer, migrates `factory/.env` →
   `/etc/factory/factory.env` 600 root, rebuilds the image on every deploy, installs the
   rewritten unit) and drive one real card. Two things were reasoned about but not
   observed on a real Docker/Linux host: (a) Discord still receives per-tool progress
   embeds from the container stream; (b) the `--user <uid>:<gid>` + `chmod 0777
   /home/agent` combination actually lets pi write `~/.pi/agent` as the factory user.
   Also confirm the image builds on **linux/amd64** — it was built and probed on
   linux/arm64.
3. **Container resource limits** (`--memory`, `--cpus` from config) were deferred to 2.2
   because parallel children are where pressure shows up. `buildDockerArgs` is the single
   place to add them, plus a pure-args test.

## Working rules that applied last phase

- Verify, don't assume — 2.1's plan contained three blockers that only showed up by
  running the real image and reading `dist/modes/print-mode.js`. Reproduce a failure in a
  real container before designing around it.
- When a plan step turns out to be wrong, implement the correction *and* write the
  deviation into the plan file (`plan/2.1-secret-isolation.md` has a
  "Deviations — what verifying instead of assuming changed" section to copy the shape of).
- Keep tests hermetic: no Docker, no network, no real credentials in `npm test`.
  Anything needing Docker goes behind `TEST_DOCKER=1` and reports why it skipped.
- Commit messages in this repo are imperative and scoped:
  `test: phase 2.0 — …`, `Secret isolation`, `factory init`.
