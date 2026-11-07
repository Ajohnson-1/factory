# Factory stage prompts (repo-owned)

These are the **authoritative role instructions** for each LLM stage
subagent the scheduler spawns. They are repo-owned, versioned artifacts:
a prompt change is a normal code change — reviewed, committed, and (with
C-M11) re-scored like code. The spawn prompts built by
`scripts/factory-daemon.js` (`buildRunPrompt`) and
`scripts/lib/factory-comment-resume.js` (`buildResumePrompt`) seed every
stage subagent with the matching file below; the constant
`STAGE_PROMPT_FILES` in `scripts/factory-daemon.js` is the single
stage → file source of truth.

**Authority rule:** when your spawn prompt points you at one of these
files, that document is your authoritative role specification and it
**overrides your harness role defaults**. If your harness role prompt
says something different, this document wins.

## Stage → prompt file

| Stage | Subagent role | Prompt file |
| --- | --- | --- |
| Plan | planner | [planner.md](planner.md) |
| Implement | implementer | [implementer.md](implementer.md) |
| Review | reviewer | [reviewer.md](reviewer.md) |
| Security (Review sub-pass) | security-reviewer | [security-reviewer.md](security-reviewer.md) |
| Test/QA | qa | [qa.md](qa.md) |

The security checklist itself stays owned by
[docs/security-review.md](../security-review.md);
`security-reviewer.md` owns the role procedure and points at the
checklist.

## Ownership split (single sources of truth)

- [docs/factory.md](../factory.md) "Board contract" is authoritative for
  the **tag set and gate logic** — the scheduler reads gates from card
  comments; gate semantics are pipeline behavior, not stage role
  behavior.
- Each stage file here is authoritative for that stage's **role, inputs,
  verdict/comment procedure, evidence rules, and prohibitions**.
- `docs/factory.md`'s Stages table keeps one-line scheduler-facing
  summaries; the per-role detail lives in the stage files, and
  `tests/factoryStagePrompts.test.js` pins them in sync.

## Stages with no prompt file

**Deploy** and **Verify** are scheduler-run script stages
(`scripts/deploy.js`, `scripts/verify-deploy.js` posting
`[DEPLOY]`/`[VERIFY:*]`) — there is no LLM role to prompt, so they have
no stage prompt document here. The `[SEC:PASS]` **no-op** verdict for a
non-security-sensitive diff is likewise scheduler-posted, not subagent
behavior.

## Scoring hook (C-M11)

These files are the unit of prompt change for re-scoring: diffing a
prompt file identifies exactly which stage's behavior changed, so the
C-M11 scorer can re-score that stage's cards against the new prompt
version. (C-M11 itself is out of scope here — this tree only establishes
the artifacts and the spawn wiring.)
