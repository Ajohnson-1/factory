# factory-agent — the image every agent session runs in (phase 2.1).
#
# The container is the secret boundary. An agent run gets the card's worktree at
# /work, a read-only mount of the repo's shared .git, and the LLM provider key
# allowlisted in src/agent/env.ts. The orchestrator's .env, its Trello/GitHub/
# Discord credentials and `git push` never come in here.
#
# Build with deploy/docker/build.sh (it pins PI_VERSION to package-lock.json).
FROM node:22-slim

ARG PI_VERSION

# bash + git + ripgrep are what pi's own tools drive; ca-certificates is what
# lets it reach an HTTPS API. node:22-slim ships none of git/ripgrep.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts \
  "@earendil-works/pi-coding-agent@${PI_VERSION:-latest}"

# Non-root. The home directory stays group/world writable on purpose: the
# orchestrator starts containers with `--user <host uid>:<host gid>` so files the
# agent writes are owned by the factory user on the host, and pi still needs a
# writable HOME for ~/.pi/agent.
RUN useradd -m agent \
  && mkdir -p /home/agent/.pi/agent \
  && chmod -R 0777 /home/agent

# The only repository in sight is the one the orchestrator mounted on purpose,
# and its owner uid will not match ours, so git's "dubious ownership" check has
# nothing here to protect. The mount is read-only: the agent can read history and
# diff, but cannot commit, rewrite refs, or touch hooks.
RUN git config --system --add safe.directory '*'

WORKDIR /work
USER agent
ENV HOME=/home/agent
ENTRYPOINT ["pi"]
