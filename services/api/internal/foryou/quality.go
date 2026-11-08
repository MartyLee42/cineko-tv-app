package foryou

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/httpx"
)

// Quality metrics (admin «Рекомендации» → «Качество»): how the titles For
// You showed were watched and rated, per profile and for the household.
// Read-only, computed on request from foryou_feedback (impressions with
// their attribution), playback_sessions, watch_progress and ratings; cached
// for qualityTTL. A title counts once per profile, from its first impression
// in the window; a play / completion / rating counts only after it.

const (
	qualityTTL = 5 * time.Minute
	// Liked / disliked rating thresholds (1–10).
	likedFrom, dislikedTo = 7, 4
	// qualityList: titles in «лучшие попадания» / «промахи».
	qualityList = 5
	// precisionK: «Подобрано для вас» tiles counted for precision@K.
	precisionK = 10
)

// qualityWindows: window → days (0 = everything kept, feedback lives 180 days).
var qualityWindows = map[string]int{"30": 30, "90": 90, "all": 0}

// qualityObs is one shown title of one profile.
type qualityObs struct {
	MediaID string
	Shares  map[string]float64
	Score   *float64 // predicted score at the first impression (nil: unknown)
	Top10   bool     // shown among the first precisionK tiles of «Подобрано для вас»
	Played  bool     // a playback of ≥ LearnPlaySeconds after it was shown
	Done    bool     // finished after it was shown
	Rating  int      // rated after it was shown (0 = not rated)
}

// Funnel is shown → played → finished → rated → liked (contract ForYouQualityFunnel).
type Funnel struct {
	Shown    int `json:"shown"`
	Played   int `json:"played"`
	Finished int `json:"finished"`
	Rated    int `json:"rated"`
	Liked    int `json:"liked"`
	Disliked int `json:"disliked"`
}

// RatingSummary: n ratings, their mean and liked / disliked shares.
type RatingSummary struct {
	N        int      `json:"n"`
	Avg      *float64 `json:"avg"`
	Liked    *float64 `json:"liked"`
	Disliked *float64 `json:"disliked"`
}

// CalibrationBucket: titles by predicted score (tertiles of the shown ones).
type CalibrationBucket struct {
	ScoreMin float64 `json:"score_min"`
	ScoreMax float64 `json:"score_max"`
	Shown    int     `json:"shown"`
	Played   int     `json:"played"`
	RatingSummary
}

// SourceQuality: share-weighted plays and ratings per learn key.
type SourceQuality struct {
	Source string   `json:"source"`
	Shown  float64  `json:"shown"`
	Plays  float64  `json:"plays"`
	Rated  float64  `json:"rated"`
	Avg    *float64 `json:"avg"`
	Liked  *float64 `json:"liked"`
}

// QualityTitle is one hit or miss.
type QualityTitle struct {
	MediaID    string  `json:"media_id"`
	Title      string  `json:"title"`
	Year       *int    `json:"year"`
	PosterPath *string `json:"poster_path"`
	Rating     int     `json:"rating"`
}

// QualityStats is one profile's (or the household's) metrics.
type QualityStats struct {
	Funnel Funnel `json:"funnel"`
	// Recommended: ratings of shown-then-rated titles; Elsewhere: the
	// profile's other ratings in the window (baseline).
	Recommended RatingSummary       `json:"recommended"`
	Elsewhere   RatingSummary       `json:"elsewhere"`
	Calibration []CalibrationBucket `json:"calibration"`
	Sources     []SourceQuality     `json:"sources"`
	// Precision@K: of the titles shown in the first K tiles of «Подобрано
	// для вас», how many were rated liked.
	PrecisionShown int            `json:"precision_shown"`
	PrecisionLiked int            `json:"precision_liked"`
	Hits           []QualityTitle `json:"hits"`
	Misses         []QualityTitle `json:"misses"`
}

