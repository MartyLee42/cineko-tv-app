-- +goose Up
-- Kinopoisk/IMDb ratings (internal/ratings).
--
-- kp_id maps a title to Kinopoisk (resolved through a keyed API, budgeted);
-- ratings come keyless from rating.kinopoisk.ru/<kp_id>.xml and are
-- refreshed at most weekly, lazily when a title is displayed. A failed
-- lookup is remembered in kp_lookup_failed_at so misses are not retried for
-- ~30 days. Ratings are global (not per profile).

ALTER TABLE media
    ADD COLUMN kp_id               integer,
    ADD COLUMN kp_rating           double precision,
    ADD COLUMN kp_votes            integer,
    ADD COLUMN imdb_rating         double precision,
    ADD COLUMN imdb_votes          integer,
    ADD COLUMN ratings_fetched_at  timestamptz,
    ADD COLUMN kp_lookup_failed_at timestamptz;

ALTER TABLE media_external_ids DROP CONSTRAINT media_external_ids_provider_check;
ALTER TABLE media_external_ids ADD CONSTRAINT media_external_ids_provider_check
    CHECK (provider IN ('tmdb_movie', 'tmdb_tv', 'imdb', 'tvdb', 'kinopoisk'));

-- Requests spent against the Kinopoisk API key per day (Moscow date), so a
-- restart does not reset the daily budget.
CREATE TABLE ratings_budget (
    day  date PRIMARY KEY,
    used integer NOT NULL DEFAULT 0
);

-- +goose Down
DROP TABLE ratings_budget;
DELETE FROM media_external_ids WHERE provider = 'kinopoisk';
ALTER TABLE media_external_ids DROP CONSTRAINT media_external_ids_provider_check;
ALTER TABLE media_external_ids ADD CONSTRAINT media_external_ids_provider_check
    CHECK (provider IN ('tmdb_movie', 'tmdb_tv', 'imdb', 'tvdb'));
ALTER TABLE media
    DROP COLUMN kp_id,
    DROP COLUMN kp_rating,
    DROP COLUMN kp_votes,
    DROP COLUMN imdb_rating,
    DROP COLUMN imdb_votes,
    DROP COLUMN ratings_fetched_at,
    DROP COLUMN kp_lookup_failed_at;
