package foryou

import (
	"context"
	"slices"
	"time"

	"martytv/api/internal/catalog"
	"martytv/api/internal/watch"
)

// «Cineko TV»: a lean-back channel whose programme is built from «Для вас»
// on request only (GET /profiles/{id}/channel, when the viewer tunes in —
// nothing is computed or warmed ahead). Films from the profile's scored
// pool, plus the next episode of series in progress; nothing rated,
// dismissed, started or finished; consecutive picks alternate genres. The
// TV builds the clock («Сейчас … · до 21:40», «Далее в 21:40 …») from the
// estimated runtimes and asks for more when the list runs low.

// ContinueSource is the part of watch.Service the channel uses (optional).
type ContinueSource interface {
	ContinueWatching(ctx context.Context, profileID, lang string) ([]watch.ContinueItem, error)
}

const (
	// ChannelRowID is the feedback row_id of plays started on the channel.
	ChannelRowID        = "channel"
	ChannelDefaultCount = 8
	ChannelMaxCount     = 20
	// Unknown runtimes (list-only titles: details not fetched yet).
	channelMovieMinutes   = 105
	channelEpisodeMinutes = 45
	// channelWindow: picks consider this many best remaining candidates.
	channelWindow = 40
	// No playable torrent found by a search this recent → not on the channel.
	channelEmptySearch = 24 * time.Hour
)

// ChannelEpisode is the episode a series item plays.
type ChannelEpisode struct {
	ID            string `json:"id"`
	SeasonNumber  int    `json:"season_number"`
	EpisodeNumber int    `json:"episode_number"`
	Name          string `json:"name"`
}

// ChannelItem is one programme entry (contract ChannelItem).
type ChannelItem struct {
	Media   catalog.MediaSummary `json:"media"`
	Episode *ChannelEpisode      `json:"episode"`
	// RuntimeMinutes is an estimate when RuntimeKnown is false.
	RuntimeMinutes int  `json:"runtime_minutes"`
	RuntimeKnown   bool `json:"runtime_known"`
	// ResumeSeconds: an episode left mid-way starts where it was.
	ResumeSeconds float64 `json:"resume_seconds"`
	// Source: foryou (the scored pool) or continue (a series in progress).
	Source string     `json:"source"`
	Reason *ReasonOut `json:"reason"`
}

// Channel is the contract's ChannelProgramme.
type Channel struct {
	Items    []ChannelItem `json:"items"`
	PoolSize int           `json:"pool_size"`
}

// progCand is a programme candidate (pure input of buildProgramme).
type progCand struct {
	ID     string
	Genres []int
	Score  float64
	// Series: the next episode of a series in progress.
	Series bool
}

// buildProgramme orders up to count candidates (given best first): mostly
// by score with a little randomness, but a pick sharing the previous one's
// main genre (or any genre with it) is pushed back, and series episodes
// never follow each other and fill at most a third of the slots.
func buildProgramme(cands []progCand, count int, rnd func() float64) []progCand {
	left := slices.Clone(cands)
	maxSeries := (count + 2) / 3
	var out []progCand
	series := 0
	for len(out) < count && len(left) > 0 {
		best, bestScore := -1, 0.0
		for i := 0; i < len(left) && i < channelWindow; i++ {
			c := left[i]
			if c.Series && series >= maxSeries {
				continue
			}
			sc := c.Score + 0.2*rnd()
			if n := len(out); n > 0 {
				prev := out[n-1]
				if c.Series && prev.Series {
					sc -= 0.6
				}
				if len(c.Genres) > 0 && len(prev.Genres) > 0 && c.Genres[0] == prev.Genres[0] {
					sc -= 0.35
				}
				if sharesGenre(c.Genres, prev.Genres) {
					sc -= 0.15
				}
				if n > 1 && len(c.Genres) > 0 && len(out[n-2].Genres) > 0 && c.Genres[0] == out[n-2].Genres[0] {
					sc -= 0.1
				}
			}
			if best < 0 || sc > bestScore {
				best, bestScore = i, sc
			}
		}
		if best < 0 {
			break
		}
		if left[best].Series {
			series++
		}
		out = append(out, left[best])
		left = slices.Delete(left, best, best+1)
	}
	return out
}

