-- +goose Up
-- «О моих вкусах» (profile setting taste_note, internal/foryou/prefs.go):
-- a changed note marks the profile's AI collections stale and starts a
-- background regeneration for that profile, at most one per 30 minutes.
-- note_changed_at = last change; regen_at = last note-triggered
-- regeneration start (the rate limit); applied_at = last time collections
-- were generated with the current note (by that regeneration or a run).
CREATE TABLE foryou_note_regen (
    profile_id      uuid PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
    note_changed_at timestamptz NOT NULL DEFAULT now(),
    regen_at        timestamptz,
    applied_at      timestamptz
);

-- Runs started by a taste-note change.
ALTER TABLE foryou_runs DROP CONSTRAINT foryou_runs_trigger_check;
ALTER TABLE foryou_runs ADD CONSTRAINT foryou_runs_trigger_check
    CHECK (trigger IN ('schedule', 'admin', 'startup', 'taste_note'));

-- +goose Down
DELETE FROM foryou_runs WHERE trigger = 'taste_note';
ALTER TABLE foryou_runs DROP CONSTRAINT foryou_runs_trigger_check;
ALTER TABLE foryou_runs ADD CONSTRAINT foryou_runs_trigger_check
    CHECK (trigger IN ('schedule', 'admin', 'startup'));
DROP TABLE foryou_note_regen;
