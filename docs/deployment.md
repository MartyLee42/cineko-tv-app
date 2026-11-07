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
   `INVIDIOUS_HMAC_KEY`, `INVIDIOUS_COMPANION_KEY`. Existing values are never
   replaced.
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
