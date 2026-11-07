#!/bin/sh
# Applies Cineko's TorrServer settings from .env (install.sh and update.sh run
# it; safe to run any time):
#
#   TORRSERVER_CACHE_MB=128               RAM cache per torrent (CacheSize)
#   TORRSERVER_REMOVE_CACHE_ON_DROP=true  delete a torrent's cache when it closes
#   TORRSERVER_RUTOR_SEARCH=false         TorrServer's own rutor search (Cineko
#                                         searches through Prowlarr / Jacred)
#
#   scripts/torrserver-settings.sh                 the bundled compose service
#   scripts/torrserver-settings.sh --restart       …then restart TorrServer
#   scripts/torrserver-settings.sh --url http://127.0.0.1:5665
#                                  a TorrServer reachable from this machine
#   scripts/torrserver-settings.sh --container NAME [--url URL]
#                                  run the requests inside container NAME
#                                  (default URL there: http://127.0.0.1:8090)
#
# Reads the full settings (POST /settings {"action":"get"}), changes only
# these three fields and writes the whole object back ("set" replaces all of
# them). Nothing is written when they already match: a "set" makes TorrServer
# drop every open torrent and reconnect, which interrupts whatever is
# streaming (Cineko, Lampa, MSX). The new values apply right away; --restart
# is never needed for them. Needs only docker (or curl/wget with --url), sed.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=${CINEKO_ENV_FILE:-$ROOT/.env}
MODE=compose URL="" CONTAINER="" RESTART=0 WAIT=${TORRSERVER_WAIT:-120}

usage() { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --restart) RESTART=1 ;;
    --url) URL=${2:?--url needs a value}; shift; [ "$MODE" = container ] || MODE=host ;;
    --url=*) URL=${1#*=}; [ "$MODE" = container ] || MODE=host ;;
    --container) CONTAINER=${2:?--container needs a name}; MODE=container; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '  %s\n' "$*"; }
die() { printf '  ! %s\n' "$*" >&2; exit 1; }

env_get() {  # last value of KEY in .env (empty if missing); never sourced
  [ -f "$ENV_FILE" ] || return 0
  awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$ENV_FILE" |
    sed "s/^[\"']\(.*\)[\"']\$/\1/"
}
bool() {  # bool NAME VALUE → true|false
  case $(printf '%s' "$2" | tr '[:upper:]' '[:lower:]') in
    true|1|yes|on) echo true ;;
    false|0|no|off) echo false ;;
    *) die "$1 must be true or false (got \"$2\")" ;;
  esac
}

# --- desired values -------------------------------------------------------------
cache_mb=$(env_get TORRSERVER_CACHE_MB); cache_mb=${cache_mb:-128}
case $cache_mb in ''|*[!0-9]*) die "TORRSERVER_CACHE_MB must be a number of megabytes (got \"$cache_mb\")" ;; esac
[ "$cache_mb" -ge 4 ] && [ "$cache_mb" -le 16384 ] || die "TORRSERVER_CACHE_MB must be 4…16384"
want_cache=$((cache_mb * 1024 * 1024))
v=$(env_get TORRSERVER_REMOVE_CACHE_ON_DROP); want_drop=$(bool TORRSERVER_REMOVE_CACHE_ON_DROP "${v:-true}")
v=$(env_get TORRSERVER_RUTOR_SEARCH); want_rutor=$(bool TORRSERVER_RUTOR_SEARCH "${v:-false}")

# --- where TorrServer is --------------------------------------------------------
case $MODE in
  compose)
    ts_url=$(env_get TORRSERVER_URL)
    if [ -n "$ts_url" ] && [ "$ts_url" != http://torrserver:8090 ]; then
      say "TorrServer is your own ($ts_url): not configured (use --url / --container)"
      exit 0
    fi
    URL=http://127.0.0.1:8090 ;;
  container) URL=${URL:-http://127.0.0.1:8090} ;;
esac
URL=${URL%/}

user=$(env_get TORRSERVER_USERNAME); [ -n "$user" ] || user=$(env_get TORRSERVER_LOGIN)
pass=$(env_get TORRSERVER_PASSWORD); [ -n "$pass" ] || pass=$(env_get TORRSERVER_PWD)
TS_AUTH=""
if [ -n "$user" ]; then
  TS_AUTH=$(printf '%s:%s' "$user" "$pass" | base64 | tr -d '\n')
fi
export TS_AUTH
unset user pass

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

# http PATH [BODY_FILE] → response body on stdout; non-zero on any failure.
# In compose / container mode the request runs inside the container with its
# (busybox) wget; the auth header comes in through the environment.
http() {
  path=$1 body=${2:-/dev/null}
  # sh -c script: $TS_AUTH must expand inside the container.
  # shellcheck disable=SC2016
  inner='a=""; [ -z "$TS_AUTH" ] || a="Authorization: Basic $TS_AUTH"
    if [ -n "$TS_POST" ]; then
      wget -q -T 60 -O - ${a:+--header "$a"} --header "Content-Type: application/json" --post-file /dev/stdin "$TS_REQ"
    else
      wget -q -T 10 -O - ${a:+--header "$a"} "$TS_REQ"
    fi'
  post=""; [ "$body" = /dev/null ] || post=1
  case $MODE in
    compose) TS_REQ=$URL$path TS_POST=$post "$ROOT/scripts/cineko.sh" exec -T -e TS_AUTH -e TS_REQ -e TS_POST torrserver sh -c "$inner" < "$body" ;;
    container) TS_REQ=$URL$path TS_POST=$post docker exec -i -e TS_AUTH -e TS_REQ -e TS_POST "$CONTAINER" sh -c "$inner" < "$body" ;;
    host)
      if command -v curl >/dev/null 2>&1; then
        : > "$TMP/hdr"; [ -z "$TS_AUTH" ] || printf 'Authorization: Basic %s\n' "$TS_AUTH" > "$TMP/hdr"
        if [ -n "$post" ]; then
          curl -fsS --max-time 60 -H @"$TMP/hdr" -H 'Content-Type: application/json' --data-binary @"$body" "$URL$path"
        else
          curl -fsS --max-time 10 -H @"$TMP/hdr" "$URL$path"
        fi
      elif command -v wget >/dev/null 2>&1; then
        TS_REQ=$URL$path TS_POST=$post sh -c "$inner" < "$body"
      else
        die "neither curl nor wget on this machine (use --container NAME)"
      fi ;;
  esac
}

