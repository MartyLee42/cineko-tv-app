#!/bin/sh
# Entry point of the web image (Caddy): before Caddy starts, adds this build's
# hashed assets (PWA /assets/*, TV app /tv/assets/*) to the asset archive —
# a volume at $ASSET_ARCHIVE_DIR that outlives deploys — and prunes it. Pages
# opened before a deploy (a TV runs one for days) still load their own
# release's lazy chunks from there (Caddyfile: current build first, then the
# archive). Only immutable hashed files go in: never index.html, sw.js or the
# manifest. A file goes once it is older than ASSET_ARCHIVE_DAYS (default 14)
# AND none of the last ASSET_ARCHIVE_RELEASES (default 3) releases had it.
# No volume mounted (the directory is absent): nothing to do.
# The music service does the same for Cineko Music (services/music/assetarchive.go).
set -eu

ARCHIVE=${ASSET_ARCHIVE_DIR:-/srv/asset-archive}
DAYS=${ASSET_ARCHIVE_DAYS:-14}
KEEP=${ASSET_ARCHIVE_RELEASES:-3}

# archive_app <name> <build dir>: <build>/assets/* → $ARCHIVE/<name>/assets/.
archive_app() {
  name=$1 build=$2
  [ -d "$build/assets" ] || return 0
  dst="$ARCHIVE/$name/assets" lists="$ARCHIVE/$name/releases"
  mkdir -p "$dst" "$lists"
  list=$(mktemp)
  (cd "$build/assets" && find . -type f | sed 's#^\./##' | sort) > "$list"
  while IFS= read -r f; do
    if [ ! -f "$dst/$f" ]; then
      mkdir -p "$(dirname "$dst/$f")"
      # Whole files only: a request never sees half a chunk.
      cp "$build/assets/$f" "$dst/$f.tmp" && mv "$dst/$f.tmp" "$dst/$f"
    fi
    # The running release's files count as new (never pruned while live).
    touch "$dst/$f"
  done < "$list"
  # One list per release (a restart of the same build adds none).
  last=$(find "$lists" -name '*.list' | sort | tail -n 1)
  if [ -n "$last" ] && cmp -s "$list" "$last"; then rm -f "$list"
  else mv "$list" "$lists/$(date -u +%Y%m%d%H%M%S)-$$.list"; fi
  # Prune: old files no recent release has, and old lists.
  recent=$(find "$lists" -name '*.list' | sort | tail -n "$KEEP")
  keep=$(mktemp)
  # shellcheck disable=SC2086 # the list paths have no spaces
  cat $recent | sort -u > "$keep"
  (cd "$dst" && find . -type f -mtime +"$DAYS" | sed 's#^\./##') | while IFS= read -r f; do
    grep -qxF "$f" "$keep" || rm -f "$dst/$f"
  done
  find "$lists" -name '*.list' -mtime +"$DAYS" | while IFS= read -r l; do
    echo "$recent" | grep -qxF "$l" || rm -f "$l"
  done
  rm -f "$keep"
  find "$dst" -name '*.tmp' -mmin +10 -exec rm -f {} + 2>/dev/null || true
}

# `seed`: a tar of <app>/assets/… on stdin (the files of the release that ran
# before this image's: scripts/update.sh, deployments/deploy.sh) goes into the
# archive. Files already there are kept; the copies are dated now.
if [ "${1:-}" = seed ]; then
  tmp=$(mktemp -d)
  tar -C "$tmp" -xf -
  (cd "$tmp" && find . -type f | sed 's#^\./##') | while IFS= read -r f; do
    [ -e "$ARCHIVE/$f" ] && continue
    mkdir -p "$(dirname "$ARCHIVE/$f")"
    cp "$tmp/$f" "$ARCHIVE/$f.tmp" && mv "$ARCHIVE/$f.tmp" "$ARCHIVE/$f"
  done
  rm -rf "$tmp"
  exit 0
fi

if [ -d "$ARCHIVE" ]; then
  # Never keep Caddy from starting over the archive.
  archive_app web /srv/web || echo "asset archive: web failed" >&2
  archive_app tv /srv/tv || echo "asset archive: tv failed" >&2
fi

exec "$@"
