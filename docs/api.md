# API

The contract lives in [`packages/contracts/openapi.yaml`](../packages/contracts/openapi.yaml).
Run `make gen` after changing it to regenerate `packages/contracts/src/schema.d.ts`.
Both frontends call the API through `createApi()` and `unwrap()` from `@martytv/contracts`.

Base path: `/api/v1`. Realtime: `/api/v1/ws` (see [architecture.md](architecture.md#realtime-protocol-apiv1ws)).

## Conventions

- **Auth:** the `mt_session` cookie plus `X-CSRF-Token` on unsafe methods;
  `Authorization: Bearer mtp_…` (API token) or `mtd_…` (TV);
  `Authorization: Pairing <secret>` for pairing status and exchange.
- **Errors:** always the same envelope:
  ```json
  {"error": {"code": "validation_failed", "message": "Some fields are invalid.",
             "request_id": "…", "fields": {"name": "must be 1-32 characters"}}}
  ```
  Codes in use:
  - `unauthorized`, `invalid_token`, `invalid_credentials`
  - `forbidden`, `insufficient_scope`, `session_required`
  - `csrf_failed`, `bad_origin`
  - `not_found`, `validation_failed`, `rate_limited` (with a `Retry-After` header)
  - `pairing_*`, `last_admin`, `last_super_admin`, `self_lockout`,
    `super_admin_required` (403), `profile_limit`, `internal`
  - `catalog_unavailable` (503, TMDB not configured), `catalog_upstream_error`
    (502, TMDB unreachable and nothing cached), `image_unavailable` (502)
  - `releases_unavailable` (503, Prowlarr not configured), `releases_upstream_error`
    (502, Prowlarr unreachable and nothing cached)
- **Collections:** `{"items": [...]}`. Phase 1 lists are bounded (≤ 8 profiles,
  a handful of devices/sessions/tokens), so they aren't paginated yet. Catalog lists
  mirror TMDB paging: `?page=` (1–500) and `MediaPage` (`page`, `total_pages`,
  `total_results`).
- **IDs:** UUIDs. A malformed ID returns 404.
- **Timestamps:** RFC 3339 in UTC.
- **Request IDs:** an incoming `X-Request-ID` is accepted, otherwise one is
  generated. It's echoed in the response and included in logs and audit events.

## Endpoints (Phase 1)

| Area | Endpoints |
|---|---|
| auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/session`, `POST /auth/logout-all`, `GET /auth/sessions`, `DELETE /auth/sessions/{id}`, `POST /auth/password`, `GET/POST /auth/tokens`, `DELETE /auth/tokens/{id}` |
| profiles | `GET/POST /profiles`, `PATCH/DELETE /profiles/{id}`, `POST /profiles/{id}/verify-pin`, `GET/PUT/PATCH /profiles/{id}/preferences` (`ui_language`: en, ru, kk or "" = not chosen; PATCH changes only the fields sent) |
| devices | `GET /devices`, `GET /devices/me` (TV), `POST /devices/register` (token), `POST /devices/demo` (browser session: a «Демо TV» credential for `/demo_tv`, see architecture.md), `GET/PATCH/DELETE /devices/{id}`, `GET/PUT /devices/{id}/permissions`, `DELETE /devices/{id}/permissions/{userId}` |
| pairing | `POST /pairing`, `GET /pairing/lookup?code=`, `GET /pairing/{id}`, `POST /pairing/{id}/exchange`, `POST /pairing/{id}/approve`, `POST /pairing/{id}/deny` |
| admin | `GET/POST /admin/users`, `PATCH /admin/users/{id}`, `POST /admin/users/{id}/password`, `GET /admin/integrations` (prowlarr, torrserver, tmdb, kinopoisk — the latter with `budget_remaining`), `GET /admin/system[/history]` |
| ops | `GET /healthz` (liveness), `GET /readyz` (DB required; integrations reported but never fail readiness), `GET /metrics` (Prometheus text format; 404 unless `METRICS_TOKEN` is set, then `Authorization: Bearer <METRICS_TOKEN>` or 401; not proxied by Caddy — see [deployment](deployment.md#metrics--prometheus)), `GET /msx/start.json`, `GET /msx/menu.json`; `GET /status` (signed in: TorrServer/Prowlarr up + latency, `active_streams`, `server_time`, `seasonal_effects`, `cpu_percent` — latest 10 s CPU sample, % of all cores, null before the first sample or when older than a minute; shown in the TV player's stats panel); `GET /speedtest?bytes=N` (any signed-in reader incl. TVs: N incompressible random bytes, 1 B…25 MB, default 1 MB; `no-store`, never compressed or buffered; 30 per 10 min per user / TV → 429 `rate_limited`, a few at once; the background speed test of both apps, see [architecture](architecture.md#device-playback-profiles)) |

The Go handlers are written by hand against this contract. The integration
tests in `services/api/internal/server/*_test.go` check every status code the
frontends depend on.

## Remote commands (phone → TV)

Sent over the socket (`{id, type, target_device_id, payload}`) or
`POST /devices/{id}/commands {id?, type, payload}`; the TV answers with an
`ack {ok, error?, result?}` (`result` is usually its new `DeviceState`).
Payloads are validated by the server (`realtime/payloads.go`): a bad one is
`ack bad_payload` on the socket and **422** `validation_failed` on HTTP.

| Command | Payload | Notes |
|---|---|---|
| `media.open` | `{media_id, season_number?, episode_number?, force?}` | Details on the TV |
| `media.play` | `{media_id, episode_id?, source_id?, release_id?, quality?, position_seconds?, player?, force?}` | Start playback. Phones send ids only and the TV opens its loading screen at once: `release_id` (a release picked on the phone) → the TV creates the source itself; neither → the TV searches / ranks releases for itself. The TV reports progress in `PlaybackState.loading` (stage, progress, peers / seeders / speed) and failures in `DeviceState.player_error`. |
| `media.pause` / `media.resume` / `media.stop` | — | Films, live TV and «Видео» |
| `media.seek` | `{position_seconds}` | Films and «Видео» (not live TV) |
| `media.next_episode` | — | Series; «Видео»: the next related video |
| `media.select_source` | `{source_id}` | Another release, same position |
| `playback.set_audio` / `playback.set_subtitles` | `{track_id}` (`null` = subtitles off) | |
| `playback.set_volume` | `{volume?: 0..1, delta?: −1..1 (≠ 0), muted?: bool}`, at least one | The TV's level. `volume` wins over `delta`; a delta snaps to its grid (55 % + 0.1 → 60 %); changing the level without `muted` unmutes. Samsung Tizen with the `tv.audio` privilege: the TV's **system** volume (`tizen.tvaudiocontrol`), else Cineko's own player volume (0–100 % of the TV's level, saved per TV, applied to every new film / channel / video). Works with nothing playing (kept for the next playback). The state reports `volume`, `muted`, `volume_source` (`system` / `app`) and `system_volume` (`ok` / `absent` / `denied` / `error:<name>`) |
| `iptv.play` | `{channel_id, profile_id?, force?}` | Live TV channel |
| `video.play` | `{video_id, profile_id?, position_seconds?, quality?, force?}` | «Видео» (YouTube) |
| `device.show_message` | `{text}` (1–200) | A toast on the TV |
| `device.request_state` | — | The TV's `DeviceState` |

## Catalog (Phase 2)

| Endpoint | Notes |
|---|---|
| `GET /catalog/config` | Image base URL + sizes, TMDB attribution text, default region, `available` |
| `GET /catalog/home?lang=` | 7 rows in fixed order: `trending` (all, week), `popular_movies`, `popular_series`, `top_rated_movies`, `top_rated_series`, `upcoming_movies`, `on_the_air_series`; 20 items each |
| `GET /catalog/lists/{list}?kind=&page=&lang=` | `upcoming`/`now_playing` movie-only, `on_the_air`/`airing_today` series-only, `popular`/`top_rated` movie or series, `trending` also `all`. Wrong kind → 422; unknown list → 404 |
| `GET /catalog/discover?kind=…` | `genres` (comma = all must match), `year_from/to`, `runtime_min/max`, `original_language`, `rating_min`, `sort` (`popularity`, `rating`, `release_date`, `title`) |
| `GET /catalog/search?q=&kind=all` | Matches original, translated and alternative titles in any language; people are dropped (a page can hold < 20 items) |
| `GET /catalog/genres?kind=` | Genre names in `lang` |
| `GET /media/{id}?lang=` | Full details (cast ≤ 30, key crew, seasons, external ids, trailer) |
| `GET /media/{id}/similar`, `/recommendations` | `MediaPage`; empty when TMDB has none |
| `GET /media/{id}/seasons/{n}` | Series only; 404 for movies and unknown seasons. Episode ids are stable |
| `GET /media/{id}/quotes?lang=` | «Цитаты»: `MediaQuotes {items: [{text, speaker\|null}] (≤ 12), source: wikiquote\|null, source_url, lang}` from Wikiquote (page found via Wikidata by TMDB id; `lang`, else the other language). Empty when there is no page. Never AI |
| `GET /media/{id}/facts?lang=` | «Факты»: `MediaFacts {items: [{text, kind: fact\|blooper, spoiler}] (≤ 15), source: kinopoisk\|ai\|null, source_url, lang}`. Kinopoisk facts (keyed API, one budget unit, Russian) when the title has a Kinopoisk id and facts; else DeepSeek (`ai`, counts towards the AI token budget). 502 `trivia_failed` on an upstream failure |
| `GET /media/{id}/companion?profile_id&lang` | Watch companion availability: `MediaCompanion {ai_enabled, daily_limit, used_today, recap: {available, last_watched_at, through: {season, episode}\|null, cached}, after_credits: {available, scope: movie\|season\|series\|"", season}}`. Recap: a series with completed episodes, last touched ≥ 7 days ago. After the credits: a completed movie, or a series whose season finale is completed (`series` = the final season of an ended show). Both false while AI is off |
| `POST /media/{id}/recap` | «Ранее в сериале». `{profile_id, lang?}` → `SeriesRecap {lines (≤ 5), through, episodes, cached, generated_at}`, built by DeepSeek ONLY from the synopses of the episodes this profile completed (the furthest 12). Cached by the exact episodes used. 409 `not_eligible`, 422 `no_synopses`, 429 `companion_limit` (FORYOU_COMPANION_DAILY_PER_PROFILE, default 20 uncached answers + chat messages per profile per Moscow day) / `ai_budget`, 502 `ai_failed` (refunded), 503 `ai_disabled` |
| `POST /media/{id}/after-credits` | «После титров» (spoilers). `{profile_id, lang?, topic: ending\|significance}` → `AfterCredits {topic, known, paragraphs (≤ 4), scope, season, cached, generated_at}`; `known: false` = the model doesn't know the title well enough. Never past the finished season. Errors as for /recap |
| `GET\|POST /media/{id}/after-credits/chat` | The profile's spoiler chat about the finished title: `AfterCreditsChat {messages: [{role: user\|assistant, text}], followups, limit (6), remaining, scope, season, refused}`. POST `{profile_id, lang?, message (2–300)?, reset?}`; 409 `chat_full` after 6 messages; off-topic / injection → `refused` |
| `GET /media/{id}/providers?region=` | JustWatch data via TMDB; empty lists when none. Default region `CATALOG_REGION` |
| `GET /people/{tmdb_id}?lang=&profile_id=` | An actor's / director's page: bio, dates and `credits` (films + series from TMDB combined credits, most popular first, max 150; talk shows and playing oneself dropped). Each credit: `media`, `role` (characters / jobs), `crew`. Obscure entries (no poster, no votes) are dropped too. Web `/person/:id` (cast and director names on a title link here; Все / Фильмы / Сериалы, Популярные / Сначала новые); TV: OK on a cast card in Details opens the actor's grid, Back returns to the title |
| `GET /images/{size}/{file}` | Public image proxy (see below) |

- **Auth:** any principal that may read: browser session, TV device credential,
  or an API token with `read` (else `403 insufficient_scope`). Anonymous → 401.
  Images are public.
- **Validation:** `lang` ∈ `en`, `ru` (default `en`); `page` 1–500; invalid
  query values → `422 validation_failed` with `fields`. `total_pages` is
  capped at 500 (TMDB serves no further).
- **Not configured:** `/catalog/config` returns `available: false`; every
  other catalog/media endpoint returns `503 catalog_unavailable`.
- **IDs:** `id` is Cineko's UUID, the same for a title in every language,
  list and device. `tmdb_id` is informational (movie and tv ids collide).
- **Nulls:** `rating` is null under 3 votes; `year`/`release_date` are null when
  TMDB has no date; `poster_path`/`backdrop_path`/`profile_path`/`still_path`
  may be null; `trailer` is null when there is no YouTube trailer/teaser in the
  requested language or English.
- **Kinopoisk/IMDb ratings:** every `MediaSummary` (and `MediaDetail`) has
  `kp_rating` and `imdb_rating` (0–10, one decimal) — `null` until known.
  They are filled lazily: a list response returns what is stored and queues
  the rest (it appears on a later request); `GET /media/{id}` tries to
  resolve within ~1.5 s, so details usually have it on the first open, plus
  `external_ids.kinopoisk` (Kinopoisk film id or null). Ratings are global (no
  `profile_id` needed) and stay null when the server has no Kinopoisk key.
  The poster badge is chosen per profile by the setting `poster_rating`
  (`kp` default | `tmdb` | `imdb` | `off`; show TMDB `rating` when the chosen
  one is null). Details: [architecture.md → Ratings](architecture.md#ratings-kinopoiskimdb).
- **Awards:** `GET /media/{id}` has `awards` (never null): the title's awards
  and nominations from Wikidata grouped per award —
  `[{group, group_label, tier, wins: [{label, year}], nominations: [{label, year}]}]`,
  labels in `lang` (`group_label` «Оскар», `label` the category «лучший фильм»;
  in the `other` group the full award name; `year` null when unknown). Groups
  come sorted by `tier` (1 = Oscars and the main prizes of Cannes/Venice/Berlin,
  2 = other major awards, 3 = `other`), then wins, then nominations. Stored data
  only: a title never checked is looked up in the background and the list
  fills on a later request; everything is re-checked every 60 days. Summaries
  (lists, home, search, «Для вас», «Подборки»…) carry `award_badge`
  `{group: oscar|cannes|venice|berlin, count}` only when the title has tier-1
  wins (omitted otherwise) — the poster 🏆 chip. Details:
  [architecture.md → Awards](architecture.md#awards-and-nominations-wikidata).
- **Caching:** list/discover responses are cached 6 h, search 1 h, genres 7 d,
  similar/recommendations/providers 24 h. Details and seasons are stored in the
  database; after 7 days they are served as-is and refreshed in the background.
  If TMDB is down, expired cache entries are served for up to 7 more days.

### Images

Build URLs as `image_base_url + "/" + size + path` (`imageUrl()` in
`@martytv/media-types`). `image_base_url` is TMDB's CDN by default, or
`/api/v1/images` when `IMAGE_PROXY=true`. The proxy accepts only the sizes
`w92 w154 w185 w300 w342 w500 w780 w1280 h632 original` and file names matching
`^[A-Za-z0-9_-]+\.(jpg|png|svg)$` (anything else → 404). It requires an
`image/*` upstream response of at most 10 MB, caches files on disk
(`IMAGE_CACHE_DIR`) and answers with
`Cache-Control: public, max-age=2592000, immutable`. SVGs are served with a
sandboxing CSP.

## Releases (Phase 4)

`GET /media/{id}/releases?season=&episode=&profile_id=&refresh=&lang=` →
`ReleaseList {items, searched_at, cached, indexer_errors}`; design in
[architecture.md](architecture.md#releases-phase-4).

- **Auth:** any reader (session, TV credential, token with `read`). With
  `profile_id` the profile must be the caller's own (TVs: one usable on the
  device), else 404; its preferences rank the list. Without it, `lang`
  (`en`/`ru`, default `en`) + English are the preferred audio languages.
- **Params:** `season` 0–1000 (series only; unknown season → 422), `episode`
  ≥ 1 (requires `season`), `refresh` `true|false` (bypasses the 30-min cache;
  6 per 10 min per user/device, then 429). Invalid values → 422.
- **Items:** best first, at most 100; wrong titles/years/sequels/seasons/
  episodes and non-video results are excluded (confidence < 0.5). `id` is the
  info hash when known (RuTor), otherwise an opaque `p…` id; pass it to
  `POST /playback/sources` within 24 h. `reasons` explain the match
  (`title_exact`, `title_alt`, `year_match`, `year_in_range`, `collection`,
  `season_pack`, `episode_in_pack`, `episode_match`, `multi_season_pack`,
  `complete_series`, …); `warnings`: `low_seeders`, `cam_quality`,
  `over_size_limit`, `no_preferred_language`, `likely_unplayable_codec`,
  `disc_image`, `3d`. `is_season_pack` is true for any multi-episode release.
  `languages` are inferred from the title (Russian trackers' Cyrillic
  releases are assumed to carry Russian audio).
- **`indexer_errors`:** trackers Prowlarr recorded a failure for during this
  search or has temporarily disabled, plus `{indexer: "Prowlarr"}` when some
  (or, with a stale cache, all) queries failed.
- **Errors:** 404 unknown media/profile, 422 validation, 429 refresh limit,
  502 `releases_upstream_error` (Prowlarr down, nothing cached) or
  `catalog_upstream_error` (TMDB down for an uncached title), 503
  `releases_unavailable` (or `catalog_unavailable` without TMDB).
- **Latency:** a live search takes ~5–15 s (Prowlarr queries the trackers);
  cached responses are immediate. Show a spinner, not a timeout.
- **Sources:** the search covers the torrent sources the profile enabled
  (`ProfileSettings.sources`, default all; see [Sources](#sources)): Prowlarr
  and Jacred, merged and de-duplicated by info hash (the first source wins
  and keeps its chip; Jacred's parsed `voices[]` are merged into
  `voiceovers`). Every item carries `provider {id, name, kind}`. A failing
  source appears in `indexer_errors` as `{indexer: "<source name>", message:
  "search failed: …"}`; 502 only when every source failed. A profile with no
  torrent source gets `items: []` without a search. 503 means no torrent
  source is configured and enabled at all.

## Sources

Providers of things to play, one registry (design:
[architecture.md](architecture.md#sources)). Ids: `prowlarr`, `jacred`
(kind `torrent`) and `anilibria` (kind `anime`, UI group «Аниме»).

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/sources?profile_id=` | any reader (session, TV, token `read`) | `{items: SourceItem[], enabled: "all" \| string[]}`: `id, kind, name, needs_credentials, configured, enabled_by_admin, healthy (null = unknown), last_error?, checked_at?`, plus `enabled` (the profile's choice; always true without `profile_id` or with `"all"`) and `available` (= `enabled_by_admin && configured`) |
| GET | `/media/{id}/online?season=&episode=&profile_id=&refresh=&lang=` | any reader | `OnlineList {items, providers, searched_at, cached}` (below) |
| GET | `/admin/sources` | admin | `{items: AdminSource[]}`: Info + `base_url`, `has_credentials`, `updated_at` |
| GET | `/admin/sources/{id}` | admin | one `AdminSource` |
| PATCH | `/admin/sources/{id}` | admin | `{enabled?, base_url?, credentials?}` → `AdminSource`. `enabled:false` switches the source off for everyone. `base_url` "" = env default. `credentials` (string map, ≤ 10 keys) replaces the stored ones, `{}` clears; never returned. Audit `sources.updated` (flags only, no values) |
| POST | `/admin/sources/{id}/probe` | admin | runs the health check now → `AdminSource` |

- **Profile setting:** `PUT /profiles/{id}/settings {"sources": {"enabled":
  "all" | ["jacred", …]}}`. Default `"all"` = every available source,
  including ones added later. A list is replaced as a whole; ids must be
  registered sources (else 422, also for a wrong shape); ≤ 50 ids. An empty
  list switches every source off.
- **`/media/{id}/online`:** asks every enabled online/anime source in
  parallel (15 s timeout each). `items` are `OnlineVariant`s best first: `id`
  (`o…`, playable via `POST /playback/sources` for 24 h), `provider`, `voice`
  (the source's label) and `voiceover` (the `Voiceover` schema, language
  defaults to `ru`), `title`, `max_quality`, `qualities`, `format`
  (`mp4`|`hls`), `subtitle_langs`, `season`, `episode`, `episodes` (season-
  level variant: available episode numbers), `score`, and `preferred: true`
  on the first item (auto-pick: preferred voice-over studio, then audio
  language, then resolution, mp4 slightly over hls). `providers[]` is
  `{id, name, kind, status: ok|empty|error|timeout, count, error, cached}`:
  one source failing never fails the response. Per-source cache: 6 h (empty
  1 h, errors 10 min); `refresh=true` bypasses it (6 per 10 min, then 429).
  Series: `season` alone → one variant per voice with `episodes`;
  `season`+`episode` → that episode. Errors: 404 unknown media/profile, 422
  validation (`season` on a movie, `episode` without `season`), 502
  `catalog_upstream_error`.
- **Online sources (CDNVideoHub, Collaps):** provider ids `cdnvideohub` and
  `collaps` (`kind: online`, name «CDNVideoHub» / «Collaps»). Both need the
  title's Kinopoisk id (Collaps falls back to the IMDb id); without it they
  answer `empty`. CDNVideoHub: one item per voice-over (`format: mp4`,
  `qualities` e.g. `[2160,1440,1080,720,480,360,240,144]`). Collaps: one item
  per audio track of its multi-audio HLS (`format: hls`, `qualities: [720]`
  or lower, `subtitle_langs`), non-Russian tracks carry `voiceover.language`
  (`uk`, `en`); the server plays only that track. Admin `PATCH
  /admin/sources/collaps {base_url: "https://primary, https://mirror"}`
  switches hosts (comma/space separated, tried in order); empty = defaults.

## Playback (Phase 4)

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/playback/sources` | session, token `write`, TV | `{media_id, release_id, episode_id?, profile_id?, quality?}` → 201 `PlaybackSource` (`preparing` or `ready`; same source when repeated). An online variant id (`o…` from `/media/{id}/online`) creates a `kind: "online"` source that is `ready` at once; `quality` (e.g. 720, 0/absent = best) applies to online sources only |
| GET | `/playback/sources/{id}` | creator, creator's/shared TVs, creating TV; token `read` | status, live `torrent` stats, `media_info`, fresh `stream_url` |
| PATCH | `/playback/sources/{id}` | same | `{file_index}` → choose another video file (torrent); `{quality}` → switch quality (online, one of `qualities` or 0 = best) |
| DELETE | `/playback/sources/{id}` | same | 204. The viewer cancelled while loading: preparation stops; the torrent is removed from TorrServer only when this source added it (≤ 1 h ago), nothing streams it, no other source/download uses its hash and no session got past 30 s. Torrents that were already in TorrServer (e.g. Lampa's) are never removed |
| GET | `/playback/sources/{id}/files` | same | `{items: TorrentFile[]}` (empty until metadata arrived); 404 for online sources |
| GET/HEAD | `/stream/{token}` and `/stream/{token}/{filename}` | anyone with the token | torrent: video bytes with Range, `{filename}` is ignored. Online HLS: `/stream/{token}/index.m3u8` is the rewritten playlist (multi-audio masters reduced to the variant's voice); every URI in it is another `/stream/{token}/{signed ref}` (403 `invalid_stream_url` for anything not signed for this source) |

- **Online sources** (`kind: "online"`): `stream_url` ends in `/index.m3u8`
  (`mime_type: application/vnd.apple.mpegurl`, `format: "hls"`) or
  `/video.mp4`; `qualities` lists the offered heights and `quality` the
  current one (POST without `quality` = best ≤ the profile's preferred
  resolution); `provider` is a `ProviderRef`; `subtitles[].url` are proxied;
  `markers` (`[{kind: opening|ending, start_seconds, end_seconds}]`, only
  present when the provider knows them, e.g. AniLiberty) allow "skip intro";
  `file`, `torrent`, `media_info` are null; `duration_seconds` is the
  provider's film/episode length in seconds when known (CDNVideoHub, Collaps
  episodes; omitted otherwise). MP4 streams (`/video.mp4`) support Range and
  are re-signed transparently when the CDN URL expires. Torrent sources carry
  `kind: "torrent"`, `qualities: []`, `subtitles: []`. Sessions and progress
  (`POST /playback/sessions` with `source_id`) work the same.

- **Polling:** while `status` is `preparing`, poll GET every 1–2 s; it
  settles within ~60 s (`ready` or `error`). Keep polling a ready source every
  few seconds for live `torrent` stats while buffering.
- **Errors:** `404 release_not_found` (search again), `422 validation_failed`
  (`episode_id` required for series / wrong episode / inaccessible profile;
  `file_index` not a video), `409 source_not_ready` (PATCH before the file list
  is known), `502 torrserver_unavailable`, `502 release_unavailable` (download
  failed / rejected). Source `error` values: `no_metadata` (no peers),
  `no_matching_file` (pick one via `/files` + PATCH), `torrserver_unavailable`.
- **`torrent`:** `peers` (active), `seeders` (connected), `download_speed_bps`
  in **bytes** per second, `preloaded_bytes`; null when TorrServer is
  unreachable.
- **`stream_url`** is relative to the API origin (the device already reaches
  it; TorrServer is never exposed) and valid until `stream_expires_at` (12 h);
  every GET returns a fresh one. External players (MSX native player, VLC) may
  append `/<file name>` (e.g. `stream_url + "/" + basename(file.path)`) so the
  container can be guessed from the URL. Expired/invalid token → 403.
- **Compat streams** (torrent sources, `compat_url` when the server runs
  the transcoder; [architecture.md → Browser compatibility
  stream](architecture.md#browser-compatibility-stream-servicestranscoder)):
  `GET|HEAD /stream/{token}/compat.mp4?audio=&start=&ch=[&video=h264]`
  (fragmented MP4, no Range, `X-Stream-Start`; `video=h264` re-encodes old
  video codecs ≤ 1080p — only when the source has `compat_video: true`), `/stream/{token}/subs/{index}.vtt?start=`
  (WebVTT), and for Safari / iOS the HLS variant
  `GET|HEAD /stream/{token}/compat.m3u8?audio=&start=&ch=` → multivariant
  playlist (`X-Stream-Start`) → `/stream/{token}/compat/{session}/index.m3u8`
  (fMP4 EVENT playlist, `#EXT-X-START:TIME-OFFSET=0`, no-store),
  `…/init.mp4`, `…/seg{N}.m4s` (video/mp4, Range/HEAD). Errors: 403 bad /
  expired token, 422 bad `audio`/`start`/`ch`/`video` (`video_not_convertible`), 503 `transcoder_busy`, 502
  `transcoder_unavailable` / `stream_unavailable`, 404
  `compat_session_gone` (session ended: request compat.m3u8 again).
- **Stream responses:** `Accept-Ranges: bytes`, `Content-Length`,
  `Content-Range` on 206, `Content-Type` from the file (`video/mp4`,
  `video/x-matroska`, `video/webm`, `video/mp2t`, `video/x-msvideo`…),
  `Content-Disposition: inline; filename="…"`, `Cache-Control: no-store`.
  HEAD needs no TorrServer round trip. No transcoding: the client must be able
  to play the container/codecs (see `media_info`).

## Server downloads («Скачать на сервер»)

Rules: [architecture.md → Server downloads](architecture.md#server-downloads).

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/downloads` | session, token `write`, TV (as its owner) | `{source_id, season?}` → 201 `{items: Download[]}`. The source must be a ready **torrent** source the caller can use (same rules as GET `/playback/sources/{id}`). Shared per (info hash, file index): an existing download is reused (a `failed` one restarts) and the caller is added to its requesters. `season: true` also queues every other episode file of that season in the torrent (season packs; not samples/extras) |
| GET | `/downloads` | same, token `read` | the caller's downloads, newest first; `?status=`, `?media_id=`, `?lang=en\|ru` (media cards); `?all=true` admins only (403 otherwise) → every download with `users[]` |
| GET | `/downloads/{id}` | requesters, admins | 404 for everyone else (even if their own source plays the same file) |
| PATCH | `/downloads/{id}` | requesters, admins | `{pinned?, paused?}`. Pinned («Хранить дольше») = never evicted; `paused: false` also restarts a `failed` one |
| DELETE | `/downloads/{id}` | requesters, admins | 204. A requester removes their request; the file is deleted when nobody else asked for it. An admin deletes the download and file outright |
| GET / PATCH | `/admin/storage` | admin | `StorageStatus`: disk total/free (statfs of `LIBRARY_DIR`), library used, reserve, available, `settings {reserve_gb, max_library_gb\|null, keep_days}`, `counts` by status, `max_jobs`. PATCH any of the settings (`reserve_gb` 1…10000, `max_library_gb` 1…100000 or null = disk-limited, `keep_days` 1…3650; 422 otherwise). Audited `storage.updated` |
| GET | `/admin/torrserver/torrents` | admin | every torrent in the household TorrServer (shared with Lampa): `hash, title, size_bytes, stat, stat_string, idle (stat ≥ 4), added_at, peers, download_speed_bps, martytv {sources, streaming, download {id,status}\|null, in_use}` |
| DELETE | `/admin/torrserver/torrents/{hash}` | admin | `POST /torrents {"action":"rem"}` on TorrServer (also gone from Lampa; Cineko re-adds on next play). `409 torrent_in_use` while Cineko streams it or a download is queued/running/waiting on it, unless `?force=true`; 404 when TorrServer doesn't list it. Audited `torrserver.removed` |

- **`Download`:** `status` `queued | downloading | paused | done | failed |
  waiting_space`; `error` (`failed`: `size_mismatch`, `upstream_error`,
  `write_error`; `waiting_space`: `insufficient_space` with
  `space_needed_bytes`); `progress` 0…1, `bytes_done`, `size`, `rate_bps` and
  `eta_seconds` while downloading; `keep_until` (kept at least until then:
  max(completed, last watched) + `keep_days`; null while incomplete or
  pinned); `mine`; `info_hash`, `file_index`, `file_name`, `release_title`,
  `media_id`, `episode_id`, `season`, `episode`, `media` (`MediaSummary`).
- **`PlaybackSource.download`** (`DownloadBrief | null`): `{id, status,
  progress, bytes_done, size, rate_bps, eta_seconds, completed_at,
  keep_until, pinned, mine}` for the source's file. When `done`, the same
  `stream_url` / `compat_url` serve the server's copy (Range, If-Range, HEAD;
  `ETag`/`Last-Modified` from the download), `torrent` stats are null, and
  creating a source for an already-downloaded file returns `ready` at once.
- **Realtime:** `download.updated` (payload: `Download` with `media: null`;
  status changes at once, progress at most every ~2 s) and `download.removed`
  (`{id}`) go to the requesters' browser sockets.
- **Errors:** `404` (unknown/foreign source or download), `409
  source_not_ready`, `422 not_a_torrent` (online source) /
  `validation_failed`, `503 library_unavailable` (the library dir isn't
  writable).

## Watch sync, lists, settings (Phase 5)

Rules and rationale: [architecture.md → Watch sync](architecture.md#watch-sync-phase-5).
"Profile check" = the profile must be usable by the caller (own profile, or
selectable on the calling TV); otherwise **404**. API tokens need `read` for
GET and `write` otherwise.

| Method | Path | Notes |
|---|---|---|
| GET/PUT | `/profiles/{id}/settings` | `ProfileSettings`; GET fills defaults, PUT merges the given keys (TVs allowed). Layers: a TV reads/writes its own layer of the per-device keys, a browser its `?device_class=desktop|mobile` layer; other keys and callers without a class use the profile base (architecture «Device settings»); bad enum → 422. Includes `poster_rating` (`kp`\|`tmdb`\|`imdb`\|`off`, default `kp`), `taste_note` («О моих вкусах», string ≤ 600 chars, trimmed, default `""`; a change regenerates the profile's AI collections in the background, ≤ 1 per 30 min) and `min_votes` (0\|50\|100\|300\|1000\|5000, default 100: vote floor of Explore tiles, Surprise Me's discover fallback and «Для вас» candidates; a change rebuilds the rows). `design` also takes `retro80` / `retro90` / `popart` / `constructivism`. `hidden_tabs` («Вкладки меню»): tab ids the profile hides — `tv, video, explore, new, history, ask, search, movies, series, surprise, mine, messages` (default `[]`; Home and Settings can't be hidden; unknown id → 422); the web header and phone bar honour it. `loading_style`: `popcorn` (default), `fill_title`, `poster_reveal`, `film_reel`, `minimal`, `marty` («Cineko»: Cineko's loading loop + progress bar, he cheers at 100 %), `marty_popcorn` («Cineko с попкорном»), `matrix`, `paws`, `aquarium`, `speed88`, `odyssey`, `balloons`, `catch` («Лови!», a waiting game), `water_glass`, `poster_dig`, `chocolate_box`, `coffee_cup`, `honey_pot`, `hyperjump`, `ghost_meter`, `target_scan`, `docking`, `claw_machine` (TV only; the PWA player shows «Заполняющееся название» for them). «Тема под фильм»: `film_theme` (default false; Details and the TV loader take a look matching the film, classified on the client by `filmTheme()` in @martytv/media-types), `surprise` (a different one per load) and `match` («Под фильм»: chosen from the title's genres / text). «Уютный режим»: `cozy_mode` (default false: warm dimmed palette), `cozy_ambience` (`rain`\|`fireplace`\|`off`, default `fireplace`; Home only), `cozy_sound` (default false; synthesized in the client). `design_surprise` («Сюрприз»: `off`\|`day`\|`week`, default `off`; the clients show a design from `design_favorites` per local day / ISO week) and `design_favorites` (design ids, default `[]` = all; deduped; unknown id → 422). `poster_wobble` («Живые постеры», default true: web posters tilt toward the mouse, the focused TV card hops). «Семья советует»: `share_with_family` (default false, opt-in) and `show_family` (default true); «Подборки» on Home: `show_curated` (default true); non-boolean → 400 |
| GET/PATCH | `/devices/{id}/settings` | `TvSettings {device_id, device: TvDeviceSettings, updated_at, profiles: [{id, name, avatar, color, own}], active_profile_id, profile_id, effective, overrides, layered_keys}` (`?profile_id`, default: the profile on screen, else the default one). PATCH `{device?, reset_device?, profile_id?, profile? (layered keys only), reset?}`. `me` = the calling TV. Access: the TV, owner, `use` share (own profiles), super_admin; else 404. A change from anyone but the TV sends it realtime `settings.changed {profile_id?}` |
| GET/PUT | `/profiles/{id}/preferences` | now also `preferred_voiceovers: string[]` (≤ 10, 1–40 chars, most preferred first; boosts matching releases) |
| POST | `/playback/sessions` | `{profile_id, media_id, episode_id?, source_id?}` → 201 `{id, resume_position_seconds, progress, report_token}`; series need `episode_id` (422), movies refuse one |
| POST | `/playback/sessions/{id}/progress` | `{seq, position_seconds, duration_seconds?, state}` → `{accepted, reason?, progress}`; `reason` ∈ `stale_sequence`, `stale_session`, `too_early`. JSON or `text/plain` body. Creator only (404), or `?token=<report_token>` (no cookie/CSRF needed; bad/expired → 401) |
| GET | `/media/{id}/progress?profile_id=` | `MediaProgress` (movie row, episode rows, season counts, `next_up`) |
| PUT | `/media/{id}/watched` | `{profile_id, watched, episode_id? \| season_number?}` → `MediaProgress`; series need exactly one of them; `watched:false` deletes |
| GET | `/profiles/{id}/continue-watching?lang=` | `{items: ContinueItem[]}`, newest first, max 30 |
| GET | `/profiles/{id}/new-episodes?lang` | «Новые серии» from the nightly check: episodes of the profile's series (watched in the last year, watchlist/favorites, or ongoing Kinopoisk imports — only episodes aired after the import) that aired after what was watched. Unseen first, then seen ones from the last 30 days (max 100). Watching it or a later episode marks it seen |
| POST | `/profiles/{id}/new-episodes/seen` | `{episode_ids?: uuid[] (≤ 200), all?: bool}` → 204: marks seen / hides |
| GET | `/profiles/{id}/tickets?lang&cursor&limit` | Ticket stubs (one per finished film, newest number first; `limit` 1–100, default 24; `next_cursor`): number, media, finished_at + household `date`/`time`, hall/row/seat (stable hash), the profile's `rating`. Owner, its TVs, admins |
| GET | `/profiles/{id}/achievements?lang` | Unlocked stickers (oldest first, with the title that earned each), `progress` (the next locked goal of each started counter ladder: `{id, have, need}`) and `secret` (the rest, still hidden). Recorded on read, silently |
| GET | `/admin/new-episodes` | Admin: schedule (`NEW_EPISODES_AT` in `NEW_EPISODES_TZ`, default 04:00 UTC) and the last 10 runs |
| POST | `/admin/new-episodes/run` | Admin: run the check now → 202; 409 while one runs |
| GET | `/profiles/{id}/history?lang&cursor&limit` | `{items: HistoryItem[], next_cursor}`, newest first; bad cursor → 422 |
| GET | `/profiles/{id}/lists/{watchlist\|favorites}?page&lang` | `MediaPage`, newest first, 20 per page |
| PUT/DELETE | `/profiles/{id}/lists/{list}/{mediaId}` | 204, idempotent; unknown media → 404 |
| PUT/DELETE | `/profiles/{id}/ratings/{mediaId}` | `{rating: 1..10}` (integer, else 422) → 204; DELETE idempotent |
| GET | `/messages` | caller's inbox (max 100) + `unread`; a TV sees its owner's `show_on_tv` messages |
| POST | `/messages/{id}/read` | 204 (idempotent); only a recipient (a TV: its owner's `show_on_tv` messages) |

**Player integration.**
- Call POST `/playback/sessions` when playback actually starts, seek to
  `resume_position_seconds` when not null.
- Report every ~15 s while playing and on pause, seek, end (`ended`), stop
  and page hide (`stopped`). `seq` starts at 0 and increases per session.
- On page hide use `navigator.sendBeacon(url + "?token=" + report_token,
  JSON.stringify(body))` (sent as `text/plain`) or `fetch(…, {keepalive:true})`.
- Progress (`WatchProgress`) carries `source_id` — the source of the last
  session — so «Продолжить» restarts the same release. A failing source that
  reports 0 s (with no session position past `MinWatchSeconds`) gets
  `too_early` and does not wipe the resume position.
- `accepted:false` is not an error: `stale_session` means another device took
  over — stop reporting (and maybe tell the user); `too_early` is normal for
  the first 30 s.

**Catalog personalization.** `/catalog/home`, `/catalog/lists/{list}`,
`/catalog/discover`, `/catalog/search`, `/media/{id}`, `/media/{id}/similar`
and `/media/{id}/recommendations` accept `profile_id` (profile check; bad
UUID → 422). Every `MediaSummary` then has `me` (`progress_percent`,
`completed`, `in_watchlist`, `favorite`, `rating`); without `profile_id` the
key is omitted. `hide_anime` applies everywhere except details;
`hide_watched=true|false` (lists, discover, similar, recommendations; home
uses the setting; search never hides watched) defaults to the profile
setting. **Pages may have fewer than 20 items**; paging numbers stay TMDB's.

## Roles and super-admin views

Roles: `user` < `admin` < `super_admin` ([architecture](architecture.md#roles)).
`/admin/*` needs admin or super_admin; the endpoints below need super_admin
(403 `super_admin_required` otherwise, also for an admin-scoped API token of
a plain admin). User management rules (`POST/PATCH /admin/users`,
`POST /admin/users/{id}/password`): a plain admin creates, renames,
disables/enables and resets passwords of **regular users only**; granting or
revoking admin/super_admin and touching any admin or super_admin needs a
super_admin (403 `super_admin_required`). Your own role or disabling yourself
→ 409 `self_lockout`; removing the last active administrator → 409
`last_admin`, the last active super_admin → 409 `last_super_admin`. Role
changes are audited `admin.user_role_changed {from, to}`.

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/devices` | `{items: AdminDevice[]}`: every paired TV with owner (username, display name), name, platform, model, `app_version` (latest client report, else null), default profile, shares, `last_seen_at`, `online`, `credential_active`. Metadata only, never credentials |
| PATCH | `/admin/devices/{id}` | `{name}` (1–64) → 204. Audited `admin.device_renamed` |
| POST | `/admin/devices/{id}/revoke-credential` | Revokes the TV's credentials and closes its socket now; the device stays listed with `credential_active: false` (the TV pairs again) → 204. Audited `admin.device_credential_revoked` |
| DELETE | `/admin/devices/{id}` | Unpairs (as the owner's «Отвязать») → 204. Audited `admin.device_deleted` |
| GET | `/admin/pairing` | `{items: AdminPairingRequest[]}`: pending, approved-not-exchanged, and expired/rejected in the last hour, newest first; user code, device name, platform, User-Agent, requesting IP, created/expires, status, `approved_by_username`. Never the poll secret |
| POST | `/admin/pairing/{id}/reject` | Rejects a pending or cancels an approved, not yet exchanged request (TV sees `denied`) → 204; ended → 410 `pairing_unavailable`. Audited `admin.pairing_rejected` |
| GET | `/admin/pairing/assignees` | Enabled users with their profiles (for the approve sheet) |
| POST | `/admin/pairing/{id}/approve` | `{user_id, device_name?, default_profile_id?}` → 204: accepts the TV **for `user_id`** through the same path as owner approval; the exchange creates a device owned by that user. Profile must be theirs (else 422); none given → their first profile (created if none). Disabled/unknown user → 422; expired/handled → 410. Audited `pairing.admin_approved`; the user's sockets get `device.changed` |

Realtime: super_admin browser sockets get `{"type":"admin.devices.updated","payload":{"reason"}}`
on device online/offline/changed and pairing created/approved/denied/rejected/expired,
throttled to one per second (first at once, one trailing). No data: the page refetches.

## Admin activity & messages (Phase 5)

Admin only (403 otherwise). Users are informed in their settings that admins
can see what they watch.

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/activity/now?lang=` | `{items: ActivityItem[]}`: open sessions reported in the last 3 min + live TV player states (TV state wins for its device; `player` = `builtin` for TV states, null otherwise), newest first |
| GET | `/admin/users/{id}/history?lang&cursor&limit` | `{items: AdminHistoryItem[], next_cursor}` across all of the user's profiles; unknown user → 404 |
| GET | `/admin/messages` | `{items: SentMessage[]}` with `recipients`/`read_count` |
| POST | `/admin/messages` | `{title (1–80), body (1–1000), user_ids?, show_on_tv = true}` → 201 `SentMessage`. Empty `user_ids` = every enabled user but the sender; unknown/disabled ids → 422. 20/hour per admin (429). Audited |
| GET | `/admin/system` | `SystemStatus`: host CPU/RAM/swap/load/disks/network, top processes, containers (from martytv-hostmon; `scope: container` + `hostmon: unavailable` without it) and `app` (streams, WebSockets, DB size, image cache, TorrServer). See [architecture](architecture.md#admin-system-monitor) |
| GET | `/admin/system/history?minutes=60` | `SystemHistory`: 10 s samples (≤ 1 h, oldest first) of CPU %, RAM used, load1, rx/tx bytes/s, active streams |

Delivery: realtime event `{"type":"message","payload":Message}` to each
recipient's browser sockets and, with `show_on_tv`, to the TVs they own.

## Recommendations between people («Посоветовать»)

`Recommendation {id, media: MediaSummary, from: PersonRef, to: PersonRef, note,
created_at, seen_at, reaction: like|dislike|watched|null, reply}`;
`PersonRef {user_id, name, color, avatar}` (`from.name` is the sender's
profile name when `from_profile_id` was given). Recipients come from
`GET /users/directory`. See [architecture](architecture.md#recommendations-between-people-посоветовать).

| Method | Path | Notes |
|---|---|---|
| POST | `/recommendations?lang=` | `{media_id, to_user_ids (1–20), note? (≤ 500), from_profile_id?}` → 201 `{items}` (one per recipient). Recipients must be enabled users other than the caller (422, same message for unknown/disabled/self); `from_profile_id` must be the caller's (422); unknown media → 404. Same title to the same person within 7 days updates the note. 60/hour per user (429). Audited `reco.sent`. User only (TV → 403) |
| GET | `/recommendations/inbox?lang&profile_id` | `{items, unseen}`, newest first (max 100), without dismissed ones. `profile_id` (caller's own) adds `media.me`. A TV credential reads its owner's inbox |
| GET | `/recommendations/sent?lang=` | `{items}` sent by the caller with reactions/replies (also ones the recipient dismissed), last reacted/created first (max 200). User only |
| PATCH | `/recommendations/{id}?lang=` | Recipient only (others → 404): `{seen?: bool, reaction?: like\|dislike\|watched\|null, reply?: string\|null (≤ 300)}` → `Recommendation`. A reaction or reply implies seen and notifies the sender |
| DELETE | `/recommendations/{id}` | 204: recipient dismisses (hidden from the inbox, still in the sender's `/sent`) or sender withdraws (deleted); anyone else → 404 |

Realtime: `{"type":"recommendation","payload":Recommendation}` to the
recipient's browser sockets and the TVs they own (on create and on a de-duped
re-send); `{"type":"recommendation.reaction","payload":Recommendation}` to the
sender's browser sockets when the recipient reacts or replies.

## Family sharing («Семья советует»)

Opt-in per profile: settings `share_with_family` (default `false`) exposes the
profile's ratings, finished titles and favorites to the other profiles on the
server (never progress, watchlist or notes); `show_family` (default `true`)
shows the family to this profile. See
[architecture](architecture.md#family-sharing-семья-советует).

| Method | Path | Notes |
|---|---|---|
| GET | `/profiles/{id}/family?lang&limit` | `FamilyBlock {profile_id, enabled (show_family), sharing (share_with_family), members: [{profile_id, name, avatar, color, user_name, match (0–100 \| null), co_rated}], items: [{media: MediaSummary (with me), why: {people: FamilyEndorsement[], liked_by, text}, score}]}`; `FamilyEndorsement {profile_id, name, avatar, color, user_name, rating, completed, completed_at, favorite, liked}`. Titles the viewer rated/started/finished/dismissed (and anime with hide_anime) are excluded; ranked by taste similarity. `limit` ≤ 50 (default 20). The profile's account and its TVs; others 404 |
| GET | `/profiles/{id}/family/media/{mediaId}` | `MediaFamily {enabled, people: FamilyEndorsement[]}` («Оценки семьи»; likers first). Empty when nobody shares it or `show_family` is off |

`GET /foryou/rows` also includes this block as the row `kind: family`
(`id: family`, second row) when it has items: items have `reason.type:
family` and `reason.family` (`FamilyWhy`), the row has `family.members`.
Dismissing from it is the usual feedback with `row_id: "family"`.

## Curated lists («Подборки»)

Hand-made film lists from books, directors' lists, polls and the Soviet
canon ([architecture](architecture.md#curated-lists-подборки)). `profile_id`
is optional (a profile the caller may use, else 404); with it, `watched`
counts finished or rated titles and items carry `me`.

| Method | Path | Notes |
|---|---|---|
| GET | `/curated?profile_id&lang` | `{groups: [{id: thinkers\|directors\|polls\|ru, title, lists: CuratedListSummary[]}]}`; `CuratedListSummary {id, group, title, description, author, source, source_url, ordered, count, resolved, watched, covers (≤ 4 poster paths)}` |
| GET | `/curated/{list_id}?profile_id&lang` | `CuratedList` = summary + `items: [{position, rank (ordered lists), title, original_title, year, kind, note, watched, media: MediaSummary \| null}]` in list order; `media: null` = not in the catalog. Unknown id → 404 |

`GET /foryou/rows` includes one list a day as the row `kind: curated` (id
`curated:<list_id>`, third row, `curated: {list_id, title, author, count,
watched}`; items `reason.type: curated`, text = the film's note or the list
title) unless the profile set `show_curated: false`. `GET /foryou/explore`
has a section `kind: curated` with tiles `curated:<list_id>` (`curated_id`,
`progress` «12 / 48»), browsable with `/foryou/browse?tile=curated:<id>`.

## Personal recommendations («Для вас», Phase 6)

Not the same as `/recommendations` above: these are computed for a profile
from its own ratings and viewing. Every `profile_id` must be usable by the
caller (else 404); paired TVs may call everything except diary/taste. Item
`reason`s are typed and localized (`ForYouReason {type, text, media_id,
media_title, person_tmdb_id, person_name, genre_ids, genre_names,
collection_id, collection_title, mood}`); see
[architecture](architecture.md#recommendations-phase-6).

| Method | Path | Notes |
|---|---|---|
| GET | `/foryou/rows?profile_id&lang` | `ForYouRows {profile_id, generated_at, stale, cold_start, rows: [{id, kind, title, reason, items: [{media: MediaSummary (with me), reason, score}]}]}`. Kinds: `top_picks`, `because_you_rated` (×≤ 3), `director` (×≤ 2), `actor`, `hidden_gems`, `something_different`, `genre`, `trending`, `ai_collection` (×≤ 2 AI collections + ≤ 2 AI theme rubrics), `theme` («Вам нравятся фильмы про …», TMDB discover by the most liked keyword), `rewatch`, `popular` (cold start). Reason type `theme` carries `keyword_id`, `keyword_name`, `keyword_localized`; any item may carry `ai_text` (the daily AI re-ranking's one-line personal reason, in the profile's language — clients show it instead of the typed reason). A title appears in at most one row; titles rated/completed/dismissed since the cache was built are filtered out at read time; rows with < 4 items are dropped. `stale: true` → a rebuild runs and `foryou.updated` follows |
| POST | `/foryou/feedback` | `{profile_id, media_id, action, row_id?}` or `{profile_id, events: [{media_id, action, row_id?}] (≤ 100)}` → 202 `{accepted}`. Actions `impression` (batch them), `open`, `play`, `complete`, `dismiss` («Не интересно»: hidden everywhere at once + negative signal), `undismiss`. 120 calls/min per profile |
| GET | `/profiles/{id}/channel?count&exclude&lang` | «Cineko TV»: `{items: [ChannelItem {media, episode \| null, runtime_minutes, runtime_known, resume_seconds, source: foryou\|continue, reason \| null}], pool_size}` built on request — films from the profile's pool (nothing rated/started/finished/dismissed, hidden anime, known-unplayable), next episodes of series in progress, alternating genres. `count` 1–20 (default 8), `exclude` comma-separated media ids (≤ 200) |
| GET | `/foryou/surprise/options?lang` | `{moods: [{key, title, emoji, genre_ids}], decades}` |
| POST | `/foryou/surprise?lang` | `SurpriseRequest {profile_id, mood?, genres?, runtime_min?, runtime_max?, decade?, min_rating?, include_watched?, kind?: movie\|series\|any, exclude_ids?}` → `{media \| null, reason \| null, source: pool\|discover\|none, pool_size, reroll: {exclude_ids}}`. Weighted-random from the scored pool; TMDB discover fallback. Moods: `cozy, tense, funny, thoughtful, scary, romantic, family` |
| GET | `/foryou/explore?profile_id&lang` | `{sections: [{id, kind: moods\|decades\|countries\|genres\|keywords\|collections, title, tiles: [{id, kind, title, subtitle, emoji, image_path, collection_id, discover}]}]}`; taste-ordered. Tiles whose selection is known to be empty (at the profile's `min_votes`) are left out, and so are sections left empty; collection tiles always stay |
| GET | `/foryou/browse?tile&kind&page&profile_id&lang` | `MediaPage + {tile, title}` for a tile id (`mood:cozy`, `decade:1980`, `lang:ko`, `genre:18`, `kw:4379`, `collection:<uuid>`); hide_anime/hide_watched/dismissals applied. 422 unknown tile; 503 without TMDB |
| GET | `/foryou/collections?profile_id&lang` | `{items: ForYouCollection[], ai_enabled}`: the profile's latest AI batch (3–5) + the latest global one (2–3). `ForYouCollection {id, scope: profile\|global, title, description, generated_at, model, items: MediaSummary[]}` |
| GET | `/foryou/collections/{id}?profile_id&lang` | One collection (global or that profile's; else 404) |
| POST | `/foryou/ask?lang` | «Спросить ИИ». `{profile_id, prompt (3–500), lang?, kind?: movie\|series\|any, include_watched?, device_id?, creativity?: precise\|normal\|bold}` → `ForYouAsk {id, profile_id, prompt, kind, include_watched, answer (plain text), items: [{media: MediaSummary (with me), why}] (≤ 8, model order), followups (2–3), refused, tokens, created_at, sent_to_device?}`. Off-topic/injection → `refused: true, items: []`. 429 `ask_limit` (FORYOU_ASK_DAILY_PER_USER, default 30 per account per Moscow day; TVs billed to the owner) or `ai_budget` (daily token cap), with Retry-After; 503 `ai_disabled` without a key; 502 `ai_failed` (not counted). `device_id` (an owned TV; not from TVs) also delivers the answer as realtime `foryou.ask`. Opening a result: feedback `open` with `row_id: "ask"` |
| GET | `/foryou/ai-settings` | `{enabled, temperature: {collections, ask, music}, creativity: {precise: -0.4, normal: 0, bold: 0.4}, min: 0, max: 1.5}` — the admin's DeepSeek temperatures; `creativity` is added to them and clamped (Cineko Music reads its default here) |
| GET | `/foryou/asks?profile_id&lang` | `{items: ForYouAsk[] (last 20, newest first), ai_enabled, daily_limit}` |
| GET | `/foryou/regenerate?profile_id` | `ForYouRegenStatus {available, used_today, daily_limit (1), unlimited (admins), next_available_at (now, or the next Moscow midnight once used), running, run_id, ai_enabled}` |
| POST | `/foryou/regenerate` | «Обновить подборки ИИ». `{profile_id}` → 202 `ForYouRegenStatus` (`running: true, run_id`). Regenerates the profile's AI collections and rows in the background (a run with trigger `user`); `foryou.updated` (reason `collections`) when done. One per profile per Moscow day on top of the daily run (admins unlimited): 429 `regen_limit` with `error.fields.next_available_at` + Retry-After; 429 `ai_budget` (not counted); 503 `ai_disabled`. One already running → returned, not counted. A model failure gives it back. TVs allowed |
| GET | `/profiles/{id}/notes?cursor&lang` | «Мои заметки». `{items: [{media: MediaSummary (with me), text, reasons, updated_at}] (30, newest first), next_cursor}`. The profile's account and its TVs; others 404 |
| PUT | `/profiles/{id}/notes/{mediaId}` | `{text (≤ 1000, trimmed), reasons: NoteReason[] (≤ 15)}` → 200 `{media_id, text, reasons, updated_at}`; empty text and no reasons → 204 (deleted). Unknown reason/too long 422, unknown title 404. Every `MediaSummary.me` carries `note: {text, reasons} \| null` |
| GET | `/profiles/{id}/diary?month=YYYY-MM&lang` | Owner only (other users 404, TVs 403). `{month, days: [{date, entries: [{media, watched, episodes, rating, rewatch, at}]}], stats: {movies_watched, episodes_watched, series_watched, hours_watched, ratings_count, average_rating, rewatches, favorite_genres, favorite_decades, top_directors, top_rated}}`; Moscow dates |
| GET | `/profiles/{id}/taste?lang` | Owner only. `TasteDNA {signals, rating_histogram[10], kinds, genres/decades/languages/countries: [{key, name, score −1…1, count}], directors/actors/writers/cinematographers/composers: [{tmdb_id, name, profile_path, score, count}], themes: [{id, name, name_en, localized, score, count}] (TMDB keywords), credits_coverage, adjustments: [{reason: too_scary\|childish\|too_long, titles, strength, penalty, genre_ids, genre_names, runtime_max}]}` (adjustments: from note reasons) |
| GET | `/profiles/{id}/taste-quiz?lang` | «Давайте определим ваш вкус». `TasteQuizState`: questions (option ids; clients hold the labels), answers so far, counts of rated/answered titles, `completed` / `dismissed`. The profile's account and its TVs |
| GET | `/profiles/{id}/taste-quiz/titles?limit&lang` | Next well-known titles to ask about (≤ 30; hits and classics of every decade, Soviet/Russian, series, Korea, anime, Europe…) minus anything rated, watched, dismissed, listed or answered → `{items: MediaSummary[]}` |
| POST | `/profiles/{id}/taste-quiz/answers` | `{answers?, titles?: [{media_id, answer: rated\|want\|not_interested\|unseen, rating?}] (≤ 50)}` → state. `rated` sets the rating, `want` adds to the watchlist, `not_interested` dismisses; `unseen` is only remembered |
| POST | `/profiles/{id}/taste-quiz/finish` | Marks it completed, recomputes the taste and rows now (AI collections in the background when AI is on) → `{state, ai_regeneration}` |
| POST | `/profiles/{id}/taste-quiz/generate?lang` | «✨ Заполнить по моим фильмам». Derives the questionnaire answers from the profile's history (ratings ≥ 7 like / ≤ 4 dislike, finished, favourites, rewatches, watchlist, abandoned, «Не интересно», notes; recency-weighted) — deterministic, no AI; dislikes need negative evidence on 2+ titles. Overwrites `genres_like`, `genres_dislike`, `eras`, `origins`, `mood`, `format`, `intensity` (a question without evidence is cleared); `audio` and `company` are kept. Refreshes taste + rows like `finish` (without marking the quiz completed) → `{state, basis: {titles, rated, completed, favorites, liked, disliked}, ai_regeneration}`. Callable again any time. Fewer than 3 rated / finished / favourite titles → 409 `not_enough_history`. The profile's account and its TVs |
| POST | `/profiles/{id}/taste-quiz/dismiss` | Hides the Home invitation; the quiz stays in Settings → state |
| POST | `/admin/foryou/rerun` | Admin. `{scope: all\|user\|profile, id?, ai?: true}` → 202 `{run_id}`; 409 `{error: {code: run_in_progress}, run_id}` while a run is active; unknown user/profile 404. Audited `foryou.rerun` |
| GET | `/admin/foryou/runs` | Admin. `{items: ForYouRun[] (last 30), ai: {enabled, model, tokens_today, daily_budget, run_budget, balance, temperature}, daily_at, next_run_at}`; `balance` = DeepSeek's `GET /user/balance` as `{available, currency, total, granted, topped_up, checked_at}` (USD preferred; cached 10 min, refreshed after every run) or `null` without a key / when the call failed. `ForYouRun {id, scope, target_id, ai, trigger: schedule\|admin\|startup\|taste_note\|user, status: running\|completed\|failed, requested_by, profiles_total, profiles_done, ai_calls, ai_tokens, collections_created, errors: [{profile_id, step, message}], started_at, finished_at, duration_ms}` |
| PUT | `/admin/foryou/ai` | Admin. `{temperature?: {collections?, ask?, music?, facts?, companion?}, facts_ai?, themes_ai?, picks_ai?, companion_ai?, learn_weights?}` (each 0–1.5; omitted keep their value; `facts_ai: false` = «Факты» from Kinopoisk only; `themes_ai` / `picks_ai: false` = no AI theme rubrics / no AI re-ranking in the daily run; `companion_ai: false` = no «Ранее в сериале» / «После титров») → `ForYouAISettings`. 422 out of range or empty. Audited as `foryou.ai_updated` |
| GET | `/admin/foryou/weights` | Admin. Learned source weights: `{enabled, sources: [learn key], items: [{profile_id, name, owner, updated_at, items: [{source, weight, prev_weight, target, impressions, opens, plays, completes, dismisses}]}]}` (counts share-weighted over 60 days; docs/architecture.md "Learned source weights"). `learn_weights: false` in `PUT /admin/foryou/ai` stops learning and using them |
| DELETE | `/admin/foryou/weights/{id}` | Admin. Forgets a profile's learned weights → 204 (404 none); rows rebuild. Audited `foryou.weights_reset` |
| GET | `/admin/foryou/quality` | Admin. `?window=30\|90\|all` (default 90), `lang` → `ForYouQuality {window, generated_at, household, profiles: [{profile_id, name, owner, stats}]}`; stats = funnel (shown/played ≥ 10 min/finished/rated/liked ≥ 7/disliked ≤ 4), `recommended` / `elsewhere` rating summaries `{n, avg, liked, disliked}`, `calibration` (score tertiles), per-source `sources`, `precision_shown/liked` (first 10 of «Подобрано»), `hits` / `misses` (≤ 5, with posters). Cached 5 min |

Realtime: `{"type":"foryou.updated","payload":{"profile_ids":[…],"reason":"run|signals|collections|settings"}}`
to the owning users' browser sockets when rows or collections changed.
`{"type":"foryou.ask","payload":ForYouAsk}` goes to one TV when a phone
asked with `device_id` (the TV's «Спросить с телефона» QR).

## IPTV (live TV, Phase 7)

Rules: [architecture.md → IPTV](architecture.md#iptv-phase-7). Who: browser
sessions, paired TVs and API tokens (`read` for GET, `write` otherwise);
`profile_id` must be usable by the caller (else 404). Admin endpoints need
role `admin`.

| Method | Path | Notes |
|---|---|---|
| GET | `/iptv/channels?profile_id&group&q&include_hidden` | `IptvChannelList {items: IptvChannel[], groups: IptvGroup[], favorites_count, last_channel_id, server_time}`. `group` = an `IptvGroup.id` or `favorites`; `q` matches names (case/ё-insensitive, iptv-org alt names too) or a channel number. Hidden channels only with `include_hidden=true` |
| GET | `/iptv/channels/{id}/epg?from&to` | `{items: IptvProgramme[]}` overlapping the range (default now − 3 h … + 24 h, ≤ 3 days) |
| PATCH | `/iptv/channels/{id}/prefs` | `{profile_id, favorite?, hidden?, number?}` (`number: null` clears; 1…9999) → the `IptvChannel` |
| PUT | `/iptv/order` | `{profile_id, channel_ids}` (≤ 5000): listed channels first in that order, the rest after; `[]` resets → 204 |
| POST | `/iptv/watched` | `{profile_id, channel_id}` → 204: the "watched channel" event (sets the profile's last channel) |
| GET | `/iptv/state?profile_id` | `{available, channel_count, last: {channel, watched_at} \| null, playlists: [{id, name, channel_count, selected}]}` |
| GET | `/iptv/guide?profile_id&from&to&group&offset&limit` | grid page `{from, to, total, offset, items: [{channel, programmes}]}`; default from = now − 30 min floored to 30 min, to = from + 4 h (≤ 24 h); limit ≤ 100 |
| GET | `/iptv/logos/{id}` | public; the channel's logo fetched server-side (disk cache, `Cache-Control: public, max-age=86400`) |
| POST | `/playback/sources` | `{kind: "iptv", channel_id, profile_id?}` → 201 `PlaybackSource` with `kind: "iptv"`, `live: true`, `channel_id`, `media_id: null`, `format` `hls` or `ts`, `stream_url` `/api/v1/live/<token>/index.m3u8` or `…/stream.ts`. Not retrievable by GET (POST again for a fresh token). `video_codec` / `audio_codec` from the last health check. The server opens the channel (then its mirrors) first; 404 unknown/disabled channel, 502 with a cause when nothing answers: `channel_geo_blocked`, `channel_timeout`, `channel_format_unsupported`, `channel_unavailable` (remembered 45 s) |
| GET/HEAD | `/live/{token}/{name}` | anyone with the token (12 h). `index.m3u8`: the upstream playlist fetched fresh and rewritten (`Cache-Control: no-cache, no-store`); nested playlists/segments/keys are `/live/{token}/{signed ref}` (403 `invalid_stream_url` otherwise); `stream.ts`: TS pass-through. 502 `stream_unavailable` when the upstream fails |

Admin (`/admin/iptv/…`):

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/iptv/playlists` | `{items: AdminIptvPlaylist[], totals: IptvStats, proxy_configured, refresh_hours, epg_refresh_hours}`; each playlist has `refresh {status never/running/ok/error, error, refreshed_at, fetched_via direct/proxy/upload}`, `epg {status …/none, error, refreshed_at, xmltv_channels, programmes}`, `stats {channels, offline, epg_matched, with_programmes}`, `effective_epg_url`. `epg_urls` + `epg.guides[]` (per guide: status, classified error, bytes, took_ms, fetched_via, matched, programmes, live `progress {phase, bytes, total}`). `m3u_url` URLs come back with credentials masked (`***`); PATCH without `url` keeps the stored one. `epg_url` takes up to 5 URLs (commas/new lines), merged in order |
| POST | `/admin/iptv/playlists` | `AdminIptvPlaylistInput` (`kind` required; `country` for `iptv_org_country`, `url` for `m3u_url`) → 201, first refresh starts in the background; 409 `playlist_exists` for a country added twice. Audited `iptv.playlist_created` |
| PATCH | `/admin/iptv/playlists/{id}` | partial update (kind fixed); a new URL/country or enabling refreshes, a new `epg_url` refreshes the guide. Audited `iptv.playlist_updated` |
| DELETE | `/admin/iptv/playlists/{id}` | channels and per-profile prefs go too → 204. Audited `iptv.playlist_deleted` |
| PUT | `/admin/iptv/playlists/{id}/content` | `m3u_file`: raw M3U body (`text/plain`, ≤ 5 MB, UTF-8) → refresh; 422 when no channel parses. Audited `iptv.playlist_uploaded` |
| POST | `/admin/iptv/playlists/{id}/refresh` | 202 (playlist, then its guide); 409 `refresh_running`. Audited `iptv.playlist_refreshed` |
| GET | `/admin/iptv/countries` | iptv-org presets `{items: [{code, name_en, name_ru, suggested}]}` |

Realtime: `iptv.play {channel_id, profile_id?, force?}` switches a TV to a
channel (same `busy_playing` → `force` flow as `media.play`). While a channel
plays, the TV reports `DeviceState.live {channel_id, name, number, programme}`
with `screen: "player"`, `media_id: null`, `playback: null`.

Profile setting `iptv_playlists`: `"all"` (default) or a list of playlist ids
(unknown ids → 422).

## Video (YouTube via Invidious)

The «Видео» tab talks to a self-hosted Invidious on the internal network
(`INVIDIOUS_URL`); see [architecture](architecture.md#video-invidious). Every
`/video/*` endpoint accepts browser sessions, paired TVs and API tokens
(read/write); per-profile lists need `profile_id` (404 for someone else's
profile, 422 when missing). Catalog endpoints take an optional `profile_id`
that applies `video_hide_shorts` (`shorts=true` keeps them) and adds each
video's `progress`. While Invidious is down or not configured they answer
503 `video_unavailable`; the cached feed, lists and history still work.

| Method | Path | Notes |
|---|---|---|
| GET | `/video/search?q&type&page&profile_id` | `VideoSearchResult {videos, channels, playlists, page}`; `type` all/video/channel/playlist, page 1…20. Cached 10 min |
| GET | `/video/search/suggestions?q` | `{items: string[]}` (≤ 10, cached 1 h) |
| GET | `/video/trending?region=RU&type&profile_id` | `{items: VideoItem[]}`, cached 30 min. `type` default/music/gaming/movies/news; the default list drops live streams and is topped up from gaming |
| GET | `/video/videos/{id}?profile_id` | `VideoDetail`: description, likes, `channel` (+ `subscribed`), `related`, `qualities` (≤ 1080), `captions`, `playable`, `in_watch_later`, `progress`. Cached up to 6 h (less when YouTube's stream URLs expire sooner) |
| GET | `/video/channels/{id}?profile_id` | `VideoChannel` with the latest uploads and `continuation` |
| GET | `/video/channels/{id}/videos?continuation` | `{items, continuation}` |
| GET | `/video/playlists/{id}` | `VideoPlaylist` |
| GET | `/video/feed?profile_id` | «Подписки»: latest uploads of the subscribed channels, newest first (≤ 100) + `refreshed_at` |
| GET | `/video/subscriptions?profile_id` | `{items: VideoSubscription[]}` by name |
| PUT / DELETE | `/video/subscriptions/{channel_id}?profile_id` | subscribe (→ `VideoChannelRef`, idempotent; the channel's feed refreshes right away) / unsubscribe (204) |
| GET | `/video/watch-later?profile_id` | «Смотреть позже», newest first |
| PUT / DELETE | `/video/watch-later/{video_id}?profile_id` | add (→ `VideoItem`; 404 unknown video) / remove (204) |
| GET | `/video/history?profile_id` | «История»: played videos with `progress`, most recent first (≤ 200) |
| DELETE | `/video/history/{video_id}?profile_id` | forget one (and its resume position) |
| GET | `/video/continue?profile_id` | «Продолжить»: unfinished (≥ 15 s, last 60 days), ≤ 30 |
| POST | `/video/progress` | `{profile_id, video_id, position_seconds, duration_seconds?}` → 204; finished within the last 8 % or 20 s |
| GET | `/video/thumbs/vi/{id}/{name}.jpg`, `/video/thumbs/ggpht/{path}` | public image proxy (Invidious → i.ytimg.com / yt3.ggpht.com through the VPN), disk cache 7 days, `Cache-Control: public, max-age=86400` |
| POST | `/playback/sources` | `{kind: "video", video_id, quality?, profile_id?}` → 201 `PlaybackSource` with `kind: "video"`, `video_id`, `format: "hls"` (or `mp4` when YouTube has no H.264 DASH), `stream_url` `/api/v1/vstream/<token>/master.m3u8`, `fallback_url` (progressive MP4, 360p, for old engines) or null, `quality` (cap: `quality`, else the profile's `video_quality`, default 720), `qualities`, `subtitles` (captions as VTT), `duration_seconds`, `position_seconds` (resume, with profile_id). 404 unknown video, 422 `video_live_unsupported` (live/premiere) or `video_unplayable`, 503 `video_unavailable` |
| GET/HEAD | `/vstream/{token}/{name}` | anyone with the token (12 h): `master.m3u8`, `v<itag>.m3u8` / `a<itag>.m3u8` (VOD playlists built from the DASH sidx: EXT-X-BYTERANGE fragments of one fMP4 file), `m<itag>.mp4` (byte ranges passed through), `p<itag>.mp4` (progressive), `cc<n>.vtt`. Only this video's H.264/AAC formats on the Invidious origin; 403 `invalid_stream_token` / `stream_token_expired`, 502 `stream_unavailable` |
| GET | `/admin/video/status?check` | admin: `AdminVideoStatus {configured, reachable, version, latency_ms, checked_at, last_error, last_error_at, last_ok_at, subscriptions, channels, feed_videos, feed_refreshed_at}` |

Realtime: `video.play {video_id, profile_id?, position_seconds?, quality?, force?}`
plays a video on a TV (same `busy_playing` → `force` flow as `media.play` /
`iptv.play`).

Profile settings: `video_quality` 480 / 720 (default) / 1080 caps playback;
`video_hide_shorts` (default true) hides Shorts from video lists.
