package foryou

import (
	"math"
	"reflect"
	"slices"
	"strconv"
)

// Source is one reason a candidate was generated.
type Source struct {
	Type         string // a Reason* constant
	MediaID      string // because_you_rated: the seed
	PersonID     int    // director / actor
	GenreIDs     []int
	CollectionID string
	KeywordID    int // theme
	// Strength 0..1: how strongly this source vouches for the candidate
	// (seed/person affinity × rank in the TMDB list).
	Strength float64
}

// Candidate is a title that may be recommended.
type Candidate struct {
	MediaID string
	Features
	VoteAverage float64
	VoteCount   int
	Popularity  float64
	KPRating    float64 // 0 = unknown
	Sources     []Source
	// Impressions without an open in the last 14 days (fatigue); Shown =
	// ever shown (novelty).
	Impressions int
	Shown       bool
	Watchlist   bool
	Runtime     int // minutes, 0 = unknown
}

// Scored is a candidate with its score and main reason.
type Scored struct {
	*Candidate
	Score   float64
	Quality float64 // 0..1
	Genre   float64 // genre match −1..1
	Reason  Reason
}

// quality is a Bayesian-shrunk rating mapped to 0..1 (Kinopoisk blended in
// when known).
func quality(c *Candidate, w Weights) float64 {
	v := float64(c.VoteCount)
	r := (v*c.VoteAverage + w.QualityPriorVotes*w.QualityPriorMean) / (v + w.QualityPriorVotes)
	if c.KPRating > 0 {
		r = 0.5*r + 0.5*c.KPRating
	}
	return math.Max(0, math.Min(1, (r-5.5)/3))
}

func genreMatch(c *Candidate, t *Taste) float64 {
	if len(c.Genres) == 0 {
		return 0
	}
	best, sum := math.Inf(-1), 0.0
	for _, g := range c.Genres {
		s := t.genreScore(g)
		best = math.Max(best, s)
		sum += s
	}
	return 0.6*best + 0.4*sum/float64(len(c.Genres))
}

// sourceStrength combines sources as a noisy-or (several independent
// reasons reinforce each other, never beyond 1).
func sourceStrength(c *Candidate) float64 {
	miss := 1.0
	for _, s := range c.Sources {
		miss *= 1 - math.Max(0, math.Min(1, s.Strength))
	}
	return 1 - miss
}

// typePriority breaks ties between reasons: specific ones explain better.
var typePriority = map[string]float64{
	ReasonBecause: 1, ReasonDirector: 1, ReasonRewatch: 1, ReasonAI: 0.95, ReasonActor: 0.9,
	ReasonHiddenGem: 0.8, ReasonDifferent: 0.8, ReasonTheme: 0.85, ReasonTrending: 0.6, ReasonGenre: 0.5, ReasonPopular: 0.3,
}

// Score ranks a candidate for a taste. Deterministic.
func Score(c *Candidate, t *Taste, w Weights) Scored {
	q := quality(c, w)
	g := genreMatch(c, t)
	src := sourceStrength(c)
	pop := math.Min(1, math.Log1p(c.Popularity)/math.Log1p(1000))
	s := w.Quality*q + w.Genre*g + w.Decade*t.decadeScore(c.Year) + w.Language*t.langScore(c.Lang) +
		w.Country*t.countryScore(c.Countries) + w.Source*src + w.Popularity*pop +
		w.Keyword*keywordMatch(c, t) + w.People*peopleMatch(c, t, w)
	if !c.Shown {
		s += w.Novelty
	}
	s -= w.Fatigue * float64(min(c.Impressions, 5))
	s -= reasonPenalty(c, t, w)
	if c.Watchlist {
		s += w.WatchlistBoost
	}
	return Scored{Candidate: c, Score: round3(s), Quality: q, Genre: g, Reason: themed(mainReason(c, t), c, t, w)}
}

// themed replaces a weak reason (genre, trending) with the candidate's most
// liked theme: «вам нравятся фильмы про ограбления» says more than «криминал».
// The genres stay as the fallback when the keyword has no name in the
// response language.
func themed(r Reason, c *Candidate, t *Taste, w Weights) Reason {
	if r.Type != ReasonGenre && r.Type != ReasonTrending {
		return r
	}
	k, _ := bestKeyword(c, t, w.ThemeReasonMin)
	if k == 0 {
		return r
	}
	gs := r.GenreIDs
	if r.Type != ReasonGenre {
		gs = matchingGenres(c, t)
	}
	return Reason{Type: ReasonTheme, KeywordID: k, GenreIDs: gs}
}

