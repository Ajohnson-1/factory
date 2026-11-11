# Plan — Stop commenting the crash report when waiting for human response

Card: 6aee77a4db0dd0de45c77d7c · Repo: factory · Branch: `factory/6aee77a4db0dd0de45c77d7c`
One-function fix in `scripts/factory-daemon.js` + `docs/factory.md` contract text + test re-shaping. No changes to any other lib.

## Root cause (verified against the live trail)

The example comment — card `6aee5f4d6e98279cb3ab3304` (FM-5), comment `6af1ed5c4b3dd164aeeee2e0`, 2026-11-09T15:57:16.416Z — is a `[DAEMON-CRASH]` report posted **74 seconds after the card went human-waiting**:

- 15:56:02.821Z `[ASK]` — the Deploy run's risk gate (`factory.js approve`, high tier) posted the approval ask + Discord ping and was waiting (the run ran it in the background, printed its pipeline-state status, and **exited 0 with no verdict**).
- 15:57:16.416Z `[DAEMON-CRASH] run exited stalled (exit 0 with no verdict) after 2 prior crash(es); parking needs-human where it stands (QA)` + the full ≤40-line / ≤4000-char run-log tail — the card already had 2 `[DAEMON-CRASH]` comments (14:26, 14:38) so `decideCrashRecovery`'s park cap (≥ `FACTORY_CRASH_RETRIES` = 2) **out-ranks the ask-pending hold** → `park` → full crash report posted.
- 16:04:08.605Z `[HUMAN] APPROVED 539e8a4…` — the approval was already in flight; the gate resolved and the background `approve` kept the run's contract. The crash report added zero information and its 4 KB tail buried the `[ASK]` the human was supposed to read — exactly the card's complaint ("flood the comment and make it hard to read what the ask is").

Every posting site of a crash report while a human answer is owed, found by exhaustive search of `addComment`/`crashCommentText` call sites:

- `scripts/factory-daemon.js` `handleRunCrash` (the ONLY crash-report poster — daemon dispatch/resume exit handlers and the stall sweep both funnel here via `crashRecovery`). Two shapes post on a waiting card, both stall-family (`isStallCode(code)`):
  1. **hold + `holdReason:'ask-pending'`** (below the cap): `[DAEMON-CRASH] stalled …; a pending [ASK] owns the reply — left waiting on the human (<stage>)` + log tail — made visible deliberately by RC4 on card 6aebab9a65613358f4ca333a ("waiting on you becomes board-visible").
  2. **park + askPending** (at the cap): `[DAEMON-CRASH] … parking needs-human where it stands (<stage>)` + log tail — **the example comment**.
- `scripts/lib/factory-stall-sweep.js`: already **skips ask-pending cards** (`selectInFlight` tags them `reason: 'ask-pending'`; docs confirm "Cards … whose `[ASK]` is still pending are skipped") — never the flood source, but a race (ask posted between selection and recovery) lands in `handleRunCrash` and is covered by the same predicate.
- `scripts/lib/factory-ask.js`: posts `[ASK]` (+ `[HUMAN]` relays) only; timeout exits 1 so the scheduler parks per the board contract — never posts a crash report. No change needed.

Flood mechanic: any daemon restart or `FACTORY_MAX_TIME` cap hit while a stage agent waits on a human (approval gate, `[ASK]`) ends that run as `stalled (exit 0 with no verdict)` → one `[DAEMON-CRASH]` report (head + log tail) per wait, stacked on top of the `[ASK]`. The exit-0-stall classification (D1) is correct and stays; only the **comment** is wrong on a waiting card.

## Fix

`handleRunCrash`, beside the existing D4 `silentHold` line (`scripts/factory-daemon.js:499`). Add one predicate and extend the post guard:

