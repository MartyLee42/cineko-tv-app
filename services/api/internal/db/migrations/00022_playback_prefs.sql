-- +goose Up
-- Per-device playback profiles («Это устройство»): what a TV detected about
-- itself (auto: codecs, screen, throughput) and the user's overrides
-- (manual). Release ranking merges them (manual wins) per request.
ALTER TABLE devices
    ADD COLUMN playback_auto jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN playback_manual jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN playback_updated_at timestamptz;

-- The same for browsers/phones (PWA), per signed-in user and stable local
-- client id (localStorage martytv.client_id). At most 20 per user (the
-- oldest is dropped by the API).
CREATE TABLE client_playback_prefs (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{8,64}$'),
    name text NOT NULL DEFAULT '' CHECK (length(name) <= 64),
    platform text NOT NULL DEFAULT '' CHECK (length(platform) <= 64),
    auto jsonb NOT NULL DEFAULT '{}',
    manual jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, client_id)
);

-- +goose Down
DROP TABLE client_playback_prefs;
ALTER TABLE devices
    DROP COLUMN playback_auto,
    DROP COLUMN playback_manual,
    DROP COLUMN playback_updated_at;
