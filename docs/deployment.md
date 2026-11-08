# Installing and running Cineko

Cineko runs as one Docker Compose stack on a Linux server: the app itself
plus everything it needs to find and stream torrents and YouTube videos. No
other software has to be installed first.

| Service | What it does | Reachable from |
|---|---|---|
| `web` | Caddy: the web app (`/`), the TV app (`/tv/`), music (`/music`), HTTPS; proxies `/api`, `/msx`, `/healthz` | **published: 80, 443 (+ 443/udp)** |
| `api` | Cineko API (Go). Migrates the database on start | internal |
| `postgres` | Cineko's database | internal |
| `transcoder` | ffmpeg sidecar: browser-compatible streams (AC3/DTS → AAC, MKV → MP4, HLS for Safari) | internal |
| `music` | Music app and API at `/music` | internal |
| `prowlarr` | Torrent search across indexers (trackers) | internal; UI on `127.0.0.1:9696` |
| `flaresolverr` | Gets Prowlarr past Cloudflare checks on some trackers | internal |
| `torrserver` | Streams torrents over HTTP while they download | internal; UI on `127.0.0.1:8090` |
| `invidious`, `invidious-db`, `companion` | YouTube for the «Видео» tab and music audio | internal |
| `restart-proxy` | Docker socket proxy that lets the API restart Invidious + companion nightly ([below](#nightly-invidious-restart)) — nothing else | internal |
| `gluetun` *(profile `vpn`, optional)* | VPN client offering an HTTP proxy, for places where TMDB / YouTube are blocked | internal |

Only Caddy is published. The Prowlarr and TorrServer web UIs listen on the
server's loopback interface only; you reach them through an SSH tunnel.

## Requirements

- A 64-bit Linux server (amd64 or arm64) with **2+ CPU cores, 4 GB RAM**
  (8 GB is comfortable), and disk space for the databases plus TorrServer's
  cache. The whole stack idles at under 1 GB of RAM.
- **Docker Engine** with the **compose plugin 2.24+**:
  `curl -fsSL https://get.docker.com | sh` (or
  [the official guide](https://docs.docker.com/engine/install/)). Run Docker as
  root or add your user to the `docker` group.
- `git`, `openssl` (optional; `/dev/urandom` is used otherwise).
- For HTTPS: a domain whose DNS A/AAAA record points at the server, and ports
  80 and 443 reachable from the internet. Without a domain Cineko runs on
  plain HTTP on your local network.
- A free [TMDB](https://www.themoviedb.org/signup) account for the catalog
  (Settings → API → "API Read Access Token"). Optional, but without it the
  catalog is empty.

## Install with `install.sh`

```sh
git clone https://github.com/MartyLee42/cineko-tv-app.git cineko
cd cineko
./install.sh
```

The installer:

1. Checks Docker and the compose plugin (it prints how to install them; it
   never installs anything itself).
2. Asks for the **public address**. A domain (`tv.example.com`) gives
   automatic HTTPS from Let's Encrypt; an IP address (`192.168.1.20`) gives
   plain HTTP on the LAN (`SITE_ADDRESS=:80`, `COOKIE_SECURE=false`).
3. Asks for a **TMDB token**, an optional **DeepSeek key** (AI picks) and an
   optional **outbound proxy** (see [Blocked TMDB / YouTube](#blocked-tmdb--youtube-vpn-profile)).
4. Writes `.env` (mode 0600) and generates every secret: `APP_SESSION_SECRET`,
   `POSTGRES_PASSWORD`, `TRANSCODER_SECRET`, `INVIDIOUS_DB_PASSWORD`,
   `INVIDIOUS_HMAC_KEY`, `INVIDIOUS_COMPANION_KEY`, `METRICS_TOKEN`
   ([metrics](#metrics--prometheus)), `ALERT_TOKEN` ([outage alerts](#outage-alerts)).
   Existing values are never replaced.
5. Pulls the prebuilt images from GHCR (or builds them from the checkout when
   they aren't available, or with `--build`) and starts the stack.
6. Waits for Prowlarr, copies its generated API key into `.env`
   (`PROWLARR_API_KEY`), adds FlareSolverr as an indexer proxy (tag
   `flaresolverr`) and a few public indexers that need no account (RuTor,
   The Pirate Bay, 1337x via FlareSolverr, YTS, EZTV, LimeTorrents). An
   indexer that can't be reached from your server is skipped with a message;
   the install goes on.
7. Restarts `api` and `music` so they pick up the key, creates the first
   **super admin** (username and password asked; the password is never
   echoed and goes to the API over stdin).
8. Prints the URLs and the Media Station X start parameter.

Re-running `./install.sh` is safe: it keeps `.env`, adds only what's missing
in Prowlarr and leaves existing accounts alone. Use it after changing the
address (`--domain` / `--lan`) or to retry failed indexers.

### Non-interactive install

```sh
CINEKO_ADMIN_PASSWORD='a long password' ./install.sh --yes \
  --domain tv.example.com --tmdb "$TMDB_TOKEN" --admin-user me
./install.sh --yes --lan                    # LAN, detected IP, no admin yet
./install.sh --yes --lan 192.168.1.20 --http-port 8080 --https-port 8443
```

`./install.sh --help` lists every option (`--proxy`, `--vpn`,
`--deepseek-key`, `--indexers`, `--skip-prowlarr`, `--build`, `--pull`,
`--admin-password-file`, `--no-start`). Each also has an environment variable
(`CINEKO_DOMAIN`, `CINEKO_LAN=1`, `CINEKO_TMDB`, `CINEKO_PROXY`,
`CINEKO_ADMIN_USER`, `CINEKO_ADMIN_PASSWORD`, `CINEKO_YES=1`, …).

## Manual install

```sh
cp deployments/env.example .env && chmod 600 .env
# Fill in PUBLIC_BASE_URL, SITE_ADDRESS and the secrets, e.g.
#   openssl rand -base64 48 | tr -d '/+='      (APP_SESSION_SECRET, …)
#   openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 16   (INVIDIOUS_COMPANION_KEY)
scripts/cineko.sh pull           # prebuilt images…
scripts/cineko.sh up -d          # …or: scripts/cineko.sh up -d --build  (make prod)
```

`scripts/cineko.sh` is `docker compose -f deployments/compose.yaml --env-file .env`
(plus `deployments/compose.override.yaml` when it exists), runnable from any
directory. Then:

```sh
# Prowlarr's API key → .env, then recreate api and music
scripts/cineko.sh exec prowlarr sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' /config/config.xml
echo 'PROWLARR_API_KEY=<the key>' >> .env
scripts/cineko.sh up -d

# Optional: the same Prowlarr setup install.sh does
scripts/cineko.sh exec -T prowlarr bash -s < scripts/prowlarr-setup.sh

# First administrator (password from stdin, 10+ characters)
scripts/cineko.sh exec api /martytv admin create --username me --role super_admin
```

The compose project is called `cineko`; containers are `cineko-api-1`, etc.

## Configuration

All settings live in `.env`; [`deployments/env.example`](../deployments/env.example)
documents each one. After editing, run `scripts/cineko.sh up -d`: compose
recreates the containers whose settings changed.

- **Secrets** can also come from files: `NAME_FILE=/run/secrets/name`.
  Changing `APP_SESSION_SECRET` signs everyone out and unpairs every TV.
  `POSTGRES_PASSWORD` / `INVIDIOUS_DB_PASSWORD` only take effect on a fresh
  database volume.
- **Local changes to the stack** (extra volumes, ports, limits) go into
  `deployments/compose.override.yaml`, which `scripts/cineko.sh`, `make prod`
  and `install.sh` load automatically. Keep `deployments/compose.yaml`
  unmodified so updates merge cleanly.
- **Memory**: every container has a `mem_limit`. On a small server lower
  TorrServer's cache in its settings and `TRANSCODER_MAX_JOBS`.

## GPU transcoding

Most compatibility streams copy the video; only old codecs (XviD / DivX,
MPEG-2, VC-1 ≤ 1080p) are re-encoded to H.264. That runs on the CPU
(libx264) unless the transcoder finds a working GPU encoder at startup.
`TRANSCODER_HWACCEL=auto` (default) tries, in order, NVIDIA NVENC, VAAPI
(Intel / AMD) and Intel QSV; a backend is used only when ffmpeg has its
encoder **and** a one-second test encode succeeds. Otherwise — and with
`TRANSCODER_HWACCEL=none` — it stays on the CPU. `nvenc` / `vaapi` / `qsv`
restricts the probe to that backend (still falling back to the CPU).
Output is the same on every backend: H.264 High 4.0, 8-bit 4:2:0, a keyframe
every 2 s, AAC audio. A GPU job that fails before any output is retried on the
CPU; if that works, the CPU is used for the next 10 minutes.

The GPU has to be passed into the container — add to
`deployments/compose.override.yaml`:

```yaml
services:
  transcoder:
    # Intel / AMD: the render nodes, readable by the `render` group's id on the host.
    devices: ["/dev/dri:/dev/dri"]
    group_add: ["${RENDER_GID:-109}"]     # getent group render | cut -d: -f3
```

- **Intel**: the amd64 image includes the drivers (iHD for Broadwell and newer,
  i965 for older, oneVPL for QSV).
- **AMD**: needs Mesa's VA driver, which is large (~225 MB), so it is not in
  the published image: build it with
  `build: { context: ../services/transcoder, target: runtime, args: { VA_DRIVERS: mesa-va-gallium } }`
  in the override and `scripts/cineko.sh up -d --build transcoder`.
- **NVIDIA**: the stock image's ffmpeg (Alpine) has no NVENC encoder, so `auto`
  skips it. The detection supports it for a custom image (`FFMPEG_PATH` to an
  ffmpeg with `h264_nvenc`) with the nvidia-container-toolkit, see the
  commented example in `deployments/compose.yaml`.

Check the choice: `scripts/cineko.sh logs transcoder | grep "video encoder"`,
or run the probe again with every attempt shown:
`scripts/cineko.sh exec transcoder martytv-transcoder probe`. The
transcoder's `/metrics` (`video_encoder`, `video_encoder_fallback`) is in the
API's admin system stats too. `TRANSCODER_HWACCEL_DEVICE=/dev/dri/renderD129`
picks another GPU.

## Torrent indexers (Prowlarr)

Cineko searches through Prowlarr. Open its UI through an SSH tunnel:

```sh
ssh -L 9696:127.0.0.1:9696 you@your-server      # then http://localhost:9696
```

On first visit Prowlarr asks you to set a login for its UI. Then
**Indexers → Add indexer**:

- **Public trackers** need nothing else. If one is behind Cloudflare, give it
  the tag `flaresolverr` so its requests go through FlareSolverr.
- **Private / semi-private trackers** (RuTracker, Kinozal, NNM-Club, …): pick
  the tracker and enter your account (login/password, cookie or API key, as
  the form asks). Prowlarr logs in for Cineko; your credentials stay in
  Prowlarr's volume.
- Test the indexer, save. Cineko uses every enabled indexer; no restart
  needed. **Admin → Sources** in Cineko shows each indexer's health.

`install.sh --indexers rutor,1337x:fs,…` chooses which public indexers are
added automatically (definition names as in Prowlarr; `:fs` = through
FlareSolverr). Cineko also queries the public **Jacred** index by default
(`JACRED_URL`, Admin → Sources).

Already running Prowlarr elsewhere? Set `PROWLARR_URL` / `PROWLARR_API_KEY`
to it; the bundled one then just idles (or remove it in the override file).

## TorrServer

TorrServer downloads the pieces a player asks for and serves them over HTTP to
the API and the transcoder; clients never talk to it.

Three of its settings come from `.env` and are applied by
`scripts/torrserver-settings.sh` (install.sh and update.sh run it; flags
`--ts-cache-mb`, `--ts-remove-cache-on-drop`, `--ts-rutor-search` of
install.sh write them):

| `.env` | Default | TorrServer setting |
|---|---|---|
| `TORRSERVER_CACHE_MB` | `128` | `CacheSize` (bytes): RAM cache per torrent |
| `TORRSERVER_REMOVE_CACHE_ON_DROP` | `true` | `RemoveCacheOnDrop`: free a torrent's cache when it closes |
| `TORRSERVER_RUTOR_SEARCH` | `false` | `EnableRutorSearch`: TorrServer's own rutor search (Cineko uses Prowlarr / Jacred) |

The script reads TorrServer's full settings, changes only these fields and
writes the whole object back; everything else you set in its UI stays. It
writes nothing when they already match, because every change makes
TorrServer drop its open torrents and reconnect (whatever is streaming —
Cineko, Lampa, MSX — has to restart). New values apply at once; no restart
is needed (`--restart` restarts it anyway). With basic auth it uses
`TORRSERVER_USERNAME` / `TORRSERVER_PASSWORD`.

```sh
scripts/torrserver-settings.sh                    # bundled TorrServer
scripts/torrserver-settings.sh --url http://127.0.0.1:8090   # your own one, from this machine (curl/wget)
scripts/torrserver-settings.sh --container NAME   # your own one in container NAME
```

The rest (connection limits, preload, …) is in its UI:

```sh
ssh -L 8090:127.0.0.1:8090 you@your-server      # then http://localhost:8090
```

- **Cache**: 128 MB per torrent suits a few simultaneous streams; up to
  256–1024 MB helps on slow torrents. Keep (cache × streams) below the
  container's `mem_limit` (2 GB).
- **Incoming peers** (faster starts on poorly seeded torrents): set a fixed
  "peer port" in its settings and publish it in
  `deployments/compose.override.yaml`:
  ```yaml
  services:
    torrserver:
      ports: ["51413:51413", "51413:51413/udp"]
  ```
- **Basic auth** (only needed if you publish TorrServer yourself): create
  `accs.db` in its config volume (`{"user":"password"}`), set `TS_HTTPAUTH=1`
  plus `TORRSERVER_USERNAME` / `TORRSERVER_PASSWORD` in `.env`, then
  `scripts/cineko.sh up -d`.
- Using an existing TorrServer: set `TORRSERVER_URL` to an address the
  containers can reach (e.g. `http://host.docker.internal:8090` with an
  `extra_hosts: ["host.docker.internal:host-gateway"]` override for `api`,
  `music` and `transcoder`).

## Blocked TMDB / YouTube (VPN profile)

Where TMDB or YouTube are blocked, send that traffic through a proxy. One
setting covers TMDB (API and images), Invidious and companion (YouTube) and
music (Deezer, lyrics):

```sh
./install.sh --proxy socks5h://user:pass@proxy.example:1080   # any SOCKS5 / HTTP proxy
```

This sets `OUTBOUND_PROXY_URL`, derives `INVIDIOUS_HTTP_PROXY` (Invidious
wants a YAML map) and turns on `IMAGE_PROXY=true` so clients load posters
through your server. Per-service overrides: `TMDB_PROXY_URL`,
`MUSIC_PROXY_URL`, `COMPANION_PROXY`. With no proxy everything goes direct.

No proxy of your own? The `vpn` profile runs
[gluetun](https://github.com/qdm12/gluetun), which connects to almost any VPN
provider (WireGuard / OpenVPN) and exposes an HTTP proxy to the stack:

```sh
./install.sh --vpn        # creates gluetun.env and stops: fill it in
nano gluetun.env          # VPN_SERVICE_PROVIDER=…, WIREGUARD_PRIVATE_KEY=…, …
./install.sh --vpn        # sets COMPOSE_PROFILES=vpn, OUTBOUND_PROXY_URL=http://gluetun:8888
```

Torrent traffic (TorrServer, Prowlarr) does **not** go through it. Check:
**Admin → Сервер** shows TMDB and «Видео (Invidious)» status.

## Nightly Invidious restart

Invidious gets slower and runs into YouTube's limits (stale connections,
rate limiting, growing memory) the longer it runs; its own docs recommend
restarting it regularly. Cineko does it every night at **03:00** in the
server's timezone, so it is fresh before anyone watches:

- The API restarts `companion`, then `invidious` (under a minute of «Видео»
  downtime).
- **Never mid-video**: if a YouTube video streamed in the last 5 minutes, the
  restart waits and checks again every 15 minutes; if someone is still watching
  at 05:00 it is skipped until the next night. (Music played from YouTube for
  the first time isn't counted.)
- Settings in `.env`: `INVIDIOUS_RESTART_AT=03:00` (`off` disables it);
  the timezone is `INVIDIOUS_RESTART_TZ`, else `TZ` (install.sh sets it from
  the host), else `NEW_EPISODES_TZ`, else UTC.
- The restart goes through `restart-proxy`
  ([wollomatic/socket-proxy](https://github.com/wollomatic/socket-proxy)),
  which mounts the Docker socket and allows exactly
  `POST /containers/<project>-{companion,invidious}-1/restart`, only from the
  `api` container, on a network of their own. The API itself never sees the
  socket. Rootless Docker or a socket elsewhere: `DOCKER_SOCKET=/run/user/1000/docker.sock`.
- Check: `scripts/cineko.sh logs api | grep -i 'invidious restart'` (the
  schedule is logged at start, every restart or postponement when it happens);
  blocked requests show in `scripts/cineko.sh logs restart-proxy`.

No host cron or systemd timer is needed; it starts with the stack (also after
`scripts/update.sh`). The dev stack (`make dev`) has no proxy, so it is off there.

## Domain, HTTPS and reverse proxies

- **Domain** (`SITE_ADDRESS=tv.example.com`): Caddy gets and renews the
  certificate (HTTP-01 on port 80) and stores it in the `caddy_data` volume.
  HTTP/3 uses 443/udp.
- **LAN only**: `SITE_ADDRESS=:80`, `PUBLIC_BASE_URL=http://192.168.1.20`,
  `COOKIE_SECURE=false`. Other ports: `HTTP_PORT=8080` (then
  `PUBLIC_BASE_URL=http://192.168.1.20:8080`).
- **Behind Cloudflare**: SSL mode "Full (strict)"; set
  `CADDY_TRUSTED_PROXIES` to Cloudflare's ranges and
  `CADDY_CLIENT_IP_HEADER=CF-Connecting-IP` so client IPs can't be spoofed.

### Cineko Music on its own domain

Cineko Music always lives at `/music/` on the main host. Optionally it can also
be its own app on its own host, so phones can install Music alone, or Cineko
and Cineko Music side by side, as two PWAs:

```sh
./install.sh --music-domain music.example.com     # or MUSIC_DOMAIN=… in .env, then scripts/cineko.sh up -d
```

- Point the name's DNS at the server like the main domain (behind Cloudflare:
  proxied the same way). Caddy gets its certificate on first request.
- `https://music.example.com/` serves the Music app at the root (its own
  manifest: id, `start_url` and scope `/`; its own service worker). Caddy also
  proxies `/music/api/*` (music service) and `/api/*` (Cineko API: sign-in,
  settings) there, so the app works same-origin. `/metrics` answers 404.
- **Sign-in**: when both hosts share a parent domain (`tv.example.com` +
  `music.example.com`, or `example.com` + `music.example.com`), the API sets
  the session cookie with `Domain=example.com` (HttpOnly, Secure, SameSite=Lax),
  so one sign-in covers both hosts. Public suffixes are never used
  (`a.github.io` + `b.github.io` → host-only). `COOKIE_DOMAIN=` sets the
  domain by hand; `COOKIE_DOMAIN=off` keeps host-only cookies (then Music has
  its own sign-in screen on its host, which works too). The music origin is
  added to the API's allowed origins automatically.
- **Existing sessions** keep working on the main host (old host-only cookie);
  the music host asks for one sign-in, after which the shared cookie replaces
  the old one on whichever host you sign in to. A browser holding both is
  fine: the API takes the first valid one, and signing out clears both.
- The shared cookie is sent to every subdomain of the parent domain: if other,
  less trusted sites run on subdomains of it, use `COOKIE_DOMAIN=off`.
- Unset `MUSIC_DOMAIN` (or `--music-domain off`) = only `/music/`, exactly as
  before.

### Behind an existing nginx (or another proxy)

Keep Caddy as the inner server on a local port and let nginx terminate TLS:

```sh
# .env
SITE_ADDRESS=:80
HTTP_PORT=127.0.0.1:8081      # publish Caddy on loopback only
HTTPS_PORT=127.0.0.1:8443
PUBLIC_BASE_URL=https://tv.example.com
COOKIE_SECURE=true
```

```nginx
server {
  listen 443 ssl http2;
  server_name tv.example.com;
  # ssl_certificate …; ssl_certificate_key …;
  client_max_body_size 50m;

  location / {
    proxy_pass http://127.0.0.1:8081;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    # WebSocket (/api/v1/ws)
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    # Video and audio streams: unbuffered, long-lived, Range passes through
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 6h;
    proxy_send_timeout 6h;
  }
}
# in http {}:  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

Never let the outer proxy compress or buffer `/api/v1/stream/*`,
`/api/v1/vstream/*`, `/api/v1/speedtest` or `/music/api/*` streams. Caddy
already trusts private ranges for `X-Forwarded-For`; if nginx is on another
host with a public IP, set `CADDY_TRUSTED_PROXIES` to it.

## TVs: Media Station X

The TV app runs inside [Media Station X](https://msx.benzac.de/) (Samsung
Tizen, LG webOS, Android TV, …):

1. Install Media Station X from the TV's app store.
2. **Settings → Start Parameter → Setup**, enter your address without the
   scheme: `tv.example.com` (or `192.168.1.20`, `192.168.1.20:8080`).
3. Cineko appears in the MSX menu. The TV shows a code / QR; confirm it on a
   phone that's signed in to Cineko (pairing).

The launcher is `/msx/start.json`. `MSX_APPS` adds more buttons to the MSX
menu; `MSX_BRIDGE=false` serves a plain menu.

A newly paired TV shows the «Каркас» design for every profile until another
design is picked on it (TVs paired earlier keep theirs). `NEW_TV_DESIGN` sets
another design id; `NEW_TV_DESIGN=` (empty) or `off` makes new TVs follow the
profile's design.

## Updating

```sh
scripts/update.sh            # git pull, pull new images (or rebuild), restart
scripts/update.sh --build    # always build from the checkout
```

Database migrations run automatically when the API starts. Pin a release
with `CINEKO_VERSION=1.2.0` in `.env` (default `latest`). Third-party images
(Prowlarr, TorrServer, Invidious, …) are pinned in `deployments/compose.yaml`
and move with Cineko updates. When YouTube playback breaks, a newer
`invidious-companion` tag usually fixes it: override its `image:` in
`deployments/compose.override.yaml`.

### Old releases' assets (the asset archive)

A page opened before an update keeps running the release it started with —
TVs for days (the TV app reloads by itself only at a quiet moment, never
during playback). Its screens, players, loading styles, designs and strings
are lazy chunks with hashed names, fetched from the server when first
needed. So that they don't vanish with the update, the web container keeps
earlier releases' hashed files in the **asset archive**, the `asset-archive`
volume mounted at `/srv/asset-archive`:

- At start, the container adds its own `/assets/*` (PWA) and `/tv/assets/*`
  (TV app) files to the archive (hashed names never collide), notes which
  files the release has, and prunes: a file goes once it is older than 14
  days **and** none of the last 3 releases has it (`ASSET_ARCHIVE_DAYS`,
  `ASSET_ARCHIVE_RELEASES` on the `web` service). Only immutable hashed files
  go in — never `index.html`, `sw.js` or the manifest.
- Caddy serves `/assets/*` and `/tv/assets/*` from the current build first,
  then from the archive (both with the long immutable cache header); a file
  in neither is a `404` with `Cache-Control: no-store` (never the app's
  `index.html`).
- Cineko Music does the same in its own data volume
  (`music-data:/data/asset-archive`, `MUSIC_ASSET_ARCHIVE=off` disables it)
  for both of its builds.
- `scripts/update.sh` (and the owner's `deployments/deploy.sh`) also copy the
  assets of the release running *before* the update into the archive, so the
  first update with the archive already covers it.

Without the archive (the volume removed) or once a file is pruned, the apps
still recover: a chunk that fails to download while the server has a newer
release reloads the page once («Обновляем приложение…»; a sessionStorage
marker prevents reload loops), and the TV app comes back to the title it was
starting or playing, at the same position and source (or to the Details
page it showed).

## Backup and restore

```sh
scripts/backup.sh                     # → backups/<date>/
```

The backup holds the database dump (`cineko.dump`), the music library
(`music-data.tar`), Prowlarr's and TorrServer's settings and a copy of `.env`
(**secrets: keep it private**). Caches (posters, YouTube audio, HLS) and
server downloads are not included. Without the same `APP_SESSION_SECRET`,
restored sessions and TV pairings stop working (accounts, profiles and
history are unaffected).

Restore on a new server (same or newer Cineko):

```sh
cp backups/<date>/env .env && chmod 600 .env
scripts/cineko.sh up -d postgres
scripts/cineko.sh exec -T postgres pg_restore -U martytv -d martytv --clean --if-exists < backups/<date>/cineko.dump
scripts/cineko.sh up -d
scripts/cineko.sh exec -T prowlarr tar -C /config -xf - < backups/<date>/prowlarr-config.tar
scripts/cineko.sh exec -T torrserver tar -C /opt/ts -xf - < backups/<date>/torrserver-config.tar
scripts/cineko.sh stop music
docker run --rm -i -v cineko_music-data:/data alpine tar -C /data -xf - < backups/<date>/music-data.tar
scripts/cineko.sh restart prowlarr torrserver music
```

## Server downloads on another disk

«Скачать на сервер» keeps full copies of torrents in the API's `cache` volume
by default. To use a bigger disk, mount it in `deployments/compose.override.yaml`
and make it writable by the API's user (uid 65532):

```yaml
services:
  api:
    environment:
      LIBRARY_DIR: /var/lib/martytv/library
    volumes:
      - /mnt/big/cineko-library:/var/lib/martytv/library
```

```sh
sudo mkdir -p /mnt/big/cineko-library && sudo chown 65532:65532 /mnt/big/cineko-library
scripts/cineko.sh up -d api
```

Admin → «Хранилище» sets the free-space reserve, size cap and keep days.

## Host monitor (optional)

The admin **Server** tab shows the container's own CPU/RAM by default. For the
whole host, install the small `martytv-hostmon` service (static Go binary,
read-only, no network; answers on `/run/martytv/hostmon.sock`):

```sh
docker build --target hostmon --output type=local,dest=/tmp/hostmon services/api
sudo install -m 755 /tmp/hostmon/martytv-hostmon /usr/local/bin/
sudo install -m 644 deployments/hostmon/martytv-hostmon.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now martytv-hostmon
```

and mount its socket into the API (`deployments/compose.override.yaml`):

```yaml
services:
  api:
    volumes: ["/run/martytv:/run/martytv:ro"]
```

## Metrics / Prometheus

«Метрики»: the API and Cineko Music serve `GET /metrics` in the Prometheus text
format, for Prometheus, VictoriaMetrics, Grafana Agent / Alloy and the like.

- **Off** unless `METRICS_TOKEN` is set in `.env` (then `/metrics` answers
  404). `install.sh` generates one; set or change it by hand and run
  `scripts/cineko.sh up -d`.
- Every scrape needs `Authorization: Bearer <METRICS_TOKEN>` (else 401).
- **Not public**: Caddy only proxies `/api`, `/msx`, `/music…` and `/healthz`, so
  `https://<your domain>/metrics` is just the PWA. Scrape from inside the
  compose network: `api:8080/metrics` and `music:8080/metrics`.
- Cheap: the snapshot (host load, DB counts, device health, AI usage,
  integrations) is refreshed every 20 s only while someone scrapes; a 15–60 s
  scrape interval is fine.

What's there (all prefixed `cineko_`; Go runtime and process series as usual):

| Area | Series |
|---|---|
| HTTP | `http_requests_total{method,route,status}` (route = template like `/api/v1/media/:id`, status = `2xx`…), `http_request_duration_seconds{method,route}` |
| Server tab | `host_cpu_usage_ratio`, `host_load1/5/15`, `host_memory_*_bytes`, `host_swap_*_bytes`, `host_disk_{total,used,free}_bytes{mount}`, `host_network_{receive,transmit}_bytes_total{iface}`, `container_{running,cpu_ratio,memory_bytes,memory_limit_bytes}{container}` (with the [host monitor](#host-monitor-optional); otherwise the API container's own numbers, `host_info{scope="container"}`), `db_size_bytes`, `image_cache_bytes` |
| Database | `db_pool_{acquired,idle,total,max}_conns`, `db_pool_acquires_total`, `db_pool_acquire_duration_seconds_total`, … |
| Playback | `active_streams`, `playback_sessions_active{client}`, `websocket_connections{kind}`, `transcoder_{up,active_jobs,max_jobs}`, `transcoder_jobs_{started,rejected,failed}_total`, `torrserver_{up,torrents,active_torrents,peers}`, `torrserver_{download,upload}_bytes_per_second` |
| Downloads | `downloads{status}`, `downloads_size_bytes{status}`, `downloads_done_bytes{status}` |
| Integrations | `integration_up{name}`, `integration_configured{name}` (tmdb, prowlarr, torrserver, kinopoisk; checked every 30 s), `integration_budget_remaining{name="kinopoisk"}`, `invidious_{configured,up,latency_seconds}` |
| AI | `ai_enabled`, `ai_tokens_today`, `ai_calls_today`, `ai_daily_token_budget`, `ai_asks_today`, `ai_ask_daily_limit_per_user`, `ai_balance{currency}`; music: `music_ai_tokens_today`, `music_ai_daily_token_budget` («today» = the Moscow day the budgets use) |
| Errors | `client_error_groups_open{app}`, `client_error_events{app}` (Admin → Errors) |
| TVs | `devices_paired`, `devices_seen_1d`, `users`, `profiles`; latest health report per TV (≤ 1 day old) `device_health_{fps,heap_used_bytes,heap_limit_bytes,event_loop_lag_seconds,slow_frames_ratio,long_tasks,dropped_frames,total_frames,…}{device,model}` — labelled by device id and model, never the TV's name |
| Meta | `build_info{version}`, `metrics_source_up{source}` (0 = that part of the snapshot failed; see the API log) |

Example: Prometheus next to Cineko, in `deployments/compose.override.yaml`.
Put the token in a file Prometheus reads (it isn't printed):

```sh
grep '^METRICS_TOKEN=' .env | cut -d= -f2- > deployments/metrics_token && chmod 600 deployments/metrics_token
```

```yaml
services:
  prometheus:
    image: prom/prometheus:v3.5.0
    restart: unless-stopped
    user: "0"   # reads the 0600 token file
    command: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.retention.time=30d"]
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./metrics_token:/etc/prometheus/metrics_token:ro
      - prometheus-data:/prometheus
    ports: ["127.0.0.1:9090:9090"]   # UI through an SSH tunnel
    networks: [internal]
volumes:
  prometheus-data:
```

`deployments/prometheus.yml`:

```yaml
global:
  scrape_interval: 30s
scrape_configs:
  - job_name: cineko-api
    metrics_path: /metrics
    authorization: { credentials_file: /etc/prometheus/metrics_token }
    static_configs: [{ targets: ["api:8080"] }]
  - job_name: cineko-music
    authorization: { credentials_file: /etc/prometheus/metrics_token }
    static_configs: [{ targets: ["music:8080"] }]
```

**Prometheus on another machine**: tunnel or publish the API's port only on a
private interface (LAN / VPN address), e.g. in the override
`services: { api: { ports: ["10.8.0.1:9101:8080"] } }`, and scrape
`10.8.0.1:9101` with the same bearer token. Don't add `/metrics` to the
Caddyfile unless you also restrict who can reach it — the token protects it,
but the numbers describe your household's viewing.

**Grafana**: add the Prometheus data source and build panels from e.g.
`sum by (route) (rate(cineko_http_requests_total{status="5xx"}[5m]))`,
`histogram_quantile(0.95, sum by (le, route) (rate(cineko_http_request_duration_seconds_bucket[5m])))`,
`cineko_host_cpu_usage_ratio`, `cineko_active_streams`,
`cineko_ai_tokens_today / cineko_ai_daily_token_budget`,
`cineko_device_health_fps`, `cineko_integration_up == 0` (alert).

## Outage alerts

«Оповещения о сбоях»: when something the household depends on breaks, every
admin and super_admin gets a **Cineko message** (the bell in the PWA; never on
TVs) and, on devices where they turned it on, a **Web Push** notification.
Admin → **Инциденты** lists open incidents and the last 30 days.

What opens an incident (`services/api/internal/alerts`):

| Source | Kind | Condition |
| --- | --- | --- |
| API monitor (every minute, reusing the cached `/readyz` checks; open after 3 failed checks in a row, close after 2 good ones) | TMDB | the probe fails (401 → «TMDB отклоняет ключ») |
| | Prowlarr / TorrServer | the probe fails (only when configured) |
| | YouTube | Invidious doesn't answer its health probe |
| | VPN | the outbound proxy (`TMDB_PROXY_URL`) refuses TCP connections; TMDB failures then count as the VPN's |
| | Disk | a filesystem has less than min(10 %, 5 GiB) free (hostmon, else the container's) |
| | Database | `Ping` fails (the message can't be stored then: push only) |
| Host watchdog (`martytv-video-watchdog`) | YouTube | search or video streams still fail after it restarted Invidious / the companion (the message says so: «Компаньон перезапущен, не помогло.») |
| | VPN | YouTube and TMDB fail through the VPN for ≥ 3 checks and a restart of `awg-socks` didn't help |
| Host image updater | Update | a new Invidious / companion release was rolled back (once per 6 h per release); YouTube still broken after the rollback |

One notice on open, a reminder at most every 6 h while open, one on recovery
(«Снова работает: YouTube (сбой 23 мин)»). Times are in the household's
timezone (`TZ`). An incident nobody reports on for 20 minutes (a check turned
off, the watchdog removed) closes silently. Message language: the admin's
newest push subscription (the PWA's language when it was turned on), else
Russian.

**Web Push**: Admin → Инциденты → «Уведомления о сбоях» → Включить (per
browser / phone; on iPhone add Cineko to the Home Screen first). Needs HTTPS.
The VAPID key pair is generated by the API on first use and kept in the
database — nothing to configure. The API sends pushes directly (not through
the VPN proxy) to the browsers' push services (FCM, Mozilla, Apple, Windows),
so outbound HTTPS to them must work; otherwise only the messages arrive.

**Host scripts**: they `POST http://api:8080/internal/incident` with
`Authorization: Bearer $ALERT_TOKEN` from the web container (`docker exec
martytv-web-1 wget …`; the token goes on stdin), reading `ALERT_TOKEN` from
`/opt/martytv/.env`. `install.sh` and `deployments/deploy.sh` generate it;
without it the endpoint answers 404 and the scripts skip reporting. A failed
report never fails the script. The endpoint is outside `/api`, so Caddy never
publishes it. Body: `{"kind": "youtube"|"vpn"|"updater", "state":
"down"|"up"|"event", "cause": "search"|"streams"|"rollback", "action":
"invidious_restarted"|"companion_restarted"|"vpn_restarted"|"rolled_back",
"detail": "…"}` (down/up are already debounced by the scripts).

## Troubleshooting

```sh
scripts/cineko.sh ps                         # health of every container
scripts/cineko.sh logs -f --tail=100 api     # or web, music, prowlarr, torrserver, invidious …
scripts/cineko.sh exec web wget -qO- http://api:8080/readyz   # DB + integrations status
curl -s https://tv.example.com/healthz
```

- **No search results**: Prowlarr has no working indexers, or
  `PROWLARR_API_KEY` is missing/stale (re-run `./install.sh`). Admin → Sources
  shows each indexer; Prowlarr → System → Status shows failing ones.
- **Playback never starts**: TorrServer can't get peers (firewall, dead
  torrent) — check `scripts/cineko.sh logs torrserver` and try another release.
  Browser-only audio problems (no sound in Chrome/Safari) are handled by the
  transcoder; check its logs.
- **Empty catalog / no posters**: no TMDB key, or TMDB is blocked — set a
  proxy (see above). `readyz` shows `tmdb`.
- **«Видео» says unavailable**: Invidious can't reach YouTube. Check
  `scripts/cineko.sh logs companion`; behind blocks, use the proxy/VPN; update
  the companion image.
- **HTTPS certificate fails**: DNS must point at the server and port 80 must
  be reachable from the internet; `scripts/cineko.sh logs web`.
- **Signed out immediately on HTTP**: `COOKIE_SECURE=false` is required
  without HTTPS (install.sh sets it in LAN mode).
- **Port 80/443 already in use**: set `HTTP_PORT` / `HTTPS_PORT`, or run
  behind your existing proxy (above).
- **Start over** (deletes all data!): `scripts/cineko.sh down -v && rm .env`.

## Development

`make dev` runs the development stack (`deployments/compose.dev.yaml`):
Postgres on `127.0.0.1:5433`, the API with live reload, Vite for the web and
TV apps, Caddy on `:8080`. `make check` runs lint, typecheck and all tests.
Migrations are embedded SQL files (`services/api/internal/db/migrations`,
goose) applied on `serve`, `migrate` and `admin create`.

Streaming path: TorrServer → API → Caddy → player through
`/api/v1/stream/<token>`; the proxy must not buffer or compress it and must
allow responses lasting hours (the bundled Caddyfile has a dedicated
`handle` with `flush_interval -1` and excludes those paths from `encode`).
