-- +goose Up
-- Server-wide app settings set by admins, one row per key (internal/appsettings).
-- seasonal_effects: {"enabled": bool} — the global switch of the holiday
-- animations (no row = enabled).
CREATE TABLE app_settings (
    key        text PRIMARY KEY CHECK (key ~ '^[a-z0-9_]{1,64}$'),
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES users (id) ON DELETE SET NULL
);

-- +goose Down
DROP TABLE app_settings;
