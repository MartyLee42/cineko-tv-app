-- +goose Up
-- Phase 2: TMDB media catalog.
--
-- Every title a client sees is materialized here so it has a stable internal
-- UUID: the same TMDB title always maps to the same media row regardless of
-- language, endpoint or device. Language-agnostic facts live in columns;
-- localized strings live in `translations` keyed by catalog language
-- ({"en": {"title": …, "overview": …}, "ru": {…}}).

CREATE TABLE media (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind               text NOT NULL CHECK (kind IN ('movie', 'series')),
    -- TMDB movie and tv ids are separate namespaces (and collide), so the
    -- materialization key is (kind, tmdb_id). Mirrored in media_external_ids.
    tmdb_id            integer NOT NULL,
    original_title     text NOT NULL DEFAULT '',
    original_language  text NOT NULL DEFAULT '',
    release_date       date,           -- movies: release; series: first air date
    year               integer,
    runtime            integer,        -- minutes; series: typical episode runtime
    status             text NOT NULL DEFAULT '',
    poster_path        text,           -- default (en) artwork; localized in translations
    backdrop_path      text,
    vote_average       double precision NOT NULL DEFAULT 0,
    vote_count         integer NOT NULL DEFAULT 0,
    popularity         double precision NOT NULL DEFAULT 0,
    number_of_seasons  integer,
    number_of_episodes integer,
    last_air_date      date,
    countries          text[] NOT NULL DEFAULT '{}',
    translations       jsonb NOT NULL DEFAULT '{}',
    -- {"en": "<timestamp>"}: when full details were last fetched per language.
    details_fetched_at jsonb NOT NULL DEFAULT '{}',
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, tmdb_id)
);

CREATE TABLE media_external_ids (
    media_id    uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    provider    text NOT NULL CHECK (provider IN ('tmdb_movie', 'tmdb_tv', 'imdb', 'tvdb')),
    external_id text NOT NULL,
    PRIMARY KEY (provider, external_id),
    UNIQUE (media_id, provider)
);

-- Genre names per language. TMDB genre ids are shared by the movie and tv lists.
CREATE TABLE genres (
    id           integer PRIMARY KEY,   -- TMDB genre id
    translations jsonb NOT NULL DEFAULT '{}',
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- No FK to genres: list results reference genre ids before the genre list
-- (names) has been fetched, and names are only needed for display.
CREATE TABLE media_genres (
    media_id uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    genre_id integer NOT NULL,
    position smallint NOT NULL DEFAULT 0,
    PRIMARY KEY (media_id, genre_id)
);
CREATE INDEX media_genres_genre_idx ON media_genres (genre_id);

CREATE TABLE media_people (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tmdb_id      integer NOT NULL UNIQUE,
    name         text NOT NULL,          -- original (usually Latin) name
    translations jsonb NOT NULL DEFAULT '{}', -- {"ru": "Киану Ривз"}
    profile_path text,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_cast (
    media_id    uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    person_id   uuid NOT NULL REFERENCES media_people (id) ON DELETE CASCADE,
    credit_type text NOT NULL CHECK (credit_type IN ('cast', 'crew')),
    character   text NOT NULL DEFAULT '',
    job         text NOT NULL DEFAULT '',
    department  text NOT NULL DEFAULT '',
    ord         integer NOT NULL DEFAULT 0,
    PRIMARY KEY (media_id, credit_type, person_id, job)
);
CREATE INDEX media_cast_person_idx ON media_cast (person_id);

CREATE TABLE seasons (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    media_id            uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    season_number       integer NOT NULL,
    tmdb_id             integer,
    air_date            date,
    episode_count       integer NOT NULL DEFAULT 0,
    poster_path         text,
    translations        jsonb NOT NULL DEFAULT '{}',
    episodes_fetched_at jsonb NOT NULL DEFAULT '{}',
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (media_id, season_number)
);

-- Episode ids are stable per (media, season, episode): watch history and
-- progress (Phase 5) reference them.
CREATE TABLE episodes (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    media_id       uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    season_id      uuid NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
    season_number  integer NOT NULL,
    episode_number integer NOT NULL,
    tmdb_id        integer,
    air_date       date,
    runtime        integer,
    still_path     text,
    vote_average   double precision NOT NULL DEFAULT 0,
    vote_count     integer NOT NULL DEFAULT 0,
    translations   jsonb NOT NULL DEFAULT '{}',
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (media_id, season_number, episode_number)
);
CREATE INDEX episodes_season_idx ON episodes (season_id);

-- Raw TMDB responses for lists, search, discover, genres and providers.
-- The key is the request path plus sorted query (never credentials).
CREATE TABLE tmdb_cache (
    key        text PRIMARY KEY,
    body       jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX tmdb_cache_expiry_idx ON tmdb_cache (expires_at);

-- +goose Down
DROP TABLE tmdb_cache;
DROP TABLE episodes;
DROP TABLE seasons;
DROP TABLE media_cast;
DROP TABLE media_people;
DROP TABLE media_genres;
DROP TABLE genres;
DROP TABLE media_external_ids;
DROP TABLE media;
