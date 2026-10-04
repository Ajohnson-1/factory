# Open issues — hardening 2.1–2.2 before 2.3

**Goal:** close the defects and operator-facing holes that phases 2.1–2.2 left
behind. These are not features, and they are not polish: #1 makes a re-triggered
card unable to do any work at all, and #2/#3 can wedge the whole factory. Land
this **before or alongside 2.3**, because the reviewer will start writing
`agent_runs` rows on every PR push and immediately hit #1, #3 and #6.

Evidence and reproductions live in `plan/HANDOFF-2.3.md`; this file is the plan
of record for fixing them. Ordered by blast radius.

---

## Status — the code half has landed

`npm test` → 483 passing, 3 docker-gated skips; `npm run typecheck`, `npm run
build`, `npm run test:coverage` all clean, thresholds held. What is *not* here is
the two things only a live run can give: #5 (provider key + VPS) and #1's "observed
once in `graph-smoke.ts`".

Three smaller holes are known and deliberately **not** fixed here, so the next
session does not rediscover them: `trello/webhook.ts:34` discards
`store.enqueue`'s result, so a re-drag while a card is `running` is dropped with
no operator feedback (the refusal is correct, the silence is not);
`setup-factory.sh`'s call to `configure_factory_env` sits in a `while` loop under
`set -o pipefail`, so a missing env file aborts the install mid-way rather than
skipping the step; and the `AGENT_RUNTIME=process` MVP path records no usage at
all (`runAgentProcess` returns `Promise<void>`), which is why #6's `reported`
count exists.

**One bug found while implementing #1, and it was bigger than #1.** `run_id` was
the whole PRIMARY KEY of `agent_runs` while `src/agents/spawn.ts` numbers children
from its own per-spawner counter (`c1`, `c2`, …). So the *second card the factory
ever processed* threw `UNIQUE constraint failed: agent_runs.run_id` on its first
child, and a re-triggered attempt would have thrown the same way — meaning #1 as
written would have shipped a card that can be re-queued and then fails anyway.
Reproduced before fixing, on a real database:

```
VERDICT — COLLISION: UNIQUE constraint failed: agent_runs.run_id
VERDICT — RETRIGGER COLLISION: UNIQUE constraint failed: agent_runs.run_id
```

Three consequences, all of them deliberate:

- `agent_runs` is keyed on `(card_id, run_id)`. SQLite cannot alter a primary key,
  so the migration copies the table into the new shape — that is part of the same
  boot-time `PRAGMA`/`ALTER` pass, and `test/state/store-attempts.test.ts` proves
  it against a database written by hand in the old shape.
- `setRunDone(cardId, runId, …)` takes the card now. Two cards both have a `c1`,
  and closing one must never close the other.
- A spawner seeds its counter from `store.countRuns(cardId)` over *all* attempts,
  so a re-triggered card's first child is `c3` rather than a colliding `c1`. It
  also reads better in the status view: `coder-7` on attempt two tells you the card
  has burned seven children.

Two other decisions worth recording: #2 went the **cap + always-`setFailed`**
route (per-card concurrency stays a design change for its own plan doc), and
`ORCHESTRATOR_TIMEOUT_MS` is floored at one child timeout — a planner that cannot
outlive its own slowest child loses legitimate work, which is worse than the hang
being capped. `scripts/graph-smoke.ts` raises the ceiling to the derived budget
when you raise `AGENT_TIMEOUT_MS`, the same way it already did for
`httpIdleTimeoutMs`, so a slow smoke run is not cut off by the new cap.

### Verification pass — four things this section overstated, now corrected

A fresh pass over the landed diff (suite green at 483, typecheck and coverage
 clean) found no BUG-1-class fake — the migration test really does hand-write the
old `run_id TEXT PRIMARY KEY` DDL, and the attempt plumbing runs against a real
store, a real git fixture and a real socket. It did find four claims that were
worth more than the code behind them:

