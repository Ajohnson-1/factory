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

# The orchestrator's custom tool, baked in rather than mounted.
#
# An extension resolves its imports from its own directory upward, and pi's own
# dependencies are nested inside its package — `@earendil-works/pi-ai` is not in
# `$(npm root -g)`. Mounting the extension anywhere else fails the import with
# ERR_MODULE_NOT_FOUND (verified against this image). /opt/factory/node_modules
# links the two packages the extension is allowed to import, and the check below
# fails the *build* if that layout ever stops holding, instead of failing a card
# at run time.
RUN set -eux; \
    ROOT="$(npm root -g)"; \
    PI="$ROOT/@earendil-works/pi-coding-agent"; \
    test -f "$PI/package.json"; \
    mkdir -p /opt/factory/extensions /opt/factory/node_modules/@earendil-works; \
    ln -s "$PI" /opt/factory/node_modules/@earendil-works/pi-coding-agent; \
    for pkg in pi-ai pi-agent-core; do \
      if [ -d "$PI/node_modules/@earendil-works/$pkg" ]; then \
        ln -s "$PI/node_modules/@earendil-works/$pkg" "/opt/factory/node_modules/@earendil-works/$pkg"; \
      elif [ -d "$ROOT/@earendil-works/$pkg" ]; then \
        ln -s "$ROOT/@earendil-works/$pkg" "/opt/factory/node_modules/@earendil-works/$pkg"; \
      fi; \
    done; \
    test -d /opt/factory/node_modules/@earendil-works/pi-ai; \
    cd /opt/factory; \
    node --input-type=module -e "import('@earendil-works/pi-ai').then((m) => process.exit(m.Type ? 0 : 1)).catch(() => process.exit(1))"; \
    node --input-type=module -e "import('@earendil-works/pi-coding-agent').then((m) => process.exit(m.defineTool ? 0 : 1)).catch(() => process.exit(1))"

# Both extensions, baked together. Copying the directory rather than naming each
# file means a third role with a custom tool cannot ship a source file the image
# quietly leaves out — the failure it prevents is a container that starts, loads no
# tool, and reports a model that refused to use it.
COPY extensions/ /opt/factory/extensions/

# The only repository in sight is the one the orchestrator mounted on purpose,
# and its owner uid will not match ours, so git's "dubious ownership" check has
# nothing here to protect. The mount is read-only: the agent can read history and
# diff, but cannot commit, rewrite refs, or touch hooks.
RUN git config --system --add safe.directory '*'

WORKDIR /work
USER agent
ENV HOME=/home/agent
ENTRYPOINT ["pi"]
