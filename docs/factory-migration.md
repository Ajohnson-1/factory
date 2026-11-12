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

**delete-from-discord-bot at FM-7 — EXECUTED 2026-11-11, discord-bot master
`0885b59`:** the first block above deleted wholesale (8 scripts, 16 libs,
15 docs, 22 tests + `eval/cases.jsonl` = 62 files, single commit), with the
recorded exceptions of the "FM-7 deviations" section below: the three libs
`deploy-config.js`/`deploy-ssh.js`/`factory-launchd.js` STAY (private deps of
surviving bot scripts `g50ProdRead.js`/`local-embeddings.js`), `plans/factory/`
history stays (docs-only records; `g50ProdRead.js` cites one), and
`.env.example` keeps the `DEPLOY_*` block as the deploy-classifier note.
`AGENTS.md` now carries the 5-line pointer; `package.json` ignores only the
3 surviving `node:test` suites; the old rule (additive until the soak —
discords-bot copies authoritative) is history.

## 6. Laptop → Proxmox migration plan

### 6.1 Box prerequisites (one-time; mostly operator root/console)

1. **Trello:** add the token member `ompbot` as a member of the softwarefactory board
   (today 401 — verified this session).
2. **Console paste** — `scripts/provision-factory-host.sh` (+ shared helpers
   `scripts/factory-host-lib.sh`; extends the existing `provision-deploy-host.sh`
   idempotent-paste pattern; `PROVISION_MODE=test DESTDIR=<scratch>` runs the same
   flow rootless/offline for the self-check):
   root: `loginctl enable-linger factory` + pre-create the factory-owned
   runtime tree under root-owned `/opt` (`/opt/factory`, `/opt/repos`,
   worktrees dirs; chown `factory:docker` — the factory user cannot mkdir
   under `/opt`; the script does both idempotently);
   factory user: node LTS tarball → `~/.local/node`; omp = pinned
   sha256-verified release binary (`can1357/oh-my-pi` `omp-linux-x64` →
   `~/.local/node/bin/omp`) — **not** `npm i -g omp` (the npm name is
   squatted: `omp@1.0.0` installs no bin);
   full working clone of discord-bot → `/opt/repos/discord-bot` (separate from the
   `/opt/discord-bot` app dir — bind-mount state lives there); clone factory → `/opt/factory`.
3. **GitHub push access:** GitHub refuses to share one deploy key across
   repos ("key is already in use"), so the factory repo uses a **dedicated**
   key `factory_github_deploy_factory_ed25519` (write) wired on the box via
   a `github.com-factory` ssh host alias + global git `insteadOf` rewrite of
   the factory clone URL; the existing `factory_github_deploy_ed25519` keeps
   discord-bot with write (verified this session: both repos fetch); set
   `git config user.name factory` (deploy-history actor) in both clones.
4. **Secrets on the box:** `/home/factory/.env` — `TRELLO_KEY/TOKEN`, `BOT_TOKEN`,
   `DEPLOY_HOST/DEPLOY_KEY/…` and copy the private half of `factory_deploy_ed25519` to
   `/home/factory/.ssh/` (ssh-to-self works: public half already in `authorized_keys`);
   `factory-repos.local.json` with box paths (D2). `provision-factory-host.sh` writes
   the `.env` (0600, fixed key order = byte-stable re-runs) and installs the key from
   `FACTORY_SSH_PRIVKEY_FILE` (skip-if-identical).

The systemd units themselves (`factory-daemon.service`; `factory-metrics` /
`factory-sweep` / `prod-watch` service+timer pairs; 0600 `data/factory-env.conf` from
the repo `.env`) are written on Linux by `install` via
`scripts/lib/factory-platform-systemd.js` (dispatch `scripts/lib/factory-platform.js`;
launchd stays the default on macOS). From-box prod-watch transport preflight:
`node scripts/probe-factory-box.js` (exit 0 = ssh-to-self + classifier work; zero
board writes). FM-5 verified on the macOS gate host with unit-render +
scratch-DESTDIR assertions (no Linux box in this environment); the live enable/active
checks and one manual run per timer land at cutover (§6.2, FM-6).

### 6.2 Cutover runbook (FM-6) — EXECUTED 2026-11-09; status live-checked 2026-11-10

