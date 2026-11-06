package foryou

import (
	"context"
	"math"
	"slices"
	"strconv"
	"time"

	"martytv/api/internal/catalog"
)

// ---- diary ----

type DiaryEpisode struct {
	SeasonNumber  int `json:"season_number"`
	EpisodeNumber int `json:"episode_number"`
}

type DiaryEntry struct {
	Media    catalog.MediaSummary `json:"media"`
	Watched  bool                 `json:"watched"`
	Episodes []DiaryEpisode       `json:"episodes"`
	Rating   *int                 `json:"rating"`
	Rewatch  bool                 `json:"rewatch"`
	At       time.Time            `json:"at"`
	mediaID  string
}

type DiaryDay struct {
	Date    string        `json:"date"`
	Entries []*DiaryEntry `json:"entries"`
}

type DiaryCount struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type RatedItem struct {
	Media  catalog.MediaSummary `json:"media"`
	Rating int                  `json:"rating"`
}

type DiaryStats struct {
	MoviesWatched   int          `json:"movies_watched"`
	EpisodesWatched int          `json:"episodes_watched"`
	SeriesWatched   int          `json:"series_watched"`
	HoursWatched    float64      `json:"hours_watched"`
	RatingsCount    int          `json:"ratings_count"`
	AverageRating   *float64     `json:"average_rating"`
	Rewatches       int          `json:"rewatches"`
	FavoriteGenres  []DiaryCount `json:"favorite_genres"`
	FavoriteDecades []DiaryCount `json:"favorite_decades"`
	TopDirectors    []DiaryCount `json:"top_directors"`
	TopRated        []RatedItem  `json:"top_rated"`
}

type Diary struct {
	Month string     `json:"month"`
	Days  []DiaryDay `json:"days"`
	Stats DiaryStats `json:"stats"`
}

