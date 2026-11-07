# Deploy Host: Provisioning, Day-2 SSH Use, and Prod Cutover

Target: a Debian 12 (bookworm) VM on the LAN that becomes the prod
`discord-bot` host. The factory agent logs in as the non-root `factory` user
with a deploy SSH key; Docker is installed from Docker's official apt repo
(`download.docker.com` — required for `docker-compose-plugin`, which Debian
12 does not ship).

## 1. One-time console paste procedure

The fresh VM gives you **root console / web-UI access only** (no SSH yet).
Everything happens in ONE paste block — the deploy pubkey is already
pre-filled inside the script (`FACTORY_SSH_PUBKEY=...` near the top of
`scripts/provision-deploy-host.sh`), so **no edits are needed**.

1. Log into the Debian 12 VM console (or web UI terminal) as **root**.
2. Paste a single block: the opening heredoc line, the **entire** contents of
   `scripts/provision-deploy-host.sh`, the closing delimiter, then run it:

   ```sh
   cat > /root/provision-deploy-host.sh <<'FACTORY_PROVISION_EOF'
   <paste the whole contents of scripts/provision-deploy-host.sh here>
   FACTORY_PROVISION_EOF
   bash /root/provision-deploy-host.sh
   ```

   The quoted delimiter `<<'FACTORY_PROVISION_EOF'` makes the body literal —
   `$`, backticks, and single quotes inside the script pass through
   untouched. (The script body contains no line equal to `FACTORY_PROVISION_EOF`,
   so the heredoc always terminates where you expect.)
3. **Expected final line:** `SELF-CHECK: 12/12 PASS`, exit status 0. The
   self-check verifies: docker daemon active, Docker CE apt repo configured
   (keyring + sources list present), compose plugin present, factory
   user exists, docker-group-only membership, password login locked,
   `authorized_keys` mode 600 / factory-owned / byte-exact key,
   `/opt/discord-bot` factory-owned, `sudo -n true` failing as factory,
   **docker logging limits in `daemon.json`** (`log-driver=json-file`,
   `log-opts.max-size=10m`, `log-opts.max-file="5"`), **`daemon.json`
   unrelated keys preserved** (the merge never clobbers human config keys),
   and **journald persistence** (`/var/log/journal` + `SystemMaxUse=2G`
   drop-in + journald active).
4. On a `FAIL <name>` line or non-zero exit: fix the cause and **re-paste the
   same block** — the script is fully idempotent (get/dpkg guards + atomic
   file replace), so re-running is always safe. Re-pastes are byte-stable:
   `daemon.json` is merged with sorted keys, and **docker restarts only when
   the merged bytes actually change** — an unchanged re-paste restarts
   nothing (a repaired/tampered `daemon.json` does restart docker once, and
   the limits self-check fails loudly until repaired). A human-edited
   `daemon.json` is merged, never clobbered; if it is not valid JSON the
   script refuses to overwrite it, prints `ERROR: … refusing to overwrite`,
   and the two `daemon.json` checks FAIL. Note: `daemon.json` log caps apply
   to containers **created after** the change — on an already-running host,
   existing containers pick them up only after a recreate:
   `cd /opt/discord-bot && docker compose up -d`.

What the script does: adds the official Docker CE apt repo (fetches
`https://download.docker.com/linux/debian/gpg`, dearmors to
`/etc/apt/keyrings/docker.gpg`, writes `/etc/apt/sources.list.d/docker.list`
with the codename from `/etc/os-release`; skipped as a no-op when both files
already exist), then `apt-get install` of
`docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`
(noninteractive; `docker-compose-plugin` does not exist in Debian 12 repos,
which is why the CE repo is required), then `systemctl enable --now docker`,
creates user `factory` with **docker as its only (primary) group**, locks the
password (`passwd -l` → `passwd -S` shows `L`), never touches sudoers (no
sudo), installs the deploy key into `/home/factory/.ssh/authorized_keys`
(atomically: tmp file + rename, mode 0600), and creates `/opt/discord-bot`
owned by `factory`. If `download.docker.com` is unreachable the script
continues past the repo/install step but the self-check prints `FAIL` lines
(repo, daemon, compose) and exits non-zero — a loud failure, never a silent
pass; re-paste once network/routing to `download.docker.com` works.
Password-based SSH login is impossible for `factory`
(locked account) even if `PasswordAuthentication yes` is set host-wide;
console/web root login is unaffected. The script does not modify sshd
configuration at all.

## 2. Day-2 agent use (SSH)

