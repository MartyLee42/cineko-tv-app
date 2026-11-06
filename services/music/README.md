# Cineko Music (`/music`)

A Spotify-style music app for the household, served at `/music` next to
Cineko. It is a separate container (Go service + its own React app + ffmpeg);
Cineko's API, PWA and TV app are untouched. Same accounts: the Cineko
session cookie is checked against the API (`/api/v1/auth/session`), and the
login form posts to `/api/v1/auth/login`.

## Sources

| What | Where from |
|------|------------|
| Catalog: search, charts, genres, artists, albums, playlists, artist radio | Deezer public API (no key) |
| Audio of catalog tracks | YouTube via the household Invidious: each track is matched to an upload (duration, "Artist - Topic" channels, title, no live/cover/remix), verified to actually stream, then the AAC audio is proxied and **cached on disk** (`MUSIC_CACHE_GB`, LRU) |
| Lossless albums / anything not in the catalog | Prowlarr search → TorrServer stream. Album tracks are matched to the release's files (discographies and `image+.cue` included). FLAC/MP3/AAC/OGG play natively; APE/WavPack/DSD and CUE tracks are transcoded to MP3 320 by ffmpeg |
| Lyrics (synced when available) | LRCLIB |
| Covers | Deezer CDN, proxied and cached |

The Invidious route to YouTube (the VPN SOCKS proxy) fails transiently, so
Invidious calls are retried, the next track in the queue is resolved and
downloaded ahead of time, and replays come from the disk cache.

## Features

Home with «Моя волна» (endless mix from your top artists), artist mixes,
recently played, charts; search (catalog + torrents); artist / album /
playlist pages; likes, saved albums/artists/playlists and your own playlists
(per Cineko account, SQLite in `/data`); queue (play next, reorder),
shuffle, repeat, autoplay of similar tracks when the queue ends; synced
lyrics; "wrong recording?" picker per track (shared by everyone); per-album
"always play from this torrent"; lock-screen / headphone controls (Media
Session); installable on phones (manifest).

## Development

```sh
# Go unit tests
docker build --target test -t martytv-music:test services/music && docker run --rm martytv-music:test

# Run the service locally against the dev stack's .env, without Cineko login:
#   MUSIC_DEV_USER=me MUSIC_DATA_DIR=/tmp/mm MUSIC_STATIC_DIR=web/dist go run .
# UI with hot reload (proxies /music/api to 127.0.0.1:18090):
cd services/music/web && npm install && npm run dev
```

In the dev stack (`make dev`) it is the `music` service behind Caddy at
<http://localhost:8080/music/>.

Data (`/data`): `music.db` (library, YouTube matches, opened torrents),
`audio/` (YouTube audio cache), `img/` (covers).
