# Plan — FM-4 acceptance canary: deploy-drivers self — README Deploys section

Card: 6af13b7d426ab6db2fc4b270 · Repo: factory · Branch: `factory/6af13b7d426ab6db2fc4b270` · Docs-only change.

## Requirements (from card description)

Add a `## Deploys` section to `README.md` pointing at docs/factory.md's
"Deploy drivers (per-repo)" section, listing **both** drivers with their exact
deploy/verify/rollback command lines: `docker-ssh` for discord-bot prod,
`self` for the factory runtime.

## Repo facts grounding the plan

- **`README.md` does not exist** on `origin/master` (`git ls-tree HEAD` has no
  readme entry; worktree root has only `AGENTS.md` besides configs). The card's
  "add a section to README.md" therefore means **create `README.md`** with a
  minimal H1 header plus the `## Deploys` section — that is the whole file.
- **`docs/factory.md:188` has `## Deploy drivers (per-repo)`** — the link
  target; GitHub anchor: `docs/factory.md#deploy-drivers-per-repo`.
- **The exact command lines are code-derived truth**, not prose: `deployCommands(repo)`
  in `scripts/lib/factory-registry.js:270-284` renders the per-driver lines that
  land in every run's REPO CONTEXT block (pinned by `tests/factoryStagePrompts.test.js`).
  The README MUST reproduce these verbatim so the doc cannot drift from the renderer:

  **docker-ssh (discord-bot prod):**
  - build: `node scripts/deploy.js build master`
  - deploy: `node scripts/deploy.js deploy <sha>`
  - rollback (after `[VERIFY:FAIL]`): `node scripts/deploy.js rollback`
  - verify: `node scripts/verify-deploy.js`

  **self (factory runtime):**
  - build: none — pushing to `master` IS the artifact
  - deploy: `node scripts/deploy-factory.js deploy` (git pull --ff-only origin master in the runtime clone + detached daemon restart)
  - rollback (after `[VERIFY:FAIL]`): `node scripts/deploy-factory.js rollback` (checkout the previous sha + restart)
  - verify: `node scripts/verify-factory.js` (daemon unit active + a board poll logged after the restart)

- Registry (`config/factory-repos.json`): `factory` → `deploy.driver: self`,
  `discord-bot` → `deploy.driver: docker-ssh`. docs/factory.md notes the
  `[DEPLOY]`/`[VERIFY:*]`/`[ROLLBACK]` comment contract is IDENTICAL across
  drivers; only the runners differ.

## Design decisions

1. **Create `README.md` (it doesn't exist yet)** with a short H1 ("factory") +
   one-line description, then `## Deploys`. A docs-only canary should not grow
   a full repo guide; the Deploys section is the deliverable. (Alternative
   considered: create the file containing ONLY `## Deploys` with no H1 —
   rejected; an H1 is the minimum courteous doc header and costs nothing.)
2. **`## Deploys` content:**
   - Lead line pointing to `docs/factory.md#deploy-drivers-per-repo` as the
     authoritative spec, with the driver→repo mapping (`docker-ssh` =
     discord-bot prod, `self` = the factory runtime) and a note that the
     `[DEPLOY]`/`[VERIFY:*]`/`[ROLLBACK]` comment contract is identical across
     drivers — only the runners differ.
   - Two subsections (or a bulleted pair), one per driver, each listing the
     exact build/deploy/verify/rollback command lines **verbatim from
     `deployCommands()`** above, in code spans. docker-ssh commands run from
     the discord-bot checkout; `self` commands from the factory checkout.
3. **No other files touched.** No links to add elsewhere; docs/factory.md stays
   the spec, README the pointer + quick reference.

## Implementation steps (for implementer)

1. `mkdir -p plans/factory` already done (this plan); create `README.md` at repo
   root with H1 + `## Deploys` per the design above.
2. Copy command lines character-exact from
   `scripts/lib/factory-registry.js` `deployCommands()` (do not paraphrase the
   parenthetical annotations for the `self` driver — they carry the semantics).
3. Commit on `factory/6af13b7d426ab6db2fc4b270`, message prefix
   `factory(6af13b7d426ab6db2fc4b270): impl — README ## Deploys section`. Do not push.

## Verification plan (docs-only; no build/test runs)

- `git diff` review: only `README.md` added; markdown well-formed (one H1, one
  `## Deploys`, fenced/code-span commands balanced).
- Cross-check every command line against `deployCommands()` in
  `scripts/lib/factory-registry.js` — must match verbatim.
- Cross-check driver→repo mapping against `config/factory-repos.json` and
  the docs/factory.md "Deploy drivers (per-repo)" table.
- Link target exists: heading `## Deploy drivers (per-repo)` at
  `docs/factory.md:188` → anchor `#deploy-drivers-per-repo`.
- No tests to add: docs-only change, nothing executable changes;
  `tests/factoryStagePrompts.test.js` already pins the renderer these lines mirror.

## Risks

- Drift if the README paraphrases instead of mirrors `deployCommands()` —
  mitigated by the verbatim rule above.
- Pre-FM-6 nuance (installed launchd job still runs the discord-bot checkout;
  a `self` restart cycles THAT job) is documented in docs/factory.md; the
  README points there rather than duplicating the caveat.

---

## Run 2 addendum — 2026-11-10 (idempotent re-verify, zero impl commits)

Run 1 (2026-11-09) completed CHECK:PASS + deploy and died before posting
`[DEPLOY]`; its commits 233b5e7/342c06a are already merged to master
(`[HUMAN]` operator hold, 2026-11-09T03:58Z). This run re-executes the card
from the fixed tip. The plan above stays as written; this addendum records
run-2 facts only — no design change.

**Deliverable state: already implemented and merged.** Re-verified against
the current tip `origin/master` = `a09efef7ba07cef8f86b2d37e7d71d07682140dd`
(branch tip == master; `git diff origin/master HEAD` is empty):

- `README.md` exists with `# factory`, `## Deploys`, both driver subsections,
  and the link to `docs/factory.md#deploy-drivers-per-repo`; the anchor
  heading `## Deploy drivers (per-repo)` exists in docs/factory.md.
- All 8 command bullets (4 docker-ssh + 4 self) are **character-exact**
  against `deployCommands()` output in `scripts/lib/factory-registry.js`,
  derived from the live registry at
  `FACTORY_REPOS_FILE=/home/factory/factory-repos.local.json`
  (`factory` → `self`, `discord-bot` → `docker-ssh`). Check: 8/8 equal, no
  drift.

**Run facts:** the run-1 worktree was destroyed by the 2026-11-10T13:34Z
cleanup after the FM-6 self-deploy daemon restart; the scheduler rebuilt
worktree + branch from `origin/master` `a09efef` at 2026-11-10T21:46Z
(worktree dir birth time), so the branch diff vs master is empty.

**Decision: zero implementation commits.** The requested change is fully in
place; there is nothing to change. The only commit on this branch is this
plan addendum (docs-only), keeping the branch a fast-forward of
`origin/master`. Downstream: impl is a zero-diff no-op; review/QA/checks
verify the empty diff plus the merged deliverable; deploy runs the `self`
driver (`node scripts/deploy-factory.js deploy` from the factory checkout)
and verify runs `node scripts/verify-factory.js` — which is exactly what
this canary is meant to exercise end-to-end.
