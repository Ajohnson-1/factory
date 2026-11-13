# Software Factory

Looping card pipeline over the Trello boards in the repo registry
(<https://trello.com/b/LLNG5MAm/softwarefactory> for factory work since
FM-3; <https://trello.com/b/ZHkVYBN1/discord-bot> for product cards until
the FM-6 cutover). The omp session is the
**scheduler**: it polls the board, fans cards out as parallel pipelines, and
spawns a specialized subagent per stage. Trello lists are state; card
comments are the audit log.

## Board contract

Lists (created by `node scripts/factory.js init`):

```
Ready → Plan → Implement → Review → QA → Deploy → Verify → Done
      ↑________________________________________________|
                 (bounce back to Implement, max 3 total)
```

Deploy/Verify run `scripts/deploy.js` + `scripts/verify-deploy.js` against the prod
host (docs/deploy-host.md); a `[VERIFY:FAIL]` bounces to Implement and counts
toward the 3-bounce rule.

- A card's **list is its state**. Only the scheduler moves cards.
- Label `needs-human` — parked card: 3 failed bounces or an unresolvable
  merge conflict. The scheduler stops touching it.
- Card **description = the requirements**, written by a human. Agents never
  edit it.
- Every stage posts exactly one comment, first token is a tag:
  `[PLAN]`, `[IMPL]`, `[REVIEW:APPROVE]`, `[REVIEW:CHANGES]`, `[REVIEW:VERIFY]`, `[SEC:PASS]`,
  `[SEC:FINDINGS]`, `[QA:PASS]`,
  `[QA:FAIL]`, `[DEPLOY]`, `[VERIFY:PASS]`, `[VERIFY:FAIL]`, `[ROLLBACK]`,
  `[PROD-CLOSE]`, `[ASK]`, `[HUMAN]`, `[CHECK:PASS]`, `[CHECK:FAIL]`,
  `[RESUME]`.
  `[ASK]` is posted by a blocked agent (`factory.js ask`, below); `[HUMAN]` is
  the human's answer to it; `[RESUME]` is the comment listener's
  scheduler-bookkeeping ack when it picks a card back up at its current stage
  (see "Listening for human comments" — same class as the daemon's
  `[DAEMON-CRASH]`/`[DAEMON-RESTART]` and the metrics reporter's `[METRICS]` summary comment
  (see "Metrics report"). `[CHECK:PASS]`/`[CHECK:FAIL]` are posted by the daemon's
  independent blocking-checks gate (scheduler bookkeeping, same class as
  `[DEPLOY]`; see "Independent blocking checks" under the daemon section) —
  `[CHECK:FAIL]` bounces to Implement and **counts** toward the 3-bounce
  rule, exactly like `[VERIFY:FAIL]`. `[REVIEW:VERIFY]` is the Review-verify sub-step's
  verdict on the reviewer's findings (see "Verifying reviewer findings" —
  same scheduler-bookkeeping class as `[RESUME]`). `[ROLLBACK]` is scheduler bookkeeping on the
  Verify-failure path, posted by the scheduler alongside
  `[DEPLOY]`/`[VERIFY:*]` (the "one comment per stage" rule binds stage
  agents, not scheduler bookkeeping). `[PROD-CLOSE]` is bot bookkeeping too —
  the which-layer-failed incident closure for `[PROD-WATCH]` cards
  (`factory.js prod-close`; see "Incident closure" under the Prod watchdog).
  Agents consume the curated per-stage view with
  `node scripts/factory.js context <cardId> <stage>` ("Per-stage context",
  below); `node scripts/factory.js read <cardId>` remains the **raw,
  audit-only** trail — no new tags were added for this (STAGE_TAGS
  untouched; the curation is read-time, never a board write).
- An `[IMPL]` comment MUST carry its verification evidence in prose: the exact
  commands/checks run and what they printed — test counts, exit codes, and for
  UI work a screenshot path — plus one short note on what those checks would
  *not* catch. A bare claim ("tests pass") with no command and no observed
  output is not evidence. The reviewer treats missing evidence as an automatic
  `[REVIEW:CHANGES]` finding: the pipeline trusts printed output, not claims.
  An `[IMPL]` comment MUST additionally carry three labeled parts (the
  blog-PR-template mirror): `how-tested:` (the commands run and observed
  counts/exit codes — may reference the evidence prose above), `risk:` (the
  worst-case blast radius if shipped), and `how-to-revert:` (revert commit /
  config flip / feature flag). The reviewer treats a missing or empty part as
  an automatic `[REVIEW:CHANGES]` finding, same rule class as missing evidence.
- **Per-finding disposition on a bounce.** When a bounce is pending — a
  `[REVIEW:CHANGES]`, `[SEC:FINDINGS]`, or `[QA:FAIL]` comment exists
  after the latest `[IMPL]` — the next `[IMPL]` comment MUST carry a
  **Findings disposition** section enumerating every itemized finding in
  the latest comment of each such kind, one line per item with exactly one
  disposition: `fixed — <where>` (commit / file:line) or `not-a-bug —
  <why>` (the resolving reason). A reasoned argument that the item is not
  a defect is a disposition; silence is not. The reviewer's next pass
  checks this enumeration before judging the diff — a missing section, an
  omitted item, or a missing disposition is an automatic
  `[REVIEW:CHANGES]` finding (same class as missing evidence).
  `[VERIFY:FAIL]` and `[CHECK:FAIL]` bounces are exempt: they are
  scheduler bookkeeping carrying their own structured report (a state
  report, not an itemized reviewer finding — `[VERIFY:FAIL]` embeds the
  JSON verdict, `[CHECK:FAIL]` embeds the gate's failing command, exit
  code, and output tail; same class as `[ROLLBACK]`).

## Stages

| Stage | Subagent role | Input | Output | On success | On failure |
| --- | --- | --- | --- | --- | --- |
| Plan | planner | card name/desc via `factory.js context <id> plan` + repo read + `docs/factory-prompts/planner.md` | `plans/factory/<id>-plan.md` (committed on branch) + `[PLAN]` comment | → plan approval gate (factory.js plan-approve, sha-keyed human approval) → Implement | → bounce |
| Implement | implementer | `factory.js context <id> implement` (description + plan pointer + live findings + resolved digest) + plan file + own worktree + `docs/factory-prompts/implementer.md` | committed code + `[IMPL]` comment with verification evidence — exact commands run + observed output (Board contract) | → Review | → bounce |
| Review | reviewer | `factory.js context <id> review` (description + latest `[IMPL]` evidence) + diff `git diff master...factory/<id>` + `factory.js mergeable` + risk tier (`factory.js risk`, fallback rules: reviewer brief) + `docs/factory-prompts/reviewer.md` + per-area review docs (`docs/review-guide/`, matched areas only) | `[REVIEW:APPROVE]` / `[REVIEW:CHANGES]` (itemized findings — **each finding on its own line tagged `[Important]` / `[Nit]` / `[Pre-existing]`** — mergeability noted; missing `[IMPL]` evidence or missing per-finding Findings-disposition enumeration on a bounce = automatic finding) | → security pass | → Review-verify |
| Review-verify | verifier(s) — one fresh-context read-only subagent per finding | latest `[REVIEW:CHANGES]` findings + diff `git diff origin/master...factory/<id>` + worktree (to check master for pre-existence) | per-finding classifications → `factory.js review-verify <card> -` → `[REVIEW:VERIFY]` verdict (`decision=bounce` iff ≥1 CONFIRMED Important finding) | `decision=proceed` → security pass (no bounce) | `decision=bounce` → Implement (counts once) |
| Security | security-reviewer (subagent; scheduler no-op when diff is not security-sensitive) | `factory.js context <id> security` + diff `master...factory/<id>` + `docs/factory-prompts/security-reviewer.md` seed (points at the `docs/security-review.md` checklist; runs while card sits in Review) | `[SEC:PASS]` (no-op variant allowed, notes ok) / `[SEC:FINDINGS]` (itemized HIGH/MEDIUM findings) | → QA (with `[REVIEW:APPROVE]`) | → Implement (counts) |
| Test/QA | qa | `factory.js context <id> qa` (acceptance criteria + gate pointers) + worktree + `docs/factory-prompts/qa.md` | full `npm test`, lint, acceptance walkthrough + `[QA:PASS]`/`[QA:FAIL]` comment; then the daemon's independent gate runs `npm test` itself at the tip → `[CHECK:PASS]`/`[CHECK:FAIL]` | → risk gate → merge → Deploy (gate blocks Deploy for medium/high tiers) | → Implement |
| Deploy | scheduler (scripts) | risk gate passed (low, or human-approved sha) + merged master sha + SSH to prod host | `deploy.js build master` + `deploy.js deploy <sha>`; `[DEPLOY] sha=<short> img=<tag>` comment | → Verify | → bounce (counts) |
| Verify | scheduler (scripts) | deployed host | `verify-deploy.js` JSON verdict; `[VERIFY:PASS]` / `[VERIFY:FAIL]` (FAIL comment embeds the JSON). `ai-hosts-probe` classifies infra-transient dependency failures (HTTP 429/5xx, connect errors) and re-probes 3× with 30/60/120 s backoff **before** FAIL — rollback happens only after the retry budget is exhausted (dim mismatch and other config defects fail fast immediately) | → Done | `[VERIFY:FAIL]` (JSON embedded) → `deploy.js rollback` → `[ROLLBACK]` → Implement (counts) |

## Stage prompts (repo-owned)

Each LLM stage role's authoritative instructions live in **repo-owned,
versioned prompt documents** under `docs/factory-prompts/` — the
scheduler's spawn prompts (and the comment-resume prompt) seed every
stage subagent with the matching file:

| Stage | Subagent | Prompt document |
| --- | --- | --- |
| Plan | planner | `docs/factory-prompts/planner.md` |
| Implement | implementer | `docs/factory-prompts/implementer.md` |
| Review | reviewer | `docs/factory-prompts/reviewer.md` |
| Security | security-reviewer | `docs/factory-prompts/security-reviewer.md` (points at the `docs/security-review.md` checklist) |
| Test/QA | qa | `docs/factory-prompts/qa.md` |

- **Authority:** the spawned subagent's prompt begins "Read
  `docs/factory-prompts/<stage>.md` and follow it as your authoritative
  role instructions (they override your harness role defaults)" — the
  repo document wins over any harness role prose.
