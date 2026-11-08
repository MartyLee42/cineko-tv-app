-- +goose Up
-- Outage alerts (internal/alerts): incidents the API's monitor or the host
-- scripts (watchdog, image updater) report. One open incident per kind;
-- admins get a Cineko message (and Web Push) on open, reminders, recovery.
CREATE TABLE incidents (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind             text NOT NULL,
    cause            text NOT NULL DEFAULT '',
    detail           text NOT NULL DEFAULT '',
    source           text NOT NULL CHECK (source IN ('monitor', 'host')),
    notes            text[] NOT NULL DEFAULT '{}', -- actions taken (e.g. companion_restarted)
    opened_at        timestamptz NOT NULL DEFAULT now(),
    closed_at        timestamptz,
    silent_close     boolean NOT NULL DEFAULT false, -- closed without a recovery notice (stale / event)
    last_notified_at timestamptz NOT NULL DEFAULT now(),
    reminders        int NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX incidents_open_kind_key ON incidents (kind) WHERE closed_at IS NULL;
CREATE INDEX incidents_opened_idx ON incidents (opened_at DESC);

-- Web Push subscriptions of admins' browsers («Уведомления о сбоях»).
CREATE TABLE push_subscriptions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint   text NOT NULL UNIQUE,
    p256dh     text NOT NULL,
    auth       text NOT NULL,
    locale     text NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru', 'en', 'kk')),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_ok_at timestamptz,
    failures   int NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- The server's VAPID key pair (generated on first use; one row).
CREATE TABLE push_vapid_keys (
    id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    private_key text NOT NULL, -- base64url P-256 scalar
    public_key  text NOT NULL, -- base64url uncompressed point
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE push_vapid_keys;
DROP TABLE push_subscriptions;
DROP TABLE incidents;
