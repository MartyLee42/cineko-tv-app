-- +goose Up
-- «Спросить ИИ» (POST /foryou/ask, internal/foryou/ask.go): the last ~20
-- asks per profile so answers can be reopened, and a per-account daily
-- counter for the ask limit. Only the prompt, the short answer, follow-up
-- suggestions and the resolved titles (media id + one-line «почему») are
-- kept — never the raw model output.
CREATE TABLE foryou_asks (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id      uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    prompt          text NOT NULL,
    lang            text NOT NULL DEFAULT 'en',
    kind            text NOT NULL DEFAULT 'any' CHECK (kind IN ('movie', 'series', 'any')),
    include_watched boolean NOT NULL DEFAULT false,
    answer          text NOT NULL DEFAULT '',
    -- [{"media_id": uuid, "why": text}] in the model's order
    items           jsonb NOT NULL DEFAULT '[]',
    followups       jsonb NOT NULL DEFAULT '[]',
    refused         boolean NOT NULL DEFAULT false,
    tokens          integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX foryou_asks_profile_idx ON foryou_asks (profile_id, created_at DESC);

-- Asks per account per Moscow day (FORYOU_ASK_DAILY_PER_USER).
CREATE TABLE foryou_ask_usage (
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    day     date NOT NULL,
    asks    integer NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
);

-- +goose Down
DROP TABLE foryou_ask_usage;
DROP TABLE foryou_asks;