1. **#6's last link was untested.** `container.ts` accumulated `usage` and
   `store.setRunDone` wrote it, but nothing asserted that a *spawned child's*
   `result.usage` reached its `agent_runs` row — the one line (`spawn.ts:352`)
   whose failure leaves every other test green and turns the cost guardrail back
   into a count guardrail. Now covered by `describe("token usage reaches
   agent_runs")` in `test/agents/spawn.test.ts`: reported usage lands on the row
   and in `usageByCard`, usage from a run that *failed* is kept rather than
   dropped, and a run that reported nothing stays NULL with `reported: 0`.
2. **`/factory status` collapsed NULL into 0**, which is exactly the distinction
   `setRunDone` and the container went out of their way to preserve. A card whose
   runs all died before their first `message_end` — and every card on the
   `process` runtime, which reports no usage at all — read as a card that cost
   nothing. `usageByCard` now returns `reported` (`COUNT(usage_in)`) alongside the
   COALESCE'd sums, and the view says `usage not reported (N runs)`, or `(3 of 4
   runs reported)` when only part of the card reported. The sums stay 0 because
   SQL says so; the honesty is in the count.
3. **`committingFake` was still spelled `committingFake`**, one line aliasing
   `writeOnlyFake` — a name that promises commits and delivers none, which is the
   precise shape of BUG-1. Deleted, 13 call sites renamed, the header note kept
   the historical name and says why it is gone.
4. **#1's `/factory retry` is broader than this file claims**, and #4's third
   bullet claimed a verification that does not exist. Both recorded below at
   their own bullets rather than silently rewritten.


---

## 1. The run budget never resets — a card permanently loses its ability to spawn

**Symptom (reproduced).** After one attempt spends all `MAX_AGENT_RUNS`, a card
re-dragged to Ready is rejected on its first spawn, forever:

```
attempt 2, first spawn -> rejected
  summary: run budget exhausted for this card (12). Summarise what has landed
           and stop; do not spawn again.
