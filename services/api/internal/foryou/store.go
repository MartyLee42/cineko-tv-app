package foryou

import (
	"context"
	"encoding/json"
	"time"

	"martytv/api/internal/db"
)

// ---- signals ----

// loadSignals reads every interaction of a profile in one query.
func (s *Service) loadSignals(ctx context.Context, profileID string) ([]Signal, error) {
	rows, err := s.pool.Query(ctx, `
		WITH r AS (SELECT media_id, rating, updated_at FROM ratings WHERE profile_id = $1),
		p AS (
			SELECT wp.media_id,
			       bool_or(wp.completed AND wp.episode_id IS NULL) AS whole,
			       count(*) FILTER (WHERE wp.completed AND wp.episode_id IS NOT NULL)::int AS eps,
			       max(wp.completed_at) AS completed_at,
			       COALESCE(max(wp.percent) FILTER (WHERE NOT wp.completed), 0) AS pct,
			       max(wp.updated_at) AS last_at
			FROM watch_progress wp WHERE wp.profile_id = $1 GROUP BY wp.media_id),
		f AS (SELECT media_id, created_at FROM favorites WHERE profile_id = $1),
		wl AS (SELECT media_id, created_at FROM watchlist_items WHERE profile_id = $1),
		d AS (SELECT media_id, created_at FROM foryou_dismissals WHERE profile_id = $1),
		rw AS (
			SELECT ps.media_id, count(*)::int AS n FROM playback_sessions ps
			JOIN watch_progress wp ON wp.profile_id = ps.profile_id AND wp.media_id = ps.media_id AND wp.episode_id IS NULL
			WHERE ps.profile_id = $1 AND ps.episode_id IS NULL AND wp.completed AND wp.completed_at IS NOT NULL
			  AND ps.started_at > wp.completed_at AND ps.last_duration > 0 AND ps.last_position >= 0.9 * ps.last_duration
			GROUP BY ps.media_id),
		n AS (SELECT media_id, reasons FROM profile_media_notes WHERE profile_id = $1 AND reasons <> '{}'),
		ids AS (SELECT media_id FROM r UNION SELECT media_id FROM p UNION SELECT media_id FROM f
		        UNION SELECT media_id FROM wl UNION SELECT media_id FROM d UNION SELECT media_id FROM n)
		SELECT ids.media_id, COALESCE(r.rating, 0)::int, r.updated_at,
		       COALESCE(p.whole, false), COALESCE(p.eps, 0), p.completed_at, COALESCE(p.pct, 0), p.last_at, p.media_id IS NOT NULL,
		       f.created_at, wl.created_at, d.created_at, COALESCE(rw.n, 0), COALESCE(n.reasons, '{}')
		FROM ids
		LEFT JOIN r ON r.media_id = ids.media_id
		LEFT JOIN p ON p.media_id = ids.media_id
		LEFT JOIN f ON f.media_id = ids.media_id
		LEFT JOIN wl ON wl.media_id = ids.media_id
		LEFT JOIN d ON d.media_id = ids.media_id
		LEFT JOIN rw ON rw.media_id = ids.media_id
		LEFT JOIN n ON n.media_id = ids.media_id
		ORDER BY ids.media_id`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Signal
	for rows.Next() {
		var (
			sg                      Signal
			ratedAt, doneAt, lastAt *time.Time
			favAt, wlAt, dismAt     *time.Time
			whole                   bool
			eps                     int
		)
		if err := rows.Scan(&sg.MediaID, &sg.Rating, &ratedAt, &whole, &eps, &doneAt, &sg.Percent, &lastAt, &sg.Started,
			&favAt, &wlAt, &dismAt, &sg.Rewatches, &sg.NoteReasons); err != nil {
			return nil, err
		}
		sg.Completed = whole || eps >= 3
		set := func(dst *time.Time, src *time.Time) {
			if src != nil {
				*dst = *src
			}
		}
		set(&sg.RatedAt, ratedAt)
		set(&sg.CompletedAt, doneAt)
		set(&sg.LastActivity, lastAt)
		if favAt != nil {
			sg.Favorite, sg.FavoriteAt = true, *favAt
		}
		if wlAt != nil {
			sg.Watchlist, sg.WatchlistAt = true, *wlAt
		}
		if dismAt != nil {
			sg.Dismissed, sg.DismissedAt = true, *dismAt
		}
		out = append(out, sg)
	}
	return out, rows.Err()
}

// latestSignal is the newest rating/completion/dismissal/favorite time,
// used to detect stale caches cheaply.
func (s *Service) latestSignal(ctx context.Context, profileID string) (*time.Time, error) {
	var t *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT GREATEST(
			(SELECT max(updated_at) FROM ratings WHERE profile_id = $1),
			(SELECT max(completed_at) FROM watch_progress WHERE profile_id = $1 AND completed),
			(SELECT max(created_at) FROM foryou_dismissals WHERE profile_id = $1),
			(SELECT max(created_at) FROM favorites WHERE profile_id = $1))`, profileID).Scan(&t)
	return t, err
}

// ---- features ----

type mediaFacts struct {
	Features
	VoteAverage float64
	VoteCount   int
	Popularity  float64
	KPRating    float64
	Runtime     int
}

// loadFeatures reads facts, genres and key people for many titles at once.
func (s *Service) loadFeatures(ctx context.Context, ids []string) (map[string]mediaFacts, error) {
	out := make(map[string]mediaFacts, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.kind, COALESCE(m.year, 0), m.original_language, m.countries,
		       m.vote_average, m.vote_count, m.popularity, COALESCE(m.kp_rating, 0), COALESCE(m.runtime, 0),
		       COALESCE((SELECT array_agg(g.genre_id ORDER BY g.position, g.genre_id) FROM media_genres g WHERE g.media_id = m.id), '{}'),
		       COALESCE((SELECT array_agg(DISTINCT p.tmdb_id) FROM media_cast c JOIN media_people p ON p.id = c.person_id
		                 WHERE c.media_id = m.id AND c.credit_type = 'crew' AND c.job IN ('Director', 'Creator')), '{}'),
		       COALESCE((SELECT array_agg(p.tmdb_id ORDER BY c.ord) FROM media_cast c JOIN media_people p ON p.id = c.person_id
		                 WHERE c.media_id = m.id AND c.credit_type = 'cast' AND c.ord < $2), '{}'),
		       m.details_fetched_at <> '{}'::jsonb,
		       COALESCE((SELECT array_agg(DISTINCT p.tmdb_id) FROM media_cast c JOIN media_people p ON p.id = c.person_id
		                 WHERE c.media_id = m.id AND c.credit_type = 'crew' AND c.job IN ('Screenplay', 'Writer')), '{}'),
		       COALESCE((SELECT array_agg(DISTINCT p.tmdb_id) FROM media_cast c JOIN media_people p ON p.id = c.person_id
		                 WHERE c.media_id = m.id AND c.credit_type = 'crew' AND c.job = 'Director of Photography'), '{}'),
		       COALESCE((SELECT array_agg(DISTINCT p.tmdb_id) FROM media_cast c JOIN media_people p ON p.id = c.person_id
		                 WHERE c.media_id = m.id AND c.credit_type = 'crew' AND c.job = 'Original Music Composer'), '{}'),
		       COALESCE((SELECT array_agg(k.id ORDER BY mk.position, k.id) FROM media_keywords mk JOIN keywords k ON k.id = mk.keyword_id
		                 WHERE mk.media_id = m.id AND NOT (lower(k.name) = ANY($3::text[]))), '{}')
		FROM media m WHERE m.id = ANY($1::uuid[])`, ids, s.w.ActorBilling, keywordStoplist)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id                   string
			f                    mediaFacts
			genres, dirs, actors []int32
			writers, dops, comps []int32
			kws                  []int32
		)
		if err := rows.Scan(&id, &f.Kind, &f.Year, &f.Lang, &f.Countries, &f.VoteAverage, &f.VoteCount, &f.Popularity,
			&f.KPRating, &f.Runtime, &genres, &dirs, &actors, &f.HasCredits, &writers, &dops, &comps, &kws); err != nil {
			return nil, err
		}
		f.Genres, f.Directors, f.Actors = ints(genres), ints(dirs), ints(actors)
		f.Writers, f.Cinematographers, f.Composers, f.Keywords = ints(writers), ints(dops), ints(comps), ints(kws)
		out[id] = f
	}
	return out, rows.Err()
}

