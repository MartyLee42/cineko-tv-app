#!/usr/bin/env bash
# Cineko installer: one command from a fresh Linux server with Docker to a
# running stack (Cineko, Prowlarr + FlareSolverr, TorrServer, Invidious).
#
#   ./install.sh                         interactive
#   ./install.sh --yes --domain tv.example.com --admin-user me
#   ./install.sh --yes --lan             LAN only (http://<this machine's IP>)
#
# Safe to re-run: secrets already in .env are never replaced, Prowlarr keeps
# what you configured, existing accounts are untouched. Run with --help for
# every option. Docs: docs/deployment.md
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT"
ENV_FILE=${CINEKO_ENV_FILE:-$ROOT/.env}

# --- options (flags win over environment variables) ------------------------
ASSUME_YES=${CINEKO_YES:-0}
ADDRESS=${CINEKO_ADDRESS:-}          # domain or IP (or empty → ask)
LAN=${CINEKO_LAN:-0}
HTTP_PORT_OPT=${CINEKO_HTTP_PORT:-}
HTTPS_PORT_OPT=${CINEKO_HTTPS_PORT:-}
TMDB_OPT=${CINEKO_TMDB:-}
DEEPSEEK_OPT=${CINEKO_DEEPSEEK_KEY:-}
PROXY_OPT=${CINEKO_PROXY:-}
VPN=${CINEKO_VPN:-0}
ADMIN_USER=${CINEKO_ADMIN_USER:-}
ADMIN_PASSWORD=${CINEKO_ADMIN_PASSWORD:-}
BUILD_MODE=${CINEKO_BUILD:-auto}     # auto | build | pull
INDEXERS=${CINEKO_INDEXERS:-rutor,thepiratebay,1337x:fs,yts,eztv,limetorrents}
SKIP_PROWLARR=${CINEKO_SKIP_PROWLARR:-0}
TS_CACHE_MB=${CINEKO_TS_CACHE_MB:-}  # TorrServer settings; empty = keep .env / default
TS_DROP=${CINEKO_TS_REMOVE_CACHE_ON_DROP:-}
TS_RUTOR=${CINEKO_TS_RUTOR_SEARCH:-}
SKIP_TORRSERVER=${CINEKO_SKIP_TORRSERVER:-0}
NO_START=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

  --domain NAME          public domain (DNS → this server, ports 80/443 open):
                         automatic HTTPS via Let's Encrypt
  --lan [IP]             plain HTTP on the local network (default IP: detected)
  --http-port N          host port for HTTP  (default 80)
  --https-port N         host port for HTTPS (default 443)
  --tmdb TOKEN           TMDB v4 read access token or v3 API key (catalog)
  --deepseek-key KEY     DeepSeek API key (optional AI picks)
  --proxy URL            outbound proxy for TMDB / YouTube / music where they
                         are blocked: socks5h://host:port or http://host:port
  --vpn                  use the bundled gluetun VPN (profile "vpn",
                         settings in gluetun.env) as that proxy
  --admin-user NAME      create this super admin (password: --admin-password-file,
                         $CINEKO_ADMIN_PASSWORD, or asked without echo)
  --admin-password-file F  read the admin password from file F
  --indexers LIST        Prowlarr indexers to add (definition names, ",";
                         suffix ":fs" = via FlareSolverr). Default:
                         rutor,thepiratebay,1337x:fs,yts,eztv,limetorrents
  --skip-prowlarr        don't configure Prowlarr
  --ts-cache-mb N        TorrServer RAM cache per torrent, MB (default 128)
  --ts-remove-cache-on-drop true|false
                         drop a torrent's cache when it closes (default true)
  --ts-rutor-search true|false
                         TorrServer's own rutor search (default false)
  --skip-torrserver      don't apply TorrServer settings
  --build                build images from this checkout
  --pull                 only use prebuilt images from GHCR (fail otherwise)
  --no-start             only write .env
  -y, --yes              never ask; use flags / defaults
  -h, --help             this help