countRuns(CARD) = 12 | activeRuns = 0
```

**Cause.** `countRuns(cardId)` is `COUNT(*) FROM agent_runs WHERE card_id=?`
(`src/state/store.ts:167-172`) over **all history**; `agent_runs` has no attempt
column (`store.ts:43-51`) and nothing anywhere issues a `DELETE` on it.
`enqueue` is `INSERT OR IGNORE`, so a re-trigger reuses the same job row and the
same accumulated count. The budget in `src/agents/spawn.ts` compares against that
count, so it is comparing "this attempt" to "all attempts ever".

**Fix — per-attempt budget.**
- [x] Add `attempt INTEGER NOT NULL DEFAULT 1` to `agent_runs`, and
      `attempt: number` to the row type. **Migration is mandatory, not optional:**
      the schema is `CREATE TABLE IF NOT EXISTS`, so an existing
      `/var/lib/factory/factory.db` will *not* gain the column. Use
      `PRAGMA table_info(agent_runs)` and `ALTER TABLE … ADD COLUMN attempt` when
      it is missing; assert that path in a test against a DB written with the old
      schema (build the old table by hand in the test — do not fake the migration).
- [x] `jobs` gets a `generation INTEGER NOT NULL DEFAULT 1`, bumped by
      `enqueue` when it re-queues a job that already exists (change `INSERT OR
      IGNORE` to an upsert that increments on a terminal status only — a re-drag
      while `running` must **not** start a second graph for the same card).
- [x] `countRuns(cardId, attempt?)` counts one attempt; the spawner is handed the
      current attempt when it is created in `runCardGraph`.
- [x] `runsFor(cardId, attempt?)` same, defaulting to "all" so
      `/factory status` can still show history.
- [x] Implement `/factory retry` (PLAN.md's loop promises it; `src/discord/bot.ts`
      has no such subcommand today). It should re-queue a `failed` card through
      the same path the webhook uses, so there is exactly one re-trigger
      implementation and it is covered by this fix.

  **Deviation, recorded because the code is a superset of this sentence:**
  `requeueCard` re-queues *any* terminal status, so `review` and `done` are
  retryable, not just `failed`. It refuses `running` and `queued`, and it refuses
  an unknown card. That is deliberate — a card stuck in `review` over a PR that
  closed unmerged has no other way back into the factory, and `enqueue`'s
  generation bump is what makes a second attempt safe — but it means retrying a
  `done` card whose PR is merged starts a fresh run against a branch that is
  already landed. Nothing in the code stops that; the operator has to know it.
  The 2.3 reviewer is the reason to care, because a re-run reopens a PR and every
  PR push is a review.

**Tests.**
- [x] The regression, failing before the fix: *a card re-queued after a failed
      attempt can spawn again* — exhaust the budget, re-enqueue, assert the next
      `spawn()` is not `rejected`.
- [x] Attempt isolation: attempt 1's rows never count against attempt 2, and
      `runsFor(card)` with no attempt still returns both.
- [x] Re-drag while `running` does not bump the generation or start a second graph.
- [x] Migration: old-schema DB opens, gains the column, existing rows read back
      with `attempt = 1`.
- [x] `/factory retry` on a `failed` card re-queues it; on a `running` card it
      refuses.

**Done when** a card can fail, be re-triggered, and complete a full graph on the
second attempt — asserted by a test, and observed once in `graph-smoke.ts` by
running the same card id twice in one process.

---

## 2. One wedged orchestrator blocks the entire factory for hours

**Cause.** Two defaults compose badly:
- `orchestratorTimeoutMs = AGENT_TIMEOUT_MS * (maxAgentRuns + 1)`
  (`src/agents/graph.ts`) = 20 min × 13 = **260 minutes** at defaults.
- `queue.ts:15` gates on a **global** `store.isRunning()`, so while one card runs,
  no other card starts.

A planner that hangs on a provider stall holds every other card for 4.3 hours.

**Fix.**
- [x] `ORCHESTRATOR_TIMEOUT_MS` config getter (default e.g. 45 min) that *caps*
      the computed value: `min(childTimeout * (maxRuns + 1), orchestratorTimeout)`.
      Keep the child budget math but stop letting it set an unbounded wall clock.
- [x] Make the worker's gate per-card rather than global, or bound the global one:
      a card that exceeds `ORCHESTRATOR_TIMEOUT_MS` must be marked failed so
      `isRunning()` clears. Pick one and note it here — per-card concurrency is a
      design change (queue + worktree naming + Discord's "active job" notion), so
      the minimum honest fix is: cap the orchestrator + guarantee the timeout path
      always reaches `setFailed`.
- [x] Assert the invariant, not just the value: the orchestrator container must
      always be killed by name (`timeoutMs` reaches `runAgentInContainer`).

**Tests.** `orchestratorTimeoutMs` respects the cap at absurd inputs (maxRuns 0,
1, 1000); a graph whose container times out produces `status:"timeout"` and the
runner marks the job failed (so `store.isRunning()` becomes false); the kill is
issued with the orchestrator's container name.

---

## 3. Nothing reaps stale `agent_runs`, so the status view lies and #1 gets worse

**Cause.** `setRunDone` is only called from the happy/failed paths in
`createAgentSpawner`. If the orchestrator process is killed mid-card, rows stay
`status='running'` forever: `/factory status` lists children that will never
finish, and those rows count against the budget. 2.2 deliberately did not add a
reaper — that decision is now the bug.

**Fix.**
- [x] On startup (in `startWorker`, before the first tick), sweep: any
      `agent_runs` row with `status='running'`, or any `jobs` row with
      `status='running'`, whose card has no live in-process run → mark `failed`
      with summary `reaped: orchestrator restarted mid-run`.
- [x] Log what it reaped (count + card ids). Silent state mutation in a factory
      that operators watch is worse than noisy.
- [x] Keep `activeRuns()` as the single "mid-flight" source of truth, as 2.2 did —
      the sweep is what makes it trustworthy, not a replacement for it. Nothing
      added a second mid-flight query; `reapStale` is boot-only and `activeRuns`
      still reads `status='running'` straight off the table.

**Tests.** A DB left with a `running` job + two `running` rows is swept clean on
worker start and the rows read back `failed`; a genuinely live run is **not**
reaped (sweep runs before the first `runCard`, not on a timer); reaped rows stop
counting toward the attempt budget after #1 lands.

---

## 4. The deploy path and README know none of the 2.2 knobs

**Cause.** `grep` says it: `deploy/setup-factory.sh` 0 mentions, `README.md` 0
mentions; only `.env.example` documents `AGENT_GRAPH`, `MAX_PARALLEL_AGENTS`,
`AGENT_TIMEOUT_MS`, `MAX_AGENT_RUNS`, `FACTORY_IPC_BIND/PORT/SLACK_MS`,
`AGENT_MEMORY`, `AGENT_CPUS`, `FACTORY_AGENT_MODELS_FILE`,
`FACTORY_AGENT_SETTINGS_FILE`.

That hides a **deployment requirement**, which is worse than a missing nicety: on
Linux, `--add-host=host.docker.internal:host-gateway` reaches the *bridge*
address, so `FACTORY_IPC_BIND=127.0.0.1` (the default, and what Docker Desktop
happily accepts) means a container can never reach the spawn channel — every
`spawn_agent` call fails on a real VPS.

**Fix.**
- [x] `setup-factory.sh` writes `FACTORY_IPC_BIND` for Linux into
      `/etc/factory/factory.env` (not loopback), and comments the token-only
      exposure tradeoff at the line where it writes it.
- [x] Add the 2.2 knobs, grouped, to `.env.example` on the VPS path and to the
      README's architecture/loop section: what a graph is, that the orchestrator
      is containerized, that children merge back serially.
- [x] Fail loudly rather than silently misbehave: if `AGENT_GRAPH=1` and the IPC
      bind is unreachable from a container, the first spawn attempt's error should
      name `FACTORY_IPC_BIND` as the thing to check. (The provider-outage NOTE in
      `graph-smoke.ts` is the model for this kind of message.)

  **Half-true, and the split matters.** Two messages name the variable, and they
  cover two different failures:
  - `graph.ts` names it when the host's `listen()` itself fails — an unusable
    bind address, tested by binding a TEST-NET-3 address
    (`test/agents/graph.test.ts`).
  - `spawn-agent.ts`'s `BIND_HINT` names it when the *container* cannot connect,
    which is the actual Linux failure mode (`host.docker.internal` arriving at
    the bridge while the host listens on `127.0.0.1`).

  The second one is what this bullet promised and it is **not behaviourally
  verified**: `extension-drift.test.ts` greps the extension source for `channelFault(`
  and cannot execute it. The real case happens inside the agent container, out of
  reach of this repo's hermetic suite, and only a Linux run (open issue #5, third
  bullet) can close it. Do not read the `[x]` as "a container that cannot reach
  the channel produces this message" — that is an inference from a grep.

- [ ] **`#4 was incomplete, and the missing half made the fixed half useless.**
      Widening `FACTORY_IPC_BIND` only moves the *listener*. Docker Engine on Linux
      does not define `host.docker.internal` at all — it is a Docker Desktop
      convenience — so a container on a VPS still cannot resolve the name it dials,
      whatever it resolves to. `addHosts` was plumbed through `buildDockerArgs` and
      **no production caller ever set it**: `grep` found one use, in
      `scripts/ipc-roundtrip.ts`, a spike. The docs then repeated
      `--add-host=host.docker.internal:host-gateway` as though it were being passed.
      Found while wiring 2.3's reviewer, which needs the same channel. Fixed
      alongside it: `FACTORY_IPC_ADD_HOST` is a real setting, `graph.ts` and
      `reviewer.ts` pass it, and `configure-env.sh` writes it beside the bind on
      Linux (they are one requirement, so one install step sets both). The Linux
      end-to-end proof is still #5's third bullet — what is new is that there is now
      something correct for that run to verify.

**Tests.** A pure-args/config test for whatever `setup-factory.sh` gains; and a
spawn-error test asserting the message mentions the bind when the channel is
unreachable.

---

## 5. Phase 2.1 carry-overs still open

- [ ] **Exfiltration canary with a real provider key.**
      `TEST_DOCKER=1 npx vitest run test/integration` self-skips 2 of 4 tests
      without one, because this box uses OAuth. Needs an env with e.g.
      `ANTHROPIC_API_KEY` exported once, to prove the canary never appears in the
      NDJSON. 2.1's DoD is not complete until that passes.
- [ ] **Live VPS check.** amd64 image build (the image was built and probed on
      arm64), `--user <uid>:<gid>` + `chmod 0777 /home/agent` letting pi write
      `~/.pi/agent`, and Discord receiving per-tool embeds from a real container
      stream.
      *(First clause advanced 2026-10-04, from a deploy attempt rather than from
      reading: `docker build --pull --platform linux/amd64 --build-arg
      PI_VERSION=0.84.4 -f factory-agent.Dockerfile deploy/docker` exited 0, the
      Dockerfile's own import self-check (`pi-ai` / `defineTool` through
      `/opt/factory/node_modules`) passed inside the amd64 layers, and the
      resulting image ran — `docker run --rm --platform linux/amd64
      factory-agent --version` → `0.84.4`, matching `package-lock.json`, with both
      `spawn-agent.ts` and `post-review.ts` baked in.
      **Label it correctly: that is amd64 code executed under emulation on
      arm64, not a build on amd64 hardware.** It proves the Dockerfile and the
      pinned pi version, which is what the installer's `exit 1` guards; it does not
      rule out a native-only defect, and the remaining two clauses — the
      `--user`/`HOME` writability question and real Discord embeds — still need the
      container itself. Found while deploying rather than while reading: the image
      build is not where that deploy died, `npm install` for better-sqlite3 was —
      see the toolchain/allowlist fix in `deploy/setup-factory.sh`.)*
