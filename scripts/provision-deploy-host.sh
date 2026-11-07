#!/usr/bin/env bash
# Provision the Debian 12 deploy host for the discord-bot factory agent.
#
# One-time use: paste into the ROOT console of a fresh Debian 12 VM as a single
# block (see docs/deploy-host.md §1):
#
#   cat > /root/provision-deploy-host.sh <<'FACTORY_PROVISION_EOF'
#   <this whole file>
#   FACTORY_PROVISION_EOF
#   bash /root/provision-deploy-host.sh
#
# Idempotent: safe to re-run; every step is a getent/dpkg/test guard or an
# atomic replace. Ends with a PASS/FAIL self-check whose exit status gates
# success (0 = all PASS). No interactive prompts anywhere.
set -euo pipefail

# --- EDIT IF THE DEPLOY KEY CHANGES (otherwise leave as-is) ---
# Default applies when the variable is unset; if exported (CI passes it empty
# to exercise the key guard) the exported value is respected and validated.
if [ -z "${FACTORY_SSH_PUBKEY+isset}" ]; then
  FACTORY_SSH_PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMPqgmwDze4Ojo7hgGR0m1xjPVc6JEzUQM8ZBINsgEEO factory-deploy@laptop'
fi

# --- test seams (defaults = production values; CI overrides) ---
FACTORY_USER="${FACTORY_USER:-factory}"
FACTORY_GROUP="${FACTORY_GROUP:-docker}"
DESTDIR="${DESTDIR:-}"                     # path prefix; '' = real system
PROVISION_MODE="${PROVISION_MODE:-live}"   # live | test

# Resolved paths (DESTDIR-prefixed so tests can run against a scratch tree).
HOMEDIR="$DESTDIR/home/$FACTORY_USER"
SSHDIR="$HOMEDIR/.ssh"
APPDIR="$DESTDIR/opt/discord-bot"
STATE="$DESTDIR/state"
DAEMON_JSON_DIR="${DAEMON_JSON_DIR:-$DESTDIR/etc/docker}"   # docker daemon config dir
JOURNAL_DIR="$DESTDIR/var/log/journal"
JOURNAL_DROPIN_DIR="$DESTDIR/etc/systemd/journald.conf.d"
JOURNAL_DROPIN="$JOURNAL_DROPIN_DIR/10-factory.conf"

# ---------------------------------------------------------------------------
# Portable stat: GNU coreutils (Debian 12) uses `stat -c`; BSD (macOS gate
# host) uses `stat -f` with different directives. Probe once, use either.
# ---------------------------------------------------------------------------
if stat -c '%a' . >/dev/null 2>&1; then
  _STAT_GNU=1
else
  _STAT_GNU=0
fi

stat_mode() {  # $1=path -> octal mode, e.g. 600
  if [ "$_STAT_GNU" -eq 1 ]; then stat -c '%a' "$1"; else stat -f '%A' "$1"; fi
}
stat_user() {  # $1=path -> owner name
  if [ "$_STAT_GNU" -eq 1 ]; then stat -c '%U' "$1"; else stat -f '%Su' "$1"; fi
}

# ---------------------------------------------------------------------------
# Key validation (runs before ANY mutation)
# ---------------------------------------------------------------------------
require_valid_key() {
  if [ -z "$FACTORY_SSH_PUBKEY" ]; then
    echo 'ERROR: FACTORY_SSH_PUBKEY is empty; paste the script with the key line filled in' >&2
    return 1
  fi
  case "$FACTORY_SSH_PUBKEY" in
    *'
'*)
      echo 'ERROR: FACTORY_SSH_PUBKEY must be a single line' >&2
      return 1
      ;;
  esac
  local re='^ssh-(ed25519|rsa|ecdsa|dss) [A-Za-z0-9+/]+[=]*( [^[:space:]]+)?$'
  if ! [[ $FACTORY_SSH_PUBKEY =~ $re ]]; then
    echo 'ERROR: FACTORY_SSH_PUBKEY is not a valid OpenSSH public key (want: ssh-<type> <base64> [comment])' >&2
    return 1
  fi
}

