# Plan — planner clarifying questions + plan-approval gate before Implement

Card: 6af61f965d1abaa7ca5275a8 — "Update planner to ask questions as needed. and add approval gate before moving card to implement."
Branch: `factory/6af61f965d1abaa7ca5275a8` (base `origin/master` @ `4c82011480211d18307e28644ff48c328f562322`)

## 1. Requirements (card title is the whole requirement)

(a) **Planner asks questions as needed.** When the card's name/description is ambiguous in a way that changes the plan, the planner stage posts `[ASK]` questions and folds the human answer into the plan — instead of guessing silently.

(b) **Approval gate between Plan and Implement.** A card never flows into Implement without a human approval. Today the Plan→Implement move is unconditional; the gate must make it human-gated, keyed to the plan that was approved, and recoverable (comments are the state).

## 2. Research (state at base sha)

- **[ASK] protocol** — `scripts/lib/factory-ask.js`, CLI `factory.js ask|wait` (`scripts/factory.js:614-635`): `askHuman` posts `[ASK] <question>` + best-effort Discord ping (per-board channel routing via `board`), then date-based polling for the earliest **human reply** (author other than the bot via `isBotMember`, or `[HUMAN]`-tagged; bot comments never count). Timeout → exit 1. `wait` is the resume half ("ask once, wait many times"). Spec: docs/factory.md "Asking a human". planner.md currently mentions `ask … --no-wait` only once, in the shared preamble, as a stuck-escape.
- **Existing approval machinery** — `scripts/lib/factory-risk.js`, CLI `factory.js approve <card> <sha> [branch]` (`scripts/factory.js:708-720`): `classifyDiff` tiers the diff (docs-only → `low` → **auto-pass, zero board writes**); `approvalGate` for medium/high: scan-first for a **sha-keyed** human approval (`findApprovalComment`: full/≥7-char sha prefix, word-bounded, + ask-protocol author rules, bot-authored never), else ONE `askHuman({noWait:true})` post+ping, then `waitForHuman` loop until deadline; a wrong-sha reply does not count and does not re-post (window advances); timeout → `{approved:false,timedOut:true}` → CLI exit 1 → scheduler labels `needs-human`, card stays in QA, **park not bounce** (gate posts no bounce-counted tag). Spec: docs/factory.md "Risk-tiered approval before Deploy".
- **Plan→Implement transition today** — the daemon moves Ready→Plan and spawns ONE headless scheduler run per card (`scripts/factory-daemon.js` `dispatch` + `buildRunPrompt:256-277`); the run drives every later move itself. The contract has no gate between the two steps: docs/factory.md "Scheduler loop" lines 277-278 are literally `move → Plan; planner; expect [PLAN] comment` / `move → Implement; implementer; expect [IMPL]`, and `buildRunPrompt` step 2 enumerates `planner ([PLAN]), implementer ([IMPL]), …` back-to-back. The RISK GATE (step 3) is the in-run gate precedent this design mirrors.
- **Recovery machinery already handles a parked Plan** — a pending `[ASK]` ⇒ stall/crash recovery decides `hold` (zero move/spawn, silent — card 6aee77a4db0dd0de45c77d7c); a later `[HUMAN]`/untagged reply lifts the ask and the comment-resume watcher (`scripts/lib/factory-comment-resume.js` `findPendingAsk`/`isAskPending`) resumes the run **at Plan**; a human drag past the gated stage is an advance instruction (resume prompt: "treat it as approval to proceed … including past any pending [ASK] gate the drag clearly answers"); `needs-human` + drag back to Ready re-runs the card (label removed) — the risk gate's recovery idiom ("approve late, drag back to Ready, the re-run's scan short-circuits — comments are the state") transfers verbatim.
- **Context curation already feeds the planner what it needs** — `scripts/lib/factory-context.js`: the `plan` stage view carries `description`, `human.ask` (latest `[ASK]` excerpt) and `human.reply` (full text of the latest human answer) — no curator change needed for either feature.
- **Test pins** — `tests/factoryStagePrompts.test.js` pins docs↔prompt↔table sync, the scheduler-loop gate ORDER (anchors + "no merge/push line between gates"), per-stage-doc markers, and the run/resume REPO CONTEXT blocks; `tests/factoryRisk.test.js` exercises `factory-risk.js` through injected seams (fake trello/git/notify/sleep/now; zero live Trello/Discord/git); suite runs via `npm test` (jest). Planner doc markers pinned today: comment CLI, exactly-one-comment, first-token, never-move, `[ASK]`, harness-override line, `factory.js read`.
- **Known doc drift (out of scope):** docs/factory.md's "Approval grammar" paragraph ("reply matching is by AUTHOR, never by SHA") contradicts the shipped sha-keyed matcher (`findApprovalComment` requires the sha mention). The risk section ("An approval comment qualifies when it mentions the sha") matches the code and is the operative rule; this card inherits sha-keyed matching and does not touch the drift.

