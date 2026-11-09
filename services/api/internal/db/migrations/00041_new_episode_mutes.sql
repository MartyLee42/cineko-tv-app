-- +goose Up
-- «Новые серии»: series a profile asked not to be told about. The nightly
-- check skips them (no TMDB refresh when every profile of the series muted it)
-- and the list hides their existing items, which come back on unmute.
CREATE TABLE new_episode_mutes (
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, media_id)
);

-- +goose Down
DROP TABLE new_episode_mutes;
