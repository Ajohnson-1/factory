#!/usr/bin/env bash
# Provision the Proxmox box for the FACTORY runtime (FM-5, card
# 6aee5f4d6e98279cb3ab3304; docs/factory-migration.md §6.1 steps 2-4).
#
# Two paste sessions, same idempotent pattern as provision-deploy-host.sh:
#   ROOT console (step 2 root line):
#     bash /root/provision-factory-host.sh   # uid 0 => enables user linger
#   FACTORY user session (steps 2-4 user lines):
#     FACTORY_TRELLO_KEY=… FACTORY_TRELLO_TOKEN=… FACTORY_BOT_TOKEN=… \
#     FACTORY_DEPLOY_HOST=… FACTORY_SSH_PRIVKEY_FILE=~/factory_deploy_ed25519 \
#     bash /home/factory/provision-factory-host.sh
#
# Idempotent: safe to re-run; every step is an existence/version guard or
# an atomic byte-stable replace. Ends with a PASS/FAIL self-check whose
# status gates the exit (0 = all PASS). No interactive prompts.
#
# Test seams (same as the deploy-host provisioner): PROVISION_MODE=test +
# DESTDIR=<scratch> folds every adapter onto a scratch tree (no root, no
# network, no systemd); FACTORY_PROVISION_ROLE=root|user selects the
# session under test. bash 3.2 compatible.
set -euo pipefail

PROVISION_MODE="${PROVISION_MODE:-live}"          # live | test
DESTDIR="${DESTDIR:-}"                            # path prefix; '' = real system
if [ "$PROVISION_MODE" = live ]; then
  FACTORY_USER="${FACTORY_USER:-factory}"
  FACTORY_GROUP="${FACTORY_GROUP:-docker}"
else
  FACTORY_USER="${FACTORY_USER:-$(id -un)}"
  FACTORY_GROUP="${FACTORY_GROUP:-$(id -gn)}"
fi
FACTORY_PROVISION_ROLE="${FACTORY_PROVISION_ROLE:-auto}"   # auto | root | user

# Box layout (§6.1: the discord-bot RUNTIME clone lives under /opt/repos,
# SEPARATE from the /opt/discord-bot app dir — bind-mount state lives there).
FACTORY_DIR="${FACTORY_DIR:-$DESTDIR/opt/factory}"
REPOS_DIR="${REPOS_DIR:-$DESTDIR/opt/repos}"
DBOT_DIR="${DBOT_DIR:-$REPOS_DIR/discord-bot}"
FACTORY_WORKTREES="${FACTORY_WORKTREES:-$DESTDIR/opt/factory-worktrees}"
DBOT_WORKTREES="${DBOT_WORKTREES:-$REPOS_DIR/discord-bot-worktrees}"
FACTORY_REPO_URL="${FACTORY_REPO_URL:-git@github.com:Ajohnson-1/factory.git}"
DBOT_REPO_URL="${DBOT_REPO_URL:-git@github.com:Ajohnson-1/discord-bot.git}"

# Node LTS install target (§6.1 step 2; the systemd unit PATH bakes
# ~/.local/node/bin — lib/factory-platform-systemd.js unitPath()).
NODE_VERSION="${NODE_VERSION:-v22.14.0}"
NODE_ARCH="${NODE_ARCH:-x64}"
NODE_MIRROR="${NODE_MIRROR:-https://nodejs.org/dist}"

HOMEDIR="$DESTDIR/home/$FACTORY_USER"
SSHDIR="$HOMEDIR/.ssh"
NODEHOME="$HOMEDIR/.local/node"
STATE="$DESTDIR/state"
ENV_FILE="$FACTORY_DIR/.env"      # operative read path: trello.js/deploy-config.js ROOT/.env
ENV_FILE_HOME="$HOMEDIR/.env"     # §6.1 docs location — same bytes
REGISTRY_FILE="$FACTORY_DIR/config/factory-repos.local.json"   # D2 override

