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
# Pages opened before this update (a TV runs one for days) keep loading their
# release's lazy chunks: the new web container archives its own assets at
# start; the release running now goes into the archive here first (its image
# may predate the archive). Existing files are kept; copies are dated now.
if [ -n "$(dc ps -q web 2>/dev/null)" ]; then
  echo "==> asset archive"
  dc exec -T web tar -C /srv -cf - web/assets tv/assets 2>/dev/null \
    | dc run --rm -T --no-deps web seed \
    || echo "    previous release's assets not archived (its pages reload once instead)" >&2
fi
echo "==> restarting"
dc up -d --remove-orphans
for i in $(seq 1 60); do
  if dc exec -T api /martytv healthcheck >/dev/null 2>&1; then echo "==> api healthy"; break; fi
  sleep 3
  [ "$i" -lt 60 ] || { echo "api not healthy after 3 minutes: scripts/cineko.sh logs api" >&2; exit 1; }
done
# TorrServer settings from .env (TORRSERVER_CACHE_MB, …): a no-op unless
# they changed; never restarts TorrServer.
echo "==> TorrServer settings"
sh "$ROOT/scripts/torrserver-settings.sh" || echo "    not applied (above): scripts/torrserver-settings.sh" >&2
dc ps --format 'table {{.Service}}\t{{.Status}}'
echo "Old images can be removed with: docker image prune   (removes all dangling images)"
