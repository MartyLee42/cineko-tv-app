-- +goose Up
-- «Цитаты» and «Факты» of a title (internal/trivia): the finished answer per
-- language, cached until expires_at (30 days for found data, shorter for
-- misses and AI stand-ins so real sources win once they appear).
CREATE TABLE media_trivia (
    media_id   uuid        NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    kind       text        NOT NULL CHECK (kind IN ('quotes', 'facts')),
    lang       text        NOT NULL,
    data       jsonb       NOT NULL,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (media_id, kind, lang)
);

-- +goose Down
DROP TABLE media_trivia;