# daemon.json merge/checks need python3: Debian 12 base ships it (node does
# NOT — the bot runs inside containers), and any machine that can
# `npm install` this repo has it (node-gyp dependency). Missing python3 in
# live mode ⇒ loud early death before any mutation; in test mode the
# merge step warns and the new self-checks FAIL loudly, never skip.
require_json_tool() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo 'ERROR: python3 required to merge daemon.json (Debian 12 ships it; is PATH broken?)' >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Live-mode guards (test mode skips: CI runs unprivileged on non-Debian)
# ---------------------------------------------------------------------------
require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo 'ERROR: must run as root (paste into the root console)' >&2
    return 1
  fi
}
require_debian12() {
  if ! grep -q 'VERSION_ID="12"' /etc/os-release 2>/dev/null; then
    echo 'ERROR: this provisioner targets Debian 12 (bookworm) only' >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# System adapters: the ONLY functions that touch the system.
# Test mode operates solely under $DESTDIR (no root, no docker, no network).
# ---------------------------------------------------------------------------
APT_FLAGS='-y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confnew -o Dpkg::Options::=--force-confmiss'

# docker-compose-plugin is not in Debian 12 repos (only Docker's own CE apt
# repo ships it), so add that repo first, then install.
DOCKER_PKGS='docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin'
KEYRING='/etc/apt/keyrings/docker.gpg'
SOURCES_LIST='/etc/apt/sources.list.d/docker.list'

# Live mode: add download.docker.com apt repo. Idempotent (keyring + list
# present -> no re-add churn). Returns non-zero on failure (e.g.
# download.docker.com unreachable); caller continues so the self-check
# reports it loudly.
add_docker_repo() {
  if [ -s "$KEYRING" ] && [ -s "$SOURCES_LIST" ]; then
    return 0
  fi
  # shellcheck disable=SC1091  # Debian-standard path
  . /etc/os-release            # require_debian12 already verified VERSION_ID="12"
  local codename="${VERSION_CODENAME:-bookworm}"
  if ! command -v curl >/dev/null 2>&1 || ! command -v gpg >/dev/null 2>&1; then
    # shellcheck disable=SC2086  # APT_FLAGS is a deliberate word-split flag list
    DEBIAN_FRONTEND=noninteractive apt-get install $APT_FLAGS curl gnupg
  fi
  mkdir -p /etc/apt/keyrings
  # pipefail makes an unreachable curl fail the pipeline; keyring.tmp keeps
  # any existing keyring intact on partial failure.
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o "$KEYRING.tmp" || { rm -f "$KEYRING.tmp"; return 1; }
  chmod 0644 "$KEYRING.tmp"
  mv -f "$KEYRING.tmp" "$KEYRING"
  printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/debian %s stable\n' \
    "$(dpkg --print-architecture)" "$KEYRING" "$codename" > "$SOURCES_LIST"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
}

ensure_docker_repo() {
  if [ "$PROVISION_MODE" = live ]; then
    if ! add_docker_repo; then
      echo 'ERROR: Docker CE apt repo setup failed (download.docker.com unreachable?); continuing so the self-check reports it' >&2
    fi
  else
    mkdir -p "$STATE"
    touch "$STATE/apt-repo"    # scratch marker; tests never hit the network
  fi
}

ensure_packages() {
  local p need=''
  if [ "$PROVISION_MODE" = live ]; then
    for p in $DOCKER_PKGS; do
      dpkg -s "$p" >/dev/null 2>&1 || need="$need $p"
    done
    if [ -n "$need" ]; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq || echo 'WARN: apt-get update failed' >&2
      # shellcheck disable=SC2086  # APT_FLAGS/need are deliberate word-split lists
      DEBIAN_FRONTEND=noninteractive apt-get install $APT_FLAGS $need \
        || echo 'ERROR: docker package install failed (repo unreachable?); the self-check will FAIL' >&2
    fi
  else
    mkdir -p "$STATE"
    for p in $DOCKER_PKGS; do
      printf '%s\n' "$p" >> "$STATE/apt.log"
    done
  fi
}

enable_docker() {
  if [ "$PROVISION_MODE" = live ]; then
    systemctl enable --now docker
  else
    mkdir -p "$STATE"
    touch "$STATE/docker.enabled"
  fi
}

ensure_group() {
  if [ "$PROVISION_MODE" = live ]; then
    getent group "$FACTORY_GROUP" >/dev/null || groupadd "$FACTORY_GROUP"
  else
    mkdir -p "$STATE/groups/$FACTORY_GROUP"
  fi
}

ensure_user() {
  if [ "$PROVISION_MODE" = live ]; then
    getent passwd "$FACTORY_USER" >/dev/null || useradd -m -g "$FACTORY_GROUP" -s /bin/bash "$FACTORY_USER"
    passwd -l "$FACTORY_USER"   # password login disabled (shadow lock); idempotent
  else
    mkdir -p "$STATE/users"
    touch "$STATE/users/$FACTORY_USER"
    touch "$STATE/users/$FACTORY_USER.locked"   # mirrors `passwd -S` field 2 = L
  fi
  # Home must exist and be factory-owned in both modes.
  mkdir -p "$HOMEDIR"
  set_owner_mode "$FACTORY_USER" "$FACTORY_GROUP" 755 "$HOMEDIR"
}

# set_owner_mode user group mode path — chown+chmod in live mode; in test
# mode the owner args map to the current user (non-root can always chown to
# itself and its primary group).
set_owner_mode() {
  local user="$1" group="$2" mode="$3" path="$4"
  if [ "$PROVISION_MODE" = live ]; then
    chown "$user:$group" "$path"
    chmod "$mode" "$path"
  else
    chown "$(id -un):$(id -gn)" "$path"
    chmod "$mode" "$path"
  fi
}

# ---------------------------------------------------------------------------
# Core idempotency logic (identical in both modes; the CI test exercises this)
# ---------------------------------------------------------------------------
# Atomic authorized_keys replace: write tmp, chmod 600, rename. Rename within
# one directory is atomic — readers never see a partial/empty file. Re-run
# writes identical bytes (byte-stable idempotency) and repairs corruption.
install_authorized_keys() {
  local dest_dir="$1" pubkey="$2" tmp
  mkdir -p "$dest_dir"
  set_owner_mode "$FACTORY_USER" "$FACTORY_GROUP" 700 "$dest_dir"
  tmp="$dest_dir/authorized_keys.tmp.$$"
  printf '%s\n' "$pubkey" > "$tmp"
  set_owner_mode "$FACTORY_USER" "$FACTORY_GROUP" 600 "$tmp"
  mv -f "$tmp" "$dest_dir/authorized_keys"
}

ensure_app_dir() {
  mkdir -p "$APPDIR"
  set_owner_mode "$FACTORY_USER" "$FACTORY_GROUP" 755 "$APPDIR"
}

# ---------------------------------------------------------------------------
# Docker daemon log caps + journald persistence (card 6ae4c877a23c63a664b75aab)
# daemon.json is MERGED via python3 — node is absent on the Debian host and
# python3 is base-shipped — with byte-stable output (sort_keys, indent 2) so
# re-pastes are byte-identical and docker restarts ONLY on real change.
# max-file MUST stay the STRING "5": docker rejects numeric 5.
# ---------------------------------------------------------------------------
DAEMON_CHANGED=0
CLOBBER_GUARD=0
DAEMON_ORIGINAL_EXTRAS_JSON=''

# Snapshot every daemon.json key EXCEPT log-driver/log-opts (sorted, so the
# post-merge self-check can byte-compare "human keys" before vs after).
# Missing file => '{}'; unparseable => sentinel INVALID.
daemon_snapshot_extras() {
  python3 - "$DAEMON_JSON_DIR/daemon.json" <<'DAEMON_SNAP_PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        obj = json.load(fh)
except FileNotFoundError:
    obj = {}
except Exception:
    print('INVALID')
    sys.exit(0)
print(json.dumps({k: v for k, v in obj.items()
                  if k not in ('log-driver', 'log-opts')}, sort_keys=True))
DAEMON_SNAP_PY
}

# Merged doc on stdout (log-driver + log-opts forced, human keys kept, sorted
# + indent 2 + one trailing newline = deterministic bytes). Exit 3 when the
# existing file is non-empty but not a valid JSON object -> caller refuses to
# overwrite it (a human's broken edit is never clobbered).
daemon_merged_doc() {
  python3 - "$1" <<'DAEMON_MERGE_PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        raw = fh.read()
except FileNotFoundError:
    raw = ''
if raw.strip():
    try:
        obj = json.loads(raw)
    except ValueError:
        sys.exit(3)
    if not isinstance(obj, dict):
        sys.exit(3)
else:
    obj = {}
obj['log-driver'] = 'json-file'
obj['log-opts'] = {'max-size': '10m', 'max-file': '5'}
sys.stdout.write(json.dumps(obj, sort_keys=True, indent=2) + '\n')
DAEMON_MERGE_PY
}

# MERGE (never clobber) daemon.json so every container created afterwards
# caps its json-file logs at max-size 10m x max-file 5. Same core logic in
# both modes; the only live/test split is the restart mechanism:
#   live: systemctl restart docker  (only when bytes changed)
#   test: append one line to $STATE/docker-restarts.log (tests assert the
#         restart count stays 1 across idempotent re-runs).
ensure_daemon_json() {
  if ! require_json_tool; then
    echo 'WARN: python3 missing; daemon.json log caps NOT applied; self-check will FAIL' >&2
    return 0
  fi
  local f="$DAEMON_JSON_DIR/daemon.json" merged tmp
  mkdir -p "$DAEMON_JSON_DIR"
  DAEMON_ORIGINAL_EXTRAS_JSON="$(daemon_snapshot_extras)"
  CLOBBER_GUARD=0
  DAEMON_CHANGED=0
  if ! merged="$(daemon_merged_doc "$f")"; then
    CLOBBER_GUARD=1
    echo "ERROR: $f is not valid JSON; refusing to overwrite" >&2
    return 0
  fi
  # tmp + cmp + rename (install_authorized_keys idiom): identical bytes =>
  # zero churn; different => atomic replace, remember to restart once.
  tmp="$DAEMON_JSON_DIR/daemon.json.tmp.$$"
  printf '%s\n' "$merged" > "$tmp"
  if cmp -s "$tmp" "$f"; then
    rm -f "$tmp"
  else
    mv -f "$tmp" "$f"
    DAEMON_CHANGED=1
  fi
  if [ "$DAEMON_CHANGED" = 1 ]; then
    if [ "$PROVISION_MODE" = live ]; then
      systemctl restart docker
    else
      mkdir -p "$STATE"
      printf 'restart\n' >> "$STATE/docker-restarts.log"
    fi
  fi
}

# Persistent journald: /var/log/journal must EXIST (journald then persists on
# its own), plus a drop-in capping usage at SystemMaxUse=2G so history
# survives reboots without eating the disk. The journald restart is
# unconditional — lightweight, safe with containers running; the
# restart-only-on-change rule is docker-specific churn avoidance.
ensure_journald_persistence() {
  local tmp
  mkdir -p "$JOURNAL_DIR" "$JOURNAL_DROPIN_DIR"
  tmp="$JOURNAL_DROPIN.tmp.$$"
  printf '[Journal]\nSystemMaxUse=2G\n' > "$tmp"
  mv -f "$tmp" "$JOURNAL_DROPIN"
  if [ "$PROVISION_MODE" = live ]; then
    systemctl restart systemd-journald
  else
    mkdir -p "$STATE"
    touch "$STATE/journald-restarted"
  fi
}

# ---------------------------------------------------------------------------
# Self-check predicates (set -e safe: every one runs inside `if` in check)
# ---------------------------------------------------------------------------
groups_of() {  # space-separated groups of the factory user
  local d g out=''
  if [ "$PROVISION_MODE" = live ]; then
    id -nG "$FACTORY_USER"
  else
    for d in "$STATE"/groups/*; do
      [ -e "$d" ] || continue
      g="${d##*/}"
      out="$out${out:+ }$g"
    done
    printf '%s\n' "$out"
  fi
}

