-- +goose Up
-- Phase 5: per-profile settings, watch sync (playback sessions, progress,
-- events), watchlist/favorites/ratings, and admin messages.
-- All timestamps are timestamptz and written by the server in UTC.

-- Preferred dub/voice-over studios (e.g. LostFilm), most preferred first.
ALTER TABLE profile_preferences ADD COLUMN preferred_voiceovers text[] NOT NULL DEFAULT '{}';

CREATE TABLE profile_settings (
    profile_id uuid PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
    -- Only the keys a client has set; defaults are filled in by the API.
    settings   jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- One row per "press play": the player opens a session and reports progress
-- against it with a monotonically increasing seq.
CREATE TABLE playback_sessions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id    uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,   -- caller (device owner for TVs)
    device_id     uuid REFERENCES devices (id) ON DELETE CASCADE,          -- null = browser / API token
    media_id      uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    episode_id    uuid REFERENCES episodes (id) ON DELETE CASCADE,
    source_id     uuid REFERENCES playback_sources (id) ON DELETE SET NULL,
    started_at    timestamptz NOT NULL DEFAULT now(),
    last_seq      bigint NOT NULL DEFAULT -1,
    last_position double precision NOT NULL DEFAULT 0,
    last_duration double precision,
    last_state    text CHECK (last_state IN ('playing', 'paused', 'seeking', 'ended', 'stopped')),
    last_event_at timestamptz,  -- throttles watch_events for periodic reports
    updated_at    timestamptz NOT NULL DEFAULT now(),
    ended_at      timestamptz
);
CREATE INDEX playback_sessions_item_idx ON playback_sessions (profile_id, media_id, episode_id, started_at DESC);
CREATE INDEX playback_sessions_active_idx ON playback_sessions (updated_at DESC) WHERE ended_at IS NULL;

-- Resume point + completion per (profile, movie) or (profile, episode).
CREATE TABLE watch_progress (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id       uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    media_id         uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    episode_id       uuid REFERENCES episodes (id) ON DELETE CASCADE,
    position_seconds double precision NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
    duration_seconds double precision CHECK (duration_seconds >= 0),
    percent          double precision NOT NULL DEFAULT 0 CHECK (percent BETWEEN 0 AND 1),
    completed        boolean NOT NULL DEFAULT false,
    completed_at     timestamptz,
    manual           boolean NOT NULL DEFAULT false,
    -- position is a meaningful resume point (>= 30 s and before the end).
    resumable        boolean NOT NULL DEFAULT false,
    last_session_id  uuid REFERENCES playback_sessions (id) ON DELETE SET NULL,
    -- Denormalized so the stale-session rule survives session pruning.
    last_session_started_at timestamptz,
    device_id        uuid REFERENCES devices (id) ON DELETE SET NULL,
    started_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT watch_progress_item_key UNIQUE NULLS NOT DISTINCT (profile_id, media_id, episode_id)
);
CREATE INDEX watch_progress_recent_idx ON watch_progress (profile_id, updated_at DESC, id DESC);
CREATE INDEX watch_progress_media_idx ON watch_progress (media_id);

-- Append-only activity log for the future diary/recommendations. Periodic
-- "playing" reports are throttled per session; pruned after a year.
CREATE TABLE watch_events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    session_id uuid REFERENCES playback_sessions (id) ON DELETE SET NULL,
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    episode_id uuid REFERENCES episodes (id) ON DELETE CASCADE,
    device_id  uuid REFERENCES devices (id) ON DELETE SET NULL,
    state      text NOT NULL,
    position   double precision NOT NULL,
    duration   double precision,
    seq        bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watch_events_profile_idx ON watch_events (profile_id, created_at DESC);
CREATE INDEX watch_events_created_idx ON watch_events (created_at);

CREATE TABLE watchlist_items (
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, media_id)
);
CREATE INDEX watchlist_items_recent_idx ON watchlist_items (profile_id, created_at DESC);

CREATE TABLE favorites (
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, media_id)
);
CREATE INDEX favorites_recent_idx ON favorites (profile_id, created_at DESC);

CREATE TABLE ratings (
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    rating     smallint NOT NULL CHECK (rating BETWEEN 1 AND 10),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, media_id)
);

-- Admin → user messages (inbox + live delivery over the realtime socket).
CREATE TABLE messages (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    sender_name    text NOT NULL,   -- kept if the sender is deleted
    title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
    body           text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
    show_on_tv     boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_created_idx ON messages (created_at DESC);

CREATE TABLE message_recipients (
    message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    read_at    timestamptz,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_recipients_user_idx ON message_recipients (user_id);

-- +goose Down
DROP TABLE message_recipients;
DROP TABLE messages;
DROP TABLE ratings;
DROP TABLE favorites;
DROP TABLE watchlist_items;
DROP TABLE watch_events;
DROP TABLE watch_progress;
DROP TABLE playback_sessions;
DROP TABLE profile_settings;
ALTER TABLE profile_preferences DROP COLUMN preferred_voiceovers;
