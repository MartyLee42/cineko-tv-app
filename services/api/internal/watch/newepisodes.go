package watch

// «Новые серии»: once a night the server refreshes the episodes of every
// profile's series from TMDB and records the episodes that aired after what
// the profile watched. A profile's series ("my series"): any episode progress
// in the last year, the title is in its watchlist or favorites, or — only
// while the series is ongoing (TMDB "Returning Series" / "In Production", or
// an episode still to air) — it was rated on Kinopoisk and imported. For a
// Kinopoisk-only series nothing is known about episodes, so only episodes
// that aired after the import count (on top of the window below).
//
// What counts as new for a profile: a regular-season episode that has aired
// (air date ≤ today in the household timezone), comes after the furthest
// episode the profile has watched (or marked watched), has no progress of its
// own, and aired inside the look-back window: 14 days, or back to two days
// before the previous completed check when that is longer ago (so the first
// check never floods the list with a backlog, and a server that was down for
// a while still catches up). Each (profile, episode) is recorded once.
//
// An item counts as seen once the profile marks it (or all) seen, watches the
// episode, or watches a later one.
//
// A profile can mute a series (new_episode_mutes): it's no longer "mine" for
// the check (not refreshed unless another profile has it, nothing recorded)
// and its existing items are hidden from the list and the unseen count; they
// come back on unmute (so «undo» restores them).

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"martytv/api/internal/catalog"
	"martytv/api/internal/config"
)

const (
	newEpisodesWindow = 14 * 24 * time.Hour
	// Shown in the list: seen items stay this long after airing.
	newEpisodesKeepSeen = 30
	newEpisodesMax      = 100
	// Pause between series refreshes (TMDB rate limit).
	newEpisodesPause = 250 * time.Millisecond
)

// mineSQL: (profile, series, kp_only, imported) for every profile's series.
// $tz is the household timezone (import dates). Progress rows without an
// episode are the Kinopoisk import's per-title marks, not real watching.
const mineSQL = `
	src AS (
		SELECT profile_id, media_id, false AS kp, NULL::date AS imported FROM watch_progress
		WHERE episode_id IS NOT NULL AND updated_at > now() - interval '365 days'
		UNION ALL SELECT profile_id, media_id, false, NULL FROM watchlist_items
		UNION ALL SELECT profile_id, media_id, false, NULL FROM favorites
		UNION ALL SELECT j.profile_id, i.media_id, true, (coalesce(j.finished_at, j.created_at) AT TIME ZONE %[1]s)::date
		FROM import_job_items i JOIN import_jobs j ON j.id = i.job_id
		WHERE j.status = 'done' AND NOT j.dry_run AND i.result IN ('rated', 'skipped') AND i.media_id IS NOT NULL
	), mine AS (
		SELECT s.profile_id, s.media_id, bool_and(s.kp) AS kp_only, min(s.imported) AS imported
		FROM src s JOIN media m ON m.id = s.media_id AND m.kind = 'series'
		WHERE NOT EXISTS (SELECT 1 FROM new_episode_mutes nm WHERE nm.profile_id = s.profile_id AND nm.media_id = s.media_id)
		GROUP BY s.profile_id, s.media_id
	)`

// ongoingSQL: the series m is still running (or not refreshed yet when unknownOK).
const ongoingSQL = `(m.status IN ('Returning Series', 'In Production')
	OR EXISTS (SELECT 1 FROM episodes f WHERE f.media_id = m.id AND f.air_date > %[1]s))`

// ErrCheckRunning: a check is already in progress.
var ErrCheckRunning = errors.New("watch: new-episodes check already running")

type newEpisodesState struct {
	cfg     config.NewEpisodesConfig
	mu      sync.Mutex
	running bool
	pause   time.Duration
	baseCtx context.Context
}

// SetNewEpisodes configures the nightly check (before Run).
func (s *Service) SetNewEpisodes(cfg config.NewEpisodesConfig) {
	if cfg.Location == nil {
		cfg.Location = time.UTC
	}
	if cfg.Lang == "" {
		cfg.Lang = "ru"
	}
	s.ne.cfg = cfg
	s.ne.pause = newEpisodesPause
}

// SetNewEpisodesPause changes the pause between series refreshes (tests).
func (s *Service) SetNewEpisodesPause(d time.Duration) { s.ne.pause = d }