Every option also has an environment variable (CINEKO_DOMAIN, CINEKO_LAN=1,
CINEKO_TMDB, CINEKO_PROXY, CINEKO_ADMIN_USER, CINEKO_ADMIN_PASSWORD,
CINEKO_YES=1, CINEKO_BUILD=build|pull, CINEKO_TS_CACHE_MB, …).
EOF
}

[ -n "${CINEKO_DOMAIN:-}" ] && ADDRESS=$CINEKO_DOMAIN
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) ADDRESS=${2:?--domain needs a value}; LAN=0; shift ;;
    --domain=*) ADDRESS=${1#*=}; LAN=0 ;;
    --lan) LAN=1; if [ -n "${2:-}" ] && [ "${2#-}" = "$2" ]; then ADDRESS=$2; shift; fi ;;
    --lan=*) LAN=1; ADDRESS=${1#*=} ;;
    --http-port) HTTP_PORT_OPT=${2:?}; shift ;;
    --https-port) HTTPS_PORT_OPT=${2:?}; shift ;;
    --tmdb) TMDB_OPT=${2:?}; shift ;;
    --deepseek-key) DEEPSEEK_OPT=${2:?}; shift ;;
    --proxy) PROXY_OPT=${2:?}; shift ;;
    --vpn) VPN=1 ;;
    --admin-user) ADMIN_USER=${2:?}; shift ;;
    --admin-password-file) ADMIN_PASSWORD=$(head -n1 "${2:?}"); shift ;;
    --indexers) INDEXERS=${2:?}; shift ;;
    --skip-prowlarr) SKIP_PROWLARR=1 ;;
    --ts-cache-mb) TS_CACHE_MB=${2:?}; shift ;;
    --ts-remove-cache-on-drop) TS_DROP=${2:?}; shift ;;
    --ts-rutor-search) TS_RUTOR=${2:?}; shift ;;
    --skip-torrserver) SKIP_TORRSERVER=1 ;;
    --build) BUILD_MODE=build ;;
    --pull) BUILD_MODE=pull ;;
    --no-start) NO_START=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# --- output helpers ----------------------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B='' G='' Y='' R='' N=''; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
SUMMARY=()
note() { SUMMARY+=("$*"); }

interactive() { [ "$ASSUME_YES" != 1 ] && [ -t 0 ]; }
# ask VAR "Question" "default"
ask() {
  local __var=$1 __q=$2 __def=${3:-} __ans
  if interactive; then
    read -r -p "  $__q${__def:+ [$__def]}: " __ans || true
    printf -v "$__var" '%s' "${__ans:-$__def}"
  else
    printf -v "$__var" '%s' "$__def"
  fi
}
ask_secret() {
  local __var=$1 __q=$2 __ans
  if interactive; then
    read -r -s -p "  $__q: " __ans || true; echo
    printf -v "$__var" '%s' "$__ans"
  else
    printf -v "$__var" '%s' ""
  fi
}
confirm() {  # confirm "Question" default(y|n)
  local ans def=${2:-y}
  interactive || { [ "$def" = y ]; return; }
  read -r -p "  $1 [$([ "$def" = y ] && echo Y/n || echo y/N)]: " ans || true
  ans=${ans:-$def}
  [[ $ans =~ ^[Yy] ]]
}

# --- .env helpers --------------------------------------------------------------
env_get() {  # last value of KEY in .env (empty if missing)
  [ -f "$ENV_FILE" ] || return 0
  awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { if (v != "") print v }' "$ENV_FILE"
}
env_set() {  # replace KEY's line (or append); values are written verbatim
  local key=$1 val=$2 tmp
  case "$val" in *$'\n'*) die "value for $key contains a newline" ;; esac
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  chmod 600 "$tmp"
  KEY="$key" VAL="$val" awk '
    BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"]; done = 0 }
    index($0, k "=") == 1 { if (!done) { print k "=" v; done = 1 } ; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}
