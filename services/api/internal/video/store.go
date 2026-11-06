package video

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"

	"martytv/api/internal/db"
)

type store struct{ q db.Querier }

// ---- subscriptions ----

type subscription struct {
	ChannelRef
	CreatedAt string `json:"created_at"`
}

func (st *store) subscribe(ctx context.Context, profileID string, ch ChannelRef) (bool, error) {
	tag, err := st.q.Exec(ctx, `INSERT INTO video_subscriptions (profile_id, channel_id, channel_name, avatar)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (profile_id, channel_id) DO UPDATE SET
			channel_name = CASE WHEN EXCLUDED.channel_name <> '' THEN EXCLUDED.channel_name ELSE video_subscriptions.channel_name END,
			avatar = COALESCE(EXCLUDED.avatar, video_subscriptions.avatar)`,
		profileID, ch.ID, ch.Name, ch.Avatar)
	if err != nil {
		return false, err
	}
	_, err = st.q.Exec(ctx, `INSERT INTO video_channels (id, name, avatar) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET
			name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE video_channels.name END,
			avatar = COALESCE(EXCLUDED.avatar, video_channels.avatar), updated_at = now()`, ch.ID, ch.Name, ch.Avatar)
	return tag.RowsAffected() > 0, err
}

func (st *store) unsubscribe(ctx context.Context, profileID, channelID string) (bool, error) {
	tag, err := st.q.Exec(ctx, `DELETE FROM video_subscriptions WHERE profile_id = $1 AND channel_id = $2`, profileID, channelID)
	return tag.RowsAffected() > 0, err
}

