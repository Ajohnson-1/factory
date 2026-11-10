# Plan — FM-6 — Laptop→box cutover + rollback runbook

Card: `6aee5f4ddfa43cd53a1c7b2b` · Repo: factory (runtime clone `/opt/factory`) · Branch: `factory/6aee5f4ddfa43cd53a1c7b2b` · Deliverable: docs-only — the executed cutover+rollback runbook in `docs/factory-migration.md` §6.2 + §9 log entries. No code, no tests.

## Requirements (card description)

Sub-steps: preflight/soak/uninstall per §6.2 · runbook committed to `docs/factory-migration.md` · rollback rehearsed once (box → laptop → box) during the soak window.
Acceptance: ≥7 days always-on on the box, ≥3 Done cards, laptop agents uninstalled, runbook merged.

**Core problem to solve:** the cutover already *happened* (operator-driven, [OPS] 2026-11-09), but §6.2 in the repo is still the pre-execution *design* runbook and §9 logs only one line. This card's durable artifact is §6.2 converted to the **executed runbook**: per-step evidence for what ran, exact commands for what still must run (rollback drill, uninstall), and an acceptance-tracking block that states honestly which items are satisfied, which time-gate (soak ends 2026-11-16), and which are operator-owned (Mac reboot for the ghost daemon; step 5 + drill are console/GUI work — a daemon-dispatched run that issues machine transitions reclaims itself mid-flight).

## Repo + live facts (verified 2026-11-10, box `DiscordBot` = 192.168.0.157, master tip `c5f278e`)