# --- JSON (TorrServer's compact BTSets object; only top-level number/bool keys) --
# A key in a JSON string would have its quotes escaped, so "Key": only
# matches the real key.
jget() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([^,}[:space:]]*\).*/\1/p" "$2"; }
jset() {  # jset KEY VALUE FILE (replace, or add when missing)
  if grep -q "\"$1\"[[:space:]]*:" "$3"; then
    sed "s/\"$1\"[[:space:]]*:[[:space:]]*[^,}[:space:]]*/\"$1\":$2/" "$3" > "$3.new"
  else
    sed "s/^[[:space:]]*{/{\"$1\":$2,/" "$3" > "$3.new"
  fi
  mv "$3.new" "$3"
}
mb() { case $1 in ''|*[!0-9]*) echo "${1:-unset}" ;; *) echo "$(($1 / 1048576)) MB" ;; esac; }
show() { printf '  %-18s %s\n' CacheSize "$(mb "$(jget CacheSize "$1")")" RemoveCacheOnDrop "$(jget RemoveCacheOnDrop "$1")" EnableRutorSearch "$(jget EnableRutorSearch "$1")"; }

# --- wait, get, change, set -------------------------------------------------------
i=0
until http /echo > "$TMP/echo" 2>/dev/null; do
  i=$((i + 3))
  [ "$i" -lt "$WAIT" ] || die "TorrServer at $URL not answering /echo after ${WAIT}s"
  sleep 3
done
say "TorrServer $(head -c 40 "$TMP/echo" | tr -d '\r\n') at $URL"

get() {
  printf '%s' '{"action":"get"}' > "$TMP/req"
  http /settings "$TMP/req" > "$1.raw" || die "couldn't read the settings (wrong TORRSERVER_USERNAME / PASSWORD?)"
  tr -d '\r\n' < "$1.raw" > "$1"
  case $(head -c 1 "$1") in '{') ;; *) die "unexpected answer to settings get" ;; esac
  [ -n "$(jget CacheSize "$1")" ] || die "the settings have no CacheSize: not a TorrServer this script knows"
}
get "$TMP/before"
cp "$TMP/before" "$TMP/sets"
jset CacheSize "$want_cache" "$TMP/sets"
jset RemoveCacheOnDrop "$want_drop" "$TMP/sets"
jset EnableRutorSearch "$want_rutor" "$TMP/sets"

if cmp -s "$TMP/before" "$TMP/sets"; then
  say "settings already applied:"
  show "$TMP/before"
else
  say "before:"; show "$TMP/before"
  { printf '%s' '{"action":"set","sets":'; cat "$TMP/sets"; printf '}'; } > "$TMP/req"
  http /settings "$TMP/req" > /dev/null || die "settings set failed"
  get "$TMP/after"
  say "after:"; show "$TMP/after"
  [ "$(jget CacheSize "$TMP/after")" = "$want_cache" ] &&
    [ "$(jget RemoveCacheOnDrop "$TMP/after")" = "$want_drop" ] &&
    [ "$(jget EnableRutorSearch "$TMP/after")" = "$want_rutor" ] ||
    die "TorrServer didn't keep the new values (read-only settings database?)"
  say "applied (TorrServer reconnected: open streams had to restart)"
fi

if [ "$RESTART" = 1 ]; then
  say "restarting TorrServer: anything streaming through it (Cineko, Lampa, MSX) stops"
  case $MODE in
    compose) "$ROOT/scripts/cineko.sh" restart torrserver >/dev/null ;;
    container) docker restart "$CONTAINER" >/dev/null ;;
    host) die "--restart needs --container NAME (or the bundled compose service)" ;;
  esac
  i=0
  until http /echo >/dev/null 2>&1; do
    i=$((i + 3)); [ "$i" -lt "$WAIT" ] || die "TorrServer not back after ${WAIT}s"; sleep 3
  done
  say "TorrServer restarted"
fi
