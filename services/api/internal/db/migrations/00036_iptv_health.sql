-- +goose Up
-- IPTV stream health (internal/livecheck): the last check's verdict and
-- cause, the codecs it saw, and the playlist's other URLs for the same
-- channel (duplicates of one tvg-id: tried in order when the first fails).
ALTER TABLE iptv_channels
    ADD COLUMN health            text CHECK (health IN ('ok', 'codec', 'geo', 'dead', 'timeout')),
    ADD COLUMN health_cause      text,
    ADD COLUMN health_checked_at timestamptz,
    ADD COLUMN video_codec       text,
    ADD COLUMN audio_codec       text,
    ADD COLUMN mirrors           jsonb NOT NULL DEFAULT '[]';

CREATE INDEX iptv_channels_health_due_idx ON iptv_channels (health_checked_at NULLS FIRST) WHERE active;

-- +goose Down
DROP INDEX IF EXISTS iptv_channels_health_due_idx;
ALTER TABLE iptv_channels
    DROP COLUMN health, DROP COLUMN health_cause, DROP COLUMN health_checked_at,
    DROP COLUMN video_codec, DROP COLUMN audio_codec, DROP COLUMN mirrors;