## 3. Design decisions

**D1 — New `plan-approve` command + `planApprovalGate` export that reuses the risk gate's primitives; do NOT extend `approve`.**
Reusing `approve` as-is is wrong: the plan commit is a docs-only diff (`plans/**`) → tier `low` → auto-pass with zero board writes → a gate that never gates. Forcing it through a mode flag (`--plan`) would bolt plan semantics onto the deploy risk gate whose contract is different in kind: the risk gate approves the **code sha that passed QA and will be deployed**; the plan gate approves the **plan content that will be implemented**. Different requiredness (unconditional vs tier-gated), different invalidation (re-plan vs rebase), different park location (Plan vs QA), and the plan gate needs no git/diff at all (sha arrives as argv).
Reuse instead is at the **primitive** level, in one module (`factory-risk.js` already owns "human approval keyed to a sha, ask protocol underneath"): `findApprovalComment`/`shaMentionRe` (matching), `askHuman({noWait:true})` + `waitForHuman` + `isBotMember` (post/ping/wait), `approvalTimeoutDefault` (knobs). If the sha-vs-author grammar drift (D6) is ever resolved, both gates move together because they share the matcher.
*Rejected:* daemon-poller gate like the blocking-checks gate — the poller does not drive per-stage transitions (only Ready→Plan); stage sequencing is the run's contract. *Rejected:* prompt-only gate ("scheduler, ask the human in prose") — prompt-only gates drift; sha-keyed CLI + `[ASK]` audit is the established pattern (RISK GATE precedent).

**D2 — Gate is unconditional: every card, every tier.** The requirement says the gate must exist before Implement; reviewing a plan is cheap (one doc read + one comment) and its whole purpose is human eyes before implementer compute is spent. No risk-tier escape hatch (that would re-invent the docs-only auto-pass that defeats the gate). Human overrides already exist in contract: a late sha-keyed approval comment satisfies the scan, and a drag past Plan→Implement is a human advance instruction (existing resume rule answers the pending ask).

**D3 — Approval keys to the PLAN COMMIT SHA.** `sha = git rev-parse HEAD` in the card worktree immediately after the planner commits `plans/factory/<id>-plan.md`. Invalidation on change mirrors the risk gate's rebase rule: any re-plan = new commit = new sha = approval stale = gate re-asks. If the plan file is untouched (e.g. resume with an already-approving human reply, nothing else changed), HEAD is unchanged and the scan short-circuits with zero new board writes.

**D4 — Gate runs in the scheduler run, after `[PLAN]`, before `move → Implement`** — the exact RISK GATE idiom: exit 0 → move; exit 1 (timeout) → `node scripts/factory.js label <card> needs-human`, leave the card in **Plan**, stop the run. **Park, not bounce:** the gate posts no `[REVIEW:CHANGES]/[QA:FAIL]/[VERIFY:FAIL]/[CHECK:FAIL]`, so the 3-bounce budget is untouched. Recovery: approve on the card (comment containing the plan sha) + drag back to Ready → re-run's scan short-circuits; or a plain `[HUMAN]` reply on a pending ask resumes at Plan via the comment-resume watcher. While the gate's `[ASK]` is pending, the ask-pending guardrails (silent watcher, stall-hold) apply unchanged, and the ask-on-top invariant (`liftPendingAsk`) keeps the ask the newest comment.