env_default() { [ -n "$(env_get "$1")" ] || env_set "$1" "$2"; }   # never overwrites
rand() {  # rand N → N random letters/digits
  local n=$1 out=""
  while [ ${#out} -lt "$n" ]; do
    if command -v openssl >/dev/null 2>&1; then out+=$(openssl rand -base64 96 | tr -dc 'A-Za-z0-9')
    else out+=$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9'); fi
  done
  printf '%s' "${out:0:$n}"
}

# --- 1. prerequisites -----------------------------------------------------------
step "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "Docker is not installed.
  Install Docker Engine + the compose plugin, e.g.:
    curl -fsSL https://get.docker.com | sh
  (or see https://docs.docker.com/engine/install/), then re-run ./install.sh"
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    die "Docker works only with sudo. Either run: sudo ./install.sh
  or add yourself to the docker group: sudo usermod -aG docker \$USER (then log in again)"
  fi
  die "Can't talk to the Docker daemon. Is it running (sudo systemctl start docker)?
  Are you in the docker group (sudo usermod -aG docker \$USER, then log in again)?"
fi
docker compose version >/dev/null 2>&1 || die "The Docker compose plugin is missing.
  Debian/Ubuntu: sudo apt-get install docker-compose-plugin
  (see https://docs.docker.com/compose/install/linux/)"
cv=$(docker compose version --short 2>/dev/null | sed 's/^v//')
if [ "$(printf '%s\n' 2.24.0 "$cv" | sort -V | head -1)" != 2.24.0 ]; then
  die "docker compose $cv is too old; 2.24 or newer is needed (sudo apt-get install docker-compose-plugin)"
fi
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), compose $cv"
[ -f deployments/compose.yaml ] || die "run this from a Cineko checkout (deployments/compose.yaml missing)"

COMPOSE=(docker compose -f deployments/compose.yaml)
[ -f deployments/compose.override.yaml ] && COMPOSE+=(-f deployments/compose.override.yaml)
COMPOSE+=(--env-file "$ENV_FILE")
dc() { "${COMPOSE[@]}" "$@"; }

# --- 2. configuration (.env) -------------------------------------------------------
step "Configuration ($ENV_FILE)"
FIRST_RUN=0
umask 077
if [ ! -f "$ENV_FILE" ]; then
  FIRST_RUN=1
  { echo "# Cineko settings, written by install.sh. Keep this file private (mode 0600)."
    echo "# Every setting is documented in deployments/env.example."; } > "$ENV_FILE"
  ok "created .env"
else
  ok "keeping existing .env (secrets are never replaced)"
fi
chmod 600 "$ENV_FILE"

detect_ip() {
  local ip=""
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") {print $(i+1); exit}}') || true
  [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | awk '{print $1}') || true
  printf '%s' "${ip:-127.0.0.1}"
}
is_ip() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || $1 == localhost || $1 == *:* ]]; }

# Public address.
cur_base=$(env_get PUBLIC_BASE_URL)
if [ -z "$ADDRESS" ] && [ "$LAN" != 1 ] && [ -n "$cur_base" ] && [ "$FIRST_RUN" = 0 ]; then
  ok "public address: $cur_base (unchanged; pass --domain / --lan to change)"
