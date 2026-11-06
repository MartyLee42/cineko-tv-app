package watch

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"

	"martytv/api/internal/catalog"
)

// epInfo is one stored episode of a series.
type epInfo struct {
	id             string
	season, number int
	airDate        *time.Time
	trs            map[string]struct {
		Name string `json:"name"`
	}
}

func (e *epInfo) aired(today time.Time) bool {
	return e.airDate != nil && !e.airDate.After(today)
}

func (e *epInfo) name(lang string) string {
	if n := e.trs[lang].Name; n != "" {
		return n
	}
	return e.trs["en"].Name
}

type seasonInfo struct {
	number, episodeCount int
	airDate              *time.Time
}

// seriesData is everything needed for series progress of one profile.
type seriesData struct {
	eps      []epInfo // ordered by season, episode
	seasons  []seasonInfo
	progress []WatchProgress // episode rows
}

// loadSeries batch-loads episodes, seasons and progress for several series.
func (s *Service) loadSeries(ctx context.Context, profileID string, mediaIDs []string) (map[string]*seriesData, error) {
	out := make(map[string]*seriesData, len(mediaIDs))
	for _, id := range mediaIDs {
		out[id] = &seriesData{}
	}
	if len(mediaIDs) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT media_id, id, season_number, episode_number, air_date, translations FROM episodes
		WHERE media_id = ANY($1::uuid[]) ORDER BY media_id, season_number, episode_number`, mediaIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var mid string
		var e epInfo
		if err := rows.Scan(&mid, &e.id, &e.season, &e.number, &e.airDate, &e.trs); err != nil {
			rows.Close()
			return nil, err
		}
		out[mid].eps = append(out[mid].eps, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = s.pool.Query(ctx, `
		SELECT media_id, season_number, episode_count, air_date FROM seasons
		WHERE media_id = ANY($1::uuid[]) ORDER BY media_id, season_number`, mediaIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var mid string
		var si seasonInfo
		if err := rows.Scan(&mid, &si.number, &si.episodeCount, &si.airDate); err != nil {
			rows.Close()
			return nil, err
		}
		out[mid].seasons = append(out[mid].seasons, si)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	prog, err := queryProgress(ctx, s.pool, `SELECT `+progressCols+progressFrom+`
		WHERE wp.profile_id = $1 AND wp.media_id = ANY($2::uuid[]) AND wp.episode_id IS NOT NULL
		ORDER BY e.season_number, e.episode_number`, profileID, mediaIDs)
	if err != nil {
		return nil, err
	}
	for _, p := range prog {
		out[p.MediaID].progress = append(out[p.MediaID].progress, p)
	}
	return out, nil
}

func today() time.Time {
	y, m, d := time.Now().UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// seasonCounts: total = aired episodes (stored episodes when the season is
// loaded, else the season's episode_count once it has started airing).
func (sd *seriesData) seasonCounts(now time.Time) []SeasonCount {
	done := map[string]bool{}
	for _, p := range sd.progress {
		if p.Completed && p.EpisodeID != nil {
			done[*p.EpisodeID] = true
		}
	}
	byNum := map[int]*SeasonCount{}
	loaded := map[int]bool{}
	var order []int
	get := func(n int) *SeasonCount {
		if c, ok := byNum[n]; ok {
			return c
		}
		c := &SeasonCount{SeasonNumber: n}
		byNum[n] = c
		order = append(order, n)
		return c
	}
	for _, e := range sd.eps {
		c := get(e.season)
		loaded[e.season] = true
		if e.aired(now) {
			c.Total++
		}
		if done[e.id] {
			c.Completed++
		}
	}
	for _, si := range sd.seasons {
		c := get(si.number)
		if !loaded[si.number] && si.airDate != nil && !si.airDate.After(now) {
			c.Total = si.episodeCount
		}
	}
	slices.Sort(order)
	out := make([]SeasonCount, 0, len(order))
	for _, n := range order {
		c := byNum[n]
		c.Total = max(c.Total, c.Completed)
		out = append(out, *c)
	}
	return out
}

// nextUp implements the series rule (specials, season 0, are never suggested):
//  1. the most recently updated episode row is a resume point → that episode;
//  2. else the first aired, not completed episode after the most recently
//     completed one (rolling into later seasons);
//  3. else the most recent in-progress (resumable) episode;
//  4. else, if the profile has any progress but nothing completed, the first
//     aired uncompleted episode; with no progress at all → nil (a series the
//     profile never started has no "next up").
func (sd *seriesData) nextUp(now time.Time, lang string) *NextUp {
	if len(sd.progress) == 0 {
		return nil
	}
	idx := map[string]int{}
	for i, e := range sd.eps {
		idx[e.id] = i
	}
	done := map[string]bool{}
	var latest, lastDone, lastResumable *WatchProgress
	for i := range sd.progress {
		p := &sd.progress[i]
		if p.EpisodeID == nil {
			continue
		}
		if _, ok := idx[*p.EpisodeID]; !ok || sd.eps[idx[*p.EpisodeID]].season == 0 {
			continue
		}
		if latest == nil || p.UpdatedAt.After(latest.UpdatedAt) {
			latest = p
		}
		if p.Completed {
			done[*p.EpisodeID] = true
			if lastDone == nil || laterCompletion(p, lastDone, sd.eps, idx) {
				lastDone = p
			}
		}
		if p.resumable && (lastResumable == nil || p.UpdatedAt.After(lastResumable.UpdatedAt)) {
			lastResumable = p
		}
	}
	mk := func(e *epInfo) *NextUp {
		var air *string
		if e.airDate != nil {
			s := e.airDate.Format("2006-01-02")
			air = &s
		}
		return &NextUp{EpisodeID: e.id, SeasonNumber: e.season, EpisodeNumber: e.number, Name: e.name(lang), AirDate: air}
	}
	if latest == nil {
		return nil
	}
	if latest.resumable {
		return mk(&sd.eps[idx[*latest.EpisodeID]])
	}
	if lastDone != nil {
		for i := idx[*lastDone.EpisodeID] + 1; i < len(sd.eps); i++ {
			e := &sd.eps[i]
			if e.season > 0 && e.aired(now) && !done[e.id] {
				return mk(e)
			}
		}
	}
	if lastResumable != nil {
		return mk(&sd.eps[idx[*lastResumable.EpisodeID]])
	}
	if lastDone == nil {
		for i := range sd.eps {
			e := &sd.eps[i]
			if e.season > 0 && e.aired(now) && !done[e.id] {
				return mk(e)
			}
		}
	}
	return nil
}

// laterCompletion orders completions by completed_at, then by position in
// the series (a season marked at once shares one timestamp).
func laterCompletion(a, b *WatchProgress, eps []epInfo, idx map[string]int) bool {
	at, bt := a.CompletedAt, b.CompletedAt
	if at != nil && bt != nil && !at.Equal(*bt) {
		return at.After(*bt)
	}
	return idx[*a.EpisodeID] > idx[*b.EpisodeID]
}

// missingNextSeason returns a later season (after the latest completed
// episode's season) whose episodes are not stored yet, or -1.
func (sd *seriesData) missingNextSeason(now time.Time) int {
	maxDone := -1
	idx := map[string]int{}
	for i, e := range sd.eps {
		idx[e.id] = i
	}
	for _, p := range sd.progress {
		if p.Completed && p.EpisodeID != nil {
			if i, ok := idx[*p.EpisodeID]; ok {
				maxDone = max(maxDone, sd.eps[i].season)
			}
		}
	}
	if maxDone < 1 {
		return -1
	}
	loaded := map[int]bool{}
	for _, e := range sd.eps {
		loaded[e.season] = true
	}
	for _, si := range sd.seasons {
		if si.number > maxDone && !loaded[si.number] && (si.airDate == nil || !si.airDate.After(now)) {
			return si.number
		}
	}
	return -1
}

// seriesNextUp computes next_up, fetching the next season's episodes from
// TMDB (via the catalog) when the profile reached the end of what is stored.
func (s *Service) seriesNextUp(ctx context.Context, profileID, mediaID string, sd *seriesData, lang string) (*NextUp, *seriesData) {
	now := today()
	nu := sd.nextUp(now, lang)
	for attempt := 0; nu == nil && attempt < 2; attempt++ {
		n := sd.missingNextSeason(now)
		if n < 0 {
			break
		}
		if _, err := s.catalog.Season(ctx, mediaID, n, lang); err != nil {
			s.log.WarnContext(ctx, "next season load failed", "media_id", mediaID, "season", n, "err", err)
			break
		}
		fresh, err := s.loadSeries(ctx, profileID, []string{mediaID})
		if err != nil {
			break
		}
		sd = fresh[mediaID]
		nu = sd.nextUp(now, lang)
	}
	return nu, sd
}

// MediaProgress is GET /media/{id}/progress.
func (s *Service) MediaProgress(ctx context.Context, profileID, mediaID, lang string) (*MediaProgress, error) {
	kind, err := s.mediaKind(ctx, mediaID)
	if err != nil {
		return nil, err
	}
	out := &MediaProgress{MediaID: mediaID, Kind: kind, Episodes: []WatchProgress{}, Seasons: []SeasonCount{}}
	if kind == "movie" {
		out.Movie, err = getProgress(ctx, s.pool, profileID, mediaID, nil, false)
		return out, err
	}
	all, err := s.loadSeries(ctx, profileID, []string{mediaID})
	if err != nil {
		return nil, err
	}
	nu, sd := s.seriesNextUp(ctx, profileID, mediaID, all[mediaID], lang)
	out.NextUp = nu
	out.Episodes = append(out.Episodes, sd.progress...)
	out.Seasons = sd.seasonCounts(today())
	return out, nil
}

// ---- manual overrides ----

type WatchedInput struct {
	ProfileID    string  `json:"profile_id"`
	Watched      *bool   `json:"watched"`
	EpisodeID    *string `json:"episode_id"`
	SeasonNumber *int    `json:"season_number"`
}

// SetWatched marks a movie, an episode or a whole season (every aired
// episode) watched, or clears it (the progress rows are deleted).
func (s *Service) SetWatched(ctx context.Context, mediaID string, in WatchedInput, lang string) (*MediaProgress, error) {
	kind, err := s.mediaKind(ctx, mediaID)
	if err != nil {
		return nil, err
	}
	f := validationError{}
	if in.Watched == nil {
		f["watched"] = "required"
	}
	if in.EpisodeID != nil && !isUUID(*in.EpisodeID) {
		f["episode_id"] = "must be a UUID"
	}
	if in.SeasonNumber != nil && (*in.SeasonNumber < 0 || *in.SeasonNumber > 1000) {
		f["season_number"] = "must be >= 0"
	}
	switch {
	case kind == "movie" && (in.EpisodeID != nil || in.SeasonNumber != nil):
		f["episode_id"] = "movies have no episodes or seasons"
	case kind == "series" && (in.EpisodeID == nil) == (in.SeasonNumber == nil):
		f["episode_id"] = "series need exactly one of episode_id or season_number"
	}
	if len(f) > 0 {
		return nil, f
	}
	watched := *in.Watched

	var episodeIDs []string
	switch {
	case kind == "movie":
	case in.EpisodeID != nil:
		if err := s.checkEpisode(ctx, kind, mediaID, in.EpisodeID); err != nil {
			return nil, err
		}
		episodeIDs = []string{*in.EpisodeID}
	default:
		if episodeIDs, err = s.seasonEpisodes(ctx, mediaID, *in.SeasonNumber, !watched, lang); err != nil {
			return nil, err
		}
	}

	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if !watched {
			if kind == "movie" {
				_, err := tx.Exec(ctx, `DELETE FROM watch_progress WHERE profile_id = $1 AND media_id = $2 AND episode_id IS NULL`,
					in.ProfileID, mediaID)
				return err
			}
			_, err := tx.Exec(ctx, `DELETE FROM watch_progress WHERE profile_id = $1 AND media_id = $2 AND episode_id = ANY($3::uuid[])`,
				in.ProfileID, mediaID, episodeIDs)
			return err
		}
		const upsert = `
			INSERT INTO watch_progress AS wp (profile_id, media_id, episode_id, position_seconds, percent, completed,
				completed_at, manual, resumable, updated_at)
			SELECT $1, $2, ep, 0, 1, true, now(), true, false, now() FROM %s
			ON CONFLICT ON CONSTRAINT watch_progress_item_key DO UPDATE SET
				position_seconds = COALESCE(wp.duration_seconds, wp.position_seconds), percent = 1,
				manual = CASE WHEN wp.completed THEN wp.manual ELSE true END,
				completed = true, completed_at = COALESCE(wp.completed_at, now()),
				resumable = false, updated_at = now()`
		if kind == "movie" {
			_, err := tx.Exec(ctx, fmt.Sprintf(upsert, "(SELECT NULL::uuid AS ep) t"), in.ProfileID, mediaID)
			return err
		}
		_, err := tx.Exec(ctx, fmt.Sprintf(upsert, "unnest($3::uuid[]) AS ep"), in.ProfileID, mediaID, episodeIDs)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.MediaProgress(ctx, in.ProfileID, mediaID, lang)
}

// seasonEpisodes returns a season's aired episodes (or all of them), loading
// the season from TMDB first when it is not stored.
func (s *Service) seasonEpisodes(ctx context.Context, mediaID string, season int, all bool, lang string) ([]string, error) {
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM episodes WHERE media_id = $1 AND season_number = $2`,
		mediaID, season).Scan(&n); err != nil {
		return nil, err
	}
	if n == 0 {
		if _, err := s.catalog.Season(ctx, mediaID, season, lang); err != nil {
			if errors.Is(err, catalog.ErrNotFound) {
				return nil, ErrNotFound
			}
			return nil, err
		}
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id FROM episodes WHERE media_id = $1 AND season_number = $2
		  AND ($3 OR (air_date IS NOT NULL AND air_date <= current_date))`, mediaID, season, all)
	if err != nil {
		return nil, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	if ids == nil {
		ids = []string{}
	}
	return ids, nil
}
