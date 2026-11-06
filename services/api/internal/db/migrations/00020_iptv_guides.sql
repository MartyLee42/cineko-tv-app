-- +goose Up
-- IPTV: several guides per playlist. Each guide remembers which channels it
-- matched (only XMLTV channels with programmes in the kept window); the
-- channel's epg_source/epg_channel link points at the first guide in its
-- playlist's order that has a match.
CREATE TABLE iptv_epg_matches (
    epg_source  text NOT NULL REFERENCES iptv_epg_sources (id) ON DELETE CASCADE,
    channel_id  uuid NOT NULL REFERENCES iptv_channels (id) ON DELETE CASCADE,
    epg_channel text NOT NULL,
    PRIMARY KEY (epg_source, channel_id)
);
CREATE INDEX iptv_epg_matches_channel_idx ON iptv_epg_matches (channel_id);
ALTER TABLE iptv_epg_sources ADD COLUMN bytes bigint NOT NULL DEFAULT 0;     -- last download (compressed)
ALTER TABLE iptv_epg_sources ADD COLUMN took_ms integer NOT NULL DEFAULT 0;  -- download + parse
ALTER TABLE iptv_epg_sources ADD COLUMN fetched_via text;                    -- direct | proxy
ALTER TABLE iptv_epg_sources ADD COLUMN matched integer NOT NULL DEFAULT 0;

-- Existing single-guide links become matches so nothing disappears before
-- the next refresh.
INSERT INTO iptv_epg_matches (epg_source, channel_id, epg_channel)
SELECT c.epg_source, c.id, c.epg_channel FROM iptv_channels c
JOIN iptv_epg_sources s ON s.id = c.epg_source
WHERE c.epg_channel IS NOT NULL
ON CONFLICT DO NOTHING;

-- +goose Down
ALTER TABLE iptv_epg_sources DROP COLUMN matched;
ALTER TABLE iptv_epg_sources DROP COLUMN fetched_via;
ALTER TABLE iptv_epg_sources DROP COLUMN took_ms;
ALTER TABLE iptv_epg_sources DROP COLUMN bytes;
DROP TABLE iptv_epg_matches;