else
  if [ -z "$ADDRESS" ]; then
    if [ "$LAN" = 1 ] || ! interactive; then
      ADDRESS=$(detect_ip); LAN=1
    else
      echo "  Public address: a domain name pointing at this server gives automatic"
      echo "  HTTPS (ports 80 and 443 must be reachable from the internet). An IP"
      echo "  address serves plain HTTP on your local network."
      ask ADDRESS "Domain or IP" "$(detect_ip)"
    fi
  fi
  ADDRESS=${ADDRESS#http://}; ADDRESS=${ADDRESS#https://}; ADDRESS=${ADDRESS%%/*}
  [ -n "$ADDRESS" ] || die "no public address"
  is_ip "$ADDRESS" && LAN=1
  http_port=${HTTP_PORT_OPT:-$(env_get HTTP_PORT)}; http_port=${http_port:-80}
  if [ "$LAN" = 1 ]; then
    base="http://$ADDRESS"; [ "$http_port" = 80 ] || base="$base:$http_port"
    env_set SITE_ADDRESS ":80"
    env_set PUBLIC_BASE_URL "$base"
    env_set COOKIE_SECURE false
    ok "LAN mode: $base (plain HTTP)"
  else
    https_port=${HTTPS_PORT_OPT:-$(env_get HTTPS_PORT)}; https_port=${https_port:-443}
    base="https://$ADDRESS"; [ "$https_port" = 443 ] || base="$base:$https_port"
    env_set SITE_ADDRESS "$ADDRESS"
    env_set PUBLIC_BASE_URL "$base"
    env_set COOKIE_SECURE true
    ok "domain: $base (Caddy gets the certificate on first start)"
    [ "$http_port" = 80 ] && [ "$https_port" = 443 ] || warn "Let's Encrypt needs ports 80/443 reachable from the internet (forward them to $http_port/$https_port)"
  fi
fi
[ -n "$HTTP_PORT_OPT" ] && env_set HTTP_PORT "$HTTP_PORT_OPT"
[ -n "$HTTPS_PORT_OPT" ] && env_set HTTPS_PORT "$HTTPS_PORT_OPT"

# Secrets (generated once, never replaced).
env_default APP_SESSION_SECRET "$(rand 64)"
env_default POSTGRES_PASSWORD "$(rand 32)"
env_default TRANSCODER_SECRET "$(rand 48)"
env_default INVIDIOUS_DB_PASSWORD "$(rand 32)"
env_default INVIDIOUS_HMAC_KEY "$(rand 48)"
[[ $(env_get INVIDIOUS_COMPANION_KEY) =~ ^[A-Za-z0-9]{16}$ ]] || env_set INVIDIOUS_COMPANION_KEY "$(rand 16)"
ok "secrets present (generated where missing)"

# Fixed service wiring (only written when missing, so your edits stay).
env_default PROWLARR_URL http://prowlarr:9696
env_default TORRSERVER_URL http://torrserver:8090
# TorrServer settings (applied after start by scripts/torrserver-settings.sh):
# a flag replaces the .env value, otherwise yours stays.
[[ -z $TS_CACHE_MB || $TS_CACHE_MB =~ ^[0-9]+$ ]] || die "--ts-cache-mb must be a number of megabytes"
for v in "$TS_DROP" "$TS_RUTOR"; do
  [[ -z $v || $v =~ ^(true|false)$ ]] || die "--ts-remove-cache-on-drop / --ts-rutor-search take true or false"
done
if [ -n "$TS_CACHE_MB" ]; then env_set TORRSERVER_CACHE_MB "$TS_CACHE_MB"; else env_default TORRSERVER_CACHE_MB 128; fi
if [ -n "$TS_DROP" ]; then env_set TORRSERVER_REMOVE_CACHE_ON_DROP "$TS_DROP"; else env_default TORRSERVER_REMOVE_CACHE_ON_DROP true; fi
if [ -n "$TS_RUTOR" ]; then env_set TORRSERVER_RUTOR_SEARCH "$TS_RUTOR"; else env_default TORRSERVER_RUTOR_SEARCH false; fi
if [ -z "$(env_get TZ)" ]; then
  tz=$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || true)
  env_set TZ "${tz:-Etc/UTC}"
fi

# TMDB.
if [ -z "$TMDB_OPT" ] && [ -z "$(env_get TMDB_ACCESS_TOKEN)$(env_get TMDB_API_KEY)" ] && interactive; then
  echo "  TMDB supplies the catalog (posters, descriptions). Free account:"
  echo "  https://www.themoviedb.org/signup → Settings → API → \"API Read Access Token\"."
  ask_secret TMDB_OPT "TMDB read access token or API key (Enter to skip)"
