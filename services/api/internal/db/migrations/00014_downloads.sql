-- +goose Up
-- Server downloads (internal/downloads): a torrent file read in full through
-- TorrServer and kept on the server's disk (LIBRARY_DIR), so it plays from
-- disk later. One row per (info hash, file index), shared by everyone who
-- asked for it (download_requests). See docs/architecture.md "Server downloads".

CREATE TABLE downloads (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    info_hash       text NOT NULL CHECK (info_hash ~ '^[0-9a-f]{40}$'),
    file_index      integer NOT NULL CHECK (file_index >= 0),
    file_path       text NOT NULL,                -- path inside the torrent
    size            bigint NOT NULL CHECK (size > 0),
    media_id        uuid REFERENCES media (id) ON DELETE SET NULL,
    episode_id      uuid REFERENCES episodes (id) ON DELETE SET NULL,
    release_title   text NOT NULL DEFAULT '',
    -- The playback source it was requested from (to re-add the torrent to
    -- TorrServer from its stored magnet when it was removed there).
    source_id       uuid REFERENCES playback_sources (id) ON DELETE SET NULL,
    status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'downloading', 'paused', 'done', 'failed', 'waiting_space')),
    error           text,
    space_needed    bigint,
    bytes_done      bigint NOT NULL DEFAULT 0,
    pinned          boolean NOT NULL DEFAULT false,
    created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    completed_at    timestamptz,
    last_watched_at timestamptz,
    UNIQUE (info_hash, file_index)
);
CREATE INDEX downloads_status_idx ON downloads (status, created_at);
CREATE INDEX downloads_media_idx ON downloads (media_id);

-- Who asked for a download ("my downloads"). A user's delete removes their
-- request; the file goes when nobody is left.
CREATE TABLE download_requests (
    download_id uuid NOT NULL REFERENCES downloads (id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (download_id, user_id)
);
CREATE INDEX download_requests_user_idx ON download_requests (user_id);

-- Admin storage settings (single row).
CREATE TABLE library_settings (
    id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    reserve_gb     double precision NOT NULL DEFAULT 15 CHECK (reserve_gb > 0),
    max_library_gb double precision CHECK (max_library_gb IS NULL OR max_library_gb > 0),
    keep_days      integer NOT NULL DEFAULT 30 CHECK (keep_days > 0),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    updated_by     uuid REFERENCES users (id) ON DELETE SET NULL
);
INSERT INTO library_settings (id) VALUES (1);

-- +goose Down
DROP TABLE library_settings;
DROP TABLE download_requests;
DROP TABLE downloads;