// mainReason picks the most explanatory source.
func mainReason(c *Candidate, t *Taste) Reason {
	var best *Source
	bestV := -1.0
	for i := range c.Sources {
		s := &c.Sources[i]
		v := s.Strength * typePriority[s.Type]
		if v > bestV || (v == bestV && best != nil && sourceKey(s) < sourceKey(best)) {
			best, bestV = s, v
		}
	}
	if best == nil {
		return Reason{Type: ReasonGenre, GenreIDs: matchingGenres(c, t)}
	}
	switch best.Type {
	case ReasonBecause, ReasonRewatch:
		return Reason{Type: best.Type, MediaID: best.MediaID}
	case ReasonDirector, ReasonActor:
		return Reason{Type: best.Type, PersonID: best.PersonID}
	case ReasonAI:
		return Reason{Type: best.Type, CollectionID: best.CollectionID}
	case ReasonTheme:
		return Reason{Type: best.Type, KeywordID: best.KeywordID, GenreIDs: matchingGenres(c, t)}
	case ReasonDifferent:
		return Reason{Type: best.Type, GenreIDs: best.GenreIDs}
	case ReasonGenre:
		if gs := matchingGenres(c, t); len(gs) > 0 {
			return Reason{Type: ReasonGenre, GenreIDs: gs}
		}
		return Reason{Type: ReasonGenre, GenreIDs: best.GenreIDs}
	}
	return Reason{Type: best.Type}
}

func sourceKey(s *Source) string {
	return s.Type + "|" + s.MediaID + "|" + strconv.Itoa(s.PersonID) + "|" + s.CollectionID + "|" + strconv.Itoa(s.KeywordID)
}

// matchingGenres: the candidate's genres the profile likes, best first (≤ 2).
func matchingGenres(c *Candidate, t *Taste) []int {
	gs := slices.Clone(c.Genres)
	slices.SortStableFunc(gs, func(a, b int) int {
		sa, sb := t.genreScore(a), t.genreScore(b)
		switch {
		case sa > sb:
			return -1
		case sa < sb:
			return 1
		}
		return a - b
	})
	var out []int
	for _, g := range gs {
		if len(out) == 2 || t.genreScore(g) <= 0 {
			break
		}
		out = append(out, g)
	}
	return out
}

func (s *Scored) source(typ string, match func(*Source) bool) *Source {
	for i := range s.Sources {
		if s.Sources[i].Type == typ && (match == nil || match(&s.Sources[i])) {
			return &s.Sources[i]
		}
	}
	return nil
}

// similarity for MMR: shared genres, decade, seed and main reason.
func similarity(a, b *Scored) float64 {
	s := 0.6 * jaccard(a.Genres, b.Genres)
	if reflect.DeepEqual(a.Reason, b.Reason) {
		s += 0.25
	}
	if a.Year > 0 && a.Year/10 == b.Year/10 {
		s += 0.2
	}
	for _, x := range a.Sources {
		if x.Type == ReasonBecause && b.source(ReasonBecause, func(y *Source) bool { return y.MediaID == x.MediaID }) != nil {
			s += 0.2
			break
		}
	}
	return s
}

func jaccard(a, b []int) float64 {
	if len(a) == 0 && len(b) == 0 {
		return 0
	}
	inter := 0
	for _, x := range a {
		if slices.Contains(b, x) {
			inter++
		}
	}
	return float64(inter) / float64(len(a)+len(b)-inter)
}

// mmr greedily picks k items maximizing λ·relevance − (1−λ)·max similarity
// to those already picked. keys are row-specific relevance values.
func mmr(items []*Scored, keys []float64, k int, lambda float64) []int {
	if len(items) == 0 || k <= 0 {
		return nil
	}
	lo, hi := math.Inf(1), math.Inf(-1)
	for _, v := range keys {
		lo, hi = math.Min(lo, v), math.Max(hi, v)
	}
	// The weakest key maps to 0.5, not 0, so diversity can't promote
	// clearly worse items too eagerly.
	lo -= hi - lo
	norm := func(v float64) float64 {
		if hi == lo {
			return 1
		}
		return (v - lo) / (hi - lo)
	}
	picked := []int{}
	taken := make([]bool, len(items))
	for len(picked) < k {
		best, bestV := -1, math.Inf(-1)
		for i, it := range items {
			if taken[i] {
				continue
			}
			maxSim := 0.0
			for _, p := range picked {
				maxSim = math.Max(maxSim, similarity(it, items[p]))
			}
			v := lambda*norm(keys[i]) - (1-lambda)*maxSim
			if v > bestV+1e-12 {
				best, bestV = i, v
			}
		}
		if best < 0 {
			break
		}
		taken[best] = true
		picked = append(picked, best)
	}
	return picked
}

