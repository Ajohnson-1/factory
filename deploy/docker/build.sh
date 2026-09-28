#!/usr/bin/env bash
#
# build.sh — build the agent container image.
#
#   bash deploy/docker/build.sh            # -> factory-agent:latest
#   AGENT_IMAGE=registry/x:tag bash deploy/docker/build.sh
#
# The pi version inside the image is pinned to what package-lock.json resolves,
# so an agent container runs the same pi the orchestrator is built and tested
# against (and `pi --help`-level details like `--` option-parsing match too).
# Bumping @earendil-works/pi-coding-agent therefore means rebuilding this image;
# CI builds it on every push and deploy/setup-factory.sh rebuilds on deploy.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE=${AGENT_IMAGE:-factory-agent}

VERSION=$(node -e '
  const fs = require("fs");
  const name = "@earendil-works/pi-coding-agent";
  const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const resolved = lock.packages?.[`node_modules/${name}`]?.version;
  if (resolved) {
    process.stdout.write(resolved);
  } else {
    // no lockfile entry: fall back to the declared range minus its ^/~
    const pkg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const spec = pkg.dependencies[name];
    if (!spec) throw new Error(`no ${name} dependency`);
    process.stdout.write(spec.replace(/^[\^~]/, ""));
  }
' "$ROOT/package-lock.json" "$ROOT/package.json")

echo "[agent-image] building $IMAGE with pi@$VERSION"
# context is this directory only: the Dockerfile needs nothing from the repo.
docker build --pull -t "$IMAGE" --build-arg PI_VERSION="$VERSION" \
  -f "$HERE/factory-agent.Dockerfile" "$HERE"
echo "[agent-image] done: $IMAGE"
