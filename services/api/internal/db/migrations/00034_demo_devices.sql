-- +goose Up
-- «Демо TV» (/demo_tv): the TV app in a signed-in browser without pairing.
-- A demo device belongs to one browser session (POST /devices/demo): its
-- credentials work only while that session does, expire on their own, and
-- the device never shows up in device lists, remote targets, presence or
-- stats (docs/architecture.md «Demo TV»).
ALTER TABLE devices
    ADD COLUMN demo boolean NOT NULL DEFAULT false,
    ADD COLUMN demo_session_id uuid REFERENCES user_sessions (id) ON DELETE SET NULL;
-- One live demo device per session (reused by every tab of the browser).
CREATE UNIQUE INDEX devices_demo_session_key ON devices (demo_session_id) WHERE demo AND revoked_at IS NULL;

-- Paired TVs keep credentials without expiry (NULL); demo ones expire.
ALTER TABLE device_credentials ADD COLUMN expires_at timestamptz;

-- +goose Down
ALTER TABLE device_credentials DROP COLUMN expires_at;
DROP INDEX devices_demo_session_key;
ALTER TABLE devices DROP COLUMN demo_session_id, DROP COLUMN demo;