chk_docker_active() {
  if [ "$PROVISION_MODE" = live ]; then
    systemctl is-active --quiet docker
  else
    [ -f "$STATE/docker.enabled" ]
  fi
}
chk_docker_repo() {  # Docker CE repo present, or the install could not have worked
  if [ "$PROVISION_MODE" = live ]; then
    [ -s "$KEYRING" ] && [ -s "$SOURCES_LIST" ]
  else
    [ -f "$STATE/apt-repo" ]
  fi
}
chk_compose_present() {
  if [ "$PROVISION_MODE" = live ]; then
    docker compose version >/dev/null 2>&1
  else
    [ -f "$STATE/apt.log" ] && grep -qx 'docker-compose-plugin' "$STATE/apt.log"
  fi
}
chk_user_exists() {
  if [ "$PROVISION_MODE" = live ]; then
    getent passwd "$FACTORY_USER" >/dev/null
  else
    [ -f "$STATE/users/$FACTORY_USER" ]
  fi
}
chk_group_only() {  # docker is the ONLY group
  [ "$(groups_of)" = "$FACTORY_GROUP" ]
}
chk_passwd_locked() {
  if [ "$PROVISION_MODE" = live ]; then
    [ "$(passwd -S "$FACTORY_USER" 2>/dev/null | awk '{print $2}')" = 'L' ]
  else
    [ -f "$STATE/users/$FACTORY_USER.locked" ]
  fi
}
chk_authorized_keys() {  # exists, mode 600, factory-owned, byte-exact key
  local f="$SSHDIR/authorized_keys"
  [ -f "$f" ] || return 1
  [ "$(stat_mode "$f")" = '600' ] || return 1
  [ "$(stat_user "$f")" = "$FACTORY_USER" ] || return 1
  printf '%s\n' "$FACTORY_SSH_PUBKEY" | cmp -s - "$f"
}
chk_appdir() {  # /opt/discord-bot is a directory owned by factory
  [ -d "$APPDIR" ] && [ "$(stat_user "$APPDIR")" = "$FACTORY_USER" ]
}
chk_no_sudo() {  # factory must fail `sudo -n true`; nothing under sudoers.d
  if [ "$PROVISION_MODE" = live ]; then
    if su -s /bin/bash "$FACTORY_USER" -c 'sudo -n true' >/dev/null 2>&1; then
      return 1
    fi
    return 0
  fi
  [ ! -e "$STATE/sudoers.d/$FACTORY_USER" ]
}
chk_daemon_json() {  # log caps present: json-file, 10m, "5" (STRING — docker requires it)
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  python3 - "$DAEMON_JSON_DIR/daemon.json" <<'DAEMON_CHK_PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        obj = json.load(fh)
except Exception:
    sys.exit(1)
opts = obj.get('log-opts') or {}
sys.exit(0 if (obj.get('log-driver') == 'json-file'
               and opts.get('max-size') == '10m'
               and opts.get('max-file') == '5') else 1)
DAEMON_CHK_PY
}
chk_daemon_json_extras() {  # human keys survived the merge (byte-compare of sorted dumps)
  if [ "$CLOBBER_GUARD" = 1 ]; then
    return 1
  fi
  local now orig="$DAEMON_ORIGINAL_EXTRAS_JSON"
  # Sourced-lib runs that never executed ensure_daemon_json (e.g. a lone
  # `self_check` after a prior full run) carry an empty baseline; a pristine
  # daemon.json has exactly the log caps and no extras => baseline '{}'.
  [ -n "$orig" ] || orig='{}'
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  now="$(daemon_snapshot_extras)" || return 1
  [ "$now" = "$orig" ]
}
chk_journald_persistent() {  # persistent dir + 2G cap drop-in + journald restarted
  if [ "$PROVISION_MODE" = live ]; then
    [ -d /var/log/journal ] \
      && grep -qx 'SystemMaxUse=2G' /etc/systemd/journald.conf.d/10-factory.conf \
      && systemctl is-active --quiet systemd-journald
  else
    [ -d "$JOURNAL_DIR" ] \
      && grep -qx 'SystemMaxUse=2G' "$JOURNAL_DROPIN" \
      && [ -f "$STATE/journald-restarted" ]
  fi
}

