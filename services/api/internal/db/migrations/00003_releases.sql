-- +goose Up
-- Phase 4: release search (Prowlarr).
--
-- release_search_cache holds the parsed, matched (but not yet
-- preference-ranked) results of one search for ~30 minutes; expired rows are
-- kept up to 24 h as a fallback while Prowlarr is down.
--
-- release_sources maps every release shown to a client to its retrieval
-- data for 24 h, so playback can resolve a release id after the list cache
-- expired. download_url is a Prowlarr proxy link stored WITHOUT its apikey
-- parameter (re-added at resolve time); nothing here is ever sent to clients.

CREATE TABLE release_search_cache (
    key        text PRIMARY KEY,
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    season     integer,
    episode    integer,
    body       jsonb NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX release_search_cache_expiry_idx ON release_search_cache (expires_at);
CREATE INDEX release_search_cache_media_idx ON release_search_cache (media_id);

CREATE TABLE release_sources (
    media_id     uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    release_id   text NOT NULL,
    release      jsonb NOT NULL,
    info_hash    text,
    magnet_uri   text,
    download_url text,
    indexer      text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    PRIMARY KEY (media_id, release_id)
);
CREATE INDEX release_sources_expiry_idx ON release_sources (expires_at);

-- +goose Down
DROP TABLE release_sources;
DROP TABLE release_search_cache;
