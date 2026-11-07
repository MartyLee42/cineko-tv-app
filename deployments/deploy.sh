#!/usr/bin/env bash
# Deploys MartyTV to the media server.
#
#   deployments/deploy.sh            build from the working tree
#   deployments/deploy.sh --index    build from what is staged in git (git add)
#
# Builds the API and web images locally (the server is small and shares RAM
# with TorrServer), streams them over SSH, and (re)starts the stack in
# /opt/martytv. Also installs the martytv-hostmon systemd service (host load
# for the admin Server tab). Never touches other containers or services
# on the server, except three TorrServer settings through its API (cache
# size, cache cleanup, rutor search; scripts/torrserver-settings.sh).
#
# Needs: docker, ssh. Server login from ./.remote_server (SERVER_URL,
# SERVER_USER, SERVER_PWD) or your SSH keys. Settings in
# deployments/server/.env.server (git-ignored; see .env.server.example).
set -Eeuo pipefail
# Every failure says where: the failing command, its line, and (inside a
# helper) the deploy.sh line that called it.
trap 'rc=$?; echo "deploy failed at line $LINENO (exit $rc): $BASH_COMMAND${FUNCNAME[0]:+ [in ${FUNCNAME[*]}, called from lines ${BASH_LINENO[*]}]}" >&2' ERR

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
# shellcheck disable=SC1091
# MARTYTV_REMOTE_FILE / MARTYTV_SETTINGS point elsewhere for a local test
# target (see deployments/remote.sh); defaults are production.
REMOTE_FILE=${MARTYTV_REMOTE_FILE:-.remote_server}
# shellcheck disable=SC1090
[ -f "$REMOTE_FILE" ] && . "$REMOTE_FILE"
HOST=${SERVER_URL:?set SERVER_URL in .remote_server}
USER_=${SERVER_USER:-root}
SETTINGS=${MARTYTV_SETTINGS:-deployments/server/.env.server}
[ -f "$SETTINGS" ] || { echo "missing $SETTINGS (copy deployments/server/.env.server.example)"; exit 1; }

DOCKER=docker
docker info >/dev/null 2>&1 || DOCKER="sg docker -c docker"   # not yet in the docker group
dk() { if [ "$DOCKER" = docker ]; then docker "$@"; else sg docker -c "docker $(printf '%q ' "$@")"; fi; }

# --- SSH (password via askpass if provided; one shared connection) ---------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; ssh -O exit -o ControlPath="$TMP/cm" -p "${SERVER_PORT:-22}" "$USER_@$HOST" 2>/dev/null || true' EXIT
# remote / remote_in / remote_quiet / put_small / put_big (always this script's own copy).
# shellcheck source=deployments/remote.sh
. "$ROOT/deployments/remote.sh"