- [ ] **The Linux IPC bind question** — same as #4 but the empirical half: prove a
      widened bind + token actually works end to end on Linux, since #9 of the
      handoff's pi facts is a documented inference, not an observation.

---

## 6. Things 2.2 asserted but never measured

- [x] **Token spend per card is unknown.** `pi --mode json` emits `usage` on
      `message_end`, and `createAgentEventCollector` throws it away. Add
      `usage_in` / `usage_out` / `usage_cache_read` columns to `agent_runs`,
      sum them per run, and surface the per-card total in `/factory status`. This
      is the only way the `MAX_AGENT_RUNS` guardrail becomes a *cost* guardrail
      rather than a count guardrail.
- [ ] **Same-file serialisation is untested against a model.** *(still open — it
      needs a live endpoint, so it was not attempted in the pass that landed the
      rest; `scripts/graph-smoke.ts` is still the single-card scenario.)* Both `graph-smoke`
      runs were given two *independent* tasks, so the conflict-and-respawn loop
      has unit coverage only. Add a second smoke card whose two tasks deliberately
      edit the same file, and assert either a clean serialised landing or a
      visible `MERGE CONFLICT` re-spawn — currently the orchestrator has only ever
      been observed not needing it.
- [x] **Reviewer cost/latency**, once 2.3 exists: it will run on every `opened` +
      `synchronized`, so #1 and #6 compound. That is why this plan precedes 2.3.
      Measured now. One review of a 14-line file on a local 27B model: **238 s wall
      clock, 26 608 input / 2 044 output tokens**, three findings, one summary — from
      `scripts/review-smoke.ts` against a real container. The numbers land in the
      `reviews` table (`usage_in`/`usage_out`/`usage_cache_read`, NULL when unreported,
      same rule as `agent_runs`) and print as their own `review spend:` line in
      `/factory status`, because a card's graph budget and its review budget are knobs
      an operator tunes separately. This is also why `REVIEW_MAX_RUNS_PER_CARD` exists:
      26k tokens per push, uncapped, is the compounding #6 warned about with a price
      tag on it.

