-- +goose Up
-- Keepsakes (internal/keepsakes): a paper ticket stub per finished film and
-- silent achievement stickers, per profile.
--
-- A stub is issued once, the first time a film counts as finished
-- (watch_progress.completed, including «Просмотрено» and imports), and stays
-- when the film is later marked unwatched or rewatched. number is the
-- profile's running stub number in issue order. Seat, row and hall are not
-- stored: they are a hash of (profile, media), so they never change. The
-- rating punched into the stub is read live from ratings.
CREATE TABLE ticket_stubs (
    profile_id  uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    media_id    uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    number      integer NOT NULL CHECK (number > 0),
    finished_at timestamptz NOT NULL,
    issued_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, media_id),
    UNIQUE (profile_id, number)
);

-- An unlocked sticker (rules in internal/keepsakes/rules.go). unlocked_at is
-- when the history first satisfied the rule, not when it was noticed; a
-- sticker is never taken back. media_id: the title that earned it, if any.
CREATE TABLE profile_achievements (
    profile_id     uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    achievement_id text NOT NULL CHECK (achievement_id ~ '^[a-z][a-z0-9_]{1,40}$'),
    unlocked_at    timestamptz NOT NULL,
    media_id       uuid REFERENCES media (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, achievement_id)
);

-- Backfill: every film already finished gets its stub, numbered by finish time.
INSERT INTO ticket_stubs (profile_id, media_id, number, finished_at)
SELECT wp.profile_id, wp.media_id,
       row_number() OVER (PARTITION BY wp.profile_id ORDER BY COALESCE(wp.completed_at, wp.updated_at), wp.media_id),
       COALESCE(wp.completed_at, wp.updated_at)
FROM watch_progress wp JOIN media m ON m.id = wp.media_id
WHERE wp.completed AND wp.episode_id IS NULL AND m.kind = 'movie';

-- +goose Down
DROP TABLE profile_achievements;
DROP TABLE ticket_stubs;
