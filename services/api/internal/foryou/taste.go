package foryou

import (
	"math"
	"slices"
	"strconv"
	"time"
)

// Signal is everything a profile did with one title.
type Signal struct {
	MediaID string
	Rating  int // 1..10, 0 = not rated
	RatedAt time.Time
	// Completed: a finished movie, a series marked watched, or a series
	// with at least 3 completed episodes.
	Completed   bool
	CompletedAt time.Time
	// Percent is the furthest progress of an unfinished movie (or of the
	// furthest episode of an unfinished series).
	Percent      float64
	Started      bool // any progress row
	LastActivity time.Time
	Favorite     bool
	FavoriteAt   time.Time
	Watchlist    bool
	WatchlistAt  time.Time
	Dismissed    bool
	DismissedAt  time.Time
	Rewatches    int
	// NoteReasons are the reason codes of the profile's note on the title.
	NoteReasons []string
}

// Features are a title's facts used for affinities and scoring.
type Features struct {
	Kind       string
	Genres     []int
	Year       int
	Lang       string
	Countries  []string
	Directors  []int // TMDB person ids (Director, or Creator for series)
	Actors     []int // top-billed cast
	HasCredits bool
}

// Affinity is one feature's score (−1…1 after normalization).
type Affinity struct {
	Key   string  `json:"k"`
	Score float64 `json:"s"`
	Count int     `json:"n"`
}

// Seed is a title the profile liked, used for "because you liked" rows.
type Seed struct {
	MediaID string  `json:"m"`
	Weight  float64 `json:"w"`
}

// TasteStats are raw counts for Taste DNA.
type TasteStats struct {
	Ratings       int     `json:"ratings"`
	Completed     int     `json:"completed"`
	Favorites     int     `json:"favorites"`
	Watchlist     int     `json:"watchlist"`
	Dismissed     int     `json:"dismissed"`
	Abandoned     int     `json:"abandoned"`
	Rewatches     int     `json:"rewatches"`
	AverageRating float64 `json:"average_rating"`
	Positive      int     `json:"positive"`
	Histogram     [10]int `json:"histogram"`
	Movies        int     `json:"movies"`
	Series        int     `json:"series"`
	WithCredits   int     `json:"with_credits"`
	Total         int     `json:"total"`
}

// Taste is profile_taste.data.
type Taste struct {
	Genres    []Affinity `json:"genres"`
	Decades   []Affinity `json:"decades"`
	Languages []Affinity `json:"languages"`
	Countries []Affinity `json:"countries"`
	Directors []Affinity `json:"directors"`
	Actors    []Affinity `json:"actors"`
	Seeds     []Seed     `json:"seeds"`
	// Seen = rated, completed, started or dismissed titles: never recommended
	// (except rewatch). Not stored (recomputed with the taste).
	Stats     TasteStats `json:"stats"`
	SignalsAt time.Time  `json:"signals_at"`
	// RatingCenter is the rating treated as neutral for this profile.
	RatingCenter float64 `json:"rating_center"`
	// Adjustments are penalties from note reasons repeated across titles
	// (too_scary → horror/thriller, childish → family/animation,
	// too_slow/too_long → long runtimes).
	Adjustments []ReasonAdjustment `json:"adjustments,omitempty"`

	genre, decade, lang, country map[string]float64
}

// index builds the lookup maps (after decoding from JSON too).
func (t *Taste) index() {
	mk := func(list []Affinity) map[string]float64 {
		m := make(map[string]float64, len(list))
		for _, a := range list {
			m[a.Key] = a.Score
		}
		return m
	}
	t.genre, t.decade, t.lang, t.country = mk(t.Genres), mk(t.Decades), mk(t.Languages), mk(t.Countries)
}

func (t *Taste) genreScore(id int) float64 {
	if t.genre == nil {
		t.index()
	}
	return t.genre[strconv.Itoa(id)]
}

