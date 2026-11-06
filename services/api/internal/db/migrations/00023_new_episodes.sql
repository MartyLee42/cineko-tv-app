-- +goose Up
-- «Новые серии»: episodes of a profile's series that aired after what the
-- profile watched, found by the nightly check (internal/watch/newepisodes.go).
CREATE TABLE new_episodes (
    profile_id  uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    episode_id  uuid NOT NULL REFERENCES episodes (id) ON DELETE CASCADE,
    media_id    uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    air_date    date NOT NULL,
    detected_at timestamptz NOT NULL DEFAULT now(),
    -- Marked seen / hidden by the profile (watching the episode hides it too).
    seen_at     timestamptz,
    -- 'kinopoisk': the series is "mine" only through a Kinopoisk ratings import.
    source      text CHECK (source IN ('kinopoisk')),
    PRIMARY KEY (profile_id, episode_id)
);
CREATE INDEX new_episodes_profile_idx ON new_episodes (profile_id, air_date DESC);

-- One row per check (nightly, startup catch-up or admin «run now»).
CREATE TABLE new_episode_runs (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    trigger        text NOT NULL CHECK (trigger IN ('schedule', 'startup', 'manual')),
    status         text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    started_at     timestamptz NOT NULL DEFAULT now(),
    finished_at    timestamptz,
    series_checked integer NOT NULL DEFAULT 0,
    refresh_errors integer NOT NULL DEFAULT 0,
    found          integer NOT NULL DEFAULT 0,
    error          text
);
CREATE INDEX new_episode_runs_started_idx ON new_episode_runs (started_at DESC);

-- +goose Down
DROP TABLE new_episode_runs;
DROP TABLE new_episodes;
