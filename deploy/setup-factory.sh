#!/usr/bin/env bash
#
# setup-factory.sh — set up the factory in a Proxmox LXC container (Debian 12).
#
# Run as root INSIDE the container:
#   FACTORY_REPO=https://github.com/<you>/factory.git DOMAIN=factory.example.com \
#   VLLM_HOST=192.168.1.50 VLLM_PORT=8000 bash setup-factory.sh
#
# What it does:
#   1. Installs Node 22, git, nftables, caddy, docker, sudo and a C++ toolchain
#   2. Creates user `pi` (no sudo, private 700 home) and lets it reach dockerd
#   3. Clones + builds the factory in /home/pi/factory
#   4. Keeps secrets in /etc/factory/factory.env (mode 600, root-owned, outside
#      the repo tree) and loads them via systemd EnvironmentFile=
#   5. Builds the factory-agent image the agents run in (phase 2.1)
#   6. systemd service sandboxed to /home/pi only
#   7. nftables egress filter for uid pi: DNS + HTTPS to allowlist + vLLM host
#   8. Caddy HTTPS front (only if DOMAIN is set)
#
set -euo pipefail

FACTORY_REPO=${FACTORY_REPO:?set FACTORY_REPO to the git URL of this repo}
DOMAIN=${DOMAIN:-}
CADDY_EMAIL=${CADDY_EMAIL:-admin@example.com}
VLLM_HOST=${VLLM_HOST:-}
VLLM_PORT=${VLLM_PORT:-8000}
WEBHOOK_PORT=8787

log() { echo "[setup] $*"; }

# Hosts the factory needs to reach over HTTPS at runtime (kept in sync with the
# HOSTS list inside factory-net-apply below).
ALLOW_HOSTS=(
  api.trello.com
  discord.com
  gateway.discord.gg
  github.com
  api.github.com
  objects.githubusercontent.com
  codeload.github.com
  # Where a GitHub release asset actually redirects to. better-sqlite3's
  # prebuilt binary is a release asset, so without this an `npm install` run as
  # uid pi after these rules load stalls on the download and falls back to
  # compiling. Verified 2026-10-04: the v11.10.0 node-v127-linux-x64 asset 200s
  # only after bouncing through release-assets.githubusercontent.com.
  release-assets.githubusercontent.com
  registry.npmjs.org
  # node-gyp downloads node headers from here when it has to compile. Same
  # failure shape as above, one step later.
  nodejs.org
  api.anthropic.com
  api.openai.com
  generativelanguage.googleapis.com
  api.groq.com
  openrouter.ai
  api.mistral.ai
)

# ---------------------------------------------------------------- packages
log "installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y install curl git nftables cron ca-certificates dnsutils docker.io
# Two things this list was missing, both found by deploying on a fresh Debian 12
# LXC rather than reading it:
#   sudo   — used below as `sudo -u pi` for the clone/install/build, under
#            `set -euo pipefail`. A template without it aborts at the clone.
#   a C++  toolchain — better-sqlite3 is a native addon. It first tries a
#            prebuilt binary from a GitHub release, and when that download
#            times out (as it did on the 2026-10-04 deploy) node-gyp compiles
#            it, which needs make and g++. Without them a fresh deploy cannot
#            install its own database library and the whole run dies there.
apt-get -y install sudo build-essential python3
if ! command -v caddy &>/dev/null; then
  apt-get -y install caddy || {
    log "caddy not in apt — installing from caddyserver.com"
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" \
      -o /usr/local/bin/caddy && chmod +x /usr/local/bin/caddy
  }
