# Security review checklist (factory Review sub-pass)

Seed checklist for the **security-reviewer subagent** the scheduler spawns
after `[REVIEW:APPROVE]`, while the card still sits in Review. Read this
**first**, then review `git diff master...factory/<card-id>` in the card's
worktree. Role: reviewer mindset, **read-only** — never edit code, never move
the card. Post **exactly one** comment:

```sh
node scripts/factory.js comment <card-id> "[SEC:PASS] …notes…"
node scripts/factory.js comment <card-id> "[SEC:FINDINGS] <itemized: file:line, why it matters, suggested fix>"
```

**Severity rule** (so `[SEC:PASS]` stays meaningful): only **HIGH/MEDIUM**
findings from this checklist may be raised as `[SEC:FINDINGS]`; LOW/INFO
observations ride inside a `[SEC:PASS]` comment. `[SEC:FINDINGS]` bounces the
card to Implement and counts toward the 3-bounce rule
(`# [REVIEW:CHANGES] + # [SEC:FINDINGS] + # [QA:FAIL] + # [VERIFY:FAIL] ≥ 3`
→ `needs-human`, park in Review). Gate + spawn rules: docs/factory.md
("Security review pass").

## Trigger: when does this run

The scheduler probes the diff footprint first — the **single source of truth
for the patterns is the code constant** `SECURITY_PATH_PATTERNS` in
`scripts/lib/factory-security-review.js`; this table describes it:

| Concern | Pattern (case-insensitive, over repo-relative paths) |
| --- | --- |
| Secrets/env/config files | `(^|/)\.env(\.|$)` · `(^|/)config(\.js|/config\.json$)` |
| Credential plumbing | `\b(trello|factory-(ask|done-ping|comment-resume))\b` within `scripts/` · `\b(secret|credential|auth|token)\b` |
| SSH/deploy paths | `deploy` · `\bssh\b` · `(^|/)(Dockerfile|docker-compose\.yml)$` |
| Inbound Discord/Trello input | `(^|/)index\.js$` · `service/(interactionAdapter|ai/(multiBotRouting|requestLog)|resilience)\.js` · `/trello\.js` |

```sh
node scripts/factory.js security-check factory/<card-id> master
# → { "securitySensitive": true, "matchedPaths": ["scripts/lib/trello.js"], "totalFiles": 4 }  (exit 0)
```

`securitySensitive: false` → the scheduler posts the no-op verdict itself
(`[SEC:PASS] no-op — diff touches no security-sensitive paths (<N> files)`);
you are **not** spawned. `true` → you run on exactly those matched files
(+ their callers) with full context.

## 1. Secrets handling

- `TRELLO_KEY`, `TRELLO_TOKEN`, `BOT_TOKEN`, `DEPLOY_KEY`,
  `FACTORY_DISCORD_WEBHOOK` values are **never logged or echoed** — check
  every added `console.*`, error message, and shell line. Failure messages
  name the *variable*, never its value.
- Resolution order **env → repo `.env` → `config/config.json`** is preserved
  (`scripts/lib/trello.js`, `config.js`, `scripts/lib/factory-ask.js`).
- No secret **values** committed (watch `config/config.json` hunks, fixtures,
  recorded HTTP responses); `.env` stays gitignored.

## 2. Inbound input from Discord/Trello is untrusted

- Message/interaction text, card names/descriptions/comments are attacker-
  influenceable: bounded length handling; **no `eval`**, no shell or SQL
  interpolation of inbound strings; URL construction encodes parameters.
- Bot-authored comments never trigger automation (tag rules — the
  comment-resume identity check is fail-closed; a diff that weakens it is a
  HIGH finding).

## 3. SSH/deploy paths

- `scripts/lib/deploy-ssh.js` keeps **structured argv** to `ssh` — no local
  shell interpolation of remote strings.
- `DEPLOY_KEY` stays an operator path (never fetched, never logged).
- Remote command strings are built from constants, **not card text**.
- `scripts/verify-deploy.js` exit-code contract (0 = up) is not weakened.

## 4. Token/credential plumbing in the ping/ask paths

- ask/done/resume pings reuse `BOT_TOKEN` without printing it; the Discord
  webhook URL comes from config, not user input; failure messages name the
  *variable*, never its value.

## 5. Cross-check with `.env.example`

- Any new required/optional env var introduced by the diff is documented in
  `.env.example` **and** docs/factory.md "Credentials" — with no real values.