---

## 7. A fresh LXC deploy died in `npm install`, and only half of it is explained

**Found by doing the 2.4 gate deploy rather than by reading the docs.** On a
clean Debian 12 Proxmox LXC, `setup-factory.sh` aborted at `sudo -u pi npm install
--omit=dev`:

```
prebuild-install warn install Request timed out
gyp ERR! stack Error: not found: make
```

Fixed in `deploy/setup-factory.sh` (commit `4563203`): `build-essential` +
`python3` + `sudo` are installed, and `release-assets.githubusercontent.com` +
`nodejs.org` joined the egress allowlist — the first because a GitHub release
asset only 200s after redirecting there (the allowlist already had its two
neighbours), the second because node-gyp fetches headers from it. Without those
two hosts, a later `npm install` as uid `pi` stalls in exactly the same shape,
and the symptom reads as a network timeout rather than a firewall drop.

**What is NOT explained:** why the prebuild download timed out at all. The asset
exists and serves 200 for `node-v127-linux-x64`, the registry was reachable (the
deps around it installed), and the box pulls from Docker Hub fine. Candidates are
IPv6 preference with no v6 route, or a cold CDN path — not separated. So the
change makes the *fallback* work; it does not fix the cause. If it recurs, the
distinguishing test is a direct `curl -4` against the asset URL versus the same
without `-4`, and `nft list ruleset | grep factory-drop` if the rules were
already loaded at the time.