func (t *Taste) decadeScore(year int) float64 {
	if t.decade == nil {
		t.index()
	}
	if year <= 0 {
		return 0
	}
	return t.decade[strconv.Itoa(year/10*10)]
}

func (t *Taste) langScore(l string) float64 {
	if t.lang == nil {
		t.index()
	}
	return t.lang[l]
}

func (t *Taste) countryScore(cs []string) float64 {
	if t.country == nil {
		t.index()
	}
	best := 0.0
	for _, c := range cs {
		if v := t.country[c]; math.Abs(v) > math.Abs(best) {
			best = v
		}
	}
	return best
}

// abandoned: started, stopped early, idle long enough, no rating.
func abandoned(s Signal, now time.Time, w Weights) bool {
	return s.Started && !s.Completed && s.Rating == 0 && s.Percent < w.AbandonPercent &&
		!s.LastActivity.IsZero() && now.Sub(s.LastActivity) >= w.AbandonIdle
}

// ratingCenter is the neutral rating for a profile: its mean − 0.5,
// clamped (generous raters don't make every 7 a "like").
func ratingCenter(signals []Signal, w Weights) float64 {
	sum, n := 0, 0
	for _, s := range signals {
		if s.Rating > 0 {
			sum += s.Rating
			n++
		}
	}
	c := 6.5
	if n > 0 {
		c = float64(sum)/float64(n) - 0.5
	}
	return math.Max(w.RatingCenterMin, math.Min(w.RatingCenterMax, c))
}

// signalWeight is one title's taste weight (may be negative) and the time
// of its latest interaction.
func signalWeight(s Signal, center float64, now time.Time, w Weights) (float64, time.Time) {
	v := 0.0
	var at time.Time
	later := func(t time.Time) {
		if t.After(at) {
			at = t
		}
	}
	if s.Rating > 0 {
		r := (float64(s.Rating) - center) / w.RatingSpread
		v += w.Rating * math.Max(-w.RatingClamp, math.Min(w.RatingClamp, r))
		later(s.RatedAt)
	} else if s.Completed {
		v += w.Completed
	}
	if s.Completed {
		later(s.CompletedAt)
	}
	if s.Favorite {
		v += w.Favorite
		later(s.FavoriteAt)
	}
	if s.Watchlist && !s.Completed && s.Rating == 0 {
		v += w.Watchlist
		later(s.WatchlistAt)
	}
	v += w.Rewatch * float64(min(s.Rewatches, w.MaxRewatches))
	if abandoned(s, now, w) {
		v += w.Abandon
		later(s.LastActivity)
	}
	if s.Dismissed {
		v += w.Dismiss
		later(s.DismissedAt)
	}
	if slices.ContainsFunc(s.NoteReasons, negativeReason) {
		// A note saying why it didn't work: extra negative weight.
		v += w.NoteDislike
		if at.IsZero() {
			at = s.LastActivity
		}
	}
	if at.IsZero() {
		at = s.LastActivity
	}
	age := now.Sub(at)
	if age < 0 {
		age = 0
	}
	rec := w.RecencyFloor + (1-w.RecencyFloor)*math.Pow(0.5, float64(age)/float64(w.RecencyHalfLife))
	return v * rec, at
}

type acc struct {
	sum float64
	n   int
}