- **Ownership/versioning:** prompt changes are code changes — reviewed,
  committed, and re-scored like code with C-M11's `factory.js eval-run
  --min-score` gate (see "Reviewer replay scoring"). Diffing a prompt file
  identifies exactly which stage's behavior changed.
- **Single sources of truth:** the Board contract above owns the **tag
  set and gate logic** (scheduler-facing); each stage document owns its
  **role procedure, verdict/comment mechanics, evidence rules, and
  prohibitions**. The Stages-table Input cells stay one-line summaries;
  `tests/factoryStagePrompts.test.js` pins the docs and this table in
  sync. The stage → file mapping's code source of truth is
  `STAGE_PROMPT_FILES` in `scripts/factory-daemon.js`.
- **Deploy/Verify have no prompt document:** they are scheduler-run
  script stages (`deploy.js` / `verify-deploy.js`) with no LLM role to
  prompt; the `[SEC:PASS]` **no-op** verdict is likewise scheduler-posted
  behavior, not subagent behavior.

## Review ground truth (per-area docs)

Per-area review ground-truth documents live under `docs/review-guide/`:
owner-written notes stating what a bad change in one part of the repo
looks like, what the Review stage must verify there, which paths are
nit-free zones, and what evidence a finding there must carry
(`file:line`). They are repo-owned like the stage prompts and seeded
through one of them: `docs/factory-prompts/reviewer.md` points at them,
and the reviewer applies every matched area's doc before judging a diff.

- **Ownership:** the area docs own what matters per area;
  `docs/factory-prompts/reviewer.md` owns when and how to apply them;
  the Board contract still owns the tag set and gate logic (unchanged).
- **Path map:** `docs/review-guide/README.md` owns the path → area
  mapping table the reviewer maps `git diff --name-only` output against.
- **Spot-check:** the operator spot-checks that reviewer findings
  actually follow the area docs — after every 10 merged cards or
  monthly, whichever comes first — per the ritual in
  `docs/review-guide/README.md`, appending the result to that file's
  Spot-check log (the git history is the audit trail); a recurring
  non-compliant pattern becomes a Ready card via `factory.js add`.
  `tests/factoryStagePrompts.test.js` pins the guide, the reviewer doc,
  and this doc in sync.

## Multi-repo + multi-board (FM-2)

`config/factory-repos.json` (the repo registry, docs/factory-migration.md
§4.1) maps each repo to its board, worktree root, base branch, deploy driver,
and worktree bootstrap recipe. Since FM-3 the committed config is split:
`factory` → `LLNG5MAm`, `discord-bot` → `ZHkVYBN1`. The rules:

- **Card → repo routing:** a card `repo:<name>` label pins the repo; with no
  label the board's registry entry is the default. An unknown or ambiguous
  `repo:` label is **fail-closed**: the daemon posts one `[ASK]` + `needs-human`
  and leaves the card in Ready (zero spawn) — never a guessed checkout.
- **REPO CONTEXT block:** every dispatch and resume prompt ends with the
  block generated from the registry — exact `repoDir`, worktree path,
  `git worktree add` line, bootstrap recipe, and deploy/verify command lines.
  Run all git operations for a repo in its `repoDir`; every
  `node scripts/factory.js …` invocation runs from the FACTORY repo checkout.
- **The daemon polls every registered board** each tick — per-board Ready
  passes, Done-ping / comment-resume / stall-sweep / blocking-checks loops,
  and crash recovery — through ONE global queue and the global
  `FACTORY_MAX_PARALLEL` cap. State files stay card-id keyed (Done-ping is
  per-board: `data/factory-done-ping.<board>.json` for non-default boards).
- **CLI targeting:** `--board <id>` / `--repo <name>` resolve through the
  registry on board/list/git commands (`status`, `init`, `pull`, `add`,
  `move`, `ask`, `risk`, `merge-guard`, …). Flagless stays today's behavior:
  the `TRELLO_BOARD` board and the registry `defaultRepo` — the git-flow
  commands additionally resolve the repo when the cwd sits inside a
  registered checkout or worktree. `init` ensures `To Do` alongside the
  stage lists.

## Deploy drivers (per-repo)

Every registry entry names a deploy driver (`deploy.driver`); the
`[DEPLOY]`/`[VERIFY:*]`/`[ROLLBACK]` comment contract is IDENTICAL across
drivers — only the runners differ. The routed repo's exact command lines land
in every run's REPO CONTEXT block (rendered by `deployCommands`).

| driver | repo | build | deploy | verify | rollback |
|---|---|---|---|---|---|
| `docker-ssh` | discord-bot | `deploy.js build master` (host-side image) | `deploy.js deploy <sha>` (compose up + `.deploy-history`) | `verify-deploy.js` (probes → JSON verdict) | `deploy.js rollback` (second-to-last history entry) |
| `self` | factory | none — pushing to master IS the artifact | `deploy-factory.js deploy` (ff-pull runtime clone + detached daemon restart) | `verify-factory.js` (unit active + a board poll logged after the restart → JSON verdict) | `deploy-factory.js rollback` (checkout previous sha + restart) |

The `self` driver (FM-4, docs/factory-migration.md §4.5): the deploy runs as
a child of the daemon it restarts, so the restart is **armed, not
completed** — macOS hands bootout+bootstrap to a detached guard in its own
session (the `bootstrapGuard` precedent, `scripts/lib/factory-launchd.js`);
Linux arms `systemd-run --user --on-active=2s systemctl --user restart
`factory-daemon.service` (the FM-5 box path). If the SIGTERM cascade kills the
run mid-deploy, crash recovery resumes the card and the deploy is idempotent:
ff-pull of the same sha is a no-op, and a redeploy of a sha the unit is
ALREADY ACTIVE on (last deploy-history entry = same sha) prints
`restart skipped`, exits 0 WITHOUT arming another restart and without a
history append — otherwise the resumed run would self-kill on every retry and
bounce into the crash cap (the boot orphan sweep resumes with ZERO silence,
so one restart = one `[DAEMON-CRASH]` + one stage-aware resume). A dead unit
still gets the guard (its bootstrap revives it);
`FACTORY_DEPLOY_FORCE=1` forces a restart on an unchanged sha. The runtime
clone is `deploy.runtimeClone` (default `repoDir`); a dirty clone fails
closed (exit 2, never clobbers local work). `verify-factory.js` proves the
new daemon really reaches Trello: a `watching "Ready"` boot marker AND a
`[poll] board <id> poll ok — first successful poll since boot` line, both
stamped after the deploy-history entry; stdout is ONLY the verdict JSON
(same contract as `verify-deploy.js`). Deploy history is append-only JSONL
at `<clone>/data/factory-deploy-history.jsonl`; rollbacks bounce
deterministically between the last two shas. Until the FM-6 cutover the
installed launchd job still runs the discord-bot checkout — a `self` restart
cycles THAT job; FM-6 points the plist at the factory runtime clone this
driver pulls. Knobs: `FACTORY_DEPLOY_CLONE` (override the runtime clone),
`FACTORY_DEPLOY_FORCE=1` (restart even when already active on the target sha),
`FACTORY_VERIFY_TIMEOUT_MS` (default 180000), `FACTORY_VERIFY_INTERVAL_MS`
(default 5000).

## Isolation — one worktree per card