# ---------------------------------------------------------------------------
# System adapters (live) / markers (test) — pattern + helpers from
# scripts/factory-host-lib.sh (portable stat, atomic writes, self-check).
# ---------------------------------------------------------------------------
# shellcheck source=factory-host-lib.sh
. "$(dirname "${BASH_SOURCE[0]:-$0}")/factory-host-lib.sh"

# --- root session (§6.1 step 2, the one root line) --------------------------
ensure_linger() {
  if [ "$PROVISION_MODE" = live ]; then
    loginctl enable-linger "$FACTORY_USER"   # idempotent
  else
    mkdir -p "$STATE"
    touch "$STATE/linger"
  fi
}

# --- factory-user session (§6.1 steps 2-4) ----------------------------------
# node LTS tarball -> ~/.local/node (skip when the pinned version is
# already there; a different version is replaced atomically).
ensure_node() {
  local want="${NODE_VERSION#v}"
  if [ -x "$NODEHOME/bin/node" ] && [ "$("$NODEHOME/bin/node" --version 2>/dev/null || true)" = "$NODE_VERSION" ]; then
    return 0
  fi
  if [ "$PROVISION_MODE" = live ]; then
    local tarball="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
    mkdir -p "$HOMEDIR/.local"
    curl -fsSL "$NODE_MIRROR/$NODE_VERSION/$tarball" -o "$HOMEDIR/$tarball"
    rm -rf "$HOMEDIR/.local/node.tmp"
    mkdir -p "$HOMEDIR/.local/node.tmp"
    tar -xJ -f "$HOMEDIR/$tarball" -C "$HOMEDIR/.local/node.tmp" --strip-components=1
    rm -rf "$HOMEDIR/.local/node.old"
    [ -d "$NODEHOME" ] && mv "$NODEHOME" "$HOMEDIR/.local/node.old"
    mv "$HOMEDIR/.local/node.tmp" "$NODEHOME"
    rm -rf "$HOMEDIR/.local/node.old" "$HOMEDIR/$tarball"
  else
    mkdir -p "$NODEHOME/bin"
    printf '#!/bin/sh\necho %s\n' "$NODE_VERSION" > "$NODEHOME/bin/node"
    chmod +x "$NODEHOME/bin/node"
  fi
}

# omp on the user npm prefix (= ~/.local/node once step 2 landed).
ensure_omp() {
  if [ "$PROVISION_MODE" = live ]; then
    if PATH="$NODEHOME/bin:$PATH" command -v omp >/dev/null 2>&1; then
      return 0
    fi
    PATH="$NODEHOME/bin:$PATH" npm install -g omp \
      || echo 'WARN: npm i -g omp failed (registry reachable? node installed?) — the self-check will FAIL' >&2
  else
    mkdir -p "$STATE"
    touch "$STATE/omp"
  fi
}

ensure_repos() {
  ensure_repo "$DBOT_DIR" "$DBOT_REPO_URL"
  ensure_repo "$FACTORY_DIR" "$FACTORY_REPO_URL"
  mkdir -p "$FACTORY_WORKTREES" "$DBOT_WORKTREES"
}

# The 0600 secrets file (§6.1 step 4) — fixed key order = byte-stable
# re-runs. Written to BOTH the operative repo path and the docs home path.
dotenv_content() {
  printf 'TRELLO_KEY=%s\n' "${FACTORY_TRELLO_KEY:-}"
  printf 'TRELLO_TOKEN=%s\n' "${FACTORY_TRELLO_TOKEN:-}"
  printf 'BOT_TOKEN=%s\n' "${FACTORY_BOT_TOKEN:-}"
  printf 'DEPLOY_HOST=%s\n' "${FACTORY_DEPLOY_HOST:-}"
  printf 'DEPLOY_USER=factory\n'
  printf 'DEPLOY_KEY=~/.ssh/factory_deploy_ed25519\n'
  printf 'DEPLOY_DIR=/opt/discord-bot\n'
  printf 'FACTORY_REPOS_FILE=%s\n' "$REGISTRY_FILE"
}
write_dotenv() {
  local content; content="$(dotenv_content)"
  write_file_atomic "$ENV_FILE" 600 "$content"
  mkdir -p "$HOMEDIR"
  write_file_atomic "$ENV_FILE_HOME" 600 "$content"
}