// CollectionRef is an AI collection offered as a row. Theme = the model
// grouped the scorer's own candidates (kind 'theme').
type CollectionRef struct {
	ID    string
	Theme bool
}

// rowSpec is a row being built: its identity, how it ranks candidates
// (key; ok=false = not eligible) and the items picked so far.
type rowSpec struct {
	id, kind   string
	reason     Reason
	itemReason *Reason // nil = each item keeps its own main reason
	key        func(*Scored) (float64, bool)
	slot       int // display position
	items      []cachedItem
}

// BuildRows turns scored candidates into ordered rows. Every title appears
// in at most one row. Three phases keep both the top row and the specific
// rows strong: (1) every specific row reserves MinRowItems titles, scarce
// rows first (a person's filmography, a collection); (2) «Подобрано для
// вас» takes the best of the rest; (3) the specific rows fill up to
// RowSize. Deterministic for fixed inputs.
func BuildRows(all []Scored, t *Taste, w Weights, cols []CollectionRef, cold bool) []cachedRow {
	rows, _ := BuildRowsAI(all, t, w, cols, cold, nil)
	return rows
}

// BuildRowsAI is BuildRows with the AI re-ranking of «Подобрано для вас»:
// aiPicks (media ids, the model's order) lead the row when still eligible
// and are reserved before the specific rows; the rest fills up as usual.
// It also returns the row's candidates — the current picks plus the best
// titles left for the row, RerankCandidates in all — which the next
// re-ranking is asked about.
func BuildRowsAI(all []Scored, t *Taste, w Weights, cols []CollectionRef, cold bool, aiPicks []string) ([]cachedRow, []string) {
	sorted := make([]*Scored, 0, len(all))
	for i := range all {
		sorted = append(sorted, &all[i])
	}
	slices.SortStableFunc(sorted, func(a, b *Scored) int {
		if a.Score != b.Score {
			if a.Score > b.Score {
				return -1
			}
			return 1
		}
		return cmpStr(a.MediaID, b.MediaID)
	})
	used := map[string]bool{}
	// pick selects up to k unused eligible items by MMR among the best by key.
	pick := func(k int, spec *rowSpec) []cachedItem {
		if k <= 0 {
			return nil
		}
		var items []*Scored
		var keys []float64
		for _, s := range sorted {
			if used[s.MediaID] || s.Watchlist && s.source(ReasonRewatch, nil) == nil {
				continue
			}
			if v, ok := spec.key(s); ok {
				items = append(items, s)
				keys = append(keys, v)
			}
			if len(items) >= 200 {
				break
			}
		}
		order := make([]int, len(items))
		for i := range order {
			order[i] = i
		}
		slices.SortStableFunc(order, func(a, b int) int {
			switch {
			case keys[a] > keys[b]:
				return -1
			case keys[a] < keys[b]:
				return 1
			}
			return 0
		})
		top := min(len(order), k*4)
		cItems, cKeys := make([]*Scored, top), make([]float64, top)
		for i := 0; i < top; i++ {
			cItems[i], cKeys[i] = items[order[i]], keys[order[i]]
		}
		out := []cachedItem{}
		for _, i := range mmr(cItems, cKeys, k, w.MMRLambda) {
			s := cItems[i]
			used[s.MediaID] = true
			r := s.Reason
			if spec.itemReason != nil {
				r = *spec.itemReason
			}
			out = append(out, cachedItem{MediaID: s.MediaID, Score: s.Score, Reason: r})
		}
		return out
	}
	release := func(items []cachedItem) {
		for _, it := range items {
			delete(used, it.MediaID)
		}
	}
	// reserve picks a spec's first MinRowItems; false (and nothing kept)
	// when there aren't enough.
	reserve := func(spec *rowSpec) bool {
		items := pick(w.MinRowItems, spec)
		if len(items) < w.MinRowItems {
			release(items)
			return false
		}
		spec.items = items
		return true
	}
	finish := func(specs []*rowSpec) []cachedRow {
		rows := []cachedRow{}
		for _, sp := range specs {
			if len(sp.items) >= w.MinRowItems {
				rows = append(rows, cachedRow{ID: sp.id, Kind: sp.kind, Reason: sp.reason, Items: sp.items})
			}
		}
		return rows
	}

	if cold {
		popular := &rowSpec{id: "popular", kind: RowPopular, reason: Reason{Type: ReasonPopular}, itemReason: &Reason{Type: ReasonPopular},
			key: func(s *Scored) (float64, bool) {
				src := s.source(ReasonPopular, func(x *Source) bool { return x.MediaID == "trending" })
				if src == nil {
					return 0, false
				}
				return src.Strength, true
			}}
		top := &rowSpec{id: RowTopPicks, kind: RowTopPicks, reason: Reason{Type: ReasonPopular},
			key: func(s *Scored) (float64, bool) { return s.Quality + 0.2*s.Score, true }}
		popular.items = pick(w.RowSize, popular)
		top.items = pick(w.RowSize, top)
		return finish([]*rowSpec{popular, top}), nil
	}

	topGenres := []int{}
	for _, k := range topPositive(t.Genres, 3, 0.2) {
		g, _ := strconv.Atoi(k)
		topGenres = append(topGenres, g)
	}
	var specs []*rowSpec
	has := func(id string) bool {
		return slices.ContainsFunc(specs, func(sp *rowSpec) bool { return sp.id == id })
	}
	count := func(kind string) int {
		n := 0
		for _, sp := range specs {
			if sp.kind == kind {
				n++
			}
		}
		return n
	}
	try := func(sp *rowSpec) bool {
		if has(sp.id) || !reserve(sp) {
			return false
		}
		specs = append(specs, sp)
		return true
	}
	// because: the first seed (in seed order) without a row that has enough.
	because := func(slot int) func() {
		return func() {
			if count(RowBecause) >= w.BecauseRows {
				return
			}
			for _, seed := range t.Seeds {
				r := Reason{Type: ReasonBecause, MediaID: seed.MediaID}
				if try(&rowSpec{id: "byr:" + seed.MediaID, kind: RowBecause, reason: r, itemReason: &r, slot: slot,
					key: func(s *Scored) (float64, bool) {
						src := s.source(ReasonBecause, func(x *Source) bool { return x.MediaID == seed.MediaID })
						if src == nil {
							return 0, false
						}
						return s.Score + w.Source*src.Strength, true
					}}) {
					return
				}
			}
		}
	}
	person := func(kind string, list []Affinity, maxRows, slot int) func() {
		return func() {
			if count(kind) >= maxRows {
				return
			}
			for _, a := range list {
				if a.Score < 0.3 {
					break
				}
				pid, _ := strconv.Atoi(a.Key)
				r := Reason{Type: kind, PersonID: pid}
				if try(&rowSpec{id: kind + ":" + a.Key, kind: kind, reason: r, itemReason: &r, slot: slot,
					key: func(s *Scored) (float64, bool) {
						src := s.source(kind, func(x *Source) bool { return x.PersonID == pid })
						if src == nil {
							return 0, false
						}
						return s.Score + w.Source*src.Strength, true
					}}) {
					return
				}
			}
		}
	}
	simple := func(id, kind, srcType string, rowReason Reason, slot int, key func(*Scored, *Source) (float64, bool)) func() {
		return func() {
			try(&rowSpec{id: id, kind: kind, reason: rowReason, slot: slot, key: func(s *Scored) (float64, bool) {
				src := s.source(srcType, nil)
				if src == nil {
					return 0, false
				}
				return key(s, src)
			}})
		}
	}
	var aiCols, themeCols []CollectionRef
	for _, c := range cols {
		if c.Theme {
			themeCols = append(themeCols, c)
		} else {
			aiCols = append(aiCols, c)
		}
	}
	collectionOf := func(cols []CollectionRef) func(i, slot int) func() {
		return func(i, slot int) func() {
			return func() {
				if i >= len(cols) {
					return
				}
				cid := cols[i].ID
				r := Reason{Type: ReasonAI, CollectionID: cid}
				try(&rowSpec{id: "ai:" + cid, kind: RowAI, reason: r, itemReason: &r, slot: slot, key: func(s *Scored) (float64, bool) {
					src := s.source(ReasonAI, func(x *Source) bool { return x.CollectionID == cid })
					if src == nil {
						return 0, false
					}
					return src.Strength, true // keep the collection's order
				}})
			}
		}
	}
	collection, themeCollection := collectionOf(aiCols), collectionOf(themeCols)
	// theme: a row per liked keyword whose discover source found enough.
	theme := func(slot int) func() {
		return func() {
			if count(RowTheme) >= w.ThemeRows {
				return
			}
			for _, a := range t.Keywords {
				if a.Score < w.ThemeReasonMin {
					break
				}
				kid, _ := strconv.Atoi(a.Key)
				r := Reason{Type: ReasonTheme, KeywordID: kid}
				if try(&rowSpec{id: "theme:" + a.Key, kind: RowTheme, reason: r, itemReason: &r, slot: slot,
					key: func(s *Scored) (float64, bool) {
						src := s.source(ReasonTheme, func(x *Source) bool { return x.KeywordID == kid })
						if src == nil {
							return 0, false
						}
						return s.Score + w.Source*src.Strength, true
					}}) {
					return
				}
			}
		}
	}
	// Build order = reservation priority (scarce rows first); slot = display order.
	// AI theme rubrics come first: the model grouped exactly these
	// candidates, and they are useless if other rows take them.
	plan := []func(){
		themeCollection(0, 6),
		themeCollection(1, 12),
		person(ReasonDirector, t.Directors, w.DirectorRows, 2),
		person(ReasonActor, t.Actors, w.ActorRows, 10),
		collection(0, 5),
		collection(1, 12),
		theme(7),
		because(1), because(4), because(7),
		simple("hidden_gems", RowHiddenGems, ReasonHiddenGem, Reason{Type: ReasonHiddenGem}, 3,
			func(s *Scored, _ *Source) (float64, bool) { return s.Score, true }),
		simple("something_different", RowDifferent, ReasonDifferent, Reason{Type: ReasonDifferent}, 6,
			func(s *Scored, _ *Source) (float64, bool) { return s.Quality + 0.3*s.Score, true }),
		simple("genre", RowGenre, ReasonGenre, Reason{Type: ReasonGenre, GenreIDs: topGenres}, 8,
			func(s *Scored, _ *Source) (float64, bool) { return s.Score, s.Genre > 0 }),
		person(ReasonDirector, t.Directors, w.DirectorRows, 9),
		simple("trending", RowTrending, ReasonTrending, Reason{Type: ReasonTrending}, 11,
			func(s *Scored, _ *Source) (float64, bool) { return s.Score, s.Genre > 0 }), // trending, filtered by taste
		simple("rewatch", RowRewatch, ReasonRewatch, Reason{Type: ReasonRewatch}, 13,
			func(s *Scored, src *Source) (float64, bool) { return src.Strength, true }),
	}
	top := &rowSpec{id: RowTopPicks, kind: RowTopPicks, reason: Reason{Type: ReasonGenre, GenreIDs: topGenres},
		key: func(s *Scored) (float64, bool) { return s.Score, s.source(ReasonRewatch, nil) == nil }}
	// Phase 0: the AI re-ranking's picks are «Подобрано для вас» — reserved
	// before any specific row can take them (model order, still eligible).
	var aiTop []cachedItem
	if len(aiPicks) > 0 {
		byID := make(map[string]*Scored, len(sorted))
		for _, s := range sorted {
			byID[s.MediaID] = s
		}
		for _, id := range aiPicks {
			s := byID[id]
			if len(aiTop) >= w.TopPicks || s == nil || used[id] || s.Watchlist {
				continue
			}
			if _, ok := top.key(s); !ok {
				continue
			}
			used[id] = true
			aiTop = append(aiTop, cachedItem{MediaID: id, Score: s.Score, Reason: s.Reason})
		}
	}
	for _, step := range plan {
		step()
	}
	// Phase 2: the best of the rest, diversified. The next re-ranking sees
	// the current picks plus the best RerankCandidates of the rest.
	first := pick(w.TopPicks-len(aiTop), top)
	more := pick(max(0, w.RerankCandidates-len(aiTop)-len(first)), top)
	var cands []string
	for _, list := range [][]cachedItem{aiTop, first, more} {
		for _, it := range list {
			cands = append(cands, it.MediaID)
		}
	}
	release(more)
	top.items = append(aiTop, first...)
	// Phase 3: fill the specific rows.
	for _, sp := range specs {
		sp.items = append(sp.items, pick(w.RowSize-len(sp.items), sp)...)
	}
	slices.SortStableFunc(specs, func(a, b *rowSpec) int { return a.slot - b.slot })
	return finish(append([]*rowSpec{top}, specs...)), cands
}

// BuildPool is the scored pool for Surprise Me (best first).
func BuildPool(all []Scored, w Weights) []cachedItem {
	items := make([]cachedItem, 0, len(all))
	for _, s := range all {
		if s.source(ReasonRewatch, nil) != nil && len(s.Sources) == 1 {
			continue
		}
		items = append(items, cachedItem{MediaID: s.MediaID, Score: s.Score, Reason: s.Reason, Watchlist: s.Watchlist})
	}
	slices.SortStableFunc(items, func(a, b cachedItem) int {
		if a.Score != b.Score {
			if a.Score > b.Score {
				return -1
			}
			return 1
		}
		return cmpStr(a.MediaID, b.MediaID)
	})
	return limit(items, w.PoolSize)
}