- The **private** key lives only on the laptop:
  `~/.ssh/factory_deploy_ed25519` (public half = the pre-filled line in the
  script).
- Smoke command (proves key, daemon, and app dir in one shot):

  ```sh
  ssh -i ~/.ssh/factory_deploy_ed25519 -o StrictHostKeyChecking=accept-new \
    factory@<host> 'docker compose version && ls -ld /opt/discord-bot'
  ```

- Confirm there is no sudo: `ssh -i ~/.ssh/factory_deploy_ed25519 factory@<host> 'sudo -n true'`
  must **fail** (non-zero exit). Confirm password auth is dead: as root on
  the host, `passwd -S factory` prints `L` (locked) in field 2.
- Prod working root is `/opt/discord-bot`: the compose file plus `config/`
  and `data/` live there (the compose file uses relative bind mounts
  `./config` and `./data`, so all prod state must sit under that directory).
- `scripts/deploy.js build` resolves a ref as `refs/remotes/origin/<ref>`, then
  `refs/tags/<ref>`, then the raw ref (bare-init fetch layout), so branch and
  tag deploys both work with no manual checkout.

## 3. First prod cutover runbook (never both hosts live)

**Why the order matters:** one Discord bot token = one consumer. Two live
hosts mean duplicate command handling, double memory extraction, TTT save
races, and a split `ai-metrics.jsonl`; the bind-mounted SQLite files
(`memory.db`, `ttt.db`) must never be written by two hosts at once — and an
`rsync` of a *live* SQLite file can capture a torn snapshot. So the runbook
runs: **stop old → cold-copy → start new → verify → decommission old**.
The card's shorthand ("bring up new, verify, THEN stop the old host") maps
onto permanent decommissioning *after* verification; the containers are
stopped before the copy so the **never both hosts live** invariant holds at
every instant. Placeholders: `<old-host>` = current prod box, `<new-host>` =
the freshly provisioned Debian 12 VM.

1. **Stop the old stack first** (cold copy, no torn DBs):

   ```sh
   ssh -i ~/.ssh/factory_deploy_ed25519 factory@<old-host> 'cd <repo-dir> && docker compose down'
   ```

   (If the old host has no `factory` user yet, run `docker compose down`
   there directly as its normal admin user.)

2. **Cold-copy state to the new host**:

   ```sh
   cd <repo-dir>
   rsync -e 'ssh -i ~/.ssh/factory_deploy_ed25519' -a docker-compose.yml factory@<new-host>:/opt/discord-bot/
   rsync -e 'ssh -i ~/.ssh/factory_deploy_ed25519' -a config/config.json factory@<new-host>:/opt/discord-bot/config/
   rsync -e 'ssh -i ~/.ssh/factory_deploy_ed25519' -a data/ factory@<new-host>:/opt/discord-bot/data/
   ```

   `data/` carries `memory.db*`, `ttt.db*`, `ai-metrics.jsonl`, and
   `backups/`. Callout: `config/config.json` is gitignored **and**
   `.dockerignore`d — it never travels inside the image; the copy on the
   deploy host is the live truth (Memory-DEPLOY-GUIDE §0).

3. **Start the new stack** — image tag reconciliation required: the build and
   deploy scripts push `:multibot-fix`, but `docker-compose.yml` pins
   `:latest`, so retag on the new host first:

   ```sh
   ssh -i ~/.ssh/factory_deploy_ed25519 factory@<new-host> \
     'docker pull ghcr.io/ajohnson-1/discord-bot:multibot-fix \
      && docker tag ghcr.io/ajohnson-1/discord-bot:multibot-fix ghcr.io/ajohnson-1/discord-bot:latest \
      && cd /opt/discord-bot && docker compose up -d --no-build'
   ```

   `--no-build`: the `bot` service declares `build: .`, but only the image
   and the compose file live on the host (no source tree), so compose must
   use the pulled image.

4. **Verify** before decommissioning anything:

   ```sh
   ssh -i ~/.ssh/factory_deploy_ed25519 factory@<new-host> \
     'cd /opt/discord-bot && docker compose ps'
   ```

   Expect `bot`, `speck`, `glorb` all Up; confirm the bot answers a mention
   in Discord, and that memory/metrics are flowing:

   ```sh
   ssh -i ~/.ssh/factory_deploy_ed25519 factory@<new-host> \
     'cd /opt/discord-bot && docker compose exec -T bot cat /app/data/ai-metrics.jsonl | tail -3'
   ```

