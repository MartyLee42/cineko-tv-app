package foryou

import (
	"context"
	"slices"
	"strconv"
	"sync"
	"time"

	"martytv/api/internal/catalog"
)

// candidateSet accumulates candidates from concurrent sources.
type candidateSet struct {
	mu sync.Mutex
	m  map[string]*Candidate
	// order keeps insertion order for determinism of ties.
	order []string
}

func newCandidateSet() *candidateSet { return &candidateSet{m: map[string]*Candidate{}} }

func (cs *candidateSet) add(id string, src Source) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	c := cs.m[id]
	if c == nil {
		c = &Candidate{MediaID: id}
		cs.m[id] = c
		cs.order = append(cs.order, id)
	}
	// One source per (type, seed/person/collection): keep the strongest.
	for i := range c.Sources {
		x := &c.Sources[i]
		if x.Type == src.Type && x.MediaID == src.MediaID && x.PersonID == src.PersonID && x.CollectionID == src.CollectionID {
			if src.Strength > x.Strength {
				*x = src
			}
			return
		}
	}
	c.Sources = append(c.Sources, src)
}

// rankFactor decays a TMDB list position (0-based) from 1 to 0.5.
func rankFactor(i, n int) float64 {
	if n <= 1 {
		return 1
	}
	return 1 - 0.5*float64(i)/float64(n-1)
}

