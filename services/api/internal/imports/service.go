// Package imports applies ratings exported from other services to a viewing
// profile. Today: Kinopoisk («Импорт оценок с Кинопоиска»).
//
// A job is created from an uploaded CSV and processed in the background
// (Run) with bounded concurrency. Each line is matched to a TMDB title
// (an existing Kinopoisk id mapping first, then TMDB search through the
// catalog), and the profile's rating is written with the original date;
// optionally the title is marked watched. Jobs survive restarts: Run picks
// up queued and running jobs on boot and skips lines already processed.
package imports

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/audit"
	"martytv/api/internal/db"
)

// Concurrency is the number of lines matched at once (each needs 1–4 TMDB
// searches; the TMDB client rate-limits on top).
const Concurrency = 4

var (
	ErrNotFound = errors.New("imports: not found")
	// ErrActive: the profile already has a queued or running job.
	ErrActive = errors.New("imports: a job is already running for this profile")
)

// Options are the job switches.
type Options struct {
	Overwrite   bool `json:"overwrite"`
	MarkWatched bool `json:"mark_watched"`
	DryRun      bool `json:"dry_run"`
}

// Unmatched is one line that was not applied.
type Unmatched struct {
	KPID   int    `json:"kp_id"`
	Title  string `json:"title"`
	Year   *int   `json:"year"`
	Reason string `json:"reason"`
}

// Job is the contract's ImportJob.
type Job struct {
	ID          string      `json:"id"`
	ProfileID   string      `json:"profile_id"`
	Source      string      `json:"source"`
	Status      string      `json:"status"`
	Overwrite   bool        `json:"overwrite"`
	MarkWatched bool        `json:"mark_watched"`
	DryRun      bool        `json:"dry_run"`
	Total       int         `json:"total"`
	Processed   int         `json:"processed"`
	Matched     int         `json:"matched"`
	Rated       int         `json:"rated"`
	Skipped     int         `json:"skipped"`
	Unmatched   []Unmatched `json:"unmatched"`
	Error       *string     `json:"error"`
	CreatedAt   time.Time   `json:"created_at"`
	StartedAt   *time.Time  `json:"started_at"`
	FinishedAt  *time.Time  `json:"finished_at"`

	userID string
}

type Service struct {
	pool  *pgxpool.Pool
	cat   Catalog
	audit *audit.Logger
	log   *slog.Logger
	wake  chan struct{}
	// retryWait is the pause before retrying a line after a TMDB failure.
	retryWait time.Duration
}

func NewService(pool *pgxpool.Pool, cat Catalog, a *audit.Logger, log *slog.Logger) *Service {
	return &Service{pool: pool, cat: cat, audit: a, log: log, wake: make(chan struct{}, 1), retryWait: 3 * time.Second}
}

// SetRetryWait shortens TMDB retry pauses (tests).
func (s *Service) SetRetryWait(d time.Duration) { s.retryWait = d }