```js
const silentHold = mode === 'hold' && !degraded && !askPending && isStallCode(code); // unchanged (D4)
// Card 6aee77a4db0dd0de45c77d7c — a stall while a blocking [ASK] is pending is
// the WAIT, not a failure: the pending [ASK] comment IS the board-visible
// "waiting on you" (the ask protocol already Discord-pings the owner). The
// report head + ≤4 KB run-log tail bury the ask the human must read (card
// 6aee5f4d6e98279cb3ab3304 comment 6af1ed5c4b3dd164aeeee2e0: park report 74 s
// into an approval wait). Every recovery DECISION is unchanged — park still
// applies needs-human, silently.
const waitingOnHuman = askPending && !degraded && !restartStopped && isStallCode(code);
```

and in the post block:

```js
if (!silentHold && !waitingOnHuman) { …existing addComment(crashCommentText(...)) call, byte-identical… }
else if (waitingOnHuman) log(`stall for ${card.id} (${code}) while a pending [ASK] owns the reply — crash comment suppressed (${mode}${stage ? ` at ${stage}` : ''})`);
else { …existing silentHold "comment suppressed" log, byte-identical… }
```

Guard rationale (each conjunct load-bearing):

- `askPending` — the board's one pending-ask definition, `isAskPending` (factory-comment-resume.js). The approval gate's ask opens with `[ASK] Approval required …` (same literal prefix, verified in the example trail), so one predicate covers both the ask protocol and the risk gate.
- `isStallCode(code)` — flood is stall-family ONLY (`stalled (exit 0 with no verdict)` from `exitCodeStr(0)`, `stalled (orphan, silent <n> min)` from the sweep). **True failures keep posting byte-for-byte even under a pending ask**: a non-zero exit / signal / `spawn-failed` is new information the `[ASK]` cannot carry, and D1/D4 already document "non-zero codes/sig/'spawn-failed' keep posting their crash comments byte-for-byte". This preserves that invariant verbatim.
- `!degraded` — board-state uncertainty deserves the record (existing contract sentence stays); comment-fetch failure ⇒ `askPending` false ⇒ posts anyway, and the rare readable-comments/unreadable-card case posts.
- `!restartStopped` — self-deploy SIGTERM stops post `[DAEMON-RESTART]`, a different contract class (invisible to the crash cap, own consecutive-storm guard, expected stop per card 6af1fa46fecb634350948a5d); out of this card's scope, stays byte-identical.

Deliberately unchanged semantics (the boring design — decision logic untouched):

- `decideCrashRecovery` untouched: the park cap still out-ranks askPending. Under suppression the comment-derived cap **freezes** while the human is owed (a stall during someone else's wait must not burn the pipeline's crash retries — WDS2FExH burned crash 3 purely for waiting), a card already at the cap keeps silently parking (idempotent `addLabelToCard`), and a true crash during a wait still counts and still reports. No runaway loop: `hold`/`park` spawn nothing, so silence cannot storm; the ask protocol's own timeout (1 h → exit 1 → needs-human per contract) owns escalation.
- `crashCommentText` untouched: the hold+`ask-pending` shape stays reachable and byte-identical for true-crash codes (hold + `code=1` + askPending still posts exactly that text); park wording unchanged.
- `handleRunCrash`'s move/spawn/label side effects and the mode-logging (incl. the ask-pending hold's `pending [ASK] owns the reply — card left waiting` log) unchanged.
- `factory-comment-resume.js`, `factory-ask.js`, `factory-stall-sweep.js`, `factory-context.js`, `factory-metrics.js` zero code change. Metrics `crashes` counts posted `[DAEMON-CRASH]` comments, so human-wait stalls stop being counted as crashes — more accurate, not a regression to fix.

## docs/factory.md (board contract) — "Auto-start daemon"