func sharesGenre(a, b []int) bool {
	return slices.ContainsFunc(a, func(g int) bool { return slices.Contains(b, g) })
}

// rankScore spreads a pool sorted best first over 1 … 0.5.
func rankScore(i, n int) float64 {
	if n <= 1 {
		return 1
	}
	return 1 - 0.5*float64(i)/float64(n-1)
}

// Channel is GET /profiles/{id}/channel.
func (s *Service) Channel(ctx context.Context, profileID, lang string, count int, exclude []string) (*Channel, error) {
	if count <= 0 {
		count = ChannelDefaultCount
	}
	count = min(count, ChannelMaxCount)
	skip := map[string]bool{}
	for _, id := range exclude {
		skip[id] = true
	}
	c, err := s.ensureCache(ctx, profileID, lang)
	if err != nil {
		return nil, err
	}
	seen, err := s.seenSet(ctx, profileID)
	if err != nil {
		return nil, err
	}

	// The pool's films, best first, without what the profile has rated,
	// started, finished or dismissed.
	var ids []string
	byID := map[string]cachedItem{}
	for _, it := range c.Pool {
		if skip[it.MediaID] || seen[it.MediaID] || it.Reason.Type == ReasonRewatch {
			continue
		}
		if _, dup := byID[it.MediaID]; dup {
			continue
		}
		byID[it.MediaID] = it
		ids = append(ids, it.MediaID)
	}

	// Series in progress: their next episode.
	type nextEp struct {
		ep     ChannelEpisode
		resume float64
	}
	eps := map[string]nextEp{}
	var seriesIDs []string
	if s.cont != nil {
		items, err := s.cont.ContinueWatching(ctx, profileID, lang)
		if err != nil {
			s.log.WarnContext(ctx, "foryou: channel without series in progress", "err", err)
		}
		for _, it := range items {
			nu := it.NextUp
			if nu == nil || it.Media.Kind != "series" || skip[it.Media.ID] {
				continue
			}
			e := nextEp{ep: ChannelEpisode{ID: nu.EpisodeID, SeasonNumber: nu.SeasonNumber, EpisodeNumber: nu.EpisodeNumber, Name: nu.Name}}
			if p := it.Progress; p != nil && p.EpisodeID != nil && *p.EpisodeID == nu.EpisodeID && !p.Completed {
				e.resume = p.PositionSeconds
			}
			eps[it.Media.ID] = e
			seriesIDs = append(seriesIDs, it.Media.ID)
		}
	}

	all := append(slices.Clone(ids), seriesIDs...)
	facts, err := s.loadFeatures(ctx, all)
	if err != nil {
		return nil, err
	}
	anime, err := s.animeFilter(ctx, profileID, all)
	if err != nil {
		return nil, err
	}
	dismissed, err := s.dismissedSet(ctx, profileID, all)
	if err != nil {
		return nil, err
	}
	dead, err := s.knownUnplayable(ctx, ids)
	if err != nil {
		return nil, err
	}

	var films []progCand
	for _, id := range ids {
		m, ok := facts[id]
		if !ok || m.Kind != "movie" || anime[id] || dismissed[id] || dead[id] {
			continue
		}
		films = append(films, progCand{ID: id, Genres: m.Genres})
	}
	slices.SortStableFunc(films, func(a, b progCand) int {
		sa, sb := byID[a.ID].Score, byID[b.ID].Score
		switch {
		case sa > sb:
			return -1
		case sa < sb:
			return 1
		}
		return 0
	})
	for i := range films {
		films[i].Score = rankScore(i, len(films))
	}
	var cands []progCand
	j := 0
	for _, id := range seriesIDs {
		if anime[id] || dismissed[id] {
			continue
		}
		// Most recently watched first, a strong (not overwhelming) pull.
		cands = append(cands, progCand{ID: id, Genres: facts[id].Genres, Score: 0.9 - 0.05*float64(j), Series: true})
		j++
	}
	cands = append(cands, films...)
	slices.SortStableFunc(cands, func(a, b progCand) int {
		switch {
		case a.Score > b.Score:
			return -1
		case a.Score < b.Score:
			return 1
		}
		return 0
	})
	picked := buildProgramme(cands, count, s.random)

	out := &Channel{Items: []ChannelItem{}, PoolSize: len(cands)}
	if len(picked) == 0 {
		return out, nil
	}
	pickIDs := make([]string, len(picked))
	var reasons []Reason
	for i, p := range picked {
		pickIDs[i] = p.ID
		if !p.Series {
			reasons = append(reasons, byID[p.ID].Reason)
		}
	}
	sums, err := s.summaries(ctx, profileID, lang, pickIDs)
	if err != nil {
		return nil, err
	}
	sumByID := make(map[string]catalog.MediaSummary, len(sums))
	for _, m := range sums {
		sumByID[m.ID] = m
	}
	rc, err := s.newRender(ctx, lang, nil, reasons)
	if err != nil {
		return nil, err
	}
	var epIDs []string
	for _, p := range picked {
		if p.Series {
			epIDs = append(epIDs, eps[p.ID].ep.ID)
		}
	}
	epRuntime, err := s.episodeRuntimes(ctx, epIDs)
	if err != nil {
		return nil, err
	}
	for _, p := range picked {
		m, ok := sumByID[p.ID]
		if !ok {
			continue
		}
		it := ChannelItem{Media: m, Source: "foryou"}
		if p.Series {
			e := eps[p.ID]
			ep := e.ep
			it.Episode, it.ResumeSeconds, it.Source = &ep, e.resume, "continue"
			it.RuntimeMinutes = epRuntime[ep.ID]
			if it.RuntimeMinutes <= 0 {
				it.RuntimeMinutes = channelEpisodeMinutes
			} else {
				it.RuntimeKnown = true
			}
		} else {
			ro := rc.reason(byID[p.ID].Reason)
			it.Reason = &ro
			if rt := facts[p.ID].Runtime; rt > 0 {
				it.RuntimeMinutes, it.RuntimeKnown = rt, true
			} else {
				it.RuntimeMinutes = channelMovieMinutes
			}
		}
		out.Items = append(out.Items, it)
	}
	return out, nil
}