fi
if [ -n "$TMDB_OPT" ]; then
  if [ ${#TMDB_OPT} -gt 40 ]; then env_set TMDB_ACCESS_TOKEN "$TMDB_OPT"; else env_set TMDB_API_KEY "$TMDB_OPT"; fi
  ok "TMDB key saved"
fi
if [ -n "$(env_get TMDB_ACCESS_TOKEN)$(env_get TMDB_API_KEY)" ]; then ok "TMDB configured"
else warn "no TMDB key: the catalog stays empty until you add TMDB_ACCESS_TOKEN to .env"; note "Add a TMDB token (TMDB_ACCESS_TOKEN in .env, then scripts/cineko.sh up -d)."; fi

# DeepSeek (optional).
if [ -z "$DEEPSEEK_OPT" ] && [ -z "$(env_get DEEPSEEK_API_KEY)" ] && interactive; then
  echo "  Optional: a DeepSeek API key (https://platform.deepseek.com) enables AI picks."
  ask_secret DEEPSEEK_OPT "DeepSeek API key (Enter to skip)"
fi
[ -z "$DEEPSEEK_OPT" ] || { env_set DEEPSEEK_API_KEY "$DEEPSEEK_OPT"; ok "DeepSeek key saved"; }

# Outbound proxy (optional).
if [ "$VPN" = 1 ]; then PROXY_OPT=http://gluetun:8888; fi
if [ -z "$PROXY_OPT" ] && [ -z "$(env_get OUTBOUND_PROXY_URL)" ] && [ "$FIRST_RUN" = 1 ] && interactive; then
  echo "  Optional: if TMDB or YouTube are blocked where this server is, give a"
  echo "  proxy (socks5h://host:port, http://user:pass@host:port), or \"vpn\" for"
  echo "  the bundled gluetun VPN client."
  ask PROXY_OPT "Outbound proxy (Enter for none)" ""
  [ "$PROXY_OPT" = vpn ] && { VPN=1; PROXY_OPT=http://gluetun:8888; }
fi
if [ -n "$PROXY_OPT" ]; then
  [[ $PROXY_OPT =~ ^(socks5h?|https?)://([^@/]+@)?[^:/@]+:[0-9]+/?$ ]] || die "proxy must look like socks5h://host:port or http://host:port"
  env_set OUTBOUND_PROXY_URL "${PROXY_OPT%/}"
fi
proxy=$(env_get OUTBOUND_PROXY_URL)
if [ -n "$proxy" ]; then
  # Invidious takes the proxy as a YAML map, not a URL.
  scheme=${proxy%%://*}; rest=${proxy#*://}; user=""; pass=""
  if [[ $rest == *@* ]]; then cred=${rest%@*}; rest=${rest##*@}; user=${cred%%:*}; pass=${cred#*:}; [ "$pass" != "$cred" ] || pass=""; fi
  host=${rest%:*}; port=${rest##*:}
  case "$scheme" in socks5|socks5h) itype=socks5 ;; *) itype=http ;; esac
  map="{type: $itype, host: \"$host\", port: $port"
  [ -z "$user" ] || map+=", user: \"$user\", password: \"$pass\""
  env_set INVIDIOUS_HTTP_PROXY "$map}"
  env_default IMAGE_PROXY true   # clients load TMDB images through the server
  ok "outbound proxy: ${scheme}://${host}:${port}"
fi
if [ "$VPN" = 1 ]; then
  env_set COMPOSE_PROFILES vpn
  if [ ! -f "$ROOT/gluetun.env" ]; then
    cat > "$ROOT/gluetun.env" <<'EOF'
# gluetun (profile "vpn") settings: https://github.com/qdm12/gluetun-wiki
# Pick your provider and fill in its credentials, e.g. WireGuard:
#VPN_SERVICE_PROVIDER=mullvad
#VPN_TYPE=wireguard
#WIREGUARD_PRIVATE_KEY=
#WIREGUARD_ADDRESSES=
#SERVER_COUNTRIES=Netherlands
# or any WireGuard config: VPN_SERVICE_PROVIDER=custom, VPN_TYPE=wireguard,
# WIREGUARD_ENDPOINT_IP, WIREGUARD_ENDPOINT_PORT, WIREGUARD_PUBLIC_KEY, …
EOF
    chmod 600 "$ROOT/gluetun.env"
  fi
  if ! grep -q '^VPN_SERVICE_PROVIDER=' "$ROOT/gluetun.env"; then
    die "the VPN profile needs your VPN provider settings: edit $ROOT/gluetun.env, then re-run ./install.sh"
  fi
  ok "VPN profile on (gluetun)"
fi

[ "$NO_START" = 1 ] && { step "Done (--no-start): .env written"; exit 0; }

# --- 3. images and start -----------------------------------------------------------
step "Starting the stack"
OURS=(api transcoder music web)
case "$BUILD_MODE" in
  build) dc build "${OURS[@]}" ;;
  pull) dc pull "${OURS[@]}" ;;
  *)
    if dc pull -q "${OURS[@]}" 2>/dev/null; then ok "prebuilt images pulled"
    else warn "prebuilt images unavailable; building from source (takes a while)"; dc build "${OURS[@]}"; fi ;;
esac
dc up -d --remove-orphans --quiet-pull
ok "containers started"

wait_for() {  # wait_for "what" seconds command...
  local what=$1 secs=$2; shift 2
  local i
  for ((i = 0; i < secs; i += 3)); do
    if "$@" >/dev/null 2>&1; then ok "$what"; return 0; fi
    sleep 3
  done
  warn "$what: not ready after ${secs}s"; return 1
}
api_healthy() { dc exec -T api /martytv healthcheck; }
wait_for "API healthy" 180 api_healthy || { dc logs --tail=40 api >&2; die "the API didn't start (logs above)"; }

# --- 4. Prowlarr -----------------------------------------------------------------------
prowlarr_key() { dc exec -T prowlarr sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' /config/config.xml 2>/dev/null | tr -d '\r\n'; }
prowlarr_up() { dc exec -T prowlarr curl -fs http://127.0.0.1:9696/ping; }
if [ "$SKIP_PROWLARR" != 1 ] && [ "$(env_get PROWLARR_URL)" != http://prowlarr:9696 ]; then
  step "Prowlarr (torrent search)"
  ok "using your own Prowlarr at $(env_get PROWLARR_URL) (not configured by install.sh)"
  SKIP_PROWLARR=1
fi
if [ "$SKIP_PROWLARR" != 1 ]; then
  step "Prowlarr (torrent search)"
  if wait_for "Prowlarr up" 180 prowlarr_up; then
    key=$(prowlarr_key)
    if [ -z "$key" ]; then
      warn "couldn't read Prowlarr's API key; set PROWLARR_API_KEY in .env by hand (Prowlarr → Settings → General)"
    else
      if [ "$(env_get PROWLARR_API_KEY)" != "$key" ]; then
        env_set PROWLARR_API_KEY "$key"
        ok "PROWLARR_API_KEY saved to .env"
      fi
      if dc exec -T prowlarr sh -c 'command -v jq >/dev/null && command -v curl >/dev/null'; then
        dc exec -T -e INDEXERS="$INDEXERS" -e FLARESOLVERR_URL=http://flaresolverr:8191/ prowlarr \
          bash -s < "$ROOT/scripts/prowlarr-setup.sh" || warn "Prowlarr setup reported errors (above); finish it in Prowlarr's UI"
      else
        warn "jq/curl missing in the Prowlarr image; add indexers in its UI (docs/deployment.md)"
      fi
    fi
  else
    note "Prowlarr didn't come up: check 'scripts/cineko.sh logs prowlarr', then re-run ./install.sh."
  fi
  # api and music read PROWLARR_API_KEY from .env: recreate them if it changed.
  dc up -d api music >/dev/null 2>&1 || dc up -d api music
  wait_for "API healthy" 120 api_healthy || true
fi

# --- 5. TorrServer settings ---------------------------------------------------------
# Cache size, cache cleanup and rutor search from .env. Written only when they
# differ (a change makes TorrServer reconnect, interrupting open streams).
if [ "$SKIP_TORRSERVER" != 1 ]; then
  step "TorrServer settings"
  if ! CINEKO_ENV_FILE="$ENV_FILE" sh "$ROOT/scripts/torrserver-settings.sh"; then
    warn "TorrServer settings not applied (see above)"
    note "Apply TorrServer's settings: scripts/torrserver-settings.sh"
  fi
fi

# --- 6. first administrator ------------------------------------------------------------
step "Administrator account"
if [ -z "$ADMIN_USER" ] && interactive && confirm "Create a super admin account now?" "$([ "$FIRST_RUN" = 1 ] && echo y || echo n)"; then
  ask ADMIN_USER "Username" "admin"
fi
if [ -n "$ADMIN_USER" ]; then
  p2=""
  if [ -z "$ADMIN_PASSWORD" ]; then
    interactive || die "no password for --admin-user (use --admin-password-file or CINEKO_ADMIN_PASSWORD)"
    while :; do
      ask_secret ADMIN_PASSWORD "Password for $ADMIN_USER (10+ characters)"
      ask_secret p2 "Repeat password"
      [ "$ADMIN_PASSWORD" = "$p2" ] && [ ${#ADMIN_PASSWORD} -ge 10 ] && break
      warn "passwords differ or are shorter than 10 characters"
    done
  fi
  if out=$(printf '%s\n' "$ADMIN_PASSWORD" | dc exec -T api /martytv admin create --username "$ADMIN_USER" --role super_admin 2>&1); then
    ok "created super admin \"$ADMIN_USER\""
  elif grep -q 'already exists' <<<"$out"; then
    ok "user \"$ADMIN_USER\" already exists (unchanged)"
  else
    warn "couldn't create the admin: $out"
    note "Create an admin later: scripts/cineko.sh exec -T api /martytv admin create --username NAME --role super_admin (password on stdin)."
  fi
  unset ADMIN_PASSWORD p2
else
  ok "skipped (create one later: scripts/cineko.sh exec api /martytv admin create --username NAME --role super_admin)"
fi

# --- 7. status and summary -------------------------------------------------------------
step "Status"
dc ps --format 'table {{.Service}}\t{{.Status}}'
ready=$(dc exec -T web wget -qO- http://api:8080/readyz 2>/dev/null || true)
[ -z "$ready" ] || echo "  readyz: $ready"

base=$(env_get PUBLIC_BASE_URL)
host=${base#*://}
step "Cineko is running"
cat <<EOF
  Web app (phones, computers):  $base
  TV app:                       $base/tv/
  Music:                        $base/music
  Media Station X start parameter (MSX → Settings → Start Parameter): $host

  Prowlarr UI (indexers):  ssh -L 9696:127.0.0.1:$(env_get PROWLARR_UI_PORT | grep . || echo 9696) <you>@<this server>, then http://localhost:9696
  TorrServer UI:           ssh -L 8090:127.0.0.1:$(env_get TORRSERVER_UI_PORT | grep . || echo 8090) <you>@<this server>, then http://localhost:8090

  Manage:   scripts/cineko.sh ps | logs -f api | restart api …
  Update:   scripts/update.sh        Backup: scripts/backup.sh
  Settings: .env (see deployments/env.example), then scripts/cineko.sh up -d
EOF
if [ ${#SUMMARY[@]} -gt 0 ]; then
  echo
  echo "  ${B}To do:${N}"
  for s in "${SUMMARY[@]}"; do echo "  - $s"; done
fi
