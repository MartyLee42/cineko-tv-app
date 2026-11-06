#!/usr/bin/env bash
# MartyTV third-party image updater: keeps Invidious and its companion on the
# newest published release (YouTube changes break old versions within days).
#
#   martytv-image-updater          check quay.io; upgrade what's newer
#   martytv-image-updater apply    re-apply saved pins to compose.yaml (deploy.sh
#                                  runs this, so a deploy never downgrades)
#
# Upgrade = pull, pin in /opt/martytv/compose.yaml, `docker compose up -d <svc>`,
# wait for healthy (≤ 120 s); unhealthy → back to the previous tag. Pins are
# saved in /opt/martytv/image-pins (svc=image). Runs from
# martytv-image-updater.timer (every 6 h); installed by deployments/deploy.sh.
# Logs: journalctl -u martytv-image-updater
set -uo pipefail
DIR=${MARTYTV_DIR:-/opt/martytv}
COMPOSE=$DIR/compose.yaml
PINS=$DIR/image-pins
# service  repository                          tag pattern (releases only)
SERVICES=(
  "companion quay.io/invidious/invidious-companion ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9a-f]{7}$"
  "invidious quay.io/invidious/invidious ^2\.[0-9]{8}\.[0-9]+$"
)

log() { echo "[image-updater] $*"; }

# Current image of a service in compose.yaml.
current() { awk -v s="  $1:" '$0==s{f=1;next} f&&/^  [a-z]/{f=0} f&&/^    image:/{print $2; exit}' "$COMPOSE"; }

# Replace the image line of service $1 with $2.
pin() {
  local tmp
  tmp=$(mktemp "$DIR/.compose.XXXXXX") || return 1
  awk -v s="  $1:" -v img="$2" '$0==s{f=1;print;next} f&&/^  [a-z]/{f=0} f&&/^    image:/{print "    image: " img; f=0; next} {print}' "$COMPOSE" >"$tmp" \
    && chmod --reference="$COMPOSE" "$tmp" && mv "$tmp" "$COMPOSE"
}

save_pin() {
  touch "$PINS"; chmod 600 "$PINS"
  grep -v "^$1=" "$PINS" >"$PINS.new" || true
  echo "$1=$2" >>"$PINS.new"; mv "$PINS.new" "$PINS"
}

healthy() {
  local c="martytv-$1-1" s
  for _ in $(seq 1 24); do
    s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohc-{{.State.Status}}{{end}}' "$c" 2>/dev/null || true)
    case "$s" in healthy | nohc-running) return 0 ;; esac
    sleep 5
  done
  return 1
}

# Newest release tag of a quay.io repository matching the pattern.
newest() {
  local repo=${1#quay.io/}
  curl -fsS --max-time 30 "https://quay.io/api/v1/repository/$repo/tag/?limit=50&onlyActiveTags=true" \
    | jq -r --arg re "$2" '[.tags[] | select(.name | test($re))] | sort_by(.start_ts) | last | .name // empty'
}

apply() {
  [ -f "$PINS" ] || exit 0
  while IFS='=' read -r svc img; do
    [ -n "$svc" ] && [ -n "$img" ] || continue
    cur=$(current "$svc")
    if [ -n "$cur" ] && [ "$cur" != "$img" ]; then
      pin "$svc" "$img" && log "$svc: keeping $img (was $cur in the deployed compose)"
    fi
  done <"$PINS"
  return 0
}

check() {
  cd "$DIR" || exit 1
  for line in "${SERVICES[@]}"; do
    read -r svc repo re <<<"$line"
    cur=$(current "$svc")
    [ -n "$cur" ] || continue
    tag=$(newest "$repo" "$re") || { log "$svc: can't reach quay.io"; continue; }
    [ -n "$tag" ] || continue
    want="$repo:$tag"
    [ "$want" = "$cur" ] && continue
    # Only move forward: release tags sort by date.
    [ "$(printf '%s\n%s\n' "${cur##*:}" "$tag" | sort -V | tail -1)" = "$tag" ] || continue
    log "$svc: $cur → $want"
    timeout 900 docker pull -q "$want" >/dev/null || { log "$svc: pull failed"; continue; }
    pin "$svc" "$want" || continue
    docker compose up -d "$svc" >/dev/null 2>&1
    if healthy "$svc"; then
      save_pin "$svc" "$want"
      log "$svc: upgraded to $tag"
    else
      log "$svc: $tag not healthy; rolling back to $cur"
      pin "$svc" "$cur"
      docker compose up -d "$svc" >/dev/null 2>&1
      healthy "$svc" || log "$svc: still unhealthy after rollback"
    fi
  done
}

case "${1:-check}" in
  apply) apply ;;
  check) check ;;
  *) echo "usage: $0 [check|apply]" >&2; exit 2 ;;
esac