// knownUnplayable: films whose recent torrent search found nothing and with
// no online variant on record (a cheap check of what's already cached; no
// search is run for the channel).
func (s *Service) knownUnplayable(ctx context.Context, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT c.media_id FROM release_search_cache c
		WHERE c.media_id = ANY($1::uuid[]) AND c.season IS NULL AND c.fetched_at > $2
		GROUP BY c.media_id
		HAVING bool_and(COALESCE(jsonb_array_length(c.body->'candidates'), 0) = 0)
		   AND NOT EXISTS (SELECT 1 FROM online_search_cache o
		                   WHERE o.media_id = c.media_id AND o.status = 'ok' AND jsonb_array_length(o.variants) > 0)`,
		ids, s.now().Add(-channelEmptySearch))
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

// episodeRuntimes: minutes per episode id (the episode's own runtime, else
// the series' typical one; missing = unknown).
func (s *Service) episodeRuntimes(ctx context.Context, episodeIDs []string) (map[string]int, error) {
	out := map[string]int{}
	if len(episodeIDs) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT e.id, COALESCE(NULLIF(e.runtime, 0), NULLIF(m.runtime, 0), 0)
		FROM episodes e JOIN media m ON m.id = e.media_id
		WHERE e.id = ANY($1::uuid[])`, episodeIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}