**D5 — Planner question-asking is prose guidance in `docs/factory-prompts/planner.md` only.** The ownership split is explicit (docs/factory.md "Stage prompts"; `docs/factory-prompts/README.md`): the Board contract owns tags/gate logic; the stage doc owns the role procedure. Asking is the existing `[ASK]` protocol — zero new tags, zero `STAGE_TAGS`/curator/ask-code changes. New guidance: ask **once, grouped** (all open questions in one `[ASK]` comment, numbered), **blocking** (default 1 h) so the answer lands inside the run; ask only when the ambiguity changes the code (read the repo first; boring/safe defaults get an assumption note in the plan instead, not a question); on re-entry never double-post — check the context `human` channel and use `factory.js wait`; on ask timeout do NOT fake a `[PLAN]` (pending `[ASK]` is the board-visible "waiting on you"; a later reply resumes at Plan).

**D6 — Sha-keyed approval matching (parity with shipped risk-gate code).** The plan-gate ask text instructs `"[HUMAN] APPROVED <sha>"` and accepts any human comment mentioning the plan sha (full or ≥7-char prefix, word-bounded); bot-authored never counts; degraded identity (no `getMe`) → `[HUMAN]`-tagged only — same fail-closed trade-off as the risk gate. The pre-existing "Approval grammar" author-only drift is left untouched (assumption A2).

**No new tags; no new env knobs** (timeout reuses `FACTORY_APPROVAL_TIMEOUT_MS` → `FACTORY_ASK_TIMEOUT_MS` → 1 h; interval reuses `FACTORY_ASK_POLL_MS` → 30 s).

## 4. Changes, file by file

### 4.1 `scripts/lib/factory-risk.js` — two new exports (append after `approvalGate`)

```js
/** The plan-gate `[ASK]` question template (docs/factory.md "Plan approval
 *  gate before Implement"). Keys to the PLAN COMMIT sha; states the
 *  re-plan invalidation rule. */
export const planApprovalAskText = ({ cardId, sha }) =>
  `Plan approval required. Implementation of card ${cardId} is held until a ` +
  `human approves the plan on branch factory/${cardId} ` +
  `(plans/factory/${cardId}-plan.md @ sha ${sha}). ` +
  `To approve, post a comment containing the sha, e.g. "[HUMAN] APPROVED ${sha}". ` +
  `Comments keyed to another sha do not count — after a re-plan a new approval is required.`;

/**
 * The plan-approval gate (docs/factory.md "Plan approval gate before
 * Implement"): unconditional human approval keyed to the PLAN COMMIT sha,
 * between the [PLAN] verdict and the move to Implement. Same primitives as
 * approvalGate, no tiering and NO git (the sha arrives as argv; the CLI runs
 * from the factory checkout): required for every card; scan-first
 * (findApprovalComment, any date — comments are the state); else ONE
 * askHuman({noWait:true}) post + Discord ping, then waitForHuman until the
 * deadline; wrong-sha replies don't count, don't re-post, window advances;
 * timeout → {required:true, approved:false, timedOut:true} → CLI exit 1 →
 * scheduler parks needs-human IN PLAN (a park, not a bounce).
 * → { required:true, approved, via?, timedOut?, sha, askCommentId?, discord?,
 *     reply?, polls, waitedMs }
 */
export async function planApprovalGate({
  cardId, sha, timeoutMs = approvalTimeoutDefault(), intervalMs = envNum('FACTORY_ASK_POLL_MS', 30_000),
  board = undefined, t = trello, notify = sendOwnerPing,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date().toISOString(),
} = {}) { … }
```