# --- Build ------------------------------------------------------------------
VERSION=$(date -u +%Y%m%d-%H%M%S)
SRC="$ROOT"
if [ "${1:-}" = "--index" ]; then
  SRC="$TMP/src"; mkdir -p "$SRC"
  git checkout-index -a --prefix="$SRC/"
  cp .dockerignore "$SRC/" 2>/dev/null || true
  # Household PDF guides are kept out of git; ship the local copies if present.
  mkdir -p "$SRC/docs/private" && cp docs/private/*.pdf "$SRC/docs/private/" 2>/dev/null || true
fi
echo "==> building martytv $VERSION from ${1:-working tree}"
dk build -q --target runtime --build-arg VERSION="$VERSION" -t "martytv-api:$VERSION" "$SRC/services/api" >/dev/null
dk build -q -f "$SRC/deployments/Dockerfile.web" --build-arg VERSION="$VERSION" -t "martytv-web:$VERSION" "$SRC" >/dev/null
# Everything the server gets (images, compose file, hostmon unit) comes from
# $SRC, so --index never mixes staged code with working-tree config.
COMPOSE_SRC="$SRC/deployments/server/compose.yaml"
IMAGES=("martytv-api:$VERSION" "martytv-web:$VERSION")
# The transcoder only ships when this source has it; then its compose file
# references it, otherwise neither does.
if [ -f "$SRC/services/transcoder/Dockerfile" ]; then
  dk build -q -t "martytv-transcoder:$VERSION" "$SRC/services/transcoder" >/dev/null
  IMAGES+=("martytv-transcoder:$VERSION")
  TRANSCODER=1
else
  TRANSCODER=0
  if grep -q 'martytv-transcoder:' "$COMPOSE_SRC"; then
    echo "compose.yaml references the transcoder but services/transcoder is missing from the source" >&2; exit 1
  fi
fi
# Cineko Music (/music): ships when this source has it, like the transcoder.
if [ -f "$SRC/services/music/Dockerfile" ]; then
  dk build -q --target runtime -t "martytv-music:$VERSION" "$SRC/services/music" >/dev/null
  IMAGES+=("martytv-music:$VERSION")
  MUSIC=1
else
  MUSIC=0
  if grep -q 'martytv-music:' "$COMPOSE_SRC"; then
    echo "compose.yaml references martytv-music but services/music is missing from the source" >&2; exit 1
  fi
fi
# martytv-hostmon: a static binary for the host (systemd), not an image.
dk build -q --target hostmon --output "type=local,dest=$TMP/hostmon" "$SRC/services/api" >/dev/null

echo "==> uploading images"
remote 'mkdir -p /opt/martytv && chmod 700 /opt/martytv'
# The image stream is large (~350 MB) and the link to the server sometimes
# drops mid-transfer (ssh exit 255): save once locally, retry the upload.
docker_save_gz() {
  if [ "$DOCKER" = docker ]; then docker save "${IMAGES[@]}" | gzip -1
  else sg docker -c "docker save ${IMAGES[*]}" | gzip -1; fi
}
docker_save_gz > "$TMP/images.tar.gz"
for attempt in 1 2 3; do
  if remote_in 'gunzip | docker load -q' < "$TMP/images.tar.gz"; then break; fi
  [ "$attempt" -lt 3 ] || { echo "image upload failed 3 times" >&2; exit 1; }
  echo "image upload failed (attempt $attempt), retrying in 10 s…" >&2
  ssh -O exit -o ControlPath="$TMP/cm" "$USER_@$HOST" 2>/dev/null || true # fresh connection
  sleep 10
done
rm -f "$TMP/images.tar.gz"

echo "==> system logs capped at 500 MB (journald)"
put_small "$SRC/deployments/journald/martytv.conf" /tmp/martytv-journald.conf 644
remote "mkdir -p /etc/systemd/journald.conf.d
  if ! cmp -s /tmp/martytv-journald.conf /etc/systemd/journald.conf.d/martytv.conf; then
    mv /tmp/martytv-journald.conf /etc/systemd/journald.conf.d/martytv.conf
    systemctl restart systemd-journald
    journalctl --vacuum-size=500M >/dev/null 2>&1
  else rm -f /tmp/martytv-journald.conf; fi
  journalctl --disk-usage"

echo "==> host monitor (martytv-hostmon systemd service)"
# Idempotent; only touches its own binary, unit and /run/martytv.
put_big "$TMP/hostmon/martytv-hostmon" /usr/local/bin/martytv-hostmon.new 755
put_small "$SRC/deployments/hostmon/martytv-hostmon.service" /etc/systemd/system/martytv-hostmon.service.new 644
remote "set -e
  mv /usr/local/bin/martytv-hostmon.new /usr/local/bin/martytv-hostmon
  mv /etc/systemd/system/martytv-hostmon.service.new /etc/systemd/system/martytv-hostmon.service
  chmod 644 /etc/systemd/system/martytv-hostmon.service
  systemctl daemon-reload
  systemctl enable martytv-hostmon >/dev/null 2>&1
  systemctl restart martytv-hostmon
  sleep 1; systemctl is-active martytv-hostmon"

if grep -q '^  invidious:' "$COMPOSE_SRC"; then
  echo "==> «Видео» watchdog (martytv-video-watchdog timer)"
  # Restarts only our Invidious / companion when stuck while the VPN works.
  put_small "$SRC/deployments/watchdog/martytv-video-watchdog.sh" /usr/local/bin/martytv-video-watchdog 755
  put_small "$SRC/deployments/watchdog/martytv-video-watchdog.service" /etc/systemd/system/martytv-video-watchdog.service 644
  put_small "$SRC/deployments/watchdog/martytv-video-watchdog.timer" /etc/systemd/system/martytv-video-watchdog.timer 644
  remote "set -e
    systemctl daemon-reload
    systemctl enable --now martytv-video-watchdog.timer >/dev/null 2>&1
    systemctl is-active martytv-video-watchdog.timer"
fi

if grep -q '^  companion:' "$COMPOSE_SRC"; then
  echo "==> image updater (martytv-image-updater timer)"
  # Keeps Invidious / companion on the newest release (rollback if unhealthy).
  put_small "$SRC/deployments/watchdog/martytv-image-updater.sh" /usr/local/bin/martytv-image-updater 755
  put_small "$SRC/deployments/watchdog/martytv-image-updater.service" /etc/systemd/system/martytv-image-updater.service 644
  put_small "$SRC/deployments/watchdog/martytv-image-updater.timer" /etc/systemd/system/martytv-image-updater.timer 644
  remote "set -e
    systemctl daemon-reload
    systemctl enable --now martytv-image-updater.timer >/dev/null 2>&1
    systemctl is-active martytv-image-updater.timer"
fi

echo "==> configuring"
put_small "$COMPOSE_SRC" /opt/martytv/compose.yaml.new 600
# Keep generated secrets across deploys; settings come from .env.server.
put_small "$SETTINGS" /opt/martytv/.env.settings 600
remote "set -e; cd /opt/martytv; umask 077
  touch .env
  sess=\$(grep -m1 '^APP_SESSION_SECRET=' .env | cut -d= -f2- || true)
  pg=\$(grep -m1 '^POSTGRES_PASSWORD=' .env | cut -d= -f2- || true)
  [ -n \"\$sess\" ] || sess=\$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=')
  [ -n \"\$pg\" ] || pg=\$(head -c 24 /dev/urandom | base64 | tr -d '\n/+=')
  tc=\$(grep -m1 '^TRANSCODER_SECRET=' .env | cut -d= -f2- || true)
  [ -n \"\$tc\" ] || tc=\$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=')
  # Invidious («Видео»): its database password, hmac_key and the companion
  # key (exactly 16 letters/digits). Generated once, kept across deploys.
  ivdb=\$(grep -m1 '^INVIDIOUS_DB_PASSWORD=' .env | cut -d= -f2- || true)
  [ -n \"\$ivdb\" ] || ivdb=\$(head -c 24 /dev/urandom | base64 | tr -d '\n/+=')
  ivh=\$(grep -m1 '^INVIDIOUS_HMAC_KEY=' .env | cut -d= -f2- || true)
  [ -n \"\$ivh\" ] || ivh=\$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=')
  ivc=\$(grep -m1 '^INVIDIOUS_COMPANION_KEY=' .env | cut -d= -f2- || true)
  printf '%s' \"\$ivc\" | grep -qE '^[A-Za-z0-9]{16}\$' || ivc=\$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)
  { cat .env.settings; echo; echo APP_SESSION_SECRET=\$sess; echo POSTGRES_PASSWORD=\$pg; echo TRANSCODER_SECRET=\$tc;
    echo INVIDIOUS_DB_PASSWORD=\$ivdb; echo INVIDIOUS_HMAC_KEY=\$ivh; echo INVIDIOUS_COMPANION_KEY=\$ivc; echo MARTYTV_VERSION=$VERSION; } > .env.new
  mv .env.new .env; rm -f .env.settings; chmod 600 .env
  mv compose.yaml.new compose.yaml
  # Newer Invidious / companion the updater already moved to: never downgrade.
  [ ! -x /usr/local/bin/martytv-image-updater ] || /usr/local/bin/martytv-image-updater apply
  # Server downloads: host dir for the api container (nonroot uid 65532).
  # Idempotent; never touches existing files' contents.
  mkdir -p /opt/martytv/library
  chown 65532:65532 /opt/martytv/library
  chmod 750 /opt/martytv/library"

# Third-party images (Invidious, companion, Postgres) are pinned in
# compose.yaml. The server pulls them itself; when it can't (registry
# unreachable from there), they are pulled here and shipped like ours.
echo "==> third-party images"
mapfile -t THIRD_PARTY < <(grep -E '^\s+image:' "$COMPOSE_SRC" | awk '{print $2}' | grep -v '^martytv-' | sort -u)
for img in "${THIRD_PARTY[@]}"; do
  if remote_quiet "docker image inspect $img >/dev/null 2>&1"; then continue; fi
  echo "    pulling $img on the server"
  if remote "timeout 600 docker pull -q $img >/dev/null 2>&1"; then continue; fi
  echo "    server pull failed; shipping $img from here"
  dk pull -q "$img" >/dev/null
  if [ "$DOCKER" = docker ]; then docker save "$img" | gzip -1 > "$TMP/third.tar.gz"
  else sg docker -c "docker save $img" | gzip -1 > "$TMP/third.tar.gz"; fi
  remote_in 'gunzip | docker load -q' < "$TMP/third.tar.gz"
  rm -f "$TMP/third.tar.gz"
done

# Pages opened before this deploy (a TV runs one for days) keep loading their
# release's lazy chunks: the new web container archives its own assets at
# start (deployments/web-entrypoint.sh); the release running now goes into the
# archive here first (its image may predate the archive). Idempotent: existing
# files are kept, copies are dated now (pruned after ASSET_ARCHIVE_DAYS).
# The volume is created like compose would (its labels), so compose adopts it.
echo "==> asset archive"
remote "docker volume inspect martytv_asset-archive >/dev/null 2>&1 \
    || docker volume create --label com.docker.compose.project=martytv --label com.docker.compose.volume=asset-archive martytv_asset-archive >/dev/null
  if [ \"\$(docker inspect -f '{{.State.Running}}' martytv-web-1 2>/dev/null)\" = true ]; then
    docker exec martytv-web-1 tar -C /srv -cf - web/assets tv/assets 2>/dev/null \
      | docker run --rm -i --network none -v martytv_asset-archive:/srv/asset-archive martytv-web:$VERSION seed \
      && echo 'running release archived' || echo 'WARNING: running release not archived (its pages reload once instead)'
  fi"

echo "==> starting"
# The remote shell has no pipefail: keep compose's exit status explicitly.
remote 'cd /opt/martytv && out=$(docker compose up -d --remove-orphans 2>&1); rc=$?; printf "%s\n" "$out" | tail -5; exit $rc' \
  || { echo "docker compose up failed; the old containers are still running" >&2; exit 1; }
# The containers must run this build (compose can "succeed" without recreating).
check_image() {
  local got
  got=$(remote_quiet "docker inspect -f '{{.Config.Image}}' $1 2>/dev/null" || true)
  [ "$got" = "$2" ] || { echo "$1 runs '${got:-nothing}', expected $2" >&2; exit 1; }
}
check_image martytv-api-1 "martytv-api:$VERSION"
check_image martytv-web-1 "martytv-web:$VERSION"
if [ "$TRANSCODER" = 1 ]; then check_image martytv-transcoder-1 "martytv-transcoder:$VERSION"; fi
if [ "$MUSIC" = 1 ]; then check_image martytv-music-1 "martytv-music:$VERSION"; fi
# Third-party containers: a mismatch is a warning, never a failed deploy.
warn_image() {
  local got
  got=$(remote_quiet "docker inspect -f '{{.Config.Image}}' $1 2>/dev/null" || true)
  [ "$got" = "$2" ] || echo "WARNING: $1 runs '${got:-nothing}', expected $2" >&2
}
for svc in invidious companion invidious-db; do
  img=$(awk -v s="  $svc:" '$0==s{f=1;next} f&&/^  [a-z]/{f=0} f&&/^    image:/{print $2; exit}' "$COMPOSE_SRC")
  [ -z "$img" ] || warn_image "martytv-$svc-1" "$img"
done
healthy=0
for i in $(seq 1 30); do
  if remote_quiet 'docker exec martytv-api-1 /martytv healthcheck' >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
[ "$healthy" = 1 ] || { echo "api not healthy after 60 s" >&2; exit 1; }
remote 'echo "api healthy"; docker exec martytv-web-1 wget -qO- http://api:8080/readyz; echo'
if [ "$TRANSCODER" = 1 ]; then
  remote 'docker exec martytv-transcoder-1 martytv-transcoder healthcheck && echo "transcoder healthy" || echo "WARNING: transcoder not healthy (compat streams off)"'
fi
if [ "$MUSIC" = 1 ]; then
  remote 'for i in $(seq 1 15); do docker exec martytv-music-1 martytv-music healthcheck && { echo "music healthy"; exit 0; }; sleep 2; done; echo "WARNING: music not healthy (/music unavailable)"'
fi
if grep -q '^  invidious:' "$COMPOSE_SRC"; then
  # «Видео»: Invidious up and YouTube reachable through awg-socks (warnings only).
  remote 'for i in $(seq 1 30); do docker exec martytv-invidious-1 wget -qO- http://127.0.0.1:3000/api/v1/stats >/dev/null 2>&1 && break; sleep 3; done
    if docker exec martytv-invidious-1 wget -qO- "http://127.0.0.1:3000/api/v1/search?q=test" 2>/dev/null | grep -q videoId; then echo "invidious healthy (YouTube reachable)";
    else echo "WARNING: invidious not answering or YouTube unreachable through awg-socks («Видео» unavailable)"; fi'
fi

# TorrServer (the server's own, host networking) gets Cineko's cache settings
# from .env (TORRSERVER_CACHE_MB, …; defaults 128 MB / drop cache / no rutor).
# A no-op when they already match; never restarts it. TORRSERVER_SETTINGS=off
# in .env.server leaves TorrServer alone. Warnings only.
echo "==> TorrServer settings"
put_small "$SRC/scripts/torrserver-settings.sh" /opt/martytv/torrserver-settings.sh 700
remote 'cd /opt/martytv
  if grep -q "^TORRSERVER_SETTINGS=off" .env; then echo "skipped (TORRSERVER_SETTINGS=off)"; exit 0; fi
  u=$(grep -m1 "^TORRSERVER_URL=" .env | cut -d= -f2- | sed "s#//host.docker.internal#//127.0.0.1#")
  [ -n "$u" ] && CINEKO_ENV_FILE=/opt/martytv/.env sh torrserver-settings.sh --url "$u" \
    || echo "WARNING: TorrServer settings not applied"'

# Keep the two newest MartyTV image versions; never touches other images.
remote "for repo in martytv-api martytv-web martytv-transcoder martytv-music; do docker image ls \$repo --format '{{.Tag}}' | sort -r | tail -n +3 | xargs -r -I{} docker image rm -f \$repo:{} >/dev/null; done"
echo "==> deployed $VERSION"
