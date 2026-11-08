-- +goose Up
-- The profile's interface language becomes a real choice: '' = not chosen
-- (each device keeps its own language), else en | ru | kk. No app ever let
-- a viewer pick it, so the stored 'en' values are the old column default.
-- Kazakh rubric titles («Ваши темы») are written when the profile is Kazakh.
ALTER TABLE profile_preferences ALTER COLUMN ui_language SET DEFAULT '';
UPDATE profile_preferences SET ui_language = '' WHERE ui_language = 'en';
ALTER TABLE foryou_collections
    ADD COLUMN title_kk       text NOT NULL DEFAULT '',
    ADD COLUMN description_kk text NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE foryou_collections DROP COLUMN title_kk, DROP COLUMN description_kk;
UPDATE profile_preferences SET ui_language = 'en' WHERE ui_language NOT IN ('en', 'ru');
ALTER TABLE profile_preferences ALTER COLUMN ui_language SET DEFAULT 'en';