// ComputeTaste aggregates signals into affinities. Pure and deterministic.
func ComputeTaste(signals []Signal, feats map[string]Features, now time.Time, w Weights) *Taste {
	t := &Taste{}
	center := ratingCenter(signals, w)
	t.RatingCenter = center
	genres, decades, langs, countries := map[string]*acc{}, map[string]*acc{}, map[string]*acc{}, map[string]*acc{}
	directors, actors := map[string]*acc{}, map[string]*acc{}
	add := func(m map[string]*acc, k string, v float64) {
		a := m[k]
		if a == nil {
			a = &acc{}
			m[k] = a
		}
		a.sum += v
		a.n++
	}
	type weighted struct {
		id     string
		w      float64
		at     time.Time
		recent bool
	}
	var ws []weighted
	ratingSum := 0
	for _, s := range signals {
		st := &t.Stats
		if s.Rating > 0 {
			st.Ratings++
			ratingSum += s.Rating
			st.Histogram[min(max(s.Rating, 1), 10)-1]++
		}
		if s.Completed {
			st.Completed++
		}
		if s.Favorite {
			st.Favorites++
		}
		if s.Watchlist {
			st.Watchlist++
		}
		if s.Dismissed {
			st.Dismissed++
		}
		if abandoned(s, now, w) {
			st.Abandoned++
		}
		st.Rewatches += s.Rewatches

		v, at := signalWeight(s, center, now, w)
		if at.After(t.SignalsAt) {
			t.SignalsAt = at
		}
		f, ok := feats[s.MediaID]
		if ok {
			if s.Rating > 0 || s.Completed || s.Favorite {
				st.Total++
				if f.HasCredits {
					st.WithCredits++
				}
				if f.Kind == "series" {
					st.Series++
				} else {
					st.Movies++
				}
			}
		}
		if v == 0 {
			continue
		}
		if v > 0 {
			st.Positive++
			recent := (s.Rating == 0 || float64(s.Rating) >= center+1) &&
				now.Sub(at) <= time.Duration(w.RecentDays)*24*time.Hour
			ws = append(ws, weighted{s.MediaID, v, at, recent})
		}
		if !ok {
			continue
		}
		for _, g := range f.Genres {
			add(genres, strconv.Itoa(g), v)
		}
		if f.Year > 0 {
			add(decades, strconv.Itoa(f.Year/10*10), v)
		}
		if f.Lang != "" {
			add(langs, f.Lang, v)
		}
		for _, c := range f.Countries {
			add(countries, c, v)
		}
		for _, p := range f.Directors {
			add(directors, strconv.Itoa(p), v)
		}
		for _, p := range f.Actors {
			add(actors, strconv.Itoa(p), v*w.ActorFactor)
		}
	}
	if t.Stats.Ratings > 0 {
		t.Stats.AverageRating = math.Round(float64(ratingSum)/float64(t.Stats.Ratings)*100) / 100
	}
	t.Genres = affinities(genres, w.AffinityPrior, 1)
	t.Decades = affinities(decades, w.AffinityPrior, 1)
	t.Languages = affinities(langs, w.AffinityPrior, 1)
	t.Countries = affinities(countries, w.AffinityPrior, 1)
	t.Adjustments = reasonAdjustments(signals, w)
	t.Directors = limit(affinities(directors, w.AffinityPrior, w.MinPersonTitles), 30)
	t.Actors = limit(affinities(actors, w.AffinityPrior, w.MinPersonTitles), 30)

	// Seeds: strongest liked titles, plus a few recent ones.
	slices.SortFunc(ws, func(a, b weighted) int {
		if a.w != b.w {
			if a.w > b.w {
				return -1
			}
			return 1
		}
		return cmpStr(a.id, b.id)
	})
	picked := map[string]bool{}
	for _, x := range ws {
		if len(t.Seeds) >= w.Seeds {
			break
		}
		picked[x.id] = true
		t.Seeds = append(t.Seeds, Seed{x.id, round3(x.w)})
	}
	recent := 0
	for _, x := range ws {
		if recent >= w.RecentSeeds {
			break
		}
		if x.recent && !picked[x.id] {
			picked[x.id] = true
			recent++
			t.Seeds = append(t.Seeds, Seed{x.id, round3(x.w)})
		}
	}
	t.index()
	return t
}

