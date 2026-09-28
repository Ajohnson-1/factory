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
chmod 600 .env         # it holds every credential the agents must not see
npm run dev
```

Without Docker locally, `AGENT_RUNTIME=process` runs the agent in-process — the
old behaviour, with none of the isolation (see [Secret isolation](#secret-isolation)).

On a server, keep the env file out of the repo tree entirely (dotenv reads the
cwd's `.env`, which is one `git add -A` away from being published): systemd
loads it with `EnvironmentFile=/etc/factory/factory.env`, mode 600, root-owned,
so the service user cannot even open it.

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

## Secret isolation

Agents run arbitrary commands, so the boundary is a container: each agent
session is one throwaway `docker run`, and the orchestrator keeps every
credential.

| | orchestrator (host) | agent container |
|---|---|---|
| credentials | `TRELLO_*`, `GITHUB_TOKEN`, `DISCORD_BOT_TOKEN`, `WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET` | `PATH`, `HOME`, and only the provider API keys that are set — allowlisted in [src/agent/env.ts](src/agent/env.ts) |
| filesystem | the whole disk | the card's worktree at `/work` (rw) + the repo's shared `.git` (ro) |
| git | commit, push, open the PR | `log`/`diff`/`status`; cannot commit, push or rewrite refs |

Flow: `worktree → docker run pi --mode json → host commit → host push → PR → CI`.
pi's JSONL events on stdout are mapped onto the same Discord progress embeds the
in-process runtime used to produce.

**Why `.git` is mounted at all.** A `git worktree` directory is not a repository:
its `.git` is a one-line file pointing into the main clone. Mount only the
worktree and `git status` inside the container reports "not a git repository".
So the shared `.git` comes along too — read-only, at its own absolute path,
which leaves the worktree writable and the history immutable.

**Two requirements this puts on the operator**

- **A provider API key in the env.** pi reads `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`,
  `MISTRAL_API_KEY`. OAuth logins are *not* copied in: `~/.pi/agent` is never
  mounted, because that directory also holds your own credentials. With no key
  pi exits with "No API key found for the selected model" and the job fails.
- **No token in the git remote URL.** `remote.origin.url` is readable inside the
  container, so use an ssh remote or a credential helper. The factory scans the
  mounted git config before spawning and refuses to start a container whose
  config embeds credentials (`https://user:ghp_…@…`) or sets an auth header.

**What is not isolated**

- **Network egress.** An agent can reach anything the host can — it needs npm and
  the model API while working. The deploy script's nftables filter is keyed on
  the orchestrator's uid and does not cover *forwarded* container traffic.
  Follow-up: an egress proxy that allows only the provider and registries.
- **Files the repo tracks.** A `.env` that is committed to the target repo ships
  with it. This phase protects the orchestrator's secrets; anything already in
  git history is the repo's own problem (and `git worktree add` deliberately does
  not carry untracked files — guarded by `test/worker/no-env.test.ts`).
- **Shared kernel.** Containers share the host kernel. `--cap-drop=ALL`,
  `no-new-privileges`, `--init` and a non-root user narrow the surface; they do
  not replace a VM.

**Dev escape hatch.** `AGENT_RUNTIME=process` runs pi inside the orchestrator with
no boundary at all: the agent inherits every secret in the env and can read any
file the factory user can. For a laptop with a throwaway repo only.

**Image.** `bash deploy/docker/build.sh` builds `factory-agent`, pinned to the pi
version in `package-lock.json`; CI builds it on every push and the deploy script
rebuilds it on every deploy.

**Proof.** `TEST_DOCKER=1 npx vitest run test/integration` runs the canary: a host
`.env` full of sentinel values next to the worktree, then asks the container —
and then pi itself, if a provider key is set — to print it.

## VPS deployment

### Proxmox LXC (recommended)

Run inside a fresh Debian 12 container as root:

```bash
FACTORY_REPO=https://github.com/<you>/factory.git \
DOMAIN=factory.example.com \
VLLM_HOST=192.168.1.50 VLLM_PORT=8000 \
bash deploy/setup-factory.sh
```

