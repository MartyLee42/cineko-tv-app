package anilibria

import (
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// Matching a Cineko title (TMDB) to AniLiberty releases.
//
// AniLiberty publishes every season (cour) as its own release named
// "Title", "Title 2", "Title 3" (English "… Season 2" or a subtitle), and
// movies as type MOVIE. A candidate is accepted only when a normalized name
// (ru main / english / alternative) equals one of the target's titles (or is
// very close), the type fits (movie vs TV), the year is within ±1 (season 1
// / movie) and, for series, the parsed season number equals the requested
// season. If two different releases score the same, nothing is returned.

const (
	minNameSim   = 0.88 // fuzzy floor for a name to count at all
	minAccept    = 0.80 // final score floor
	ambiguityGap = 0.05 // best must beat the runner-up by this much
	maxSeasonNum = 30   // a trailing number above this is part of the title
)

// target is the normalized lookup.
type target struct {
	Movie   bool
	Titles  []string // normalized, deduplicated
	Bases   []string // titles with a trailing season marker removed
	Year    int
	Season  int // series: requested season (≥1)
	Animish bool
}

// candidate is an AniLiberty release reduced to what matching needs.
type candidate struct {
	ID       int
	Type     string
	Year     int
	Names    []string // normalized full names
	Bases    []string // names without a season marker
	Season   int      // parsed season (1 when no marker)
	Episodes int
}

type scored struct {
	c     candidate
	score float64
}

var (
	nonWord = regexp.MustCompile(`[^\p{L}\p{N}]+`)
	// Season markers, applied to normalized (lower-case, single-spaced) names.
	seasonRes = []*regexp.Regexp{
		// (RE2's \b is ASCII-only, so word starts are spelled as a space.)
		regexp.MustCompile(`^(.*?) тв (\d{1,2})$`),                       // "[ТВ-2]"
		regexp.MustCompile(`^(.*?) (\d{1,2}) (?:сезон|season)(?: .*)?$`), // "2 сезон", "2nd season" (ordinal stripped first)
		regexp.MustCompile(`^(.*?) (?:сезон|season) (\d{1,2})(?: .*)?$`), // "season 2 …"
		regexp.MustCompile(`^(.*?) (?:part|часть) (\d{1,2})$`),
		regexp.MustCompile(`^(.*\S)\s+(\d{1,2})$`), // "Title 2"
	}
	ordinalSuffix = regexp.MustCompile(`(^|\s)(\d{1,2})(?:st|nd|rd|th|й|ий|ой)(\s|$)`)
	digitRun      = regexp.MustCompile(`\d+`)
	romanTail     = regexp.MustCompile(`^(.*\S)\s+(ii|iii|iv|v|vi)$`)
	// Tokens that decorate a name without changing it.
	noiseTail = regexp.MustCompile(`\s+(?:фильм|the movie|movie|tv|тв|ova|ona)$`)
)

var romanNums = map[string]int{"ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6}

// norm lower-cases, folds ё→е, drops punctuation and collapses spaces.
func norm(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, "ё", "е")
	s = nonWord.ReplaceAllString(s, " ")
	s = strings.Join(strings.Fields(s), " ")
	for {
		t := noiseTail.ReplaceAllString(s, "")
		if t == s || t == "" {
			break
		}
		s = t
	}
	return s
}

// splitSeason returns the base name and a season number (1 when there is
// no marker).
func splitSeason(n string) (string, int) {
	n = ordinalSuffix.ReplaceAllString(n, "$1$2$3")
	for _, re := range seasonRes {
		if m := re.FindStringSubmatch(n); m != nil && strings.TrimSpace(m[1]) != "" {
			if k, err := strconv.Atoi(m[2]); err == nil && k >= 1 && k <= maxSeasonNum {
				return strings.TrimSpace(m[1]), k
			}
		}
	}
	if m := romanTail.FindStringSubmatch(n); m != nil {
		return m[1], romanNums[m[2]]
	}
	return n, 1
}

func uniq(xs []string) []string {
	out := xs[:0:0]
	seen := map[string]bool{}
	for _, x := range xs {
		if x != "" && !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func hasLetters(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

func newTarget(movie bool, titles []string, year, season int) target {
	t := target{Movie: movie, Year: year, Season: season}
	if !movie && t.Season < 1 {
		t.Season = 1
	}
	for _, s := range titles {
		if n := norm(s); hasLetters(n) {
			t.Titles = append(t.Titles, n)
			b, _ := splitSeason(n)
			t.Bases = append(t.Bases, b)
		}
	}
	t.Titles, t.Bases = uniq(t.Titles), uniq(t.Bases)
	return t
}

func newCandidate(r *apiRelease) candidate {
	c := candidate{ID: r.ID, Type: r.typ(), Year: r.Year, Season: 1}
	if r.EpisodesTotal != nil {
		c.Episodes = *r.EpisodesTotal
	}
	names := []string{r.Name.Main, r.Name.English}
	// "alternative" is free text: sometimes a name, sometimes a keyword list
	// ("Магическая, Битва, 0"); only use it when it is not a comma list.
	if a := r.Name.Alternative; a != "" && strings.Count(a, ",") < 2 {
		names = append(names, a)
	}
	for i, s := range names {
		n := norm(s)
		if !hasLetters(n) {
			continue
		}
		c.Names = append(c.Names, n)
		b, k := splitSeason(n)
		c.Bases = append(c.Bases, b)
		// The Russian main name is authoritative for the season (the English
		// one is often a subtitle: "Shimetsu Kaiyuu - Zenpen"); the English
		// name only fills in when the main one has no marker.
		switch {
		case i == 0:
			c.Season = k
		case i == 1 && c.Season == 1 && k > 1:
			c.Season = k
		}
	}
	c.Names, c.Bases = uniq(c.Names), uniq(c.Bases)
	return c
}

// sim is 1 for equal strings, otherwise a Levenshtein ratio (0 below the
// fuzzy floor or for short names, where one letter changes the title).
func sim(a, b string) float64 {
	if a == b {
		return 1
	}
	// Same words in another order ("Фрирен, провожающая в последний путь"
	// vs AniLiberty's "Провожающая в последний путь Фрирен").
	if sameWords(a, b) {
		return 0.97
	}
	ra, rb := []rune(a), []rune(b)
	if len(ra) < 8 || len(rb) < 8 {
		return 0
	}
	// Numbers are identity ("Title" vs "Title 0", "Title 2"): never fuzzy.
	if strings.Join(digitRun.FindAllString(a, -1), " ") != strings.Join(digitRun.FindAllString(b, -1), " ") {
		return 0
	}
	d := levenshtein(ra, rb)
	m := max(len(ra), len(rb))
	r := 1 - float64(d)/float64(m)
	if r < minNameSim {
		return 0
	}
	return r
}

func sameWords(a, b string) bool {
	fa, fb := strings.Fields(a), strings.Fields(b)
	if len(fa) < 2 || len(fa) != len(fb) {
		return false
	}
	slices.Sort(fa)
	slices.Sort(fb)
	return slices.Equal(fa, fb)
}

func levenshtein(a, b []rune) int {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

func bestSim(as, bs []string) float64 {
	best := 0.0
	for _, a := range as {
		for _, b := range bs {
			if s := sim(a, b); s > best {
				best = s
			}
		}
	}
	return best
}

// typeScore: movie targets want MOVIE; series want TV/ONA/WEB. OVA/SPECIAL
// fit either with a penalty (TMDB files them inconsistently).
func typeScore(movie bool, typ string) float64 {
	switch typ {
	case "MOVIE":
		if movie {
			return 1
		}
		return 0
	case "TV", "ONA", "WEB":
		if movie {
			return 0
		}
		return 1
	case "OVA", "SPECIAL", "OAD":
		return 0.85
	case "":
		return 0.9
	}
	return 0
}

// score rates a candidate (0 = rejected).
func (t *target) score(c candidate) float64 {
	ts := typeScore(t.Movie, c.Type)
	if ts == 0 {
		return 0
	}
	var name, ys float64
	if t.Movie {
		name = bestSim(t.Titles, c.Names)
		ys = yearScore(t.Year, c.Year, 1)
	} else {
		if c.Season != t.Season {
			return 0
		}
		// Season 1 may be named exactly like the show; later seasons are
		// compared by base name.
		name = bestSim(t.Bases, c.Bases)
		if t.Season == 1 {
			name = max(name, bestSim(t.Titles, c.Names))
			ys = yearScore(t.Year, c.Year, 1)
		} else {
			// The show's first-air year: later seasons air afterwards.
			switch {
			case t.Year == 0 || c.Year == 0:
				ys = 0.85
			case c.Year >= t.Year:
				ys = 1
			}
		}
	}
	if name == 0 || ys == 0 {
		return 0
	}
	s := name * ts * ys
	if s < minAccept {
		return 0
	}
	return s
}

func yearScore(want, got, tol int) float64 {
	if want == 0 || got == 0 {
		return 0.85
	}
	d := want - got
	if d < 0 {
		d = -d
	}
	switch {
	case d == 0:
		return 1
	case d <= tol:
		return 0.92
	}
	return 0
}

// pick returns the single best candidate, or false when nothing fits or
// the top two (different releases) are too close to tell apart.
func (t *target) pick(cands []candidate) (candidate, bool) {
	var ss []scored
	seen := map[int]bool{}
	for _, c := range cands {
		if seen[c.ID] {
			continue
		}
		seen[c.ID] = true
		if s := t.score(c); s > 0 {
			ss = append(ss, scored{c, s})
		}
	}
	if len(ss) == 0 {
		return candidate{}, false
	}
	sort.SliceStable(ss, func(i, j int) bool { return ss[i].score > ss[j].score })
	if len(ss) > 1 && ss[0].score-ss[1].score < ambiguityGap {
		return candidate{}, false
	}
	return ss[0].c, true
}

// chain lists the TV releases of the same show (same base name as the
// matched one), ordered by season, for absolute episode numbering.
func chain(matched candidate, cands []candidate) []candidate {
	out := []candidate{}
	bySeason := map[int]candidate{}
	for _, c := range cands {
		if typeScore(false, c.Type) != 1 || bestSim(matched.Bases, c.Bases) < 1 {
			continue
		}
		if prev, ok := bySeason[c.Season]; ok && prev.ID != c.ID {
			// Two releases claim one season: the chain is unreliable past it.
			bySeason[c.Season] = candidate{ID: -1, Season: c.Season}
			continue
		}
		bySeason[c.Season] = c
	}
	for k := matched.Season; ; k++ {
		c, ok := bySeason[k]
		if !ok || c.ID < 0 {
			break
		}
		out = append(out, c)
	}
	return out
}