Body mirrors `approvalGate`'s flow minus `cls`/git: `shaMentionRe(sha)` (throws on a bad sha — CLI surfaces as a usage die); best-effort `t.getMe()` (`bot = null` on error → tagged-only fail-closed); `t.getCardComments` + `findApprovalComment(actions, { sha, bot })` → `{ approved:true, via:'existing-comment' }` with zero `addComment`; else second-floor `askFloorIso`, `askHuman({ cardId, question: planApprovalAskText({ cardId, sha }), noWait: true, board, t, notify, sleep, now })`, then the same `waitForHuman` loop (deadline = `askFloorIso + timeoutMs`; sha-mention reply → `approved:true, via:reply.via`; non-matching human reply → advance window `+1 ms`, ONE ask post for the whole window; expiry → `timedOut:true`).

### 4.2 `scripts/factory.js` — `plan-approve` subcommand (after `approve`, same file/flag shape)

```js
  // Plan-approval gate (docs/factory.md "Plan approval gate before
  // Implement"): unconditional, keyed to the PLAN COMMIT sha. No git — the
  // sha is argv (the scheduler run passes `git rev-parse HEAD` of the worktree
  // right after the planner commits the plan file). Timeout → exit 1 → the
  // scheduler labels needs-human and leaves the card in Plan (park, not a
  // bounce). Recovery = approve on the card + drag back to Ready (scan
  // short-circuits; comments are the state).
  async 'plan-approve'() {
    const board = boardOf();
    const { flags, positional } = parseFlags(args);
    const id = parseCardId(positional[0]);
    const sha = (positional[1] || '').toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha))
      die('Usage: factory.js plan-approve <card> <sha> [--timeout <ms>] [--interval <ms>]  (sha = plan-commit HEAD — 7-40 hex chars)');
    const res = await planApprovalGate({ cardId: id, sha, board, ...flags });
    out(res);
    process.exit(res.approved ? 0 : 1);
  },
```

Plus the usage-list entry after the `approve` lines (`plan-approve <card> <sha>  plan gate: exit 0 only when a human comment keys THIS plan-commit sha`, with the timeout/interval defaults line).

### 4.3 `scripts/factory-daemon.js` — `buildRunPrompt` step 2, one inserted sentence

After the "Spawn stage subagents: planner ([PLAN]), implementer ([IMPL]), …" sentence, insert (single template line, kept inside step 2):

> `   PLAN GATE after [PLAN] and BEFORE the Implement move: in the worktree capture sha=$(git rev-parse HEAD) (the planner's plan commit), then run node scripts/factory.js plan-approve <card> $sha. Exit 0 → move → Implement. Exit 1 (approval timeout) → node scripts/factory.js label <card> needs-human, leave the card in Plan, STOP this run — a park, NOT a bounce (the gate posts no bounce-counted tag). A pre-existing human approval comment keyed to the plan sha satisfies the gate with zero new writes (comments are the state). The planner itself may post grouped [ASK] clarifying questions before its [PLAN] — see docs/factory-prompts/planner.md.`

