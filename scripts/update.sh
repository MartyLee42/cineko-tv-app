#!/usr/bin/env bash
# Updates Cineko: pulls the new code, then new images (or rebuilds them),
# and restarts what changed. Data and .env are kept.
#
#   scripts/update.sh            prebuilt images from GHCR (falls back to building)
#   scripts/update.sh --build    always build from source
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
dc() { "$ROOT/scripts/cineko.sh" "$@"; }

if [ -d .git ]; then
  echo "==> git pull"
  git pull --ff-only
fi
OURS=(api transcoder music web)
echo "==> images"
dc pull --ignore-buildable -q            # third-party (pinned in compose.yaml)
if [ "${1:-}" = --build ] || ! dc pull -q "${OURS[@]}"; then
  echo "    building Cineko images from source"
  dc build --pull "${OURS[@]}"
fi
echo "==> restarting"
dc up -d --remove-orphans
for i in $(seq 1 60); do
  if dc exec -T api /martytv healthcheck >/dev/null 2>&1; then echo "==> api healthy"; break; fi
  sleep 3
  [ "$i" -lt 60 ] || { echo "api not healthy after 3 minutes: scripts/cineko.sh logs api" >&2; exit 1; }
done
dc ps --format 'table {{.Service}}\t{{.Status}}'
echo "Old images can be removed with: docker image prune   (removes all dangling images)"