func ints(in []int32) []int {
	out := make([]int, len(in))
	for i, v := range in {
		out[i] = int(v)
	}
	return out
}

// ---- taste ----

func (s *Service) saveTaste(ctx context.Context, profileID string, t *Taste) error {
	b, err := json.Marshal(t)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO profile_taste (profile_id, data, signals, computed_at) VALUES ($1, $2, $3, now())
		ON CONFLICT (profile_id) DO UPDATE SET data = EXCLUDED.data, signals = EXCLUDED.signals, computed_at = now()`,
		profileID, b, t.Stats.Positive)
	return err
}

func (s *Service) loadTaste(ctx context.Context, profileID string) (*Taste, time.Time, error) {
	var raw []byte
	var at time.Time
	err := s.pool.QueryRow(ctx, `SELECT data, computed_at FROM profile_taste WHERE profile_id = $1`, profileID).Scan(&raw, &at)
	if db.IsNoRows(err) {
		return nil, time.Time{}, nil
	}
	if err != nil {
		return nil, time.Time{}, err
	}
	var t Taste
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, time.Time{}, nil // unreadable: recompute
	}
	t.index()
	return &t, at, nil
}

// ---- cache ----

type cacheRow struct {
	Rows []cachedRow
	Pool []cachedItem
	// TopCandidates: what «Подобрано для вас» was chosen from (AI re-ranking).
	TopCandidates []string
	ColdStart     bool
	Lang          string
	SignalsAt     *time.Time
	ComputedAt    time.Time
	ExpiresAt     time.Time
}

func (s *Service) loadCache(ctx context.Context, profileID string) (*cacheRow, error) {
	var c cacheRow
	var rowsRaw, poolRaw, candRaw []byte
	err := s.pool.QueryRow(ctx, `
		SELECT rows, pool, top_candidates, cold_start, lang, signals_at, computed_at, expires_at FROM recs_cache WHERE profile_id = $1`, profileID).
		Scan(&rowsRaw, &poolRaw, &candRaw, &c.ColdStart, &c.Lang, &c.SignalsAt, &c.ComputedAt, &c.ExpiresAt)
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if json.Unmarshal(rowsRaw, &c.Rows) != nil || json.Unmarshal(poolRaw, &c.Pool) != nil {
		return nil, nil
	}
	_ = json.Unmarshal(candRaw, &c.TopCandidates)
	return &c, nil
}

func (s *Service) saveCache(ctx context.Context, profileID string, c *cacheRow) error {
	rows, _ := json.Marshal(nonNilSlice(c.Rows))
	pool, _ := json.Marshal(nonNilSlice(c.Pool))
	cands, _ := json.Marshal(nonNilSlice(c.TopCandidates))
	_, err := s.pool.Exec(ctx, `
		INSERT INTO recs_cache (profile_id, rows, pool, top_candidates, cold_start, lang, signals_at, computed_at, expires_at)
		VALUES ($1, $2, $3, $8, $4, $5, $6, now(), now() + $7::interval)
		ON CONFLICT (profile_id) DO UPDATE SET rows = EXCLUDED.rows, pool = EXCLUDED.pool, top_candidates = EXCLUDED.top_candidates,
			cold_start = EXCLUDED.cold_start,
			lang = EXCLUDED.lang, signals_at = EXCLUDED.signals_at, computed_at = now(), expires_at = EXCLUDED.expires_at`,
		profileID, rows, pool, c.ColdStart, c.Lang, c.SignalsAt, cacheTTL, cands)
	return err
}

func nonNilSlice[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// ---- small lookups ----

// profileOwner returns the account a profile belongs to ("" if unknown).
func (s *Service) profileOwner(ctx context.Context, profileID string) (string, error) {
	var uid string
	err := s.pool.QueryRow(ctx, `SELECT user_id FROM profiles WHERE id = $1`, profileID).Scan(&uid)
	if db.IsNoRows(err) {
		return "", nil
	}
	return uid, err
}

// profileLang is the catalog language for a profile's candidates: the last
// one it asked rows in, else its UI language.
func (s *Service) profileLang(ctx context.Context, profileID string) string {
	var l string
	err := s.pool.QueryRow(ctx, `
		SELECT COALESCE((SELECT lang FROM recs_cache WHERE profile_id = $1),
		                (SELECT ui_language FROM profile_preferences WHERE profile_id = $1), 'en')`, profileID).Scan(&l)
	if err != nil || (l != "ru" && l != "en") {
		return "en"
	}
	return l
}

// seenSet: titles the profile rated, started/completed or dismissed.
func (s *Service) seenSet(ctx context.Context, profileID string) (map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT media_id FROM ratings WHERE profile_id = $1
		UNION SELECT media_id FROM watch_progress WHERE profile_id = $1
		UNION SELECT media_id FROM foryou_dismissals WHERE profile_id = $1`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// dismissedSet among ids.
func (s *Service) dismissedSet(ctx context.Context, profileID string, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT media_id FROM foryou_dismissals WHERE profile_id = $1 AND media_id = ANY($2::uuid[])`, profileID, ids)
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

// impressionStats: unopened impressions in the last 14 days, and whether a
// title was ever shown.
func (s *Service) impressionStats(ctx context.Context, profileID string) (map[string]int, map[string]bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT media_id,
		       count(*) FILTER (WHERE action = 'impression' AND created_at > now() - interval '14 days')::int,
		       bool_or(action IN ('open', 'play', 'complete') AND created_at > now() - interval '14 days')
		FROM foryou_feedback WHERE profile_id = $1 GROUP BY media_id`, profileID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	fatigue, shown := map[string]int{}, map[string]bool{}
	for rows.Next() {
		var id string
		var n int
		var opened bool
		if err := rows.Scan(&id, &n, &opened); err != nil {
			return nil, nil, err
		}
		shown[id] = true
		if !opened {
			fatigue[id] = n
		}
	}
	return fatigue, shown, rows.Err()
}

type personName struct {
	Name    string
	Profile *string
}

// personNames resolves TMDB person ids to (localized) names.
func (s *Service) personNames(ctx context.Context, ids []int, lang string) (map[int]personName, error) {
	out := map[int]personName{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT tmdb_id, COALESCE(NULLIF(translations ->> $2::text, ''), name), profile_path
		FROM media_people WHERE tmdb_id = ANY($1::int[])`, ids, lang)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var p personName
		if err := rows.Scan(&id, &p.Name, &p.Profile); err != nil {
			return nil, err
		}
		out[id] = p
	}
	return out, rows.Err()
}

// genreNamesFor resolves genre ids (stored names first, static fallback).
func (s *Service) genreNamesFor(ctx context.Context, lang string) map[int]string {
	out := map[int]string{}
	rows, err := s.pool.Query(ctx, `SELECT id, translations ->> $1::text FROM genres`, lang)
	if err == nil {
		for rows.Next() {
			var id int
			var n *string
			if rows.Scan(&id, &n) == nil && n != nil && *n != "" {
				out[id] = *n
			}
		}
		rows.Close()
	}
	return out
}

func genreName(names map[int]string, lang string, id int) string {
	if n, ok := names[id]; ok {
		return n
	}
	return staticGenreName(lang, id)
}
