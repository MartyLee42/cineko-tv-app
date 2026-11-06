-- +goose Up
-- Phase 1: accounts, profiles, devices, pairing, audit.
-- All timestamps are timestamptz and written in UTC.

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username      text NOT NULL CHECK (username ~ '^[a-zA-Z0-9_.-]{3,32}$'),
    display_name  text NOT NULL DEFAULT '',
    password_hash text NOT NULL,
    role          text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    disabled_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TABLE user_sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash          bytea NOT NULL UNIQUE,
    csrf_token          text NOT NULL,
    user_agent          text NOT NULL DEFAULT '',
    ip                  text NOT NULL DEFAULT '',
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_seen_at        timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    revoked_at          timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);
CREATE INDEX user_sessions_expiry_idx ON user_sessions (expires_at);

CREATE TABLE api_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    token_hash   bytea NOT NULL UNIQUE,
    token_prefix text NOT NULL,
    scopes       text[] NOT NULL DEFAULT '{}',
    expires_at   timestamptz,
    last_used_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

CREATE TABLE profiles (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
    avatar     text NOT NULL DEFAULT '',
    color      text NOT NULL DEFAULT '#6366f1' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
    pin_hash   text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX profiles_user_name_key ON profiles (user_id, lower(name));

CREATE TABLE profile_preferences (
    profile_id                   uuid PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
    ui_language                  text NOT NULL DEFAULT 'en',
    preferred_audio_languages    text[] NOT NULL DEFAULT '{}',
    preferred_subtitle_languages text[] NOT NULL DEFAULT '{}',
    preferred_resolution         text NOT NULL DEFAULT '',
    max_size_gb                  numeric(6, 1),
    preferred_codecs             text[] NOT NULL DEFAULT '{}',
    updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    platform           text NOT NULL DEFAULT '',
    user_agent         text NOT NULL DEFAULT '',
    default_profile_id uuid REFERENCES profiles (id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at       timestamptz,
    revoked_at         timestamptz
);
CREATE INDEX devices_owner_idx ON devices (owner_user_id);

CREATE TABLE device_credentials (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id    uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX device_credentials_device_idx ON device_credentials (device_id);

-- Explicit sharing of a device with another user.
--   control: may see the device and send it commands.
--   use:     control + the user's profiles appear on the TV.
CREATE TABLE device_permissions (
    device_id          uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    permission         text NOT NULL CHECK (permission IN ('control', 'use')),
    granted_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, user_id)
);
CREATE INDEX device_permissions_user_idx ON device_permissions (user_id);

CREATE TABLE pairing_sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_code           text NOT NULL,
    poll_secret_hash    bytea NOT NULL,
    device_name         text NOT NULL,
    platform            text NOT NULL DEFAULT '',
    user_agent          text NOT NULL DEFAULT '',
    ip                  text NOT NULL DEFAULT '',
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
    approved_by_user_id uuid REFERENCES users (id) ON DELETE CASCADE,
    approved_name       text,
    default_profile_id  uuid REFERENCES profiles (id) ON DELETE SET NULL,
    device_id           uuid REFERENCES devices (id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz NOT NULL,
    decided_at          timestamptz,
    consumed_at         timestamptz
);
-- A code only needs to be unique among requests that can still be approved.
CREATE UNIQUE INDEX pairing_sessions_pending_code_key ON pairing_sessions (user_code) WHERE status = 'pending';
CREATE INDEX pairing_sessions_expiry_idx ON pairing_sessions (expires_at);

CREATE TABLE audit_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    device_id   uuid REFERENCES devices (id) ON DELETE SET NULL,
    action      text NOT NULL,
    target_type text NOT NULL DEFAULT '',
    target_id   text NOT NULL DEFAULT '',
    ip          text NOT NULL DEFAULT '',
    request_id  text NOT NULL DEFAULT '',
    metadata    jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_user_idx ON audit_events (user_id, created_at DESC);
CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);

-- +goose Down
DROP TABLE audit_events;
DROP TABLE pairing_sessions;
DROP TABLE device_permissions;
DROP TABLE device_credentials;
DROP TABLE devices;
DROP TABLE profile_preferences;
DROP TABLE profiles;
DROP TABLE api_tokens;
DROP TABLE user_sessions;
DROP TABLE users;