fi
if ! command -v node &>/dev/null || [[ $(node -v) != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get -y install nodejs
fi
log "node $(node -v), git $(git --version)"

# ---------------------------------------------------------------- user pi
if ! id pi &>/dev/null; then
  useradd -m -s /usr/bin/bash pi
  log "created user pi (uid $(id -u pi))"
else
  log "user pi already exists (uid $(id -u pi))"
fi
chmod 700 /home/pi

# ---------------------------------------------------------------- docker
# Phase 2.1: every agent session is one throwaway container, so the orchestrator
# needs dockerd. Only the socket is exposed to the service — no sudo, no root.
if ! command -v dockerd &>/dev/null; then
  log "dockerd missing; apt package did not install it"
  exit 1
fi
systemctl enable --now docker
if [[ ! -e /run/docker.sock ]]; then
  log "/run/docker.sock is not there. In a Proxmox LXC you need nesting=1 (and"
  log "usually features=nfs; for overlay2 on newer kernels also keyctl=1)."
  log "See https://pve.proxmox.com/wiki/Linux_Container#_docker_inside_an_lxc"
  log "docker log tail:"
  journalctl -u docker --no-pager -n 25 || true
  exit 1
fi
usermod -aG docker pi
log "user pi is in the docker group; socket owned by $(ls -l /run/docker.sock | awk '{print $3":"$4}')"

# ---------------------------------------------------------------- factory
if [[ ! -d /home/pi/factory/.git ]]; then
  sudo -u pi git clone "$FACTORY_REPO" /home/pi/factory
fi
sudo -u pi bash -c 'cd /home/pi/factory && git pull --ff-only || true'
# NOT `npm install --omit=dev`. This tree builds with a devDependency: `npm run
# build` is `tsc`, and typescript is only in devDependencies, so a production-only
# install leaves node_modules/.bin containing nothing that can compile the
# project — on a fresh LXC the deploy died at `sh: 1: tsc: not found`. Install
# fully, build, then prune back to production-only so the service does not keep
# test tooling on disk. Verified on a clean copy of this tree: install -> tsc
# present; build -> exit 0, dist/index.js; prune --omit=dev -> tsc gone,
# better-sqlite3 and dist/ both survive, dist/config.js still loads.
sudo -u pi npm install --prefix /home/pi/factory
sudo -u pi npm run build --prefix /home/pi/factory
sudo -u pi bash -c 'cd /home/pi/factory && npm prune --omit=dev'
# `scripts/` is not compiled (tsconfig includes only src), and the one script an
# operator needs post-deploy — register:trello-webhooks — runs under tsx, which
# the prune just removed. Say it out loud rather than letting the next person
# rediscover it as "tsx: not found":
log "note: tsx was pruned with the other dev deps. Install it (npm install --no-save tsx) before running npm run register:trello-webhooks."

# ------------------------------------------------------------- secrets file
# The orchestrator is the only thing that holds secrets, and the agent
# containers are started by it. dotenv looks for .env in the working directory,
# so an env file inside the repo tree is one `git add -A` away from being
# published. Keep it in /etc/factory instead, owned by root and mode 600: the
# service user cannot read it, systemd reads it before dropping privileges.
ENV_FILE=/etc/factory/factory.env
install -d -m 700 -o root -g root /etc/factory
if [[ ! -f $ENV_FILE ]]; then
  if [[ -f /home/pi/factory/.env ]]; then
    # migrate an old in-repo env file rather than making you retype it
    mv /home/pi/factory/.env "$ENV_FILE"
    log "moved /home/pi/factory/.env -> $ENV_FILE"
  else
    install -m 600 /home/pi/factory/.env.example "$ENV_FILE"
    log "created $ENV_FILE from .env.example — FILL IT IN before starting"
  fi
fi
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"
if [[ -f /home/pi/factory/.env ]]; then
  log "removing the leftover in-repo env file (secrets live in $ENV_FILE now)"
  rm -f /home/pi/factory/.env
fi

# On a Linux host the spawn channel's default bind (127.0.0.1) is unreachable
# from inside an agent container, which is the difference between a graph that
# works and an orchestrator whose every spawn_agent call fails. Written here, at
# install time, because the container that would discover the problem cannot fix
# it. deploy/configure-env.sh explains the exposure this accepts.
source /home/pi/factory/deploy/configure-env.sh
configure_factory_env "$ENV_FILE" "$(uname -s)" | while IFS= read -r line; do log "$line"; done

log "env file: $ENV_FILE ($(grep -cvE '^\s*(#|$)' "$ENV_FILE") values set)"

# ------------------------------------------------------------- agent image
# The agents run the pi baked into this image, so rebuild it on every deploy:
# bumping @earendil-works/pi-coding-agent in the repo is enough to roll it out.
if bash /home/pi/factory/deploy/docker/build.sh; then
  log "agent image: $(docker run --rm factory-agent --version 2>/dev/null | tail -1)"
else
  log "agent image build FAILED — AGENT_RUNTIME=container runs will not work"
  exit 1
fi

# ---------------------------------------------------------------- systemd
# Sandboxed: reads the whole system, but may only write /home/pi. Secrets come
# in through EnvironmentFile, which PID 1 reads before dropping privileges, so
# the service user never needs to be able to open the file itself.
cat > /etc/systemd/system/factory.service <<EOF
[Unit]
Description=Factory orchestrator (Discord + Trello + pi agents)
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
User=pi
Group=pi
WorkingDirectory=/home/pi/factory
ExecStart=/usr/bin/node /home/pi/factory/dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production

# Agent containers are started through /run/docker.sock. Note that the
# read-only-path options below do not block AF_UNIX socket *connections*, so
# /run does not have to be writable — the docker group is what grants access.
SupplementaryGroups=docker

# --- sandbox: only its own folder ---
NoNewPrivileges=true
ProtectSystem=strict
# 'read-only', not 'true': ProtectHome=true makes /home inaccessible and, unlike
# ReadOnlyPaths=, nothing can be re-exposed inside it — that would hide
# /home/pi/factory from the service that lives there. Other users' homes stay
# unreadable either way, and agent containers run outside this unit's namespace.
ProtectHome=read-only
ReadWritePaths=/home/pi
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable factory
log "systemd unit installed (not started — fill in $ENV_FILE first)"

# ---------------------------------------------------------------- network
# Egress filter for uid pi: allow DNS, HTTPS to allowlisted hosts, vLLM.
# Everything else is dropped + logged. Re-runnable; refreshes the IP set.
cat > /usr/local/bin/factory-net-apply <<'NET'
#!/usr/bin/env bash
set -euo pipefail
HOSTS=(
  api.trello.com discord.com gateway.discord.gg github.com api.github.com
  objects.githubusercontent.com codeload.github.com registry.npmjs.org
  # Native-addon installs. `npm install` as uid pi needs the better-sqlite3
  # prebuild (a GitHub release asset, which redirects here) and, if that fails,
  # node-gyp's headers from nodejs.org. Keeping this list in sync with
  # ALLOW_HOSTS above is manual; a missing entry looks like a network timeout.
  release-assets.githubusercontent.com nodejs.org
  # LLM provider APIs. An agent container's traffic is *forwarded* via docker's
  # bridge rather than locally generated by uid pi, so this filter does not see
  # it; these entries matter for AGENT_RUNTIME=process and for a future egress
  # proxy that does cover containers.
  api.anthropic.com api.openai.com generativelanguage.googleapis.com
  api.groq.com openrouter.ai api.mistral.ai
)
VLLM_HOST=${VLLM_HOST:-}
VLLM_PORT=${VLLM_PORT:-8000}
PI_UID=$(id -u pi)

resolve() {
  local h=$1 ips
  ips=$(getent ahostsv4 "$h" 2>/dev/null | awk '{print $1}')
  [[ -z $ips ]] && ips=$(host -4 "$h" 2>/dev/null | awk '{print $NF}')
  # Only dotted-quad IPv4 is allowed through. `host` does not fail quietly on a
  # lookup miss — it prints "... not found: 3(NXDOMAIN)", whose last field is
  # literally `3(NXDOMAIN)`. That non-empty-but-not-an-IP string went straight
  # into the element list on 2026-10-05 and nft rejected the whole batch
  # ("unexpected '(', expecting comma or '}'"), so a single bad hostname would
  # have failed every refresh. Anything that is not an address counts as
  # unresolved, which is what the guard below is actually for.
  grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' <<<"$ips" || true
}

# Resolve EVERYTHING before touching the live ruleset. A partial answer would
# narrow the allowlist, and a narrowed allowlist presents as the application
# failing, not as the network: that is exactly how the 2026-10-05 deploy lost
# trello.getCard with a 10s connect timeout and no refusal anywhere.
missing=()
IPS=()
for h in "${HOSTS[@]}"; do
  got=$(resolve "$h")
  if [[ -z $got ]]; then
    missing+=("$h")
  else
    while read -r ip; do [[ -n $ip ]] && IPS+=("$ip"); done <<<"$got"
  fi
done
if (( ${#missing[@]} )); then
  echo "[net] ERROR: unresolved host(s): ${missing[*]}" >&2
  echo "[net] keeping the current ruleset rather than narrowing it" >&2
  exit 1
fi
if (( ${#IPS[@]} == 0 )); then
  echo "[net] ERROR: no IPs resolved — check DNS" >&2
  exit 1
fi
mapfile -t IPS < <(printf '%s\n' "${IPS[@]}" | sort -u)
ELEMENTS=$(printf '%s,' "${IPS[@]}")
ELEMENTS=${ELEMENTS%,}
[[ -n $VLLM_HOST ]] && VLLM_RULE="meta skuid $PI_UID tcp dport $VLLM_PORT ip daddr $VLLM_HOST accept"
VLLM_RULE=${VLLM_RULE:-#}

# The directory is not a thing Debian gives you: `dpkg -L nftables` ships
# /etc/nftables.conf and nothing else, and there is no /etc/nftables.d to write
# into. Without this line the redirect below fails with "No such file or
# directory" and, under set -e, takes the whole deploy down with it — which is
# exactly what happened on the 2026-10-04 LXC install.
install -d -m 755 /etc/nftables.d

cat > /etc/nftables.d/factory.nft <<NFT
table inet factory {
    set allowed_v4 {
        type ipv4_addr
        flags dynamic
        elements = { $ELEMENTS }
    }
    chain output {
        type filter hook output priority filter; policy accept;
        meta skuid $PI_UID ip daddr 127.0.0.1/32 accept
        meta skuid $PI_UID ct state established,related accept
        meta skuid $PI_UID udp dport 53 accept
        meta skuid $PI_UID tcp dport 53 accept
        meta skuid $PI_UID tcp dport 443 ip daddr @allowed_v4 accept
        $VLLM_RULE
        meta skuid $PI_UID log prefix "factory-drop: " level info
        meta skuid $PI_UID drop
    }
}
NFT

# Why the file above is not simply applied every run: **it merges, it does not replace.**
# Measured on nft v1.0.6 — two applies with disjoint elements left BOTH in the
# set, and 40 applies left 41 addresses. The daily cron was therefore only ever
# widening this allowlist and never trimming a stale CDN edge out of it, while
# simultaneously being too narrow to cover the edge undici was actually handed.
# Once the table exists, refresh only the set contents. The chain keeps
# referencing @allowed_v4 the whole time, so the microsecond between flush and
# add DENIES traffic rather than permitting it — the transient state fails
# closed. Verified: 40 refreshes leave exactly one address, the chain survives
# 200 of them, and a malformed batch is refused by `nft -c` with the live set
# unchanged.
if nft list table inet factory >/dev/null 2>&1; then
  cat > /etc/nftables.d/factory-refresh.nft <<RENEW
flush set inet factory allowed_v4
add element inet factory allowed_v4 { $ELEMENTS }
RENEW
  nft -c -f /etc/nftables.d/factory-refresh.nft
  nft -f /etc/nftables.d/factory-refresh.nft
  echo "[net] allowed_v4 replaced with ${#IPS[@]} address(es)"
else
  nft -f /etc/nftables.d/factory.nft
  echo "[net] table inet factory created with ${#IPS[@]} address(es)"
fi
NET
chmod +x /usr/local/bin/factory-net-apply

# Boot persistence, deliberately NOT via Debian's own config. Two facts from
# testing this on a stock debian:12-slim with nft v1.0.6:
#
#   1. The shipped /etc/nftables.conf starts with `flush ruleset`, and it does not
#      include /etc/nftables.d. Loading it at boot took the factory table from 1
#      to 0 — the filter vanishes on reboot. Adding `include
#      "/etc/nftables.d/*.nft"` to that file does fix it (verified: 1 after boot,
#      with the skuid rule live), BUT that same `flush ruleset` would also wipe
#      whatever the docker daemon put in nft when it starts, so restarting
#      nftables.service would break container networking. Not worth it.
#   2. The package does not enable nftables.service on a fresh install anyway
#      (WantedBy=sysinit.target, and the postinst only enables it if it "was
#      enabled" before), so nothing reads /etc/nftables.conf at boot regardless.
#
# So re-run the generator at boot instead. This is better than a static dump of
# the include route, too: factory-net-apply resolves the allowlisted hostnames
# afresh, and CDN/IP-shifted entries do not age into a silent drop.
cat > /etc/systemd/system/factory-net.service <<EOF
[Unit]
Description=Re-apply the factory egress allowlist (resolves hostnames fresh)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/factory-net-apply
Environment=VLLM_HOST=${VLLM_HOST}
Environment=VLLM_PORT=${VLLM_PORT}
EOF
systemctl daemon-reload
systemctl enable factory-net.service
log "boot-time egress re-apply enabled (factory-net.service)"
VLLM_HOST="$VLLM_HOST" VLLM_PORT="$VLLM_PORT" /usr/local/bin/factory-net-apply

# Refresh every 5 minutes, not daily.
#
# The daily cron was the wrong cadence for a CDN-backed host. api.trello.com sits
# behind CloudFront: on 2026-10-05 the pinned set held no 13.225.47.x entry while
# undici was handed exactly that pool, so the orchestrator's own getCard timed
# out at 10s with no refusal anywhere, and a legitimate card move did nothing.
# Five minutes keeps the set TIGHT — roughly the ~50 addresses DNS is answering
# right now, rather than the 211 published CloudFront prefixes, which would have
# traded correctness for a much larger allowance — while shrinking the window in
# which a pool change can strand the service from 24 hours to 5.
#
# One mechanism, not two: the old daily cron is removed rather than left beside
# the timer, because two writers of the same ruleset at different cadences is how
# "why did it change at 03:00" questions start.
rm -f /etc/cron.d/factory-net
cat > /etc/systemd/system/factory-net.timer <<EOF
[Unit]
Description=Refresh the factory egress allowlist every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now factory-net.timer
log "egress allowlist refreshes every 5 min (factory-net.timer)"
log "check it: systemctl list-timers factory-net.timer; journalctl -u factory-net.service -n 20"

# ---------------------------------------------------------------- caddy
if [[ -n $DOMAIN ]]; then
  cat > /etc/caddy/Caddyfile <<EOF
{
    email $CADDY_EMAIL
}
$DOMAIN {
    reverse_proxy 127.0.0.1:$WEBHOOK_PORT
}
EOF
  systemctl enable --now caddy
  log "caddy serving https://$DOMAIN -> :$WEBHOOK_PORT"
else
  log "no DOMAIN set — webhooks will hit http://<container-ip>:$WEBHOOK_PORT directly"
fi

# ---------------------------------------------------------------- done
cat <<'DONE'

[setup] complete. Next steps:
  1. Fill in /etc/factory/factory.env (Trello, Discord, GitHub, REPO_PATH, and
     the ANTHROPIC_API_KEY / OPENAI_API_KEY / ... the agents should use)
  2. Clone the target repo:  sudo -u pi git clone <target> /home/pi/repos/<name>
     Use an ssh remote or a credential helper — NOT an https URL with a token in
     it. Agents get a read-only mount of <repo>/.git, and the factory refuses to
     start a container whose git config embeds credentials.
  3. Start:                  systemctl start factory
  4. Webhooks:
       Trello  one BOARD webhook, registered from the API (there is no Trello
               webhook UI, and no per-card step):
                 TRELLO_WEBHOOK_URL=https://<domain>/webhook/trello \
                   npm run register:trello-webhooks
               Run it AFTER starting the factory: Trello HEADs the callback URL
               and creates nothing unless that answers 200. Needs
               TRELLO_APP_SECRET for the factory to verify deliveries with.
       GitHub  repo webhook -> https://<domain>/webhook/github  (Pull requests only)
  5. Verify egress filter:   nft list ruleset | grep factory
                             (test: sudo -u pi curl -sI https://example.com -> dropped)
     Note: agent container traffic is forwarded through docker's bridge, not
     generated by uid pi, so this filter does not constrain what an agent can
     reach. See the "Secret isolation" section of the README.
  6. Verify isolation end to end (real container, needs a provider key set):
       TEST_DOCKER=1 npx vitest run test/integration
DONE