// generate collects candidates from TMDB (through the catalog cache) for a
// taste. Each source failing is logged and skipped. paced = background run
// (TMDB calls go through the run's own limiter).
// mv is the profile's min_votes: every discover vote floor follows it
// (votesFloor).
func (s *Service) generate(ctx context.Context, t *Taste, lang string, cold, paced bool, mv int) *candidateSet {
	cs := newCandidateSet()
	if !s.cat.Available() {
		return cs
	}
	var jobs []func(context.Context)
	page := func(name string, src func(i, n int, it catalog.MediaSummary) (Source, bool), fetch func(context.Context) (*catalog.MediaPage, error)) func(context.Context) {
		return func(ctx context.Context) {
			if paced {
				if err := s.pace.Wait(ctx); err != nil {
					return
				}
			}
			p, err := fetch(ctx)
			if err != nil {
				s.log.DebugContext(ctx, "foryou: candidate source failed", "source", name, "err", err)
				return
			}
			for i, it := range p.Items {
				if sc, ok := src(i, len(p.Items), it); ok {
					cs.add(it.ID, sc)
				}
			}
		}
	}
	vc := func(n int) *int { n = votesFloor(n, mv); return &n }
	vr := func(n int) *int { n = ratedVotesFloor(n, mv); return &n }
	rmin := func(f float64) *float64 { return &f }

	// Trending: shared by every profile (and the cold-start row).
	jobs = append(jobs, page("trending", func(i, n int, _ catalog.MediaSummary) (Source, bool) {
		if cold {
			return Source{Type: ReasonPopular, MediaID: "trending", Strength: rankFactor(i, n) * 0.5}, true
		}
		return Source{Type: ReasonTrending, Strength: s.w.SrcTrending * rankFactor(i, n)}, true
	}, func(ctx context.Context) (*catalog.MediaPage, error) {
		return s.cat.List(ctx, "trending", "all", lang, 1, false)
	}))

	if cold {
		jobs = append(jobs, page("top_rated", func(i, n int, _ catalog.MediaSummary) (Source, bool) {
			return Source{Type: ReasonPopular, MediaID: "top_rated", Strength: rankFactor(i, n) * 0.4}, true
		}, func(ctx context.Context) (*catalog.MediaPage, error) {
			return s.cat.List(ctx, "top_rated", "movie", lang, 1, false)
		}))
		jobs = append(jobs, page("popular", func(i, n int, _ catalog.MediaSummary) (Source, bool) {
			return Source{Type: ReasonPopular, MediaID: "popular", Strength: rankFactor(i, n) * 0.3}, true
		}, func(ctx context.Context) (*catalog.MediaPage, error) {
			return s.cat.List(ctx, "popular", "movie", lang, 1, false)
		}))
	}

	// Seeds: TMDB recommendations of liked titles.
	maxSeed := 0.0
	for _, sd := range t.Seeds {
		maxSeed = max(maxSeed, sd.Weight)
	}
	for _, sd := range limit(t.Seeds, 10) {
		strength := 0.5
		if maxSeed > 0 {
			strength = 0.4 + 0.6*sd.Weight/maxSeed
		}
		jobs = append(jobs, page("seed", func(i, n int, _ catalog.MediaSummary) (Source, bool) {
			return Source{Type: ReasonBecause, MediaID: sd.MediaID, Strength: strength * rankFactor(i, n)}, true
		}, func(ctx context.Context) (*catalog.MediaPage, error) {
			return s.cat.Related(ctx, sd.MediaID, "recommendations", lang, 1)
		}))
	}

	topGenres := topPositive(t.Genres, 3, 0.2)
	gIDs := make([]int, 0, len(topGenres))
	for _, g := range topGenres {
		id, _ := strconv.Atoi(g)
		gIDs = append(gIDs, id)
	}
	seriesShare := 0.0
	if tot := t.Stats.Movies + t.Stats.Series; tot > 0 {
		seriesShare = float64(t.Stats.Series) / float64(tot)
	}
	// Discover by top genres (popular, with a vote floor), plus the top
	// decade when it isn't the current one.
	for _, g := range gIDs {
		jobs = append(jobs, page("genre", func(i, n int, _ catalog.MediaSummary) (Source, bool) {
			return Source{Type: ReasonGenre, GenreIDs: []int{g}, Strength: s.w.SrcGenre * rankFactor(i, n)}, true
		}, func(ctx context.Context) (*catalog.MediaPage, error) {
			return s.cat.Discover(ctx, catalog.DiscoverParams{Kind: "movie", Genres: []int{g}, Sort: "popularity", Page: 1, Lang: lang, VoteCountMin: vc(300)})
		}))
	}
	if len(gIDs) >= 2 {
		jobs = append(jobs, page("genre_pair", func(i, n int, _ catalog.MediaSummary) (Source, bool) {
			return Source{Type: ReasonGenre, GenreIDs: gIDs[:2], Strength: s.w.SrcGenre * 1.2 * rankFactor(i, n)}, true
		}, func(ctx context.Context) (*catalog.MediaPage, error) {
			return s.cat.Discover(ctx, catalog.DiscoverParams{Kind: "movie", Genres: gIDs[:2], Sort: "rating", Page: 1, Lang: lang, VoteCountMin: vr(500)})
		}))
	}
	if dec := topPositive(t.Decades, 1, 0.3); len(dec) == 1 && len(gIDs) > 0 {
		d, _ := strconv.Atoi(dec[0])
		if d < s.now().Year()/10*10 {
			from, to := d, d+9
			jobs = append(jobs, page("decade", func(i, n int, _ catalog.MediaSummary) (Source, bool) {
				return Source{Type: ReasonGenre, GenreIDs: gIDs[:1], Strength: s.w.SrcGenre * rankFactor(i, n)}, true
			}, func(ctx context.Context) (*catalog.MediaPage, error) {
				return s.cat.Discover(ctx, catalog.DiscoverParams{Kind: "movie", AnyGenres: gIDs, YearFrom: &from, YearTo: &to, Sort: "rating", Page: 1, Lang: lang, VoteCountMin: vr(500)})
			}))
		}
	}
	if seriesShare >= 0.15 && len(gIDs) > 0 {
		tvG := genresFor("series", gIDs)
		if len(tvG) > 0 {
			jobs = append(jobs, page("series_genre", func(i, n int, _ catalog.MediaSummary) (Source, bool) {
				return Source{Type: ReasonGenre, GenreIDs: tvG[:1], Strength: s.w.SrcGenre * rankFactor(i, n)}, true
			}, func(ctx context.Context) (*catalog.MediaPage, error) {
				return s.cat.Discover(ctx, catalog.DiscoverParams{Kind: "series", AnyGenres: tvG, Sort: "rating", Page: 1, Lang: lang, VoteCountMin: vr(300)})
			}))
		}
	}

	// Filmographies of favourite directors and actors (movies).
	people := func(kind string, list []Affinity, n int) {
		for _, a := range list {
			if n == 0 || a.Score < 0.3 {
				break
			}
			n--
			pid, _ := strconv.Atoi(a.Key)
			strength := a.Score
			jobs = append(jobs, page(kind, func(i, cnt int, _ catalog.MediaSummary) (Source, bool) {
				return Source{Type: kind, PersonID: pid, Strength: strength * rankFactor(i, cnt)}, true
			}, func(ctx context.Context) (*catalog.MediaPage, error) {
				// Only titles they directed (or starred in): TMDB's discover
				// with_crew would also match produced/written ones.
				job := "Director"
				if kind == ReasonActor {
					job = "Actor"
				}
				items, err := s.cat.PersonMovies(ctx, pid, job, lang, votesFloor(50, mv))
				if err != nil {
					return nil, err
				}
				return &catalog.MediaPage{Items: items}, nil
			}))
		}
	}
	people(ReasonDirector, t.Directors, 4)
	people(ReasonActor, t.Actors, 3)

	// Hidden gems: highly rated, few votes, in liked genres.
	if len(gIDs) > 0 {
		jobs = append(jobs, page("hidden_gems", func(i, n int, _ catalog.MediaSummary) (Source, bool) {
			return Source{Type: ReasonHiddenGem, Strength: s.w.SrcHiddenGem * rankFactor(i, n)}, true
		}, func(ctx context.Context) (*catalog.MediaPage, error) {
			// Released at least a year ago: brand-new titles have inflated
			// averages from a few early votes.
			to := s.now().Year() - 1
			lo, hi := hiddenGemVotes(mv)
			return s.cat.Discover(ctx, catalog.DiscoverParams{Kind: "movie", AnyGenres: gIDs, Sort: "rating", Page: 1, Lang: lang,
				YearTo: &to, RatingMin: rmin(7.2), VoteCountMin: &lo, VoteCountMax: &hi})
		}))
	}

	// Something different: acclaimed titles from genres outside the top
	// ones that the profile doesn't dislike; rotates daily.
	if !cold {
		if g, ok := differentGenre(t, s.now()); ok {
			jobs = append(jobs, page("different", func(i, n int, _ catalog.MediaSummary) (Source, bool) {
				return Source{Type: ReasonDifferent, GenreIDs: []int{g}, Strength: s.w.SrcDifferent * rankFactor(i, n)}, true
			}, func(ctx context.Context) (*catalog.MediaPage, error) {
				return s.cat.Discover(ctx, catalog.DiscoverParams{Kind: "movie", Genres: []int{g}, Sort: "rating", Page: 1, Lang: lang, VoteCountMin: vr(2000)})
			}))
		}
	}

	// Run with bounded concurrency.
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			j(ctx)
		}()
	}
	wg.Wait()
	// Deterministic order regardless of goroutine timing.
	slices.Sort(cs.order)
	for _, c := range cs.m {
		slices.SortFunc(c.Sources, func(a, b Source) int { return cmpStr(sourceKey(&a), sourceKey(&b)) })
	}
	return cs
}

// differentGenre picks a well-loved movie genre outside the profile's top
// five that it doesn't dislike; the choice rotates by day.
func differentGenre(t *Taste, now time.Time) (int, bool) {
	top := map[string]bool{}
	for _, k := range topPositive(t.Genres, 5, -1) {
		top[k] = true
	}
	var eligible []int
	for _, g := range []int{18, 35, 53, 878, 80, 9648, 12, 14, 10749, 16, 99, 36, 10752, 37, 10402, 27} {
		k := strconv.Itoa(g)
		if top[k] || t.genreScore(g) < -0.1 {
			continue
		}
		eligible = append(eligible, g)
	}
	if len(eligible) == 0 {
		return 0, false
	}
	return eligible[now.YearDay()%len(eligible)], true
}