Execution model (from the [OPS] cutover): machine transitions are
operator-driven — box-side `systemctl --user` works over ssh with
`XDG_RUNTIME_DIR=/run/user/$(id -u)` + `DBUS_SESSION_BUS_ADDRESS` exported;
laptop `launchctl` needs a console GUI session (FM-4: non-GUI shells get
113/5). A daemon-dispatched run NEVER issues a freeze/start pair — the run is
a child of the daemon it would stop.

- [x] **Step 1 — Preflight/drain** (2026-11-09T16:47Z, [OPS]): every in-flight
  list empty on `ZHkVYBN1` + `LLNG5MAm` (board-API verified); box `status`
  green on both boards.
- [x] **Step 2 — Laptop dispatcher frozen** (2026-11-09T16:34Z, [OPS]):
  `com.ajjohnson.factory-daemon` registration reclaimed with its transient
  session (plist kept = rollback anchor); `com.discordbot.prodwatch` booted
  out (plist kept). Caveat: one **ghost laptop daemon** (stale discord-bot job
  in an unreachable launchd domain) needs a **Mac reboot** to clear; until then
  it would double-dispatch `ZHkVYBN1`, so step 5 stays gated on the reboot.
- [x] **Step 3 — Box dispatcher started** (2026-11-09T16:51:27Z, [OPS]):
  `systemctl --user enable --now factory-daemon.service` over ssh → sole
  dispatcher; journal shows boot + `poll ok` for `LLNG5MAm` and `ZHkVYBN1`.
  Fix during start: `/opt/factory/.env` gained the missing
  `FACTORY_SERVER_ID`/`FACTORY_CHANNEL_ID` and was CR-stripped (dotenv
  tolerated CR bytes, raw sourcing 401-ed).
- [x] **Step 4 — Canary Done on the box** (card `6af1fa46fecb634350948a5d`,
  Done 2026-11-10): docs-only card ran the full pipeline on the box incl. the
  first live Linux detached self-restart (`deploy-factory.js` →
  `systemd-run … in 2s`, deploy-history entry `a09efef` 2026-11-10T13:32Z) →
  `[VERIFY:PASS]` → Done.
- [ ] **Step 5 — one discord-bot product card end-to-end from the box**
  (docker-ssh deploy + verify): ⏳ **operator-owned** — create/dispatch only
  after the Mac reboot clears the ghost daemon (step 2 caveat).
- [ ] **Step 6 — Soak ≥7 days + uninstall:** ⏳ soak clock started
  2026-11-09T16:51Z → ends **2026-11-16 ~17:00Z**. Evidence as of commit:
  13 boots ↔ 13 `poll ok` per board (1:1, all deploy-armed restarts), zero
  `[PROD-WATCH]` incident cards on `LLNG5MAm`, 2 Done cards completed on the
  box since cutover (≥3 target counts naturally; the FM-6 card itself is
  projected third). After the soak passes → FM-7 cleanup + remove the laptop
  rollback anchors (jobs are already booted out):
  `rm ~/Library/LaunchAgents/com.ajohnson.factory-daemon.plist`
  `~/Library/LaunchAgents/com.discordbot.prodwatch.plist`
  (+ `com.discordbot.factory-metrics` / `com.ajohnson.factory-sweep` plists if
  present), archive `data/factory-daemon` logs.
  FM-7's discord-bot deletion executed 2026-11-11 at master `0885b59` (factory
  copies gone; see §5 + the FM-7 deviations section). **Laptop rollback anchors
  uninstalled 2026-11-12** (see the §9 review bullet): both plists deleted, jobs
  booted out, stragglers killed; `com.discordbot.factory-metrics` /
  `com.ajohnson.factory-sweep` plists were not present. Archiving the laptop
  `data/factory-daemon` logs stays operator-owned.

#### Rollback drill — box → laptop → box ❎ WAIVED 2026-11-12 (operator: forward-only)

Operator decision 2026-11-12: **no rollback** — the box is the permanent
dispatcher and the factory moves forward. The drill and the "rollback
rehearsed once" acceptance clause are waived; the laptop anchors were deleted
rather than kept (§9). The steps below stay as the documented fallback recipe
for the day the box must actually be abandoned. Precondition when used: both
boards drained (zero in-flight). Run interactively — never from a dispatched
run (§7 invariant).

1. Forward (box → laptop): box `systemctl --user disable --now
   factory-daemon` and stop the satellite service+timer pairs
   (`factory-metrics`, `factory-sweep`, `prod-watch`); laptop console — the
   2026-11-12 uninstall deleted the anchor plists, so regenerate instead of
   bootstrap: `cd ~/GitHub/factory && node scripts/factory-daemon.js install`
   (writes the plist + bootstraps; a prodwatch plist pointing at the
   factory-repo `scripts/prod-watch.js` if you want that leg too); verify
   laptop `node scripts/factory.js status` green on both boards.
