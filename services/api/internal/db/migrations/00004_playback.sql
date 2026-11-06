-- +goose Up
-- Phase 4: playback sources (a release registered with TorrServer and the
-- file chosen inside it). TorrServer URLs/credentials are never stored here.

CREATE TABLE playback_sources (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    media_id           uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    episode_id         uuid REFERENCES episodes (id) ON DELETE CASCADE,
    release_id         text NOT NULL,
    release            jsonb NOT NULL,
    info_hash          text NOT NULL CHECK (info_hash ~ '^[0-9a-f]{40}$'),
    -- Server-only: the magnet used to (re-)register the torrent. May carry
    -- private tracker passkeys, so it is never returned to clients.
    magnet             text,
    file_index         integer,
    file_path          text,
    file_size          bigint,
    files              jsonb,          -- cached TorrServer file list
    status             text NOT NULL DEFAULT 'preparing'
                       CHECK (status IN ('preparing', 'ready', 'error')),
    error_code         text,
    media_info         jsonb,
    created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id          uuid REFERENCES devices (id) ON DELETE SET NULL,
    profile_id         uuid REFERENCES profiles (id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    ready_at           timestamptz
);
-- One source per (account, torrent, episode): re-creating reuses it.
CREATE UNIQUE INDEX playback_sources_reuse_key
    ON playback_sources (created_by_user_id, info_hash, episode_id) NULLS NOT DISTINCT;
CREATE INDEX playback_sources_media_idx ON playback_sources (media_id);

-- +goose Down
DROP TABLE playback_sources;
