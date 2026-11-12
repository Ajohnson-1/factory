# Plan — 6af464c16dcf4c57881fc2ae "Change the approved line delta to >=1500"

Card requirements (verbatim intent): change the approved line delta — the
blast-radius churn trigger of the risk-tiered approval gate — from 500 to
`>= 1500` total churned lines (`additions + deletions`).

All file:line cites are against `origin/master` 8af5f82 (this branch's base).

---

## 1. Design

Single value change: `HIGH_CHURN_LINES` 500 → 1500 in
`scripts/lib/factory-risk.js:45` — the exported tunable that makes a diff
`high` (blast radius) and therefore forces human approval (`[ASK]` + sha-keyed
approve) before merge+Deploy. Everything else is mandatory sync of the
literal copies of the old number:

- Diffs churning 500–1499 lines (with ≤ 24 files, no always-human path) move
  from `high` → `medium`: auto-passable by the gate once the other stages
  clear. That widening of the auto-pass band IS the card.
- Unchanged: the always-human paths (`scripts/deploy.js`, `config/`, `.env*`,
  CI/Docker, …), the file-count trigger `≥ 25` (`HIGH_FILE_COUNT`), and the
  `low`/`medium` rules (docs-only / additive-only / empty; mixed-edit default).
- `HIGH_CHURN_LINES` is exported "so tests/tuners never hardcode"; the header
  comment (`scripts/lib/factory-risk.js:7`) and the `classifyDiff` JSDoc
  (`:95`) cite the symbol, not the number — nothing to sync there. The
  reason string (`:121`) interpolates the constant — self-syncing.

## 2. Mandatory syncs (literal copies of `500`/`≥ 500` on master)

| File | Site | Change |
|------|------|--------|
| `scripts/lib/factory-risk.js` | `:45` | `HIGH_CHURN_LINES = 500` → `1500` |
| `docs/factory.md` | `:920` | risk-tier table row: total churn `additions + deletions ≥ 500` → `≥ 1500` |
| `docs/factory-prompts/reviewer.md` | `:60` | manual-fallback rule `churn ≥ 500` → `churn ≥ 1500` |
| `tests/factoryStagePrompts.test.js` | `:225`, `:241` | both `expect(doc).toContain('500')` doc pins → `toContain('1500')` — the old `'500'` substring-matches inside "1500" and would hide a stale doc; `'1500'` closes that hole |
| `tests/factoryStagePrompts.test.js` | `:256` | classifier-vs-doc parity sample `['churn ≥ 500', …additions 300 + deletions 220…, 'high']` expects `high`: 520 total churn falls below the new threshold → sample becomes 1000 + 520 = 1520 ≥ 1500 (still `high`); label follows the doc wording `churn ≥ 1500` |
| `tests/factoryRisk.test.js` | `:129` | test title `churn ≥ 500 lines → high` → `≥ 1500` (cosmetic; body is `HIGH_CHURN_LINES`-derived, self-syncing) |
| `tests/factoryRisk.test.js` | `:146-152` | edge case `churn 499 … → medium`: the hardcoded `additions: 452` (+1 + 23×2 = churn 499 = `HIGH_CHURN_LINES - 1`) breaks the invariant assert at the new constant → `additions: 1452` (churn 1499 = `HIGH_CHURN_LINES - 1`, still `medium`); title `499` → `1499` |

5 files, digit/label-only hunks. No other churn-threshold literals exist
(audit: `grep` for `500`/`HIGH_CHURN_LINES` across `docs/`, `tests/`,
`scripts/` — the remaining hits are HTTP-500 fixtures, timers (`5000`,
`restartMs: 500`, `-n 500`) and other tunables, unrelated to churn).

## 3. Test / verification strategy

- `node --test tests/factoryRisk.test.js` — the churn cases: `churn ≥ 1500 →
  high` and the `churn 1499 … → medium (edge)` assert directly on the new
  constant via `HIGH_CHURN_LINES`/`HIGH_CHURN_LINES - 1`.
- `node --test tests/factoryStagePrompts.test.js` — reviewer.md `'1500'`/`'25'`
  doc pins + classifier-vs-doc-sample parity (suite imports
  `scripts/lib/factory-risk.js` and re-classifies the doc samples).
- `npm test` — full suite, no collateral drift (the suites that hardcode other
  `500`s — HTTP statuses, timers — are untouched).

## 4. Risks

- Operational, not code: the auto-pass band widens by 1000 lines — a
  500–1499-churn diff across ≤ 24 files with deletions now merges+deploys
  without human approval. Always-human paths and the ≥ 25-file trigger still
  force a human.
- `docs/factory.md:920` has no test pin (only reviewer.md is pinned); drift
  there is reviewer-diligence territory — the sync is done here anyway.
