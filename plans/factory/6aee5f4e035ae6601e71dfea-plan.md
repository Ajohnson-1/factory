# Plan — FM-7: Retire factory code from discord-bot (post-soak cleanup)

Card `6aee5f4e035ae6601e71dfea` · routed repo `factory` (this branch carries the
factory-side doc updates) · deletion lands directly on **discord-bot master**
(`/opt/repos/discord-bot`, precedent: FM-1 `726eb39` "FM-1: npm test drops factory
test files…" + `5d405d8`).

## Migration state (verified this session)

- FM-6 cutover EXECUTED 2026-11-09: box `/opt/factory` (systemd user unit
  `factory-daemon.service`) is the sole dispatcher; laptop agents booted out
  (§6.2/§9). The discord-bot factory copies have been **inert** since — deletion
  moves nothing that runs. Soak clock ends 2026-11-16; the pipeline dispatching
  this card IS the go-ahead (§6.3: rollback = revert the one discord-bot commit).
- All 62 block-one files have byte- or superset-counterparts in the factory repo
  (verified: every deleted script/lib/test exists in the factory tree;
  `docs/factory.md`/`docs/deploy-host.md` differ only because the factory copies
  are the canonical newer versions).
- Live deploy proof for sub-step 5 (below, "Why the deploy survives").

## Design decisions

**D-7a — three libs STAY (recorded FM-7 deviation from "delete everything in the
first block").** Two surviving bot scripts import block-one libs; deleting them
would break `npm test` (both tests run in the `node --test` half of the script):

| kept file | surviving dependent | import site |
|---|---|---|
| `scripts/lib/deploy-config.js` | `scripts/g50ProdRead.js` (§5: stays — bot rollout collector) | `g50ProdRead.js:43` |
| `scripts/lib/deploy-ssh.js` | `scripts/g50ProdRead.js` + `tests/g50ProdRead.test.js:25` | `g50ProdRead.js:44` |
| `scripts/lib/factory-launchd.js` | `scripts/local-embeddings.js` (bot embeddings server, launchd KeepAlive per its `.env.example` comment) | `local-embeddings.js:58` |

Each kept file gets a one-line header comment: *"Bot-side copy used by
`<dependent>`; the deploy/factory runners' canonical copy lives in
github.com/Ajohnson-1/factory."* No factory *machinery* (dispatchers, board CLI,
deploy runners, stage docs/tests) survives — the acceptance wording holds: no
factory machinery outside app-tree deploy artifacts; these three are private
deps of bot scripts, the same class as the grandfathered one-off `scripts/verify*`.

**D-7b — `plans/factory/*.md` history stays** (28 files + rollout-verification
doc). Not machinery (docs-only records of the discord-bot-board era) and
`scripts/g50ProdRead.js:410` still references
`plans/factory/6ad2263a5615709ac0b3fd71-plan.md`. Recorded in §5's deletion clause.

**D-7c — `.env.example` keeps the `DEPLOY_*` block.** §5: "keeps bot keys, drops
factory keys except the deploy classifier note". The note = deploy keys:
`scripts/g50ProdRead.js` (stays) reads `DEPLOY_HOST` via `deployConfig`, and
`deploy.js` refreshes the shipped classifier (`deploy-host-logs.sh`) from the
deployed sha, so the `DEPLOY_HOST/USER/KEY/DIR` lines stay, retitled to point at
the factory repo; every other factory section is dropped.

## Deletion list — discord-bot (62 files, all confirmed present today)

`git rm` exactly:

- **scripts (8):** `factory.js`, `factory-daemon.js`, `factory-sweep.js`,
  `factory-metrics.js`, `deploy.js`, `verify-deploy.js`, `prod-watch.js`,
  `provision-deploy-host.sh`
- **scripts/lib (16):** `trello.js`, `factory-ask.js`, `factory-audit-cards.js`,
  `factory-blocking-checks.js`, `factory-comment-resume.js`, `factory-context.js`,
  `factory-done-ping.js`, `factory-eval.js`, `factory-merge-guard.js`,
  `factory-metrics.js`, `factory-prod-close.js`, `factory-review-verify.js`,
  `factory-risk.js`, `factory-security-review.js`, `factory-stall-sweep.js`,
  `factory-sweep.js`
- **docs (15):** `docs/factory.md`, `docs/factory-audit.md`,
  `docs/factory-migration.md`, `docs/deploy-host.md`, `docs/security-review.md`,
  `docs/factory-prompts/` (README, implementer, planner, qa, reviewer,
  security-reviewer), `docs/review-guide/` (README, deploy-ssh,
  memory-embeddings, trello-discord-io)
- **tests (22):** `factoryAsk`, `factoryAuditCards`, `factoryBlockingChecks`,
  `factoryCommentResume`, `factoryContext`, `factoryDaemon`, `factoryDonePing`,
  `factoryEval`, `factoryMergeGuard`, `factoryMetrics`, `factoryProdClose`,
  `factoryReviewVerify`, `factoryRisk`, `factorySecurityReview`,
  `factoryStagePrompts`, `factoryStallSweep`, `factorySweep`, `prod-watch`,
  `deploy`, `verifyDeploy`, `deployHostLogs`, `provisionDeployHost` (all
  `tests/<name>.test.js`) — the 20 of §5's list plus the FM-1-deviation pair
  `factoryBlockingChecks`/`factoryEval`
- **eval (1):** `eval/cases.jsonl` (FM-1 deviation: moved to factory; removes the
  now-empty `eval/` dir)

**Stays (verified, do not touch):** `scripts/deploy-host-logs.sh` + `Dockerfile`
+ `docker-compose.yml` (app-tree deploy artifacts; `deploy.js` refreshes compose
+ classifier from the deployed sha's tree), `scripts/g50ProdRead.js` +
`tests/g50ProdRead.test.js`, the 3 kept libs (D-7a), all `service/`, one-off
`scripts/verify*`/`memory*`/bot scripts, `scripts/local-embeddings.js` + test,
`README.md` (its lines 64–65 already point at the factory repo), `plans/`
(incl. `plans/factory/`, D-7b), `CRASH_REPORT.md`/`TRUNCATION_REPORT.md`,
`pnpm-lock.yaml`/`package-lock.json`/`yarn.lock` (the dirty `yarn.lock` is
pre-existing — leave it, never `git add -A`).

## discord-bot file edits (3 files)

1. **`AGENTS.md`** — replace the whole `## Software factory` section (the
   pipeline paragraph + the "Canonical tooling moved (FM-1/FM-3)" paragraph)
   with this ≤5-line pointer:

   ```markdown
   ## Software factory

   Product cards flow on <https://trello.com/b/ZHkVYBN1/discord-bot>: plan →
   implement → review → QA on `factory/<card>` branches, `--ff-only` merge to
   `master`. All factory machinery — board contract (`docs/factory.md`), review
   guides, deploy runbook (`docs/deploy-host.md`) — is canonical in the factory
   repo: <https://github.com/Ajohnson-1/factory>; never edit factory tooling here.
   ```

   (5 body lines; the deleted `docs/factory.md`/`review-guide/`/`deploy-host.md`
   names become pointers into the factory repo, satisfying §5's "keeps a pointer
   line in AGENTS.md".)

2. **`package.json`** — trim the jest `--testPathIgnorePatterns` list from 24
   entries to the 3 surviving `node:test` suites (they must stay out of jest;
   20 of the entries name now-deleted files — yargs would swallow
   stale positionals into the array harmlessly, but the house rule is no ghost
   entries):

   ```
   NODE_OPTIONS='--experimental-vm-modules' jest --testPathIgnorePatterns '/node_modules/' 'tests/crashUnhandledRejection.test.js' 'tests/g50ProdRead.test.js' 'tests/localEmbeddings.test.js' && node --test tests/crashUnhandledRejection.test.js tests/g50ProdRead.test.js tests/localEmbeddings.test.js
   ```

   jest devDep stays (jest remains the bot-suite runner).

3. **`.env.example`** — delete the five factory sections: `# --- trello software
   factory …` (TRELLO_*/TRELLO_BOARD/FACTORY_MAX_PARALLEL), `# --- factory
   ask-human protocol …`, `# --- factory done-ping …`, `# --- factory comment
   listener …`, `# --- factory nightly review sweep …` (file tail). Retitle the
   deploy section to the classifier note (D-7c): keep
   `DEPLOY_HOST=`/`DEPLOY_USER=factory`/`DEPLOY_KEY=~/.ssh/factory_deploy_ed25519`/
   `DEPLOY_DIR=/opt/discord-bot` and replace the surrounding prose with: the
   docker-ssh deploy/verify runners (`deploy.js`, `verify-deploy.js`) now live in
   the factory repo and read these from *its* environment; kept here because
   `scripts/g50ProdRead.js` still resolves them and because the app-tree
   classifier (`deploy-host-logs.sh`) ships from the deployed sha. Drop the
   "Optional overrides" DEPLOY_REPO/DEPLOY_ACTOR comment lines.

## Factory-repo updates (this branch, normal Review/QA/merge/self-deploy)

`docs/factory-migration.md`:

- **§5 deletion clause** → annotate "delete-from-discord-bot at FM-7" as
  **executed** (cite the discord-bot master sha once it lands) and record the
  exceptions: 3 kept libs + dependents (D-7a), `plans/factory/` history (D-7b),
  `.env.example` DEPLOY_* note (D-7c).
- **new `### FM-7 deviations (recorded)` subsection** after the FM-4 notes —
  same precedent as the FM-1/FM-2/FM-3 deviation sections.
- **§6.2 step 6** — add: discord-bot factory copies deleted at <sha> (<date>);
  laptop plist removal + Mac reboot remain operator-owned after the soak.
- **§7 ownership block** — rewrite the three bullets to steady state: box
  `/opt/factory` = the dispatcher (systemd user unit), discord-bot factory copies
  are GONE (AGENTS.md pointer only), factory checkout = source of truth; update
  the freeze/start-pair sentence to the box `systemctl --user` form as primary.
- **§9 cutover log** — new dated bullet: FM-7 deletion executed, discord-bot
  master `<sha>`, `npm test` green, deploy runners verified post-deletion.

`AGENTS.md` (factory): fix the three stale "until FM-6"/"until the FM-6 cutover"
phrases (lines ~14, ~26, ~30) to steady-state wording (product cards permanently
on `ZHkVYBN1`; box daemon sole dispatcher since FM-6; discord-bot copies removed
at FM-7). No factory test pins this wording — verified: factory tests cite
`docs/factory-migration.md` only in comments.

## Commit strategy — both repos

1. **discord-bot** (implementer, from `/opt/repos/discord-bot`, branch `master`,
   clean except the pre-existing dirty `yarn.lock`): one commit with explicit
   paths — `git rm` the 62 files + edits to `AGENTS.md`, `package.json`,
   `.env.example` + the 3 kept-lib header comments. Message:
   `FM-7: delete factory machinery from discord-bot (8 scripts, 16 libs, 15 docs, 22 tests, eval cases) + AGENTS.md pointer, test-script trim, .env.example trim`.
   Then `git push origin master` (GitHub is the deploy source; precedent
   `5d405d8`/`726eb39` pushed directly to master). Do NOT touch `yarn.lock`;
   `git status` before commit must show only the intended paths.
2. **factory**: the discord-bot sha from step 1 is cited in the factory docs
   commit(s) on `factory/6aee5f4e035ae6601e71dfea`; normal pipeline flow
   (mergeable gate → review → QA → `--ff-only` merge → self-deploy). Nothing
   gets pushed on the factory branch before QA.

## Why the deploy survives (sub-step 5)

`scripts/deploy.js` (docker-ssh driver, factory repo) is fully host-side:
`build <ref>` resolves the sha **from real GitHub** (`git@github.com:Ajohnson-1/
discord-bot.git`, `DEPLOY_REPO` default), fetches into `$DIR/src/bot.git` on the
deploy host and `git archive | tar` → `docker build` host-local; `deploy <sha>`
extracts the tree to `$DIR/src/work` and refreshes `$DIR/docker-compose.yml` +
`$DIR/deploy-host-logs.sh` from the deployed sha's tree. It never reads the
`/opt/repos/discord-bot` working tree — only origin/master content. After the
deletion the sha tree still carries everything the build needs: `Dockerfile`
(`COPY` lines reference only `package.json`, `*.js`, `service/`, `config/*.md`,
`scripts/verify-native-modules-linux-x64.js` — none deleted), the kept
`docker-compose.yml` + `deploy-host-logs.sh`, and the full app. The registry's
discord-bot entry (repoDir `/opt/repos/discord-bot`, driver `docker-ssh`) is
untouched by the deletion.

## Verification plan

discord-bot, in `/opt/repos/discord-bot` (`node_modules` present ✓):

1. **Baseline before deletion:** `npm test` → capture pass/fail set. Expect the
   3 product suites (per-bot `config/*.config.json` overlays missing on this box)
   to fail identically pre/post — that's the FM-3-recorded machine-state backlog,
   not this card; pre-existing failures must not grow.
2. **After the commit:** `npm test` → identical-or-fewer failures; **zero**
   failures referencing deleted paths; `node --test` trio passes —
   `g50ProdRead` + `localEmbeddings` passing is the direct proof of the D-7a
   keep decision.
3. **Acceptance grep:** `grep -rniE 'factory|trello' package.json .env.example
   AGENTS.md` → only the pointer/DEPLOY-note wording; `find scripts tests docs
   eval -iname '*factory*'` → only the 3 kept libs (+ `plans/factory/`).
4. **Push + deploy survival:** after `git push origin master`, from
   `/opt/factory` run `node scripts/deploy.js build master` (host-local image
   build, touches nothing live — proves the post-deletion sha tree builds) and
   `node scripts/verify-deploy.js` (exit 0 on the currently running sha). No
   `deploy <sha>` cutover is forced just for testing; the next product card's
   deploy exercises the full path. `node scripts/factory.js status` green on
   both boards.

factory (this worktree / `/opt/factory`): `npm test` green (docs-only edits;
verified no test pins migration-doc prose). Card's "both suites green on the
box" = discord-bot step 2 + factory here.

## Risks / notes

- **Ghost laptop daemon** (§6.2 step-2 caveat): runs from the *laptop's*
  discord-bot checkout, which does not auto-pull — unaffected by the deletion
  until reboot; Mac reboot + plist removal + rollback drill stay operator-owned
  after the soak; recorded, not this card's code.
- Rollback (§6.3): `git revert` the single discord-bot master commit restores
  the whole tree; factory docs commit reverts alongside.
- Dispatch order: deletion commit lands on discord-bot master first, factory docs
  cite its sha — one implementer run does both repos in that order.
