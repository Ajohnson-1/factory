# Factory — Plan

A software factory managed via Discord + Trello. Trello cards drive AI coding
agents (pi); Discord is the command center.

## Decisions (confirmed)

- **Factory mode:** AI coding agents build from Trello cards
- **Agent:** pi (SDK: `createAgentSession`, `session.prompt`, event streaming, `defineTool`)
- **Code host:** GitHub (repos, PRs, CI via GitHub Actions)
- **Orchestrator host:** server/VPS (Node 22 + pi, systemd, Caddy for HTTPS)
- **Discord↔Trello bridge:** built into the orchestrator (webhooks + discord.js)

## Phase plans (2.x)

- [2.0 — Test suite for the MVP](2.0-testing.md) — Vitest, testability refactors,
  per-module unit tests, CI gate. Do first; later phases build on its seams.
- [2.1 — Secret isolation](2.1-secret-isolation.md) — agents run in ephemeral Docker
  containers (worktree + LLM key only); `.env` never reachable.
- [2.2 — Agent graphs](2.2-agent-graph.md) — orchestrator agent with `spawn_agent`
  tool fans out spec-writer / researcher / coder / verifier in parallel worktrees.
- [2.3 — PR reviewer](2.3-pr-reviewer.md) — reviewer agent pulls down factory PRs on
  create/update and posts PR comments (summary + line comments).

Order: 2.0 → 2.1 → 2.2 → 2.3 (each reuses the previous phase's seams).

## Decisions (2.x, confirmed)

- **Test framework:** Vitest (ESM/TS, vi.mock, coverage); tests in `test/` mirroring `src/`
- **Secret boundary:** container isolation — one Docker container per agent session
  (pi CLI `--mode json`); push/PR stay on the host with real tokens
- **Agent graph:** dynamic — orchestrator agent decides roles at runtime via a
  `spawn_agent` custom tool; parallel children in detached worktrees merged back into
  the card branch

## Architecture

```
factory/
�── src/
│   ├── index.ts          # boots: webhook server + Discord bot + worker
│   ├── config.ts         # env-based config
│   ├── trello/
│   │   ├── client.ts     # Trello REST API (cards, lists, comments)
│   │   └── webhook.ts    # receives card:action:move events
│   ├── discord/
│   │   ├── bot.ts        # discord.js: slash commands + progress embeds
│   │   └── embeds.ts
│   ├── github/
│   │   └── client.ts     # Octokit: branches, PRs, CI status
│   ├── worker/
│   │   ├── queue.ts      # job queue (SQLite-backed, survives restarts)
│   │   ├── worktree.ts   # git worktree per card: factory/<card-id>
│   │   └── runner.ts     # pi SDK: createAgentSession per card
│   └── state/store.ts    # card ↔ job ↔ PR mapping
├── .env.example
�── README.md
```

## The loop

1. Card moves to **Ready** → Trello webhook hits the VPS
2. Worker creates git worktree + branch `factory/<card-id>`
3. Spawns pi agent session (cwd = worktree, prompt = card title + description + repo AGENTS.md)
4. Agent codes, tests, commits — events stream to Discord as progress embeds
5. Worker pushes, opens PR, waits for CI
6. Card → **Review**; Discord gets "✅ PR ready" with link
7. PR merges (GitHub webhook) → card → **Done**
8. Discord commands: `/factory status`, `/factory retry`, `/factory pause`

## Testing

- Vitest; `npm test` (unit, hermetic — no network, temp dirs, mocked SDKs),
  `npm run test:integration` (opt-in, real LLM).
- Testability seams: `createStore(dbPath)` factory, `runCard(deps)`, git helpers via
  `execFileSync`. See [2.0](2.0-testing.md) for the policy.

## MVP scope

- One target repo, one agent at a time
- pi with default model
- GitHub Actions as CI gate
- SQLite for job state (survives restarts)

## VPS deployment

- Node 22 + pi installed
- systemd service for the orchestrator
- Caddy reverse proxy (Trello webhooks need public HTTPS)
- Env vars: TRELLO_API_KEY, TRELLO_TOKEN, DISCORD_BOT_TOKEN, GITHUB_TOKEN,
  TRELLO_BOARD_ID, READY_LIST_ID, REVIEW_LIST_ID, DONE_LIST_ID, REPO_PATH

## Existing tools considered (not used)

- Taco Bot, Trello Discord Power-Ups, Team Toolbox — bridge only, no factory
- addyosmani/factory, kapso, fluent, miniforge, tasktrooper, forgeo — agent
  factories without the Discord+Trello control plane
