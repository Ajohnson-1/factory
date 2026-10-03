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
4. Register one **board-level** webhook against the public route the factory
   serves. Do it with the script, not from the Trello UI — there is no webhook UI
   ("webhooks are only accessible through the API currently"), and not per card:
   `updateCard` fires for a webhook on the board, so a single registration covers
   every card anyone drags into Ready, now and later.

   ```bash
   # the factory must already be running and reachable: Trello HEADs the
   # callback URL and creates nothing unless that answers 200
   TRELLO_WEBHOOK_URL=https://<your-vps>/webhook/trello \
     npm run register:trello-webhooks            # add --dry-run to just look
   ```

   Deliveries are authenticated with `TRELLO_APP_SECRET` — Trello signs each one
   into `X-Trello-Webhook` (HMAC-SHA1 over the body plus the callback URL, keyed
   with the app secret from https://trello.com/apps/admin) and cannot set custom
   headers, so there is nothing else to check. The factory refuses every delivery
   while that secret or `TRELLO_WEBHOOK_URL` is unset.

   A delivery only says a card changed; the factory then asks Trello where the
   card *is* (`GET /1/cards/{id}`) and enqueues it only if that is Ready. The
   payload's own list fields are deliberately not trusted — they are not
   documented tightly enough for a trigger to depend on. Set
   `TRELLO_WEBHOOK_DEBUG_FILE` to record raw deliveries if you need to see one.

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
| credentials | `TRELLO_*` (including `TRELLO_APP_SECRET`), `GITHUB_TOKEN`, `DISCORD_BOT_TOKEN`, `GITHUB_WEBHOOK_SECRET` | `PATH`, `HOME`, and only the provider API keys that are set — allowlisted in [src/agent/env.ts](src/agent/env.ts) |
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

### Agent graphs (phase 2.2)

By default a card is not run by one agent. It is run by an **orchestrator**: a
read-only pi session whose only way to change anything is a `spawn_agent` tool.
It plans the card, asks the host for children — `spec-writer`, `researcher`,
`coder`, `verifier` — and each child gets its own container in its own worktree.
Independent tasks run at once; the host commits each child's work and merges it
back **one at a time**, because two concurrent merges into one worktree can leave
a half-merged tree. A child that clashes comes back named, with the conflicting
files, so the orchestrator re-spawns that task with the conflict in its context.

Everything with authority — starting containers, git, pushing — stays on the
host. The orchestrator container holds no credentials, and the channel it calls
home on is gated by a token minted for one run and revoked when that run ends.

**One card at a time.** The worker gate is global (`store.isRunning()`), so a
hung orchestrator delays every other card. Its wall clock is therefore capped:
`AGENT_TIMEOUT_MS × (MAX_AGENT_RUNS + 1)` — 260 minutes at the defaults — cut off
at `ORCHESTRATOR_TIMEOUT_MS` (45 minutes), never below a single child timeout.

**Reaching the host is two settings, and `setup-factory.sh` makes both for you.**
On a Linux host, a container that dials `host.docker.internal` needs the name to
*resolve* and the host to be *listening where the name points*:

- Docker Engine does not define `host.docker.internal` at all — that is a Docker
  Desktop convenience. `FACTORY_IPC_ADD_HOST=host.docker.internal:host-gateway`
  adds it, and `src/agent/container.ts` passes it as `--add-host` on every run.
- `host-gateway` arrives at the docker bridge, not the host's loopback, so the
  default `FACTORY_IPC_BIND=127.0.0.1` is unreachable even once the name resolves.

Get either one wrong and every `spawn_agent` (and every `post_review`) fails, with
the container's own error naming `FACTORY_IPC_BIND`. The installer writes both
lines into `/etc/factory/factory.env` on Linux (`deploy/configure-env.sh`) and
leaves them alone on Docker Desktop, where the defaults are the working
arrangement. If you took the Manual path below, set them yourself. The widened
port can start containers and post to GitHub, so keep it off any public interface
at the firewall — the per-run token is what gates it, not the address.

| Knob | Default | What it decides |
| --- | --- | --- |
| `AGENT_GRAPH` | `1` | `0` runs the MVP's one-agent-per-card path instead |
| `MAX_PARALLEL_AGENTS` | `4` | child containers at once per card; the rest queue |
| `AGENT_TIMEOUT_MS` | `1200000` | wall clock per child; on expiry the container is killed |
| `ORCHESTRATOR_TIMEOUT_MS` | `2700000` | ceiling on the planner's wall clock |
| `MAX_AGENT_RUNS` | `12` | child runs per card, **per attempt** — see below |
| `AGENT_MODEL` / `ORCHESTRATOR_MODEL` | pi's default | model per child / for the long-lived planner |
| `AGENT_MEMORY` / `AGENT_CPUS` | `2g` / `1` | caps on **each** container |
| `FACTORY_IPC_BIND` / `_PORT` | `127.0.0.1` / `0` | where the host listens for container requests |
| `FACTORY_IPC_ADD_HOST` | unset | `--add-host` spec; required on Linux, see below |
| `FACTORY_IPC_SLACK_MS` | `60000` | how much longer the in-container tool waits than the host |
| `FACTORY_AGENT_MODELS_FILE` / `_SETTINGS_FILE` | unset | mount a `models.json` / `settings.json` into agent containers |
| `REVIEW_MAX_COMMENTS` | `20` | line comments one review may post |
| `REVIEW_MAX_RUNS_PER_CARD` | `5` | distinct PR heads a card may ever have reviewed |
| `REVIEWER_MODEL` | `AGENT_MODEL` | model for reviews — usually the cheap one |
| `REVIEW_TIMEOUT_MS` | `AGENT_TIMEOUT_MS` | wall clock for one review container |

`MAX_AGENT_RUNS` is counted per **attempt**, and an attempt is one trip through
the queue: a re-drag to Ready, or `/factory retry`, re-queues the card at
`generation + 1` with a fresh budget. A card that spent 12 runs failing yesterday
is entitled to 12 today — which is the only reason a failed card is recoverable
without deleting the database.

Cost is recorded, not just counted: every run's `usage` lands in `agent_runs`
(`usage_in`, `usage_out`, `usage_cache_read`) and `/factory status` prints a
per-card total. Rows left `running` by a process that died mid-card are swept at
boot and marked `reaped`, so the status view cannot lie about what is in flight.

### The PR reviewer (phase 2.3)

A `pull_request` webhook with action `opened` or `synchronized` on a
`factory/<card>` branch starts a review:

```
webhook → claim (pr_number, head_sha) in the store   ← refuses a redelivery
        → detached `git worktree` at exactly that commit
        → reviewer container: read / grep / find / ls / bash + post_review
        → each finding posted by the host, as it is made
        → worktree removed, review row closed out
```

What it checks, in the order its charter gives them: correctness (including
boundaries and error paths), then missing tests for new behaviour, then clarity. A
review with no findings is a valid review, and it says so. It cannot edit, commit,
approve, request changes, or merge.

Three things about the shape are worth knowing before you change it:

- **The reviewer never holds `GITHUB_TOKEN`.** It calls a `post_review` tool that
  goes over the same IPC channel the orchestrator's `spawn_agent` uses, and the
  host posts. It also *validates* before posting: a comment on a file outside the
  diff, or on a line past the end of the file's new version, is refused with the
  reason, because GitHub's API would otherwise accept it and leave it pointing at
  nothing in a bot's name.
- **It posts as it works, so a review is never lost.** A reviewer that runs out of
  time has already put its earlier findings on the PR. If it used no tool at all,
  its final text is posted as the summary instead.
- **Reviews live in `reviews`, not `agent_runs`.** A push is not a graph child, and
  counting reviews against `MAX_AGENT_RUNS` would let a noisy branch starve a card
  of the budget it needs to do its work. `REVIEW_MAX_RUNS_PER_CARD` is the
  reviewer's own limit, and its spend is a separate line in `/factory status`.

De-duplication is on `(pr_number, head_sha)`: a redelivered `opened` for a head
that is running or already reviewed is refused before a container starts, and a
new push is a new head and gets a fresh review. Draft PRs are not reviewed —
`opened` fires for those too, and a draft is an author saying the diff is not
finished. Nothing here is triggered by a card reaching `review` in Trello; the
GitHub event is the only trigger.

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

Caddyfile (Trello webhooks need public HTTPS — Trello also HEADs this URL before
it will register a webhook, so the route has to answer 200 on `HEAD
/webhook/trello`):

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

- `/factory status` — list all jobs, their in-flight children, and each card's
  token spend
- `/factory pause` — stop accepting new cards
- `/factory retry card:<id>` — re-queue a card that finished (failed, review or
  done) with a fresh run budget; refuses one that is still running
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
