-- +goose Up
-- The watch companion (internal/companion): «Ранее в сериале» recaps and
-- «После титров» (ending explained, why it matters, a short chat).

-- Finished AI answers. Recaps are keyed by the exact set of episodes they
-- were built from (scope = hash), so profiles at the same point share one;
-- «После титров» by what was finished (movie, season N, series).
CREATE TABLE companion_answers (
    media_id   uuid        NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    kind       text        NOT NULL CHECK (kind IN ('recap', 'ending', 'significance')),
    scope      text        NOT NULL,
    lang       text        NOT NULL,
    data       jsonb       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (media_id, kind, scope, lang)
);
CREATE INDEX companion_answers_expiry_idx ON companion_answers (expires_at);

-- One spoiler chat per profile and title (restarted on demand or when the
-- scope moves on). messages: [{"role": "user"|"assistant", "text": …}].
CREATE TABLE companion_chats (
    profile_id uuid        NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    media_id   uuid        NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    scope      text        NOT NULL,
    lang       text        NOT NULL,
    messages   jsonb       NOT NULL DEFAULT '[]',
    followups  jsonb       NOT NULL DEFAULT '[]',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, media_id)
);

-- Uncached answers + chat messages per profile per Moscow day
-- (FORYOU_COMPANION_DAILY_PER_PROFILE).
CREATE TABLE companion_usage (
    profile_id uuid    NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    day        date    NOT NULL,
    uses       integer NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, day)
);

-- +goose Down
DROP TABLE companion_usage;
DROP TABLE companion_chats;
DROP TABLE companion_answers;
