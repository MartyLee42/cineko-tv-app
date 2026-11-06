-- +goose Up
-- Rating imports (internal/imports): a Kinopoisk ratings CSV applied to a
-- profile in the background. One active (queued/running) job per profile.
--
-- rows holds the parsed CSV lines while the job runs (so a restart can
-- resume); it is cleared when the job finishes. import_job_items records
-- each processed line: resume skips them, and progress, counts and the
-- unmatched list are computed from them.

CREATE TABLE import_jobs (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id   uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    source       text NOT NULL CHECK (source IN ('kinopoisk')),
    status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    overwrite    boolean NOT NULL DEFAULT false,
    mark_watched boolean NOT NULL DEFAULT true,
    dry_run      boolean NOT NULL DEFAULT false,
    total        integer NOT NULL DEFAULT 0,
    rows         jsonb,
    error        text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    started_at   timestamptz,
    finished_at  timestamptz
);
CREATE UNIQUE INDEX import_jobs_active_idx ON import_jobs (profile_id) WHERE status IN ('queued', 'running');
CREATE INDEX import_jobs_profile_idx ON import_jobs (profile_id, created_at DESC);

CREATE TABLE import_job_items (
    job_id   uuid NOT NULL REFERENCES import_jobs (id) ON DELETE CASCADE,
    row_no   integer NOT NULL,            -- index into rows (0-based)
    kp_id    integer NOT NULL,
    title    text NOT NULL,
    year     integer,
    -- rated: rating written; skipped: matched, existing rating kept;
    -- matched: matched in a dry run (nothing written); unmatched: see reason.
    result   text NOT NULL CHECK (result IN ('rated', 'skipped', 'matched', 'unmatched')),
    reason   text,
    how      text,                        -- matcher rule (kp_id, exact, year_pm1, year_pm2, year_only, title_only)
    media_id uuid REFERENCES media (id) ON DELETE SET NULL,
    PRIMARY KEY (job_id, row_no)
);

-- +goose Down
DROP TABLE import_job_items;
DROP TABLE import_jobs;
