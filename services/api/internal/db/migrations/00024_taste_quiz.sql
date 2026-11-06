-- +goose Up
-- «Давайте определим ваш вкус»: a per-profile taste quiz. The questionnaire
-- answers (genres, eras, origins, mood…) steer the taste affinities and the
-- AI summary; the titles answered in the quiz are kept so the next batch
-- never repeats them (ratings / list / dismissals go to their own tables).
CREATE TABLE taste_quiz (
    profile_id   uuid PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
    answers      jsonb NOT NULL DEFAULT '{}',
    started_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    dismissed_at timestamptz
);

CREATE TABLE taste_quiz_titles (
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    media_id   uuid NOT NULL REFERENCES media (id) ON DELETE CASCADE,
    answer     text NOT NULL CHECK (answer IN ('rated', 'unseen', 'not_interested', 'want')),
    rating     smallint CHECK (rating BETWEEN 1 AND 10),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, media_id)
);

-- +goose Down
DROP TABLE taste_quiz_titles;
DROP TABLE taste_quiz;
