#!/usr/bin/env bash
# docker compose for the Cineko stack, from anywhere:
#   scripts/cineko.sh ps
#   scripts/cineko.sh logs -f api
#   scripts/cineko.sh exec -T api /martytv admin create --username NAME --role super_admin
# Loads deployments/compose.override.yaml (your local changes) when present.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE=${CINEKO_ENV_FILE:-$ROOT/.env}

# Optional parts are compose profiles (COMPOSE_PROFILES in .env, written by
# install.sh). An .env from before them ran every part: keep it that way.
if [ -f "$ENV_FILE" ] && ! grep -q '^CINEKO_PARTS_VERSION=' "$ENV_FILE"; then
  cur=$(grep '^COMPOSE_PROFILES=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)
  new=youtube,music,prowlarr,torrserver${cur:+,$cur}
  { grep -v '^COMPOSE_PROFILES=' "$ENV_FILE"
    echo "COMPOSE_PROFILES=$new"
    echo "CINEKO_PARTS_VERSION=1"; } > "$ENV_FILE.tmp" && chmod 600 "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  echo "cineko.sh: .env now lists the optional parts (COMPOSE_PROFILES=$new); re-run ./install.sh to change them" >&2
fi

files=(-f "$ROOT/deployments/compose.yaml")
[ -f "$ROOT/deployments/compose.override.yaml" ] && files+=(-f "$ROOT/deployments/compose.override.yaml")
exec docker compose "${files[@]}" --env-file "$ENV_FILE" "$@"
