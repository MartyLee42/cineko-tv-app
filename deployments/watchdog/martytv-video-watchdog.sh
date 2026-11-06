#!/bin/sh
# MartyTV «Видео» watchdog (run every 2 min by martytv-video-watchdog.timer).
#
# After the VPN (awg-socks) drops for a while, Invidious can stay stuck with a
# pool of dead YouTube connections ("Could not check out a connection") even
# once the VPN is back; and the companion's PO token can expire (videos fail
# while search works). Both are cured by restarting our own container.
#
# Rules: act only when the VPN proxy itself works (restarting can't fix a VPN
# outage); two failed checks in a row before acting; at most one restart per
# container per 15 minutes.
#
# VPN self-heal (allowed by the owner, 31 Oct 2026): awg-socks sometimes stops
# resolving names (TMDB and YouTube both fail through it) and only a restart
# helps. It is restarted — `docker restart awg-socks`, nothing else, never its
# config — when, 3 checks in a row (~6 min): YouTube AND TMDB both fail through
# the proxy while the host's own internet works. At most once per hour.
set -u
STATE=${STATE_DIRECTORY:-/var/lib/martytv-video-watchdog}
PROXY=socks5h://127.0.0.1:10809
INV=martytv-invidious-1
COMP=martytv-companion-1
COOLDOWN=900
VPN=awg-socks
VPN_COOLDOWN=3600
VPN_FAILS_TO_ACT=3
now=$(date +%s)
log() { echo "$*"; }

# 0. VPN self-heal (see header). Any HTTP answer counts (TMDB says 401 without a key).
via_vpn() { c=$(curl -s -o /dev/null -w '%{http_code}' -m 12 -x "$PROXY" "$1" 2>/dev/null); [ -n "$c" ] && [ "$c" != 000 ]; }
vpn_check() {
  docker inspect -f '{{.State.Running}}' "$VPN" 2>/dev/null | grep -q true || return 0 # not running: someone stopped it on purpose
  if via_vpn https://www.youtube.com/generate_204 || via_vpn https://api.themoviedb.org/3/configuration; then
    echo 0 > "$STATE/vpn.fails"; return 0
  fi
  # The host's own internet down? Restarting the VPN won't help.
  if ! curl -s -o /dev/null -m 10 https://1.1.1.1/ && ! curl -s -o /dev/null -m 10 https://www.google.com/generate_204; then
    log "vpn: host internet down too; waiting"; return 1
  fi
  vf=$(( $(cat "$STATE/vpn.fails" 2>/dev/null || echo 0) + 1 ))
  echo "$vf" > "$STATE/vpn.fails"
  vlast=$(cat "$STATE/vpn.restarted" 2>/dev/null || echo 0)
  if [ "$vf" -lt "$VPN_FAILS_TO_ACT" ]; then log "vpn: YouTube and TMDB fail through the proxy ($vf/$VPN_FAILS_TO_ACT)"; return 1; fi
  if [ $(( now - vlast )) -lt "$VPN_COOLDOWN" ]; then log "vpn: still failing; restarted $(( now - vlast ))s ago, waiting"; return 1; fi
  log "vpn: down for $vf checks with the host online: restarting $VPN"
  docker restart "$VPN" >/dev/null && echo "$now" > "$STATE/vpn.restarted" && echo 0 > "$STATE/vpn.fails"
  return 1
}
vpn_check
vpn_ok=$?

docker inspect -f '{{.State.Running}}' "$INV" 2>/dev/null | grep -q true || exit 0 # «Видео» not deployed / stopped on purpose

# 1. Is the VPN itself up? If not, there's nothing to fix on our side.
if [ "$vpn_ok" != 0 ] || ! curl -s -o /dev/null -m 12 -x "$PROXY" https://www.youtube.com/generate_204; then
  log "vpn proxy not answering: waiting (no Invidious restart)"
  echo 0 > "$STATE/inv.fails"; echo 0 > "$STATE/comp.fails"
  exit 0
fi

inv_get() { docker exec "$INV" wget -qO- -T 25 "http://127.0.0.1:3000$1" 2>/dev/null; }

# check NAME OK? CONTAINER — counts failures, restarts on the second, with a cooldown.
check() {
  name=$1 ok=$2 ctr=$3
  if [ "$ok" = 1 ]; then echo 0 > "$STATE/$name.fails"; return; fi
  fails=$(( $(cat "$STATE/$name.fails" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$STATE/$name.fails"
  last=$(cat "$STATE/$name.restarted" 2>/dev/null || echo 0)
  if [ "$fails" -lt 2 ]; then log "$name check failed ($fails), will retry"; return; fi
  if [ $(( now - last )) -lt "$COOLDOWN" ]; then log "$name still failing; restarted $(( now - last ))s ago, waiting"; return; fi
  log "$name failing with the VPN up: restarting $ctr"
  docker restart "$ctr" >/dev/null && echo "$now" > "$STATE/$name.restarted" && echo 0 > "$STATE/$name.fails"
}

# 2. Invidious answers YouTube searches?
if inv_get "/api/v1/search?q=music" | grep -q videoId; then search=1; else search=0; fi
check inv "$search" "$INV"

# 3. Search works but videos have no streams → the companion (PO token).
if [ "$search" = 1 ]; then
  if inv_get "/api/v1/videos/dQw4w9WgXcQ" | grep -q adaptiveFormats; then video=1; else video=0; fi
  check comp "$video" "$COMP"
fi
exit 0
