<p align="center">
  <img src="packages/ui/src/marty/happy.webp" width="140" alt="Cineko, the Cineko robot-cat" />
</p>

<h1 align="center">Cineko</h1>

<p align="center">
  Self-hosted movies, series, live TV, YouTube and music for your household —<br />
  a lean-back <b>TV app</b> for Media Station X and a <b>PWA</b> for phones and computers.
</p>

<p align="center">
  <a href="https://martylee42.github.io/cineko-tv-app/"><b>Try Cineko Lite</b></a> (no server, runs in your browser) ·
  <a href="#install">Install the full version</a> ·
  <a href="docs/deployment.md">Deployment guide</a>
</p>

---

Cineko comes in two editions:

| | **Cineko** (full, self-hosted) | **Cineko Lite** (GitHub Pages) |
|---|---|---|
| Where it runs | Your server (Docker Compose) | Your browser, nothing to install |
| Catalog | TMDB, Kinopoisk/IMDb ratings, curated lists, AI picks | TMDB |
| Video | Torrents (Prowlarr + TorrServer), online sources, IPTV, YouTube (Invidious) | Online source (CDNVideoHub) |
| Accounts | Household accounts, profiles, TV pairing by QR, phone as a remote | None — likes, history and settings stay on the device (export/import as JSON) |
| Extras | Cineko Music (`/music`), server downloads, offline downloads to phones, browser-compatible transcoding (GPU when present), Prometheus metrics | — |
| TV | Media Station X app with the native player bridge | Media Station X app (D-pad) |
| Languages | Russian, English, Kazakh | Russian, Kazakh, English |

## Features (full version)

- **TV app** for Media Station X (Samsung, LG, Android TV…): spatial remote navigation, **13 designs** — Кинозал, Терминал, Проектор, Каркас, Киберпанк, Ар-деко, Ретро 80-е, Ретро 90-е, Поп-арт, Конструктивизм, Матрица, Стикербук, Тамагочи — or «Сюрприз» (a different favourite each day or week), each with its own startup intro, loaders and interface sounds; every design is a lazy chunk, so old TVs start fast.
- **Player:** voice-over / subtitle / quality switching, chapters on the seek bar, **skip intros, recaps and credits**, «next episode» with a countdown, sleep timer, resume everywhere (even when a TV engine restarts the stream from 0), a screensaver over a long pause; releases are ranked by what plays **smoothly** on that TV, with a lighter-release suggestion when it stutters.
- **Watch companion:** «Ранее в сериале» recaps before an episode, «После титров» (the ending explained, why it matters, a spoiler chat), title quotes and facts, «Послушать саундтрек» as a Cineko Music playlist.
- **PWA** for phones and computers: browse, search (incl. «Спросить ИИ»), manage household accounts and profiles, pair TVs by QR code and use the phone as a remote.
- **Sources:** torrents through your own **Prowlarr** or **Jackett** (+ FlareSolverr) streamed by **TorrServer**, online balancers, **IPTV** playlists with EPG, a **YouTube** tab through a private **Invidious** (autoplay of the next part).
- **Recommendations:** «Для вас» rows, taste by themes, family picks, taste quiz, curated film lists (Sight & Sound, Ebert, Cahiers du cinéma…); optional AI via DeepSeek — daily collections, theme rubrics and picks with a personal reason.
- **Cineko Music** at `/music`: Deezer catalog, YouTube / zaycev.net / lossless torrent audio, lyrics, tabs, AI playlists, offline downloads.
- **Cozy extras:** Cineko the robot-cat mascot (with costumes), cozy mode, holiday animations, live posters.
- **Operations:** one-command install, GPU transcoding auto-detected (NVENC / VAAPI / QSV, CPU fallback), TorrServer tuned from `.env`, nightly Invidious restart, an admin server monitor and Prometheus `/metrics`.
- **Privacy:** everything runs on your server; nothing is published except the Caddy web server (automatic HTTPS).

## Install