func (st *store) subscriptions(ctx context.Context, profileID string) ([]subscription, error) {
	rows, err := st.q.Query(ctx, `SELECT s.channel_id, COALESCE(NULLIF(c.name, ''), s.channel_name), COALESCE(c.avatar, s.avatar), s.created_at
		FROM video_subscriptions s LEFT JOIN video_channels c ON c.id = s.channel_id
		WHERE s.profile_id = $1 ORDER BY lower(COALESCE(NULLIF(c.name, ''), s.channel_name)), s.channel_id`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []subscription{}
	for rows.Next() {
		var s subscription
		var at time.Time
		if err := rows.Scan(&s.ID, &s.Name, &s.Avatar, &at); err != nil {
			return nil, err
		}
		s.Subscribed = true
		s.CreatedAt = at.UTC().Format(time.RFC3339)
		out = append(out, s)
	}
	return out, rows.Err()
}

func (st *store) isSubscribed(ctx context.Context, profileID, channelID string) (bool, error) {
	var ok bool
	err := st.q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM video_subscriptions WHERE profile_id = $1 AND channel_id = $2)`,
		profileID, channelID).Scan(&ok)
	return ok, err
}

func (st *store) subscribedSet(ctx context.Context, profileID string, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := st.q.Query(ctx, `SELECT channel_id FROM video_subscriptions WHERE profile_id = $1 AND channel_id = ANY($2)`, profileID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func (st *store) subscribedChannels(ctx context.Context) ([]string, error) {
	rows, err := st.q.Query(ctx, `SELECT DISTINCT s.channel_id FROM video_subscriptions s
		LEFT JOIN video_channels c ON c.id = s.channel_id ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func (st *store) channelRefreshedAt(ctx context.Context, id string) (time.Time, error) {
	var t *time.Time
	err := st.q.QueryRow(ctx, `SELECT refreshed_at FROM video_channels WHERE id = $1`, id).Scan(&t)
	if err != nil || t == nil {
		return time.Time{}, nil
	}
	return *t, nil
}

// replaceChannelVideos stores a channel's latest uploads (the feed cache).
func (st *store) replaceChannelVideos(ctx context.Context, channelID string, items []Item) error {
	pool, ok := st.q.(interface {
		Begin(context.Context) (pgx.Tx, error)
	})
	if !ok {
		return nil
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	name := ""
	if len(items) > 0 {
		name = items[0].ChannelName
	}
	if _, err := tx.Exec(ctx, `INSERT INTO video_channels (id, name, refreshed_at, last_error) VALUES ($1, $2, now(), NULL)
		ON CONFLICT (id) DO UPDATE SET name = CASE WHEN $2 <> '' THEN $2 ELSE video_channels.name END,
			refreshed_at = now(), last_error = NULL, updated_at = now()`, channelID, name); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM video_channel_videos WHERE channel_id = $1`, channelID); err != nil {
		return err
	}
	for i, it := range items {
		b, _ := json.Marshal(it)
		var pub *time.Time
		if it.PublishedAt != nil {
			if t, err := time.Parse(time.RFC3339, *it.PublishedAt); err == nil {
				pub = &t
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO video_channel_videos (channel_id, video_id, item, published_at, position)
			VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, channelID, it.ID, b, pub, i); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (st *store) channelError(ctx context.Context, id, msg string) error {
	_, err := st.q.Exec(ctx, `INSERT INTO video_channels (id, last_error) VALUES ($1, $2)
		ON CONFLICT (id) DO UPDATE SET last_error = $2, updated_at = now()`, id, msg)
	return err
}

// pruneChannels drops cached channels nobody subscribes to any more.
func (st *store) pruneChannels(ctx context.Context) error {
	_, err := st.q.Exec(ctx, `DELETE FROM video_channels c WHERE NOT EXISTS (SELECT 1 FROM video_subscriptions s WHERE s.channel_id = c.id)`)
	return err
}

// feed merges the cached latest uploads of a profile's subscriptions, newest first.
func (st *store) feed(ctx context.Context, profileID string, offset, limit int) ([]Item, *time.Time, error) {
	rows, err := st.q.Query(ctx, `SELECT v.item FROM video_channel_videos v
		JOIN video_subscriptions s ON s.channel_id = v.channel_id AND s.profile_id = $1
		ORDER BY v.published_at DESC NULLS LAST, v.channel_id, v.position, v.video_id LIMIT $2 OFFSET $3`, profileID, limit, offset)
	if err != nil {
		return nil, nil, err
	}
	items, err := scanItems(rows)
	if err != nil {
		return nil, nil, err
	}
	var at *time.Time
	err = st.q.QueryRow(ctx, `SELECT max(c.refreshed_at) FROM video_channels c
		JOIN video_subscriptions s ON s.channel_id = c.id AND s.profile_id = $1`, profileID).Scan(&at)
	return items, at, err
}

func scanItems(rows pgx.Rows) ([]Item, error) {
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var b []byte
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		var it Item
		if json.Unmarshal(b, &it) == nil && ValidVideoID(it.ID) {
			it.Progress = nil
			out = append(out, it)
		}
	}
	return out, rows.Err()
}

// ---- watch later ----

func (st *store) addWatchLater(ctx context.Context, profileID string, it Item) error {
	it.Progress = nil
	b, _ := json.Marshal(it)
	_, err := st.q.Exec(ctx, `INSERT INTO video_watch_later (profile_id, video_id, item) VALUES ($1, $2, $3)
		ON CONFLICT (profile_id, video_id) DO UPDATE SET item = EXCLUDED.item`, profileID, it.ID, b)
	return err
}

func (st *store) removeWatchLater(ctx context.Context, profileID, videoID string) (bool, error) {
	tag, err := st.q.Exec(ctx, `DELETE FROM video_watch_later WHERE profile_id = $1 AND video_id = $2`, profileID, videoID)
	return tag.RowsAffected() > 0, err
}

func (st *store) watchLater(ctx context.Context, profileID string) ([]Item, error) {
	rows, err := st.q.Query(ctx, `SELECT item FROM video_watch_later WHERE profile_id = $1 ORDER BY added_at DESC LIMIT 500`, profileID)
	if err != nil {
		return nil, err
	}
	return scanItems(rows)
}

func (st *store) inWatchLater(ctx context.Context, profileID, videoID string) (bool, error) {
	var ok bool
	err := st.q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM video_watch_later WHERE profile_id = $1 AND video_id = $2)`,
		profileID, videoID).Scan(&ok)
	return ok, err
}

// ---- progress / history ----

func (st *store) saveProgress(ctx context.Context, profileID string, it Item, pos, dur float64, finished bool) error {
	it.Progress = nil
	b, _ := json.Marshal(it)
	_, err := st.q.Exec(ctx, `INSERT INTO video_progress (profile_id, video_id, item, position_seconds, duration_seconds, finished)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (profile_id, video_id) DO UPDATE SET item = EXCLUDED.item, position_seconds = EXCLUDED.position_seconds,
			duration_seconds = CASE WHEN EXCLUDED.duration_seconds > 0 THEN EXCLUDED.duration_seconds ELSE video_progress.duration_seconds END,
			finished = EXCLUDED.finished, updated_at = now()`, profileID, it.ID, b, pos, dur, finished)
	return err
}

func (st *store) progressItem(ctx context.Context, profileID, videoID string) (*Item, error) {
	var b []byte
	err := st.q.QueryRow(ctx, `SELECT item FROM video_progress WHERE profile_id = $1 AND video_id = $2`, profileID, videoID).Scan(&b)
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var it Item
	if err := json.Unmarshal(b, &it); err != nil {
		return nil, nil
	}
	return &it, nil
}

func (st *store) progress(ctx context.Context, profileID, videoID string) (*Progress, error) {
	m, err := st.progressMap(ctx, profileID, []string{videoID})
	if err != nil {
		return nil, err
	}
	return m[videoID], nil
}

func (st *store) progressMap(ctx context.Context, profileID string, ids []string) (map[string]*Progress, error) {
	out := map[string]*Progress{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := st.q.Query(ctx, `SELECT video_id, position_seconds, duration_seconds, finished, updated_at
		FROM video_progress WHERE profile_id = $1 AND video_id = ANY($2)`, profileID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var p Progress
		var at time.Time
		if err := rows.Scan(&id, &p.PositionSeconds, &p.DurationSeconds, &p.Finished, &at); err != nil {
			return nil, err
		}
		p.UpdatedAt = at.UTC().Format(time.RFC3339)
		out[id] = &p
	}
	return out, rows.Err()
}

// history lists watched videos, most recent first; unfinished=true keeps
// only resumable ones («Продолжить»).
func (st *store) history(ctx context.Context, profileID string, unfinished bool, limit int) ([]Item, error) {
	q := `SELECT item, position_seconds, duration_seconds, finished, updated_at FROM video_progress WHERE profile_id = $1`
	if unfinished {
		q += ` AND NOT finished AND position_seconds >= 15 AND updated_at > now() - interval '60 days'`
	}
	q += ` ORDER BY updated_at DESC LIMIT $2`
	rows, err := st.q.Query(ctx, q, profileID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var b []byte
		var p Progress
		var at time.Time
		if err := rows.Scan(&b, &p.PositionSeconds, &p.DurationSeconds, &p.Finished, &at); err != nil {
			return nil, err
		}
		var it Item
		if json.Unmarshal(b, &it) != nil || !ValidVideoID(it.ID) {
			continue
		}
		p.UpdatedAt = at.UTC().Format(time.RFC3339)
		it.Progress = &p
		out = append(out, it)
	}
	return out, rows.Err()
}

func (st *store) removeHistory(ctx context.Context, profileID, videoID string) (bool, error) {
	tag, err := st.q.Exec(ctx, `DELETE FROM video_progress WHERE profile_id = $1 AND video_id = $2`, profileID, videoID)
	return tag.RowsAffected() > 0, err
}

// ---- admin ----

type storeStats struct {
	subs, channels, videos int
	refreshed              time.Time
}

func (st *store) stats(ctx context.Context) (storeStats, error) {
	var s storeStats
	var at *time.Time
	err := st.q.QueryRow(ctx, `SELECT (SELECT count(*) FROM video_subscriptions), (SELECT count(*) FROM video_channels),
		(SELECT count(*) FROM video_channel_videos), (SELECT max(refreshed_at) FROM video_channels)`).Scan(&s.subs, &s.channels, &s.videos, &at)
	if at != nil {
		s.refreshed = *at
	}
	return s, err
}
