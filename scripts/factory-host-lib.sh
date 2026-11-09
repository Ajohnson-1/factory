#!/usr/bin/env bash
# Shared idempotent helpers for scripts/provision-factory-host.sh (FM-5,
# card 6aee5f4d6e98279cb3ab3304; docs/factory-migration.md §6.1).
#
# Same adapters as scripts/provision-deploy-host.sh: portable stat, owner/
# mode setter with a test-mode fold, atomic byte-stable writes, and the
# PASS/FAIL self-check harness whose counter result gates the script's
# exit. Sourced, never executed; bash 3.2 compatible (the gate host is
# macOS). PROVISION_MODE (live|test) + FACTORY_USER/FACTORY_GROUP come
# from the sourcing script's environment.

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

# set_owner_mode user group mode path — chown+chmod in live mode; in test
# mode the owner args fold to the current user (non-root can always chown
# to itself and its primary group).
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

# write_file_atomic path mode content — tmp write, chmod, rename (rename
# inside one directory is atomic; readers never see a partial file).
# Byte-stable re-runs: identical content -> identical bytes -> callers may
# diff to decide whether anything changed.
write_file_atomic() {
  local path="$1" mode="$2" content="$3" tmp
  tmp="$path.tmp.$$"
  printf '%s\n' "$content" > "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$path"
}

# ensure_repo dir url — git clone when absent; ALWAYS (re-)set
# `git config user.name factory` (§6.1 step 3, deploy-history actor).
# Test mode: no network — stamp `.git` + the git config file the checks read.
ensure_repo() {
  local dir="$1" url="$2"
  if [ ! -d "$dir/.git" ]; then
    mkdir -p "$(dirname "$dir")"
    if [ "$PROVISION_MODE" = live ]; then
      git clone "$url" "$dir" || { echo "ERROR: clone failed: $url -> $dir" >&2; return 1; }
    else
      mkdir -p "$dir/.git"
    fi
  fi
  if [ "$PROVISION_MODE" = live ]; then
    git -C "$dir" config user.name factory
  else
    mkdir -p "$dir/.git"
    printf '[core]\n\tuser = factory\n' > "$dir/.git/config"
  fi
}

# ---------------------------------------------------------------------------
# Self-check harness (mirrors provision-deploy-host.sh: PASS/FAIL lines, the
# counts gate the script's exit; `check` never aborts under set -e)
# ---------------------------------------------------------------------------
CHECKS_RUN=0
CHECKS_PASS=0

check() {  # check NAME predicate... -> PASS/FAIL line
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

finish_checks() {
  printf 'SELF-CHECK: %d/%d PASS\n' "$CHECKS_PASS" "$CHECKS_RUN"
  [ "$CHECKS_PASS" -eq "$CHECKS_RUN" ]
}