# factory-repos.local.json with box paths (D2 / §4.1; validated in the
# self-check against scripts/lib/factory-registry.js's shape).
write_local_registry() {
  mkdir -p "$FACTORY_DIR/config"
  local tmp="$REGISTRY_FILE.tmp.$$"
  cat > "$tmp" <<EOF
{
  "defaultRepo": "factory",
  "repos": {
    "factory": {
      "repoDir": "$FACTORY_DIR",
      "worktreeRoot": "$FACTORY_WORKTREES",
      "baseBranch": "master",
      "board": "LLNG5MAm",
      "deploy": { "driver": "self" },
      "worktreeBootstrap": []
    },
    "discord-bot": {
      "repoDir": "$DBOT_DIR",
      "worktreeRoot": "$DBOT_WORKTREES",
      "baseBranch": "master",
      "board": "ZHkVYBN1",
      "deploy": { "driver": "docker-ssh" },
      "worktreeBootstrap": [
        "ln -s ../../discord-bot/node_modules node_modules",
        "cp .env version.json <wt>/",
        "mkdir -p <wt>/config <wt>/data && cp config/config.json <wt>/config/",
        "test -f <wt>/.env || cp <factoryRoot>/.env <wt>/.env"
      ]
    }
  }
}
EOF
  mv -f "$tmp" "$REGISTRY_FILE"
}

# Private half of factory_deploy_ed25519 (operator-scped file) -> ~/.ssh/
# 600; ssh-to-self works: the public half is already in authorized_keys.
ensure_ssh_key() {
  mkdir -p "$SSHDIR"
  set_owner_mode "$FACTORY_USER" "$FACTORY_GROUP" 700 "$SSHDIR"
  [ -n "${FACTORY_SSH_PRIVKEY_FILE:-}" ] || return 0
  [ -f "$FACTORY_SSH_PRIVKEY_FILE" ] || { echo "ERROR: FACTORY_SSH_PRIVKEY_FILE=$FACTORY_SSH_PRIVKEY_FILE missing" >&2; return 1; }
  local dest="$SSHDIR/factory_deploy_ed25519"
  if [ -f "$dest" ] && cmp -s "$FACTORY_SSH_PRIVKEY_FILE" "$dest"; then
    chmod 600 "$dest"
    return 0
  fi
  cp "$FACTORY_SSH_PRIVKEY_FILE" "$dest"
  set_owner_mode "$FACTORY_USER" "$FACTORY_GROUP" 600 "$dest"
}

