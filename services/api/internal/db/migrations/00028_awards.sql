-- +goose Up
-- Film awards and nominations from Wikidata (internal/awards): P166 (award
-- received) → won, P1411 (nominated for) → nominated. A title's rows are
-- replaced on every check. year 0 = unknown. group_key/tier come from the
-- curated map of major awards (internal/awards/groups.go) at fetch time:
-- tier 1 = Oscars and the main prizes of Cannes/Venice/Berlin, 2 = other
-- major awards, 3 = everything else ("other").
CREATE TABLE media_awards (
    media_id  uuid     NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    award_qid text     NOT NULL,
    group_key text     NOT NULL,
    label_ru  text     NOT NULL DEFAULT '',
    label_en  text     NOT NULL DEFAULT '',
    year      smallint NOT NULL DEFAULT 0,
    won       boolean  NOT NULL,
    tier      smallint NOT NULL CHECK (tier BETWEEN 1 AND 3),
    PRIMARY KEY (media_id, award_qid, year, won)
);

-- When Wikidata was last asked about a title's awards (re-checked after
-- 60 days by the background backfill; NULL = never: fetched when shown).
ALTER TABLE media ADD COLUMN awards_checked_at timestamptz;

-- +goose Down
ALTER TABLE media DROP COLUMN awards_checked_at;
DROP TABLE media_awards;
