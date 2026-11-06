package ratings

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/db"
)

// Row is the stored ratings state of one title.
type Row struct {
	ID             string
	KPID           *int
	KP, IMDb       *float64
	FetchedAt      *time.Time
	LookupFailedAt *time.Time
	// WikidataAt is when Wikidata last had no (confident) Kinopoisk id.
	WikidataAt *time.Time
}

// Store is the persistence the service needs (a fake in unit tests).
type Store interface {
	BudgetStore
	// Rows reads ids in ONE query; unknown ids are missing.
	Rows(ctx context.Context, ids []string) (map[string]Row, error)
	// Target reads what a lookup needs (kind, ids, year, titles).
	Target(ctx context.Context, id string) (Target, error)
	SaveIMDb(ctx context.Context, id, imdbID string) error
	SaveKPID(ctx context.Context, id string, kpID int) error
	SaveMiss(ctx context.Context, id string) error
	// WDTitles reads kind, TMDB and IMDb ids of ids in one query.
	WDTitles(ctx context.Context, ids []string) ([]WDTitle, error)
	// SaveWikidataMiss marks ids (still without kp_id) as checked on Wikidata.
	SaveWikidataMiss(ctx context.Context, ids []string) error
	SaveRatings(ctx context.Context, id string, v Values) error
}

// PGStore is the PostgreSQL Store.
type PGStore struct{ pool *pgxpool.Pool }

func NewPGStore(pool *pgxpool.Pool) *PGStore { return &PGStore{pool: pool} }

// StaleIDs lists titles with a Kinopoisk id whose ratings were never
// fetched or are older than `age` (startup backfill, e.g. after an import).
func (s *PGStore) StaleIDs(ctx context.Context, age time.Duration, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id FROM media
		WHERE kp_id IS NOT NULL
		  AND (ratings_fetched_at IS NULL OR ratings_fetched_at < now() - make_interval(secs => $1))
		ORDER BY ratings_fetched_at NULLS FIRST, updated_at DESC
		LIMIT $2`, age.Seconds(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *PGStore) Rows(ctx context.Context, ids []string) (map[string]Row, error) {
	out := make(map[string]Row, len(ids))
	rows, err := s.pool.Query(ctx, `
		SELECT id, kp_id, kp_rating, imdb_rating, ratings_fetched_at, kp_lookup_failed_at, kp_wikidata_checked_at
		FROM media WHERE id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.ID, &r.KPID, &r.KP, &r.IMDb, &r.FetchedAt, &r.LookupFailedAt, &r.WikidataAt); err != nil {
			return nil, err
		}
		out[r.ID] = r
	}
	return out, rows.Err()
}

func (s *PGStore) Target(ctx context.Context, id string) (Target, error) {
	var (
		t    Target
		orig string
		year *int
		trs  map[string]struct {
			Title string `json:"title"`
		}
		raw  []byte
		imdb *string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT m.kind, m.tmdb_id, m.original_title, m.year, m.translations,
		       (SELECT external_id FROM media_external_ids e WHERE e.media_id = m.id AND e.provider = 'imdb')
		FROM media m WHERE m.id = $1`, id).Scan(&t.Kind, &t.TMDBID, &orig, &year, &raw, &imdb)
	if db.IsNoRows(err) {
		return t, ErrNotFound
	}
	if err != nil {
		return t, err
	}
	_ = json.Unmarshal(raw, &trs)
	if year != nil {
		t.Year = *year
	}
	if imdb != nil {
		t.IMDbID = *imdb
	}
	t.Titles = nonEmpty(orig, trs["en"].Title, trs["ru"].Title)
	return t, nil
}

func (s *PGStore) SaveIMDb(ctx context.Context, id, imdbID string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO media_external_ids (media_id, provider, external_id) VALUES ($1, 'imdb', $2)
		ON CONFLICT DO NOTHING`, id, imdbID)
	return err
}

func (s *PGStore) SaveKPID(ctx context.Context, id string, kpID int) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE media SET kp_id = $2, kp_lookup_failed_at = NULL WHERE id = $1`, id, kpID); err != nil {
		return err
	}
	// Another title may already claim this id (a remake mapped wrongly, a
	// TMDB duplicate): the media column still holds it, the mirror is skipped.
	if _, err := tx.Exec(ctx, `DELETE FROM media_external_ids WHERE media_id = $1 AND provider = 'kinopoisk'`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO media_external_ids (media_id, provider, external_id) VALUES ($1, 'kinopoisk', $2)
		ON CONFLICT DO NOTHING`, id, strconv.Itoa(kpID)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PGStore) SaveMiss(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE media SET kp_lookup_failed_at = now() WHERE id = $1`, id)
	return err
}

func (s *PGStore) WDTitles(ctx context.Context, ids []string) ([]WDTitle, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.kind, m.tmdb_id,
		       COALESCE((SELECT external_id FROM media_external_ids e WHERE e.media_id = m.id AND e.provider = 'imdb'), '')
		FROM media m WHERE m.id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WDTitle
	for rows.Next() {
		var t WDTitle
		if err := rows.Scan(&t.ID, &t.Kind, &t.TMDBID, &t.IMDbID); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *PGStore) SaveWikidataMiss(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE media SET kp_wikidata_checked_at = now() WHERE id = ANY($1::uuid[]) AND kp_id IS NULL`, ids)
	return err
}

// WikidataBacklog lists titles without a Kinopoisk id that Wikidata was not
// asked about within `retry`: titles someone watched, saved or rated first,
// then the most recently updated.
func (s *PGStore) WikidataBacklog(ctx context.Context, retry time.Duration, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id FROM media m
		WHERE m.kp_id IS NULL
		  AND (m.kp_wikidata_checked_at IS NULL OR m.kp_wikidata_checked_at < now() - make_interval(secs => $1))
		ORDER BY (EXISTS (SELECT 1 FROM watch_progress w WHERE w.media_id = m.id)
		       OR EXISTS (SELECT 1 FROM watchlist_items w WHERE w.media_id = m.id)
		       OR EXISTS (SELECT 1 FROM favorites f WHERE f.media_id = m.id)
		       OR EXISTS (SELECT 1 FROM ratings r WHERE r.media_id = m.id)) DESC,
		         m.updated_at DESC, m.id
		LIMIT $2`, retry.Seconds(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *PGStore) SaveRatings(ctx context.Context, id string, v Values) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE media SET kp_rating = $2, kp_votes = $3, imdb_rating = $4, imdb_votes = $5, ratings_fetched_at = now()
		WHERE id = $1`, id, v.KP, v.KPVotes, v.IMDb, v.IMDbVotes)
	return err
}

func (s *PGStore) LoadBudget(ctx context.Context, day string) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT used FROM ratings_budget WHERE day = $1::date`, day).Scan(&n)
	if db.IsNoRows(err) {
		return 0, nil
	}
	return n, err
}

func (s *PGStore) SaveBudget(ctx context.Context, day string, used int) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO ratings_budget (day, used) VALUES ($1::date, $2)
		ON CONFLICT (day) DO UPDATE SET used = GREATEST(ratings_budget.used, EXCLUDED.used)`, day, used)
	if err == nil && used == 1 { // first request of the day: prune old days
		_, _ = s.pool.Exec(ctx, `DELETE FROM ratings_budget WHERE day < $1::date - 30`, day)
	}
	return err
}
