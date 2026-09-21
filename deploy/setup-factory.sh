#!/usr/bin/env bash
#
# setup-factory.sh — set up the factory in a Proxmox LXC container (Debian 12).
#
# Run as root INSIDE the container:
#   FACTORY_REPO=https://github.com/<you>/factory.git DOMAIN=factory.example.com \
#   VLLM_HOST=192.168.1.50 VLLM_PORT=8000 bash setup-factory.sh
#
# What it does:
#   1. Installs Node 22, git, nftables, caddy
#   2. Creates user `pi` (no sudo, private 700 home)
#   3. Clones + builds the factory in /home/pi/factory
#   4. systemd service sandboxed to /home/pi only (ProtectHome + ReadWritePaths)
#   5. nftables egress filter for uid pi: DNS + HTTPS to allowlist + vLLM host
#   6. Caddy HTTPS front (only if DOMAIN is set)
#
set -euo pipefail

FACTORY_REPO=${FACTORY_REPO:?set FACTORY_REPO to the git URL of this repo}
DOMAIN=${DOMAIN:-}
CADDY_EMAIL=${CADDY_EMAIL:-admin@example.com}
VLLM_HOST=${VLLM_HOST:-}
VLLM_PORT=${VLLM_PORT:-8000}
WEBHOOK_PORT=8787

log() { echo "[setup] $*"; }

# Hosts the factory needs to reach over HTTPS at runtime.
ALLOW_HOSTS=(
  api.trello.com
  discord.com
  gateway.discord.gg
  github.com
  api.github.com
  objects.githubusercontent.com
  codeload.github.com
  registry.npmjs.org
)

# ---------------------------------------------------------------- packages
log "installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y install curl git nftables cron ca-certificates dnsutils
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

# ---------------------------------------------------------------- factory
if [[ ! -d /home/pi/factory/.git ]]; then
  sudo -u pi git clone "$FACTORY_REPO" /home/pi/factory
fi
sudo -u pi bash -c 'cd /home/pi/factory && git pull --ff-only || true'
sudo -u pi npm install --prefix /home/pi/factory --omit=dev
sudo -u pi npm run build --prefix /home/pi/factory
if [[ ! -f /home/pi/factory/.env ]]; then
  cp /home/pi/factory/.env.example /home/pi/factory/.env
  chown pi:pi /home/pi/factory/.env
  log "created /home/pi/factory/.env — FILL IT IN before starting the service"
fi

# ---------------------------------------------------------------- systemd
# Sandboxed: the service can only read the system and write /home/pi.
cat > /etc/systemd/system/factory.service <<EOF
[Unit]
Description=Factory orchestrator (Discord + Trello + pi agents)
After=network-online.target
Wants=network-online.target

[Service]
User=pi
Group=pi
WorkingDirectory=/home/pi/factory
ExecStart=/usr/bin/node /home/pi/factory/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# --- sandbox: only its own folder ---
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
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
log "systemd unit installed (not started — fill .env first)"

# ---------------------------------------------------------------- network
# Egress filter for uid pi: allow DNS, HTTPS to allowlisted hosts, vLLM.
# Everything else is dropped + logged. Re-runnable; refreshes the IP set.
cat > /usr/local/bin/factory-net-apply <<'NET'
#!/usr/bin/env bash
set -euo pipefail
HOSTS=(
  api.trello.com discord.com gateway.discord.gg github.com api.github.com
  objects.githubusercontent.com codeload.github.com registry.npmjs.org
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
  1. Fill in /home/pi/factory/.env (Trello, Discord, GitHub, REPO_PATH)
  2. Clone the target repo:  sudo -u pi git clone <target> /home/pi/repos/<name>
  3. Start:                  systemctl start factory
  4. Webhooks:
       Trello  card webhook -> https://<domain>/webhook/trello
       GitHub  repo webhook -> https://<domain>/webhook/github  (Pull requests only)
  5. Verify egress filter:   nft list ruleset | grep factory
                             (test: sudo -u pi curl -sI https://example.com  -> should be dropped)
DONE
