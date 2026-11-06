package foryou

import (
	"context"
	"math"
	"slices"

	"martytv/api/internal/catalog"
)

// SurpriseRequest is the contract's SurpriseRequest.
type SurpriseRequest struct {
	ProfileID      string   `json:"profile_id"`
	Mood           string   `json:"mood"`
	Genres         []int    `json:"genres"`
	RuntimeMin     *int     `json:"runtime_min"`
	RuntimeMax     *int     `json:"runtime_max"`
	Decade         *int     `json:"decade"`
	MinRating      *float64 `json:"min_rating"`
	IncludeWatched bool     `json:"include_watched"`
	Kind           string   `json:"kind"`
	ExcludeIDs     []string `json:"exclude_ids"`
}

// SurpriseResult is the contract's SurpriseResult.
type SurpriseResult struct {
	Media    *catalog.MediaSummary `json:"media"`
	Reason   *ReasonOut            `json:"reason"`
	Source   string                `json:"source"`
	PoolSize int                   `json:"pool_size"`
	Reroll   struct {
		ExcludeIDs []string `json:"exclude_ids"`
	} `json:"reroll"`
}

// surpriseFilter checks a title's facts against the request.
type surpriseFilter struct {
	req    SurpriseRequest
	genres map[int]bool // any of (movie + tv ids); nil = no genre filter
	not    map[int]bool
}

func newSurpriseFilter(req SurpriseRequest) surpriseFilter {
	f := surpriseFilter{req: req}
	var want, not []int
	if m := moodByKey(req.Mood); m != nil {
		want, not = append(want, m.Genres...), append(not, m.Without...)
	}
	want = append(want, req.Genres...)
	if len(want) > 0 {
		f.genres = map[int]bool{}
		for _, g := range append(want, genresFor("series", want)...) {
			f.genres[g] = true
		}
	}
	if len(not) > 0 {
		f.not = map[int]bool{}
		for _, g := range append(not, genresFor("series", not)...) {
			f.not[g] = true
		}
	}
	return f
}

func (f surpriseFilter) ok(m mediaFacts) bool {
	r := f.req
	if r.Kind != "any" && m.Kind != r.Kind {
		return false
	}
	if f.genres != nil && !slices.ContainsFunc(m.Genres, func(g int) bool { return f.genres[g] }) {
		return false
	}
	if slices.ContainsFunc(m.Genres, func(g int) bool { return f.not[g] }) {
		return false
	}
	if r.Decade != nil && (m.Year < *r.Decade || m.Year > *r.Decade+9) {
		return false
	}
	if r.RuntimeMin != nil || r.RuntimeMax != nil {
		if m.Runtime <= 0 || r.RuntimeMin != nil && m.Runtime < *r.RuntimeMin || r.RuntimeMax != nil && m.Runtime > *r.RuntimeMax {
			return false
		}
	}
	if r.MinRating != nil {
		rating := m.KPRating
		if rating == 0 {
			if m.VoteCount < 50 {
				return false
			}
			rating = m.VoteAverage
		}
		if rating < *r.MinRating {
			return false
		}
	}
	return true
}

// weightedPick chooses an index with probability ∝ exp((score − best)/T)
// among the first 60 (scores sorted descending).
func weightedPick(scores []float64, r float64) int {
	n := min(len(scores), 60)
	if n == 0 {
		return -1
	}
	const temp = 0.25
	ws := make([]float64, n)
	sum := 0.0
	for i := 0; i < n; i++ {
		ws[i] = math.Exp((scores[i] - scores[0]) / temp)
		sum += ws[i]
	}
	x := r * sum
	for i, w := range ws {
		if x < w {
			return i
		}
		x -= w
	}
	return n - 1
}