// Diary is GET /profiles/{id}/diary: completions and ratings of one month
// (Moscow dates) and that month's stats.
func (s *Service) Diary(ctx context.Context, profileID string, month time.Time, lang string) (*Diary, error) {
	start := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, msk)
	end := start.AddDate(0, 1, 0)
	entries := map[string]*DiaryEntry{} // date|media
	entry := func(at time.Time, mediaID string) *DiaryEntry {
		k := at.In(msk).Format("2006-01-02") + "|" + mediaID
		e := entries[k]
		if e == nil {
			e = &DiaryEntry{mediaID: mediaID, Episodes: []DiaryEpisode{}, At: at}
			entries[k] = e
		}
		if at.After(e.At) {
			e.At = at
		}
		return e
	}
	st := DiaryStats{FavoriteGenres: []DiaryCount{}, FavoriteDecades: []DiaryCount{}, TopDirectors: []DiaryCount{}, TopRated: []RatedItem{}}
	watchedMovies, watchedSeries := map[string]bool{}, map[string]bool{}
	seconds := 0.0

	rows, err := s.pool.Query(ctx, `
		SELECT wp.media_id, m.kind, e.season_number, e.episode_number, wp.completed_at,
		       COALESCE(wp.duration_seconds, e.runtime * 60.0, m.runtime * 60.0, 0)
		FROM watch_progress wp JOIN media m ON m.id = wp.media_id LEFT JOIN episodes e ON e.id = wp.episode_id
		WHERE wp.profile_id = $1 AND wp.completed AND wp.completed_at >= $2 AND wp.completed_at < $3
		ORDER BY wp.completed_at`, profileID, start, end)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var (
			mid, kind string
			sn, en    *int
			at        time.Time
			dur       float64
		)
		if err := rows.Scan(&mid, &kind, &sn, &en, &at, &dur); err != nil {
			rows.Close()
			return nil, err
		}
		e := entry(at, mid)
		e.Watched = true
		seconds += dur
		if sn != nil && en != nil {
			e.Episodes = append(e.Episodes, DiaryEpisode{*sn, *en})
			st.EpisodesWatched++
			watchedSeries[mid] = true
		} else if kind == "series" {
			watchedSeries[mid] = true
		} else {
			watchedMovies[mid] = true
		}
	}
	rows.Close()

	type rated struct {
		id     string
		rating int
		at     time.Time
	}
	var ratedList []rated
	rows, err = s.pool.Query(ctx, `
		SELECT media_id, rating, updated_at FROM ratings
		WHERE profile_id = $1 AND updated_at >= $2 AND updated_at < $3 ORDER BY updated_at`, profileID, start, end)
	if err != nil {
		return nil, err
	}
	sum := 0
	for rows.Next() {
		var r rated
		if err := rows.Scan(&r.id, &r.rating, &r.at); err != nil {
			rows.Close()
			return nil, err
		}
		e := entry(r.at, r.id)
		v := r.rating
		e.Rating = &v
		ratedList = append(ratedList, r)
		sum += r.rating
	}
	rows.Close()
	st.RatingsCount = len(ratedList)
	if len(ratedList) > 0 {
		avg := math.Round(float64(sum)/float64(len(ratedList))*10) / 10
		st.AverageRating = &avg
	}

	// Rewatches: sessions this month that reached 90% of a movie already
	// completed before they started.
	rows, err = s.pool.Query(ctx, `
		SELECT ps.media_id, ps.started_at FROM playback_sessions ps
		JOIN watch_progress wp ON wp.profile_id = ps.profile_id AND wp.media_id = ps.media_id AND wp.episode_id IS NULL
		WHERE ps.profile_id = $1 AND ps.episode_id IS NULL AND wp.completed AND ps.started_at > wp.completed_at
		  AND ps.started_at >= $2 AND ps.started_at < $3 AND ps.last_duration > 0 AND ps.last_position >= 0.9 * ps.last_duration`,
		profileID, start, end)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var mid string
		var at time.Time
		if err := rows.Scan(&mid, &at); err != nil {
			rows.Close()
			return nil, err
		}
		e := entry(at, mid)
		e.Rewatch, e.Watched = true, true
		st.Rewatches++
	}
	rows.Close()

	st.MoviesWatched, st.SeriesWatched = len(watchedMovies), len(watchedSeries)
	st.HoursWatched = math.Round(seconds/3600*10) / 10

	// Media summaries.
	var ids []string
	for _, e := range entries {
		ids = append(ids, e.mediaID)
	}
	ids = slicesUniq(ids)
	slices.Sort(ids)
	sums, err := s.summaries(ctx, profileID, lang, ids)
	if err != nil {
		return nil, err
	}
	byID := map[string]catalog.MediaSummary{}
	for _, m := range sums {
		byID[m.ID] = m
	}
	days := map[string]*DiaryDay{}
	for k, e := range entries {
		m, ok := byID[e.mediaID]
		if !ok {
			continue
		}
		e.Media = m
		date := k[:10]
		d := days[date]
		if d == nil {
			d = &DiaryDay{Date: date}
			days[date] = d
		}
		d.Entries = append(d.Entries, e)
	}
	out := &Diary{Month: start.Format("2006-01"), Days: []DiaryDay{}, Stats: st}
	for _, d := range days {
		slices.SortFunc(d.Entries, func(a, b *DiaryEntry) int {
			if !a.At.Equal(b.At) {
				return b.At.Compare(a.At)
			}
			return cmpStr(a.mediaID, b.mediaID)
		})
		out.Days = append(out.Days, *d)
	}
	slices.SortFunc(out.Days, func(a, b DiaryDay) int { return cmpStr(a.Date, b.Date) })

	// Genres/decades over titles watched or rated this month; directors
	// over watched ones.
	facts, err := s.loadFeatures(ctx, ids)
	if err != nil {
		return nil, err
	}
	genres, decades, directors := map[string]int{}, map[string]int{}, map[string]int{}
	for _, id := range ids {
		f := facts[id]
		for _, g := range f.Genres {
			genres[strconv.Itoa(g)]++
		}
		if f.Year > 0 {
			decades[strconv.Itoa(f.Year/10*10)]++
		}
		if watchedMovies[id] || watchedSeries[id] {
			for _, p := range f.Directors {
				directors[strconv.Itoa(p)]++
			}
		}
	}
	gnames := s.genreNamesFor(ctx, lang)
	for _, kv := range topCounts(genres, 5) {
		g, _ := strconv.Atoi(kv.Key)
		kv.Name = genreName(gnames, lang, g)
		out.Stats.FavoriteGenres = append(out.Stats.FavoriteGenres, kv)
	}
	for _, kv := range topCounts(decades, 5) {
		d, _ := strconv.Atoi(kv.Key)
		kv.Name = decadeName(lang, d)
		out.Stats.FavoriteDecades = append(out.Stats.FavoriteDecades, kv)
	}
	topDir := topCounts(directors, 5)
	var pids []int
	for _, kv := range topDir {
		p, _ := strconv.Atoi(kv.Key)
		pids = append(pids, p)
	}
	people, err := s.personNames(ctx, pids, lang)
	if err != nil {
		return nil, err
	}
	for _, kv := range topDir {
		p, _ := strconv.Atoi(kv.Key)
		kv.Name = people[p].Name
		out.Stats.TopDirectors = append(out.Stats.TopDirectors, kv)
	}
	slices.SortStableFunc(ratedList, func(a, b rated) int {
		if a.rating != b.rating {
			return b.rating - a.rating
		}
		return b.at.Compare(a.at)
	})
	for _, r := range ratedList {
		if len(out.Stats.TopRated) == 5 {
			break
		}
		if m, ok := byID[r.id]; ok {
			out.Stats.TopRated = append(out.Stats.TopRated, RatedItem{Media: m, Rating: r.rating})
		}
	}
	return out, nil
}

