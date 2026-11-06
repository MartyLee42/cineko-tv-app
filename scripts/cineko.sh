#!/usr/bin/env bash
# docker compose for the Cineko stack, from anywhere:
#   scripts/cineko.sh ps
#   scripts/cineko.sh logs -f api
#   scripts/cineko.sh exec -T api /martytv admin create --username NAME --role super_admin
# Loads deployments/compose.override.yaml (your local changes) when present.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
files=(-f "$ROOT/deployments/compose.yaml")
[ -f "$ROOT/deployments/compose.override.yaml" ] && files+=(-f "$ROOT/deployments/compose.override.yaml")
exec docker compose "${files[@]}" --env-file "${CINEKO_ENV_FILE:-$ROOT/.env}" "$@"
