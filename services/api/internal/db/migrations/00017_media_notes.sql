-- +goose Up
-- Personal notes on titles («Моя заметка», internal/foryou/notes.go): a
-- private, per-profile reaction to a title — free text and quick reason
-- codes (too_slow, loved_atmosphere, …). Shown only to that profile
-- (`me.note`), sent to the AI prompts as the viewer's own reactions, and
-- dislike reasons feed the taste profile.
CREATE TABLE profile_media_notes (
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    text       text NOT NULL DEFAULT '' CHECK (char_length(text) <= 1000),
    reasons    text[] NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, media_id)
);
CREATE INDEX profile_media_notes_recent_idx ON profile_media_notes (profile_id, updated_at DESC, media_id);

-- +goose Down
DROP TABLE profile_media_notes;
