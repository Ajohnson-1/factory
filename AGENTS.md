# AGENTS.md — the factory repo

Trello cards drive headless coding agents. This repo holds the factory itself:
the board dispatcher daemon, the board CLI, the deploy runners, and the repo
registry. It was extracted from discord-bot (FM-1, card 4e7nwL3J); the design
and migration state live in [docs/factory-migration.md](docs/factory-migration.md).

## Board contract

The full board-is-the-state contract (stages, tags, watermarks, ask protocol,
risk gate) is [docs/factory.md](docs/factory.md). Stage prompts:
[docs/factory-prompts/](docs/factory-prompts/). Factory work flows on the
factory board `LLNG5MAm` (FM-3 flipped the registry); product cards keep
flowing on `ZHkVYBN1` until the FM-6 cutover.

## Repo registry

`config/factory-repos.json` maps repo ↔ board ↔ worktree ↔ deploy driver;
machine-local override via `FACTORY_REPOS_FILE`. FM-2 landed the routing:
`repoForCard` (`repo:<name>` card label beats the board default;
unknown/ambiguous → fail-closed `[ASK]`, never a guess), `detectRepo`
(`--repo` flag → cwd worktree/checkout match → `defaultRepo`), the daemon
polls every registered board (per-board lists + pollers, one global cap),
and the run/resume prompts carry a REPO CONTEXT block with the exact
worktree/bootstrap/deploy lines. The `factory` entry carries `LLNG5MAm`
since FM-3; `discord-bot` stays on `ZHkVYBN1` until FM-6.

## Runtime rule

The daemon runs from **exactly one repo checkout at a time** — until the FM-6
cutover that is discord-bot's copy. See docs/factory-migration.md §7.

## Dev loop

```bash
npm install          # devDep: jest
cp .env.example .env # TRELLO_KEY/TRELLO_TOKEN required for CLI
npm test             # jest (daemon + stage prompts) + node --test (the rest)
node scripts/factory.js status
```