// NextNightly is the next HH:MM in cfg.Location strictly after now (nil when off).
func NextNightly(now time.Time, cfg config.NewEpisodesConfig) *time.Time {
	if cfg.Off {
		return nil
	}
	loc := cfg.Location
	if loc == nil {
		loc = time.UTC
	}
	l := now.In(loc)
	next := time.Date(l.Year(), l.Month(), l.Day(), cfg.Hour, cfg.Minute, 0, 0, loc)
	if !next.After(l) {
		next = time.Date(l.Year(), l.Month(), l.Day()+1, cfg.Hour, cfg.Minute, 0, 0, loc)
	}
	t := next.UTC()
	return &t
}

// RunNewEpisodes is the nightly scheduler (started from main). A check that
// hasn't completed in the last 24 h runs a few minutes after start.
func (s *Service) RunNewEpisodes(ctx context.Context) {
	s.ne.mu.Lock()
	s.ne.baseCtx = ctx
	s.ne.mu.Unlock()
	if _, err := s.pool.Exec(ctx, `
		UPDATE new_episode_runs SET status = 'failed', finished_at = now(), error = 'interrupted by restart'
		WHERE status = 'running'`); err != nil && ctx.Err() == nil {
		s.log.Warn("new episodes: could not close stale runs", "err", err)
	}
	if s.ne.cfg.Off {
		s.log.Info("new episodes: nightly check disabled (NEW_EPISODES_AT=off)")
		return
	}
	var recent bool
	_ = s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM new_episode_runs WHERE status = 'completed'
		AND started_at > now() - interval '24 hours')`).Scan(&recent)
	wait := time.Until(*NextNightly(s.now(), s.ne.cfg))
	trigger := "schedule"
	if !recent && wait > time.Hour {
		wait, trigger = 5*time.Minute, "startup"
	}
	for {
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		if _, err := s.CheckNewEpisodes(ctx, trigger); err != nil && ctx.Err() == nil {
			s.log.Warn("new episodes: check failed", "trigger", trigger, "err", err)
		}
		trigger = "schedule"
		wait = time.Until(*NextNightly(s.now().Add(time.Minute), s.ne.cfg))
	}
}

// NewEpisodeRun is the contract's NewEpisodeRun.
type NewEpisodeRun struct {
	ID            int64      `json:"id"`
	Trigger       string     `json:"trigger"`
	Status        string     `json:"status"`
	StartedAt     time.Time  `json:"started_at"`
	FinishedAt    *time.Time `json:"finished_at"`
	SeriesChecked int        `json:"series_checked"`
	RefreshErrors int        `json:"refresh_errors"`
	Found         int        `json:"found"`
	Error         *string    `json:"error"`
}

func (s *Service) beginCheck() bool {
	s.ne.mu.Lock()
	defer s.ne.mu.Unlock()
	if s.ne.running {
		return false
	}
	s.ne.running = true
	return true
}

func (s *Service) endCheck() {
	s.ne.mu.Lock()
	s.ne.running = false
	s.ne.mu.Unlock()
}

// StartNewEpisodesCheck runs a check in the background (admin «run now»).
func (s *Service) StartNewEpisodesCheck() error {
	if !s.beginCheck() {
		return ErrCheckRunning
	}
	s.ne.mu.Lock()
	base := s.ne.baseCtx
	s.ne.mu.Unlock()
	if base == nil {
		base = context.Background()
	}
	go func() {
		defer s.endCheck()
		if _, err := s.checkNewEpisodes(base, "manual"); err != nil && base.Err() == nil {
			s.log.Warn("new episodes: manual check failed", "err", err)
		}
	}()
	return nil
}

// CheckNewEpisodes refreshes "my series" and records new episodes (synchronously).
func (s *Service) CheckNewEpisodes(ctx context.Context, trigger string) (*NewEpisodeRun, error) {
	if !s.beginCheck() {
		return nil, ErrCheckRunning
	}
	defer s.endCheck()
	return s.checkNewEpisodes(ctx, trigger)
}

func (s *Service) checkNewEpisodes(ctx context.Context, trigger string) (*NewEpisodeRun, error) {
	cfg := s.ne.cfg
	if cfg.Location == nil {
		cfg.Location = time.UTC
	}
	var runID int64
	var prev *time.Time
	if err := s.pool.QueryRow(ctx, `SELECT max(started_at) FROM new_episode_runs WHERE status = 'completed'`).Scan(&prev); err != nil {
		return nil, err
	}
	if err := s.pool.QueryRow(ctx, `INSERT INTO new_episode_runs (trigger, status) VALUES ($1, 'running') RETURNING id`, trigger).Scan(&runID); err != nil {
		return nil, err
	}
	run := &NewEpisodeRun{ID: runID, Trigger: trigger, Status: "running"}
	fail := func(err error) (*NewEpisodeRun, error) {
		msg := err.Error()
		_, _ = s.pool.Exec(context.Background(), `UPDATE new_episode_runs SET status = 'failed', finished_at = now(), error = $2,
			series_checked = $3, refresh_errors = $4 WHERE id = $1`, runID, msg, run.SeriesChecked, run.RefreshErrors)
		return nil, err
	}

	series, err := s.mySeries(ctx)
	if err != nil {
		return fail(err)
	}
	if s.catalog != nil && s.catalog.Available() {
		for i, id := range series {
			if i > 0 && s.ne.pause > 0 {
				select {
				case <-ctx.Done():
					return fail(ctx.Err())
				case <-time.After(s.ne.pause):
				}
			}
			if err := s.catalog.RefreshSeries(ctx, id, cfg.Lang); err != nil {
				if ctx.Err() != nil {
					return fail(ctx.Err())
				}
				run.RefreshErrors++
				if !errors.Is(err, catalog.ErrNotFound) {
					s.log.Info("new episodes: refresh failed", "media_id", id, "err", err)
				}
			}
			run.SeriesChecked++
		}
	}

	today := s.now().In(cfg.Location)
	todayDate := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
	since := todayDate.Add(-newEpisodesWindow)
	if prev != nil {
		p := prev.In(cfg.Location)
		pd := time.Date(p.Year(), p.Month(), p.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -2)
		if pd.Before(since) {
			since = pd
		}
	}
	tag, err := s.pool.Exec(ctx, `
		WITH `+fmt.Sprintf(mineSQL, "$3::text")+`, furthest AS (
			SELECT wp.profile_id, wp.media_id, max(e.season_number * 10000 + e.episode_number) AS k
			FROM watch_progress wp JOIN episodes e ON e.id = wp.episode_id
			WHERE e.season_number > 0
			GROUP BY wp.profile_id, wp.media_id
		)
		INSERT INTO new_episodes (profile_id, episode_id, media_id, air_date, source)
		SELECT mine.profile_id, e.id, e.media_id, e.air_date, CASE WHEN mine.kp_only THEN 'kinopoisk' END
		FROM mine
		JOIN media m ON m.id = mine.media_id
		JOIN episodes e ON e.media_id = mine.media_id
		LEFT JOIN furthest f ON f.profile_id = mine.profile_id AND f.media_id = mine.media_id
		WHERE e.season_number > 0 AND e.air_date IS NOT NULL
		  AND e.air_date <= $1::date AND e.air_date >= $2::date
		  AND e.season_number * 10000 + e.episode_number > coalesce(f.k, 0)
		  AND NOT EXISTS (SELECT 1 FROM watch_progress w WHERE w.profile_id = mine.profile_id AND w.episode_id = e.id)
		  AND (NOT mine.kp_only OR (e.air_date > mine.imported AND `+fmt.Sprintf(ongoingSQL, "$1::date")+`))
		ON CONFLICT DO NOTHING`, todayDate, since, cfg.Location.String())
	if err != nil {
		return fail(err)
	}
	run.Found = int(tag.RowsAffected())
	run.Status = "completed"
	if err := s.pool.QueryRow(ctx, `
		UPDATE new_episode_runs SET status = 'completed', finished_at = now(), series_checked = $2, refresh_errors = $3, found = $4
		WHERE id = $1 RETURNING started_at, finished_at`, runID, run.SeriesChecked, run.RefreshErrors, run.Found).Scan(&run.StartedAt, &run.FinishedAt); err != nil {
		return nil, err
	}
	s.log.Info("new episodes: check done", "trigger", trigger, "series", run.SeriesChecked, "refresh_errors", run.RefreshErrors, "found", run.Found)
	return run, nil
}

// mySeries: every profile's series (union), skipping long-finished ones;
// Kinopoisk-only series only while ongoing (or not refreshed yet: status unknown).
func (s *Service) mySeries(ctx context.Context) ([]string, error) {
	loc := "UTC"
	if s.ne.cfg.Location != nil {
		loc = s.ne.cfg.Location.String()
	}
	rows, err := s.pool.Query(ctx, `
		WITH `+fmt.Sprintf(mineSQL, "$1::text")+`
		SELECT DISTINCT m.id FROM mine JOIN media m ON m.id = mine.media_id
		WHERE NOT (m.status IN ('Ended', 'Canceled') AND m.last_air_date IS NOT NULL AND m.last_air_date < current_date - 60)
		  AND (NOT mine.kp_only OR m.status = '' OR `+fmt.Sprintf(ongoingSQL, "current_date")+`)
		ORDER BY m.id`, loc)
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

// ---- reading ----

// NewEpisodeItem is the contract's NewEpisodeItem.
type NewEpisodeItem struct {
	Media      catalog.MediaSummary `json:"media"`
	Episode    catalog.Episode      `json:"episode"`
	DetectedAt time.Time            `json:"detected_at"`
	Seen       bool                 `json:"seen"`
	// Source: "kinopoisk" when the series is the profile's only through a Kinopoisk import.
	Source *string `json:"source"`
}

// NewEpisodeList is the contract's NewEpisodeList.
type NewEpisodeList struct {
	Items  []NewEpisodeItem `json:"items"`
	Unseen int              `json:"unseen"`
}

type epTranslation struct {
	Name     string `json:"name"`
	Overview string `json:"overview"`
}

// NewEpisodes lists a profile's new episodes: unseen first (newest first),
// then seen ones that aired in the last 30 days.
func (s *Service) NewEpisodes(ctx context.Context, profileID, lang string) (*NewEpisodeList, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT ne.media_id, ne.detected_at, ne.source,
		       ne.seen_at IS NOT NULL OR coalesce(f.k, 0) >= e.season_number * 10000 + e.episode_number AS seen,
		       e.id, e.season_number, e.episode_number, e.air_date, e.runtime, e.still_path, e.vote_average, e.vote_count, e.translations
		FROM new_episodes ne
		JOIN episodes e ON e.id = ne.episode_id
		LEFT JOIN LATERAL (
			SELECT max(e2.season_number * 10000 + e2.episode_number) AS k
			FROM watch_progress wp JOIN episodes e2 ON e2.id = wp.episode_id
			WHERE wp.profile_id = ne.profile_id AND wp.media_id = ne.media_id
		) f ON true
		WHERE ne.profile_id = $1
		  AND NOT EXISTS (SELECT 1 FROM new_episode_mutes nm WHERE nm.profile_id = ne.profile_id AND nm.media_id = ne.media_id)
		ORDER BY seen, ne.air_date DESC, e.season_number DESC, e.episode_number DESC
		LIMIT 500`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keepFrom := s.now().AddDate(0, 0, -newEpisodesKeepSeen)
	out := &NewEpisodeList{Items: []NewEpisodeItem{}}
	var ids []string
	seenIDs := map[string]bool{}
	for rows.Next() {
		var (
			it    NewEpisodeItem
			air   *time.Time
			avg   float64
			votes int
			trs   map[string]epTranslation
		)
		if err := rows.Scan(&it.Media.ID, &it.DetectedAt, &it.Source, &it.Seen, &it.Episode.ID, &it.Episode.SeasonNumber, &it.Episode.EpisodeNumber,
			&air, &it.Episode.Runtime, &it.Episode.StillPath, &avg, &votes, &trs); err != nil {
			return nil, err
		}
		if it.Seen && (air == nil || air.Before(keepFrom)) {
			continue
		}
		if !it.Seen {
			out.Unseen++
		}
		if len(out.Items) >= newEpisodesMax {
			continue
		}
		t, en := trs[lang], trs["en"]
		it.Episode.Name = firstNonEmpty(t.Name, en.Name)
		it.Episode.Overview = firstNonEmpty(t.Overview, en.Overview)
		if air != nil {
			d := air.Format("2006-01-02")
			it.Episode.AirDate = &d
		}
		if votes > 0 && avg > 0 {
			r := avg
			it.Episode.Rating = &r
		}
		out.Items = append(out.Items, it)
		if !seenIDs[it.Media.ID] {
			seenIDs[it.Media.ID] = true
			ids = append(ids, it.Media.ID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return out, nil
	}
	sums, err := s.summaries(ctx, profileID, ids, lang)
	if err != nil {
		return nil, err
	}
	items := out.Items[:0]
	for _, it := range out.Items {
		m, ok := sums[it.Media.ID]
		if !ok {
			continue
		}
		it.Media = m
		items = append(items, it)
	}
	out.Items = items
	return out, nil
}

// MarkNewEpisodesSeen marks the given episodes (or all when ids is empty and all is set) seen.
func (s *Service) MarkNewEpisodesSeen(ctx context.Context, profileID string, episodeIDs []string, all bool) error {
	if all {
		_, err := s.pool.Exec(ctx, `UPDATE new_episodes SET seen_at = now() WHERE profile_id = $1 AND seen_at IS NULL`, profileID)
		return err
	}
	_, err := s.pool.Exec(ctx, `UPDATE new_episodes SET seen_at = now() WHERE profile_id = $1 AND episode_id = ANY($2::uuid[]) AND seen_at IS NULL`,
		profileID, episodeIDs)
	return err
}

// ---- muted series ----

// ErrNotSeries: only series can be muted.
var ErrNotSeries = errors.New("watch: not a series")

// MutedSeries is the contract's MutedSeries.
type MutedSeries struct {
	Media   catalog.MediaSummary `json:"media"`
	MutedAt time.Time            `json:"muted_at"`
}

// MuteSeries stops «Новые серии» for a series on this profile (idempotent).
func (s *Service) MuteSeries(ctx context.Context, profileID, mediaID string) error {
	kind, err := s.mediaKind(ctx, mediaID)
	if err != nil {
		return err
	}
	if kind != "series" {
		return ErrNotSeries
	}
	_, err = s.pool.Exec(ctx, `INSERT INTO new_episode_mutes (profile_id, media_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		profileID, mediaID)
	return err
}

// UnmuteSeries is idempotent.
func (s *Service) UnmuteSeries(ctx context.Context, profileID, mediaID string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM new_episode_mutes WHERE profile_id = $1 AND media_id = $2`, profileID, mediaID)
	return err
}

// MutedSeriesList: the profile's muted series, newest first.
func (s *Service) MutedSeriesList(ctx context.Context, profileID, lang string) ([]MutedSeries, error) {
	rows, err := s.pool.Query(ctx, `SELECT media_id, created_at FROM new_episode_mutes WHERE profile_id = $1
		ORDER BY created_at DESC, media_id LIMIT 500`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MutedSeries{}
	var ids []string
	for rows.Next() {
		var it MutedSeries
		if err := rows.Scan(&it.Media.ID, &it.MutedAt); err != nil {
			return nil, err
		}
		out = append(out, it)
		ids = append(ids, it.Media.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return out, nil
	}
	sums, err := s.summaries(ctx, profileID, ids, lang)
	if err != nil {
		return nil, err
	}
	items := out[:0]
	for _, it := range out {
		if m, ok := sums[it.Media.ID]; ok {
			it.Media = m
			items = append(items, it)
		}
	}
	return items, nil
}

// NewEpisodesStatus is the contract's NewEpisodesStatus (admin).
type NewEpisodesStatus struct {
	At        string          `json:"at"`
	Timezone  string          `json:"timezone"`
	NextRunAt *time.Time      `json:"next_run_at"`
	Running   bool            `json:"running"`
	Runs      []NewEpisodeRun `json:"runs"`
}

// NewEpisodesAdminStatus: schedule and the last runs.
func (s *Service) NewEpisodesAdminStatus(ctx context.Context) (*NewEpisodesStatus, error) {
	cfg := s.ne.cfg
	st := &NewEpisodesStatus{At: cfg.At(), Runs: []NewEpisodeRun{}, NextRunAt: NextNightly(s.now(), cfg)}
	if cfg.Location != nil {
		st.Timezone = cfg.Location.String()
	}
	s.ne.mu.Lock()
	st.Running = s.ne.running
	s.ne.mu.Unlock()
	rows, err := s.pool.Query(ctx, `
		SELECT id, trigger, status, started_at, finished_at, series_checked, refresh_errors, found, error
		FROM new_episode_runs ORDER BY started_at DESC, id DESC LIMIT 10`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r NewEpisodeRun
		if err := rows.Scan(&r.ID, &r.Trigger, &r.Status, &r.StartedAt, &r.FinishedAt, &r.SeriesChecked, &r.RefreshErrors, &r.Found, &r.Error); err != nil {
			return nil, err
		}
		st.Runs = append(st.Runs, r)
	}
	return st, rows.Err()
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