func summarize(ratings []int) RatingSummary {
	out := RatingSummary{N: len(ratings)}
	if len(ratings) == 0 {
		return out
	}
	sum, liked, disliked := 0, 0, 0
	for _, r := range ratings {
		sum += r
		if r >= likedFrom {
			liked++
		}
		if r <= dislikedTo {
			disliked++
		}
	}
	n := float64(len(ratings))
	avg, l, d := round2(float64(sum)/n), round2(float64(liked)/n), round2(float64(disliked)/n)
	out.Avg, out.Liked, out.Disliked = &avg, &l, &d
	return out
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// computeQuality turns observations (one per shown title) and the baseline
// ratings into metrics. Pure; hits and misses carry media ids only.
func computeQuality(obs []qualityObs, elsewhere []int) QualityStats {
	st := QualityStats{Elsewhere: summarize(elsewhere), Calibration: []CalibrationBucket{}, Sources: []SourceQuality{},
		Hits: []QualityTitle{}, Misses: []QualityTitle{}}
	var rated []int
	type srcAcc struct{ shown, plays, rated, sum, liked float64 }
	src := map[string]*srcAcc{}
	var scored []qualityObs
	for _, o := range obs {
		st.Funnel.Shown++
		played := o.Played || o.Done
		if played {
			st.Funnel.Played++
		}
		if o.Done {
			st.Funnel.Finished++
		}
		if o.Rating > 0 {
			st.Funnel.Rated++
			rated = append(rated, o.Rating)
			if o.Rating >= likedFrom {
				st.Funnel.Liked++
			}
			if o.Rating <= dislikedTo {
				st.Funnel.Disliked++
			}
		}
		if o.Top10 {
			st.PrecisionShown++
			if o.Rating >= likedFrom {
				st.PrecisionLiked++
			}
		}
		for k, sh := range o.Shares {
			a := src[k]
			if a == nil {
				a = &srcAcc{}
				src[k] = a
			}
			a.shown += sh
			if played {
				a.plays += sh
			}
			if o.Rating > 0 {
				a.rated += sh
				a.sum += sh * float64(o.Rating)
				if o.Rating >= likedFrom {
					a.liked += sh
				}
			}
		}
		if o.Score != nil {
			scored = append(scored, o)
		}
	}
	st.Recommended = summarize(rated)

	// Calibration: three buckets by predicted score (tertiles), low → high.
	if len(scored) >= 3 {
		slices.SortStableFunc(scored, func(a, b qualityObs) int {
			switch {
			case *a.Score < *b.Score:
				return -1
			case *a.Score > *b.Score:
				return 1
			}
			return cmpStr(a.MediaID, b.MediaID)
		})
		for b := 0; b < 3; b++ {
			part := scored[b*len(scored)/3 : (b+1)*len(scored)/3]
			cb := CalibrationBucket{ScoreMin: round2(*part[0].Score), ScoreMax: round2(*part[len(part)-1].Score), Shown: len(part)}
			var rs []int
			for _, o := range part {
				if o.Played || o.Done {
					cb.Played++
				}
				if o.Rating > 0 {
					rs = append(rs, o.Rating)
				}
			}
			cb.RatingSummary = summarize(rs)
			st.Calibration = append(st.Calibration, cb)
		}
	}

	order := map[string]int{}
	for i, k := range LearnSources {
		order[k] = i
	}
	for k, a := range src {
		sq := SourceQuality{Source: k, Shown: round2(a.shown), Plays: round2(a.plays), Rated: round2(a.rated)}
		if a.rated > 0 {
			avg, l := round2(a.sum/a.rated), round2(a.liked/a.rated)
			sq.Avg, sq.Liked = &avg, &l
		}
		st.Sources = append(st.Sources, sq)
	}
	slices.SortFunc(st.Sources, func(a, b SourceQuality) int { return order[a.Source] - order[b.Source] })

	// Hits: the best rated (≥ likedFrom); misses: the worst (≤ dislikedTo).
	var rs []qualityObs
	for _, o := range obs {
		if o.Rating > 0 {
			rs = append(rs, o)
		}
	}
	slices.SortStableFunc(rs, func(a, b qualityObs) int {
		if a.Rating != b.Rating {
			return b.Rating - a.Rating
		}
		return cmpStr(a.MediaID, b.MediaID)
	})
	for _, o := range rs {
		if o.Rating >= likedFrom && len(st.Hits) < qualityList {
			st.Hits = append(st.Hits, QualityTitle{MediaID: o.MediaID, Rating: o.Rating})
		}
	}
	for i := len(rs) - 1; i >= 0; i-- {
		if o := rs[i]; o.Rating <= dislikedTo && len(st.Misses) < qualityList {
			st.Misses = append(st.Misses, QualityTitle{MediaID: o.MediaID, Rating: o.Rating})
		}
	}
	return st
}

// ProfileQuality is one profile in GET /admin/foryou/quality.
type ProfileQuality struct {
	ProfileID string       `json:"profile_id"`
	Name      string       `json:"name"`
	Owner     string       `json:"owner"`
	Stats     QualityStats `json:"stats"`
}

// QualityReport is GET /admin/foryou/quality (contract ForYouQuality).
type QualityReport struct {
	Window      string           `json:"window"`
	GeneratedAt time.Time        `json:"generated_at"`
	Household   QualityStats     `json:"household"`
	Profiles    []ProfileQuality `json:"profiles"`
}

type qualityCache struct {
	mu sync.Mutex
	m  map[string]qualityEntry // window|lang → report
}

type qualityEntry struct {
	at  time.Time
	rep *QualityReport
}

// Quality computes (or serves the cached) report for a window.
func (s *Service) Quality(ctx context.Context, window, lang string) (*QualityReport, error) {
	key := window + "|" + lang
	s.quality.mu.Lock()
	if e, ok := s.quality.m[key]; ok && s.now().Sub(e.at) < qualityTTL {
		s.quality.mu.Unlock()
		return e.rep, nil
	}
	s.quality.mu.Unlock()
	rep, err := s.computeQualityReport(ctx, window, lang)
	if err != nil {
		return nil, err
	}
	s.quality.mu.Lock()
	if s.quality.m == nil {
		s.quality.m = map[string]qualityEntry{}
	}
	s.quality.m[key] = qualityEntry{at: s.now(), rep: rep}
	s.quality.mu.Unlock()
	return rep, nil
}

func (s *Service) computeQualityReport(ctx context.Context, window, lang string) (*QualityReport, error) {
	since := time.Time{}
	if d := qualityWindows[window]; d > 0 {
		since = s.now().Add(-time.Duration(d) * 24 * time.Hour)
	}
	rows, err := s.pool.Query(ctx, `
		WITH imp AS (
			SELECT f.profile_id, f.media_id, min(f.created_at) AS at,
			       (array_agg(f.sources ORDER BY f.created_at) FILTER (WHERE f.sources IS NOT NULL))[1] AS sources,
			       (array_agg(f.score ORDER BY f.created_at) FILTER (WHERE f.score IS NOT NULL))[1] AS score,
			       COALESCE(bool_or(f.row_id = 'top_picks' AND f.item_pos < $3), false) AS top
			FROM foryou_feedback f
			WHERE f.action = 'impression' AND f.created_at > $1
			GROUP BY f.profile_id, f.media_id)
		SELECT i.profile_id, i.media_id, i.sources, i.score, i.top,
		       EXISTS (SELECT 1 FROM playback_sessions ps WHERE ps.profile_id = i.profile_id AND ps.media_id = i.media_id
		               AND ps.started_at >= i.at AND ps.last_position >= $2),
		       EXISTS (SELECT 1 FROM watch_progress wp WHERE wp.profile_id = i.profile_id AND wp.media_id = i.media_id
		               AND wp.completed AND wp.completed_at >= i.at),
		       COALESCE(r.rating, 0)
		FROM imp i
		LEFT JOIN ratings r ON r.profile_id = i.profile_id AND r.media_id = i.media_id AND r.updated_at >= i.at
		ORDER BY i.profile_id, i.media_id`, since, s.w.LearnPlaySeconds, precisionK)
	if err != nil {
		return nil, err
	}
	byProfile := map[string][]qualityObs{}
	var all []qualityObs
	for rows.Next() {
		var pid string
		var o qualityObs
		var raw []byte
		var score *float32
		var rating int16
		if err := rows.Scan(&pid, &o.MediaID, &raw, &score, &o.Top10, &o.Played, &o.Done, &rating); err != nil {
			rows.Close()
			return nil, err
		}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &o.Shares)
		}
		if score != nil {
			v := float64(*score)
			o.Score = &v
		}
		o.Rating = int(rating)
		byProfile[pid] = append(byProfile[pid], o)
		all = append(all, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Baseline: ratings in the window of titles not shown before they were rated.
	base := map[string][]int{}
	var baseAll []int
	brows, err := s.pool.Query(ctx, `
		SELECT r.profile_id, r.rating FROM ratings r
		WHERE r.updated_at > $1 AND NOT EXISTS (SELECT 1 FROM foryou_feedback f WHERE f.profile_id = r.profile_id
		      AND f.media_id = r.media_id AND f.action = 'impression' AND f.created_at <= r.updated_at)`, since)
	if err != nil {
		return nil, err
	}
	for brows.Next() {
		var pid string
		var r int16
		if err := brows.Scan(&pid, &r); err != nil {
			brows.Close()
			return nil, err
		}
		base[pid] = append(base[pid], int(r))
		baseAll = append(baseAll, int(r))
	}
	brows.Close()
	if err := brows.Err(); err != nil {
		return nil, err
	}

	rep := &QualityReport{Window: window, GeneratedAt: s.now(), Household: computeQuality(all, baseAll), Profiles: []ProfileQuality{}}
	prows, err := s.pool.Query(ctx, `
		SELECT p.id, p.name, COALESCE(NULLIF(u.display_name, ''), u.username) FROM profiles p JOIN users u ON u.id = p.user_id
		WHERE p.id = ANY($1) ORDER BY u.username, p.created_at, p.id`, mapKeys(byProfile))
	if err != nil {
		return nil, err
	}
	for prows.Next() {
		var pq ProfileQuality
		if err := prows.Scan(&pq.ProfileID, &pq.Name, &pq.Owner); err != nil {
			prows.Close()
			return nil, err
		}
		pq.Stats = computeQuality(byProfile[pq.ProfileID], base[pq.ProfileID])
		rep.Profiles = append(rep.Profiles, pq)
	}
	prows.Close()
	if err := prows.Err(); err != nil {
		return nil, err
	}
	s.fillQualityTitles(ctx, rep, lang)
	return rep, nil
}

func mapKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// fillQualityTitles resolves hit/miss titles and posters; unresolved ones
// are dropped.
func (s *Service) fillQualityTitles(ctx context.Context, rep *QualityReport, lang string) {
	lists := []*[]QualityTitle{&rep.Household.Hits, &rep.Household.Misses}
	for i := range rep.Profiles {
		lists = append(lists, &rep.Profiles[i].Stats.Hits, &rep.Profiles[i].Stats.Misses)
	}
	var ids []string
	for _, l := range lists {
		for _, t := range *l {
			ids = append(ids, t.MediaID)
		}
	}
	if len(ids) == 0 {
		return
	}
	sums, err := s.cat.SummariesByID(ctx, slicesUniq(ids), lang)
	if err != nil {
		s.log.WarnContext(ctx, "foryou: quality titles not resolved", "err", err)
		sums = nil
	}
	for _, l := range lists {
		out := (*l)[:0]
		for _, t := range *l {
			if m, ok := sums[t.MediaID]; ok {
				t.Title, t.Year, t.PosterPath = m.Title, m.Year, m.PosterPath
				out = append(out, t)
			}
		}
		*l = out
	}
}

// hQuality is GET /admin/foryou/quality?window=30|90|all&lang=.
func (s *Service) hQuality(c fiber.Ctx) error {
	window := c.Query("window", "90")
	if _, ok := qualityWindows[window]; !ok {
		return httpx.Validation(map[string]string{"window": "must be one of 30, 90, all"})
	}
	lang, err := langOf(c)
	if err != nil {
		return err
	}
	rep, err := s.Quality(c.Context(), window, lang)
	if err != nil {
		return err
	}
	return c.JSON(rep)
}
