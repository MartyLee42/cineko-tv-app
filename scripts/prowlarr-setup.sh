#!/usr/bin/env bash
# Configures a fresh Prowlarr for Cineko. Runs INSIDE the prowlarr container
# (the linuxserver image ships bash, curl and jq); install.sh calls it as
#
#   docker compose exec -T -e INDEXERS=... prowlarr bash -s < scripts/prowlarr-setup.sh
#
# Idempotent: adds the FlareSolverr indexer proxy (tag "flaresolverr") and
# the INDEXERS that aren't there yet. A failing indexer (site down, blocked)
# is reported and skipped, never fatal. Your own changes are never touched.
#
# INDEXERS: comma-separated Prowlarr definition names; ":fs" = route through
# FlareSolverr (Cloudflare-protected sites).
set -uo pipefail

API=http://127.0.0.1:9696/api/v1
KEY=$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' /config/config.xml | tr -d '\r\n')
[ -n "$KEY" ] || { echo "  ! no API key in /config/config.xml" >&2; exit 1; }
INDEXERS=${INDEXERS:-rutor,thepiratebay,1337x:fs,yts,eztv,limetorrents}
FLARESOLVERR_URL=${FLARESOLVERR_URL:-http://flaresolverr:8191/}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
rc=0

# api METHOD PATH [BODY_FILE] → body on stdout, HTTP status in $TMP/status
api() {
  local args=(-sS -o "$TMP/body" -w '%{http_code}' -X "$1" -H "X-Api-Key: $KEY" -H 'Content-Type: application/json' --max-time 120)
  [ -n "${3:-}" ] && args+=(--data-binary "@$3")
  curl "${args[@]}" "$API$2" > "$TMP/status" 2>"$TMP/err" || echo 000 > "$TMP/status"
  cat "$TMP/body" 2>/dev/null
}
status() { cat "$TMP/status"; }
okcode() { case "$(status)" in 2??) return 0 ;; esac; return 1; }
errmsg() { jq -r 'if type=="array" then map(.errorMessage // .message // empty) | join("; ") else (.message // .errorMessage // tostring) end' "$TMP/body" 2>/dev/null | head -c 300; }

# --- tag + FlareSolverr proxy ---------------------------------------------------
tags=$(api GET /tag)
tag_id=$(jq -r '.[] | select(.label=="flaresolverr") | .id' <<<"$tags" | head -1)
if [ -z "$tag_id" ]; then
  echo '{"label":"flaresolverr"}' > "$TMP/req"
  tag_id=$(api POST /tag "$TMP/req" | jq -r '.id // empty')
fi
[ -n "$tag_id" ] || { echo "  ! couldn't create the flaresolverr tag" >&2; rc=1; }

if [ -n "$tag_id" ]; then
  if api GET /indexerproxy | jq -e '.[] | select(.implementation=="FlareSolverr")' >/dev/null; then
    echo "  ✓ FlareSolverr proxy already configured"
  else
    api GET /indexerproxy/schema | jq --arg url "$FLARESOLVERR_URL" --argjson tag "$tag_id" '
      .[] | select(.implementation=="FlareSolverr")
      | .name = "FlareSolverr" | .tags = [$tag]
      | .fields |= map(if .name=="host" then .value = $url
                       elif .name=="requestTimeout" then .value = 60 else . end)' > "$TMP/req"
    if [ -s "$TMP/req" ]; then
      api POST "/indexerproxy?forceSave=true" "$TMP/req" >/dev/null
      if okcode; then echo "  ✓ FlareSolverr proxy added (tag \"flaresolverr\")"
      else echo "  ! FlareSolverr proxy: HTTP $(status) $(errmsg)" >&2; rc=1; fi
    else
      echo "  ! this Prowlarr has no FlareSolverr proxy type" >&2; rc=1
    fi
  fi
fi

# --- indexers --------------------------------------------------------------------
profile=$(api GET /appprofile | jq -r '.[0].id // 1')
existing=$(api GET /indexer | jq -r '.[].definitionName' 2>/dev/null)
api GET /indexer/schema > "$TMP/schema.json"
okcode || { echo "  ! couldn't read indexer definitions (HTTP $(status))" >&2; exit 1; }

IFS=',' read -r -a wanted <<<"$INDEXERS"
for item in "${wanted[@]}"; do
  item=$(echo "$item" | tr -d ' ')
  [ -n "$item" ] || continue
  def=${item%%:*}; fs=0; [ "$item" != "$def" ] && [ "${item#*:}" = fs ] && fs=1
  if grep -qxF "$def" <<<"$existing"; then echo "  ✓ $def already added"; continue; fi
  jq --arg d "$def" --argjson p "$profile" --argjson fs "$fs" --argjson tag "${tag_id:-0}" '
    [.[] | select(.definitionName == $d)][0] // empty
    | .enable = true | .appProfileId = $p | .priority = 25
    | .tags = (if $fs == 1 and $tag > 0 then [$tag] else [] end)' "$TMP/schema.json" > "$TMP/req"
  if [ ! -s "$TMP/req" ]; then echo "  ! $def: no such indexer definition (skipped)" >&2; continue; fi
  name=$(jq -r .name "$TMP/req")
  api POST /indexer "$TMP/req" >/dev/null
  if okcode; then echo "  ✓ added $name"
  else echo "  ! $name not added — HTTP $(status): $(errmsg) (site unreachable? add it later in Prowlarr's UI)" >&2; fi
done
exit $rc
