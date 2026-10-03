#!/usr/bin/env bash
#
# setup-factory.sh — set up the factory in a Proxmox LXC container (Debian 12).
#
# Run as root INSIDE the container:
#   FACTORY_REPO=https://github.com/<you>/factory.git DOMAIN=factory.example.com \
#   VLLM_HOST=192.168.1.50 VLLM_PORT=8000 bash setup-factory.sh
#
# What it does:
#   1. Installs Node 22, git, nftables, caddy, docker (for the agent containers)
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
  registry.npmjs.org
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
sudo -u pi npm install --prefix /home/pi/factory --omit=dev
sudo -u pi npm run build --prefix /home/pi/factory

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
  echo "$ips"
}
IPS=$(for h in "${HOSTS[@]}"; do resolve "$h"; done | sort -u)
[[ -n $IPS ]] || { echo "[net] ERROR: no IPs resolved — check DNS" >&2; exit 1; }
ELEMENTS=$(echo "$IPS" | paste -sd, -)
[[ -n $VLLM_HOST ]] && VLLM_RULE="meta skuid $PI_UID tcp dport $VLLM_PORT ip daddr $VLLM_HOST accept"
VLLM_RULE=${VLLM_RULE:-#}

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
nft -f /etc/nftables.d/factory.nft
echo "[net] egress rules applied for uid $PI_UID ($(echo "$IPS" | wc -l) allowlisted IPs)"
NET
chmod +x /usr/local/bin/factory-net-apply
VLLM_HOST="$VLLM_HOST" VLLM_PORT="$VLLM_PORT" /usr/local/bin/factory-net-apply

# Refresh allowlist daily (GitHub/Trello IPs change)
cat > /etc/cron.d/factory-net <<EOF
0 3 * * * root VLLM_HOST=$VLLM_HOST VLLM_PORT=$VLLM_PORT /usr/local/bin/factory-net-apply
EOF

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
