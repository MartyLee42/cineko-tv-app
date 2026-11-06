-- +goose Up
-- «Подборки» (internal/curated): curated film lists live in embedded JSON
-- files; this table maps each list position to a catalog title. item_key
-- (kind|tmdb_id|original title|year) detects a changed file entry, so a list
-- edit re-resolves only what changed. media_id NULL = not found (retried
-- after a while; shown as «нет в каталоге»).
CREATE TABLE curated_items (
    list_id    text        NOT NULL,
    position   int         NOT NULL CHECK (position > 0),
    item_key   text        NOT NULL,
    media_id   uuid        REFERENCES media (id) ON DELETE SET NULL,
    checked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (list_id, position)
);
CREATE INDEX curated_items_media_idx ON curated_items (media_id) WHERE media_id IS NOT NULL;

-- +goose Down
DROP TABLE curated_items;
