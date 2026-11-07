package iptv

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/livecheck"
)

var errNotFound = errors.New("not found")

type store struct{ q *pgxpool.Pool }

// ---------------------------------------------------------------- playlists

type playlistRow struct {
	ID, Kind, Name                            string
	URL, Country, EPGURL, UserAgent, Referrer *string
	Enabled, ViaProxy, HasContent             bool
	Position                                  int
	RefreshStatus, EPGStatus                  string
	RefreshError, EPGError, FetchedVia        *string
	RefreshedAt, EPGRefreshedAt               *time.Time
	CreatedAt, UpdatedAt                      time.Time
}

const playlistCols = `id, kind, name, url, country, epg_url, user_agent, referrer, enabled, via_proxy, content IS NOT NULL,
	position, refresh_status, epg_status, refresh_error, epg_error, fetched_via, refreshed_at, epg_refreshed_at, created_at, updated_at`

func scanPlaylist(r pgx.Row) (*playlistRow, error) {
	var p playlistRow
	err := r.Scan(&p.ID, &p.Kind, &p.Name, &p.URL, &p.Country, &p.EPGURL, &p.UserAgent, &p.Referrer, &p.Enabled, &p.ViaProxy,
		&p.HasContent, &p.Position, &p.RefreshStatus, &p.EPGStatus, &p.RefreshError, &p.EPGError, &p.FetchedVia,
		&p.RefreshedAt, &p.EPGRefreshedAt, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	return &p, err
}

func (st *store) playlists(ctx context.Context, enabledOnly bool) ([]*playlistRow, error) {
	rows, err := st.q.Query(ctx, `SELECT `+playlistCols+` FROM iptv_playlists
		WHERE $1 = false OR enabled ORDER BY position, created_at`, enabledOnly)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*playlistRow
	for rows.Next() {
		p, err := scanPlaylist(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (st *store) playlist(ctx context.Context, id string) (*playlistRow, error) {
	return scanPlaylist(st.q.QueryRow(ctx, `SELECT `+playlistCols+` FROM iptv_playlists WHERE id = $1`, id))
}

func (st *store) content(ctx context.Context, id string) (string, error) {
	var s *string
	err := st.q.QueryRow(ctx, `SELECT content FROM iptv_playlists WHERE id = $1`, id).Scan(&s)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", errNotFound
	}
	if s == nil {
		return "", err
	}
	return *s, err
}

func (st *store) setStatus(ctx context.Context, id, status string, errMsg *string, via string) error {
	_, err := st.q.Exec(ctx, `UPDATE iptv_playlists SET refresh_status = $2, refresh_error = $3,
		refreshed_at = CASE WHEN $2 IN ('ok', 'error') THEN now() ELSE refreshed_at END,
		fetched_via = CASE WHEN $4 = '' THEN fetched_via ELSE $4 END WHERE id = $1`, id, status, errMsg, via)
	return err
}

func (st *store) setEPGStatus(ctx context.Context, ids []string, status string, errMsg *string) error {
	_, err := st.q.Exec(ctx, `UPDATE iptv_playlists SET epg_status = $2, epg_error = $3,
		epg_refreshed_at = CASE WHEN $2 IN ('ok', 'error', 'none') THEN now() ELSE epg_refreshed_at END WHERE id = ANY($1)`,
		ids, status, errMsg)
	return err
}

// ---------------------------------------------------------------- channels

// upsertChannels stores a refreshed playlist: entries are upserted by
// (playlist, key) so ids, favorites and numbers survive refreshes; channels
// gone from the playlist become inactive (deleted after 30 days).
func (st *store) upsertChannels(ctx context.Context, playlistID string, entries []Entry, alt map[string][]string) (int, error) {
	tx, err := st.q.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var start time.Time
	if err := tx.QueryRow(ctx, `SELECT now()`).Scan(&start); err != nil {
		return 0, err
	}
	mirrors := playlistMirrors(entries)
	seen := map[string]bool{}
	b := &pgx.Batch{}
	n := 0
	for i, e := range entries {
		k := dedupeKey(e)
		if seen[k] {
			continue // duplicate inside the playlist: first wins (its URL is a mirror)
		}
		seen[k] = true
		mj, _ := json.Marshal(mirrors[k])
		if mirrors[k] == nil {
			mj = []byte("[]")
		}
		// Match names besides the display name: the playlist's tvg-name
		// (providers often put the Cyrillic name there), then iptv-org's.
		names := []string{}
		if e.TvgName != "" && e.TvgName != e.Name {
			names = append(names, e.TvgName)
		}
		for _, n := range alt[baseTvgID(e.TvgID)] {
			names = appendUnique(names, n)
		}
		b.Queue(`INSERT INTO iptv_channels (playlist_id, key, position, tvg_id, name, logo, group_title, stream_url,
				user_agent, referrer, alt_names, mirrors, active, seen_at)
			VALUES ($1, $2, $3, NULLIF($4, ''), $5, NULLIF($6, ''), NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), $11, $12, true, now())
			ON CONFLICT (playlist_id, key) DO UPDATE SET position = EXCLUDED.position, tvg_id = EXCLUDED.tvg_id,
				name = EXCLUDED.name, logo = EXCLUDED.logo, group_title = EXCLUDED.group_title,
				stream_format = CASE WHEN iptv_channels.stream_url = EXCLUDED.stream_url THEN iptv_channels.stream_format END,
				fail_count = CASE WHEN iptv_channels.stream_url = EXCLUDED.stream_url THEN iptv_channels.fail_count ELSE 0 END,
				offline = CASE WHEN iptv_channels.stream_url = EXCLUDED.stream_url THEN iptv_channels.offline ELSE false END,
				health = CASE WHEN iptv_channels.stream_url = EXCLUDED.stream_url THEN iptv_channels.health END,
				health_cause = CASE WHEN iptv_channels.stream_url = EXCLUDED.stream_url THEN iptv_channels.health_cause END,
				health_checked_at = CASE WHEN iptv_channels.stream_url = EXCLUDED.stream_url THEN iptv_channels.health_checked_at END,
				mirrors = EXCLUDED.mirrors,
				stream_url = EXCLUDED.stream_url, user_agent = EXCLUDED.user_agent, referrer = EXCLUDED.referrer,
				alt_names = CASE WHEN cardinality(EXCLUDED.alt_names) > 0 THEN EXCLUDED.alt_names ELSE iptv_channels.alt_names END,
				active = true, seen_at = now()`,
			playlistID, k, i, e.TvgID, e.Name, e.Logo, e.Group, e.URL, e.UserAgent, e.Referrer, names, string(mj))
		n++
	}
	if err := tx.SendBatch(ctx, b).Close(); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE iptv_channels SET active = false WHERE playlist_id = $1 AND seen_at < $2`, playlistID, start); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM iptv_channels WHERE playlist_id = $1 AND NOT active AND seen_at < now() - interval '30 days'`, playlistID); err != nil {
		return 0, err
	}
	return n, tx.Commit(ctx)
}

// listRow is a channel joined with one profile's preferences.
type listRow struct {
	ID, PlaylistID, Key, Name string
	TvgID, Logo, Group        *string
	AltNames                  []string
	EPGSource, EPGChannel     *string
	Format, Health            *string
	Offline                   bool
	Favorite, Hidden          bool
	Number, Pos               *int
}

// channels returns the active channels of enabled playlists (optionally
// only the given playlists) in default order, with the profile's prefs.
func (st *store) channels(ctx context.Context, profileID *string, playlistIDs []string) ([]*listRow, error) {
	rows, err := st.q.Query(ctx, `SELECT c.id, c.playlist_id, c.key, c.name, c.tvg_id, c.logo, c.group_title, c.alt_names,
			c.epg_source, c.epg_channel, c.stream_format, c.health, c.offline,
			COALESCE(pc.favorite, false), COALESCE(pc.hidden, false), pc.number, pc.position
		FROM iptv_channels c
		JOIN iptv_playlists p ON p.id = c.playlist_id AND p.enabled
		LEFT JOIN iptv_profile_channels pc ON pc.channel_id = c.id AND pc.profile_id = $1
		WHERE c.active AND ($2::uuid[] IS NULL OR c.playlist_id = ANY($2))
		ORDER BY p.position, p.created_at, c.position`, profileID, playlistIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*listRow
	for rows.Next() {
		var r listRow
		if err := rows.Scan(&r.ID, &r.PlaylistID, &r.Key, &r.Name, &r.TvgID, &r.Logo, &r.Group, &r.AltNames,
			&r.EPGSource, &r.EPGChannel, &r.Format, &r.Health, &r.Offline, &r.Favorite, &r.Hidden, &r.Number, &r.Pos); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

// streamRow is what playback needs for one channel.
type streamRow struct {
	ID, Name, URL                string
	TvgID                        *string
	UserAgent, Referrer, Format  *string
	PUserAgent, PReferrer        *string
	Logo                         *string
	ViaProxy, Active, PlaylistOn bool
	Mirrors                      []mirror
	VideoCodec, AudioCodec       *string
}

// mirror is another URL of the same channel (a duplicate tvg-id).
type mirror struct {
	URL       string `json:"url"`
	UserAgent string `json:"ua,omitempty"`
	Referrer  string `json:"ref,omitempty"`
}

// maxMirrors caps the alternatives kept / tried per channel.
const maxMirrors = 4

// playlistMirrors collects, per dedupe key, the URLs of a playlist's later
// duplicates (iptv-org lists a channel several times when it has several
// streams).
func playlistMirrors(entries []Entry) map[string][]mirror {
	first := map[string]string{}
	out := map[string][]mirror{}
	for _, e := range entries {
		k := dedupeKey(e)
		u, ok := first[k]
		if !ok {
			first[k] = e.URL
			continue
		}
		if e.URL == u || len(out[k]) >= maxMirrors || containsMirror(out[k], e.URL) {
			continue
		}
		out[k] = append(out[k], mirror{URL: e.URL, UserAgent: e.UserAgent, Referrer: e.Referrer})
	}
	return out
}

func containsMirror(ms []mirror, u string) bool {
	for _, m := range ms {
		if m.URL == u {
			return true
		}
	}
	return false
}

func (st *store) stream(ctx context.Context, id string) (*streamRow, error) {
	var r streamRow
	var mj []byte
	err := st.q.QueryRow(ctx, `SELECT c.id, c.name, c.stream_url, c.tvg_id, c.user_agent, c.referrer, c.stream_format,
			p.user_agent, p.referrer, c.logo, p.via_proxy, c.active, p.enabled, c.mirrors, c.video_codec, c.audio_codec
		FROM iptv_channels c JOIN iptv_playlists p ON p.id = c.playlist_id WHERE c.id = $1`, id).
		Scan(&r.ID, &r.Name, &r.URL, &r.TvgID, &r.UserAgent, &r.Referrer, &r.Format, &r.PUserAgent, &r.PReferrer, &r.Logo,
			&r.ViaProxy, &r.Active, &r.PlaylistOn, &mj, &r.VideoCodec, &r.AudioCodec)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(mj, &r.Mirrors)
	return &r, nil
}

// sameChannel returns the streams of the same tvg-id in other enabled
// playlists (cross-playlist mirrors), working ones first.
func (st *store) sameChannel(ctx context.Context, id, tvgID string) ([]mirror, error) {
	rows, err := st.q.Query(ctx, `SELECT c.stream_url, COALESCE(c.user_agent, p.user_agent, ''), COALESCE(c.referrer, p.referrer, '')
		FROM iptv_channels c JOIN iptv_playlists p ON p.id = c.playlist_id AND p.enabled
		WHERE c.active AND c.id <> $1 AND lower(c.tvg_id) = lower($2)
		ORDER BY c.offline, p.position, p.created_at LIMIT $3`, id, tvgID, maxMirrors)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []mirror
	for rows.Next() {
		var m mirror
		if err := rows.Scan(&m.URL, &m.UserAgent, &m.Referrer); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// failThreshold: consecutive failures before a channel shows offline.
const failThreshold = 3

func (st *store) report(ctx context.Context, id string, ok bool, format string) error {
	if ok {
		_, err := st.q.Exec(ctx, `UPDATE iptv_channels SET fail_count = 0, offline = false, checked_at = now(),
			health = CASE WHEN health IN ('dead', 'geo', 'timeout') THEN 'ok' ELSE health END,
			stream_format = COALESCE(NULLIF($2, ''), stream_format) WHERE id = $1`, id, format)
		return err
	}
	_, err := st.q.Exec(ctx, `UPDATE iptv_channels SET fail_count = fail_count + 1, offline = fail_count + 1 >= $2,
		checked_at = now() WHERE id = $1`, id, failThreshold)
	return err
}

// recordHealth stores a health check verdict. Definite failures (dead,
// geo) mark the channel offline at once; a timeout counts as one failure;
// ok / codec heal it. A detected format is kept.
func (st *store) recordHealth(ctx context.Context, id string, r livecheck.Result) error {
	format := ""
	if r.Format == "hls" || r.Format == "ts" {
		format = r.Format
	}
	_, err := st.q.Exec(ctx, `UPDATE iptv_channels SET health = $2, health_cause = $3, health_checked_at = now(), checked_at = now(),
			video_codec = COALESCE(NULLIF($4, ''), CASE WHEN $2 IN ('ok', 'codec') THEN video_codec END),
			audio_codec = COALESCE(NULLIF($5, ''), CASE WHEN $2 IN ('ok', 'codec') THEN audio_codec END),
			stream_format = COALESCE(NULLIF($6, ''), stream_format),
			fail_count = CASE WHEN $2 IN ('ok', 'codec') THEN 0 ELSE fail_count + 1 END,
			offline = CASE WHEN $2 IN ('ok', 'codec') THEN false WHEN $2 IN ('dead', 'geo') THEN true ELSE fail_count + 1 >= $7 END
		WHERE id = $1`, id, r.Health, r.Cause, r.Video, r.Audio, format, failThreshold)
	return err
}

// ---------------------------------------------------------------- EPG

type progRow struct {
	Source, Channel string
	Start, Stop     time.Time
	Title           string
	Desc, Category  *string
}

// programmes returns programmes overlapping [from, to) for the given
// (source, channel) pairs, in start order.
func (st *store) programmes(ctx context.Context, sources, chans []string, from, to time.Time) ([]progRow, error) {
	if len(sources) == 0 {
		return nil, nil
	}
	rows, err := st.q.Query(ctx, `SELECT p.epg_source, p.epg_channel, p.start_at, p.stop_at, p.title, p.description, p.category
		FROM iptv_programmes p JOIN unnest($1::text[], $2::text[]) AS k(s, c) ON p.epg_source = k.s AND p.epg_channel = k.c
		WHERE p.stop_at > $3 AND p.start_at < $4 ORDER BY p.epg_source, p.epg_channel, p.start_at`, sources, chans, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []progRow
	for rows.Next() {
		var r progRow
		if err := rows.Scan(&r.Source, &r.Channel, &r.Start, &r.Stop, &r.Title, &r.Desc, &r.Category); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// nowNext returns up to two programmes per channel (the one on air or
// next, and the one after) ending after now.
func (st *store) nowNext(ctx context.Context, sources, chans []string, now time.Time) ([]progRow, error) {
	if len(sources) == 0 {
		return nil, nil
	}
	rows, err := st.q.Query(ctx, `SELECT epg_source, epg_channel, start_at, stop_at, title, description, category FROM (
			SELECT p.*, row_number() OVER (PARTITION BY p.epg_source, p.epg_channel ORDER BY p.start_at) AS rn
			FROM iptv_programmes p JOIN unnest($1::text[], $2::text[]) AS k(s, c) ON p.epg_source = k.s AND p.epg_channel = k.c
			WHERE p.stop_at > $3 AND p.start_at < $3 + interval '1 day') t
		WHERE rn <= 2 ORDER BY epg_source, epg_channel, start_at`, sources, chans, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []progRow
	for rows.Next() {
		var r progRow
		if err := rows.Scan(&r.Source, &r.Channel, &r.Start, &r.Stop, &r.Title, &r.Desc, &r.Category); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- stats

type stats struct {
	Channels       int `json:"channels"`
	Offline        int `json:"offline"`
	EPGMatched     int `json:"epg_matched"`
	WithProgrammes int `json:"with_programmes"`
}

// stats per playlist ("" = totals over enabled playlists).
func (st *store) stats(ctx context.Context) (map[string]stats, error) {
	rows, err := st.q.Query(ctx, `SELECT c.playlist_id::text, count(*), count(*) FILTER (WHERE c.offline),
			count(*) FILTER (WHERE c.epg_channel IS NOT NULL),
			count(*) FILTER (WHERE EXISTS (SELECT 1 FROM iptv_programmes p WHERE p.epg_source = c.epg_source
				AND p.epg_channel = c.epg_channel AND p.stop_at > now())),
			bool_and(p.enabled)
		FROM iptv_channels c JOIN iptv_playlists p ON p.id = c.playlist_id WHERE c.active GROUP BY c.playlist_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]stats{}
	var tot stats
	for rows.Next() {
		var id string
		var s stats
		var enabled bool
		if err := rows.Scan(&id, &s.Channels, &s.Offline, &s.EPGMatched, &s.WithProgrammes, &enabled); err != nil {
			return nil, err
		}
		out[id] = s
		if enabled {
			tot.Channels += s.Channels
			tot.Offline += s.Offline
			tot.EPGMatched += s.EPGMatched
			tot.WithProgrammes += s.WithProgrammes
		}
	}
	out[""] = tot
	return out, rows.Err()
}
