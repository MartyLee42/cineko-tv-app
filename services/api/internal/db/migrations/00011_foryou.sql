-- +goose Up
-- Phase 6 personal recommendations (internal/foryou): taste profiles, the
-- cached «Для вас» rows, feedback/dismissals, AI collections (подборки),
-- runs and the daily AI token budget. Not to be confused with
-- `recommendations` (people recommending titles to each other, 00007).

-- Aggregated affinities per profile, recomputed by the daily run and on
-- demand. data = {genres, decades, languages, countries, directors, actors,
-- seeds, stats…} (see foryou.Taste).
CREATE TABLE profile_taste (
    profile_id  uuid PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
    data        jsonb NOT NULL,
    signals     integer NOT NULL DEFAULT 0,
    computed_at timestamptz NOT NULL DEFAULT now()
);

-- Computed rows + the scored candidate pool (Surprise Me) per profile.
-- Language-agnostic: ids and typed reasons only; titles/names are resolved
-- per request. signals_at = newest signal included, to detect staleness.
CREATE TABLE recs_cache (
    profile_id  uuid PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
    rows        jsonb NOT NULL,
    pool        jsonb NOT NULL,
    cold_start  boolean NOT NULL DEFAULT false,
    -- Catalog language the candidates were fetched in (the last one the
    -- profile asked for), so their titles are translated.
    lang        text NOT NULL DEFAULT 'en',
    signals_at  timestamptz,
    computed_at timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL
);

-- «Не интересно»: hidden everywhere in For You, used as a negative signal.
CREATE TABLE foryou_dismissals (
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, media_id)
);

-- Impressions/opens/plays/completions/dismissals for evaluation and
-- impression fatigue. Pruned after 180 days.
CREATE TABLE foryou_feedback (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    action     text NOT NULL CHECK (action IN ('impression', 'open', 'dismiss', 'undismiss', 'play', 'complete')),
    row_id     text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX foryou_feedback_profile_idx ON foryou_feedback (profile_id, created_at DESC);
CREATE INDEX foryou_feedback_created_idx ON foryou_feedback (created_at);

-- Background runs (daily schedule or admin button). One runs at a time.
CREATE TABLE foryou_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scope               text NOT NULL CHECK (scope IN ('all', 'user', 'profile')),
    target_id           uuid,
    ai                  boolean NOT NULL DEFAULT true,
    trigger             text NOT NULL CHECK (trigger IN ('schedule', 'admin', 'startup')),
    status              text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
    requested_by        uuid REFERENCES users (id) ON DELETE SET NULL,
    profiles_total      integer NOT NULL DEFAULT 0,
    profiles_done       integer NOT NULL DEFAULT 0,
    ai_calls            integer NOT NULL DEFAULT 0,
    ai_tokens           integer NOT NULL DEFAULT 0,
    collections_created integer NOT NULL DEFAULT 0,
    errors              jsonb NOT NULL DEFAULT '[]',
    started_at          timestamptz NOT NULL DEFAULT now(),
    finished_at         timestamptz
);
CREATE INDEX foryou_runs_started_idx ON foryou_runs (started_at DESC);

-- AI collections. profile_id NULL = global (for everyone). Kept 7 days.
CREATE TABLE foryou_collections (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id     uuid REFERENCES profiles (id) ON DELETE CASCADE,
    run_id         uuid REFERENCES foryou_runs (id) ON DELETE SET NULL,
    title_ru       text NOT NULL,
    title_en       text NOT NULL,
    description_ru text NOT NULL DEFAULT '',
    description_en text NOT NULL DEFAULT '',
    model          text NOT NULL,
    generated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX foryou_collections_profile_idx ON foryou_collections (profile_id, generated_at DESC);
CREATE INDEX foryou_collections_generated_idx ON foryou_collections (generated_at);

CREATE TABLE foryou_collection_items (
    collection_id uuid NOT NULL REFERENCES foryou_collections (id) ON DELETE CASCADE,
    position      smallint NOT NULL,
    media_id      uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    PRIMARY KEY (collection_id, media_id)
);

-- AI tokens spent per Moscow day (survives restarts; caps the daily budget).
CREATE TABLE foryou_ai_usage (
    day    date PRIMARY KEY,
    tokens integer NOT NULL DEFAULT 0,
    calls  integer NOT NULL DEFAULT 0
);

-- +goose Down
DROP TABLE foryou_ai_usage;
DROP TABLE foryou_collection_items;
DROP TABLE foryou_collections;
DROP TABLE foryou_runs;
DROP TABLE foryou_feedback;
DROP TABLE foryou_dismissals;
DROP TABLE recs_cache;
DROP TABLE profile_taste;
