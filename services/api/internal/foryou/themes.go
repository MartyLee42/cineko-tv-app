package foryou

import (
	"context"
	"math"
	"slices"
	"strings"
	"sync"
	"time"
)

// Taste by themes: TMDB keywords ("heist", "time loop", "slow burn") and
// the crew beyond directors (writers, cinematographers, composers) are
// affinity dimensions like genres. Keywords are noisy, so a small stoplist
// drops production trivia and an IDF-like factor damps keywords that are on
// a large share of all stored titles.

// Person roles in Taste.people.
const (
	roleDirector        = "director"
	roleActor           = "actor"
	roleWriter          = "writer"
	roleCinematographer = "cinematographer"
	roleComposer        = "composer"
)

// keywordStoplist: TMDB keywords that describe production or source
// material rather than what a film is about (lowercase names).
var keywordStoplist = []string{
	"duringcreditsstinger", "aftercreditsstinger", "post-credits scene", "mid-credits scene",
	"woman director", "based on novel or book", "based on comic", "based on manga", "based on short story",
	"based on play or musical", "based on young adult novel", "based on tv series", "based on video game",
	"sequel", "prequel", "remake", "reboot", "spin off", "live action remake", "anime", "3d", "imax",
	"short film", "tv movie", "miniseries", "duringcreditstinger", "softcore", "erotic movie",
}

// keywordIDF is the damping factor (KeywordIDFFloor..1) of every keyword
// from its document frequency df over n stored titles with keywords. Below
// KeywordIDFMinCorpus titles there is no reliable statistic: nil.
func keywordIDF(df map[int]int, n int, w Weights) map[int]float64 {
	if n < w.KeywordIDFMinCorpus || n <= 0 {
		return nil
	}
	lo, hi := math.Log(w.KeywordCommonShare), math.Log(w.KeywordStopShare)
	out := make(map[int]float64, len(df))
	for k, c := range df {
		share := float64(c) / float64(n)
		if share <= w.KeywordCommonShare {
			continue // full weight (absent = 1)
		}
		x := (math.Log(share) - lo) / (hi - lo)
		x = math.Max(0, math.Min(1, x))
		out[k] = round3(1 - (1-w.KeywordIDFFloor)*x)
	}
	return out
}

// idfCache keeps the keyword document frequencies for a few hours (one
// GROUP BY over media_keywords).
type idfCache struct {
	mu  sync.Mutex
	at  time.Time
	idf map[int]float64
}

const idfTTL = 6 * time.Hour

func (s *Service) keywordIDF(ctx context.Context) map[int]float64 {
	s.idf.mu.Lock()
	defer s.idf.mu.Unlock()
	if !s.idf.at.IsZero() && s.now().Sub(s.idf.at) < idfTTL {
		return s.idf.idf
	}
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*)::int FROM media WHERE keywords_fetched_at IS NOT NULL`).Scan(&n); err != nil {
		return s.idf.idf
	}
	df := map[int]int{}
	if n >= s.w.KeywordIDFMinCorpus {
		rows, err := s.pool.Query(ctx, `SELECT keyword_id, count(*)::int FROM media_keywords GROUP BY keyword_id`)
		if err != nil {
			return s.idf.idf
		}
		for rows.Next() {
			var k, c int
			if rows.Scan(&k, &c) == nil {
				df[k] = c
			}
		}
		rows.Close()
	}
	s.idf.idf, s.idf.at = keywordIDF(df, n, s.w), s.now()
	return s.idf.idf
}

// keywordMatch: 0.7 × the best + 0.3 × the worst affinity among the
// candidate's keywords the taste knows (0 when none: most keywords are
// unknown and must not dilute the match).
func keywordMatch(c *Candidate, t *Taste) float64 {
	if t.keyword == nil {
		t.index()
	}
	best, worst, n := math.Inf(-1), math.Inf(1), 0
	for _, k := range c.Keywords {
		v, ok := t.keyword[k]
		if !ok {
			continue
		}
		n++
		best, worst = math.Max(best, v), math.Min(worst, v)
	}
	if n == 0 {
		return 0
	}
	return 0.7*best + 0.3*worst
}

// bestKeyword is the candidate's most liked keyword (0 when none ≥ min).
func bestKeyword(c *Candidate, t *Taste, min float64) (int, float64) {
	if t.keyword == nil {
		t.index()
	}
	id, best := 0, min
	for _, k := range c.Keywords {
		if v := t.keyword[k]; v >= best && (v > best || id == 0 || k < id) {
			id, best = k, v
		}
	}
	return id, best
}

// peopleMatch: the strongest liked person on the title plus half the most
// disliked one, each affinity × its role factor.
func peopleMatch(c *Candidate, t *Taste, w Weights) float64 {
	if t.people == nil {
		t.index()
	}
	best, worst := 0.0, 0.0
	scan := func(role string, ids []int, factor float64) {
		m := t.people[role]
		for _, p := range ids {
			v := m[p] * factor
			best, worst = math.Max(best, v), math.Min(worst, v)
		}
	}
	scan(roleDirector, c.Directors, w.PeopleDirector)
	scan(roleWriter, c.Writers, w.PeopleWriter)
	scan(roleCinematographer, c.Cinematographers, w.PeopleCrew)
	scan(roleComposer, c.Composers, w.PeopleCrew)
	scan(roleActor, c.Actors, w.PeopleActor)
	return best + 0.5*worst
}

func uniqInts(in []int) []int {
	if len(in) < 2 {
		return in
	}
	out := slices.Clone(in)
	slices.Sort(out)
	return slices.Compact(out)
}

// ---- names ----

// keywordName is a keyword's display name: name_ru for Russian when the AI
// translated it, else TMDB's English name.
type keywordName struct{ EN, RU string }

func (k keywordName) in(lang string) string {
	if lang == "ru" && k.RU != "" {
		return k.RU
	}
	return k.EN
}

func (s *Service) keywordNames(ctx context.Context, ids []int) (map[int]keywordName, error) {
	out := map[int]keywordName{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT id, name, COALESCE(name_ru, '') FROM keywords WHERE id = ANY($1::int[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int
		var k keywordName
		if err := rows.Scan(&id, &k.EN, &k.RU); err != nil {
			return nil, err
		}
		out[id] = k
	}
	return out, rows.Err()
}

// stopKeyword reports whether a keyword name is on the stoplist.
func stopKeyword(name string) bool {
	return slices.Contains(keywordStoplist, strings.ToLower(strings.TrimSpace(name)))
}