// affinities: shrunk mean weight × salience (how often the feature
// appears), normalized so the strongest is ±1. Sorted by score desc.
func affinities(m map[string]*acc, prior float64, minCount int) []Affinity {
	maxN := 0
	for _, a := range m {
		maxN = max(maxN, a.n)
	}
	out := make([]Affinity, 0, len(m))
	maxAbs := 0.0
	for k, a := range m {
		if a.n < minCount {
			continue
		}
		mean := a.sum / (float64(a.n) + prior)
		sal := 0.5 + 0.5*math.Sqrt(float64(a.n)/float64(maxN))
		s := mean * sal
		maxAbs = math.Max(maxAbs, math.Abs(s))
		out = append(out, Affinity{Key: k, Score: s, Count: a.n})
	}
	for i := range out {
		if maxAbs > 0 {
			out[i].Score = round3(out[i].Score / maxAbs)
		}
	}
	slices.SortFunc(out, func(a, b Affinity) int {
		if a.Score != b.Score {
			if a.Score > b.Score {
				return -1
			}
			return 1
		}
		if a.Count != b.Count {
			return b.Count - a.Count
		}
		return cmpStr(a.Key, b.Key)
	})
	return out
}

func limit[T any](s []T, n int) []T {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

func cmpStr(a, b string) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// topPositive returns up to n keys with score >= minScore.
func topPositive(list []Affinity, n int, minScore float64) []string {
	var out []string
	for _, a := range list {
		if len(out) >= n || a.Score < minScore {
			break
		}
		out = append(out, a.Key)
	}
	return out
}

// ReasonAdjustment is one reason-driven penalty (contract TasteAdjustment).
type ReasonAdjustment struct {
	Reason string `json:"reason"` // too_scary | childish | too_long (too_slow counts as too_long)
	Titles int    `json:"titles"` // notes with the reason
	// Strength 0..1 = min(1, titles / ReasonFullTitles); the penalty is
	// Strength × ReasonGenrePenalty (genres) or × ReasonRuntimePenalty.
	Strength   float64 `json:"strength"`
	Genres     []int   `json:"genres,omitempty"`
	RuntimeMax int     `json:"runtime_max,omitempty"` // longer titles are penalized
}

// reasonRules: which reasons aggregate into which penalty.
var reasonRules = []struct {
	key     string
	reasons []string
	genres  []int
	runtime bool
}{
	{"too_scary", []string{"too_scary"}, []int{27, 53}, false},
	{"childish", []string{"childish"}, []int{10751, 16}, false},
	{"too_long", []string{"too_slow", "too_long"}, nil, true},
}

// reasonAdjustments counts titles per rule; a rule needs ReasonMinTitles.
func reasonAdjustments(signals []Signal, w Weights) []ReasonAdjustment {
	var out []ReasonAdjustment
	for _, rule := range reasonRules {
		n := 0
		for _, s := range signals {
			if slices.ContainsFunc(s.NoteReasons, func(r string) bool { return slices.Contains(rule.reasons, r) }) {
				n++
			}
		}
		if n < w.ReasonMinTitles || w.ReasonMinTitles <= 0 {
			continue
		}
		a := ReasonAdjustment{Reason: rule.key, Titles: n, Strength: round3(math.Min(1, float64(n)/float64(max(w.ReasonFullTitles, 1))))}
		if rule.runtime {
			a.RuntimeMax = w.ReasonLongRuntime
		} else {
			a.Genres = rule.genres
		}
		out = append(out, a)
	}
	return out
}

// reasonPenalty is the score penalty of a candidate under the profile's
// reason adjustments.
func reasonPenalty(c *Candidate, t *Taste, w Weights) float64 {
	p := 0.0
	for _, a := range t.Adjustments {
		switch {
		case a.RuntimeMax > 0:
			if c.Runtime > a.RuntimeMax {
				p += w.ReasonRuntimePenalty * a.Strength
			}
		case slices.ContainsFunc(c.Genres, func(g int) bool { return slices.Contains(a.Genres, g) }):
			p += w.ReasonGenrePenalty * a.Strength
		}
	}
	return p
}
