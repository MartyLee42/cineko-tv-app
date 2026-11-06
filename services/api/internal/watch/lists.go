package watch

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/catalog"
	"martytv/api/internal/httpx"
)

// listTables maps the contract's list names to tables (never user input in SQL).
var listTables = map[string]string{"watchlist": "watchlist_items", "favorites": "favorites"}

func (s *Service) mediaExists(ctx context.Context, mediaID string) error {
	_, err := s.mediaKind(ctx, mediaID)
	return err
}

// AddToList is idempotent; unknown media → ErrNotFound.
func (s *Service) AddToList(ctx context.Context, profileID, list, mediaID string) error {
	if err := s.mediaExists(ctx, mediaID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `INSERT INTO `+listTables[list]+` (profile_id, media_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		profileID, mediaID)
	return err
}

func (s *Service) RemoveFromList(ctx context.Context, profileID, list, mediaID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM `+listTables[list]+` WHERE profile_id = $1 AND media_id = $2`, profileID, mediaID)
	return err
}

// List returns one page (20, newest first) of a profile list as a MediaPage.
func (s *Service) List(ctx context.Context, profileID, list, lang string, page int) (*catalog.MediaPage, error) {
	table := listTables[list]
	var total int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE profile_id = $1`, profileID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT media_id FROM `+table+` WHERE profile_id = $1
		ORDER BY created_at DESC, media_id LIMIT $2 OFFSET $3`, profileID, listPageSize, (page-1)*listPageSize)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	items, err := s.summaries(ctx, profileID, ids, lang)
	if err != nil {
		return nil, err
	}
	out := make([]catalog.MediaSummary, 0, len(ids))
	for _, id := range ids {
		if m, ok := items[id]; ok {
			out = append(out, m)
		}
	}
	return &catalog.MediaPage{Items: out, Page: page, TotalPages: (total + listPageSize - 1) / listPageSize, TotalResults: total}, nil
}

// summaries loads MediaSummary for ids annotated with the profile's state.
func (s *Service) summaries(ctx context.Context, profileID string, ids []string, lang string) (map[string]catalog.MediaSummary, error) {
	m, err := s.catalog.SummariesByID(ctx, ids, lang)
	if err != nil {
		return nil, err
	}
	states, err := s.UserStates(ctx, profileID, ids)
	if err != nil {
		return nil, err
	}
	for id, it := range m {
		st := states[id]
		it.Me = &st
		m[id] = it
	}
	return m, nil
}

func (s *Service) Rate(ctx context.Context, profileID, mediaID string, rating int) error {
	if err := s.mediaExists(ctx, mediaID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ratings (profile_id, media_id, rating) VALUES ($1, $2, $3)
		ON CONFLICT (profile_id, media_id) DO UPDATE SET rating = EXCLUDED.rating, updated_at = now()`,
		profileID, mediaID, rating)
	return err
}

func (s *Service) Unrate(ctx context.Context, profileID, mediaID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM ratings WHERE profile_id = $1 AND media_id = $2`, profileID, mediaID)
	return err
}

// ---- catalog.Personalizer ----

// Viewer validates profile access for ?profile_id and returns its filters.
func (s *Service) Viewer(c fiber.Ctx, profileID string) (*catalog.Viewer, error) {
	ok, err := s.profiles.CanUse(c.Context(), auth.PrincipalFrom(c), profileID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, httpx.NotFound()
	}
	st, err := s.profiles.GetSettings(c.Context(), profileID)
	if err != nil {
		return nil, err
	}
	return &catalog.Viewer{ProfileID: profileID, HideAnime: *st.HideAnime, HideWatched: *st.HideWatched}, nil
}

