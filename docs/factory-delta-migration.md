# Delta migration study — moving factory agent runs to Zed Delta, and the human-approval gate

**Source:** distilled from `plans/factory/6af3e8877d6b0932b1f0f14b-plan.md` (card
`6af3e8877d6b0932b1f0f14b` "Look in to moving repos to delta" on the
softwarefactory board (LLNG5MAm), branch `factory/6af3e8877d6b0932b1f0f14b`). The plan is
the authoritative full study — spawn-site evidence, exact argv, test strategy;
cite it for depth. All `file:line` cites in this doc are against `origin/master`
as of that branch's base (`8372b95`), same as the plan. The card's deliverable is
this written answer; the code phases below are follow-up card candidates, not
part of this card.

---

## 1. Verdict (read this first)

- **Delta is not a drop-in runner.** It is not a headless one-shot agent CLI like
  `omp -p`: there is **no documented way to trigger a hosted agent turn from the
  CLI** — `delta thread create --prompt` only seeds a draft ("Nothing runs until
  someone sends the draft") and `delta thread append` "records activity. It
  doesn't run messages or tool calls" ([build-a-plugin](https://delta.dev/docs/cli/build-a-plugin),
  [get-started](https://delta.dev/docs/cli/get-started)). "Moving the repos to
  delta" is therefore a phased migration, not a binary swap.
- **Recommended shape:** keep `omp -p` as the scheduler's runner and the Trello
  board as the approval gate's authority; add Delta as the **record +
  human-visibility surface** (Phases 0–2, §6). Delta-native execution (Phase 3)
  stays blocked until Zed ships a CLI/API trigger for hosted runs.
- **The gate answer:** when human approval is needed, the `[ASK]` comment and the
  Discord ping gain a **link to the card's Delta thread**, whose Changes tab shows
  the live diff vs `origin/master` since the shared merge base — readable from a
  phone (§5). That is the whole "the human must SEE what is changing" answer; the
  gate's acceptance logic itself does not move to Delta and is not weakened.

## 2. What Delta is (facts + limits, with sources)

Beta caveat: Delta's own docs banner says commands/flags/output "can change
between releases" ([get-started](https://delta.dev/docs/cli/get-started)) —
treat every command below as beta-pinned.

- **Threads replace PRs** as the unit of collaboration: a conversation with
  agents plus worktrees. Review happens in dedicated review subthreads whose
  agent produces a "change guide"; a human submits a verdict **Approve /
  Request Changes** from desktop or web (`/approve`, `/request-changes`) —
  [review-and-sync](https://delta.dev/docs/agents/review-and-sync).
- **The Changes tab shows the real diff** vs an upstream ref "since the merge
  base" (e.g. `origin/master`), with per-file Seen tracking; the merge base is
  recorded and shared with everyone including web viewers. Landing is still
  ordinary Git: "pushing to `local` or your source remote" brings work in;
  commits remain the checkpoints
  ([blog](https://zed.dev/blog/delta-public-beta), review-and-sync §Bring
  changes in). → Git-flow gates (merge-base diffs, sha keying) survive a Delta
  migration intact.
- **The CLI cannot start an agent run.** The documented scripting model is a
  **plugin**: your agent keeps running on your own harness (as `delta-claude`
  does for Claude Code) and the CLI mirrors its ACP-v2 transcript and worktrees
  into a thread — `thread create --source/--external-id` (idempotent: same pair
  returns the same thread), `worktree create/attach/mount`, `thread append`
  (JSONL), `thread watch` (JSONL), `thread stop`, and a `thread contract`
  version handshake (contract v8 on Delta 0.22.0) —
  [build-a-plugin](https://delta.dev/docs/cli/build-a-plugin). This mirroring
  seam is exactly where the factory would plug in.
- **Auth/install:** the CLI runs on the Delta app (`~/.local/delta.app` on
  Linux, CLI at `~/.local/bin/delta`, installed via
  `curl -fsSL https://delta.dev/install.sh`); login is a **device-code flow**
  (`delta auth login`; the CLI machine needs no browser); `delta auth status`
  exits 0/1/2; scope is account + organization (`delta org
  create/list/switch`); usage telemetry is on and account-tied. **No API token
  is documented** → a headless service-identity story is an open question (§8).
- **Worktrees:** `worktree mount --existing-checkout` uploads the checkout
  *including uncommitted changes* and keeps syncing while the process runs;
  `thread mount` creates mount checkouts for joiners. "Local Git state, such as
  branches, aren't shared or kept."
- **Execution surface:** hosted threads run in the Delta app or a "Cloud
  Runner" (mentioned only in passing in the thread-delete docs section); no
  CLI command to trigger or await a hosted turn is documented. Phase 3 hinges
  on this; watch [delta.dev/roadmap](https://delta.dev/roadmap).

## 3. The runner today: every `omp` spawn site

The factory drives headless `omp -p` scheduler runs. Complete inventory (plan §1):

| # | Site | What it does | Runner-specific surface |
|---|------|--------------|-------------------------|
| 1 | `scripts/factory-daemon.js:278-285` `agentArgs` | THE single argv builder | `['-p','--auto-approve','--max-time',FACTORY_MAX_TIME\|\|'12h','--max-cost',FACTORY_MAX_COST\|\|'100','--model',FACTORY_MODEL?,prompt]` |
| 2 | `scripts/factory-daemon.js:633` | `ompBin = FACTORY_OMP_BIN \|\| 'omp'` (startup log `:932`; env docs `:79-80`) | binary knob already CLI-agnostic; argv is not |
| 3 | `scripts/factory-daemon.js:746-789` `dispatch()` | Ready→Plan run; `# dispatch` header `:761`, `spawn` `:763`; exit/error → `crashRecovery` | exit code + stdout-to-log + stdin-ignored = the run contract |
| 4 | `scripts/factory-daemon.js:792-816` `spawnResumeRun()` | stage-aware recovery (crash OR human comment), same argv `:795/:797`, resume watcher `:874` | same |
| 5 | `scripts/lib/factory-comment-resume.js:607-626` `defaultSpawnRun` | CLI-standalone `resume-watch` default spawn | argv duplicated |
| 6 | `scripts/lib/factory-stall-sweep.js:181-199` `defaultSpawnRun` | CLI-standalone stall recovery | same argv; silence window = `FACTORY_MAX_TIME` + 15 min (`:19`) |
| 7 | `scripts/lib/factory-eval.js:291-303` `defaultSpawn` + `:316-317` `spawnReviewerRun` | nightly reviewer replay (CLI `eval-run` → `scripts/factory.js:521,562`); captures **stdout** | stdout is the scoring input (`:293`: `omp -p` waits for stdin EOF) |
| 8 | `scripts/factory.js:614/629/685/708-720` `ask`/`wait`/`risk`/`approve` | ask/approve paths — NO agent spawn | unaffected by a runner swap |

Coupling beyond argv (all break on a delta-native swap, none on a sidecar):
SIGTERM crash classification parses omp's death chatter (`[Stopped by SIGTERM]`,
`[Recovery] omp --resume …` — `factory-daemon.js:167-178`); metrics parse the
dispatch header JSON and omp's cost tail (`factory-metrics.js:497`
`parseDispatchHeaders`, `COST_RE` `:106`, `extractCostSpent` `:526`);
`buildRunPrompt` seeds the literal "You run HEADLESS (omp -p)…" (`:261`), pinned
by `tests/factoryDaemon.test.js:115-119` (which also pins the RISK GATE approve
line `:161` and the REPO CONTEXT deploy lines `:190-205`; the `:251-255` source
comment above `buildRunPrompt` misattributes this pin to
`tests/factoryStagePrompts.test.js`, whose `buildRunPrompt` checks (`:428-434`)
pin only the stage-doc references + the "override your harness role defaults"
phrase); the service PATH lists `omp`
(plist comment `:287`, systemd unit per `docs/factory-migration.md` §4.6); stage
subagents are spawned *inside* the omp session — a delta-native move converts
them to Delta subthreads/subagents ([threads](https://delta.dev/docs/agents/threads)).

## 4. CLI / auth / env deltas

| `omp` today | Delta equivalent | Notes |
|---|---|---|
| `FACTORY_OMP_BIN` binary swap | `delta` at `~/.local/bin/delta` (new PATH entry in plist envPath `factory-daemon.js:287-289` + systemd unit, migration §4.6) | one-shot argv has no delta equivalent |
| `-p <prompt>` one-shot run | `thread create --source factory --external-id <card>` + `worktree create/attach` + `worktree mount --existing-checkout` — **the runner stays external** | plugin pattern (§2) |
| `--auto-approve` | **no equivalent** — an omp tool-permission auto-accept, NOT the human gate | must never be conflated with Delta review verdicts |
| `--max-time` / `--max-cost` | no documented per-run caps | Phase-3 blocker; stall-sweep `:19` silence window loses its anchor |
| `--model` | `thread create --model` / per-thread switch | model knobs live on the thread |
| exit code + stdout log + cost tail = run result | thread turn state via `thread watch` (`turn`/`producer.turn`, `running`/`idle`/`superseded`), `thread show` transcript | no stdout, no cost line → Phase-3 rewrite of crash/metrics model |
| env auth (API keys in `.env`, docs/factory.md "Credentials") | `delta auth login` device flow once per box + `delta org switch`; `delta auth status` as pre-dispatch health check | personal-account-bound today |
| Trello/Discord env | unchanged | unchanged |

## 5. The human-approval gate: where it lives, and what changes under Delta

**Today (and in every migration phase below — the gate never moves):** after
`[QA:PASS]`, before `git merge --ff-only`, from the card worktree: `node
scripts/factory.js approve <card> <sha> factory/<id>` (`scripts/factory.js:708-720`;
prompt RISK GATE step `factory-daemon.js:268`; spec docs/factory.md "Risk-tiered
approval before Deploy"). Tier classification is pure git (`getDiffStat`
`factory-risk.js:165` merge-base numstat → `classifyDiff` `:102`); low tier exits
0 with zero board writes. Medium/high scans comments for an existing **sha-keyed
human approval** (`findApprovalComment` `:216` — human author, bot-authored never
counts; sha regex `:193`); none found → ONE `askHuman({noWait:true})` posting
`approvalAskText` (`:83-89`) + Discord ping, then poll until
`approvalTimeoutDefault()` (`:77`; `FACTORY_APPROVAL_TIMEOUT_MS` →
`FACTORY_ASK_TIMEOUT_MS` → 1 h); timeout ⇒ CLI exit 1 (`factory.js:719`) ⇒
scheduler labels **needs-human**, card stays in QA, no merge, **park not bounce**;
recovery = approve late + drag back to Ready (the existing-approval scan
short-circuits — "comments are the state"). The comment-resume watcher stays
silent while the gate owns the reply (`factory-comment-resume.js:342/:765`); a
human drag past the gated stage is itself a complete approval.

**What the human sees today when approve is needed:** the `[ASK]` text — tier +
reasons + the sha twice + reply/stale-sha rules — plus a Discord ping. **No
diff**: the human must `git diff` or open GitHub themselves to see what is
changing. That is the card's complaint, and Delta's answer.

> **Update (card 6af61f32ed767688104029e0):** the Phase-1 *record + approval
> visibility* answer now ships first-party as the GitHub PR the gate opens when
> it asks (docs/factory.md "The PR as the mobile approval surface") — phone-readable
> diff + review-approve at the sha, mirrored `[HUMAN]` on the card. The Delta
> phases below are unaffected; this study remains the richer long-term path.

**What changes for the gate under Delta (Phases 1–2):**

1. The `[ASK]` comment gains the card's **Delta thread link** (shared to the
   org). Opening it on web/mobile shows the **Changes tab**: the live diff of
   the card's worktree vs `origin/master` since the shared merge base, with
   per-file Seen tracking; a review subthread shows the change guide (§2). The
   human reviews the actual diff in under two minutes, from a phone.
2. The Discord ping carries the same link.
3. Delta's own review verdicts (Approve / Request Changes, web-capable) become
   a *second, richer place to look* — **advisory only**: in Phases 0–2 the gate
   still accepts only a sha-keyed Trello human comment (or a stage drag). Phase
   2b may add a flag-gated *attested* path where a whitelisted Delta user's
   Approve on the card's thread, snapshotted at the QA sha, is mirrored to the
   board as `[HUMAN] APPROVED <sha> (delta-review verdict by <user>)` — one
   named, verified exception to the bot-authored-never-counts rule
   (`factory-risk.js:216`), not a bypass.
4. **Unchanged:** sha keying (`shaMentionRe` `:193`; rebase ⇒ new approval —
   merge-guard re-gate, prompt `:268`), timeout ⇒ `needs-human` parking (park,
   never bounce), the ask protocol itself, `git merge --ff-only` landing. Delta
   keeps commits as checkpoints (blog), so the sha anchor survives.
5. `--auto-approve` (`agentArgs:279`) stays what it always was: an in-run tool
   permission accept, never the human gate.

## 6. Phased migration (follow-up card candidates)

- **Phase 0 — headless spike (no code).** On the Proxmox box: install the CLI,
  prove GUI-less operation + `delta auth login` device flow over ssh surviving
  reboot, `delta --json thread contract` ≥ 8, one real card worktree →
  `thread create --source factory --external-id <card>` +
  `worktree mount --existing-checkout` + `thread share --visibility
  organization` → the human opens the share URL **on a phone** and sees the
  live diff vs `origin/master`; verify the merge-gate rebase (`:268` step) does
  not fight the mount's uncommitted-state sync. Exit: a hand-written `[ASK]`
  with a thread URL, reviewed from a phone in <2 min. Record in
  `docs/factory-migration.md` §9 style. **Effort: half a card.**
- **Phase 1 — Delta sidecar: record + approval visibility (recommended
  default).** Runner stays `omp -p`. New `scripts/lib/factory-delta.js` (DI,
  best-effort throughout: delta missing ⇒ thread null ⇒ pipeline continues):
  `ensureThread` (idempotent `--source/--external-id`), mount child tracked in
  `runs` + SIGTERM'd on run exit and daemon shutdown, `thread share` →
  `{threadId,url,mountPid}`; written to `data/factory-delta/<card>.json`.
  `dispatch()`/`spawnResumeRun()` attach threads with a **separate** `# delta`
  header line (never appended to the `# dispatch` header —
  `parseDispatchHeaders` JSON.parses from the first `[`; a separate line keeps
  metrics byte-compatible). `approvalAskText`/`approvalGate` gain an optional
  `threadUrl` into ask + ping — **gate acceptance rules unchanged**. Registry
  gets an optional per-repo `delta: {org, visibility, inviteEmails}` block;
  `factory.js` gains `delta-share <card> <path>`. env: `FACTORY_DELTA=0|1`
  (default **off**, internal-first rollout), `FACTORY_DELTA_BIN`,
  `FACTORY_DELTA_ORG`. Docs ride the card: factory.md Gate protocol (thread
  link + advisory-verdict note) and its "Approval grammar" wording fix (§8.7),
  migration doc §FM-8 + box prerequisites. **Effort: ~1 card.**
- **Phase 2a — transcript/comment mirroring (optional).** Coarse run activity
  as ACP-v2 `thread append` records (contract v8, `--acknowledge local` for
  offline resilience) + a `thread watch` sidecar per live run mirroring human
  thread comments back as Trello comments so the comment-resume watcher keeps
  working unchanged — the board stays the single source of truth.
- **Phase 2b — attested Delta verdicts (flag-gated, default off).**
  `FACTORY_DELTA_APPROVALS=0` default; §5.3's attested path + the
  `findApprovalComment` injectable `attested` source + the Gate-protocol doc
  change. A follow-up card from Phase 1.
- **Phase 3 — delta-native runs (exploratory; do not schedule).** Replace the
  per-card omp process with Delta threads as the execution surface. Hard
  blockers before it can even start: no documented CLI trigger to run a hosted
  turn; headless service identity (§8.4); run-lifecycle translation (exit
  codes / `runs` map / `FACTORY_MAX_PARALLEL` → thread turn state;
  `sigtermStopped` `factory-daemon.js:174-178` + `[Recovery] omp --resume`
  parsing die; `handleRunCrash` `:445` + `decideCrashRecovery`
  `factory-comment-resume.js:183-262` need a thread-state input); no
  `--max-time`/`--max-cost` equivalent (stall-sweep `:19`, metrics
  `COST_RE`/`extractCostSpent`); `eval-run` scoring would read `delta thread
  show --format messages` instead of stdout; stage subagents → Delta
  subthreads ⇒ rewrite of `buildRunPrompt` + all five
  `docs/factory-prompts/*.md` + their pinning tests. Files touched: essentially
  `factory-daemon.js`, `lib/{factory-comment-resume,factory-stall-sweep,factory-eval,factory-metrics,factory-delta}.js`,
  `factory.js`, the launchd/systemd units, factory.md Scheduler loop +
  Auto-start daemon.

**Verification for Phase 1 (recorded so the follow-up card doesn't re-derive
it):** new `tests/factoryDelta.test.js` with DI fakes pinning the `thread
create` argv, idempotent re-ensure, mount lifecycle (TERM on exit + shutdown),
best-effort failure (missing delta CLI ⇒ dispatch still spawns the run), and
contract fail-closed (contract `max < 8` ⇒ enrichment off, pipeline
unaffected); `factoryRisk.test.js` cases for `threadUrl` in ask text/ping and
the regression that a Delta Approve does **not** pass the gate by default;
`factoryMetrics.test.js` proving `# delta` lines are ignored by header
parsing; `factoryStagePrompts.test.js` stays green untouched. Then the
internal-first canary: one low-risk card with `FACTORY_DELTA=1` → thread +
shared link; force a medium card → `[ASK]` carries the link, sha approve,
`--ff-only` proceeds; timeout drill at `FACTORY_APPROVAL_TIMEOUT_MS=60000` →
exit 1 ⇒ `needs-human`, card stays in QA, bounce count unchanged, late approve
+ drag short-circuits. `FACTORY_DELTA` off ⇒ byte-identical behavior to today.

## 7. What explicitly does NOT change

The gate contract survives Delta in every phase: board pipeline + stage tags;
risk-tier classification (pure git numstat); sha keying and the
rebase-requires-new-approval rule; human-reply author rules; the ask protocol,
timeout, and `needs-human` parking (park, never bounce); comment-resume
drag-as-approval; `git merge --ff-only` landing on `origin/master` (Delta is
Git-compatible — merge/merge-guard are ordinary git); **Trello remains the
source of truth for stage state and approvals in every phase**, including 2b,
where the Delta verdict only ever becomes board state through the factory's
own attested comment.

## 8. Risks + open questions (from plan §6)

1. **No CLI-triggered hosted run** (§2): delta-native automation is impossible
   today. If Zed never ships it, Phases 0–2 are the end state — which already
   answers the card (gate stays on the board; the human sees the diff in Delta).
2. **Beta churn**: commands/flags/output can change between releases; mitigate
   with the `thread contract` handshake (pin v8) + fail-closed enrichment — the
   pipeline must never depend on Delta availability.
3. **Headless box**: the CLI runs on the Delta app; GUI-less operation + login
   persistence across reboot are unverified — Phase 0 decides; a `delta auth
   status` pre-dispatch health check goes in the daemon if login can expire.
4. **Service identity + data exposure**: device login binds a personal account;
   an org service account / future API token is undocumented. Threads + file
   contents upload to Delta cloud (org members read shared threads; telemetry
   on, account-tied) — acceptable for these repos? Decide before the Phase 1
   canary.
5. **Mount vs merge-gate**: `--existing-checkout` syncs uncommitted work while
   the scheduler rebases the same branch (`:268`); Phase 0 verifies they don't
   fight, else share only committed state per stage.
6. **Verdict bypass**: a Delta Approve must never merge/land on its own —
   landing stays the scheduler's merge-guard + `merge --ff-only`; docs state
   verdicts are advisory until 2b, and 2b is flag-gated + whitelisted-user.
7. **Doc/code tension to fix in the Phase 1 docs edit**: docs/factory.md
   "Approval grammar" says "reply matching is by AUTHOR, never by SHA" while
   "Gate protocol" + code (`factory-risk.js:216`) require the sha mention for
   *gate* approvals. The code is right (gate = sha-keyed; bare `Approved`
   qualifies for plain asks / resume-drags); amend the grammar wording then.
8. **Cost/time guards**: no `--max-cost`/`--max-time` equivalent Delta-side;
   Phase 1 runs stay omp-bounded (unchanged); Phase 3 must re-invent the bounds.
9. **Concurrency**: Phase 2's per-run `thread mount` + `thread watch` sidecars
   add long-lived processes per card under `FACTORY_MAX_PARALLEL`; the daemon
   `shutdown` (`:818-831`) must TERM them (a dead mount's process doesn't keep
   Delta running — degradation is acceptable, but lingering mount checkouts
   need a cleanup command).
10. **Per-repo share policy open**: `organization` visibility exposes code to
    every org member; `private` + per-card invites is the alternative — the
    registry `delta` block (Phase 1) carries the choice; decide per repo.