2. Back (laptop → box): laptop `node scripts/factory-daemon.js uninstall`
   (boots out + deletes the regenerated plists — restores the uninstalled
   state); box `systemctl --user enable --now factory-daemon`; verify boot +
   `poll ok` for both boards in `journalctl --user -u factory-daemon.service`.
3. Divergence handling: D8/§6.3 — done-ping re-baselines silently, resume
   watermarks are event-id keyed (worst case one human-comment re-ack); the
   board is the only shared state.
4. Record the drill (timestamps + poll-ok evidence) as a `## 9` cutover-log
   bullet; that bullet is the evidence flipping the card sub-step "rollback
   rehearsed once".

#### FM-6 acceptance tracking (as of this runbook commit)

| Acceptance | Status | Owner |
|---|---|---|
| ≥7 days always-on on the box | ⏳ soak window ends 2026-11-16 ~17:00Z; boots↔poll-ok 1:1 so far | time |
| ≥3 Done cards on the box | ⏳ 2 since cutover; FM-6 merge is projected 3rd | pipeline (flows naturally) |
| laptop agents uninstalled | ✅ 2026-11-12 — plists deleted + jobs booted out; the reboot alone resurrects the ghost while the plist exists, deletion is the real fix (§9) | operator (FM-7) |
| rollback rehearsed once (box→laptop→box) | ❎ waived 2026-11-12 — operator decision: forward-only, box is the permanent dispatcher (§9); recipe retained in §6.2 | operator (console) |
| runbook merged | ✅ this commit, merged + self-deployed by the factory pipeline itself | done |

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

Steady-state ownership (post-FM-6/FM-7):

- **Box** (`/opt/factory`, systemd user units) — THE dispatcher since the FM-6
  cutover (2026-11-09): `factory-daemon.service` + the satellite
  service/timer pairs. The only daemon that runs.
- **discord-bot checkout** (`/opt/repos/discord-bot`) — factory copies are GONE
  (deleted at FM-7, master `0885b59`; `AGENTS.md` carries the pointer only). No
  daemon, no board CLI, no deploy runners live here anymore.
- **This factory checkout** (laptop clone / `/opt/factory` = the deployed copy)
  — source of truth for all factory tooling; `status`, `init`, deploy runners,
  and the full test suite run here. Never `install`/bootstrap a daemon from a
  clone while the box unit is active.

Freeze/start pair (any machine transition): box-primary —
`systemctl --user stop/start factory-daemon` (needs
`XDG_RUNTIME_DIR=/run/user/$(id -u)` + `DBUS_SESSION_BUS_ADDRESS` over ssh,
§6.2); the laptop has no resident daemon and no anchor (uninstalled
2026-11-12, forward-only decision — §9). A laptop takeover, if ever needed,
follows the §6.2 drill recipe: `node scripts/factory-daemon.js install`
regenerates plist + job, `uninstall` removes them again.

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

### FM-3 notes (recorded)

- **Registry flip landed:** the `factory` entry now carries `LLNG5MAm`;
  `discord-bot` stays on `ZHkVYBN1` until FM-6. `boardIds()` returns two
  boards for the daemon; the committed-config test pins assert the split and
  a `sharedBoard()` fixture keeps the parity shape (dedup + ambiguous-board)
  under test.
