-- +goose Up
-- «Посоветовать»: one user recommends a title to another (internal/reco).
--
-- One row per (sender, recipient, title); re-recommending within 7 days
-- updates the note instead of adding a row. The recipient dismisses with
-- deleted_by_recipient (the sender still sees the reaction in /sent); the
-- sender withdraws by deleting the row.

CREATE TABLE recommendations (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    media_id             uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    from_user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    from_profile_id      uuid REFERENCES profiles (id) ON DELETE SET NULL,
    to_user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    note                 text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
    created_at           timestamptz NOT NULL DEFAULT now(),
    seen_at              timestamptz,
    reaction             text CHECK (reaction IN ('like', 'dislike', 'watched')),
    reply                text CHECK (length(reply) <= 300),
    reacted_at           timestamptz,
    deleted_by_recipient boolean NOT NULL DEFAULT false,
    CHECK (from_user_id <> to_user_id)
);
-- Inbox (newest first) and its unseen count.
CREATE INDEX recommendations_to_idx ON recommendations (to_user_id, created_at DESC) WHERE NOT deleted_by_recipient;
-- Sent list and the 7-day de-duplication lookup.
CREATE INDEX recommendations_from_idx ON recommendations (from_user_id, created_at DESC);
CREATE INDEX recommendations_dedupe_idx ON recommendations (from_user_id, to_user_id, media_id, created_at DESC);
CREATE INDEX recommendations_media_idx ON recommendations (media_id);

-- +goose Down
DROP TABLE recommendations;
