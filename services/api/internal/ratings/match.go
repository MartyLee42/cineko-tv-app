package ratings

import (
	"strings"
	"unicode"
)

// Target is what we know about a Cineko title when looking it up.
type Target struct {
	Kind   string // movie | series
	TMDBID int
	IMDbID string
	Year   int // 0 = unknown
	// Titles: original, then localized (en, ru); duplicates allowed.
	Titles []string
}

// Pick chooses the Kinopoisk id for t among candidates, or returns false.
//
// Rules, strongest first:
//  1. a candidate with the same IMDb id (and a compatible kind) wins;
//  2. a candidate with the same TMDB id AND an explicit matching kind (TMDB
//     movie and tv ids collide, so the kind must be known);
//  3. title match: same kind (or unknown), a normalized name equal to one of
//     t's titles, year within ±1 (an exact year beats ±1); a candidate whose
//     IMDb id contradicts t's is rejected. Several different ids at the best
//     score are ambiguous → no match (a wrong rating is worse than none).
func Pick(t Target, cands []Candidate) (int, bool) {
	series := t.Kind == "series"
	kindOK := func(c Candidate) bool { return c.Series == nil || *c.Series == series }

	if t.IMDbID != "" {
		for _, c := range cands {
			if strings.EqualFold(c.IMDbID, t.IMDbID) && kindOK(c) {
				return c.KPID, true
			}
		}
	}
	if t.TMDBID > 0 {
		for _, c := range cands {
			if c.TMDBID == t.TMDBID && c.Series != nil && *c.Series == series {
				return c.KPID, true
			}
		}
	}

	titles := map[string]bool{}
	for _, s := range t.Titles {
		if n := normalize(s); n != "" {
			titles[n] = true
		}
	}
	best, bestScore, ambiguous := 0, 0, false
	for _, c := range cands {
		if !kindOK(c) || (t.IMDbID != "" && c.IMDbID != "" && !strings.EqualFold(c.IMDbID, t.IMDbID)) {
			continue
		}
		named := false
		for _, n := range c.Names {
			if titles[normalize(n)] {
				named = true
				break
			}
		}
		if !named {
			continue
		}
		score := 0
		switch d := abs(c.Year - t.Year); {
		case t.Year == 0 || c.Year == 0:
			score = 1 // unknown year: weakest match
		case d == 0:
			score = 3
		case d == 1:
			score = 2
		default:
			continue
		}
		switch {
		case score > bestScore:
			best, bestScore, ambiguous = c.KPID, score, false
		case score == bestScore && c.KPID != best:
			ambiguous = true
		}
	}
	if bestScore == 0 || ambiguous {
		return 0, false
	}
	return best, true
}

// normalize folds case, ё→е and & → and, and keeps only letters and digits
// ("Spider-Man: No Way Home" == "spider man no way home").
func normalize(s string) string {
	s = strings.ToLower(s)
	s = strings.NewReplacer("ё", "е", "&", " and ").Replace(s)
	var b strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
