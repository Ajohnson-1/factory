# Open issues — hardening 2.1–2.2 before 2.3

**Goal:** close the defects and operator-facing holes that phases 2.1–2.2 left
behind. These are not features, and they are not polish: #1 makes a re-triggered
card unable to do any work at all, and #2/#3 can wedge the whole factory. Land
this **before or alongside 2.3**, because the reviewer will start writing
`agent_runs` rows on every PR push and immediately hit #1, #3 and #6.

Evidence and reproductions live in `plan/HANDOFF-2.3.md`; this file is the plan
of record for fixing them. Ordered by blast radius.

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
- [ ] Add `attempt INTEGER NOT NULL DEFAULT 1` to `agent_runs`, and
      `attempt: number` to the row type. **Migration is mandatory, not optional:**
      the schema is `CREATE TABLE IF NOT EXISTS`, so an existing
      `/var/lib/factory/factory.db` will *not* gain the column. Use
      `PRAGMA table_info(agent_runs)` and `ALTER TABLE … ADD COLUMN attempt` when
      it is missing; assert that path in a test against a DB written with the old
      schema (build the old table by hand in the test — do not fake the migration).
- [ ] `jobs` gets a `generation INTEGER NOT NULL DEFAULT 1`, bumped by
      `enqueue` when it re-queues a job that already exists (change `INSERT OR
      IGNORE` to an upsert that increments on a terminal status only — a re-drag
      while `running` must **not** start a second graph for the same card).
- [ ] `countRuns(cardId, attempt?)` counts one attempt; the spawner is handed the
      current attempt when it is created in `runCardGraph`.
- [ ] `runsFor(cardId, attempt?)` same, defaulting to "all" so
      `/factory status` can still show history.
- [ ] Implement `/factory retry` (PLAN.md's loop promises it; `src/discord/bot.ts`
      has no such subcommand today). It should re-queue a `failed` card through
      the same path the webhook uses, so there is exactly one re-trigger
      implementation and it is covered by this fix.

**Tests.**
- [ ] The regression, failing before the fix: *a card re-queued after a failed
      attempt can spawn again* — exhaust the budget, re-enqueue, assert the next
      `spawn()` is not `rejected`.
- [ ] Attempt isolation: attempt 1's rows never count against attempt 2, and
      `runsFor(card)` with no attempt still returns both.
- [ ] Re-drag while `running` does not bump the generation or start a second graph.
- [ ] Migration: old-schema DB opens, gains the column, existing rows read back
      with `attempt = 1`.
- [ ] `/factory retry` on a `failed` card re-queues it; on a `running` card it
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
- [ ] `ORCHESTRATOR_TIMEOUT_MS` config getter (default e.g. 45 min) that *caps*
      the computed value: `min(childTimeout * (maxRuns + 1), orchestratorTimeout)`.
      Keep the child budget math but stop letting it set an unbounded wall clock.
- [ ] Make the worker's gate per-card rather than global, or bound the global one:
      a card that exceeds `ORCHESTRATOR_TIMEOUT_MS` must be marked failed so
      `isRunning()` clears. Pick one and note it here — per-card concurrency is a
      design change (queue + worktree naming + Discord's "active job" notion), so
      the minimum honest fix is: cap the orchestrator + guarantee the timeout path
      always reaches `setFailed`.
- [ ] Assert the invariant, not just the value: the orchestrator container must
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
- [ ] On startup (in `startWorker`, before the first tick), sweep: any
      `agent_runs` row with `status='running'`, or any `jobs` row with
      `status='running'`, whose card has no live in-process run → mark `failed`
      with summary `reaped: orchestrator restarted mid-run`.
- [ ] Log what it reaped (count + card ids). Silent state mutation in a factory
      that operators watch is worse than noisy.
- [ ] Keep `activeRuns()` as the single "mid-flight" source of truth, as 2.2 did —
      the sweep is what makes it trustworthy, not a replacement for it.

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
- [ ] `setup-factory.sh` writes `FACTORY_IPC_BIND` for Linux into
      `/etc/factory/factory.env` (not loopback), and comments the token-only
      exposure tradeoff at the line where it writes it.
- [ ] Add the 2.2 knobs, grouped, to `.env.example` on the VPS path and to the
      README's architecture/loop section: what a graph is, that the orchestrator
      is containerized, that children merge back serially.
- [ ] Fail loudly rather than silently misbehave: if `AGENT_GRAPH=1` and the IPC
      bind is unreachable from a container, the first spawn attempt's error should
      name `FACTORY_IPC_BIND` as the thing to check. (The provider-outage NOTE in
      `graph-smoke.ts` is the model for this kind of message.)

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
- [ ] **The Linux IPC bind question** — same as #4 but the empirical half: prove a
      widened bind + token actually works end to end on Linux, since #9 of the
      handoff's pi facts is a documented inference, not an observation.

---

## 6. Things 2.2 asserted but never measured

- [ ] **Token spend per card is unknown.** `pi --mode json` emits `usage` on
      `message_end`, and `createAgentEventCollector` throws it away. Add
      `usage_in` / `usage_out` / `usage_cache_read` columns to `agent_runs`,
      sum them per run, and surface the per-card total in `/factory status`. This
      is the only way the `MAX_AGENT_RUNS` guardrail becomes a *cost* guardrail
      rather than a count guardrail.
- [ ] **Same-file serialisation is untested against a model.** Both `graph-smoke`
      runs were given two *independent* tasks, so the conflict-and-respawn loop
      has unit coverage only. Add a second smoke card whose two tasks deliberately
      edit the same file, and assert either a clean serialised landing or a
      visible `MERGE CONFLICT` re-spawn — currently the orchestrator has only ever
      been observed not needing it.
- [ ] **Reviewer cost/latency**, once 2.3 exists: it will run on every `opened` +
      `synchronized`, so #1 and #6 compound. That is why this plan precedes 2.3.

---

## Definition of done

- [ ] `npm test` green, with the #1 regression test failing before its fix and
      passing after.
- [ ] A card that failed can be re-triggered and complete a graph (test + one
      observed run in `graph-smoke.ts`).
- [ ] No path exists where a hung agent holds `store.isRunning()` true for longer
      than `ORCHESTRATOR_TIMEOUT_MS`.
- [ ] A freshly cloned VPS can be configured from `setup-factory.sh` + README
      without reading `src/` — specifically the Linux IPC bind.
- [ ] 2.1's canary run has passed once with a real key, and the result is recorded
      in `plan/2.1-secret-isolation.md` as a deviation/verification note.
- [ ] `agent_runs` carries token usage and `/factory status` shows a per-card
      total.

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
