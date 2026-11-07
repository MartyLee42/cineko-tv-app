-- +goose Up
-- Settings per device class and per TV (docs/architecture.md «Device
-- settings»). profile_settings stays the base layer: nothing is copied, so
-- every device keeps showing what it showed until a setting is changed on
-- it. The layers hold only the per-device keys a client set
-- (profiles.LayeredKeys); the API merges base → class / TV.

-- Browsers: «Компьютер» (desktop) and «Телефон» (mobile), per profile.
CREATE TABLE profile_class_settings (
    profile_id   uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    device_class text NOT NULL CHECK (device_class IN ('desktop', 'mobile')),
    settings     jsonb NOT NULL DEFAULT '{}',
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, device_class)
);

-- One TV, per profile (each TV of a household can look different).
CREATE TABLE profile_device_settings (
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    device_id  uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    settings   jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, device_id)
);
CREATE INDEX profile_device_settings_device_idx ON profile_device_settings (device_id);

-- The TV's own options for every profile (screensaver, UI sounds, intro,
-- calm motion, language…): until now in the TV's localStorage only; the TV
-- keeps it as a cache and seeds this from it once.
ALTER TABLE devices
    ADD COLUMN settings jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN settings_updated_at timestamptz;

-- +goose Down
ALTER TABLE devices DROP COLUMN settings, DROP COLUMN settings_updated_at;
DROP TABLE profile_device_settings;
DROP TABLE profile_class_settings;