- **Board state at flip:** `LLNG5MAm` already had all stage lists + `To Do`
  (FM-2's early `init`), the legacy `Todo` list was archived, and the
  backlog cards sat inert in `To Do`. `metrics --repo factory` recreated the
  `Factory metrics report` card in the board's `Done` list (idShort 14) —
  find-or-create works against a fresh board. Sweep/prod-watch cards land
  natively: both take the scoped board and default to `TRELLO_BOARD` while
  the discord-bot daemon still runs them (FM-6 moves them).
- **Acceptance canary (end-to-end on `LLNG5MAm`, discord-bot board live):**
  docs-only card `6af08deef81c512d67d5cd3a`, label `repo:discord-bot`,
  dispatched by the factory repo's daemon (`FACTORY_STALL_SILENCE_MS` frozen
  so stall recovery stayed owned by the live discord-bot daemon for its
  in-flight card): `[PLAN]`→`[IMPL]`→`[REVIEW:APPROVE]`→`[SEC:PASS]`→
  `[QA:PASS]`→merge `--ff-only`→`[DEPLOY] sha=5d405d8`→`[VERIFY:PASS]`→Done,
  worktree + branch cut and cleaned in the registry's
  `discord-bot-factory-wt` root. Deviation: two daemon processes on one
  machine during the window (§7's one-checkout rule) — boards were disjoint
  by construction: the discord-bot daemon (pre-FM-2 copy) only knows
  `ZHkVYBN1`; the canary polled both but `ZHkVYBN1`'s Ready stayed empty,
  so zero cross-dispatch. FM-6 folds ownership back into one daemon.
- **`[CHECK:FAIL]` bounce was real, not plumbing:** the blocking gate ran
  `npm test` in the routed worktree and 3 suites (7 tests) failed —
  reproducing byte-identically in the main discord-bot checkout (product
  `multiBotConfig`-style tests need the gitignored `config/*.config.json`
  per-bot overlays; they've been cleaned off the machine). The pipeline
  bounced once, the run rebased/re-pushed, Deploy+Verify passed. A product
  test fix is discord-bot backlog work, not factory plumbing.
- **Self-dispatch footgun:** starting the factory daemon while FM-3 itself
  sat in `Ready` made it dispatch its own step card (the agent began the
  pipeline before the operator killed it; the card's `[DAEMON-CRASH]`
  comment is that SIGTERM's trail). Meta-cards being worked interactively
  MUST sit in `To Do`, not `Ready`.

### FM-4 notes (recorded)

**Acceptance trail (2026-11-09, canary card `6af145e01af67cdb31706fe2` /
gqxigT8y, docs-only):** the full designed path ran live — dispatch (board
default repo:factory) -> Plan/Implement/Review/Sec/QA -> CHECK:PASS -> merged
tip 64b69b3 -> an operator docs-only push moved the deploy target to c1d145d ->
`[DEPLOY] sha=c1d145d` (history entry 04:40:11Z, `launchd-guard pid 7878`) ->
detached restart converged in ~6 s -> the run took SIGTERM (code 143) -> the
ZERO-SILENCE boot sweep recovered it (`STALL-RECOVER at Deploy (silent 1 min)`,
crash 2/3) -> stage-aware resume -> idempotent redeploy (`restart skipped`, no
second restart) -> `[VERIFY:PASS]` verdict JSON (unit active + boot/poll
markers after restartAt) at 04:45:19Z -> **Done**. Crash cap never reached.
Canary #1 (`6af13b7d426ab6db2fc4b270`) had already proven deploy+restart
convergence and exposed both f7d00a2 fixes; superseded with an operator note,
held in To Do. After acceptance the launchd job was booted out of the factory
GUI registration and re-installed from the discord-bot checkout (§7 steady
state; the missing plist was rewritten fresh in the window).

- **`self` driver landed as two scripts** (docs/factory-migration.md §4.5
  implemented verbatim): `scripts/deploy-factory.js` (deploy = ff-pull the
  runtime clone + arm a DETACHED daemon restart; rollback = checkout the
  previous sha from append-only JSONL history + restart; dirty clone fails
  closed exit 2; restart-armed ≠ restart-done is deliberate — the deploy is
  the child of the daemon it restarts, and crash recovery makes the kill
  safe: ff-pull is a no-op, guard re-arm harmless) and
  `scripts/verify-factory.js` (unit active + boot marker + the FIRST
  SUCCESSFUL POLL marker stamped after the restart; stdout is only the
  verdict JSON, mirroring `verify-deploy.js`). Platform branch on
  `process.platform`: darwin detached launchd guard; linux
  `systemd-run --user --on-active=2s` (the FM-5 unit).
- **New daemon health marker:** `[poll] board <id> poll ok — first
  successful poll since boot` logged once per boot per board; unit-active
  alone never proves the daemon reaches Trello. `LABEL`/`PLIST_PATH` are now
  exported; the verifier reads the LOG PATH out of the INSTALLED plist
  (works whichever checkout owns the job) and scans timestamps ANYWHERE in
  the line (the daemon format is `[factory-daemon <ISO>] …`).
- **Registry:** `deploy.runtimeClone` validated + tilde-expanded (default
  `repoDir`); `FACTORY_DEPLOY_CLONE` overrides for smokes. `deployCommands`
  self lines are now the final command strings rendered into REPO CONTEXT.
- **Risk:** `scripts/deploy-factory.js`, `scripts/verify-factory.js` and
  `factory-repos*.json` added to ALWAYS_HUMAN (a deploy-tooling or
  routing-config change is high tier even at 1 line).
- **Discord notifications from the factory repo** (closes the FM-3 gap):
  `sendOwnerPing` gained a `FACTORY_CHANNEL_ID` branch — resolution order
  webhook → channel → DM owner id. The factory bot (ZeroClawChat) posts to
  the factory server's channel; live smoke returned HTTP 403 on SEND
  (channel GET 200 — view channel yes, Send Messages not yet granted) —
  one operator permission flip remains.
- **Resume-trigger semantics (canary #2):** the comment-resume watcher answers
  only HUMAN-member events — `untagged = human`, and a comment whose author is
  the bot token-holder self-filters (`isBot`) even when untagged, so scheduler
  tokens can never arm a resume (the scheduler never answers itself — by
  design). A mid-deploy daemon restart therefore strands the card until a real
  member comments or drags; FM-4 acceptance used an operator-dispatched resume
  (identical agentArgs + `[RESUME]` ack) to close the window. A deploy-stage
  agent also leaked an untagged comment fragment (`- --repo factory`) that
  parked the boot sweep on "human comment owns the reply" — untagged garbage
  from a run is indistinguishable from a human reply; contract wording keeps
  stage comments on `factory.js comment` only.
- **Environment findings (machine):** the launchd job was registered but
  its PLIST FILE was missing on disk (survived only via the in-memory
  KeepAlive registration — a reboot would have lost the daemon); FM-4's
  acceptance install wrote a fresh plist and the steady-state daemon was
  restored to the discord-bot checkout afterwards (§7). Tool sessions
  outside the GUI bootstrap context cannot `launchctl print/bootout` the
  job (113/5) — irrelevant in production where deploy runs UNDER the
  daemon, but live smokes from a plain shell can only exercise the git +
  history + verdict paths, not the restart convergence.

- **Acceptance trail (`self` canary #2, this card):** the acceptance ran on
  the laptop through the INSTALLED launchd daemon — deploy → detached
  restart → boot orphan recovery → stage-aware resume → `[VERIFY:PASS]`;
  evidence lives in this card's comment trail (`6af145e01af67cdb31706fe2`)
  and `<clone>/data/factory-deploy-history.jsonl`. Steady-state daemon
  ownership was restored to the discord-bot checkout (§7).

### FM-7 deviations (recorded)

Deviations from "delete everything in the §5 first block", all recorded at
execution (discord-bot master `0885b59`, 2026-11-11):

- **Three libs STAY** (`D-7a`): `scripts/lib/deploy-config.js`,
  `scripts/lib/deploy-ssh.js`, `scripts/lib/factory-launchd.js` are private
  deps of surviving bot scripts — `g50ProdRead.js` (imports the first two)
  and `local-embeddings.js` (imports the third for its launchd KeepAlive
  plumbing); deleting them would break `tests/g50ProdRead.test.js` +
  `tests/localEmbeddings.test.js`. Each carries a header comment pointing at
  the factory repo's canonical copy. No factory MACHINERY (dispatchers, board
  CLI, deploy runners, stage docs/tests) survives in discord-bot — these are
  the same class as the grandfathered one-off `scripts/verify*`.
- **`plans/factory/` history stays** (`D-7b`): 28 plan docs + the
  rollout-verification doc are docs-only records of the discord-bot-board
  era, not machinery; `scripts/g50ProdRead.js` still cites one of them.
- **`.env.example` keeps the `DEPLOY_*` block** (`D-7c`): retitled to a
  deploy-classifier note — `g50ProdRead.js` resolves `DEPLOY_HOST` etc. via
  the kept `deploy-config.js`, and the app-tree log classifier
  (`deploy-host-logs.sh`) ships from the deployed sha; the factory runners
  that read these vars now live in this repo. All other factory sections
  (TRELLO_*/FACTORY_*) dropped.

## 8. Follow-on: agent runs on Zed Delta (studied, not scheduled)

Card 6af3e8877d6b0932b1f0f14b studied moving the repos' agent runs to Zed Delta
(https://zed.dev/blog/delta-public-beta): verdict + operator summary in
`docs/factory-delta-migration.md` (full study:
`plans/factory/6af3e8877d6b0932b1f0f14b-plan.md`). No gate change ships with
the study: the sha-keyed board approval gate stays authoritative, Delta is a
record/visibility surface (its review verdicts advisory), and the Phases 0–3
migration is follow-up card candidates.

## 9. Cutover log

- 2026-11-09 - FM-6 cutover executed: box 192.168.0.157 is the sole dispatcher (systemd user unit factory-daemon.service enabled active); laptop launchd agents booted out, plist files kept as the rollback anchor.
- 2026-11-09 - cutover fixes during step-3 start: /opt/factory/.env completed (FACTORY_SERVER_ID/FACTORY_CHANNEL_ID) + CR-byte cleanup; ghost laptop daemon pending Mac reboot (gates the discord-bot product-card step).
- 2026-11-10 - FM-6 canary 6af1fa46fecb634350948a5d Done on the box: first live Linux detached self-restart (systemd-run) converged; [VERIFY:PASS].
- 2026-11-10 - FM-6 runbook committed (§6.2 executed status + rollback drill). Open operator items: rollback drill before 2026-11-16, Mac reboot (ghost laptop daemon), one discord-bot product card from the box, post-soak plist removal.
- 2026-11-11 - FM-7 deletion executed: 62 factory files removed from discord-bot master `0885b59` (pushed; AGENTS.md 5-line pointer, test-script trim, `.env.example` DEPLOY_* classifier note; deviations D-7a/b/c recorded above). `npm test` post-deletion: failure set identical to the pre-deletion baseline (14 machine-state suites, better-sqlite3 bindings + missing per-bot config overlays), zero failures referencing deleted paths; `node --test` trio (crashUnhandledRejection/g50ProdRead/localEmbeddings) 25/25 pass. Deploy runners verified post-deletion from `/opt/factory`: `deploy.js build master` exit 0 → image `ghcr.io/ajohnson-1/discord-bot:sha-0885b59` built host-local on the deploy box; `verify-deploy.js` on the running sha: 5/6 checks pass (health×2, memory-boot-consistency, gateway-ready, logs-classifier all clean) — the one fail is `ai-hosts-probe` ECONNREFUSED, the embeddings gateway host 192.168.0.159:8123 down at verify time (machine-state, verified by direct probe; unrelated to the deletion — verify-deploy runs from this repo against the deploy host).
- 2026-11-12 - FM-7 post-soak review + laptop rollback-anchor uninstall: the day's Mac reboot re-bootstrapped the still-present discord-bot plists (factory-daemon KeepAlive + prod-watch StartInterval), and a second factory-repo `factory-daemon.js run` had been bootstrapped the same morning — three dispatchers racing the box. Owner DMs from NooNooBot (app `842506994865799169`) root-caused: the discord-bot ghost's `.env` carries no `FACTORY_CHANNEL_ID` / `DISCORD_BOT_CHANNEL_ID` / `FACTORY_DISCORD_WEBHOOK`, so `sendOwnerPing` fell back to the owner-DM path with the bot token; the box daemon and the factory-repo laptop daemon both had channel routing configured. Fix: `bootout`/`remove` all laptop jobs, delete `com.ajohnson.factory-daemon` + `com.discordbot.prodwatch` plists, kill stragglers (the daemon was mid-self-deploy of `6af60d6a85947225f6ed75a0`; its run logged the SIGTERM stop + `[Recovery]` block and the box daemon owns the handoff via stall-sweep/comment-resume — box verified active, sole dispatcher at `8af5f82` = origin/master). 48 untracked factory copies restored to the laptop discord-bot checkout were removed (`git clean`; checkout clean except the pre-existing dirty `yarn.lock`). `com.discordbot.factory-metrics` / `com.ajohnson.factory-sweep` plists were not present. Remaining operator items unchanged: rollback drill before 2026-11-16, one discord-bot product card from the box, archive laptop `data/factory-daemon` logs, soak ≥7 days / ≥3 Done.
- 2026-11-12 - Operator decision: **forward-only**. No rollback drill — the box is the permanent dispatcher; laptop state is cleanup, not an anchor (both anchor plists deleted with the agents the same day). §6.2 drill runbook retained as the fallback recipe; the "rollback rehearsed once" acceptance clause recorded waived (§6.2 table + §7 steady-state text). Remaining operator items: one discord-bot product card from the box, archive laptop `data/factory-daemon` logs, soak ≥7 days / ≥3 Done (clock ends 2026-11-16).