// Create stores a queued job for the parsed rows and wakes the runner.
func (s *Service) Create(ctx context.Context, userID, profileID string, rows []Row, o Options) (string, error) {
	raw, err := json.Marshal(rows)
	if err != nil {
		return "", err
	}
	var id string
	err = s.pool.QueryRow(ctx, `
		INSERT INTO import_jobs (profile_id, user_id, source, overwrite, mark_watched, dry_run, total, rows)
		VALUES ($1, $2, 'kinopoisk', $3, $4, $5, $6, $7) RETURNING id`,
		profileID, userID, o.Overwrite, o.MarkWatched, o.DryRun, len(rows), raw).Scan(&id)
	if db.IsUniqueViolation(err) {
		return "", ErrActive
	}
	if err != nil {
		return "", err
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
	return id, nil
}

const jobCols = `id, profile_id, user_id, source, status, overwrite, mark_watched, dry_run, total, error, created_at, started_at, finished_at`

func scanJob(row pgx.Row) (*Job, error) {
	var j Job
	err := row.Scan(&j.ID, &j.ProfileID, &j.userID, &j.Source, &j.Status, &j.Overwrite, &j.MarkWatched, &j.DryRun,
		&j.Total, &j.Error, &j.CreatedAt, &j.StartedAt, &j.FinishedAt)
	if db.IsNoRows(err) {
		return nil, ErrNotFound
	}
	return &j, err
}

// Get returns a job of the caller's (user_id) with its progress.
func (s *Service) Get(ctx context.Context, userID, jobID string) (*Job, error) {
	j, err := scanJob(s.pool.QueryRow(ctx, `SELECT `+jobCols+` FROM import_jobs WHERE id = $1 AND user_id = $2`, jobID, userID))
	if err != nil {
		return nil, err
	}
	return j, s.fill(ctx, j)
}

// Latest returns the profile's most recent job (ErrNotFound when none).
func (s *Service) Latest(ctx context.Context, profileID string) (*Job, error) {
	j, err := scanJob(s.pool.QueryRow(ctx, `SELECT `+jobCols+` FROM import_jobs WHERE profile_id = $1
		ORDER BY created_at DESC, id DESC LIMIT 1`, profileID))
	if err != nil {
		return nil, err
	}
	return j, s.fill(ctx, j)
}

// fill computes counts and the unmatched list from the processed items.
func (s *Service) fill(ctx context.Context, j *Job) error {
	j.Unmatched = []Unmatched{}
	rows, err := s.pool.Query(ctx, `SELECT result, count(*) FROM import_job_items WHERE job_id = $1 GROUP BY result`, j.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var res string
		var n int
		if err := rows.Scan(&res, &n); err != nil {
			rows.Close()
			return err
		}
		j.Processed += n
		switch res {
		case "rated":
			j.Rated, j.Matched = j.Rated+n, j.Matched+n
		case "skipped":
			j.Skipped, j.Matched = j.Skipped+n, j.Matched+n
		case "matched":
			j.Matched += n
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	rows, err = s.pool.Query(ctx, `SELECT kp_id, title, year, COALESCE(reason, '') FROM import_job_items
		WHERE job_id = $1 AND result = 'unmatched' ORDER BY row_no`, j.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var u Unmatched
		if err := rows.Scan(&u.KPID, &u.Title, &u.Year, &u.Reason); err != nil {
			return err
		}
		j.Unmatched = append(j.Unmatched, u)
	}
	return rows.Err()
}

// ---- runner ----

// Run processes queued and running jobs (oldest first) until ctx ends. On
// boot this resumes jobs interrupted by a restart; afterwards Create wakes
// it. Jobs run one at a time; lines within a job run Concurrency at once.
func (s *Service) Run(ctx context.Context) {
	tick := time.NewTicker(time.Minute) // safety net (another replica's job, a lost wake-up)
	defer tick.Stop()
	for {
		for ctx.Err() == nil {
			ran, err := s.RunNext(ctx)
			if err != nil && ctx.Err() == nil {
				s.log.WarnContext(ctx, "import job failed", "err", err)
			}
			if !ran {
				break
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		case <-tick.C:
		}
	}
}

// RunNext claims the oldest unfinished job and processes it to the end.
// It reports whether there was one.
func (s *Service) RunNext(ctx context.Context) (bool, error) {
	var (
		j   Job
		raw []byte
	)
	// Claim: a running job is resumed (a restart interrupted it).
	err := s.pool.QueryRow(ctx, `
		UPDATE import_jobs SET status = 'running', started_at = COALESCE(started_at, now())
		WHERE id = (SELECT id FROM import_jobs WHERE status IN ('queued', 'running')
		            ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING id, profile_id, user_id, overwrite, mark_watched, dry_run, total, rows`).
		Scan(&j.ID, &j.ProfileID, &j.userID, &j.Overwrite, &j.MarkWatched, &j.DryRun, &j.Total, &raw)
	if db.IsNoRows(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var rows []Row
	if err := json.Unmarshal(raw, &rows); err != nil {
		return true, s.finish(ctx, &j, fmt.Errorf("stored rows unreadable: %w", err))
	}
	if err := s.process(ctx, &j, rows); err != nil {
		if ctx.Err() != nil {
			return true, nil // shutting down: stays running, resumed on boot
		}
		return true, s.finish(ctx, &j, err)
	}
	return true, s.finish(ctx, &j, nil)
}

// process handles every line without an item yet.
func (s *Service) process(ctx context.Context, j *Job, rows []Row) error {
	done := map[int]bool{}
	r, err := s.pool.Query(ctx, `SELECT row_no FROM import_job_items WHERE job_id = $1`, j.ID)
	if err != nil {
		return err
	}
	nums, err := pgx.CollectRows(r, pgx.RowTo[int32])
	if err != nil {
		return err
	}
	for _, n := range nums {
		done[int(n)] = true
	}

	work := make(chan int)
	errc := make(chan error, Concurrency)
	var wg sync.WaitGroup
	for range Concurrency {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range work {
				if err := s.line(ctx, j, i, rows[i]); err != nil {
					errc <- err
					return
				}
			}
		}()
	}
	var firstErr error
feed:
	for i := range rows {
		if done[i] {
			continue
		}
		select {
		case work <- i:
		case firstErr = <-errc:
			break feed
		case <-ctx.Done():
			break feed
		}
	}
	close(work)
	wg.Wait()
	close(errc)
	if firstErr == nil {
		firstErr = <-errc
	}
	if firstErr == nil && ctx.Err() != nil {
		firstErr = ctx.Err()
	}
	return firstErr
}

// item is one processed line.
type item struct {
	result, reason, how string
	mediaID             *string
}

// line matches and applies one CSV line. Only database errors (and
// shutdown) are returned; a TMDB failure is retried, then recorded.
func (s *Service) line(ctx context.Context, j *Job, i int, r Row) error {
	var it item
	switch {
	case r.Invalid != "":
		it = item{result: "unmatched", reason: ReasonInvalid}
	default:
		m, reason, err := s.match(ctx, r)
		switch {
		case err != nil && ctx.Err() != nil:
			return ctx.Err()
		case err != nil:
			s.log.WarnContext(ctx, "import: tmdb failed", "job_id", j.ID, "line", r.Line, "err", err)
			it = item{result: "unmatched", reason: ReasonTMDB}
		case m == nil:
			it = item{result: "unmatched", reason: reason}
		default:
			it = item{result: "matched", how: m.How, mediaID: &m.MediaID}
		}
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if it.mediaID != nil && !j.DryRun {
			if err := s.apply(ctx, tx, j, r, *it.mediaID, &it); err != nil {
				return err
			}
		}
		var year *int
		if r.Year > 0 {
			year = &r.Year
		}
		var reason, how *string
		if it.reason != "" {
			reason = &it.reason
		}
		if it.how != "" {
			how = &it.how
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO import_job_items (job_id, row_no, kp_id, title, year, result, reason, how, media_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
			j.ID, i, r.KPID, r.Title(), year, it.result, reason, how, it.mediaID)
		return err
	})
}

// match: an existing Kinopoisk mapping, else TMDB search (retried twice).
func (s *Service) match(ctx context.Context, r Row) (*Match, string, error) {
	var id, kind string
	err := s.pool.QueryRow(ctx, `
		SELECT id, kind FROM media WHERE kp_id = $1
		UNION ALL
		SELECT m.id, m.kind FROM media_external_ids e JOIN media m ON m.id = e.media_id
		WHERE e.provider = 'kinopoisk' AND e.external_id = $2
		LIMIT 1`, r.KPID, strconv.Itoa(r.KPID)).Scan(&id, &kind)
	if err == nil {
		return &Match{MediaID: id, Kind: kind, How: "kp_id"}, "", nil
	}
	if !db.IsNoRows(err) {
		return nil, "", err
	}
	var lastErr error
	for attempt := range 3 {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, "", ctx.Err()
			case <-time.After(s.retryWait * time.Duration(attempt)):
			}
		}
		m, reason, err := matchTMDB(ctx, s.cat, r)
		if err == nil {
			if m != nil {
				// A title already mapped to ANOTHER Kinopoisk id (by IMDb id,
				// the stronger evidence) means this title match is wrong.
				var other *int
				if err := s.pool.QueryRow(ctx, `SELECT kp_id FROM media WHERE id = $1`, m.MediaID).Scan(&other); err != nil {
					return nil, "", err
				}
				if other != nil && *other != r.KPID {
					return nil, ReasonConflict, nil
				}
			}
			return m, reason, nil
		}
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		lastErr = err
	}
	return nil, "", lastErr
}

// apply writes the Kinopoisk id/rating facts, the profile's rating and the
// watched mark for a matched line.
func (s *Service) apply(ctx context.Context, tx pgx.Tx, j *Job, r Row, mediaID string, it *item) error {
	// Kinopoisk id (never replacing another) + its mirror; seed the KP
	// rating when the title has none yet (the keyless refresh replaces it).
	if _, err := tx.Exec(ctx, `
		UPDATE media SET
			kp_id     = COALESCE(kp_id, $2),
			kp_votes  = CASE WHEN kp_rating IS NULL AND $3::float8 IS NOT NULL THEN $4 ELSE kp_votes END,
			kp_rating = COALESCE(kp_rating, $3),
			kp_lookup_failed_at = NULL
		WHERE id = $1`, mediaID, r.KPID, r.KPRating, r.KPVotes); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO media_external_ids (media_id, provider, external_id)
		SELECT $1::uuid, 'kinopoisk', $2::text WHERE NOT EXISTS (
			SELECT 1 FROM media_external_ids WHERE media_id = $1::uuid AND provider = 'kinopoisk')
		ON CONFLICT DO NOTHING`, mediaID, strconv.Itoa(r.KPID)); err != nil {
		return err
	}

	at := time.Now().UTC()
	if r.RatedAt != nil {
		at = *r.RatedAt
	}
	sql := `INSERT INTO ratings (profile_id, media_id, rating, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)
		ON CONFLICT (profile_id, media_id) DO NOTHING`
	if j.Overwrite {
		sql = `INSERT INTO ratings (profile_id, media_id, rating, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)
			ON CONFLICT (profile_id, media_id) DO UPDATE SET rating = EXCLUDED.rating, updated_at = EXCLUDED.updated_at`
	}
	tag, err := tx.Exec(ctx, sql, j.ProfileID, mediaID, r.MyRating, at)
	if err != nil {
		return err
	}
	it.result = "rated"
	if tag.RowsAffected() == 0 {
		it.result = "skipped"
	}

	if j.MarkWatched {
		// One completed, non-resumable row per title (movies and series
		// alike: episode_id NULL), dated when it was rated. Never resumable,
		// and its updated_at is the old rating date, so it stays out of
		// "continue watching"; no watch_events / sessions, so the activity
		// views don't see it. Existing progress is left alone.
		if _, err := tx.Exec(ctx, `
			INSERT INTO watch_progress (profile_id, media_id, episode_id, position_seconds, percent, completed,
				completed_at, manual, resumable, started_at, updated_at)
			VALUES ($1, $2, NULL, 0, 1, true, $3, true, false, $3, $3)
			ON CONFLICT ON CONSTRAINT watch_progress_item_key DO NOTHING`, j.ProfileID, mediaID, at); err != nil {
			return err
		}
	}
	return nil
}

// finish marks a job done (or failed), drops the stored rows and audits
// the counts.
func (s *Service) finish(ctx context.Context, j *Job, cause error) error {
	status, msg := "done", (*string)(nil)
	if cause != nil {
		status = "failed"
		m := "The import stopped unexpectedly."
		msg = &m
		s.log.ErrorContext(ctx, "import job failed", "job_id", j.ID, "err", cause)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE import_jobs SET status = $2, error = $3, rows = NULL, finished_at = now() WHERE id = $1`,
		j.ID, status, msg); err != nil {
		return err
	}
	if err := s.fill(ctx, j); err != nil {
		return err
	}
	s.audit.Record(ctx, audit.Event{
		UserID: j.userID, Action: "imports.kinopoisk", TargetType: "profile", TargetID: j.ProfileID,
		Metadata: map[string]any{
			"status": status, "dry_run": j.DryRun, "total": j.Total, "matched": j.Matched,
			"rated": j.Rated, "skipped": j.Skipped, "unmatched": len(j.Unmatched),
		},
	})
	return nil
}
