-- +goose Up
-- Per-subject occurrence counts for the admin Errors filter by user/device:
-- with ?user_id= a group shows that user's own count, first and last seen.
-- Existing rows are backfilled from the samples still kept (at least 1).
ALTER TABLE client_error_affected
    ADD COLUMN count      bigint NOT NULL DEFAULT 1,
    ADD COLUMN first_seen timestamptz;

UPDATE client_error_affected a SET
    count = greatest(1, coalesce((
        SELECT sum(s.count) FROM client_error_samples s
        WHERE s.group_id = a.group_id
          AND CASE a.kind WHEN 'u' THEN s.user_id ELSE s.device_id END = a.subject_id), 0)),
    first_seen = least(a.last_seen, (
        SELECT min(s.occurred_at) FROM client_error_samples s
        WHERE s.group_id = a.group_id
          AND CASE a.kind WHEN 'u' THEN s.user_id ELSE s.device_id END = a.subject_id));

-- A TV's errors belong to its owner: add the owner where only the device was recorded.
INSERT INTO client_error_affected (group_id, kind, subject_id, last_seen, count, first_seen)
SELECT a.group_id, 'u', d.owner_user_id, a.last_seen, a.count, a.first_seen
FROM client_error_affected a JOIN devices d ON d.id = a.subject_id
WHERE a.kind = 'd'
ON CONFLICT (group_id, kind, subject_id) DO NOTHING;

UPDATE client_error_samples s SET user_id = d.owner_user_id
FROM devices d WHERE d.id = s.device_id AND s.user_id IS NULL;

ALTER TABLE client_error_affected
    ALTER COLUMN count DROP DEFAULT,
    ALTER COLUMN first_seen SET DEFAULT now(),
    ALTER COLUMN first_seen SET NOT NULL;

-- +goose Down
ALTER TABLE client_error_affected DROP COLUMN count, DROP COLUMN first_seen;
