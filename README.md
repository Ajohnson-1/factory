# Factory

A software factory managed via **Discord** + **Trello**, powered by **pi** coding agents.

Move a Trello card to **Ready** → a pi agent builds it in a git worktree → PR opens →
card moves to **Review** → merge → card moves to **Done**. Discord gets progress embeds
and slash commands throughout.

See [plan/PLAN.md](plan/PLAN.md) for the full design.

## Setup (local dev)

```bash
npm install
cp .env.example .env   # fill in all values
npm run dev
```

### Trello

1. Create an API key + token at https://trello.com/app-key
2. In the board, create lists: **Ready**, **Review**, **Done**
3. Note the board ID and list IDs (visible in the URL when you open them)
4. For each card you want the factory to pick up, add a webhook pointing at
   `https://<your-vps>/webhook/trello` (card menu → Webhooks), or call
   `trello.createWebhook(cardId, url)` from code

### Discord

1. Create an app + bot at https://discord.com/developers/applications
2. Invite the bot with `applications.commands` scope
3. Set `DISCORD_CHANNEL_ID` to the channel where factory updates should post

### GitHub

1. Fine-grained token with Contents (read/write) + Pull requests (read/write) on the target repo
2. `REPO_PATH` = local clone of the target repo on the VPS
3. Webhook: repo → Settings → Webhooks → Add webhook
   - Payload URL: `https://<your-vps>/webhook/github`
   - Secret: any random string → put it in `GITHUB_WEBHOOK_SECRET`
   - Events: select "Pull requests" only
   - On merge of a `factory/<card-id>` branch: job → done, card → Done, Discord embed

## VPS deployment

### Proxmox LXC (recommended)

Run inside a fresh Debian 12 container as root:

```bash
FACTORY_REPO=https://github.com/<you>/factory.git \
DOMAIN=factory.example.com \
VLLM_HOST=192.168.1.50 VLLM_PORT=8000 \
bash deploy/setup-factory.sh
```

Creates user `pi` (no sudo, 700 home), installs Node 22 + caddy + nftables,
builds the factory in `/home/pi/factory`, and applies:
- **Folder confinement** — systemd sandbox (`ProtectHome` + `ReadWritePaths=/home/pi`):
  the service can only write its own folder
- **Network security** — nftables egress filter for uid `pi`: DNS + HTTPS to an
  allowlist (Trello/Discord/GitHub/npm) + your vLLM host; everything else
  dropped + logged. Allowlist refreshes daily via cron (`factory-net-apply`).

### Manual (any VPS)

```bash
# on the VPS
git clone <this-repo> /opt/factory && cd /opt/factory
npm install --omit=dev
npm run build
cp .env.example .env && vim .env
```

systemd unit (`/etc/systemd/system/factory.service`):

```ini
[Unit]
Description=Factory orchestrator
After=network.target

[Service]
WorkingDirectory=/opt/factory
ExecStart=/usr/bin/node dist/index.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Caddyfile (Trello webhooks need public HTTPS):

```
factory.example.com {
    reverse_proxy localhost:8787
}
```

## Tests

```bash
npm test              # vitest run — hermetic unit tests
npm run test:watch
npm run test:coverage # + v8 coverage, fails under the per-area thresholds
npm run typecheck     # tsc over src + scripts + test
```

Tests live in `test/`, mirroring `src/`. They are hermetic: temp dirs for SQLite and
git fixtures, `vi.stubEnv` for env, mocked module boundaries (`@octokit/rest`,
`discord.js`, the pi SDK, `fetch`). Nothing touches `./data/`, the target repo, your
`.env` or the network, and no real Trello/GitHub/Discord credentials are needed.

Real seams, not mocks, cover the internals: `createStore(dbPath)`,
`runCard(cardId, bot, deps)`, `createWorktree(cardId, repoPath)`,
`handleGitHubWebhook(req, res, bot, deps)` and `createWebhookServer(bot, deps)`.

TypeScript config: `npm run build` compiles `src/` only (that is what `dist/` ships);
`npm run typecheck` uses `tsconfig.test.json`, which adds `test/` and `scripts/`.
CI (`.github/workflows/ci.yml`) runs build → typecheck → test on every push and PR.

### Integration smoke (opt-in, real model)

`npm run test:integration` runs `scripts/dry-run.ts`: a throwaway local repo plus a
mock card, through the full agent loop. It calls a real LLM, so it is never part of
`npm test` or CI. Override the scratch repo with `REPO_PATH=<tmp-repo>`.

## Discord commands

- `/factory status` — list all jobs
- `/factory pause` — stop accepting new cards
- `/factory resume` — resume

## Notes / MVP limitations

- One agent at a time (single-slot worker)
- CI gate: after the PR opens, the worker polls GitHub statuses every 30s
  (up to `CI_TIMEOUT_MS`, default 15 min). Pass → card to Review. Fail/timeout →
  job failed, card stays in Ready (move it out and back to re-trigger).
  A branch with no statuses at all reports `pending`, so repos without CI run the
  full timeout and fail — open item, see plan/2.0-testing.md.
- Progress embeds fire per tool call; throttle in `runner.ts` if it gets noisy
