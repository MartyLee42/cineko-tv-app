-- +goose Up
-- Kinopoisk ids from Wikidata (internal/ratings, keyless SPARQL): when a
-- title without kp_id was last looked up there without a confident match,
-- so the background backfill does not ask again for ~30 days.
ALTER TABLE media ADD COLUMN kp_wikidata_checked_at timestamptz;

-- The backfill scans titles still missing a Kinopoisk id.
CREATE INDEX media_kp_missing_idx ON media (updated_at DESC) WHERE kp_id IS NULL;

-- +goose Down
DROP INDEX media_kp_missing_idx;
ALTER TABLE media DROP COLUMN kp_wikidata_checked_at;
