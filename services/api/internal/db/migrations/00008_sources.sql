-- +goose Up
-- Sources: a provider registry over torrent indexers (Prowlarr, Jacred) and
-- online/anime providers (AniLiberty). See docs/architecture.md "Sources".

-- Admin settings per provider. No row = enabled with defaults. secret holds
-- the credentials JSON encrypted with AES-GCM (key derived from
-- APP_SESSION_SECRET); never returned or logged.
CREATE TABLE source_config (
    id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9:_-]{1,64}$'),
    enabled    boolean NOT NULL DEFAULT true,
    settings   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"base_url": "..."}
    secret     bytea,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES users (id) ON DELETE SET NULL
);

-- One provider's online lookup for a title (6 h ok / 1 h empty / 10 min
-- error). variants keeps the provider-private refs: server-only.
CREATE TABLE online_search_cache (
    key        text PRIMARY KEY,                     -- media:season:episode:provider
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    provider   text NOT NULL,
    status     text NOT NULL CHECK (status IN ('ok', 'empty', 'error')),
    error      text,
    variants   jsonb NOT NULL DEFAULT '[]'::jsonb,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX online_search_cache_expiry_idx ON online_search_cache (expires_at);
CREATE INDEX online_search_cache_media_idx ON online_search_cache (media_id);

-- Every online variant shown to a client, resolvable by playback for 24 h
-- (like release_sources for torrents). ref is provider-private.
CREATE TABLE online_variants (
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    variant_id text NOT NULL,
    provider   text NOT NULL,
    variant    jsonb NOT NULL,
    ref        jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (media_id, variant_id)
);
CREATE INDEX online_variants_expiry_idx ON online_variants (expires_at);

-- Which torrent provider a stored release came from.
ALTER TABLE release_sources ADD COLUMN provider text NOT NULL DEFAULT 'prowlarr';

-- Playback sources can be online streams: no info hash, a provider + ref.
ALTER TABLE playback_sources
    ADD COLUMN kind text NOT NULL DEFAULT 'torrent' CHECK (kind IN ('torrent', 'online')),
    ADD COLUMN provider text,
    ADD COLUMN online_ref jsonb,                     -- server-only (variant + ref)
    ALTER COLUMN info_hash DROP NOT NULL,
    ADD CONSTRAINT playback_sources_kind_ref_check
        CHECK ((kind = 'torrent' AND info_hash IS NOT NULL) OR (kind = 'online' AND provider IS NOT NULL));
DROP INDEX playback_sources_reuse_key;
CREATE UNIQUE INDEX playback_sources_reuse_key
    ON playback_sources (created_by_user_id, info_hash, episode_id) NULLS NOT DISTINCT WHERE kind = 'torrent';
CREATE UNIQUE INDEX playback_sources_online_reuse_key
    ON playback_sources (created_by_user_id, release_id, episode_id) NULLS NOT DISTINCT WHERE kind = 'online';

-- +goose Down
DELETE FROM playback_sources WHERE kind <> 'torrent';
DROP INDEX playback_sources_online_reuse_key;
DROP INDEX playback_sources_reuse_key;
CREATE UNIQUE INDEX playback_sources_reuse_key
    ON playback_sources (created_by_user_id, info_hash, episode_id) NULLS NOT DISTINCT;
ALTER TABLE playback_sources
    DROP CONSTRAINT playback_sources_kind_ref_check,
    ALTER COLUMN info_hash SET NOT NULL,
    DROP COLUMN online_ref,
    DROP COLUMN provider,
    DROP COLUMN kind;
ALTER TABLE release_sources DROP COLUMN provider;
DROP TABLE online_variants;
DROP TABLE online_search_cache;
DROP TABLE source_config;
