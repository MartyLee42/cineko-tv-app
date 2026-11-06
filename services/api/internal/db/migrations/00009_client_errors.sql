-- +goose Up
-- Client error logging (internal/clientlog). Web/TV clients batch their
-- errors to POST /client-errors; the API records its own 5xx responses as
-- app 'api'. Identical errors share a group (fingerprint = app + kind +
-- normalized message + top stack frame) that counts up; only the last 20
-- samples per group are kept. Retention: samples 30 days, groups 60 days
-- after they were last seen (RunCleanup). Messages, stacks and URLs are
-- scrubbed of secrets before they are stored.

CREATE TABLE client_error_groups (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint  text NOT NULL UNIQUE,
    app          text NOT NULL CHECK (app IN ('web', 'tv', 'api')),
    kind         text NOT NULL CHECK (kind IN ('error', 'unhandledrejection', 'react', 'api', 'player', 'console')),
    message      text NOT NULL,
    top_frame    text NOT NULL DEFAULT '',
    component    text NOT NULL DEFAULT '',
    count        bigint NOT NULL DEFAULT 0,
    first_seen   timestamptz NOT NULL DEFAULT now(),
    last_seen    timestamptz NOT NULL DEFAULT now(),
    last_release text NOT NULL DEFAULT '',
    last_url     text NOT NULL DEFAULT '',
    resolved_at  timestamptz,
    resolved_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    -- Set when an event arrives for a resolved group (the group reopens).
    regressed_at timestamptz
);
CREATE INDEX client_error_groups_last_seen_idx ON client_error_groups (last_seen DESC);

CREATE TABLE client_error_samples (
    id           bigserial PRIMARY KEY,
    group_id     uuid NOT NULL REFERENCES client_error_groups (id) ON DELETE CASCADE,
    occurred_at  timestamptz NOT NULL,
    received_at  timestamptz NOT NULL DEFAULT now(),
    count        integer NOT NULL DEFAULT 1,
    user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
    device_id    uuid REFERENCES devices (id) ON DELETE SET NULL,
    profile_id   uuid REFERENCES profiles (id) ON DELETE SET NULL,
    message      text NOT NULL,
    stack        text NOT NULL DEFAULT '',
    url          text NOT NULL DEFAULT '',
    component    text NOT NULL DEFAULT '',
    release      text NOT NULL DEFAULT '',
    user_agent   text NOT NULL DEFAULT '',
    device_model text NOT NULL DEFAULT '',
    extra        jsonb,
    request_id   text NOT NULL DEFAULT ''
);
CREATE INDEX client_error_samples_group_idx ON client_error_samples (group_id, id DESC);
CREATE INDEX client_error_samples_received_idx ON client_error_samples (received_at);

-- Who hit a group (kind 'u' = user, 'd' = device): affected counts and the
-- admin user/device filters. Survives sample pruning.
CREATE TABLE client_error_affected (
    group_id   uuid NOT NULL REFERENCES client_error_groups (id) ON DELETE CASCADE,
    kind       char(1) NOT NULL CHECK (kind IN ('u', 'd')),
    subject_id uuid NOT NULL,
    last_seen  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, kind, subject_id)
);
CREATE INDEX client_error_affected_subject_idx ON client_error_affected (kind, subject_id);

-- +goose Down
DROP TABLE client_error_affected;
DROP TABLE client_error_samples;
DROP TABLE client_error_groups;