No other daemon change: the daemon still only moves Ready→Plan; resume runs inherit the gate through the docs contract. `buildResumePrompt` stays byte-identical (its "continue the pipeline from ${stage} per the contract" already picks the gate up from docs/factory.md; a human reply while parked at Plan resumes the planner, who then re-runs the gate — D3's scan short-circuits when the plan file is unchanged).

### 4.4 `docs/factory.md` — contract updates

1. **Scheduler loop block** — between the two transition lines:
   ```
   move → Plan;      planner;      expect [PLAN] comment
   PLAN GATE: node scripts/factory.js plan-approve <id> <sha>  (sha = plan-commit HEAD, captured in the worktree)
                ANY card: exit 0 → move → Implement; exit 1 (timeout) → needs-human, card stays in Plan,
                stop the run — a park, NOT a bounce (3-bounce budget untouched). Comments are the state:
                a late human approval + drag back to Ready re-runs and the gate's scan short-circuits.
   move → Implement; implementer;  expect [IMPL]
   ```
2. **New section "Plan approval gate before Implement"**, placed immediately BEFORE "## Risk-tiered approval before Deploy" (the two sha-keyed approval gates sit adjacent). Content: motivation (human eyes on the plan before implementer compute; `[PLAN]` is a bot verdict and is NEVER an approval); the protocol (CLI line, sha = plan-commit HEAD, unconditional — every tier; scan-first recovery; ONE `[ASK]`+ping then date-based wait; wrong-sha replies don't count and don't re-post; invalidation: any re-plan = new sha = new approval); outcome semantics (exit 1 → `needs-human` IN PLAN, run stops, park-not-bounce); recovery paths (late approve + drag to Ready; a `[HUMAN]` reply resumes at Plan via the comment-resume watcher; a drag past the gated stage is a human advance per "Listening for human comments"); interaction line (pending `[ASK]` keeps the watcher silent and stall recovery holds; ask-on-top invariant keeps the ask newest; up to `FACTORY_MAX_PARALLEL` runs may each block ≤ the timeout — `FACTORY_APPROVAL_TIMEOUT_MS` bounds it; no new tags, no new env knobs); pointer that planner clarifying-question guidance lives in `docs/factory-prompts/planner.md` (ask protocol spec stays "Asking a human").
3. **CLI block** — after the `approve` line (line ~753):
   `node scripts/factory.js plan-approve <card> <sha> [--timeout ms] [--interval ms]  # plan gate; exit 1 unless a human comment keys the plan-commit sha`
4. **Stages table, Plan row** — "On success" cell: `→ plan approval gate (factory.js plan-approve, sha-keyed human approval) → Implement`; Output cell untouched (`[PLAN]` stays the Plan stage's one comment — the gate posts no new tag; the sync test's tag scan reads Output only).

### 4.5 `docs/factory-prompts/planner.md` — new `## Ask when ambiguous` section (between Procedure and Verdict) + two small amendments

New section:
- **Ask triggers** — ask when the card leaves a decision that changes the code and only a human can make it: acceptance criteria unspecified; two readings that lead to different files/interfaces/behaviors; an external contract (API shape, data format, product behavior) the card doesn't pin; scope trade-offs (do A, or A+B?). Do NOT ask what the repo can answer (investigate first — `factory.js context <card-id> plan` + repo read), and do NOT ask preference questions you can settle with the boring/safe option — **write the assumption into the plan instead** (assumptions are what the approval gate reviews).
- **Ask once, grouped, blocking** — collect ALL open questions into ONE `[ASK]` comment: `node scripts/factory.js ask <card-id> -` (stdin, numbered questions), blocking with the default 1 h timeout so the answer lands inside your run. Never post several asks.
- **Re-entry never double-posts** — before asking, read `factory.js context <card-id> plan`'s `human` channel: your earlier `[ASK]` still pending → `node scripts/factory.js wait <card-id>` (ask once, wait many times); already answered (`human.reply`) → fold the answer in and continue.
- **On an answer** — resolve the question explicitly in the plan file ("Resolved by human answer: …").
- **On timeout** (ask exits 1) — do NOT post `[PLAN]` and do NOT guess: the pending `[ASK]` is the board-visible "waiting on you"; per Failure semantics the stage failed; a later human reply resumes this stage at Plan.
- **Plan approval gate note** — after your `[PLAN]` comment, the scheduler runs `factory.js plan-approve` on your plan commit's sha and the card waits in Plan for a human approval before Implement. When you update the plan file (re-plan or a post-approval change request), the new commit sha invalidates any earlier approval — expect re-approval.
- **Failure semantics amendment** — one sentence: an ask that times out is a stage failure: post no `[PLAN]`; the pending `[ASK]` + the resume machinery park and recover the card; faking a `[PLAN]` to dodge the wait is forbidden (existing rule).
- All pinned preamble markers (comment CLI, exactly-one/first-token, never-move, `[ASK]`, override line, `factory.js read`) stay intact.

### 4.6 `tests/factoryRisk.test.js` — `planApprovalGate` / `planApprovalAskText` cases (injected seams, zero live I/O)

- required for EVERY card: approval asked even when the only "diff" is docs/plans (no tiering, no git dep — `planApprovalGate` must not call `git` at all: fake git = throwing stub).
- scan-first: existing human comment mentioning the sha → `{approved:true, via:'existing-comment'}`, zero `addComment`/notify calls.
- ask path: exactly ONE ask post + one ping; ask text contains the sha and the plan path.
- qualifying reply: human-author comment containing the sha (full and 7-char prefix) → approved, `via` set; degraded identity (`getMe` throws) → `[HUMAN]`-tagged reply counts, author-only does not.
- bot-authored comment containing the sha NEVER approves (even `[HUMAN]`-tagged).
- wrong-sha human reply: not approved, window advances, still exactly one ask post; later correct-sha reply approves.
- timeout: virtual clock past deadline → `{approved:false, timedOut:true, required:true}`; exit mapping covered by CLI process test.
- CLI: `node scripts/factory.js plan-approve` with a non-hex / missing sha → usage error exit before any network (spawn pattern of the existing CLI-dies-early tests).

### 4.7 `tests/factoryStagePrompts.test.js` — new pins (follow existing anchor style)

- Scheduler-loop order: `expect [PLAN] comment` < `PLAN GATE: node scripts/factory.js plan-approve` < `move → Implement;`, and the slice between the PLAN GATE anchor and `move → QA;` still contains the RISK GATE anchor (existing pin keeps passing); the Plan→Implement slice contains no `git merge --ff-only` and no `factory.js approve ` — a merge never precedes implementation and the deploy gate never moves up.
- `buildRunPrompt` carries `plan-approve`, `needs-human`, and the park-not-bounce stop instruction.
- `docs/factory.md` contains `Plan approval gate before Implement` + `plan-approve` in the CLI block; Stages-table Plan row names `plan approval gate`.
- planner-doc markers: `factory.js ask` with the blocking/grouped guidance (`/one .?ASK.?/i`, `numbered`), re-entry `factory.js wait`, `do NOT post .?PLAN.` on timeout, and the approval-gate pointer (`plan-approve` named or "plan approval").

## 5. Test strategy & verification evidence plan

- New `planApprovalGate` cases run under `tests/factoryRisk.test.js` (injected trello/notify/sleep/now; the same fake-comment-action fixtures as the risk-gate tests). No new test file; no new runner.
- Sync pins in `tests/factoryStagePrompts.test.js` (pure docs/prompts reads, no network).
- Implementer evidence (`[IMPL]` comment prose): `npm test` full suite with observed counts/exit code; `node scripts/factory.js plan-approve` usage line printed for the bad-sha die; import smoke `node -e "import('./scripts/lib/factory-risk.js').then(m=>console.log(typeof m.planApprovalGate, typeof m.planApprovalAskText))"` → `function function`.
- What these checks would NOT catch: live Trello/Discord round-trips (the actual `[ASK]` post, ping, and reply-detection against the real board), and whether a real scheduler run honors the new gate prose before its Implement move — first gated card is the operator's observation point.

## 6. Assumptions (decided here; no `[ASK]` needed)

- **A1 — Unconditional gate** (every card, every tier) per the literal requirement; the human overrides are the contract's existing ones (late sha-keyed approval comment; drag past Plan→Implement). No new env opt-out knob.
- **A2 — Sha-keyed approval matching** (parity with shipped `findApprovalComment`); docs' "Approval grammar" author-only wording is pre-existing drift, left untouched.
- **A3 — No new tags** (`[ASK]` + human reply carry the gate; Board contract tag set and `STAGE_TAGS` unchanged — the sync test's "no doc invents a tag" pin is safe).
- **A4 — Gate lives in the scheduler run** (docs + `buildRunPrompt`), mirroring RISK GATE; the daemon poller is unchanged. `buildResumePrompt` byte-identical.
- **A5 — Blocking grouped ask in the planner** (default 1 h, one comment) — the `--no-wait` variant stays available; timeout = park semantics already specified by the ask protocol + stall/hold machinery.
- **A6 — This card's own gate**: once this plan is committed, the running scheduler applies the plan gate to this very card at the Plan→Implement step — approving means posting a comment containing the plan-commit sha (the head of this branch after the plan commit).

## 7. Out of scope

- Deploy risk gate semantics/grammar (incl. the A2 drift fix), `[ASK]` protocol code, comment-resume/stall-sweep code, curator changes, C-M11 eval re-score runs beyond the normal review pipeline.