- [ ] Determine why `prebuild-install` timed out, or accept the compile fallback
      as the answer and say so here in one line.
- [ ] **Third blocker, same deploy, and this one was total:** the script ran
      `npm install --omit=dev` and then `npm run build`, but `build` is `tsc` and
      `typescript` is a devDependency. A fresh tree therefore cannot compile
      itself — measured, not inferred: an `--omit=dev` install of exactly this
      `package.json` leaves `node_modules/.bin` holding only
      `pi prebuild-install rc semver`. The build step got as far as
      `sh: 1: tsc: not found`.
      Fixed by installing fully, building, then `npm prune --omit=dev` so the
      service still ends up without test tooling — verified on a clean copy of the
      tree: install → `tsc` present; build → exit 0 with `dist/index.js`; prune →
      `tsc` gone, `better-sqlite3` and `dist/` survive, `dist/config.js` still
      loads. The same omission is why `register:trello-webhooks` cannot run after
      deploy (`scripts/` isn't compiled and `tsx` is a devDep), so the installer
      now prints that instead of leaving it to be rediscovered.
- [ ] `setup-factory.sh` still has no test for its own package list or allowlist.
      `test/deploy/configure-env.test.ts` reads the script as text for the sourcing
      lines; a missing apt package or a host out of sync between `ALLOW_HOSTS` and
      the `factory-net-apply` copy is invisible to the suite. Both of this issue's
      bugs are exactly that class.

## Definition of done

- [x] `npm test` green, with the #1 regression test failing before its fix and
      passing after.
- [ ] A card that failed can be re-triggered and complete a graph (test + one
      observed run in `graph-smoke.ts`).
- [x] No path exists where a hung agent holds `store.isRunning()` true for longer
      than `ORCHESTRATOR_TIMEOUT_MS`.
- [ ] A freshly cloned VPS can be configured from `setup-factory.sh` + README
      without reading `src/` — specifically the Linux IPC bind.
      **This box was checked and it was wrong.** An actual fresh Debian 12 LXC
      deploy stopped three times, none of them at the IPC bind: no C++ toolchain
      for better-sqlite3's node-gyp fallback (`not found: make`), `release-assets.githubusercontent.com`
      and `nodejs.org` missing from the egress allowlist, and `--omit=dev`
      installing a tree with no `tsc` while the next line asked it to build
      (`sh: 1: tsc: not found`). All three fixed in `deploy/setup-factory.sh`;
      re-check this box only when a deploy runs start to finish without editing
      anything by hand.
- [ ] 2.1's canary run has passed once with a real key, and the result is recorded
      in `plan/2.1-secret-isolation.md` as a deviation/verification note.
- [x] `agent_runs` carries token usage and `/factory status` shows a per-card
      total — and so does `reviews`, separately, which is 2.3's contribution to
      this list.

## Notes / risks

- #1's migration touches a live DB. Test the old-schema path explicitly; do not
  assume `CREATE TABLE IF NOT EXISTS` does anything useful to an existing table.
- #2's "per-card concurrency" option is a real design change (queue gate, worktree
  naming collisions between cards, Discord's single-active-job framing). If we go
  that way, it deserves its own plan doc, not a bullet here.
- Reaping (#3) mutates state at boot. Keep it idempotent and logged: a restart
  during a re-trigger must not mark a legitimately running card failed.
- Cheap ordering: #1 + #3 + #6-usage are all in `store.ts`/`spawn.ts` and should
  land in one pass to avoid touching the schema three times.