1. Stall-recovery paragraph (the D1/6aebab9a65613358f4ca333a one): the closing sentence "A pending `[ASK]` always decides `hold` (zero move, zero spawn) with a visible `[DAEMON-CRASH] … a pending [ASK] owns the reply — left waiting on the human` comment: 'waiting on you' becomes board-visible …" is rewritten — the decision is unchanged (`hold`, and at the cap `park` + `needs-human`, both zero move/spawn) but stall-family recovery posts **no** `[DAEMON-CRASH]` while an ask is pending: the pending `[ASK]` comment IS the board-visible "waiting on you"; non-zero crashes / `spawn-failed` still post byte-for-byte even under a pending ask; `[DAEMON-RESTART]` stops and degraded holds still post.
2. The crash paragraph's opening "post a `[DAEMON-CRASH]` comment, then recover by the card's own log" gets the one-clause exception pointing at the same rule (stall-family + pending ask ⇒ silent).

## Tests

`tests/factoryDaemon.test.js` (jest — the suite runs under `npm test`'s jest half):

1. Rewrite the D2 ask-hold test (`~:1011`, "holds the card waiting on its human — with a board-visible comment"): same trigger (`STALL_EXIT_CODE`, pending `[ASK]` + verdict, VERIFY list); now expects `commentsWritten` length **0**, moves `[]`, spawned `[]`, `labelAdded` `[]`, and the local log line containing `pending [ASK] owns the reply`.
2. Rewrite the D2 cap test (`~:1038`, "at the crash cap the ask-pending card still parks (the cap out-ranks the hold)"): still parks — `labelAdded` `[[card.id, NEEDS_HUMAN.id]]` — but `commentsWritten` length **0**, zero moves/spawns. Rename to "still parks — silently; the crash comment is suppressed while the [ASK] owns the trail".
3. New: non-zero crash (`code: 1`) + pending `[ASK]` + in-flight list → exactly 1 comment containing `a pending [ASK] owns the reply` (proves the ask-pending hold shape stays byte-for-byte for true failures).
4. New: `'spawn-failed'` + pending `[ASK]` → posts (non-stall family never suppressed).
5. New: sweep orphan code `stalled (orphan, silent 195 min)` + pending `[ASK]` + at-cap comments → silent park: label applied, zero comments (the sweep-race mirror of the example comment).
6. New: `restartStopped` (run log ends with `[Stopped by SIGTERM]`) + pending `[ASK]` → posts `[DAEMON-RESTART]` (the excluded class).
7. New: degraded hold with readable comments (pending `[ASK]`) but throwing `getCard` + stall code → still posts (degraded deserves the record).
8. Unchanged guards that must stay green: D4 silent-done test, D4 non-zero-on-Done byte-for-byte test, and "the healthy-exit silence NEVER leaks into sweep codes deciding resume (stall family posts)" — suppression must never touch `resume`/`requeue` (they only decide when `askPending` is false, since askPending short-circuits to hold/park).

`tests/factoryCommentResume.test.js` (node:test half): tests 38 (decideCrashRecovery park-beats-askPending) and 40 (`crashCommentText` ask-pending shape) stay byte-for-byte — they are the proof the pure decision/renderer surfaces were not touched. `tests/factoryStallSweep.test.js` unchanged.

## Verification

- `npx jest tests/factoryDaemon.test.js` — targeted suite green (tests 1–8 above).
- `node --test tests/factoryCommentResume.test.js tests/factoryStallSweep.test.js` — pure-lib contracts unchanged and green.
- `npm test` full (jest half + `node --test` half, per package.json) — zero regressions.
- Example replay, asserted in test 2's shape: comments as of 2026-11-09T15:57:16Z (pending `[ASK]` at 15:56:02Z, two `[DAEMON-CRASH]`, verdicts, QA list) + `STALL_EXIT_CODE` ⇒ zero comments written, `needs-human` applied, zero moves/spawns ⇒ the offending comment could not have posted.
- Single-poster audit: `grep -n "crashCommentText" scripts/` shows exactly one `addComment` consumer (`handleRunCrash`), guarded by the predicate.

## Non-goals

Stall classification (D1), the comment-derived crash cap and park-first ordering, needs-human escalation, resume/move behavior, the ask protocol itself, `[DAEMON-RESTART]` semantics, and context/metrics curation all stay exactly as specced.