// UserStates returns `me` for many titles in one query. Series progress is
// the share of aired (non-special) episodes completed; a series is completed
// when every aired episode is.
func (s *Service) UserStates(ctx context.Context, profileID string, ids []string) (map[string]catalog.MediaUserState, error) {
	out := make(map[string]catalog.MediaUserState, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.kind, mp.percent, COALESCE(mp.completed, false),
		       (SELECT count(*) FROM watch_progress p JOIN episodes e ON e.id = p.episode_id
		         WHERE p.profile_id = $1 AND p.media_id = m.id AND p.completed AND e.season_number > 0)::int,
		       EXISTS (SELECT 1 FROM watch_progress p WHERE p.profile_id = $1 AND p.media_id = m.id AND p.episode_id IS NOT NULL),
		       CASE WHEN m.kind = 'series' THEN (
		         SELECT COALESCE(sum(CASE
		           WHEN EXISTS (SELECT 1 FROM episodes e WHERE e.season_id = s.id)
		             THEN (SELECT count(*) FROM episodes e WHERE e.season_id = s.id AND e.air_date <= current_date)
		           WHEN s.air_date <= current_date THEN s.episode_count
		           ELSE 0 END), 0)
		         FROM seasons s WHERE s.media_id = m.id AND s.season_number > 0) ELSE 0 END::int,
		       EXISTS (SELECT 1 FROM watchlist_items w WHERE w.profile_id = $1 AND w.media_id = m.id),
		       EXISTS (SELECT 1 FROM favorites f WHERE f.profile_id = $1 AND f.media_id = m.id),
		       r.rating::int, n.text, n.reasons
		FROM media m
		LEFT JOIN watch_progress mp ON mp.profile_id = $1 AND mp.media_id = m.id AND mp.episode_id IS NULL
		LEFT JOIN ratings r ON r.profile_id = $1 AND r.media_id = m.id
		LEFT JOIN profile_media_notes n ON n.profile_id = $1 AND n.media_id = m.id
		WHERE m.id = ANY($2::uuid[])`, profileID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id, kind    string
			moviePct    *float64
			movieDone   bool
			done, total int
			anyEp       bool
			st          catalog.MediaUserState
			noteText    *string
			noteReasons []string
		)
		if err := rows.Scan(&id, &kind, &moviePct, &movieDone, &done, &anyEp, &total,
			&st.InWatchlist, &st.Favorite, &st.Rating, &noteText, &noteReasons); err != nil {
			return nil, err
		}
		if noteText != nil {
			st.Note = &catalog.MediaNote{Text: *noteText, Reasons: noteReasons}
			if st.Note.Reasons == nil {
				st.Note.Reasons = []string{}
			}
		}
		if kind == "movie" {
			st.ProgressPercent, st.Completed = moviePct, movieDone
		} else if anyEp {
			pct := 0.0
			if total > 0 {
				pct = min(float64(done)/float64(total), 1)
			}
			st.ProgressPercent = &pct
			st.Completed = total > 0 && done >= total
		} else {
			// A title-level row on a series (episode_id NULL) marks it seen as
			// a whole: the Kinopoisk import (internal/imports) writes these.
			st.Completed = movieDone
		}
		out[id] = st
	}
	return out, rows.Err()
}

// ---- continue watching ----

// ContinueWatching: in-progress movies and episodes plus series with a next
// episode, among titles touched in the last 90 days, newest first, max 30.
func (s *Service) ContinueWatching(ctx context.Context, profileID, lang string) ([]ContinueItem, error) {
	recent, err := queryProgress(ctx, s.pool, `SELECT `+progressCols+progressFrom+`
		WHERE wp.profile_id = $1 AND wp.updated_at > now() - $2::interval
		ORDER BY wp.updated_at DESC, wp.id DESC LIMIT 1000`, profileID, continueWindow)
	if err != nil {
		return nil, err
	}
	// Newest row per title decides the order.
	var order []string
	latest := map[string]*WatchProgress{}
	var seriesIDs []string
	for i := range recent {
		p := &recent[i]
		if _, ok := latest[p.MediaID]; ok {
			continue
		}
		latest[p.MediaID] = p
		order = append(order, p.MediaID)
		if p.EpisodeID != nil {
			seriesIDs = append(seriesIDs, p.MediaID)
		}
	}
	series, err := s.loadSeries(ctx, profileID, seriesIDs)
	if err != nil {
		return nil, err
	}
	var items []ContinueItem
	var ids []string
	for _, mid := range order {
		if len(items) >= continueMax {
			break
		}
		p := latest[mid]
		var it ContinueItem
		if p.EpisodeID == nil {
			if !p.resumable {
				continue
			}
			it.Progress = p
		} else {
			nu, _ := s.seriesNextUp(ctx, profileID, mid, series[mid], lang)
			if p.resumable {
				it.Progress = p
			}
			it.NextUp = nu
			if it.Progress == nil && it.NextUp == nil {
				continue
			}
		}
		it.Media.ID = mid
		items = append(items, it)
		ids = append(ids, mid)
	}
	sums, err := s.summaries(ctx, profileID, ids, lang)
	if err != nil {
		return nil, err
	}
	out := make([]ContinueItem, 0, len(items))
	for _, it := range items {
		m, ok := sums[it.Media.ID]
		if !ok {
			continue
		}
		it.Media = m
		out = append(out, it)
	}
	return out, nil
}

// ---- history ----

type historyCursor struct {
	at time.Time
	id string
}

func encodeCursor(at time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(at.UTC().Format(time.RFC3339Nano) + "|" + id))
}

var errBadCursor = errors.New("watch: bad cursor")

func decodeCursor(s string) (*historyCursor, error) {
	if s == "" {
		return nil, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, errBadCursor
	}
	ts, id, ok := strings.Cut(string(b), "|")
	if !ok || !isUUID(id) {
		return nil, errBadCursor
	}
	at, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return nil, errBadCursor
	}
	return &historyCursor{at: at, id: id}, nil
}

// historyRows pages progress rows (newest first) for a set of profiles.
func (s *Service) historyRows(ctx context.Context, profileIDs []string, cursor string, limit int) ([]WatchProgress, *string, error) {
	cur, err := decodeCursor(cursor)
	if err != nil {
		return nil, nil, validationError{"cursor": "invalid"}
	}
	var at *time.Time
	var id *string
	if cur != nil {
		at, id = &cur.at, &cur.id
	}
	rows, err := queryProgress(ctx, s.pool, `SELECT `+progressCols+progressFrom+`
		WHERE wp.profile_id = ANY($1::uuid[])
		  AND ($2::timestamptz IS NULL OR (wp.updated_at, wp.id) < ($2::timestamptz, $3::uuid))
		ORDER BY wp.updated_at DESC, wp.id DESC LIMIT $4`, profileIDs, at, id, limit+1)
	if err != nil {
		return nil, nil, err
	}
	var next *string
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		c := encodeCursor(last.UpdatedAt, last.id)
		next = &c
	}
	return rows, next, nil
}

// History is GET /profiles/{id}/history.
func (s *Service) History(ctx context.Context, profileID, cursor string, limit int, lang string) ([]HistoryItem, *string, error) {
	rows, next, err := s.historyRows(ctx, []string{profileID}, cursor, limit)
	if err != nil {
		return nil, nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.MediaID)
	}
	sums, err := s.summaries(ctx, profileID, ids, lang)
	if err != nil {
		return nil, nil, err
	}
	out := make([]HistoryItem, 0, len(rows))
	for _, r := range rows {
		if m, ok := sums[r.MediaID]; ok {
			out = append(out, HistoryItem{Media: m, Progress: r})
		}
	}
	return out, next, nil
}