5. **THEN decommission the old host permanently** (keep it stopped as the
   cold spare; never running). If any verification in step 4 fails, rollback
   order is **stop-new-first** so both stacks are never up at the same
   instant: `[new-host] cd /opt/discord-bot && docker compose down`,
   **then** `[old-host] docker compose up -d`; fix, and repeat from step 2.

## 4. Container logs and the classifier (day-2)

`scripts/deploy.js build` self-seeds the git host key into the factory user's
`~/.ssh/known_hosts` (grep-guarded `ssh-keyscan`), so fresh hosts need no
manual keyscan.

What provisioning guarantees (see §1):

- Every container gets `json-file` logs capped at `max-size 10m` × `max-file
  5` — disk use is bounded at roughly ≤ 60 MB per service (`bot`, `speck`,
  `glorb`), so a chatty service can never fill the VM's disk.
- journald persists across reboots: `/var/log/journal` exists and the drop-in
  `/etc/systemd/journald.conf.d/10-factory.conf` caps history with
  `SystemMaxUse=2G`. History therefore survives restarts:
  `journalctl -u docker --since '2 hours ago'`, `journalctl --disk-usage`.

Ship the classifier tool once (the factory user needs no sudo — it is in the
`docker` group):

```sh
scp -i ~/.ssh/factory_deploy_ed25519 scripts/deploy-host-logs.sh factory@<host>:/opt/discord-bot/
```

(`node scripts/deploy.js deploy <sha>` automates this scp — every deploy cp's the
classifier and `docker-compose.yml` from the deployed sha's tree into
`/opt/discord-bot/`, and §3's image-tag reconciliation happens via
`${BOT_IMAGE:-…}` + `--env-file .deploy-env`; the manual commands below are the
day-2 fallback.)

Daily use — one ssh round-trip returns exactly one `VERDICT=` line:

```sh
ssh -i ~/.ssh/factory_deploy_ed25519 factory@<host> 'cd /opt/discord-bot && bash deploy-host-logs.sh bot --since 10m'
```

### Exit-code contract

| exit | stdout line | meaning |
|---|---|---|
| 0 | `VERDICT=clean count=0` | no crash, no memory-degraded signature in the window |
| 1 | `VERDICT=crash count=N` | crash bucket > 0 (crash wins over memory-degraded) |
| 2 | `VERDICT=memory-degraded count=N` | degraded bucket > 0 and zero crash hits — running, but a degraded subsystem (memory/AI host) needs a look |
| 3 | — | usage error (bad service, bad `--since` value, unreadable `--input` file) |
| 4 | — | log-fetch failure (docker missing / `docker compose logs` error / garbage `--since` rejected by compose) |

A healthy fresh boot answers **0** (memory enabled + `Ready!`) or **2**
(memory disabled, or the AI host down — degraded but still serving).
**Exit 1 means investigate**:

```sh
ssh -i ~/.ssh/factory_deploy_ed25519 factory@<host> 'cd /opt/discord-bot && docker compose ps'
ssh -i ~/.ssh/factory_deploy_ed25519 factory@<host> 'cd /opt/discord-bot && docker compose logs bot --since 10m | tail -50'
ssh -i ~/.ssh/factory_deploy_ed25519 factory@<host> 'docker inspect -f "{{.State.OOMKilled}} {{.State.RestartCount}}" "$(cd /opt/discord-bot && docker compose ps -q bot)"'
```

### Signature table (real strings, grepped from the emit sites)

Every pattern below is a fixed substring of a line this codebase actually
prints (file:line of the emitting `console.*` call) — operators can trust the
verdicts. Case-sensitive unless noted. In live mode `OOMKilled=true` and
`RestartCount>0` from `docker inspect` each additionally count as one crash
hit (container state is not log text, so it cannot be a signature).

**CRASH → exit 1**

| signature | emit site |
|---|---|
| `[resilience] unhandled rejection:` | `service/resilience.js:117` |
| `[resilience] uncaught exception:` | `service/resilience.js:127` |
| `[resilience] client error event:` | `service/resilience.js:111` |
| `UnhandledPromiseRejection` | Node process dump (Node 18 default `--unhandled-rejections=throw`; `CRASH_REPORT.md`) |
| `unhandledRejection` (case-insensitive) | catch-all (process event name) |
| `unhandled promise` (case-insensitive) | catch-all (Node dump prose) |
| `OOMKilled` | `docker inspect .State.OOMKilled` + docker event text |
| `Fatal Error:` | `index.js:495` |
| `Error registering commands:` | `index.js:124` |
| `Error in valheimServer()` | `index.js:392` |
| `turnOnVpn failed` | `index.js:324` |
| `whatsMyIp failed` | `index.js:342` |
| `interaction handler error` | `index.js:691` |
| `Error:` | generic thrown-Error dump (stack lines) |

