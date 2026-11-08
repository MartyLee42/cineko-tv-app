-- +goose Up
-- Learned source weights (internal/foryou/learn.go): the nightly run measures
-- which candidate sources (trending, director, theme, AI…) lead to plays per
-- profile and stores a bounded multiplier per source.

-- Attribution stored with each feedback event, from the cached row the title
-- was served in: sources = {learn key: share of the candidate's source
-- strength}; row_pos / item_pos = row index and tile index (0-based) for the
-- position-bias correction; score = the item's predicted score (quality
-- metrics: calibration). NULL for events outside the cached rows.
ALTER TABLE foryou_feedback
    ADD COLUMN sources  jsonb,
    ADD COLUMN row_pos  smallint,
    ADD COLUMN item_pos smallint,
    ADD COLUMN score    real;
-- Outcome lookups per (profile, title).
CREATE INDEX foryou_feedback_media_idx ON foryou_feedback (profile_id, media_id, created_at);

-- One row per (profile, source). The counts are share-weighted, undecayed,
-- over the learning window; weight is what scoring and row order use,
-- prev_weight the one before the last nightly update (shown to the admin).
CREATE TABLE foryou_source_weights (
    profile_id  uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    source      text NOT NULL,
    weight      double precision NOT NULL DEFAULT 1,
    prev_weight double precision NOT NULL DEFAULT 1,
    target      double precision NOT NULL DEFAULT 1,
    impressions double precision NOT NULL DEFAULT 0,
    opens       double precision NOT NULL DEFAULT 0,
    plays       double precision NOT NULL DEFAULT 0,
    completes   double precision NOT NULL DEFAULT 0,
    dismisses   double precision NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, source)
);

-- +goose Down
DROP TABLE foryou_source_weights;
DROP INDEX foryou_feedback_media_idx;
ALTER TABLE foryou_feedback DROP COLUMN score, DROP COLUMN item_pos, DROP COLUMN row_pos, DROP COLUMN sources;
