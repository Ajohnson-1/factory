# Factory — Plan

A software factory managed via Discord + Trello. Trello cards drive AI coding
agents (pi); Discord is the command center.

## Decisions (confirmed)

- **Factory mode:** AI coding agents build from Trello cards
- **Agent:** pi (SDK: `createAgentSession`, `session.prompt`, event streaming, `defineTool`)
- **Code host:** GitHub (repos, PRs, CI via GitHub Actions)
- **Orchestrator host:** server/VPS (Node 22 + pi, systemd, Caddy for HTTPS)
- **Discord↔Trello bridge:** built into the orchestrator (webhooks + discord.js)

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