**MEMORY-DEGRADED → exit 2** (when crash count == 0)

| signature | emit site |
|---|---|
| `AI: memory disabled (aiMemoryEnabled=false)` | `index.js:197` |
| `AI: memory unavailable — ` | `index.js:201` |
| `AI: could not verify chat model at startup:` | `index.js:156,172` |
| `AI: chat model check FAILED` | `index.js:153,169` |
| `sushi verifyModelId: /models unreachable` | `service/ai/sushiClient.js:311` |
| `MEMORY: FTS5 probe failed` | `service/ai/memory/memoryManager.js:75` |
| `MEMORY: embedding dimension check failed` | `service/ai/memory/embedder.js:172` |
| `AI: memory retrieve failed, continuing without it:` | `service/ai/memory/memoryManager.js:178` |
| `AI: memory ingest failed:` | `service/ai/memory/memoryManager.js:301` |
| `AI: memory re-embed refused for` | `service/ai/memory/memoryManager.js:435` |

Precedence rule: the degraded messages interpolate `err.message`
(`service/ai/memory/memoryManager.js:88`), so a degraded line can contain
`Error:` (e.g. `AI: memory unavailable — Error: no such table: facts`).
Memory-degraded signatures are matched FIRST — such a line is degraded, never
crash. Crash count > 0 still wins over the degraded bucket overall.

**CLEAN evidence** (informational; clean = no crash AND no degraded):
`Ready!` (`index.js:229`), `Build time:` (`index.js:230`), `AI: memory ready — `
(`index.js:206`), `AI: image descriptions ready — ` (`index.js:224`),
`requestLog: conversation log for this bot -> ` (`index.js:233`).

### Streaming pipe / offline classification

`--input FILE` (or `--input -` = stdin) classifies given text WITHOUT touching
docker at all — that is also the seam `tests/deployHostLogs.test.js` uses, so
the classifier is unit-tested on any machine, no docker required:

```sh
docker compose logs speck --since 30m | bash deploy-host-logs.sh speck --input -
```

`--verbose` additionally prints `MATCH crash|memory-degraded <lineno>: <line>`
lines before the `VERDICT=` summary (leave it off for clean ssh parsing).

## 5. Embeddings gateway on the factory Mac (day-2)

Card `6aeab42bc4759702f8df2835` moved the embeddings gateway **off 145**. The
Nov-3 outage: 145 hosts BOTH the sushi agent server (:12345, every factory
agent run) and the vMLX embeddings gateway (:8080); the gateway's
`single_model_mode` swaps (embedder vs 27B chat models) under sushi memory
pressure returned a persistent `503 {"error":{"code":"model_load_failed",
"message":"Session is already running","retry_after":30}}` and rolled back
five healthy builds at the verify gate. Owner directive: run the (small)
embedding model on the local machine instead — and then a follow-up directive
(2026-11-04): **"Just use llamacpp instead of vmlx."** The factory Mac (159)
now serves the **same embedding model through llama.cpp's `llama-server`**
(OpenAI-compatible `/v1/embeddings`, endpoint shape unchanged) as a
single-model resident server, and 145 is chat-only. Same architecture and
1024-dim output as the model 145 ran; the served alias is exactly the config
model id, so consumer request bodies match byte-for-byte with before.

**What runs:** `scripts/local-embeddings.js run` ensures the GGUF is on disk
(`data/models/Qwen3-Embedding-0.6B-Q8_0.gguf` — the official
`Qwen/Qwen3-Embedding-0.6B-GGUF` Q8 of the same base model 145 served as
`mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ`; `LOCAL_EMBED_GGUF` overrides
with any GGUF path, cold start auto-downloads from HF), then spawns
`llama-server --model <gguf> --host 0.0.0.0 --port 8123 --embeddings --alias
mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ`
(`--host 0.0.0.0`: the consumers are remote — the prod container on 157 calls
this gateway over the LAN; `LOCAL_EMBED_HOST` overrides; `--embeddings`
restricts the server to the embeddings use case; `LOCAL_EMBED_BIN` overrides
the binary), waits for the endpoint,
issues ONE warm-up embed (model resident before any consumer touches it —
verify never triggers an on-demand load), then idles. launchd label
`com.ajohnson.localembeddings` (`RunAtLoad` + `KeepAlive`), logs under
`data/local-embeddings/`. Port 8123 (`LOCAL_EMBED_PORT` overrides) avoids the
8080 habit on 145.