// Surprise is POST /foryou/surprise.
func (s *Service) Surprise(ctx context.Context, req SurpriseRequest, lang string) (*SurpriseResult, error) {
	if req.Kind == "" {
		req.Kind = "movie"
	}
	res := &SurpriseResult{Source: "none"}
	exclude := map[string]bool{}
	for _, id := range req.ExcludeIDs {
		exclude[id] = true
	}
	finish := func(id string, reason Reason) (*SurpriseResult, error) {
		res.Reroll.ExcludeIDs = append(slices.Clone(req.ExcludeIDs), id)
		if len(res.Reroll.ExcludeIDs) > 200 {
			res.Reroll.ExcludeIDs = res.Reroll.ExcludeIDs[len(res.Reroll.ExcludeIDs)-200:]
		}
		sums, err := s.summaries(ctx, req.ProfileID, lang, []string{id})
		if err != nil || len(sums) == 0 {
			return res, err
		}
		rc, err := s.newRender(ctx, lang, nil, []Reason{reason})
		if err != nil {
			return nil, err
		}
		ro := rc.reason(reason)
		res.Media, res.Reason = &sums[0], &ro
		return res, nil
	}
	res.Reroll.ExcludeIDs = nonNilSlice(slices.Clone(req.ExcludeIDs))

	c, err := s.ensureCache(ctx, req.ProfileID, lang)
	if err != nil {
		return nil, err
	}
	pool := slices.Clone(c.Pool)
	seen, err := s.seenSet(ctx, req.ProfileID)
	if err != nil {
		return nil, err
	}
	if req.IncludeWatched {
		extra, err := s.rewatchPool(ctx, req.ProfileID)
		if err != nil {
			return nil, err
		}
		pool = append(pool, extra...)
	}
	ids := make([]string, len(pool))
	for i, it := range pool {
		ids[i] = it.MediaID
	}
	facts, err := s.loadFeatures(ctx, ids)
	if err != nil {
		return nil, err
	}
	anime, err := s.animeFilter(ctx, req.ProfileID, ids)
	if err != nil {
		return nil, err
	}
	dismissed, err := s.dismissedSet(ctx, req.ProfileID, ids)
	if err != nil {
		return nil, err
	}
	f := newSurpriseFilter(req)
	var match []cachedItem
	dup := map[string]bool{}
	for _, it := range pool {
		m, ok := facts[it.MediaID]
		if !ok || exclude[it.MediaID] || anime[it.MediaID] || dismissed[it.MediaID] || dup[it.MediaID] {
			continue
		}
		if seen[it.MediaID] && !(req.IncludeWatched && it.Reason.Type == ReasonRewatch) {
			continue
		}
		if !f.ok(m) {
			continue
		}
		dup[it.MediaID] = true
		match = append(match, it)
	}
	slices.SortStableFunc(match, func(a, b cachedItem) int {
		switch {
		case a.Score > b.Score:
			return -1
		case a.Score < b.Score:
			return 1
		}
		return 0
	})
	res.PoolSize = len(match)
	if len(match) > 0 {
		scores := make([]float64, len(match))
		for i, it := range match {
			scores[i] = it.Score
		}
		it := match[weightedPick(scores, s.random())]
		res.Source = "pool"
		reason := it.Reason
		if req.Mood != "" && reason.Type != ReasonRewatch {
			reason = Reason{Type: ReasonMood, Mood: req.Mood}
		}
		return finish(it.MediaID, reason)
	}

	// Fallback: TMDB discover with the same filters.
	if !s.cat.Available() {
		return res, nil
	}
	kinds := []string{req.Kind}
	if req.Kind == "any" {
		kinds = []string{"movie", "series"}
	}
	mv := s.minVotes(ctx, req.ProfileID)
	var cands []catalog.MediaSummary
	for _, kind := range kinds {
		p := catalog.DiscoverParams{Kind: kind, Sort: "popularity", Page: 1 + int(s.random()*3), Lang: lang,
			RuntimeMin: req.RuntimeMin, RuntimeMax: req.RuntimeMax}
		vc := votesFloor(200, mv)
		p.VoteCountMin = &vc
		if m := moodByKey(req.Mood); m != nil {
			p.AnyGenres, p.WithoutGenres = genresFor(kind, append(slices.Clone(m.Genres), req.Genres...)), genresFor(kind, m.Without)
		} else if len(req.Genres) > 0 {
			p.AnyGenres = genresFor(kind, req.Genres)
		}
		if req.Decade != nil {
			from, to := *req.Decade, *req.Decade+9
			p.YearFrom, p.YearTo = &from, &to
		}
		if req.MinRating != nil {
			r := *req.MinRating
			p.RatingMin = &r
		}
		pg, err := s.cat.Discover(ctx, p)
		if err != nil {
			s.log.DebugContext(ctx, "foryou: surprise discover failed", "err", err)
			continue
		}
		cands = append(cands, pg.Items...)
	}
	var ok []string
	for _, m := range cands {
		if exclude[m.ID] || (seen[m.ID] && !req.IncludeWatched) || slices.Contains(ok, m.ID) {
			continue
		}
		ok = append(ok, m.ID)
	}
	animeD, err := s.animeFilter(ctx, req.ProfileID, ok)
	if err != nil {
		return nil, err
	}
	ok = filterIDs(ok, func(id string) bool { return !animeD[id] })
	res.PoolSize = len(ok)
	if len(ok) == 0 {
		return res, nil
	}
	// Earlier (more popular) results are more likely.
	scores := make([]float64, len(ok))
	for i := range ok {
		scores[i] = -0.05 * float64(i)
	}
	id := ok[weightedPick(scores, s.random())]
	res.Source = "discover"
	reason := Reason{Type: ReasonPopular}
	if req.Mood != "" {
		reason = Reason{Type: ReasonMood, Mood: req.Mood}
	}
	return finish(id, reason)
}

// rewatchPool: favourites and highly rated completed titles (include_watched).
func (s *Service) rewatchPool(ctx context.Context, profileID string) ([]cachedItem, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, COALESCE(r.rating, 8)
		FROM media m
		LEFT JOIN ratings r ON r.profile_id = $1 AND r.media_id = m.id
		WHERE (r.rating >= 8 OR EXISTS (SELECT 1 FROM favorites f WHERE f.profile_id = $1 AND f.media_id = m.id))
		ORDER BY COALESCE(r.rating, 8) DESC, m.id LIMIT 300`, profileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []cachedItem
	for rows.Next() {
		var id string
		var rating int
		if err := rows.Scan(&id, &rating); err != nil {
			return nil, err
		}
		out = append(out, cachedItem{MediaID: id, Score: 0.5 + float64(rating)/10, Reason: Reason{Type: ReasonRewatch, MediaID: id}})
	}
	return out, rows.Err()
}