# ---------------------------------------------------------------------------
# Final self-check (last thing main does; its status is the script's exit)
# ---------------------------------------------------------------------------
CHECKS_RUN=0
CHECKS_PASS=0

check() {  # check NAME predicate... -> PASS/FAIL line; never aborts under set -e
  local name="$1"
  shift
  CHECKS_RUN=$((CHECKS_RUN + 1))
  if "$@"; then
    CHECKS_PASS=$((CHECKS_PASS + 1))
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s\n' "$name"
  fi
}

self_check() {
  CHECKS_RUN=0
  CHECKS_PASS=0
  check 'docker daemon active' chk_docker_active
  check 'docker CE apt repo configured' chk_docker_repo
  check 'docker compose plugin present' chk_compose_present
  check 'factory user exists' chk_user_exists
  check 'factory group membership is docker only' chk_group_only
  check 'factory password login disabled' chk_passwd_locked
  check 'authorized_keys mode 600 factory-owned with exact key' chk_authorized_keys
  check '/opt/discord-bot directory owned by factory' chk_appdir
  check 'factory has no sudo' chk_no_sudo
  check 'docker logging limits (daemon.json)' chk_daemon_json
  check 'daemon.json unrelated keys preserved' chk_daemon_json_extras
  check 'journald persistence configured' chk_journald_persistent
  printf 'SELF-CHECK: %d/%d PASS\n' "$CHECKS_PASS" "$CHECKS_RUN"
  [ "$CHECKS_PASS" -eq "$CHECKS_RUN" ]
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  require_valid_key
  if [ "$PROVISION_MODE" = live ]; then
    require_root
    require_debian12
    require_json_tool
  fi
  ensure_docker_repo
  ensure_packages
  enable_docker
  ensure_daemon_json
  ensure_journald_persistence
  ensure_group
  ensure_user
  install_authorized_keys "$SSHDIR" "$FACTORY_SSH_PUBKEY"
  ensure_app_dir
  self_check
}

# Testability hook: `source <thisfile> --source-lib` defines functions and
# returns without running main. Plain `bash <thisfile>` runs everything.
[ "${1:-}" = '--source-lib' ] && return 0 2>/dev/null || true

main "$@"
