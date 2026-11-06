-- +goose Up
-- «Обновить подборки ИИ» (POST /foryou/regenerate, internal/foryou/regen.go):
-- one manual AI regeneration per profile per Moscow day (admins unlimited),
-- on top of the daily run. Counted here; the run itself is a foryou_runs
-- row with trigger 'user'.
CREATE TABLE foryou_regen_usage (
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    day        date NOT NULL,
    used       integer NOT NULL DEFAULT 0,
    PRIMARY KEY (profile_id, day)
);

ALTER TABLE foryou_runs DROP CONSTRAINT foryou_runs_trigger_check;
ALTER TABLE foryou_runs ADD CONSTRAINT foryou_runs_trigger_check
    CHECK (trigger IN ('schedule', 'admin', 'startup', 'taste_note', 'user'));

-- +goose Down
DELETE FROM foryou_runs WHERE trigger = 'user';
ALTER TABLE foryou_runs DROP CONSTRAINT foryou_runs_trigger_check;
ALTER TABLE foryou_runs ADD CONSTRAINT foryou_runs_trigger_check
    CHECK (trigger IN ('schedule', 'admin', 'startup', 'taste_note'));
DROP TABLE foryou_regen_usage;
