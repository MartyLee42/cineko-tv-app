-- +goose Up
-- When each profile last opened its recommendations (internal/foryou,
-- GET /foryou/rows). The daily run skips the AI work for profiles idle for
-- more than a day; their first visit after that rebuilds it (a foryou_runs
-- row with trigger 'return'). Existing profiles start as just seen.
CREATE TABLE foryou_seen (
    profile_id uuid PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
    seen_at    timestamptz NOT NULL
);
INSERT INTO foryou_seen (profile_id, seen_at) SELECT id, now() FROM profiles;

ALTER TABLE foryou_runs DROP CONSTRAINT foryou_runs_trigger_check;
ALTER TABLE foryou_runs ADD CONSTRAINT foryou_runs_trigger_check
    CHECK (trigger IN ('schedule', 'admin', 'startup', 'taste_note', 'user', 'return'));

-- +goose Down
DELETE FROM foryou_runs WHERE trigger = 'return';
ALTER TABLE foryou_runs DROP CONSTRAINT foryou_runs_trigger_check;
ALTER TABLE foryou_runs ADD CONSTRAINT foryou_runs_trigger_check
    CHECK (trigger IN ('schedule', 'admin', 'startup', 'taste_note', 'user'));
DROP TABLE foryou_seen;
