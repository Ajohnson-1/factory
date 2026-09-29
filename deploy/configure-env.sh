#!/usr/bin/env bash
#
# configure-env.sh — the deploy-time half of open-issues #4, plus the half #4
# missed.
#
# Two things have to be true before an agent container can talk to the host, and
# only one of them is a bind address:
#
#   1. The host has to be *listening* where a container can reach it. The default
#      is loopback, which is right on Docker Desktop and wrong on Linux, where a
#      container arrives through the docker bridge.
#   2. The name the container dials — `host.docker.internal` — has to *resolve*.
#      Docker Engine on Linux does not define it at all; Docker Desktop does. On
#      a Linux host it needs `--add-host=host.docker.internal:host-gateway`, or
#      every connection fails at DNS before the bind address is ever consulted.
#
# open-issues #4 fixed (1) and documented it, and the docs repeated the
# `--add-host` flag as though it were already being passed. It was not: no
# production caller ever set `addHosts`, so a fresh VPS following this script's
# advice still could not spawn a child. This file now writes both, because they
# are one requirement described in two places.
#
# Sourced by deploy/setup-factory.sh. Tested by
# test/deploy/configure-env.test.ts, which runs this file through bash against a
# temp env file — the only way to cover a shell function without provisioning a
# container.

IPC_BIND_ENV="FACTORY_IPC_BIND"
IPC_BIND_LINUX="0.0.0.0"
IPC_ADD_HOST_ENV="FACTORY_IPC_ADD_HOST"
IPC_ADD_HOST_LINUX="host.docker.internal:host-gateway"

# write_kv <env-file> <name> <value> <comment-block>
#
# Appends NAME=value with its explanation, unless the file already sets it.
# Returns 0 when it wrote, 1 when it left well enough alone. A commented-out line
# from .env.example does NOT count as set: it is documentation, and systemd would
# keep reading the default.
write_kv() {
  local env_file="$1" name="$2" value="$3" comment="$4"

  if grep -Eq "^[[:space:]]*${name}=" "$env_file"; then
    echo "configure-env: ${name} already set — left as written"
    return 1
  fi
  {
    printf '\n%s\n' "$comment"
    printf '%s=%s\n' "$name" "$value"
  } >>"$env_file"
  return 0
}

# configure_factory_env <env-file> [<uname-s>]
#
# Echoes one line per decision, so the install log says the same thing the file
# now says. Returns 1 if the env file is missing: setup-factory.sh installs it
# first, so a miss here is a broken deploy, not a thing to paper over.
configure_factory_env() {
  local env_file="${1:-}" os="${2:-$(uname -s)}"

  if [[ -z "$env_file" || ! -f "$env_file" ]]; then
    echo "configure-env: no env file at '${env_file}' — nothing to configure" >&2
    return 1
  fi

  # Not a Linux host: both defaults are right, loopback included, and verified so
  # by the smoke runs. Overriding the name mapping on Docker Desktop would point
  # the container at the bridge and break the one arrangement that works there.
  if [[ "$os" != "Linux" ]]; then
    echo "configure-env: ${os} — leaving ${IPC_BIND_ENV} and ${IPC_ADD_HOST_ENV} at their defaults"
    return 0
  fi

  local bind_comment='
# --- agent graph + PR review spawn channel (written by deploy/configure-env.sh)
#
# On this Linux host a container reaches the host through the docker bridge, not
# through the host'"'"'s loopback, so the 127.0.0.1 default is unreachable from
# inside an agent container and every host call fails — spawn_agent for the
# orchestrator, post_review for the reviewer.
#
# The tradeoff being made: this port now answers on an interface other machines
# can route to, and what sits behind it can START CONTAINERS and POST TO GITHUB.
# A per-run token gates every request (minted for one card or one review, revoked
# when that run ends), so the exposure is authenticated rather than open — but
# keep :$FACTORY_IPC_PORT out of any public interface at the firewall.'

  local add_host_comment='
# Docker Engine on Linux does not define host.docker.internal at all — that name
# is a Docker Desktop convenience. Without this mapping the container cannot
# resolve the host whatever FACTORY_IPC_BIND says, and the failure looks like a
# broken factory rather than a missing name. src/agent/container.ts passes it as
# --add-host on every agent run.'

  local wrote=0
  write_kv "$env_file" "$IPC_BIND_ENV" "$IPC_BIND_LINUX" "$bind_comment" && wrote=1
  write_kv "$env_file" "$IPC_ADD_HOST_ENV" "$IPC_ADD_HOST_LINUX" "$add_host_comment" && wrote=1

  if [[ "$wrote" == 1 ]]; then
    echo "configure-env: Linux host — wrote ${IPC_BIND_ENV}/${IPC_ADD_HOST_ENV} into ${env_file}"
  fi
}