func topCounts(m map[string]int, n int) []DiaryCount {
	out := make([]DiaryCount, 0, len(m))
	for k, v := range m {
		out = append(out, DiaryCount{Key: k, Count: v})
	}
	slices.SortFunc(out, func(a, b DiaryCount) int {
		if a.Count != b.Count {
			return b.Count - a.Count
		}
		return cmpStr(a.Key, b.Key)
	})
	return limit(out, n)
}

// ---- taste DNA ----

type TasteAffinity struct {
	Key   string  `json:"key"`
	Name  string  `json:"name"`
	Score float64 `json:"score"`
	Count int     `json:"count"`
}

type TastePerson struct {
	TMDBID      int     `json:"tmdb_id"`
	Name        string  `json:"name"`
	ProfilePath *string `json:"profile_path"`
	Score       float64 `json:"score"`
	Count       int     `json:"count"`
}

type TasteDNA struct {
	ProfileID string    `json:"profile_id"`
	Computed  time.Time `json:"computed_at"`
	Signals   struct {
		Ratings       int      `json:"ratings"`
		Completed     int      `json:"completed"`
		Favorites     int      `json:"favorites"`
		Watchlist     int      `json:"watchlist"`
		Dismissed     int      `json:"dismissed"`
		Abandoned     int      `json:"abandoned"`
		Rewatches     int      `json:"rewatches"`
		AverageRating *float64 `json:"average_rating"`
	} `json:"signals"`
	RatingHistogram []int `json:"rating_histogram"`
	Kinds           struct {
		Movie  int `json:"movie"`
		Series int `json:"series"`
	} `json:"kinds"`
	Genres          []TasteAffinity `json:"genres"`
	Decades         []TasteAffinity `json:"decades"`
	Languages       []TasteAffinity `json:"languages"`
	Countries       []TasteAffinity `json:"countries"`
	Directors       []TastePerson   `json:"directors"`
	Actors          []TastePerson   `json:"actors"`
	CreditsCoverage struct {
		WithCredits int `json:"with_credits"`
		Total       int `json:"total"`
	} `json:"credits_coverage"`
	// Adjustments: reason-driven penalties from the profile's notes.
	Adjustments []TasteAdjustment `json:"adjustments"`
}

// TasteAdjustment is the contract's TasteAdjustment.
type TasteAdjustment struct {
	Reason     string   `json:"reason"`
	Titles     int      `json:"titles"`
	Strength   float64  `json:"strength"`
	Penalty    float64  `json:"penalty"`
	GenreIDs   []int    `json:"genre_ids"`
	GenreNames []string `json:"genre_names"`
	RuntimeMax *int     `json:"runtime_max"`
}

