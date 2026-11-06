-- +goose Up
-- YouTube «Видео» tab (internal/video): per-profile channel subscriptions,
-- «Смотреть позже», watch history with resume positions, and the cached
-- latest videos of subscribed channels (the subscriptions feed, refreshed
-- every 30 min). Video ids are YouTube ids (11 chars), channel ids UC….
-- Rows keep a small snapshot of the video (title, channel, duration) so
-- lists render without asking Invidious.

CREATE TABLE video_subscriptions (
    profile_id   uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    channel_id   text NOT NULL CHECK (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
    channel_name text NOT NULL DEFAULT '',
    avatar       text,                 -- proxied avatar path (/api/v1/video/thumbs/ggpht/…)
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, channel_id)
);
CREATE INDEX video_subscriptions_channel ON video_subscriptions (channel_id);

-- Feed cache: the latest uploads of every subscribed channel.
CREATE TABLE video_channels (
    id           text PRIMARY KEY CHECK (id ~ '^UC[A-Za-z0-9_-]{22}$'),
    name         text NOT NULL DEFAULT '',
    avatar       text,
    refreshed_at timestamptz,
    last_error   text,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE video_channel_videos (
    channel_id       text NOT NULL REFERENCES video_channels (id) ON DELETE CASCADE,
    video_id         text NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
    item             jsonb NOT NULL,      -- video.Item snapshot
    published_at     timestamptz,
    position         integer NOT NULL,    -- order on the channel page (0 = newest)
    fetched_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, video_id)
);
CREATE INDEX video_channel_videos_published ON video_channel_videos (published_at DESC NULLS LAST);

CREATE TABLE video_watch_later (
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    video_id   text NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
    item       jsonb NOT NULL,            -- video.Item snapshot
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, video_id)
);
CREATE INDEX video_watch_later_added ON video_watch_later (profile_id, added_at DESC);

-- History + resume: one row per (profile, video), updated by progress reports.
CREATE TABLE video_progress (
    profile_id       uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    video_id         text NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
    item             jsonb NOT NULL,      -- video.Item snapshot
    position_seconds double precision NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
    duration_seconds double precision NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
    finished         boolean NOT NULL DEFAULT false,
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, video_id)
);
CREATE INDEX video_progress_recent ON video_progress (profile_id, updated_at DESC);

-- +goose Down
DROP TABLE video_progress;
DROP TABLE video_watch_later;
DROP TABLE video_channel_videos;
DROP TABLE video_channels;
DROP TABLE video_subscriptions;