The factory spans out: cards run **concurrently** (`FACTORY_MAX_PARALLEL`,
default **1** — the internal-first canary posture; see "Gradual rollout
(internal-first)" for when to raise it). Each card is isolated:

```sh
git worktree add ../discord-bot-factory-wt/<card-id> -b factory/<card-id>
ln -s ../../discord-bot/node_modules ../discord-bot-factory-wt/<card-id>/node_modules
cp .env version.json ../discord-bot-factory-wt/<card-id>/
mkdir -p ../discord-bot-factory-wt/<card-id>/config ../discord-bot-factory-wt/<card-id>/data
cp config/config.json ../discord-bot-factory-wt/<card-id>/config/
```

(`.env`, `version.json`, `config/config.json`, and `data/` are gitignored — absent
from a fresh worktree they push `config.js` into env fallback and break tests
that read `config/config.json`.)

- **Mainline = `master`** (git flow; the Docker image is built from master). Factory
  branches always cut from `origin/master` at loop start — never from a checked-out
  side branch. Merged feature branches are deleted after merge.
- **Mergeability is a hard gate before Review.** Scheduler fetches `origin/master`,
  rebases `factory/<id>` onto it, then `node scripts/factory.js mergeable factory/<id>
  master` MUST exit 0. Conflicts: one rebase attempt by the implementer; still
  conflicting → `needs-human`, park in Review. The reviewer re-checks mergeability and
  must reflect it in the verdict — only mergeable code may pass Review.
- After `[QA:PASS]`: freshness re-check first — `node scripts/factory.js
  merge-guard factory/<id> master` MUST exit 0 immediately before the merge
  (fresh `git fetch origin master` + `merge-base(origin/master, factory/<id>)`
  == the `origin/master` tip; exit 1 → re-run the MERGE GATE + the guard, see
  "PRE-MERGE GUARD" under "Scheduler loop"). Then `git merge --ff-only
  factory/<id>` into `master` (always fast forwards, thanks to the rebase gate
  + merge-guard freshness re-check), then `npm test` in the main tree — the
  combined re-test against the exact master being pushed — then
  `git push origin master`. This post-merge run remains, but it is no longer
  the *only* independent signal: the daemon's blocking-checks gate already ran
  the suite against the worktree tip before the merge (see "Independent
  blocking checks").
- Then: `git worktree remove`, `git branch -d factory/<id>`, card → Done.

## Scheduler loop

```
target = origin/master (fetched fresh each loop)
while cards = pull Ready (cap FACTORY_MAX_PARALLEL, default 1):
  fan out per card:
    worktree bootstrap (branch factory/<id> cut from origin/master)
    move → Plan;      planner;      expect [PLAN] comment
    PLAN GATE: node scripts/factory.js plan-approve <id> <sha>  (sha = plan-commit HEAD, captured in the worktree)
                ANY card: exit 0 → move → Implement; exit 1 (timeout) → needs-human, card stays in Plan,
                stop the run — a park, NOT a bounce (3-bounce budget untouched). Comments are the state:
                a late human approval + drag back to Ready re-runs and the gate's scan short-circuits.
    move → Implement; implementer;  expect [IMPL]
    MERGE GATE: rebase onto origin/master; factory.js mergeable factory/<id> master
                must exit 0 — conflict → one implementer rebase, else needs-human
    move → Review;    reviewer;     verdict must confirm mergeable; APPROVE ↓ else
                    [REVIEW:CHANGES] with [Important]/[Nit]/[Pre-existing]-tagged findings
    REVIEW-VERIFY (after every [REVIEW:CHANGES]): spawn one fresh-context read-only
                  verifier per finding (answer real|style-only|pre-existing + one-line
                  why; prompt from buildVerifierPrompt, scripts/lib/factory-review-verify.js)
                  → collect the answers into the classifications JSON → run
                  node scripts/factory.js review-verify <card> -  (classifications on
                  stdin; posts [REVIEW:VERIFY], prints the decision)
                  decision=proceed → security pass (no bounce counted);
                  decision=bounce → Implement (counts once toward the cap)
    security pass: node scripts/factory.js security-check factory/<id> master
      securitySensitive=false → comment [SEC:PASS] no-op; continue to QA
      securitySensitive=true  → spawn security-reviewer (docs/factory-prompts/security-reviewer.md);
        [SEC:PASS] → QA; [SEC:FINDINGS] → bounce→Implement (counts)
    move → QA;        qa;           requires [REVIEW:APPROVE] AND [SEC:PASS] after latest [IMPL]; PASS ↓ else bounce→Implement
    CHECKS GATE (daemon, not the QA agent): card sits in QA with latest stage tag [QA:PASS] and the
      worktree tip sha ≠ the recorded watermark → the DAEMON runs the blocking suite (npm test;
      FACTORY_CHECK_CMD override) itself in the worktree; [CHECK:PASS] ↓; [CHECK:FAIL] →
      bounce→Implement (counts) — exactly like [VERIFY:FAIL]; exactly-once per tip sha
    RISK GATE: node scripts/factory.js approve <id> <sha> factory/<id>  (in the worktree;
               sha = git rev-parse HEAD — tier low → pass, zero board writes)
               tier medium/high → [ASK]+ping, block for a human comment containing <sha>
               timeout (default 1h, FACTORY_APPROVAL_TIMEOUT_MS) → label needs-human,
               card stays in QA, NO merge, no bounce count; Ready drag resumes (approval scan)
    PRE-MERGE GUARD (close the merge race — a sibling push may have advanced
                master after the MERGE GATE): node scripts/factory.js
                merge-guard factory/<id> master must exit 0 (fresh fetch;
                merge-base(origin/master, factory/<id>) == origin/master tip;
                fetch failure exits 1 fail-closed — unproven freshness never
                merges). Exit 1 → RE-RUN THE MERGE GATE (rebase onto fresh
                origin/master + factory.js mergeable, same conflict rules: one
                implementer rebase, else needs-human); every such re-gate
                rebase produces a NEW tip sha, so re-run the RISK GATE in the
                worktree (node scripts/factory.js approve <id>
                $(git rev-parse HEAD)) after that rebase and before any merge —
                a stale approval never keys the new sha: tier medium/high
                re-asks and blocks; then merge-guard again — loop bounded at
                3 rounds; exhausted → needs-human, park.
    git merge --ff-only factory/<id> → master; run npm test   ← the combined
                re-test: npm test now always runs against the exact combined
                master being pushed (the merge-queue invariant). Non-zero →
                git reset --hard origin/master (factory/<id> keeps the work)
                → bounce→Implement (counts)
    git push origin master; rejected (the residual fetch→push window) → git
                reset --hard origin/master + re-run the PRE-MERGE GUARD loop
                (bounded 3) — NEVER --force-push master
    move → Deploy;   node scripts/deploy.js build master   (parse SHA= / SHORT= / IMAGE= lines)
                     node scripts/deploy.js deploy <sha>
                     comment [DEPLOY] sha=<short> img=<tag>
                     build/deploy non-zero → bounce → Implement (counts)
    move → Verify;   node scripts/verify-deploy.js > verdict.json
                     exit 0 → comment [VERIFY:PASS]; move → Done; cleanup worktree+branch
                     exit ≠0 → VERIFY-FAILURE SEQUENCE:
                       1. comment [VERIFY:FAIL] + embedded JSON verdict
                       2. node scripts/deploy.js rollback   (restore last known-good)
                       3. comment [ROLLBACK] — success OR failure, exactly one
                       4. bounce → Implement (counts)
                     rollback failure NEVER blocks the bounce: prod must not
                     keep serving the failed build silently (B10/B17 — detect
                     fast, restore first, fix forward second), and there may
                     legitimately be nothing to roll back to (exit 2).
  bounce counting: node scripts/factory.js bounces <card> → park when bounces ≥ 3:
                 (# [REVIEW:CHANGES] whose [REVIEW:VERIFY] says decision=bounce
                 + # [REVIEW:CHANGES] with no [REVIEW:VERIFY] yet (legacy/fail-closed)
                 + # [SEC:FINDINGS] + # [QA:FAIL] + # [CHECK:FAIL] + # [VERIFY:FAIL])
                 → label needs-human, park in Review
                 (Nits never appear in this count; a proceed verdict nets its paired
                 [REVIEW:CHANGES] to zero)
loop ends when Ready drains; `watch` keeps polling for arrivals
```

Triggers: "run the factory" = drain `Ready` once. "watch" = run
`factory.js watch` as a service and start a pipeline per `NEW` line.
Auto-start = the daemon below; no human step beyond dragging the card to Ready.

### Verify-failure rollback sequence

`scripts/deploy.js` has always exported a history-based `rollback` (target =
second-to-last `.deploy-history` entry — the last **deployed** image, since the
failed deploy's entry was the last append; re-runs the deploy sequence with
that entry's image and appends an `action:"rollback"` entry; exit codes
0/1/2). On `[VERIFY:FAIL]` the scheduler now invokes it **before** the
fix-forward bounce, so prod serves the last known-good build while the
implementer fixes forward instead of serving the failed one:

**Retry before rollback (card 6aeab42bc4759702f8df2835).** The Nov-3 145
incident — the embeddings gateway returned a persistent 503
`model_load_failed` under sushi memory pressure — rolled back FIVE healthy
builds over a condition the deploy didn't cause. `verify-deploy.js` now
classifies infra-transient probe failures (HTTP 429/500/502/503/504 on either
AI endpoint, or a connect-level failure — marker `RETRYABLE=1` on probe stdout
+ exit 75) and re-probes up to 3× with 30/60/120 s local backoff **inside**
the check before recording fail; the recovered/exhausted narrative rides in
the check detail so the verdict JSON carries the retry history for
postmortems. Config defects (dimension mismatch, empty model list) fail fast
on a single attempt — a FAIL after the retry budget means the dependency (or
the build) is genuinely broken and rollback proceeds exactly as below:

1. post `[VERIFY:FAIL] <JSON verdict>` (unchanged — the Verify stage's one comment);
2. `node scripts/deploy.js rollback` (CLI; exit 0 = restored);
3. post **exactly one** `[ROLLBACK]` comment — scheduler bookkeeping, same
   class as `[DEPLOY]`/`[DAEMON-CRASH]`:
   - success: `[ROLLBACK] ok — restored last known-good sha=<short> img=<tag> (history entry N→N-1, append-only) — bouncing to Implement for fix-forward`
   - any non-zero exit (incl. exit 2 "nothing to roll back to" on fewer than
     2 history entries, host down mid-rollback): `[ROLLBACK] failed (<first line of the CLI stderr error>) — prod still serves the failed build; fix-forward continues`
4. bounce → Implement (**counts** toward the 3-bounce rule, unchanged).

Rules:

- **Rollback failure NEVER blocks the bounce** — fix-forward must continue
  even when there is nothing to roll back to or the host is unreachable; the
  failure is audit-visible in the `[ROLLBACK] failed …` comment.
- `[ROLLBACK]` is **not** a bounce-counted tag (same class as `[DEPLOY]` — a
  state report, not a defect verdict). The bounce was already counted via
  `[VERIFY:FAIL]`.
- **Ordering:** `[ROLLBACK]` is posted after `[VERIFY:FAIL]` and before the
  Implement move, so a run that dies mid-sequence leaves a truthful trail —
  the comment-resume watcher's rollback trap (see "Listening for human
  comments") resumes exactly at the pending fix-forward bounce.
- **Convergence:** a bad-but-deployed previous image rolls back to it and
  re-fails Verify → the next `[VERIFY:FAIL]` rolls back again → the existing
  deterministic two-sha bounce converges (deploy.js header).
- Optional triage: the `[VERIFY:FAIL]`/`[ROLLBACK]` comments MAY include a
  one-line `which-layer=<layer>` initial guess using the incident-closure
  taxonomy below — it enriches the C-M11 eval seeds (harvested by `eval-seed`)
  but is not machine-enforced (only `prod-close` persists JSONL).

## Security review pass

A mandatory blocking sub-pass of **Review** (no separate list — the card
stays in Review the whole time; the pass runs after `[REVIEW:APPROVE]`,
before the QA move). Verdict tags: `[SEC:PASS]` / `[SEC:FINDINGS]` (Board
contract). Checklist + severity guidance: **docs/security-review.md**.

- **Gate.** The move to QA requires **both** `[REVIEW:APPROVE]` **and**
  `[SEC:PASS]` **after the latest `[IMPL]`**, with no later `[SEC:FINDINGS]`.
  Every bounce creates a new `[IMPL]` that invalidates prior
  `[REVIEW:*]`/`[SEC:*]` verdicts — both gates re-run fresh on the new diff.
  A card already sitting in Review when this ships simply has no `[SEC:*]`
  after its latest `[IMPL]`, so the pass runs once (backfill is automatic).
- **Trigger probe.** Scheduler runs
  `node scripts/factory.js security-check factory/<id> master` (same
  worktree, after the merge gate). JSON-only stdout, exit 0 always:
  `{ "securitySensitive": bool, "matchedPaths": [...], "totalFiles": N }`.
  - `false` → the scheduler posts the **no-op** verdict itself —
    `[SEC:PASS] no-op — diff touches no security-sensitive paths (<N> files)`
    — so the audit trail always carries exactly one `[SEC:*]` verdict per
    pass (same class as the scheduler posting `[DEPLOY]`/`[VERIFY:*]`).
  - `true` → scheduler spawns the **security-reviewer subagent**.
- **Spawn prompt essentials:** card id + worktree path +
  `git diff master...factory/<id>` to review; subagent seeded with
  **`docs/factory-prompts/security-reviewer.md`** (read **first** — role
  procedure), which directs reading **`docs/security-review.md`** for
  the checklist; reviewer mindset, read-only — never edits code, never
  moves the card; post **exactly one** `[SEC:PASS]`/`[SEC:FINDINGS]`
  comment (first
  token = verdict tag; findings itemized as file:line, why it matters,
  suggested fix).
- **Severity rule:** only **HIGH/MEDIUM** checklist findings may be raised as
  `[SEC:FINDINGS]`; LOW/INFO notes ride inside a `[SEC:PASS]` comment — so
  `[SEC:PASS]` stays meaningful.
- **Bounce accounting.** `[SEC:FINDINGS]` → bounce → Implement and **counts**
  toward the 3-bounce rule:
  `(# [REVIEW:CHANGES] + # [SEC:FINDINGS] + # [QA:FAIL] + # [CHECK:FAIL] + # [VERIFY:FAIL]) ≥ 3`
  → `needs-human`. Rationale: a security finding is the same class of
  defect-as-bounce as a review change; counting it keeps one uniform loop
  bound and prevents an unbounded security bounce loop. Parking on
  needs-human stays **in Review**, exactly like `[REVIEW:CHANGES]`.

## Per-stage context

**Stage agents consume the curated per-stage view**
`node scripts/factory.js context <card> <stage>` — NOT the raw
`factory.js read` dump, which replays every stale verdict body and every
embedded `[VERIFY:FAIL]` JSON blob into every later stage's context window.
`read` stays the **raw, audit-only** trail. The curator
(`scripts/lib/factory-context.js`, CLI wiring thin in `scripts/factory.js`)
is pure read-time code: zero board writes, no new tags (STAGE_TAGS
untouched), no migration for in-flight cards.

Stages (case-insensitive): `plan implement review security qa deploy verify`
(unknown → exit 1 naming the valid list).

| stage | `description` | `live` (full, capped) | `latest.*` populated | `human` | `digest` | diff / git |
| --- | --- | --- | --- | --- | --- | --- |
| plan | ✔ | — (fresh/re-plan: nothing live to build on) | — | ✔ | ✔ | — |
| implement | ✔ | bounce verdicts after the latest `[IMPL]` | `plan`, `impl` (excerpt), `rollback` | ✔ | ✔ | — |
| review | ✔ | — (the verdict lands ON the latest `[IMPL]`) | `impl` **full text** (the `[IMPL]` evidence IS the review target — missing evidence = auto-finding per Board contract) | ✔ | ✔ | agent runs `git diff master...factory/<id>` itself |
| security | ✔ | — | `impl` (excerpt) | ✔ | ✔ | agent runs the diff + reads `docs/security-review.md` |
| qa | ✔ (**= the acceptance criteria** — description is the requirements, Board contract) | — | `impl`, `reviewApprove`/`secPass` **after the latest `[IMPL]`** (null if stale — the gate's freshness made visible) | ✔ | ✔ | agent runs `npm test` in the worktree |
| deploy / verify | ✔ | — | `deploy` / `verify`,`rollback` | ✔ | ✔ | scheduler scripts drive these; listed for resume-prompt coverage |

Per-stage filtering = which `live` entries and which `latest.*` keys are
populated; `description`, `human`, `digest`, `counts` and `note` are always
present. `--max-chars <n>` caps FULL texts (default 4000); overflow carries
`…[truncated N chars — full text: factory.js read <id>]` so the raw trail
stays one `read` away.

- **Supersede rule = the security gate's rule:** let `i` = index of the
  latest `[IMPL]` (comments sorted date-ascending; unparseable dates sort
  first, never dropped). A bounce verdict (`[REVIEW:CHANGES]` /
  `[SEC:FINDINGS]` / `[QA:FAIL]` / `[CHECK:FAIL]` / `[VERIFY:FAIL]`) at
  index `< i` is
  **resolved** — the newer `[IMPL]` addressed it — and collapses to **one
  digest line** (`[TAG] YYYY-MM-DD — ≤140-char excerpt (resolved)`), never
  the body. At index `> i` it is **live** (full text in `live[]`,
  implement stage only). Stale `[REVIEW:APPROVE]`/`[SEC:PASS]`/`[QA:PASS]`
  read as null pointers + digest lines — QA sees WHY a gate is not fresh.
- **Bookkeeping tags** (`[DEPLOY]`, `[VERIFY:PASS]`, `[ROLLBACK]`,
  `[RESUME]`, `[DAEMON-CRASH]`, `[PROD-CLOSE]`, `[CHECK:PASS]`, superseded
  `[IMPL]`s) → digest lines only; crash/deploy/impl/bounce **counts** stay
  visible for the 3-bounce rule. `[VERIFY:FAIL]` and `[CHECK:FAIL]` are
  excluded from bookkeeping treatment — they are bounce tags by the rule
  above (the gate's PASS is bookkeeping; its FAIL is a defect verdict).
- **Human channel:** `human.ask` = latest `[ASK]` excerpt; `human.reply` =
  full text of the latest `[HUMAN]` after that `[ASK]` — or, with bot
  identity available, any non-bot comment newer than the latest bot-side
  comment (a pending answer the resume watcher would also see). Without bot
  identity (degraded mode, the ask protocol's precedent) only `[HUMAN]`-
  tagged replies qualify.
- **Nothing vanishes:** every raw comment maps to exactly one of `live` /
  `latest.*` / `human` / `digest` (testable invariant — audit completeness).
- **Why not a `[DIGEST]` comment per bounce?** It would add a new tag class
  to the Board contract, a board write + scheduler obligation per bounce,
  and non-deterministic LLM-written content — and re-pollute the trail it
  wants to keep clean. The same benefit (one short digest line per resolved
  verdict) falls out of deterministic read-time code for free; the raw
  trail stays exactly the audit log.

The scheduler prompts (daemon `buildRunPrompt`, resume `buildResumePrompt`)
seed stage subagents with this command; see "Auto-start daemon" and
"Listening for human comments".

## Auto-start daemon

`scripts/factory-daemon.js` removes the manual trigger. It polls `Ready`; for
each arrival it moves the card Ready → Plan and spawns a headless
`omp -p --auto-approve` scheduler run that drives that one card to Done per
this contract. Cards beyond the concurrency cap wait in `Ready`.

```sh
node scripts/factory-daemon.js install     # launchd agent; runs at login, respawns on crash
node scripts/factory-daemon.js status      # job state, daemon pid, log files
node scripts/factory-daemon.js uninstall
```

- The daemon is part of the scheduler, so it performs the Ready → Plan move
  before spawning — a daemon restart can never double-dispatch a card.
- Restarting the daemon from inside a run (`install` as an ops step) is safe:
  bootout's SIGTERM cascade kills the run's `install` process mid-flight, but
  a detached bootstrap guard survives it and re-bootstraps the job, so the
  factory can never stay silently stopped.
- Dragging a `needs-human` card back to Ready re-runs it (label removed).
- Crashed runs (non-zero exit / spawn failure — or an **exit 0 that left the
  card stranded in-flight**, a *stall*, see below) — **dispatch or resume** —
  post a `[DAEMON-CRASH]` comment — except a stall-family stall while a
  blocking `[ASK]` is pending, which stays silent (Stall recovery below;
  card 6aee77a4db0dd0de45c77d7c) — then recover by the card's own log,
  stage-aware: once a stage **verdict** exists (`[PLAN]`…`[VERIFY:*]`,
  `[ROLLBACK]`, `[PROD-CLOSE]` — `[DAEMON-CRASH]`/`[RESUME]`/`[ASK]`
  bookkeeping alone is not a verdict), the daemon spawns a stage-aware
  recovery run **at the card's current list** — worktree reuse mandated,
  no Ready/Plan move, and the stuck-Verify / `[ROLLBACK]`→Implement traps
  apply just as for comment resumes. The full Ready re-run (Ready → Plan
  from scratch) happens **only** for crashes before the first stage
  comment — nothing is committed yet, so the re-run redoes nothing.
  A card outside the in-flight lists (Done/Ready/To Do — e.g. an agent
  that exited non-zero *after* moving itself to Done) is left untouched.
  At `FACTORY_CRASH_RETRIES` (2) crashes the card parks `needs-human`
  where it stands. `[DAEMON-CRASH]` counts are read from the card's
  comments, so the cap survives daemon restarts. When the run log exists
  the comment also embeds the last ≤40 lines / ≤4000 chars of
  `data/factory-daemon/<card>.log` (newest content first, `… (trimmed)`
  marker on a char trim) after the exit-code head line, so the recovering
  run sees the real failure text through `factory.js read` instead of only
  an exit number — Factor 9, following the `[VERIFY:FAIL]`-embeds-JSON
  precedent (Stages table); a missing/unreadable log falls back to exactly
  the byte-identical exit-code-only comment, and a log-read failure never
  blocks the crash comment, the recovery respawn, the re-queue, or the
  needs-human parking.
- **Restart-stop recovery — the self-deploy class (card
  6af1fa46fecb634350948a5d).** When the routed repo is `factory` itself, the
  Deploy step restarts the daemon that spawned the run, and the daemon's
  shutdown forwards SIGTERM to its live run — every self-deploy ends the
  same way: the run dies at Deploy/Verify before it can verify. This stop
  is EXPECTED, not a crash. When the run log's LAST dispatch section ends
  with omp's SIGTERM stop block (`[Stopped by SIGTERM]` + `[Recovery]`
  lines), the daemon posts a `[DAEMON-RESTART]` comment instead of
  `[DAEMON-CRASH]` and takes the SAME stage-aware decision (resume at the
  card's list / Ready re-queue before the first verdict / hold outside the
  pipeline) WITHOUT consulting the comment-derived crash cap — the card's
  historical crash count would otherwise park every future self-deploy
  forever. `[DAEMON-RESTART]` is scheduler bookkeeping invisible to the
  `[DAEMON-CRASH]` counter. Storm guard: `FACTORY_CRASH_RETRIES`
  CONSECUTIVE `[DAEMON-RESTART]` comments with nothing between them park
  `needs-human` where the card stands — any progress comment (a verdict, a
  crash, a human reply) breaks the streak; a bare streak means the daemon
  itself is flapping. Recovery of a genuinely crashed run is unchanged,
  byte-for-byte: an unreadable or marker-free log keeps the legacy
  `[DAEMON-CRASH]` path.
- **Stall recovery (card 6aebab9a65613358f4ca333a).** A run that exits 0
  WITHOUT advancing its card — dying at the `FACTORY_MAX_TIME` cap while
  blocked on something outside itself (a background gate, a verdict wait, a
  model server) — used to be silently ignored ("exited code=0"), stranding
  the card in Plan/Implement/Review/QA forever. Such a run is a STALL and
  takes the SAME crash-recovery path under code
  `stalled (exit 0 with no verdict)`: verdict present → stage-aware resume;
  no verdict yet → Ready re-run; at the cap → `needs-human` park. The
  healthy finish stays silent: an exit-0 stall whose card already left the
  in-flight lists (Done etc.) posts NO crash comment — the Done arrival is
  already pinged by done-watch — while non-zero crashes keep posting
  byte-for-byte. A pending `[ASK]` always decides `hold` (zero move, zero
  spawn; at the cap the park still out-ranks it and applies `needs-human`
  where the card stands) and no recovery ever restarts work under the
  human's feet. Stall-family recovery posts **no** `[DAEMON-CRASH]` comment
  while an ask is pending (card 6aee77a4db0dd0de45c77d7c): the pending
  `[ASK]` comment IS the board-visible "waiting on you" — the ask protocol
  already Discord-pings the owner — and a report head + run-log tail only
  buries the ask the human must read. Non-zero crashes / `spawn-failed`
  still post under a pending ask (new information the `[ASK]` cannot
  carry), but the ask-pending hold record is **head-only** — the run-log
  tail is dropped (RC4 amendment, card 6af60d6a85947225f6ed75a0: it exists
  for RESUMING runs, and this hold spawns none) — and every daemon
  bookkeeping post that leaves an ask pending ends with the **ask-lift
  re-post** (`liftPendingAsk` re-posts the pending `[ASK]` verbatim; the
  `[CHECK:*]` gate verdict post does the same, since a daemon gate verdict
  is bookkeeping noise, not supersession), so a waiting human's `[ASK]` is
  ALWAYS the newest comment (re-posting is the only lift mechanism — edits
  do not restamp; API-verified). A parked card now **speaks human**: the
  park comment's FIRST line stays the cap record, its SECOND line names
  the action (`needs you: reply anything (e.g. "resume") to restart at
  <stage>`), a THIRD line names the superseded sha-keyed approval ask when
  a verdict tag outranked one (`supersededApprovalAsk` reads the sha back
  out of the ask text — comments remain the only state), and the owner gets
  the same one-liner + card link as a `sendOwnerPing` DM (park was silent
  before — card 13 parked 4× unnoticed; failure recorded, never thrown).
- The daemon also **boot-sweeps and supervises the STALL SWEEP** in-process
  (`scripts/lib/factory-stall-sweep.js`; CLI `factory.js stall-sweep`), the
  orphan-recovery twin of the comment watcher. At boot — replacing the old
  log-only "orphan candidate" report, whose log lines it keeps — with **zero
  silence** (FM-4: a freshly started daemon owns no children, so every
  in-flight card without an owned run is stranded — the `self` deploy
  driver's restart kills its own caller run, and boot recovery resumes it in
  seconds; deviation windows keep boards DISJOINT per §7), then every
  `FACTORY_STALL_POLL_MS` (default 300000 = 5 min) it recovers in-flight
  cards with no live run whose NEWEST comment of any kind is older than
  `FACTORY_STALL_SILENCE_MS` (default `FACTORY_MAX_TIME` + 15 min; the
  window is provably safe because a live run can never outlive its
  `--max-time` cap — silence past cap+grace proves no run intends to
  continue, including children orphaned by a SIGKILLed daemon). Recovery is
  the same crash path under code `stalled (orphan, silent <n> min)`
  (resume/requeue/park, shared `[DAEMON-CRASH]` retry cap). The trigger
  (comment dates) and the cap (comment count) are both board-derived: the
  sweep keeps NO state file and is restart-safe by construction. Cards whose
  latest comment is human-authored (the comment-resume watcher owns those)
  or whose `[ASK]` is still pending are skipped. Do **not** run a LIVE
  `factory.js stall-sweep` by hand alongside the daemon (a concurrent tick
  can double-spawn); `--once --dry-run` reports would-resume + ask-held
  cards with zero writes and is safe to run any time.
- The daemon also **auto-starts and supervises the comment-resume watcher**
  in-process (see "Listening for human comments"): human comments on in-flight
  cards get a `[RESUME]` ack and a stage-aware resume run with zero human
  ceremony. Do **not** run `factory.js resume-watch` by hand alongside the
  daemon (a concurrent tick can double-spawn).
- The daemon also **auto-starts and supervises the independent
  blocking-checks gate** in-process (see "Independent blocking checks" below):
  the suite runs in the poller itself — no agent spawn, nothing counted
  against `FACTORY_MAX_PARALLEL`, and a manual `factory.js blocking-checks`
  one-shot alongside the daemon is harmless.
- One daemon at a time (`data/factory-daemon/daemon.pid` lock); per-card run
  logs at `data/factory-daemon/<card>.log`, launchd logs alongside.
- Env overrides: `FACTORY_POLL_MS` (15000), `FACTORY_MAX_PARALLEL` (1 — see
  "Gradual rollout (internal-first)"),
  `FACTORY_OMP_BIN`, `FACTORY_MODEL`, `FACTORY_MAX_TIME` (12h),
  `FACTORY_MAX_COST` (100 USD per run),
  `FACTORY_RESUME_POLL_MS` (comment-resume interval; default `FACTORY_POLL_MS`
  → 15000), `FACTORY_RESUME_MAX` (auto-resumes per card, default 5),
  `FACTORY_STALL_POLL_MS` (stall-sweep interval, default 300000),
  `FACTORY_STALL_SILENCE_MS` (stall silence window; default
  `FACTORY_MAX_TIME` + 15 min),
  `FACTORY_CHECK_INTERVAL_MS` (blocking-checks gate interval; default
  `FACTORY_POLL_MS` → 15000), `FACTORY_CHECK_CMD` (blocking suite override:
  JSON array of `[cmd, ...args]`, default `[["npm","test"]]`).
- Exactly one consumer should drain `Ready`: stop any interactive
  drain/`watch` session before relying on the daemon. Whoever moves the card
  out of `Ready` first owns it; the other side ignores it.

## Independent blocking checks

Before this gate, `npm test` ran only **inside agent sessions** (the
implementer's evidence run, the QA agent's procedure, the post-merge check) —
enforcement was agent discipline, waivable by a lying or crashed run. The
daemon's third supervised poller moves execution into the deterministic
layer: it runs the blocking suite **itself** against the card's worktree tip
and acts on the exit code. No LLM can skip it.

- **Trigger.** A poller tick (`FACTORY_CHECK_INTERVAL_MS` →
  `FACTORY_POLL_MS` → 15000) examines cards sitting in **QA** (no
  `needs-human` label) whose **latest stage tag is `[QA:PASS]`** — the suite
  then covers the exact commit about to be merged, and the bounce (→
  Implement) is sane because the card hasn't left QA yet — and whose worktree
  tip sha (`git rev-parse factory/<id>`, run in the main repo; refs are
  shared across worktrees) differs from the recorded watermark.
- **Suite.** `npm test` exactly as `package.json` defines it (both halves —
  the jest part and the `node --test` part), run sequentially in
  `../discord-bot-factory-wt/<card-id>`; first non-zero exit stops the suite.
  `FACTORY_CHECK_CMD` overrides with a JSON array of `[cmd, ...args]` entries
  (invalid value → logged, default kept — never crash the loop). Lint is
  deliberately NOT in the daemon suite: `package.json` has no `lint` script
  and the QA prompt's lint is per-changed-file (`npx eslint <files>`), which
  needs the diff itself — per-file lint stays the QA agent's job.
- **Verdicts.** `[CHECK:PASS]` / `[CHECK:FAIL]` — **scheduler-bookkeeping**
  tags (class of `[DEPLOY]`/`[ROLLBACK]`/`[DAEMON-CRASH]`/`[RESUME]`: posted
  by the deterministic layer, not a stage agent, so the "one comment per
  stage" rule is untouched; the live run's `[QA:PASS]` stays the move
  trigger). `[CHECK:FAIL]` embeds the failing command, exit code, and output
  tail (the `[DAEMON-CRASH]`-embeds-log-tail policy: newest ≤40 lines /
  ≤4000 chars per command). A non-zero exit is treated **exactly like
  `[VERIFY:FAIL]`**: the card bounces to Implement and the verdict **counts**
  toward the 3-bounce rule
  `(# [REVIEW:CHANGES] + # [SEC:FINDINGS] + # [QA:FAIL] + # [CHECK:FAIL] + # [VERIFY:FAIL]) ≥ 3`.
- **Exactly-once per tip; at-least-once bounce.** Watermark state at
  `data/factory-blocking-checks.json` (atomic temp+rename write), keyed by
  card id → `{ sha, verdict, ts, moved }`. A trigger requires `tipSha ≠
  recorded sha`, so exactly one check per worktree tip across daemon
  restarts; a bounce + new `[IMPL]` commit changes the sha → re-checks
  automatically. **A failed bounce move never strands a card:** the FAIL
  entry carries `moved:false` until the card actually reaches Implement,
  so a transient Trello error on the bounce move is retried on a later
  tick — MOVE ONLY: the `[CHECK:FAIL]` comment is never re-posted and the
  suite never re-runs. The retry keys off `moved:false` at the CURRENT tip
  sha because the posted FAIL comment becomes the card's latest stage tag
  and closes the `[QA:PASS]` trigger for that sha — the marker is such a
  card's only path back (a `shaOf` change hands the card to the next
  `[QA:PASS]` round instead). Cards that vanish from the board are pruned
  (comment-resume precedent). The file is gitignored and self-heals if
  deleted.
- **Mid-suite race (documented, accepted).** The live run may merge + move
  the card out of QA while the suite runs; the watcher **re-checks list
  membership immediately before the bounce move** — a card that already left
  QA gets its verdict comment but NO cross-list bounce. Residual: the run's
  later Deploy/Done moves can land after our bounce (last-write-wins); it
  self-heals via the post-merge `npm test` signal — same accepted class as
  the Done-ping double-ping edge.
- **Manual reproduction.** `node scripts/factory.js blocking-checks <card>`
  is the deterministic one-shot of the gate for one card: resolves the tip
  sha, runs the suite in the worktree, posts the `[CHECK:*]` verdict
  comment, prints `{ card, sha, pass, results }`, exits 0/1 mirroring the
  suite. It never moves the card (the daemon gate owns the bounce move).

## CLI

`<card>` accepts the internal 24-char hex id, a `trello.com/c/<token>` URL
(including a `#comment-…` fragment), or the bare 8-char short link from that
URL. Short links are CASE-SENSITIVE; the CLI resolves one to the internal id
with a single API call, so `factory/<id>` branches, worktrees, and daemon
state keys are identical whichever form was pasted.

```sh
node scripts/factory.js init                     # ensure lists + needs-human label
node scripts/factory.js status                   # board snapshot JSON
node scripts/factory.js pull [Ready]             # cards in a list
node scripts/factory.js add [Ready] <title>      # create a card
node scripts/factory.js desc <card> <text>       # set requirements description; '-' reads stdin
node scripts/factory.js read <cardIdOrUrl>       # name, desc, comments
node scripts/factory.js context <card> <stage> [--max-chars <n>]  # curated per-stage context JSON (see "Per-stage context"); exit 1 on unknown stage
node scripts/factory.js move <card> <listName> [--no-ping] [--no-close-check]  # stage transition; a Done target also DMs the owner inline (see "Pinging on Done") and enforces the [PROD-WATCH] closure gate (see "Incident closure")
node scripts/factory.js comment <card> <text>    # '-' reads stdin
node scripts/factory.js prod-close <card> --layer <name> --why "<text>" [--fix "<text>"]  # [PROD-CLOSE] closure for [PROD-WATCH] cards + C-M11 JSONL seed (see "Incident closure")
node scripts/factory.js eval-seed [--out eval/cases.jsonl] [--seed data/prod-close-seed.jsonl] [--dry] [--limit N]  # harvest board bounce verdicts + the prod-close seed into the committed eval set; new cases land curated:false (see "Reviewer replay scoring")
node scripts/factory.js eval-run [--cases eval/cases.jsonl] [--case <id>] [--out <report.json>] [--no-spawn] [--min-score <0..1>]  # replay the Reviewer role over the curated set and score it; --min-score is the keep-gate for a prompt/model change (see "Reviewer replay scoring")
node scripts/factory.js ask <card> <question|-> [--timeout ms] [--interval ms] [--no-wait]  # see below
node scripts/factory.js wait <card> [--since <ISO8601>] [--timeout ms] [--interval ms]     # resume waiting
node scripts/factory.js label <card> <labelName>
node scripts/factory.js mergeable factory/<id> master   # git-flow clean-merge gate
node scripts/factory.js merge-guard <br> [target=master]  # fresh-master gate: fresh fetch + merge-base==tip? {stale,testedBase,masterTip,action}; exit 0 merge / exit 1 re-gate (fail-closed)
node scripts/factory.js security-check <br> <target>  # security footprint probe: {securitySensitive, matchedPaths}; exit 0 always
node scripts/factory.js risk <branch> [target]        # risk tier from the diff (exit 0)
node scripts/factory.js approve <card> <sha> [branch] [--timeout ms] [--interval ms]  # risk gate; exit 1 unless approved
node scripts/factory.js plan-approve <card> <sha> [--timeout ms] [--interval ms]  # plan gate; exit 1 unless a human comment keys the plan-commit sha (see "Plan approval gate before Implement")
node scripts/factory.js watch                    # poll Ready; print NEW <id> <name>
node scripts/factory.js done-watch [Done] [--interval ms] [--once]  # ping owner on Done arrivals (see below)
node scripts/factory.js resume-watch [--interval ms] [--once] [--dry-run]  # resume in-flight cards a human commented on (see "Listening for human comments")
node scripts/factory.js stall-sweep [--interval ms] [--once] [--dry-run]  # recover stalled/orphaned in-flight cards via the crash path (see "Auto-start daemon" — stall recovery; --dry-run is read-only, never run a LIVE sweep alongside the daemon)
node scripts/factory.js blocking-checks <card>  # daemon gate one-shot: run the blocking suite (npm test; FACTORY_CHECK_CMD override) vs the card's worktree tip, post [CHECK:PASS]/[CHECK:FAIL], print JSON, exit 0/1 mirroring the suite — never moves the card (see "Independent blocking checks")
node scripts/factory.js seed-audit [--dry-run] [--list To Do] [--doc docs/factory-audit.md]  # seed one card per audit Section C finding, priority-labelled, into the list (default To Do); title-dedup makes re-runs create 0
node scripts/factory.js review-verify <card> <classesJson|->  # apply per-finding verifier classifications to the latest [REVIEW:CHANGES], post [REVIEW:VERIFY], print the verdict JSON (see "Verifying reviewer findings"; exit 1 on misuse, bounce|proceed both exit 0)
node scripts/factory.js bounces <card>             # bounce-count JSON {bounces,cap,park,breakdown} — the needs-human ≥3 gate reads this (see "Verifying reviewer findings")
node scripts/factory-sweep.js once|dry-run [--date YYYY-MM-DD]  # nightly standing review sweep: files one date-deduped [SWEEP] review card into Ready (see "Nightly review sweep")
node scripts/factory.js metrics [--no-post] [--since <ISO8601>]  # factory+reviewer metrics report (JSON); default posts one [METRICS] summary onto the report card, --no-post is zero-write dry diagnostics (see "Metrics report")
```

```sh
node scripts/factory-metrics.js once        # one reporting pass (launchd StartInterval target)
node scripts/factory-metrics.js run [--interval ms]  # manual loop (default 6 h)
node scripts/factory-metrics.js install     # launchd agent com.discordbot.factory-metrics (RunAtLoad + StartInterval 21600)
node scripts/factory-metrics.js status      # launchd state + last stored report
node scripts/factory-metrics.js uninstall   # remove the agent
```

```sh
node scripts/factory-daemon.js run        # scheduler daemon: dispatch Ready + supervise the Done pinger + comment-resume watcher + stall sweep + blocking-checks gate
node scripts/factory-daemon.js install    # launchd agent (RunAtLoad + KeepAlive): factory runs unattended
node scripts/factory-daemon.js status     # launchd job + daemon pid + log files
node scripts/factory-daemon.js uninstall  # remove the launchd agent
node scripts/factory-sweep.js install     # launchd calendar agent com.ajohnson.factory-sweep (StartCalendarInterval 03:15, RunAtLoad=false) — see "Nightly review sweep"
node scripts/factory-sweep.js status      # sweep launchd job + schedule JSON
node scripts/factory-sweep.js uninstall   # remove the sweep agent
```

## Asking a human

A stage agent that hits an ambiguity/decision it cannot resolve alone uses the
**ask protocol** instead of guessing or silently failing:

```sh
node scripts/factory.js ask <card> <question|-> [--timeout <ms>] [--interval <ms>] [--no-wait]
node scripts/factory.js wait <card> [--since <ISO8601>] [--timeout <ms>] [--interval <ms>]
```

`ask` does three things:

1. **Records the question on the card** — posts `[ASK] <question>` (the tag is
   auto-prefixed; `-` reads the question from stdin). The card comment is the
   durable record and audit trail.
2. **Pings Andrew on Discord** (best-effort, never blocks the wait).
   Resolution order: `FACTORY_DISCORD_WEBHOOK` overrides everything (plain
   webhook POST); else `FACTORY_CHANNEL_ID` posts `{content}` straight to
   that channel — the factory bot's own server/channel (the bot needs Send
   Messages there; `FACTORY_SERVER_ID` names the guild it was invited to,
   no owner id needed). FM-6 per-board routing: when the ping belongs to a
   card on `DISCORD_BOT_BOARD_ID` (default `ZHkVYBN1`) and
   `DISCORD_BOT_CHANNEL_ID` is set, that channel replaces
   `FACTORY_CHANNEL_ID` for it (done-ping poller + inline move pinger and
   ask/risk pings all carry the card's board); else bot DM via
   `POST /users/@me/channels` + channel
   send, using `BOT_TOKEN`/`DISCORD_BOT_TOKEN` and
   `FACTORY_DISCORD_USER_ID` (fallback: `config/config.json` `superUserId`).
3. **Blocks until answered** — polls card comments every `--interval` ms
   (default `FACTORY_ASK_POLL_MS` or 30 s) and prints the EARLIEST **human
   reply** dated after the `[ASK]` comment as JSON on stdout, exit 0. A comment
   is a human reply when EITHER its first token is `[HUMAN]` (still accepted,
   case-insensitive fast-path) OR it is authored by any member OTHER than the
   bot account (the bot's identity is resolved once per run via
   `GET /members/me`; while the identity lookup is unavailable only
   `[HUMAN]`-tagged replies count). Comments authored by the bot are never
   picked. Detection is
   date-based, not incremental — replies that landed before polling started are
   still found.

**Timeout**: `--timeout` ms, default `FACTORY_ASK_TIMEOUT_MS` or 1 h. On expiry
`ask` prints `{ ..., replied: false, timedOut: true }` and **exits 1**, so the
scheduler treats the stage as failed → bounce/park per the existing rules.

**Answering**: just reply on the card — any comment you post after the `[ASK]`
counts (the earliest one wins); no tag needed. The `[HUMAN]` tag (e.g.
`[HUMAN] use the blue variant`) is still accepted and works even when the
bot-identity lookup is degraded. Answering in Discord is fine too — then paste
the answer as a comment on the card (the board stays the single
source of truth for stage state).

**Approval grammar**: for an approval-gate ask (risk-tier gate, deploy
approval), a bare `Approved` (any casing, any wording that clearly approves)
is sufficient — reply matching is by AUTHOR, never by SHA, so echoing the
sha in the reply is OPTIONAL nicety, never a requirement. A reply that
approves AND names open concerns ("Approved, but the prompt docs are
missing") is an approval with feedback: the resumed run treats the concerns
as findings to address. Dragging the card forward past the gated stage is
likewise a complete answer (see "Listening for human comments").

**Not blocking the stage**: `ask --no-wait` posts + pings and returns
immediately (`{ replied:false, noWait:true }`, exit 0). Later — same run, or a
resumed run after the stage process died — collect the answer with `wait`
(`--since <ISO>` optionally narrows the window; default = process start).
"Ask once, wait many times."

Logic lives in `scripts/lib/factory-ask.js` (dependency-injectable, tested by
`tests/factoryAsk.test.js`).

## Verifying reviewer findings

One reviewer's `[REVIEW:CHANGES]` used to be authoritative: every finding —
real defect, style preference, or condition inherited from master — drove a
full Implement re-run counted against the 3-bounce cap. A false-positive
finding could burn a whole slot. The **Review-verify sub-step** filters false
positives before they bounce: after every `[REVIEW:CHANGES]` the scheduler
spawns **one fresh-context read-only verifier subagent per finding**, which
answers exactly one classification token plus a one-line rationale —
`real` (a genuine defect introduced by this branch), `style-only` (cosmetic,
no correctness impact), or `pre-existing` (already present on `origin/master`).
The scheduler collects the answers into the classifications JSON
(`[{index, verdict, why}]`) and pipes it to
`node scripts/factory.js review-verify <card> -`; the command applies the
mapping, posts exactly one `[REVIEW:VERIFY]` verdict comment, and prints the
routing decision. Verifier subagents post nothing themselves.

The comment format (parseable header + one line per finding):

```
[REVIEW:VERIFY] decision=bounce confirmed=1 nits=1 pre-existing=1 bounces=1/3
#1 [Important→Important] real: <one-line rationale + file:line>
#2 [Important→Nit] style-only: <rationale>
#3 [Pre-existing→Pre-existing] pre-existing: <rationale, present on origin/master>
Nits never bounce; they are fixed on the next Implement re-run if one happens.
Pre-existing findings do not block this card — log them for a follow-up card.
```

`decision` is `bounce` iff ≥1 finding's **final** severity is Important —
and only CONFIRMED Importants get there: the classification → final-severity
mapping is authoritative and monotone-down (verifier authority never
promotes):

| reviewer tag | verifier: `real` | verifier: `style-only` | verifier: `pre-existing` | verifier absent |
| --- | --- | --- | --- | --- |
| `Important` | **Important (CONFIRMED)** | Nit | Pre-existing | Important (fail-closed) |
| `Nit` | Nit | Nit | Pre-existing | Nit |
| `Pre-existing` | Pre-existing | Pre-existing | Pre-existing | Pre-existing |

- **Absent classifications fail closed**: an unverified Important finding
  keeps its bounce — dropping findings because verification was skipped is
  the failure mode this fixes, not reintroduced in reverse.
- **Untagged findings** (a reviewer forgetting the `[Important]`/`[Nit]`/
  `[Pre-existing]` convention) parse as `Important` — the same fail-closed
  default, and they then get a verifier like any other.
- **Nits never consume a bounce**: they ride along on the next Implement
  re-run if one happens anyway, and are otherwise just logged in the verdict
  comment. **Pre-existing findings never block this card** — they are
  recorded in the `[REVIEW:VERIFY]` comment for a future follow-up card.
- **Bounce counting** moves out of LLM arithmetic into
  `node scripts/factory.js bounces <card>` (read-only):
  `# [REVIEW:CHANGES] whose [REVIEW:VERIFY] says decision=bounce` +
  `# [REVIEW:CHANGES] with no [REVIEW:VERIFY] yet (legacy/fail-closed)` +
  `# [SEC:FINDINGS]` + `# [QA:FAIL]` + `# [VERIFY:FAIL]`. A `proceed` verdict
  nets its paired `[REVIEW:CHANGES]` to zero; the scheduler's ≥3 →
  `needs-human` gate reads the command's JSON, never its own arithmetic.

`review-verify` exits 0 on either verdict (bounce is a routing decision, not
a command failure) and exits 1 on misuse — no `[REVIEW:CHANGES]` to verify,
unparseable findings, bad classifications JSON, unknown index/verdict — so a
broken classifications payload can never silently proceed. Logic lives in
`scripts/lib/factory-review-verify.js` (dependency-injectable, tested by
`tests/factoryReviewVerify.test.js`).

## Plan approval gate before Implement

A card never flows into Implement without a human reading the plan.
`[PLAN]` is a bot verdict and is NEVER an approval: implementer compute is
expensive and follows the plan verbatim, so a human must look at the plan
BEFORE it is built. This gate is the Plan→Implement analogue of the risk
gate below — the same sha-keyed approval machinery, keyed to the **plan
commit sha** instead of the QA-passed code sha.

```sh
node scripts/factory.js plan-approve <card> <sha> [--timeout ms] [--interval ms]
```

- **Unconditional: every card, every tier.** The plan commit is a docs-only
  diff, so the deploy gate's low-tier auto-pass would defeat this gate;
  there is no tier escape hatch and no opt-out knob. Human overrides are
  the contract's existing ones: a late sha-keyed approval comment satisfies
  the scan, and dragging the card past Plan→Implement is a human advance
  instruction (the resume rules answer the pending ask).
- **`sha` = the plan-commit HEAD** — `git rev-parse HEAD` in the card
  worktree immediately after the planner commits
  `plans/factory/<id>-plan.md`. Any re-plan is a new commit = new sha =
  the old approval goes stale and the gate re-asks (mirrors the deploy
  gate's rebase rule). If the plan file is untouched, HEAD is unchanged
  and a re-run's scan short-circuits.
- **Scan-first**: a qualifying approval already on the card → exit 0 with
  ZERO new board writes (comments are the state). Otherwise the gate
  **reuses the ask protocol** (`scripts/lib/factory-ask.js`): ONE
  `ask --no-wait` post (`[ASK] Plan approval required ...`) + Discord
  ping, then date-based `wait` polls until timeout
  (`FACTORY_APPROVAL_TIMEOUT_MS`, default `FACTORY_ASK_TIMEOUT_MS` or 1 h).
- An **approval comment** qualifies exactly as in the deploy gate below:
  it mentions the plan sha (full or any ≥7-char prefix, word-bounded) AND
  passes the ask protocol's human-reply rules — human-authored, or
  `[HUMAN]`-tagged and not bot-authored; **bot-authored NEVER counts**;
  degraded identity → tagged-only. A **wrong-sha reply does not count and
  does not re-post the ask** (one ask post/ping per window; the wait
  window advances past it).
- **Timeout** → exit 1 → the scheduler labels `needs-human`, leaves the
  card in **Plan**, and stops the run. This is a **park, not a bounce**:
  the gate posts no `[REVIEW:CHANGES]/[QA:FAIL]/[VERIFY:FAIL]`, so the
  3-bounce counter is untouched. Recovery: approve on the card (a comment
  containing the plan sha) and drag it back to Ready — the re-run's scan
  finds the approval; or a plain `[HUMAN]` reply on the pending ask resumes
  the run at Plan via the comment-resume watcher. While the gate's `[ASK]`
  is pending the ask-pending guardrails apply unchanged (silent watcher,
  stall-hold).

The gate runs **inside the scheduler run**, after the `[PLAN]` comment and
before `move → Implement` (docs "Scheduler loop" PLAN GATE step; the daemon
poller is unchanged). Logic lives in `scripts/lib/factory-risk.js`
(`planApprovalGate`, dependency-injectable, tested by
`tests/factoryRisk.test.js`) behind the `factory.js plan-approve` CLI.

## Risk-tiered approval before Deploy

The **change**, not the author, decides whether a human must look before
Deploy. Every card's diff classifies into a risk tier; medium/high tiers
require an explicit human approval — keyed to the **exact sha that passed
QA** — before the merge+Deploy path. `[QA:PASS]` is a bot verdict and is
NEVER an approval.

### Risk tiers

Inputs: per-file `{path, additions, deletions}` from
`git diff --numstat <merge-base(target, branch)> <branch>` (three-dot
equivalent; `target` default `origin/master`). First match wins:

| Tier | Rule |
| --- | --- |
| `high` (always-human) | any touched path matches the always-human patterns below |
| `high` (blast radius) | total churn `additions + deletions ≥ 500` lines (`HIGH_CHURN_LINES`), OR file count `≥ 25` (`HIGH_FILE_COUNT`) |
| `low` | **docs-only**: every path is `docs/**`, `plans/**`, or `*.md`; OR **additive-only**: every file has `deletions = 0` and no binary entries; and no always-human path matched |
| `medium` | everything else |
| `low` (degenerate) | empty diff (zero files) — nothing to approve |

Always-human paths (any diff size, even 1 line): `scripts/deploy.js`,
`scripts/verify-deploy.js`, `scripts/prod-watch.js`, `scripts/lib/deploy-*`,
`config/`, `.github/`, `Dockerfile*`, `docker-compose*.yml|yaml`,
`deploy-host-logs.sh`, `provision-deploy-host.sh`, `.env*`, `*.pem`/`*.key`,
anything matching `secret` or `credential` (case-insensitive). A docs PR that
also touches `config/` is `high` — path checks run first. Binary files
(numstat `-`) map to `0/0` and can NEVER satisfy the additive-only rule (a
binary-only diff fails toward `medium`).

### Gate protocol

The gate runs **after `[QA:PASS]`, before `git merge --ff-only`**, from the
card worktree, with `sha = git rev-parse HEAD` of `factory/<id>`. The merge is
always `--ff-only` (rebase gate), so the QA sha and the deployed master sha
are byte-identical — the approval keys to the deployed sha too. Placing the
gate before merge means an unapproved medium/high change never reaches
master; the `move → Deploy` also happens strictly after approval.

```sh
node scripts/factory.js approve <card> <sha> [branch] [--timeout ms] [--interval ms]
```

- **Tier low** → exit 0 immediately, ZERO board writes — today's zero-human
  path, unchanged.
- **Tier medium/high** → scan the card's comments first: a qualifying
  approval already present → exit 0 with zero new board writes (this is the
  recovery path: approve late, drag back to Ready, the re-run's scan
  short-circuits — comments are the state). Otherwise the gate **reuses the
  ask protocol** (`scripts/lib/factory-ask.js`) verbatim: ONE `ask --no-wait`
  post (`[ASK] Approval required (risk tier <TIER>: <reasons>) ...`) + Discord
  ping, then date-based `wait` polls until timeout
  (`FACTORY_APPROVAL_TIMEOUT_MS`, default `FACTORY_ASK_TIMEOUT_MS` or 1 h).
- An **approval comment** qualifies when it mentions the sha (full sha or any
  ≥7-char prefix, word-bounded, case-insensitive) AND it passes the ask
  protocol's human-reply rules: authored by a member OTHER than the bot, or
  tagged `[HUMAN]` and not bot-authored. **Bot-authored comments NEVER count,
  even tagged `[HUMAN]` and even containing the sha.** While the bot-identity
  lookup is degraded only `[HUMAN]`-tagged comments count — the same
  fail-closed trade-off as the ask protocol.
- A **wrong-sha reply does not count and does not re-post the ask** (one ask
  post/ping for the whole window; the wait window advances past it). After a
  rebase/QA re-run the sha changes → the old approval stops matching → the
  gate re-asks — including a PRE-MERGE GUARD re-gate rebase: if the tip sha
  changed after approval, re-run `approve` on the new `git rev-parse HEAD`
  (medium/high re-ask and block) before the merge.
- **Timeout** → exit 1 → the scheduler labels `needs-human`, leaves the card
  in QA, does NOT merge, and stops the run. This is a **park, not a bounce**:
  the gate posts no `[REVIEW:CHANGES]/[QA:FAIL]/[VERIFY:FAIL]`, so the
  3-bounce counter is untouched (an approval timeout can never burn bounce
  budget). Recovery: approve on the card, drag it back to Ready (removes the
  label; existing dispatch rule) — the re-run's scan finds the approval.
- Interaction: a live pending `[ASK]` keeps the comment-resume watcher silent
  (existing guardrail) — the blocking gate owns the reply. If the run died
  mid-gate, the daemon's existing crash re-queue / Ready-drag paths own
  recovery. Up to `FACTORY_MAX_PARALLEL` runs may each block ≤1 h on
  approval; the timeout knob bounds it.

`risk <branch> [target]` prints the same tier classification for any branch
diff (git-only, zero board writes) — informational; agents may check it early.
Logic lives in `scripts/lib/factory-risk.js` (dependency-injectable, tested by
`tests/factoryRisk.test.js`).

## Pinging on Done

### Two ping paths, one state file

There are **two triggers, one dedup state file** (`data/factory-done-ping.json`):

- **`move <card> Done` pings inline (best-effort).** After the move is
  verified, `factory.js move` calls `pingDoneArrival`
  (`scripts/lib/factory-done-ping.js`), which sends the same
  `✅ Done: <card title> — <url>` message and advances the shared state file —
  works with **no watcher running**, which is how the scheduler gets pinged.
  Ping diagnostics go to stderr; ping failure never changes `move`'s exit code
  or its `{card, movedTo}` JSON (a `donePing` key is added on Done moves only).
  `--no-ping` opts out (e.g. bulk/retro moves).
- **`done-watch` remains the poller that catches UI drags.** Board-UI arrivals
  can only be caught by polling, so `done-watch` still exists — and
  `factory-daemon` **auto-starts and supervises it in-process**
  (launchd-managed: RunAtLoad + KeepAlive + crash-restart), so UI-drag
  coverage is always on with zero human ceremony. Do **not** also run
  `factory.js done-watch` by hand while the daemon runs — two live pollers
  can double-ping in a race (the shared-state dedup only guarantees
  sequential dedup). Manage the daemon with
  `node scripts/factory-daemon.js run|install|uninstall|status`.

**Dedup:** both paths read/write the same `data/factory-done-ping.json` and
advance a card's entry only after `{sent:true}`. A sequential arrival handled
by either path pings **exactly once** — whichever runs second sees the card
recorded as Done and skips. Residual edge (accepted, same class as the
out-and-back-in-one-interval edge): a poller tick that read state a moment
before the inline write may **double-ping once** in a sub-second concurrent
window.

**Fresh state:** with no/corrupt state file the inline path seeds a **full
board baseline** before recording the arrival (so a live poller never ping-
storms every other Done card). The poller's first-run silent-baseline
semantics are unchanged.

### The poller

`done-watch` DMs Andrew on Discord once per card **arrival** in the `Done`
list — a poll-and-diff of board state, so it catches cards a human drags in
the Trello UI (scheduler moves now ping inline via `move` too; both paths
dedup through the shared state file):

```sh
node scripts/factory.js done-watch [Done] [--interval <ms>] [--once]
```

`factory-daemon` runs it automatically, supervised in-process — run it by
hand only for diagnostics (`--once`), NEVER alongside the live daemon;
`--once` does exactly one poll cycle and prints the JSON result. Each arrival sends one message
`✅ Done: <card title> — <url>` (same identity plumbing as the ask ping:
`FACTORY_DISCORD_WEBHOOK` → `FACTORY_CHANNEL_ID` → bot DM) and logs a `DONE <id> <name>`
line.

**Dedup / restart semantics** (same philosophy as `watch`, but stateful):

- The poller persists each card's last-known list in
  `data/factory-done-ping.json`. The **first run is a silent baseline** — cards
  already sitting in Done never ping; deleting the file re-baselines.
- An arrival is marked Done in state only **after** the ping succeeds
  (`{sent:true}`), so delivery is **at-least-once**: a failed ping (bad token,
  Discord down) is retried every tick and self-heals once the credentials work
  again — permanent failures cost log noise, not a lost notification.
- Restarting with a card still in Done does **not** re-ping (the state file
  dedupes across restarts). Dragging a Done card out and back in pings again —
  one notification per arrival.
- If the Done list is deleted and recreated (its id changes), the poller
  re-baselines silently instead of pinging every Done card. Cards that vanish
  from the board are pruned from the state file.
- Deliberate limitation (same class as `watch` missing fast Ready churn): a
  card moved into Done and back **out** within one poll interval is not pinged.
- **Best-effort:** fetch, ping, and state errors are logged and retried — the
  poller never crashes on them.

Interval: `--interval` ms, default `FACTORY_DONE_POLL_MS` → `FACTORY_POLL_MS`
→ 15 s. Logic lives in `scripts/lib/factory-done-ping.js`
(dependency-injectable, tested by `tests/factoryDonePing.test.js`).

## Prod watchdog (`scripts/prod-watch.js`)

The bot VM gets its IP from DHCP (`iface eth0 inet dhcp`), so a reboot can move
it to a NEW address and every ssh-based tool then reads prod as DOWN. The
watchdog closes the loop on the laptop:

```sh
node scripts/prod-watch.js once          # one probe cycle (launchd target)
node scripts/prod-watch.js run [--interval ms]   # manual loop
node scripts/prod-watch.js install|uninstall|status  # launchd com.discordbot.prodwatch, 300s
```

Per cycle: one ssh probe (`docker compose ps` states + shipped
`deploy-host-logs.sh` classifier — same exit contract as Verify). Verdicts:
`up` (classifier 0/2), `unhealthy` (container down / crash / classifier tool
broken), `unreachable` (ssh failed). On `unreachable` it ARP-sweeps the LAN and
ssh-`hostname`s live IPs to detect DHCP drift and name the VM's new address.

Incident semantics (`data/prod-watch.json`, silent-baseline on first run,
down-state dedupes repeats): up→down sends a Discord DM (same identity plumbing
as ask/done pings) AND opens a `[PROD-WATCH]` card in **Ready**, so the factory
daemon auto-investigates the outage; down→up DMs recovery and comments
`[PRODWATCH:RECOVERED]` on the card (kept open for root-cause closure).

Hardening (prevents the drift, not just detects it): DHCP reservation on the
router for the VM's MAC, or a static stanza in `/etc/network/interfaces` on the
VM console — the factory user has no sudo, so both are operator actions.

### Incident closure: which layer should have caught this

Every `[PROD-WATCH]` outage/bad-deploy card must carry **exactly one
`[PROD-CLOSE]` comment** answering **which layer should have caught this** —
one layer from the taxonomy + why + the fix — **before it moves to Done**.
Run it as the last comment before the Done move:

```sh
node scripts/factory.js prod-close <card> --layer <name> --why "<text>" [--fix "<text>"]
```

- **Layer taxonomy** (the one enum shared by the CLI, the docs and C-M11):
  `plan`, `implement`, `review`, `security`, `qa`, `deploy`, `verify`,
  `prod-watch` (detector latency / no earlier layer could catch it), `infra`
  (host/DHCP/power — no pipeline layer applies), `unknown`. An unknown layer
  exits 1 and prints the valid list.
- **Comment shape:** `[PROD-CLOSE] which-layer=<layer> — <one-line why> (fix: <one-line fix or "n/a">)` —
  first token `[PROD-CLOSE]`, bot bookkeeping (class of `[RESUME]`/`[DAEMON-CRASH]`;
  Board contract tag list).
- **Durable seed:** each `prod-close` also appends one JSON line
  `{ ts, card, url, title, layer, why, fix }` to
  `data/prod-close-seed.jsonl` (gitignored `data/`, runtime append only) —
  `node scripts/factory.js eval-seed` consumes these lines into the committed
  eval set `eval/cases.jsonl` (one JSON case per closed incident; the C-H5 →
  eval loop closes with zero extra machinery — the JSONL is the contract
  boundary, deduped by card id on merge).
- **Mechanical gate** in `factory.js move <card> Done` (mirrors the inline
  Done-ping hook and the `mergeable`/`security-check` gate precedents): if the
  card title matches `[PROD-WATCH]`, the move fetches its comments and
  requires a `[PROD-CLOSE]` comment — missing ⇒ the move **refuses** (exit 1,
  actionable message naming `prod-close`); comment-fetch errors are
  **fail-open** (stderr note, move proceeds — best-effort board reads per the
  ping precedent); `--no-close-check` opts out (bulk/retro moves, same spirit
  as `--no-ping`). UI drags are ungated by nature; this section is the
  convention for human closures.
- Logic lives in `scripts/lib/factory-prod-close.js` (dependency-injectable,
  tested by `tests/factoryProdClose.test.js`).

### Gradual rollout (internal-first)

There is no flag/staged-release machinery — a deploy lands one-shot on the
single prod host — so the cheap staged release is the **deploy cadence**
itself: the daemon's default cap is **one card in flight**
(`DEFAULT_MAX_PARALLEL = 1`, env `FACTORY_MAX_PARALLEL`), which turns the
existing prod watchdog into the canary probe. Consecutive `[DEPLOY]`s are
separated by at least a full pipeline duration, so the installed watchdog
(`com.discordbot.prodwatch`, launchd `StartInterval` 300 s /
`PROD_WATCH_INTERVAL_MS`) gets ≥1 probe of the new build before any next
build can land — **the watchdog interval is the canary interval, zero new
code**. A bad deploy surfaces as a `[PROD-WATCH]` Ready card before the next
deploy ships.

**Do NOT raise `FACTORY_MAX_PARALLEL` above 1 until both hold:**

1. the fresh-master merge guard (`factory.js merge-guard`, "PRE-MERGE GUARD"
   under "Scheduler loop") is on `master` — with >1 card in flight its
   freshness re-check is what keeps every `--ff-only` race-free; and
2. the last ≥3 cards that reached Done opened **zero** `[PROD-WATCH]`
   outage/bad-deploy cards for their build within ≥1 watchdog window after
   `[DEPLOY]` (≥300 s of watchdog probing per build, zero outage cards =
   the builds held).

Raise by setting `FACTORY_MAX_PARALLEL` in the daemon's process environment
(the launchd plist `EnvironmentVariables` or an interactive `run`) and
**restarting the daemon** — the cap is read once at startup. The plist env
wiring itself stays an operator action.
## Reviewer replay scoring (C-M11)

Prompt/model changes (`buildRunPrompt` edits, `FACTORY_MODEL` flips, harness
upgrades) land blind unless scored against expert-checked past incidents —
the improvement loop only KEEPS a change whose score goes up. The instrument:

- **The eval set:** `eval/cases.jsonl` (COMMITTED next to the prompts it
  scores — unlike the gitignored `data/`). One JSON case per incident: the
  inline evidence (`[IMPL]` excerpt / diff / context), the confirmed
  `expected` verdict, and `curated: true` — the expert sign-off. Harvested
  candidates land `curated: false`; only curated cases are ever scored, and
  flipping the flag + committing is the sign-off.
- **Harvest:** `node scripts/factory.js eval-seed` merges the board's
  unresolved bounce verdicts (`[REVIEW:CHANGES]`/`[SEC:FINDINGS]`/`[QA:FAIL]`/
  `[VERIFY:FAIL]`) + the `prod-close` seed JSONL into the set, deduped by
  case id (curated edits never clobbered). Expected-verdict proposal rule:
  a real reviewer bounce ⇒ `[REVIEW:CHANGES]`; an incident whose layer is
  `review` ⇒ `[REVIEW:CHANGES]`; any other layer ⇒ `[REVIEW:APPROVE]` (the
  reviewer must not over-flag). `--dry` prints the merge with zero writes.
- **Replay + gate:** `node scripts/factory.js eval-run` seeds the Reviewer
  role (`STAGE_PROMPT_FILES.reviewer`) over each curated case's evidence with
  the daemon's own `agentArgs` — `FACTORY_MODEL`/`FACTORY_OMP_BIN`/
  `FACTORY_MAX_COST` env IS the comparison knob — parses the one-line verdict,
  and scores it (`findingsMustInclude` substrings must appear in a CHANGES
  reply). Before KEEPING a prompt/model change: `eval-run --min-score
  <baseline>` (exit 1 = score dropped = don't keep it). `--no-spawn` re-scores
  stored `got` replies with zero agent spawns (free smoke). `--out` writes a
  key-stable JSON report so before/after runs diff cleanly.
- **No CI job runs `eval-run`:** spawns cost money; the gate is run manually
  before keeping a change. Logic lives in `scripts/lib/factory-eval.js`
  (dependency-injectable — zero live Trello/spawns in
  `tests/factoryEval.test.js`).

## Nightly review sweep (`scripts/factory-sweep.js`)

The daemon is purely reactive — it only dispatches Ready arrivals, so slowly
surfacing bugs in already-merged code wait for a human to notice. The sweep is
the standing proactive review: a nightly scheduled job files **one
auto-generated `[SWEEP YYYY-MM-DD]` review card into Ready**; the untouched
daemon dispatches it exactly like a `[PROD-WATCH]` incident card (same
primitive `trello.createCard(name, readyId, desc)`; the per-card instructions
live in the card description, which every stage agent reads via
`factory.js read`). Findings become follow-up `[SWEEP-FINDING …]` Ready cards
via `factory.js add` + `desc`, so each fix rides the normal pipeline. Zero
changes to `factory-daemon.js`, the board contract, or the stage prompts.

```sh
node scripts/factory-sweep.js once [--date YYYY-MM-DD]     # one sweep (launchd/cron target; stdout = JSON)
node scripts/factory-sweep.js dry-run [--date YYYY-MM-DD]  # identical plan, ZERO side effects (no fetch, no board writes)
node scripts/factory-sweep.js install|uninstall|status     # launchd com.ajohnson.factory-sweep, daily 03:15 (FACTORY_SWEEP_HOUR/MINUTE)
```

Per `once` tick: best-effort `git fetch origin master` (fail-open to local
refs on network failure, logged) → slice = files touched on `origin/master`
within `FACTORY_SWEEP_DAYS` (default 7), factory paperwork (`plans/**`,
`docs/factory-prompts/**`) excluded, lockfiles kept, deduped, sorted, capped
at `FACTORY_SWEEP_MAX_FILES` (default 40; overflow named in the card
description as *not covered tonight*). An **empty window files no card**
(`{action:'skipped-empty-window'}`) — a quiet repo must not spam Ready.
**Date-title dedup** (seed-audit precedent, board-is-the-state): if any open
board card's name starts with `[SWEEP <YYYY-MM-DD>]` the tick skips
(`{action:'deduped'}`), so a double fire — cron + launchd coexistence, or a
launchd sleep-wake catch-up — creates 0 cards. Filing attaches the existing
`Low` priority label (reused by name from `seed-audit`); stdout is the JSON
contract, progress goes to stderr.

The card description is machine-written requirements (the prod-watch incident
card precedent — agents still never edit it): review the slice against the
review ground-truth docs — `docs/factory-prompts/reviewer.md` (mindset,
full-pass rules) **and** `docs/security-review.md` (checklist) — applied to
the EXISTING code, not a diff; file every finding (file:line, why it matters,
suggested fix, severity HIGH/MEDIUM/LOW) as its own `[SWEEP-FINDING <date>
<n>]` Ready card via `node scripts/factory.js add Ready …` +
`node scripts/factory.js desc <id> -`; cap `FACTORY_SWEEP_MAX_FINDINGS`
(default 5, highest severity first) with the overflow recorded in the sweep
card's `[IMPL]` comment, never silently dropped. The sweep card itself commits
NO code (its only commit is its own plan file → risk tier `low`), and its
`[IMPL]` evidence is the review trail + the ids/urls of the filed finding
cards; a clean sweep states "no findings — slice reviewed against both
ground-truth docs" plus the covered-file list.

Scheduler: launchd `StartCalendarInterval` (launchd's cron) — `install`
bootout-then-bootstraps `~/Library/LaunchAgents/com.ajohnson.factory-sweep.plist`
(`RunAtLoad=false` so installing never fires an immediate sweep; the `PATH`
env dict and `FACTORY_SWEEP_*` values are baked in, logs to
`data/factory-sweep/launchd.*.log`). A missed interval during sleep
coalesces into one run at wake — deduped by date. Crontab equivalent (safe to
run both thanks to the date-title dedup):

```cron
15 3 * * * cd /Users/andrewjohnson/GitHub/discord-bot && /usr/local/bin/node scripts/factory-sweep.js once
```

Accepted by design: the sweep card reaches Deploy/Verify (master is
redeployed nightly — identical to `[PROD-WATCH]` cards, no special case);
finding cards queue behind the daemon's 3-in-flight dispatch cap. Logic lives
in `scripts/lib/factory-sweep.js` (dependency-injectable, tested by
`tests/factorySweep.test.js`).
## Metrics report (`scripts/factory-metrics.js`)

The board is the metrics database (every signal is already a comment), so the
reporting pass is pure read-only counting — zero daemon edits, zero dispatch
risk. It reads board state + `data/prod-watch.json` + `data/factory-daemon/*.log`
and posts ONE `[METRICS]` comment onto a dedicated `Factory metrics report`
card parked in **Done** (inert to the daemon, created once and reused — never
a new card, so the Done pinger stays quiet). The comment is a **compact
summary** — the `[METRICS]` headline plus condensed per-signal lines — never
the full report JSON: Trello caps comment text at ~16,384 chars, and a
full-history pretty-printed report (30 KB+, growing with the board) would
400 every post and freeze the window watermark forever. The body is bounded
by construction (card-name lists cap at 12 items of 48 clipped chars, error
lines at 3 × 160) with a final hard guard clamping ANY report to
`METRICS_COMMENT_MAX_CHARS` (15,000 — well under the cap; proven by fake
adversarial tests), so the post can never exceed the limit. The **full JSON**
stays in the local artifacts: `data/factory-metrics/latest.json` +
`archive/<ISO>.json`, written on every posted run.

```sh
node scripts/factory.js metrics [--no-post] [--since <ISO8601>]   # JSON report; default also posts
node scripts/factory-metrics.js once|run|install|uninstall|status # launchd com.discordbot.factory-metrics, 6 h
```

**Report sections** (all counts are tallies of comment first-token tags,
case-insensitive, matching the board contract):

- **Bounces** — per card via the gate function **itself**: `countBounces()`
  imported from `scripts/lib/factory-review-verify.js` — the exact netting the
  scheduler's needs-human ≥ `BOUNCE_CAP` park gate reads. Over the **whole
  trail**: `[QA:FAIL]`/`[VERIFY:FAIL]`/`[SEC:FINDINGS]` count unconditionally;
  `[REVIEW:CHANGES]` counts until a later `[REVIEW:VERIFY]
  decision=proceed` nets it to zero (the standard noise outcome). `lifetime` =
  whole-trail net total (gate-equivalent by construction); `pending` = the
  same rule applied to the trail after the latest `[IMPL]` (the open bounce
  round); `needsHumanRisk` = the gate's park condition (net total ≥
  `BOUNCE_CAP`). `windowTagTally` is a **separately labeled raw tally** — #
  bounce-tag comments dated inside the window, no netting, not the gate rule.
  Board-wide: cards with (netted) bounces, max netted lifetime, needs-human-
  labeled count.
- **Stage times** — stage boundary = that stage's tag comment landing.
  `planMs` (from the first-comment/Plan-entry proxy), `implementMs`
  (`[IMPL]`−`[PLAN]`), `reviewMs` (first `[REVIEW:*]` − last preceding `[IMPL]`),
  `qaMs` (first `[QA:*]` − preceding `[REVIEW:APPROVE]`), `deployMs`
  (`[DEPLOY]`−`[QA:PASS]`), `verifyMs` (`[VERIFY:*]`−`[DEPLOY]`), `totalMs`
  (`[VERIFY:PASS]`−`[PLAN]`). Reported as p50/p95/max across cards in the
  window; intervals count only when BOTH endpoints exist — never fabricated.
  Honest caveat printed in the report: comment dates mark stage *completion*;
  queue wait in Ready before daemon dispatch is invisible to comments.
- **Crashes** — `[DAEMON-CRASH]` comments per card (comment-based, so counts
  survive daemon restarts and log rotation — same source the crash cap reads).
- **`[ASK]` latency** — per `[ASK]`: time to the EARLIEST reply authored by a
  member ≠ bot (or `[HUMAN]`-tagged when identity resolution is degraded) —
  byte-for-byte the ask protocol's reply rule; + `unanswered` count. Timeouts
  are not board-observable beyond unanswered/late cases.
- **Ask-on-top** (`askOnTop`, card 6af60d6a85947225f6ed75a0) — the
  regression signal for the invariant "a card waiting on a human shows its
  request as the NEWEST comment": over ALL `needs-human`-labeled cards, is
  the newest comment human-facing — first line opens `[ASK]` (pending ask)
  OR second line starts `needs you:` (park action line)? `needsHumanCards`
  = the labeled population; `scored` = those whose trail could actually be
  fetched (an unfetchable trail lands in `errors` and the card is EXCLUDED
  — never a fabricated green or red; the reporting pass fetches the newest
  comment even for cards untouched in the window); `offenders` = scored
  cards whose top comment is forensic noise instead of the request; `ok` =
  every scored card clean AND the population fully scored — `null` when the
  board has zero needs-human cards (nothing to assert). Headline + summary
  carry it; offenders render clipped to bounded lists like every other
  signal line.
- **`[REVIEW:CHANGES]` dispositions** — per round: `fixed` (new `[IMPL]` landed
  and a later `[REVIEW:APPROVE]` followed it), `dismissed` (intervening
  `[IMPL]` carries dismissal markers — `dismissed`/`won't fix`/`will not
  fix`/`declined`/`not valid`/`rebut*`/`disagree*` — or `[REVIEW:APPROVE]`
  arrived with NO intervening `[IMPL]`, reviewer withdrew), `open` (verdict
  pending). Reported as `actedRatio` + dismissed ratio; dismissal detection is
  KEYWORD-HEURISTIC — a structured disposition protocol is the obvious
  follow-up, not this mechanism.
- **Prod guardrail** — `data/prod-watch.json` snapshot (status/incident/
  lastCheck/lastVerdict) + `[PROD-WATCH]` incident cards opened in the window.
  Missing/corrupt state ⇒ section `null` + error note, never a crash.
- **Cost vs cap** — runs started in the window from the daemon logs'
  `# dispatch`/`# resume` headers, the LIVE `--max-cost` cap = the cap echoed
  by the **newest in-window** header (never a hardcoded 10, never the
  all-time max — a lowered `FACTORY_MAX_COST` shows up immediately; the newest
  header overall is the fallback only when the window has none, labeled via
  `costCapSource`), best-effort spend from a tail cost/usage line
  (`costObserved: false` when omp prints none — nothing is fabricated);
  crashed runs surface as `costCapSuspect`.

**Windowing + posting:** window = `[lastRun, now]` from
`data/factory-metrics.json` (override `--since` / `FACTORY_METRICS_SINCE`;
first run = full board history). Cards are touched only when they carry a
comment in the window; cards at the 50-comment fetch cap are reported
`truncated`. State advances **only after a successful post** — at-least-once
reporting (a failed post retries the same window). If the pinned report card
was deleted or archived by a human, the failed `addComment` **404** clears the
stale `lastReportCardId` pin (the `lastRun` watermark stays untouched), so the
next run finds-or-creates a fresh report card instead of 404-ing forever. The
**full** report JSON (every per-card roll-up entry, unclipped names — the
board comment shows only the clipped top-12 lists) is persisted to
`data/factory-metrics/latest.json` (+ `archive/<ISO>.json`) **on posted runs
only** — `--no-post` writes NOTHING at all, so a dry run never overwrites the
last real report.
Exit 0 even on degraded reads (they land in `report.errors`); exit 1 only when
the board fetch failed — nothing to report. `metrics --no-post` does ZERO
external writes — no board write, no Discord send AND no report artifacts
(safe any time, including alongside the live daemon — the pass writes no card
state, just its one summary comment + optional owner ping).

Alongside the board comment the pass also DMs the owner the same headline
(`📊 <headline>` via `sendOwnerPing` — the ask/done-ping identity plumbing:
`FACTORY_DISCORD_WEBHOOK` → `FACTORY_CHANNEL_ID` (bot send to the factory
channel) → `BOT_TOKEN` DM to `FACTORY_DISCORD_USER_ID` / config
`superUserId`). **Best-effort by contract:** the send
happens only after a successful board post + state advance, and any Discord
failure lands in `report.errors` and changes nothing else — the run exits 0
and the window watermark stays advanced (reporting to the board is the
durable record; the ping is a courtesy copy).

Interval: `FACTORY_METRICS_INTERVAL_MS` (default 21600000 = 6 h — a full
$10-capped agent run every 6 h for deterministic counting would violate the
cost factor the report itself measures, so this is a plain scheduled script,
not a Ready-card pipeline cycle). Logic lives in
`scripts/lib/factory-metrics.js` (dependency-injectable, tested by
`tests/factoryMetrics.test.js`).

## Listening for human comments

A human comment on an **in-flight** card whose scheduler run has died used to
be invisible: the ask protocol only polls comments *while a stage agent is
alive*, so a run that ended between stages (e.g. `[DEPLOY]` landed, the run
died before Verify) left the card unanswered forever. The **comment-resume
watcher** closes that gap: `factory-daemon` auto-starts and supervises it
in-process (same lifecycle as the Done pinger), so listening is always on
with zero human ceremony.

```sh
node scripts/factory.js resume-watch [--interval ms] [--once] [--dry-run]
```

### Trigger rules (one tick)

Each tick the watcher fetches the cards in the **in-flight lists**
(Plan, Implement, Review, QA, Deploy, Verify — Ready/Done/To Do are never
listened to, and `needs-human` cards are never fetched-for-comments or
touched), and for each card reads its **events** — the comment trail merged
with the list-move trail (`updateCard:idList`, best-effort: a move-fetch
failure degrades the tick to comment-only and logs, never silently loses a
drag). An event **qualifies** when ALL hold:

- it is the card's **latest** event (comment or move);
- its author is a member **other than the bot** (identity via
  `GET /members/me`, cached per process; when the identity lookup fails
  the whole tick is skipped — **fail-closed**, never act blind). Scheduler
  moves carry the token member (`ompbot`), a UI drag carries the dragger —
  so a human drag is distinguishable from every scheduler move;
- its date is **after the latest bot-authored event** — a bot MOVE counts as
  a bot event too, so the scheduler's own moves neither trigger nor mask a
  pending human comment;
- its id differs from the card's persisted **watermark** — a
  processed comment or move never re-fires, across restarts
  (`data/factory-comment-resume.json`).

A qualifying **human list-move** (a drag) is the human's instruction to
advance: it resumes the pipeline at the destination list's stage (the
stuck-Verify / rollback traps apply unchanged), acks with a `[RESUME]`
naming the drag, and **answers any pending `[ASK]`** — dragging the card
past the gated stage is an approval decision, so it must not be swallowed
by the ask-pending guard. A bare comment `Approved` (no SHA echo) is a
complete approval reply: reply matching is by author, never by SHA (see
"Asking a human" — Approval grammar).

### Respond + stage-aware resume

For each qualifying comment the watcher:

1. **Responds** — posts `[RESUME] …` (first token `[RESUME]`, quoting the
   human's comment) **before** spawning, so the response is visible even if
   the spawn then fails. Repeated retries never re-ack the same comment
   (`ackSentFor` dedup in the state file).
2. **Resumes at the card's CURRENT stage** — spawns a headless scheduler run
   (the daemon's spawn machinery + `FACTORY_MAX_PARALLEL` cap) seeded with the
   card's current list; the prompt **forbids moving the card back to Plan or
   Ready**, mandates reusing the existing `factory/<id>` worktree/branch,
   seeds the run with the curated stage context
   (`factory.js context <id> <stage>` — the raw trail is audit-only, see
   "Per-stage context"), tells the run to address the quoted comment,
   continue from the current stage, or post `[ASK]` (never move the card)
   when continuation is impossible.
3. **The stuck-Verify trap:** a card in Verify — or Deploy with the Verify
   move still pending — whose last stage tag is `[DEPLOY]` with no
   `[VERIFY:*]` after it resumes at the **Verify** stage: the run re-runs
   `scripts/verify-deploy.js` and posts `[VERIFY:PASS]`/`[VERIFY:FAIL]` per
   the contract, instead of replanning a finished implementation.
   **The rollback trap** (card 6ae9676d2461fd41204b507e): a card in
   Verify/Deploy whose last stage tag is `[ROLLBACK]` resumes at
   **Implement** — the `[VERIFY:FAIL]` verdict and the last-known-good
   restore are both on the card, so the pending action is the fix-forward
   bounce the dead run never completed (the resumed run performs the bounce
   move, a legal scheduler move).

The watermark advances only after a successful spawn (**at-least-once**
spawn, spam-free retry); if no concurrency slot is free the watermark stays
and the resume retries next tick.

### Guardrails

- **The `[ASK]` path is untouched while the ask is PENDING:** if
  `isAskPending` says the latest `[ASK]` is still unanswered, a blocking
  `ask`/`wait` owns the reply — the watcher advances the watermark
  **silently** (no ack, no spawn). Answering an ask works byte-for-byte as
  before (the live waiter is deduped by the live-run guard below). An
  **answered** ask whose waiter died with its run — exit-0 mid-wait leaves
  `[ASK]` as the latest bot comment with nobody waiting — is **resumed**
  like any other human comment; keying the guard on "still unanswered"
  rather than "latest bot comment opens with `[ASK]`" is what keeps an
  abandoned risk-gate approval from stranding the card forever (card
  6ae9676d0ee4189387157881, C-H4). The same pending-ask verdict (`isAskPending` in
  `scripts/lib/factory-comment-resume.js`) also **holds crash recovery and
  the stall sweep** (card 6aebab9a65613358f4ca333a): an in-flight card with
  an unanswered `[ASK]` decides `hold` — zero move, zero spawn — and
  stall-family recovery posts no `[DAEMON-CRASH]` at all: the pending
  `[ASK]` comment is the board-visible "waiting on a human" (card
  6aee77a4db0dd0de45c77d7c); non-zero crashes under a pending ask post the
  hold record **head-only** — no run-log tail (RC4 amendment, card
  6af60d6a85947225f6ed75a0: the tail exists so a RESUMING run self-heals;
  this hold spawns no resume, so the tail only buries the ask) — and every
  daemon bookkeeping post that leaves an ask pending ends with the
  **ask-lift re-post** (`liftPendingAsk`): the pending `[ASK]` is re-posted
  VERBATIM so it is the card's NEWEST comment again — a human must never
  scroll past forensic noise to find what they owe. Re-posting is the only
  lift mechanism: a Trello comment EDIT does not restamp or move it
  (API-verified 2026-11-12).
- **Live runs dedup silently:** a comment arriving while the card has a live
  run advances the watermark without ack/spawn — the live run owns the card
  (its stage-boundary reads + the ask protocol cover it).
- **Loop guard:** after `FACTORY_RESUME_MAX` (default 5) auto-resumes per
  card, further comments advance the watermark with a log line only — the
  watcher never labels or moves cards itself.
- **Board hygiene:** the watcher only ever posts the `[RESUME]` ack; only
  resumed scheduler runs move cards forward, per the board contract. A
  crashed run — resume **or** dispatch — gets the stage-aware recovery of
  "Auto-start daemon": it resumes at the card's current stage once a stage
  verdict exists and parks `needs-human` **where the card stands** at the
  crash cap — never a Ready re-queue once committed work exists.
- **Restart-safe:** watermarks persist in `data/factory-comment-resume.json`
  (atomic writes, vanished cards pruned); a card with a genuinely pending
  unanswered comment (exactly the stuck-Verify shape) is answered on the
  **first tick** after deploy — no silent baseline — then answered exactly
  once.

**CLI diagnostics:** run `resume-watch` by hand only for inspection — the
daemon already owns the live watcher. `--once` runs one cycle and prints the
JSON result; `--dry-run` reports the would-resume cards (`WOULD-RESUME` lines
+ JSON summary) with **zero board writes and zero state writes**, safe
alongside the live daemon. Never run a live `resume-watch` alongside the
daemon (a concurrent tick can double-spawn).

Interval: `--interval` ms, default `FACTORY_RESUME_POLL_MS` →
`FACTORY_POLL_MS` → 15 s. Logic lives in
`scripts/lib/factory-comment-resume.js` (dependency-injectable, tested by
`tests/factoryCommentResume.test.js`); supervision mirrors the Done pinger in
`scripts/factory-daemon.js` (`superviseCommentWatch`).

## Credentials

`.env` (gitignored): `TRELLO_KEY`, `TRELLO_TOKEN`, optional `TRELLO_BOARD`
(default `ZHkVYBN1`). Key/token from <https://trello.com/account>.

Ask-protocol extras (all optional; see `docs/factory.md` "Asking a human"):
`FACTORY_DISCORD_USER_ID` (owner DM target; default = config `superUserId`),
`FACTORY_CHANNEL_ID` (channel ping target — beats the DM; the factory bot's
server, `FACTORY_SERVER_ID` records which guild the bot was invited to and
is not used for the send), `DISCORD_BOT_CHANNEL_ID` + optional
`DISCORD_BOT_BOARD_ID` (FM-6 per-board routing: pings for that board —
default `ZHkVYBN1` — go to this channel instead of `FACTORY_CHANNEL_ID`),
`FACTORY_DISCORD_WEBHOOK` (ping override, beats
everything), `FACTORY_ASK_TIMEOUT_MS` (default 3600000), `FACTORY_ASK_POLL_MS`
(default 30000). Every ping path reuses `BOT_TOKEN`/`DISCORD_BOT_TOKEN`.
`FACTORY_DONE_POLL_MS` (default `FACTORY_POLL_MS` or 15000) sets the
`done-watch` Done-list poll interval — see "Pinging on Done"; the Done ping
reuses the same Discord identity vars, no new required credentials.
`FACTORY_RESUME_POLL_MS` (default `FACTORY_POLL_MS` or 15000) sets the
comment-resume watcher's poll interval and `FACTORY_RESUME_MAX` (default 5)
caps auto-resumes per card — see "Listening for human comments"; no new
required credentials. `FACTORY_STALL_POLL_MS` (default 300000) sets the
stall sweep's interval and `FACTORY_STALL_SILENCE_MS` (default
`FACTORY_MAX_TIME` + 15 min) its silence window — see "Auto-start daemon"
(stall recovery); no new required credentials.
`FACTORY_SWEEP_DAYS` (default 7) selects the merge window the nightly review
sweep reviews, `FACTORY_SWEEP_MAX_FILES` (default 40) caps the nightly slice
(overflow named in the card description), `FACTORY_SWEEP_MAX_FINDINGS`
(default 5) caps the follow-up finding cards one sweep run files (overflow
recorded in its `[IMPL]` comment), and `FACTORY_SWEEP_HOUR` /
`FACTORY_SWEEP_MINUTE` (default 3:15) set the launchd calendar time baked at
`install` — see "Nightly review sweep"; the sweep reuses `TRELLO_KEY` /
`TRELLO_TOKEN`, no new required credentials.
`FACTORY_METRICS_INTERVAL_MS` (default 21600000 = 6 h) sets the metrics
reporter's launchd/`run` cadence, `FACTORY_METRICS_SINCE` (ISO 8601) overrides
the window start, and `FACTORY_METRICS_LIST` (default `Done`) names the list
holding the report card — see "Metrics report". The metrics summary DM reuses
the same Discord identity vars as the ask/done pings; no new required
credentials.
`FACTORY_APPROVAL_TIMEOUT_MS` (default `FACTORY_ASK_TIMEOUT_MS` or 3600000)
gates approval waits — see "Risk-tiered approval before Deploy"; no new
required credentials.