// TasteDNA is GET /profiles/{id}/taste. The stored taste is reused unless
// newer signals exist (recomputing is DB-only and cheap).
func (s *Service) TasteDNA(ctx context.Context, profileID, lang string) (*TasteDNA, error) {
	t, at, err := s.loadTaste(ctx, profileID)
	if err != nil {
		return nil, err
	}
	latest, err := s.latestSignal(ctx, profileID)
	if err != nil {
		return nil, err
	}
	var notesAt *time.Time
	if err := s.pool.QueryRow(ctx, `SELECT max(updated_at) FROM profile_media_notes WHERE profile_id = $1`, profileID).Scan(&notesAt); err != nil {
		return nil, err
	}
	if t == nil || latest != nil && latest.After(at) || notesAt != nil && notesAt.After(at) {
		if t, _, err = s.computeTaste(ctx, profileID); err != nil {
			return nil, err
		}
		at = s.now()
	}
	out := &TasteDNA{ProfileID: profileID, Computed: at.UTC()}
	st := t.Stats
	out.Signals.Ratings, out.Signals.Completed, out.Signals.Favorites = st.Ratings, st.Completed, st.Favorites
	out.Signals.Watchlist, out.Signals.Dismissed, out.Signals.Abandoned, out.Signals.Rewatches = st.Watchlist, st.Dismissed, st.Abandoned, st.Rewatches
	if st.Ratings > 0 {
		avg := st.AverageRating
		out.Signals.AverageRating = &avg
	}
	out.RatingHistogram = st.Histogram[:]
	out.Kinds.Movie, out.Kinds.Series = st.Movies, st.Series
	out.CreditsCoverage.WithCredits, out.CreditsCoverage.Total = st.WithCredits, st.Total
	gnames := s.genreNamesFor(ctx, lang)
	out.Adjustments = []TasteAdjustment{}
	for _, a := range t.Adjustments {
		adj := TasteAdjustment{Reason: a.Reason, Titles: a.Titles, Strength: a.Strength, GenreIDs: []int{}, GenreNames: []string{}}
		if a.RuntimeMax > 0 {
			rm := a.RuntimeMax
			adj.RuntimeMax = &rm
			adj.Penalty = round3(s.w.ReasonRuntimePenalty * a.Strength)
		} else {
			adj.Penalty = round3(s.w.ReasonGenrePenalty * a.Strength)
			for _, g := range a.Genres {
				adj.GenreIDs = append(adj.GenreIDs, g)
				adj.GenreNames = append(adj.GenreNames, genreName(gnames, lang, g))
			}
		}
		out.Adjustments = append(out.Adjustments, adj)
	}
	conv := func(list []Affinity, n int, name func(string) string) []TasteAffinity {
		out := []TasteAffinity{}
		for _, a := range limit(list, n) {
			out = append(out, TasteAffinity{Key: a.Key, Name: name(a.Key), Score: a.Score, Count: a.Count})
		}
		return out
	}
	out.Genres = conv(t.Genres, 30, func(k string) string { g, _ := strconv.Atoi(k); return genreName(gnames, lang, g) })
	out.Decades = conv(t.Decades, 15, func(k string) string { d, _ := strconv.Atoi(k); return decadeName(lang, d) })
	out.Languages = conv(t.Languages, 15, func(k string) string { return languageName(lang, k) })
	out.Countries = conv(t.Countries, 15, func(k string) string { return countryName(lang, k) })
	var pids []int
	for _, a := range append(limit(t.Directors, 15), limit(t.Actors, 15)...) {
		p, _ := strconv.Atoi(a.Key)
		pids = append(pids, p)
	}
	people, err := s.personNames(ctx, pids, lang)
	if err != nil {
		return nil, err
	}
	persons := func(list []Affinity) []TastePerson {
		out := []TastePerson{}
		for _, a := range limit(list, 15) {
			p, _ := strconv.Atoi(a.Key)
			n, ok := people[p]
			if !ok {
				continue
			}
			out = append(out, TastePerson{TMDBID: p, Name: n.Name, ProfilePath: n.Profile, Score: a.Score, Count: a.Count})
		}
		return out
	}
	out.Directors, out.Actors = persons(t.Directors), persons(t.Actors)
	return out, nil
}
