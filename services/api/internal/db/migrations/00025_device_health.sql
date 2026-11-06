-- +goose Up
-- TV health samples («Состояние»): what a TV's browser can tell about its
-- own load — JS heap, device memory bucket, cores, frame rate, event-loop
-- lag, long tasks and dropped video frames (see DeviceHealthSample in
-- openapi.yaml). Posted by the TV itself every ~10 min and after playback;
-- the API keeps the newest 50 per device.
CREATE TABLE device_health_samples (
    id bigserial PRIMARY KEY,
    device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    at timestamptz NOT NULL DEFAULT now(),
    sample jsonb NOT NULL
);
CREATE INDEX device_health_samples_device_idx ON device_health_samples (device_id, id DESC);

-- +goose Down
DROP TABLE device_health_samples;