**Install (factory Mac only)** — verified recipe, 2026-11-05 (llama.cpp;
supersedes the 2026-11-04 vmlx recipe):

```sh
brew install llama.cpp                     # llama-server on PATH via /opt/homebrew/bin
node scripts/local-embeddings.js once      # foreground smoke: spawn + warm-up + dim probe
node scripts/local-embeddings.js install   # launchd agent (RunAtLoad + KeepAlive)
node scripts/local-embeddings.js status    # launchd state + last probe
```

The launchd plist ships `/opt/homebrew/bin` on `EnvironmentVariables.PATH` so
`llama-server` resolves under launchd. (Historical: the vmlx-era recipe pinned
`vmlx==1.6.83` + `mlx-lm==0.31.3` via `uv tool install` — those pins were
load-bearing only for the vmlx engine, which the owner directive replaced; the
vmlx install itself is left in place on the Mac but no longer serves.)

**Prerequisite — the Mac stays awake.** The daemon + prod-watch already assume
it (`launchd KeepAlive`); confirm `pmset -g custom` shows sleep disabled on
AC power (e.g. `sudo pmset -c sleep 0 disksleep 0`).

**Day-2 repoint (deploy host 157)** — ordered; do NOT skip step 2. Prod truth
is `/opt/discord-bot/config/config.json` (gitignored, bind-mounted — §2 day-2
ssh):

1. **Repoint the config:** set `memoryEmbeddingHost` and `vmlxHost` to
   `http://192.168.0.159:8123/v1` (leave `sushiHost` on 145:12345 — chat is
   untouched).
2. **Embedder-identity band re-check (gate — before any restart):** the dedupe
   bands are embedder-specific — `service/ai/memory/README.md` ("Changing the
   embedding model safely") records the §8.2 measurement and states the 0.95
   `aiMemoryDedupeThreshold` cutoff "is for Qwen3-Embedding-0.6B-4bit-DWQ
   only", and `scripts/calibrateMemoryDedupe.js` exists precisely to
   re-measure them "whenever the embedding model, host, or those thresholds
   change". The llama.cpp switch changed the actual embedder (Q8_0 GGUF under
   the same alias — vectors differ numerically from the MLX 4-bit-DWQ ones
   stored in prod `memory.db`), so from the repo (its `config/config.json`
   points at 159:8123; no flags needed — the script reads the repo config):

   ```sh
   node scripts/calibrateMemoryDedupe.js
   ```

   Compare the printed summary bands against the DWQ-era baseline (highest
   unrelated 0.4049, lowest reworded 0.861, measured range 0.861–0.903 —
   README §8.2). Measured on llama.cpp Q8_0, 2026-11-05: **0.3893 / 0.8674** —
   class separation preserved (slightly wider); no threshold retune needed.
   NOTE the script exits 1 whenever a reworded pair sits below 0.95 — that is
   PRE-EXISTING DWQ-era behavior too (reworded measured 0.861–0.903 < 0.95;
   prod dedupe merge is lexical-gated, see README); read the BANDS, not just
   the exit code. **If the bands move materially** (unrelated floor approaching
   `aiMemoryNearThreshold`, or reworded pairs separating away from the
   recorded range): re-measure and re-tune `aiMemoryDedupeThreshold` /
   `aiMemoryNearThreshold` per the README procedure (derive the cutoff from
   the new separation; never carry 0.82 forward) and make the cutoff decision
   BEFORE restarting — do not bounce prod onto a new embedder with unvalidated
   bands.
3. **Prove the Mac endpoint:** `node scripts/local-embeddings.js once` green
   (200 + dim 1024).
4. **Bounce the config** (the same bounce every deploy does):

   ```sh
   ssh -i ~/.ssh/factory_deploy_ed25519 factory@192.168.0.157 \
     'cd /opt/discord-bot && docker compose restart bot speck glorb'
   ```

5. **Verify:** `node scripts/verify-deploy.js` — ai-hosts-probe must show
   `EMBED_DIM=1024` via 159.

**Failure mode (accepted):** MacBook down ⇒ prod memory degrades to
keyword-only (`AI: memory unavailable —` → classifier degraded bucket, exit 2,
not a crash) and the verify probe fails on `ECONNREFUSED` — now classified
**infra-transient**: three backoff'd re-probes (30/60/120 s) before FAIL
(verify-deploy.js header), so a reboot-shaped outage never rolls back a healthy
build; a persistent failure still fails the deploy after the budget.