Creates user `pi` (no sudo, 700 home), installs Node 22 + Docker + caddy +
nftables, builds the factory in `/home/pi/factory`, builds the `factory-agent`
image, and applies:
- **Secret isolation** — agents run in containers; secrets live in
  `/etc/factory/factory.env` (600, root-owned) and are loaded by systemd, never
  from the repo tree
- **Folder confinement** — systemd sandbox (`ProtectSystem=strict` +
  `ReadWritePaths=/home/pi`): the service can only write its own folder
- **Network security** — nftables egress filter for uid `pi`: DNS + HTTPS to an
  allowlist (Trello/Discord/GitHub/npm/provider) + your vLLM host; everything
  else dropped + logged. Allowlist refreshes daily via cron
  (`factory-net-apply`). Agent container traffic is *not* covered by this filter
  (it is forwarded, not generated by uid `pi`) — see Secret isolation.

Docker inside an LXC needs `nesting=1`; the script stops with the Proxmox
pointer if `/run/docker.sock` never appears.

### Manual (any VPS)

```bash
# on the VPS
git clone <this-repo> /opt/factory && cd /opt/factory
npm install --omit=dev
npm run build
sudo install -d -m 700 /etc/factory
sudo install -m 600 .env.example /etc/factory/factory.env && sudo vim /etc/factory/factory.env
sudo bash deploy/docker/build.sh      # the image agents run in
sudo apt-get install -y docker.io && sudo systemctl enable --now docker
sudo usermod -aG pi docker            # the service user needs the socket
```

systemd unit (`/etc/systemd/system/factory.service`):

```ini
[Unit]
Description=Factory orchestrator
After=network.target docker.service
Requires=docker.service

[Service]
WorkingDirectory=/opt/factory
ExecStart=/usr/bin/node dist/index.js
Restart=always
EnvironmentFile=/etc/factory/factory.env
Environment=NODE_ENV=production
# agent containers are started through /run/docker.sock
SupplementaryGroups=docker

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
`discord.js`, the pi SDK, `node:child_process`, `fetch`). Nothing touches `./data/`,
the target repo, your `.env` or the network, and no real Trello/GitHub/Discord
credentials are needed — the agent container tests fake `spawn` rather than
running Docker.

Real seams, not mocks, cover the internals: `createStore(dbPath)`,
`runCard(cardId, bot, deps)`, `createWorktree(cardId, repoPath)`,
`buildDockerArgs(worktreeDir, prompt)` and
`handleGitHubWebhook(req, res, bot, deps)`.

TypeScript config: `npm run build` compiles `src/` only (that is what `dist/` ships);
`npm run typecheck` uses `tsconfig.test.json`, which adds `test/` and `scripts/`.
CI (`.github/workflows/ci.yml`) runs build → typecheck → test on every push and PR.

### Integration smoke (opt-in)

`npm run test:integration` runs `scripts/dry-run.ts`: a throwaway local repo plus a
mock card, through the full agent loop. It uses the **in-process** runtime and
calls a real LLM, so it is never part of `npm test` or CI. Override the scratch
repo with `REPO_PATH=<tmp-repo>`.

`TEST_DOCKER=1 npx vitest run test/integration` is the container canary instead:
the real `factory-agent` image, a host `.env` full of sentinels, and a prompt
asking pi to exfiltrate it. The filesystem probes need only Docker; the two
prompts also need a provider API key set.

## Discord commands

- `/factory status` — list all jobs
- `/factory pause` — stop accepting new cards
- `/factory resume` — resume

## Notes / MVP limitations

- One agent at a time (single-slot worker)
- The agent does not commit: `.git` is read-only inside its container, so
  `runCard` commits the working tree on the host and fails the job if the agent
  changed nothing
- CI gate: after the PR opens, the worker polls GitHub statuses every 30s
  (up to `CI_TIMEOUT_MS`, default 15 min). Pass → card to Review. Fail/timeout →
  job failed, card stays in Ready (move it out and back to re-trigger).
  A branch with no statuses at all reports `pending`, so repos without CI run the
  full timeout and fail — open item, see plan/2.0-testing.md.
- Progress embeds fire per tool call; throttle in `runner.ts` if it gets noisy
