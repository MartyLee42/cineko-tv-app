#!/usr/bin/env bash
# MartyTV third-party image updater: keeps Invidious and its companion on the
# newest published release (YouTube changes break old versions within days).
#
#   martytv-image-updater          check quay.io; upgrade what's newer
#   martytv-image-updater apply    re-apply saved pins to compose.yaml (deploy.sh
#                                  runs this, so a deploy never downgrades)
#
# Upgrade = pull, pin in /opt/martytv/compose.yaml, `docker compose up -d <svc>`,
# wait for healthy (≤ 120 s), then play a real video through Invidious (its
# info has streams AND the first bytes of one stream download); any failure →
# back to the previous tag. A container can be "healthy" while YouTube is
# broken (a bad companion release looked healthy). Pins are
# saved in /opt/martytv/image-pins (svc=image). Runs from
# martytv-image-updater.timer (every 5 min); installed by deployments/deploy.sh.
# Logs: journalctl -u martytv-image-updater
set -uo pipefail
DIR=${MARTYTV_DIR:-/opt/martytv}
COMPOSE=$DIR/compose.yaml
PINS=$DIR/image-pins
# A video that should always exist; MARTYTV_TEST_VIDEO overrides.
TEST_VIDEO=${MARTYTV_TEST_VIDEO:-dQw4w9WgXcQ}
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

inv_get() { docker exec martytv-invidious-1 wget -qO- -T 25 "http://127.0.0.1:3000$1" 2>/dev/null; }

# YouTube really works: the test video's info lists streams, and the first
# 64 KB of its audio stream download the way the players get it — Invidious
# answers latest_version with a redirect to the companion's videoplayback,
# which we fetch from the companion service (busybox wget: no Range header,
# it broke the request; `head` stops the download).
# A fresh companion may need a moment: up to 4 tries, 15 s apart.
plays() {
  local info itag loc url bytes
  for i in 1 2 3 4; do
    info=$(inv_get "/api/v1/videos/$TEST_VIDEO")
    itag=$(printf '%s' "$info" | jq -r '[.adaptiveFormats[]? | select((.type // "") | startswith("audio"))][0].itag // .adaptiveFormats[0]?.itag // empty' 2>/dev/null)
    if [ -n "$itag" ]; then
      loc=$(docker exec martytv-invidious-1 sh -c "wget -S -O /dev/null -T 25 'http://127.0.0.1:3000/latest_version?id=$TEST_VIDEO&itag=$itag&local=true' 2>&1" \
        | grep -i '^ *location: ' | tail -1 | sed -E 's/^ *[Ll]ocation: *//' | tr -d '\r')
      case "$loc" in
        /companion/*) url="http://companion:8282$loc" ;;
        http*) url=$loc ;;
        /*) url="http://127.0.0.1:3000$loc" ;;
        *) url="" ;;
      esac
      bytes=0
      [ -n "$url" ] && bytes=$(docker exec martytv-invidious-1 sh -c "timeout 40 wget -qO- -T 25 '$url' 2>/dev/null | head -c 65536 | wc -c" 2>/dev/null || echo 0)
      [ "${bytes:-0}" -ge 65536 ] && return 0
      log "test video $TEST_VIDEO: info ok, its stream gave ${bytes:-0} bytes (try $i)"
    else
      log "test video $TEST_VIDEO: no streams in its info (try $i)"
    fi
    [ "$i" -lt 4 ] && sleep 15
  done
  return 1
}

# Newest release tag of a quay.io repository matching the pattern.
newest() {
  local repo=${1#quay.io/}
  curl -fsS --max-time 30 "https://quay.io/api/v1/repository/$repo/tag/?limit=50&onlyActiveTags=true" \
    | jq -r --arg re "$2" '[.tags[] | select(.name | test($re))] | sort_by(.start_ts) | last | .name // empty'
}

# The release date of a tag: 2026.11.07-07ae73c → 2026.11.07, 2.20261103.0 → itself.
tagdate() { echo "${1%%-*}"; }

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
    # Only move forward. newest() is the latest push, so compare dates only:
    # same-day companion tags differ by commit hash, which doesn't sort.
    [ "$(printf '%s\n%s\n' "$(tagdate "${cur##*:}")" "$(tagdate "$tag")" | sort -V | tail -1)" = "$(tagdate "$tag")" ] || continue
    log "$svc: $cur → $want"
    timeout 900 docker pull -q "$want" >/dev/null || { log "$svc: pull failed"; continue; }
    pin "$svc" "$want" || continue
    docker compose up -d "$svc" >/dev/null 2>&1
    if healthy "$svc" && plays; then
      save_pin "$svc" "$want"
      log "$svc: upgraded to $tag (test video plays)"
    else
      log "$svc: $tag not healthy or the test video doesn't play; rolling back to $cur"
      pin "$svc" "$cur"
      docker compose up -d "$svc" >/dev/null 2>&1
      if healthy "$svc" && plays; then log "$svc: back on $cur, test video plays"; else log "$svc: still broken after rollback"; fi
    fi
  done
}

case "${1:-check}" in
  apply) apply ;;
  check) check ;;
  *) echo "usage: $0 [check|apply]" >&2; exit 2 ;;
esac
