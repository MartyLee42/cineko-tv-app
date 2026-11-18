-- +goose Up
-- How one playback went, as measured by the player: one row per session,
-- overwritten by the running totals piggybacked on progress reports (every
-- few minutes and at the end).
CREATE TABLE playback_quality (
    session_id       uuid PRIMARY KEY REFERENCES playback_sessions (id) ON DELETE CASCADE,
    app              text NOT NULL CHECK (app IN ('tv', 'web')),
    engine           text NOT NULL DEFAULT '',
    startup_ms       integer,
    watched_s        integer NOT NULL DEFAULT 0,
    stalls           integer NOT NULL DEFAULT 0,
    stall_ms         bigint  NOT NULL DEFAULT 0,
    longest_stall_ms integer NOT NULL DEFAULT 0,
    seeks            integer NOT NULL DEFAULT 0,
    seek_wait_ms     bigint  NOT NULL DEFAULT 0,
    dropped_frames   bigint  NOT NULL DEFAULT 0,
    total_frames     bigint  NOT NULL DEFAULT 0,
    width            integer,
    height           integer,
    errors           integer NOT NULL DEFAULT 0,
    final            boolean NOT NULL DEFAULT false,
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX playback_quality_updated_idx ON playback_quality (updated_at DESC);

-- +goose Down
DROP TABLE playback_quality;
