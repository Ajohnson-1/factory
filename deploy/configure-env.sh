#!/usr/bin/env bash
#
# configure-env.sh — the deploy-time half of open-issues #4.
#
# `FACTORY_IPC_BIND` decides whether an agent container can reach the host's
# spawn channel at all. The default (loopback) is right on Docker Desktop and
# wrong on a Linux host, where `--add-host=host.docker.internal:host-gateway`
# arrives at the bridge address instead — so a freshly provisioned VPS comes up
# with an orchestrator whose every `spawn_agent` call fails, and nothing in the
# logs says which knob to turn. This script turns it, at install time, in the
# one file the service actually reads.
#
# Sourced by deploy/setup-factory.sh. Tested by
# test/deploy/configure-env.test.ts, which runs this file through bash against a
# temp env file — the only way to cover a shell function without provisioning a
# container.

IPC_BIND_ENV="FACTORY_IPC_BIND"
IPC_BIND_LINUX="0.0.0.0"

# configure_factory_env <env-file> [<uname-s>]
#
# Echoes one line about what it did, so the install log says the same thing the
# file now says. Returns 1 if the env file is missing: setup-factory.sh installs
# it first, so a miss here is a broken deploy, not a thing to paper over.
configure_factory_env() {
  local env_file="${1:-}" os="${2:-$(uname -s)}"

  if [[ -z "$env_file" || ! -f "$env_file" ]]; then
    echo "configure-env: no env file at '${env_file}' — nothing to configure" >&2
    return 1
  fi

  # Not a Linux host: the loopback default works (verified on Docker Desktop),
  # and widening a listener that does not need widening is the wrong tradeoff.
  if [[ "$os" != "Linux" ]]; then
    echo "configure-env: ${os} — leaving ${IPC_BIND_ENV} at its default"
    return 0
  fi

  # An operator who set it wins, including a previous run of this script. A
  # commented-out line from .env.example does NOT count: it is documentation,
  # and systemd would keep reading the default.
  if grep -Eq "^[[:space:]]*${IPC_BIND_ENV}=" "$env_file"; then
    echo "configure-env: ${IPC_BIND_ENV} already set — left as written"
    return 0
  fi

  cat >>"$env_file" <<BLOCK

# --- agent graph spawn channel (written by deploy/configure-env.sh) ---------
# On this Linux host a container reaches the host through the docker bridge, not
# through the host's loopback, so the 127.0.0.1 default is unreachable from
# inside an agent container and every spawn_agent call fails.
#
# The tradeoff being made: this port now answers on an interface other machines
# can route to, and what sits behind it can START CONTAINERS. A per-run token
# gates every request (minted for one card, revoked when that run ends), so the
# exposure is authenticated rather than open — but keep :\$FACTORY_IPC_PORT out
# of any public interface at the firewall.
${IPC_BIND_ENV}=${IPC_BIND_LINUX}
BLOCK

  echo "configure-env: Linux host — set ${IPC_BIND_ENV}=${IPC_BIND_LINUX} in ${env_file}"
}