- **[OPS] 2026-11-09T16:55:44Z comment (full trail)** records: step 1 drain verified via board APIs 16:47Z both boards; step 2 laptop `factory-daemon` registration reclaimed with its transient session 16:34Z (plist kept = rollback anchor), `com.discordbot.prodwatch` booted out; **ghost laptop daemon** (stale discord-bot job in an unreachable launchd domain) needs a Mac reboot before the product-card step, else double-dispatch of `ZHkVYBN1`; step 3 `systemctl --user enable --now factory-daemon.service` active **16:51:27Z**, boot + `poll ok` LLNG5MAm + ZHkVYBN1, driven over ssh with `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` exported (no console needed); `.env` fix (missing `FACTORY_SERVER_ID`/`FACTORY_CHANNEL_ID` appended + CR-byte sed cleanup — dotenv tolerated CRs, raw sourcing 401-ed); step 4 canary `6af1fa46fecb634350948a5d` dispatched on the box.
- **Canary completed:** `6af1fa46fecb634350948a5d` is in the LLNG5MAm **Done** list; deploy history `/opt/factory/data/factory-deploy-history.jsonl` shows its `a09efef` deploy 2026-11-10T13:32Z via `systemd-run factory-daemon.service in 2s` — the first live Linux detached self-restart converging end-to-end. (Card `6af13b7d426ab6db2fc4b270` is also Done, deployed `c5f278e` 22:20Z today.)
- **Box units live right now:** `factory-daemon.service` + `factory-metrics`/`factory-sweep`/`prod-watch` service+timers all **active** (`systemctl --user is-active`); timers fire (prod-watch last 22:52Z, 300 s cadence).
- **Soak evidence so far:** journal since 2026-11-09 16:00: **13 boots ↔ 13 `poll ok` for LLNG5MAm ↔ 13 for ZHkVYBN1 (1:1)** — every restart (all deploy-armed) came back polling both boards; **zero `[PROD-WATCH]` incident cards** on LLNG5MAm (board status scan: 0 name matches).
- **Done cards on the box since cutover (16:51Z 2026-11-09): 2** (the two canaries). The ≥3 counter advances naturally; this card is projected 3rd at merge.
- **discord-bot board (ZHkVYBN1)** Done list is pre-migration inventory — no product card has run from the box yet; §6.2 step 5 is genuinely pending, gated on the Mac reboot.
- **Doc structure:** `docs/factory-migration.md` = 406 lines; §6 "Laptop → Proxmox migration plan" (6.1/6.2/6.3 at lines ~158–228), `---` then §7 with FM-1…FM-4 notes subsections, `## 9. Cutover log` last (lines 404–406, the canary's verbatim bullet — **do not touch that bullet**). No `## 8` exists.
- **No test pins this doc:** every `factory-migration` hit under `tests/` is a prose citation in comments (`§4.3`, `D7`, `§6.1`…). `npm test` is unaffected by §6.2/§9 edits; docs-to-tests sync covers `docs/factory-prompts/`, not this file.
- **Laptop launchd identifiers** (for runbook commands): `factory-daemon.js` `LABEL='com.ajjohnson.factory-daemon'`, `PLIST_PATH=~/Library/LaunchAgents/<label>.plist`; `prod-watch.js` `com.discordbot.prodwatch`; `factory-metrics.js` `com.discordbot.factory-metrics`; `lib/factory-sweep.js` `com.ajohnson.factory-sweep`. FM-4 finding (recorded in the doc): non-GUI shells cannot `launchctl print/bootout/bootstrap` the laptop job (113/5) — laptop-side steps are console-owned; box-side `systemctl --user` works over ssh with the env vars above.
- **Bounce budget:** fresh card — 0 bounces, 0 impls.

## Design decisions

1. **Update §6.2 in place; do not add a new top-level section.** The card description points at "§6.2", §7's runtime rule says "every runbook step names the freeze/start pair", and the doc must keep ONE runbook for this transition. §9 stays the chronological log. A new "## 10. runbook" section would fork the source of truth and collide with the planned §8 slot above §9 (canary-plan fact).
2. **Preserve the six design steps, convert to a checked status list.** Each step keeps its original intent text, gains `[x]`/`[ ]` + an evidence clause (timestamps, card ids, journal counts). Rewriting the steps away would erase the design→execution mapping the reviewer diffs against the card description.
3. **Add two subsections under §6.2**: `Rollback drill — box → laptop → box` (exact forward/back command pairs, drain precondition, D8 divergence note, "record result in §9") and `FM-6 acceptance tracking` (table mapping the 4 acceptance clauses + the rehearsal sub-step to status/owner/date). The drill cannot execute in this run: forward leg = box unit stop + **laptop console GUI** `launchctl bootstrap` (FM-4 113/5 finding; ghost daemon also wants the reboot first), and a dispatched run issuing `systemctl --user stop factory-daemon` kills its own parent — the [OPS] execution model. It stays **operator-owned, scheduled before 2026-11-16**.
4. **Checkbox ownership — what the implementer ticks (in the doc):** steps 1–4 (executed, evidence attached), acceptance "runbook merged" (true at this card's merge — the pipeline's `self` deploy IS the merge proof). **Stays open, named owners:** step 5 product card (operator, after Mac reboot), step 6 soak+uninstall (time-gated to 2026-11-16 + operator), rollback drill (operator, during soak), acceptance ≥7 days / ≥3 Done / laptop uninstalled (time/operator). The card may reach Done on merge with these documented-open — that is the honest state of a runbook whose soak is mid-flight; FM-7 (laptop cleanup) is the natural closer.
5. **§9 appends three dated bullets, chronological, existing canary bullet byte-identical:** the 16:55Z .env fix + ghost-daemon gate; the 2026-11-10 canary Done + first live Linux detached self-restart; the runbook commit with its open operator items + drill deadline 2026-11-16.
6. **File scope: `docs/factory-migration.md` only** (plus this plan file, already committed). No §6.1/§6.3/§7 edits — they already state the steady-state rule the runbook now reflects; touching them invites review churn. Fresh counts (Done cards, boot/poll pairs) are re-taken by the implementer at commit time; numbers age with the soak — the text marks them "as of commit".

## Implementation steps

1. **Re-take live evidence** (read-only, from `/opt/factory` — NEVER issue a machine transition; the run is a child of the daemon):
   - `systemctl --user is-active factory-daemon.service` (+ timers),
   - `journalctl --user -u factory-daemon.service --since "2026-11-09 16:51"` → boot marker count (`watching "Ready"`) vs per-board `poll ok` counts (expected 1:1; baseline 13/13/13 as of 2026-11-10),
   - `node scripts/factory.js status --repo factory` / `--repo discord-bot` green + zero `[PROD-WATCH]` cards + Done-list contents (`pull Done --repo factory`; box-since-cutover Done ids: `6af1fa46fecb634350948a5d`, `6af13b7d426ab6db2fc4b270`, plus any newer),
   - `tail data/factory-deploy-history.jsonl` (canary deploy entry).
   Use the fresh numbers in the text.
2. **Replace the §6.2 block** (heading `### 6.2 Cutover runbook (FM-6)` + its six numbered steps, up to `### 6.3`) with this drafted text (evidence numbers per step 1):

```
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
  <N> boots ↔ <N> `poll ok` per board (1:1, all deploy-armed restarts), zero
  `[PROD-WATCH]` incident cards on `LLNG5MAm`, <K> Done cards completed on the
  box since cutover (≥3 target counts naturally; the FM-6 card itself is
  projected third). After the soak passes → FM-7 cleanup + remove the laptop
  rollback anchors (jobs are already booted out):
  `rm ~/Library/LaunchAgents/com.ajohnson.factory-daemon.plist`
  `~/Library/LaunchAgents/com.discordbot.prodwatch.plist`
  (+ `com.discordbot.factory-metrics` / `com.ajohnson.factory-sweep` plists if
  present), archive `data/factory-daemon` logs.

#### Rollback drill — box → laptop → box (once, inside the soak) ⏳ operator-owned

Rehearses the §6.3 cutover rollback forward and back before the soak ends
(target before 2026-11-16). Precondition: both boards drained (zero in-flight).
Run interactively — never from a dispatched run (§7 invariant).

1. Forward (box → laptop): box `systemctl --user disable --now
   factory-daemon` and stop the satellite service+timer pairs
   (`factory-metrics`, `factory-sweep`, `prod-watch`); laptop console:
   `launchctl bootstrap gui/$(id -u)
   ~/Library/LaunchAgents/com.ajjohnson.factory-daemon.plist` (+ the prodwatch
   plist); verify laptop `node scripts/factory.js status` green on both boards.
2. Back (laptop → box): laptop `launchctl bootout
   gui/$(id -u)/com.ajohnson.factory-daemon` (+ prodwatch); box
   `systemctl --user enable --now factory-daemon`; verify boot + `poll ok` for
   both boards in `journalctl --user -u factory-daemon.service`.
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
| ≥3 Done cards on the box | ⏳ <K> since cutover; FM-6 merge is projected 3rd | pipeline (flows naturally) |
| laptop agents uninstalled | ⏳ jobs booted out; plist removal after soak; **Mac reboot first** (ghost daemon) | operator (FM-7) |
| rollback rehearsed once (box→laptop→box) | ⏳ drill scheduled inside the soak window | operator (console) |
| runbook merged | ✅ this commit, merged + self-deployed by the factory pipeline itself | done |
```

3. **Append three bullets to `## 9. Cutover log`** (keep the existing 2026-11-09 bullet byte-identical; same `- YYYY-MM-DD - …` shape):
   - `- 2026-11-09 - cutover fixes during step-3 start: /opt/factory/.env completed (FACTORY_SERVER_ID/FACTORY_CHANNEL_ID) + CR-byte cleanup; ghost laptop daemon pending Mac reboot (gates the discord-bot product-card step).`
   - `- 2026-11-10 - FM-6 canary 6af1fa46fecb634350948a5d Done on the box: first live Linux detached self-restart (systemd-run) converged; [VERIFY:PASS].`
   - `- 2026-11-10 - FM-6 runbook committed (§6.2 executed status + rollback drill). Open operator items: rollback drill before 2026-11-16, Mac reboot (ghost laptop daemon), one discord-bot product card from the box, post-soak plist removal.`
4. **Commit** on `factory/6aee5f4ddfa43cd53a1c7b2b`: message `factory(6aee5f4ddfa43cd53a1c7b2b): impl — executed cutover+rollback runbook in factory-migration.md §6.2/§9`. Do not push. (This plan file was committed in the plan stage.)
5. **Post `[IMPL]`** naming: runbook committed (§6.2 executed status + drill + acceptance table), steps 1–4 ticked with evidence, and the explicitly open items with owners/dates (drill ≤ 2026-11-16 operator console; step 5 + uninstall after Mac reboot; soak ends 2026-11-16; Done-counter advances naturally) — so Review/QA see the open items are by design, not omissions.

## Verification plan

- `git diff --stat`: exactly `docs/factory-migration.md` (+ this plan file in its own commit), no deletions outside the §6.2 replacement block.
- §9 existing bullet unchanged byte-for-byte (diff shows only `+` lines below it); §6.3/§7 untouched; no `## 8`/`## 10` introduced.
- Markdown well-formed: heading levels `###`/`####` under §6; table renders (header + separator rows); file ends with exactly one trailing newline; ASCII hyphens in commands, `→`/`≥` only where matching existing doc style.
- Every timestamp/id in the text is from a command actually run this session (step 1) — no invented evidence.
- `npm test` unaffected (fact above); run the CHECK gate as usual, expect pass with zero test edits.

## Deploy / verify expectations (`self` driver)

Merge `--ff-only` + merge-guard → deploy from `/opt/factory`: porcelain-clean clone, ff-pull this card's merge sha, detached `systemd-run --user --on-active=2s` restart (exactly today's five-times-exercised path; restart-armed ≠ crash per the 5e122df daemon fix). Verify reads the last deploy-history entry ts → unit active + boot marker + first poll-ok after restart (journalctl `@<epoch>` dialect, fixed in c71d02f) → `[VERIFY:PASS]`. If the merge gate short-circuits and master tip equals the last-deployed sha, the idempotent restart-skipped path applies — both branches converge (canary run 3 fact).

## Risks / mitigations

- **Self-reclaim:** implementer must NOT run any `systemctl` stop/restart or `launchctl` mutation — only read commands (step 1 list). Recorded in step 1 as an imperative.
- **Ghost laptop daemon** double-dispatching `ZHkVYBN1` pre-reboot: runbook states the gate explicitly; nothing this run can fix from the box; it is the card's own open operator item.
- **Stale soak numbers:** evidence values are taken minutes before commit and labeled "as of commit"; the soak itself is tracked by dates, not by the snapshot.
- **§9 drift:** the canary card's Done entry and §6.3/§7 text stay byte-identical — reviewers can diff-check in seconds.