You need a Linux server (amd64 or arm64, 2+ cores, 4 GB RAM — 8 GB is comfortable; a current
distribution such as Ubuntu 22.04+/Debian 12, on a KVM VPS or real hardware) with Docker and the
compose plugin (`curl -fsSL https://get.docker.com | sh`). The full stack idles at ~850 MB of RAM;
details in [docs/deployment.md → Sizing](docs/deployment.md#sizing).

```sh
git clone https://github.com/MartyLee42/cineko-tv-app.git cineko
cd cineko
./install.sh
```

The installer:

1. asks for your address — a **domain** gets automatic HTTPS (ports 80/443 open, DNS pointing at the server); an **IP address** runs on your LAN over HTTP;
2. asks for an optional [TMDB](https://www.themoviedb.org/signup) token (needed for the catalog), an optional DeepSeek key (AI picks) and an optional proxy / VPN (for regions where TMDB or YouTube are blocked);
3. asks which optional parts you want — YouTube «Видео» (Invidious), Cineko Music, **Prowlarr** or **Jackett** for torrent search (or your own), **TorrServer** (or your own); a part you skip gets no containers and no menu item ([details](docs/deployment.md#optional-parts));
4. generates every secret into `.env` (mode 0600, never overwritten on re-runs);
5. starts the stack: Cineko (API, transcoder, web) plus the parts you chose, with Prowlarr or Jackett preloaded with public indexers;
6. applies the TorrServer settings and creates your administrator account, then prints the addresses.

Then:

- open `https://your-domain` on phones and computers (install it to the home screen);
- on TVs install **Media Station X** and set its start parameter to `your-domain`;
- add private trackers in Prowlarr (`ssh -L 9696:127.0.0.1:9696 your-server`, then <http://localhost:9696>).

Non-interactive: `./install.sh --yes --domain tv.example.com --tmdb <token> --admin-user me`
(password from `CINEKO_ADMIN_PASSWORD`); add e.g. `--no-youtube --no-music --indexer jackett`
for a lean install. `./install.sh --help` lists every option.

Operate with `scripts/cineko.sh <compose args>` (e.g. `scripts/cineko.sh ps`, `logs -f api`), update with
`scripts/update.sh`, back up with `scripts/backup.sh`. Private trackers, GPU transcoding, the VPN profile,
nginx, metrics, restore and troubleshooting: **[docs/deployment.md](docs/deployment.md)**.

Prebuilt images are published to GHCR (`ghcr.io/martylee42/cineko-tv-app-{api,web,music,transcoder}`);
the installer falls back to building from source when they can't be pulled.

## Cineko Lite (no server)

- **PC and phones:** <https://martylee42.github.io/cineko-tv-app/>
- **TV (Media Station X):** start parameter `martylee42.github.io/cineko-tv-app` (lock icon on)

Catalog from TMDB, video from the public CDNVideoHub player API, both called straight from the browser.
No torrents, no accounts — your likes, history, resume positions and settings are stored on the device.
Details and limitations: [apps/lite/README.md](apps/lite/README.md).

## Development

Everything runs in Docker:

```sh
make dev                 # Postgres, API (live reload), PWA, TV app, music, proxy on :8080
make admin USER=me       # create an administrator (prompts for the password)
make test               # Go (with the dev Postgres) + JS unit tests
make lint typecheck
make e2e                 # Playwright
```

- PWA: <http://localhost:8080> · TV app: <http://localhost:8080/tv/> · Music: <http://localhost:8080/music/>
- MSX start parameter: `<lan-ip>:8080`

```
apps/tv              React TV app (spatial navigation, served at /tv/)
apps/web             React PWA (served at /)
apps/lite            Cineko Lite — serverless web + TV builds for GitHub Pages
services/api         Go (Fiber) modular monolith + SQL migrations
services/music       Cineko Music at /music (Go + SQLite + React)
services/transcoder  ffmpeg sidecar for browser-compatible streams
packages/contracts   OpenAPI contract, generated TS client, realtime client
packages/ui          shared components, designs, mascot, ru/en/kk translations
packages/media-types shared media model
deployments/         compose files, Caddyfiles, env.example
scripts/             cineko.sh, update, backup, Prowlarr and TorrServer setup
docs/                architecture, API, pairing, deployment, testing
e2e/                 Playwright tests
```

Docs: [Architecture](docs/architecture.md) · [API](docs/api.md) · [Pairing](docs/pairing.md) ·
[Deployment](docs/deployment.md) · [Testing](docs/testing.md)

## License

[MIT](LICENSE) — free for any use, including commercial; keep the copyright notice.

## Disclaimer

Cineko is a media center for content you are entitled to access. It ships no content and no tracker
accounts; what you index and stream through your own Prowlarr and TorrServer is your responsibility.
This product uses the TMDB API but is not endorsed or certified by TMDB.
