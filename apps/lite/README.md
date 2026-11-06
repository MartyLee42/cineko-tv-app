# Cineko Lite

A light, **serverless** edition of Cineko that runs entirely in the browser
and is hosted on GitHub Pages:

- **Web** (PC and phones, installable PWA): <https://martylee42.github.io/cineko-tv-app/>
- **TV** (Media Station X, D-pad remote): <https://martylee42.github.io/cineko-tv-app/tv/>
- **MSX start file**: <https://martylee42.github.io/cineko-tv-app/msx/start.json>

The catalog comes from [TMDB](https://www.themoviedb.org/) and the video from
the public CDNVideoHub player API, both called straight from the browser.
There is no backend: nothing to install, nothing to pay for.

## What it does

- Home with rows: Продолжить просмотр, В тренде, popular / top movies and
  series, genres; Marty (the mascot) greets you depending on the time of day.
- Search (movies and series), title pages (backdrop, poster, rating, genres,
  cast, «Похожие», «Вам может понравиться»), seasons and episodes.
- «Смотреть» appears only when CDNVideoHub has the title (checked when you
  open the title page); otherwise «Нет онлайн-источника».
- Voice-over picker, quality picker (144p…2160p progressive MP4, HLS as a
  fallback), resume position per episode, next / previous episode,
  auto-next, keyboard shortcuts (web: Space, ←/→, ↑/↓, F, M, N, P, 0–9).
- Favorites, watch history, settings: language (Русский / Қазақша / English),
  design (the main app's ten designs, «Кинозал» by default, light mode for
  «Кинозал»), default quality, TMDB key and mirrors, export / import of
  all data as a JSON file.

## Limitations

- No torrents, no accounts, no profiles, no sync between devices: everything
  (favorites, history, resume positions, chosen voice-over and quality per
  title, settings) is stored in **this browser's localStorage**. Use
  Settings → «Экспорт в файл» / «Импорт из файла» to move it.
- Only titles that CDNVideoHub carries can be played (it is looked up by
  IMDb id). Many titles have no online source.
- Stream URLs are signed for the IP address and browser that requested them
  and expire after about a day. That is why playback works only in the
  browser that opened the page (no casting a URL to another device).
- TMDB is blocked in some regions. The app tries `api.themoviedb.org`
  first and switches to the `apitmdb.cub.red` / `imagetmdb.cub.red` mirror on
  a network error (remembered); both are selectable in Settings.
- TMDB has little Kazakh metadata: with Қазақша the UI is Kazakh and
  untranslated titles, overviews and genres fall back to Russian.
- The TMDB API key is the public key of the Lampa ecosystem; you can set your
  own in Settings. This product uses the TMDB API but is not endorsed or
  certified by TMDB.

## Media Station X

1. Install **Media Station X** on the TV (Samsung Tizen, LG webOS, Android TV…).
2. Open **Settings → Start Parameter → Setup**.
3. Enter **`martylee42.github.io/cineko-tv-app`** and turn the **lock icon on**
   (HTTPS). MSX loads `https://martylee42.github.io/cineko-tv-app/msx/start.json`
   and shows the Cineko Lite launcher; press OK to open the TV app.

If your MSX version doesn't accept a path in the start parameter
(MSX documents the input as a host name: it requests
`http(s)://{input}/msx/start.json`), use one of these instead:

- A URL shortener alias, which MSX supports natively: shorten
  `https://martylee42.github.io/cineko-tv-app/msx/start.json` with a custom
  alias at <https://is.gd> (e.g. `cinekolite`) and enter **`id:igd:cinekolite`**
  as the start parameter (lowercase only).
- In a browser-based MSX, open
  `https://msx.benzac.de/?start=content:https://martylee42.github.io/cineko-tv-app/msx/menu.json`.

The TV app is laid out for 1920×1080 and scales to any screen. Remote:
arrows move, OK selects, Back (Backspace / Escape / webOS 461 / Tizen 10009)
goes back, Back twice on Home leaves the app. In the player: OK = pause,
◀ ▶ = seek (hold or repeat to speed up), ▲ ▼ = panel with episodes,
voice-overs and quality, ⏮ ⏭ = previous / next episode.

## Develop

Standalone npm project (not part of the pnpm workspace). With Node 22:

```sh
cd apps/lite
npm ci
npm run dev        # web at http://127.0.0.1:5173/cineko-tv-app/
npm run dev:tv     # TV at  http://127.0.0.1:5173/cineko-tv-app/tv/
npm test           # vitest: CDNVideoHub parsing / grouping / quality ladder, TMDB fallback
npm run build      # dist/ (web) + dist/tv/ + dist/msx/
npm run preview    # serves dist/ at http://127.0.0.1:4173/cineko-tv-app/
```

Without a local Node, the same in Docker:

```sh
docker run --rm -u $(id -u):$(id -g) -v "$PWD":/w -w /w/apps/lite \
  -e npm_config_cache=/w/.cache/npm node:22-bookworm-slim sh -c "npm ci && npm test && npm run build"
```

`LITE_BASE` sets the site path (default `/cineko-tv-app/`) and `SITE_URL` the
public URL written into `msx/start.json`. The Pages workflow
(`.github/workflows/pages.yml`) derives both from the repository's Pages
settings, so a fork deploys to `https://<owner>.github.io/<repo>/` as is
(enable Settings → Pages → Source: GitHub Actions once).

### Layout

```
src/core/    tmdb.ts (client + mirror fallback), cvh.ts (CDNVideoHub), store.ts
             (localStorage, export/import), i18n.ts (ru/kk/en), designs.ts
src/shared/  playback hook, source lookup, catalog rows, Marty, theme tokens
             (vendored from packages/ui/src/theme.css), fonts, icons
src/web/     PC + phone UI (hash routes, PWA service worker in web/public/sw.js)
src/tv/      TV UI: spatial navigation (nav.ts), Back trap for MSX/webOS,
             1920×1080 canvas, player with the remote panel
web/, tv/    the two HTML entries + their public files
scripts/     assemble.mjs (MSX start/menu files), serve.mjs (preview)
```
