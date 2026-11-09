-- +goose Up
-- «Кто видит чьи лайки» (Admin → Overview): admin overrides of «Семья
-- советует» per (viewer, sharer) pair. allowed = true shows the sharer's
-- ratings, finished titles and favorites to the viewer even when the sharer
-- has share_with_family off; false hides them even when it is on. No row =
-- the sharer's own share_with_family (so existing installs are unchanged).
CREATE TABLE family_visibility (
    viewer_profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    sharer_profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    allowed           boolean NOT NULL,
    updated_by        uuid REFERENCES users (id) ON DELETE SET NULL,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (viewer_profile_id, sharer_profile_id),
    CHECK (viewer_profile_id <> sharer_profile_id)
);
CREATE INDEX family_visibility_sharer_idx ON family_visibility (sharer_profile_id);

-- +goose Down
DROP TABLE family_visibility;
