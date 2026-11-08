# Factory migration design — multi-repo factory + laptop→Proxmox cutover

**Source:** plan §3–§6 of `plans/factory/6aeddeadc1b14ccbc5738145-plan.md` (card [Zxh650O7](https://trello.com/c/Zxh650O7/79-move-factory-to-its-own-repo), branch `factory/6aeddeadc1b14ccbc5738145`), copied verbatim as the extraction seed FM-1 carries into `github.com/Ajohnson-1/factory` as `docs/factory-migration.md` (plan §5/§7). The FM-1…FM-7 step cards live on the softwarefactory board (LLNG5MAm, To Do list, `Factory Migrations` label); their sub-step descriptions derive from the plan §7 table.

---

## 3. Design decisions (recorded)

| # | Decision | Why |
|---|---|---|
| D1 | Factory repo = **full extraction** of factory+deploy tooling from discord-bot (not a rewrite). | Every subsystem is heavily pinned by tests + docs-to-tests sync tests; a rewrite loses the audit trail, the board contract, and ~20 test suites. "Start from scratch" is permitted, not required. |
| D2 | **Repo registry** (`config/factory-repos.json`) is the single source for repo↔board↔worktree↔deploy mapping. | Matches the factory philosophy (config file = state, board = truth); no new services. Machine-local override via `FACTORY_REPOS_FILE` env (same pattern as `.env`). |
| D3 | Card→repo routing: **board default** (registry board→repo), overridable by a card **label** `repo:<name>`; unknown/ambiguous repo label → `[ASK]`, never guess. | Labels are already fetched in every card payload (`getBoardCards` fields include labels); zero new board plumbing. Fail-closed on ambiguity is the house pattern. |
| D4 | Both boards stay live: product cards keep flowing on discord-bot board (`ZHkVYBN1`); **factory** work (all `FM-*`, sweep, prod-watch incidents, metrics report) on softwarefactory (`LLNG5MAm`). | Card says move *factory related* cards; product backlog belongs on the product board. |
| D5 | `deploy.js` / `verify-deploy.js` / `prod-watch.js` / deploy libs **move to the factory repo**; `deploy-host-logs.sh` + `docker-compose.yml` + `Dockerfile` stay in discord-bot. | The deploy runners are factory stages (host-side build needs no local checkout); the classifier/compose are app-tree artifacts shipped from the deployed sha. |
| D6 | Per-repo **deploy driver** in the registry: `docker-ssh` (discord-bot: existing build/deploy/rollback/verify) and `self` (factory: pull the runtime clone + restart daemon via a detached platform mechanism + health-verify). | Keeps the `[DEPLOY]`/`[VERIFY:*]`/`[ROLLBACK]` comment contract identical across repos. |
| D7 | **systemd user units** on the box (`loginctl enable-linger factory`, operator root step); `install`/`status`/`uninstall` keep working on macOS via launchd (platform branch on `process.platform`). | Factory user has no sudo; user units + linger give the same RunAtLoad/KeepAlive semantics; timers replace `StartInterval`/`StartCalendarInterval`. |
| D8 | Cutover invariant: **exactly one dispatcher**. Rollback anchor = laptop launchd plists kept until soak ends; rollback = boot laptop agent, stop box unit. The board is the only shared state; local `data/` watermarks diverging is benign (done-ping re-baselines silently; resume watermarks are event-id keyed). | The daemon's pid-lock is per-machine; two live daemons on two machines would double-dispatch. |
| D9 | In-flight cards (C-M9 Implement, C-M11 QA) **finish on the discord-bot board**; only backlog/inert factory cards get moved. | Moving a mid-pipeline board risks nothing on the board, but re-running a daemon restart mid-card buys nothing; board-is-state already tolerates cards living where they were dispatched. |
| D10 | This card's implementation = the design doc + the 7 step cards. All code lands in the step cards. | Card description: "before you implement I want to see a full plan… break this down to several steps, make a card for each." |

## 4. Multi-repo management design

### 4.1 Repo registry — `config/factory-repos.json` (in the factory repo)

```json
{
  "defaultRepo": "factory",
  "repos": {
    "factory": {
      "repoDir": "~/GitHub/factory",
      "worktreeRoot": "~/GitHub/factory-factory-wt",
      "baseBranch": "master",
      "board": "LLNG5MAm",
      "deploy": { "driver": "self" },
      "worktreeBootstrap": []
    },
    "discord-bot": {
      "repoDir": "~/GitHub/discord-bot",
      "worktreeRoot": "~/GitHub/discord-bot-factory-wt",
      "baseBranch": "master",
      "board": "ZHkVYBN1",
      "deploy": { "driver": "docker-ssh" },
      "worktreeBootstrap": [
        "ln -s ../../discord-bot/node_modules node_modules",
        "cp .env version.json <wt>/",
        "mkdir -p <wt>/config <wt>/data && cp config/config.json <wt>/config/",
        "cp <factoryRoot>/.env <wt>/.env"
      ]
    }
  }
}
```

- `~` expansion via the existing `expandTilde` precedent (`lib/deploy-config.js`).
- Machine-local override: `FACTORY_REPOS_FILE` env names a different JSON (on the box:
  `/opt/factory/config/factory-repos.local.json` — repoDir `/opt/factory` &
  `/opt/repos/discord-bot`, worktree roots `/opt/factory-worktrees`,
  `/opt/repos/discord-bot-worktrees`). Committed file = laptop defaults.
- New `scripts/lib/factory-registry.js`: load + validate (throw with the offending key),
  `repoForCard({ labels, board })` (D3 precedence), `boardIds()`, DI'd like every other lib,
  pinned by `tests/factoryRegistry.test.js`.

### 4.2 Board routing (`lib/trello.js`)

Every exported call gains an optional trailing `{ board = BOARD }` option; `BOARD` default
keeps today's precedence (env → `.env` → `ZHkVYBN1`) so all existing single-board usage is
byte-identical. `factory.js` subcommands accept `--board <id>` (and `--repo <name>`, resolved
through the registry). `init` runs per board and also ensures a **To Do** list (today
`STAGES` omits it, while `reorder` and `seed-audit` expect it — one-line fix + test).

### 4.3 Daemon (`factory-daemon.js`)

- One process polls **every registered board** each tick: per-board Ready→Plan dispatch,
  per-board `findList`, per-board comment-resume/stall-sweep/done-ping passes (state files
  are card-id keyed → unchanged).
- `planDispatch` extends from `string[]` to `{board, cardId}` entries (cap stays global —
  `FACTORY_MAX_PARALLEL` bounds total in-flight runs across boards).
- Dispatch resolves the repo via `registry.repoForCard`; a card with an unknown/ambiguous
  `repo:` label → `[ASK]` + leave in Ready (zero spawn), never a guessed checkout.
- `buildRunPrompt`/`buildResumePrompt` gain a **REPO CONTEXT block**: repo name, repoDir,
  baseBranch, worktree path + exact bootstrap recipe, deploy driver + the exact
  deploy/verify command lines, and "all factory CLI invocations run from the factory repo".
  Pinned by `factoryStagePrompts.test.js` alongside the stage-prompt seeds.
- Crash recovery / resume / sweep iterate per board (the lists they name are per-board).

### 4.4 CLI git ops

`factory.js` git commands (`mergeable`, `merge-guard`, `security-check`, `risk`, `approve`)
resolve the target repo: `--repo` flag → else cwd `git rev-parse --show-toplevel` matches a
registry `repoDir`/`worktreeRoot` prefix → else registry `defaultRepo`. Runs with
`cwd: <resolved repo>` instead of `ROOT`. (Today's single-repo behavior is the `--repo`-less,
inside-worktree default — identical.)

### 4.5 Deploy drivers

- `docker-ssh` (discord-bot): unchanged commands
  (`deploy.js build master` / `deploy.js deploy <sha>` / `rollback`, `verify-deploy.js`) —
  now living in the factory repo, all host-side, unchanged env.
- `self` (factory repo): new `scripts/deploy-factory.js` —
  build = no-op (push to master IS the artifact); deploy = in the runtime clone
  `git pull --ff-only origin master` + restart the daemon via a **detached** mechanism so the
  daemon restarting itself can't kill its own scheduler run: Linux
  `systemd-run --on-active=2s systemctl --user restart factory-daemon`, macOS keeps the
  existing detached-launchd-guard precedent (`lib/factory-launchd.js`); rollback = checkout
  previous sha + restart. `scripts/verify-factory.js`: unit is active + daemon log shows a
  successful board poll after restart → exit 0. Same `[DEPLOY] sha=…` / `[VERIFY:*]` /
  `[ROLLBACK]` comment shapes.
- Risk-tier always-human patterns move with `factory-risk.js`; add factory-repo paths
  (`scripts/deploy-factory.js`, `config/factory-repos*.json`) to the always-human list.

### 4.6 Runtime services on the box

`install`/`status`/`uninstall` gain a Linux branch writing systemd **user** units + timers:
`factory-daemon.service` (`Restart=always`, `RestartSec=30`, `WorkingDirectory=/opt/factory`,
`Environment=PATH=…~/.local/node/bin…`), `factory-metrics.service` + 6 h timer,
`factory-sweep.service` + daily 03:15 timer, `prod-watch.service` + 300 s timer. Operator
root pre-req (once, console): `loginctl enable-linger factory`. `prod-watch` from the box
probes `DEPLOY_HOST` (itself) over ssh using the copied private key; opens `[PROD-WATCH]`
cards on the softwarefactory board.

## 5. Extraction inventory (file-by-file)

**→ factory repo (new `github.com/Ajohnson-1/factory`, master, from scratch = fresh init + copy):**

- scripts: `factory.js`, `factory-daemon.js`, `factory-sweep.js`, `factory-metrics.js`,
  `deploy.js`, `verify-deploy.js`, `prod-watch.js`, `provision-deploy-host.sh`
- scripts/lib: `trello.js`, `factory-ask.js`, `factory-audit-cards.js`,
  `factory-comment-resume.js`, `factory-context.js`, `factory-done-ping.js`,
  `factory-launchd.js`, `factory-merge-guard.js`, `factory-metrics.js`,
  `factory-prod-close.js`, `factory-review-verify.js`, `factory-risk.js`,
  `factory-security-review.js`, `factory-stall-sweep.js`, `factory-sweep.js`,
  `deploy-config.js`, `deploy-ssh.js` (+ new `factory-registry.js`)
- docs: `factory.md`, `factory-audit.md`, `factory-prompts/` (all 5), `review-guide/`,
  `security-review.md`, `deploy-host.md`, + new `factory-migration.md` (this plan's §3–§7,
  copied by FM-1), + new `AGENTS.md` (factory duties, board contract pointer)
- tests (all move): `factoryAsk`, `factoryAuditCards`, `factoryCommentResume`,
  `factoryContext`, `factoryDaemon`, `factoryDonePing`, `factoryMergeGuard`,
  `factoryMetrics`, `factoryProdClose`, `factoryReviewVerify`, `factoryRisk`,
  `factorySecurityReview`, `factoryStagePrompts`, `factoryStallSweep`, `factorySweep`,
  `prod-watch`, `deploy`, `verifyDeploy`, `deployHostLogs`, `provisionDeployHost`
  (+ new `factoryRegistry`)
- root: `package.json` (test script = jest over factory tests only; devDep jest),
  `.env.example` (TRELLO_*/BOT_TOKEN/FACTORY_*/DEPLOY_* set), `.gitignore` (data/, node_modules)

**stay in discord-bot:** every bot file; app-tree deploy artifacts
`scripts/deploy-host-logs.sh`, `Dockerfile`, `docker-compose.yml`; `scripts/g50ProdRead.js`
(+ test — bot rollout collector); one-off `scripts/verify*`/bot scripts. After FM-7:
`AGENTS.md` factory section → 5-line pointer to the factory repo; `package.json` jest list
drops factory tests; `.env.example` keeps bot keys, drops factory keys except the deploy
classifier note. `docs/deploy-host.md` moves to factory (runbook = factory-owned); discord-bot
keeps a pointer line in AGENTS.md.

**delete-from-discord-bot at FM-7:** everything in the first block (additive until then —
discords-bot factory copies stay authoritative until the cutover soak passes; single
dispatcher rule means only one repo's daemon runs at a time).

## 6. Laptop → Proxmox migration plan

### 6.1 Box prerequisites (one-time; mostly operator root/console)

1. **Trello:** add the token member `ompbot` as a member of the softwarefactory board
   (today 401 — verified this session).
2. **Console paste** (extends the existing `provision-deploy-host.sh` idempotent-paste
   pattern; new `provision-factory-host.sh` + factory-user steps run by SSH):
   root: `loginctl enable-linger factory`;
   factory user: node LTS tarball → `~/.local/node`; `npm i -g omp` (user prefix);
   full working clone of discord-bot → `/opt/repos/discord-bot` (separate from the
   `/opt/discord-bot` app dir — bind-mount state lives there); clone factory → `/opt/factory`.
3. **GitHub push access:** grant write to the existing `factory_github_deploy_ed25519`
   deploy key on **both** repos (it is currently read-only on the box); set
   `git config user.name factory` (deploy-history actor) in both clones.
4. **Secrets on the box:** `/home/factory/.env` — `TRELLO_KEY/TOKEN`, `BOT_TOKEN`,
   `DEPLOY_HOST/DEPLOY_KEY/…` and copy the private half of `factory_deploy_ed25519` to
   `/home/factory/.ssh/` (ssh-to-self works: public half already in `authorized_keys`);
   `factory-repos.local.json` with box paths (D2).

### 6.2 Cutover runbook (FM-6)

1. Preflight on the box: `node scripts/factory.js status` green on **both** boards;
   laptop daemon healthy, zero in-flight cards (drain first; C-M9/C-M11 finish pre-cutover).
2. **Freeze laptop dispatcher:** `launchctl bootout` factory-daemon (plist kept = rollback
   anchor). Same for prodwatch (both pollers would open duplicate incident cards).
3. **Start box dispatcher:** `systemctl --user start factory-daemon` → sole dispatcher
   (pid-lock proves it; board polls both boards).
4. **Canary:** file a trivial docs-only card on softwarefactory (default repo = factory) →
   full pipeline to Done including `self` deploy + daemon restart via `systemd-run`.
5. One discord-bot product card end-to-end from the box (docker-ssh deploy + verify).
6. Soak ≥7 days: ≥3 Done cards, zero `[PROD-WATCH]` incidents → then FM-7 cleanup +
   uninstall the laptop agents (`factory-daemon`, `prodwatch`, metrics/sweep if present),
   archive `data/factory-daemon` logs.

### 6.3 Rollback story

- **Repo extraction:** the extraction commit is additive-only in discord-bot until FM-7;
  rollback = keep using the discord-bot daemon (nothing removed). FM-7's removal rides the
  factory pipeline itself (dogfood), reverting one commit restores everything.
- **Cutover:** stop box unit → `launchctl bootstrap` the laptop plists. Divergence handling:
  done-ping state re-baselines silently on the laptop's stale file; comment-resume watermarks
  are event-id keyed (at worst one re-ack of a human comment posted during the divergence
  window — acceptable, logged); the board is the single truth.
- **Per-card:** unchanged — risk gate before merge, `--ff-only` + merge-guard,
  `[VERIFY:FAIL]` → `deploy.js rollback` → `[ROLLBACK]` → bounce.


## 7. Runtime rule — exactly ONE dispatcher (FM-1)

The daemon (`factory-daemon.js`, launchd label `com.ajohnson.factory-daemon`)
and its satellites (metrics, sweep, prod-watch) MUST run from **exactly one
repo checkout at a time**. The pid-lock is per-machine, not cross-repo: two
live daemons — even from different checkouts on one machine — double-dispatch
every Ready card (two spawns, racing list moves). D8 makes this the migration's
only systemic hazard; every runbook step names the freeze/start pair.

Current ownership during the migration (FM-1 → FM-6):

- **Laptop, discord-bot checkout** (`~/GitHub/discord-bot`) — authoritative
  dispatcher until the FM-6 cutover soak passes. Until FM-7 the factory copies
  in discord-bot stay in place; the daemon still runs from discord-bot.
- **Laptop, factory checkout** (this repo) — inert until FM-6. `status`,
  `init`, deploy runners, and the full test suite run here; do NOT
  `install`/`launchctl bootstrap` the daemon from here while the discord-bot
  daemon is loaded (`launchctl list | grep com.ajohnson.factory-daemon` must
  show exactly one owner).
- **Box** (`/opt/factory`, systemd user units) — becomes the sole dispatcher at
  FM-6 §6.2 step 3; laptop agents get uninstalled at FM-7.

Freeze/start pair (any machine transition): `launchctl bootout gui/$(id -u)/com.ajohnson.factory-daemon`
(plist kept = rollback anchor) → `launchctl bootstrap gui/$(id -u) <plist>` in
the other repo, or `systemctl --user stop/start factory-daemon` on the box.

### FM-1 deviations from the §5 inventory (recorded)

- `factory-blocking-checks.js`, `factory-eval.js` + their tests +
  `eval/cases.jsonl`: authored on discord-bot master after §5 was drafted
  (C-M9/C-M11 cards); moved here for full single-board parity.
- `scripts/deploy-host-logs.sh`: the deployed artifact still ships from
  discord-bot's sha tree (D5 unchanged); the factory repo carries a mirror
  copy ONLY so `tests/deployHostLogs.test.js` (§5 "all move") has its subject.
- Registry boards: both entries carry `ZHkVYBN1` in FM-1 (single-board
  parity). Flipping the factory entry to `LLNG5MAm` is FM-3's job, once
  `ompbot` membership traffic starts (401 since resolved).
- `.env.example`: discord-bot's factory blocks copied verbatim;
  worktree bootstrap prefers the discord-bot root `.env` (BOT_TOKEN for
  ask/done-ping) and falls back to this repo's `.env`.

### FM-2 notes (recorded)

- **Per-board Done-ping dedup:** the state file records ONE `doneListId`, so
  two boards alternating the legacy file rotate each other every tick (each
  poller re-baselines and silently misses arrivals — caught in the live
  two-board smoke). Non-default boards now get
  `data/factory-done-ping.<board>.json`; the default board keeps the legacy
  filename byte-for-byte (the inline `move` pinger shares it).
- **`init --board LLNG5MAm` ran early during FM-2 verification** (creating
  To Do/Plan/Implement/QA/Deploy/Verify + the `needs-human` label on the
  softwarefactory board, so the two-board poll smoke had legal lists). The 9
  backlog cards still sit in the older `Todo` list — FM-3's remaining work is
  the card moves + the doc/pointer updates; the registry keeps both entries on
  `ZHkVYBN1` per FM-1 (the flip stays FM-3's step).
- **`FACTORY_MAX_PARALLEL=0` is poll-only mode** (dispatch never starts) —
  used for the read-only two-board daemon smoke so §7's single-dispatcher
  rule held while the discord-bot daemon stayed live.
