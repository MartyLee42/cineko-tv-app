#!/usr/bin/env bash
# Backs up Cineko: the database (pg_dump), the music library (SQLite),
# Prowlarr's and TorrServer's settings, and .env, into one directory.
#
#   scripts/backup.sh [DIR]      default: ./backups/<date-time>
#
# Restore: see docs/deployment.md "Backup and restore". Caches (images,
# YouTube audio, HLS) and server downloads are not included.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dc() { "$ROOT/scripts/cineko.sh" "$@"; }
OUT=${1:-$ROOT/backups/$(date +%Y%m%d-%H%M%S)}
umask 077
mkdir -p "$OUT"

echo "==> database"
dc exec -T postgres pg_dump -U martytv -Fc martytv > "$OUT/cineko.dump"

echo "==> music library"
# The SQLite library (consistent enough when idle; stop music for a strict copy).
dc exec -T music sh -c 'cd /data && tar -cf - music.db*' > "$OUT/music-data.tar" \
  || echo "    (music volume not backed up)"

echo "==> prowlarr + torrserver settings"
dc exec -T prowlarr tar -C /config -cf - --exclude=./logs --exclude=./Backups . > "$OUT/prowlarr-config.tar" || echo "    (prowlarr skipped)"
dc exec -T torrserver tar -C /opt/ts -cf - config > "$OUT/torrserver-config.tar" || echo "    (torrserver skipped)"

cp "${CINEKO_ENV_FILE:-$ROOT/.env}" "$OUT/env"
[ -f "$ROOT/gluetun.env" ] && cp "$ROOT/gluetun.env" "$OUT/gluetun.env"
echo "==> backup in $OUT (contains secrets: keep it private)"
ls -lh "$OUT"
