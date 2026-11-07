-- +goose Up
-- Taste by themes (internal/foryou, docs/architecture.md "Recommendations"):
-- TMDB keywords per title, fetched with the details (append_to_response) or
-- backfilled by the daily run. Names are English (TMDB has no translated
-- keywords); name_ru is filled by the AI themes call when it runs.
CREATE TABLE keywords (
    id         integer PRIMARY KEY, -- TMDB keyword id
    name       text NOT NULL,
    name_ru    text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE media_keywords (
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    keyword_id integer NOT NULL REFERENCES keywords (id) ON DELETE CASCADE,
    position   smallint NOT NULL DEFAULT 0,
    PRIMARY KEY (media_id, keyword_id)
);
CREATE INDEX media_keywords_keyword_idx ON media_keywords (keyword_id);

-- When the title's keywords were last stored (NULL = never; a title may
-- legitimately have none).
ALTER TABLE media ADD COLUMN keywords_fetched_at timestamptz;

-- AI rubrics: 'ai' = the model proposes titles (resolved via TMDB search),
-- 'theme' = the model groups the scorer's own unseen candidates.
ALTER TABLE foryou_collections ADD COLUMN kind text NOT NULL DEFAULT 'ai' CHECK (kind IN ('ai', 'theme'));

-- AI re-ranking of «Подобрано для вас»: the model's picks (in order) with a
-- one-line personal reason each, in the profile's language.
CREATE TABLE foryou_ai_picks (
    profile_id   uuid PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
    run_id       uuid REFERENCES foryou_runs (id) ON DELETE SET NULL,
    lang         text NOT NULL,
    items        jsonb NOT NULL, -- [{"m": media id, "why": "…"}]
    model        text NOT NULL,
    generated_at timestamptz NOT NULL DEFAULT now()
);

-- The candidates the top-picks row is chosen from (ids, best first): what
-- the AI re-ranking sees.
ALTER TABLE recs_cache ADD COLUMN top_candidates jsonb NOT NULL DEFAULT '[]';

-- +goose Down
ALTER TABLE recs_cache DROP COLUMN top_candidates;
DROP TABLE foryou_ai_picks;
DELETE FROM foryou_collections WHERE kind = 'theme';
ALTER TABLE foryou_collections DROP COLUMN kind;
ALTER TABLE media DROP COLUMN keywords_fetched_at;
DROP TABLE media_keywords;
DROP TABLE keywords;
