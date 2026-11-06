-- +goose Up
-- Phase 7: IPTV (live TV). Playlists are household-wide (admin managed);
-- favorites, order, numbers and hidden channels are per profile.

CREATE TABLE iptv_playlists (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind           text NOT NULL CHECK (kind IN ('iptv_org_country', 'm3u_url', 'm3u_file')),
    name           text NOT NULL,
    url            text,                 -- m3u_url
    country        text,                 -- iptv_org_country: iptv-org code (ru, kz, ua, by, int…)
    content        text,                 -- m3u_file: the uploaded playlist (server-only)
    epg_url        text,                 -- optional XMLTV (.xml / .xml.gz); null = default for the kind
    header_epg_url text,                 -- x-tvg-url / url-tvg from the playlist header (last refresh)
    enabled        boolean NOT NULL DEFAULT true,
    user_agent     text,
    referrer       text,
    via_proxy      boolean NOT NULL DEFAULT false,
    position       integer NOT NULL DEFAULT 0,
    refresh_status text NOT NULL DEFAULT 'never' CHECK (refresh_status IN ('never', 'running', 'ok', 'error')),
    refresh_error  text,
    refreshed_at   timestamptz,
    fetched_via    text,                 -- direct | proxy (last successful fetch)
    epg_status     text NOT NULL DEFAULT 'never' CHECK (epg_status IN ('never', 'running', 'ok', 'error', 'none')),
    epg_error      text,
    epg_refreshed_at timestamptz,
    created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'iptv_org_country' AND country IS NOT NULL)
        OR (kind = 'm3u_url' AND url IS NOT NULL)
        OR kind = 'm3u_file')
);

CREATE TABLE iptv_channels (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    playlist_id   uuid NOT NULL REFERENCES iptv_playlists (id) ON DELETE CASCADE,
    key           text NOT NULL,         -- dedupe key: "id:<tvg-id>" or "nu:<normalized name>|<url>"
    position      integer NOT NULL,      -- order inside the playlist
    tvg_id        text,
    name          text NOT NULL,
    logo          text,                  -- upstream logo URL (served via /iptv/logos/{id})
    group_title   text,
    stream_url    text NOT NULL,         -- server-only
    user_agent    text,
    referrer      text,
    alt_names     text[] NOT NULL DEFAULT '{}',
    epg_source    text,                  -- iptv_epg_sources.id the channel is matched in
    epg_channel   text,                  -- XMLTV channel id
    stream_format text CHECK (stream_format IN ('hls', 'ts')),
    fail_count    integer NOT NULL DEFAULT 0,
    offline       boolean NOT NULL DEFAULT false,
    checked_at    timestamptz,
    active        boolean NOT NULL DEFAULT true, -- false = gone from the playlist (kept 30 days for prefs)
    seen_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (playlist_id, key)
);
CREATE INDEX iptv_channels_epg_idx ON iptv_channels (epg_source, epg_channel);

CREATE TABLE iptv_epg_sources (
    id               text PRIMARY KEY,   -- hash of the URL
    url              text NOT NULL,
    status           text NOT NULL DEFAULT 'never',
    error            text,
    fetched_at       timestamptz,
    channel_count    integer NOT NULL DEFAULT 0, -- channels in the XMLTV file
    programme_count  integer NOT NULL DEFAULT 0  -- programmes stored (matched channels, -1…+2 days)
);

CREATE TABLE iptv_programmes (
    epg_source  text NOT NULL REFERENCES iptv_epg_sources (id) ON DELETE CASCADE,
    epg_channel text NOT NULL,
    start_at    timestamptz NOT NULL,
    stop_at     timestamptz NOT NULL,
    title       text NOT NULL,
    description text,
    category    text,
    PRIMARY KEY (epg_source, epg_channel, start_at)
);
CREATE INDEX iptv_programmes_stop_idx ON iptv_programmes (stop_at);

CREATE TABLE iptv_profile_channels (
    profile_id uuid NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES iptv_channels (id) ON DELETE CASCADE,
    favorite   boolean NOT NULL DEFAULT false,
    hidden     boolean NOT NULL DEFAULT false,
    number     integer CHECK (number BETWEEN 1 AND 9999),
    position   integer,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, channel_id)
);

CREATE TABLE iptv_profile_state (
    profile_id      uuid PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
    last_channel_id uuid REFERENCES iptv_channels (id) ON DELETE SET NULL,
    last_watched_at timestamptz
);

-- +goose Down
DROP TABLE iptv_profile_state;
DROP TABLE iptv_profile_channels;
DROP TABLE iptv_programmes;
DROP TABLE iptv_epg_sources;
DROP TABLE iptv_channels;
DROP TABLE iptv_playlists;