# --- checks -----------------------------------------------------------------
chk_linger() {
  if [ "$PROVISION_MODE" = live ]; then
    [ "$(loginctl show-user "$FACTORY_USER" -p Linger 2>/dev/null | sed 's/Linger=//')" = "yes" ]
  else
    [ -f "$STATE/linger" ]
  fi
}
chk_node() {
  [ -x "$NODEHOME/bin/node" ] && [ "$("$NODEHOME/bin/node" --version 2>/dev/null || true)" = "$NODE_VERSION" ]
}
chk_omp() {
  if [ "$PROVISION_MODE" = live ]; then
    PATH="$NODEHOME/bin:$PATH" command -v omp >/dev/null 2>&1
  else
    [ -f "$STATE/omp" ]
  fi
}
chk_repo() { [ -d "$1/.git" ]; }
chk_actor() { grep -q 'name = factory' "$1/.git/config"; }  # `git config user.name factory` writes [user] + name = factory
chk_actor_both() { chk_actor "$1" && chk_actor "$2"; }
chk_dotenv() {
  [ -f "$ENV_FILE" ] && [ "$(stat_mode "$ENV_FILE")" = 600 ] \
    && grep -Eq '^TRELLO_KEY=.+' "$ENV_FILE" \
    && grep -Eq '^TRELLO_TOKEN=.+' "$ENV_FILE" \
    && grep -Eq '^BOT_TOKEN=.+' "$ENV_FILE" \
    && grep -Eq '^DEPLOY_HOST=.+' "$ENV_FILE" \
    && grep -Fq "FACTORY_REPOS_FILE=$REGISTRY_FILE" "$ENV_FILE"
}
chk_registry() {
  # Live: the pinned binary — node exists only under $NODEHOME/bin on the
  # box (no global PATH export; cf. ensure_node/ensure_omp), so a bare
  # `node` dies 127 under set -e. Test: host node (the stub can't run -e).
  local node_bin=node
  if [ "$PROVISION_MODE" = live ]; then
    node_bin="$NODEHOME/bin/node"
  fi
  [ -f "$REGISTRY_FILE" ] \
    && "$node_bin" -e '
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const f = j.repos.factory, d = j.repos["discord-bot"];
      if (j.defaultRepo !== "factory") process.exit(1);
      if (f.repoDir !== process.argv[2] || f.board !== "LLNG5MAm" || f.deploy.driver !== "self") process.exit(1);
      if (d.repoDir !== process.argv[3] || d.board !== "ZHkVYBN1" || d.deploy.driver !== "docker-ssh") process.exit(1);
      if (f.worktreeRoot !== process.argv[4] || d.worktreeRoot !== process.argv[5]) process.exit(1);
    ' "$REGISTRY_FILE" "$FACTORY_DIR" "$DBOT_DIR" "$FACTORY_WORKTREES" "$DBOT_WORKTREES"
}
chk_ssh_key() {
  [ -f "$SSHDIR/factory_deploy_ed25519" ] && [ "$(stat_mode "$SSHDIR/factory_deploy_ed25519")" = 600 ]
}

# ---------------------------------------------------------------------------
# Main — role = the session pasted (root console / factory user console)
# ---------------------------------------------------------------------------
resolve_role() {
  if [ "$FACTORY_PROVISION_ROLE" != auto ]; then
    printf '%s' "$FACTORY_PROVISION_ROLE"
  elif [ "$(id -u)" -eq 0 ]; then
    printf root
  else
    printf user
  fi
}

main() {
  case "$(resolve_role)" in
    root)
      if [ "$PROVISION_MODE" = live ]; then
        require_root_linger
      fi
      ensure_linger
      check 'linger enabled for factory user' chk_linger
      finish_checks
      ;;
    user)
      ensure_node
      ensure_omp
      ensure_repos
      write_dotenv
      write_local_registry
      ensure_ssh_key
      check 'node LTS at ~/.local/node' chk_node
      check 'omp installed on the user prefix' chk_omp
      check 'discord-bot runtime clone at /opt/repos/discord-bot' chk_repo "$DBOT_DIR"
      check 'factory clone at /opt/factory' chk_repo "$FACTORY_DIR"
      check 'git actor = factory in both clones' chk_actor_both "$DBOT_DIR" "$FACTORY_DIR"
      check '.env at repo root, mode 600, required secrets set' chk_dotenv
      check 'factory-repos.local.json valid with box paths' chk_registry
      check 'private key ~/.ssh/factory_deploy_ed25519 mode 600' chk_ssh_key
      finish_checks
      ;;
    *)
      echo "ERROR: FACTORY_PROVISION_ROLE must be auto|root|user" >&2
      exit 1
      ;;
  esac
}

require_root_linger() {
  [ "$(id -u)" -eq 0 ] || { echo 'ERROR: root session must run as root' >&2; return 1; }
  getent passwd "$FACTORY_USER" >/dev/null || { echo "ERROR: user $FACTORY_USER missing — run provision-deploy-host.sh first" >&2; return 1; }
}

# Testability hook: `source <thisfile> --source-lib` defines functions
# without running main. Plain `bash <thisfile>` runs the pasted flow.
[ "${1:-}" = '--source-lib' ] && return 0 2>/dev/null || true

main "$@"
