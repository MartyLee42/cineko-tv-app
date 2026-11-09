package releases

import (
	"fmt"
	"slices"
	"strings"
	"time"
)

// MinConfidence is the acceptance threshold: results below it (and every
// hard reject) are dropped. A correct release with an exact title and a
// matching year scores 0.9-1.0; an exact title without a year 0.8; a
// collection that includes the title ~0.6-0.7.
const MinConfidence = 0.5

// minTitleSim is the title similarity below which a result is rejected
// outright, whatever else matches ("Game of Thrones: The Last Watch" is 0.6
// against "Game of Thrones").
const minTitleSim = 0.75

// Target describes the requested media.
type Target struct {
	Kind      string   // movie | series
	Titles    []string // original, ru and en titles
	AltTitles []string // TMDB alternative titles (Latin/Cyrillic only)
	// SearchNames are romanized alternative titles (also in AltTitles),
	// searched when the original title isn't Latin/Cyrillic ("Dokkaebi").
	SearchNames []string
	Year        int    // movie release year / series first air year
	LastYear    int    // series: last air year (0 = ongoing)
	IMDbID      string // tt0133093
	// OriginalLanguage replaces the parser's "orig" language placeholder.
	OriginalLanguage string
	Countries        []string // origin countries, ISO 3166-1
	Season           *int
	Episode          *int
	SeasonYear       int // air year of the requested season (0 = unknown)
	SeasonEpisodes   int // episode count of the requested season (0 = unknown)
	SeasonCount      int

	prepared bool
	titles   []targetTitle
}

type targetTitle struct {
	tokens []string
	main   []string // part before ":" / ". " ("Аватар" of "Аватар: Путь воды")
	alt    bool
	script string
}

// Match is the verdict on one release.
type Match struct {
	Confidence float64
	Reasons    []string
	Rejected   bool
	IsPack     bool
}

func (t *Target) prepare() {
	if t.prepared {
		return
	}
	t.prepared = true
	add := func(s string, alt bool) {
		tok := normTokens(s)
		if len(tok) == 0 {
			return
		}
		for _, x := range t.titles {
			if slices.Equal(x.tokens, tok) {
				return
			}
		}
		tt := targetTitle{tokens: tok, alt: alt, script: script(s)}
		if i := strings.IndexAny(s, ":."); i > 0 {
			if m := normTokens(s[:i]); len(m) > 0 && len(m) < len(tok) {
				tt.main = m
			}
		} else if i := strings.Index(s, " - "); i > 0 {
			if m := normTokens(s[:i]); len(m) > 0 && len(m) < len(tok) {
				tt.main = m
			}
		}
		t.titles = append(t.titles, tt)
	}
	for _, s := range t.Titles {
		add(s, false)
	}
	for _, s := range t.AltTitles {
		add(s, true)
	}
}

type sim struct {
	score  float64
	kind   string // exact, alt, fuzzy, main, franchise, partial, sequel, none
	script string
}

// titleSim compares one candidate with one target title.
func titleSim(cand []string, tt targetTitle, collection bool) sim {
	tgt := tt.tokens
	if len(cand) == 0 {
		return sim{kind: "none"}
	}
	if slices.Equal(cand, tgt) {
		return sim{score: 1, kind: "exact"}
	}
	if strings.Join(cand, "") == strings.Join(tgt, "") {
		return sim{score: 0.97, kind: "exact"}
	}
	extra, missing := diff(cand, tgt), diff(tgt, cand)
	switch {
	case len(missing) == 0 && len(extra) > 0:
		if len(extra) == 1 && extra[0] == "1" && !slices.Contains(tgt, "1") {
			return sim{score: 0.95, kind: "exact"} // "Брат 1", "Avatar (1)"
		}
		if slices.ContainsFunc(extra, isNumberToken) {
			return sim{score: 0.2, kind: "sequel"}
		}
		return sim{score: float64(len(tgt)) / float64(len(cand)), kind: "partial"}
	case len(extra) == 0 && len(missing) > 0:
		if slices.ContainsFunc(missing, isNumberToken) {
			return sim{score: 0.2, kind: "sequel"}
		}
		if tt.main != nil && slices.Equal(cand, tt.main) {
			return sim{score: 0.85, kind: "main"}
		}
		if collection && len(cand) < len(tgt) && slices.Equal(cand, tgt[:len(cand)]) {
			return sim{score: 0.8, kind: "franchise"}
		}
		return sim{score: float64(len(cand)) / float64(len(tgt)), kind: "partial"}
	}
	r := levRatio(strings.Join(cand, " "), strings.Join(tgt, " "))
	if r >= 0.88 {
		if !slices.Equal(numbers(cand), numbers(tgt)) {
			return sim{score: 0.2, kind: "sequel"}
		}
		return sim{score: r * 0.95, kind: "fuzzy"}
	}
	common := len(cand) - len(extra)
	return sim{score: 0.7 * 2 * float64(common) / float64(len(cand)+len(tgt)), kind: "partial"}
}

func diff(a, b []string) []string {
	left := map[string]int{}
	for _, x := range b {
		left[x]++
	}
	var out []string
	for _, x := range a {
		if left[x] > 0 {
			left[x]--
			continue
		}
		out = append(out, x)
	}
	return out
}

func numbers(toks []string) []string {
	var out []string
	for _, t := range toks {
		if isNumberToken(t) {
			out = append(out, t)
		}
	}
	return out
}

func stripCollection(toks []string) []string {
	return slices.DeleteFunc(slices.Clone(toks), func(t string) bool { return collectionWords[t] })
}

// best returns the best similarity of a candidate against all target titles.
func (t *Target) best(cand string, collection bool) (b sim) {
	tok := normTokens(cand)
	if collection {
		tok = stripCollection(tok)
	}
	b = sim{kind: "none", script: script(cand)}
	sequel := false
	defer func() {
		// "Матрица 4" is a sequel even if a fuzzy comparison with another
		// title scores a little higher.
		if sequel && b.score < minTitleSim {
			b = sim{score: 0.2, kind: "sequel"}
		}
	}()
	for _, tt := range t.titles {
		s := titleSim(tok, tt, collection)
		if s.kind == "sequel" {
			sequel = true
		}
		if tt.alt && s.score > 0.95 {
			s.score, s.kind = 0.95, "alt"
		}
		if s.score > b.score || (s.score == b.score && s.kind == "sequel") {
			s.script = b.script
			b = s
		}
	}
	return b
}

// latinOriginal: the original title is Latin-script and not a Russian or
// Ukrainian production (TMDB gives some Russian shows an English original).
func (t *Target) latinOriginal() bool {
	switch t.OriginalLanguage {
	case "ru", "uk", "be", "kk":
		return false
	}
	return len(t.Titles) > 0 && script(t.Titles[0]) == "lat"
}

func (t *Target) hasScript(sc string) bool {
	for _, tt := range t.titles {
		if tt.script == sc {
			return true
		}
	}
	return false
}

func imdbString(id int) string {
	if id <= 0 {
		return ""
	}
	return fmt.Sprintf("tt%07d", id)
}

// nonVideoCategory reports whether every standard Newznab category of a
// result is outside video (1000 console, 3000 audio, 4000 PC, 6000 XXX,
// 7000 books). Custom (100000+) ids are ignored.
func nonVideoCategory(cats []int) bool {
	seen := false
	for _, c := range cats {
		if c >= 100000 || c <= 0 {
			continue
		}
		seen = true
		switch c / 1000 {
		case 2, 5, 8:
			return false
		}
	}
	return seen
}

// Match scores a parsed release against the target. imdb is Prowlarr's
// imdbId (0 when unknown); cats are its category ids.
func (t *Target) Match(p *Parsed, imdb int, cats []int) Match {
	t.prepare()
	m := Match{}
	reasons := []string{}
	reject := func(r string) Match {
		return Match{Rejected: true, Reasons: append(reasons, r)}
	}

	if p.NonVideo || nonVideoCategory(cats) {
		return reject("not_video")
	}
	if want := t.IMDbID; want != "" && imdb > 0 {
		if imdbString(imdb) != want {
			return reject("imdb_mismatch")
		}
		reasons = append(reasons, "imdb_match")
	}

	// ---- title ----
	collection := p.Collection || (t.Kind == "movie" && p.YearRange && len(p.Seasons) == 0)
	var best sim
	var bestBy string
	scriptBest := map[string]float64{}
	for _, c := range p.Titles {
		s := t.best(c, collection)
		sc := script(c)
		scriptBest[sc] = max(scriptBest[sc], s.score)
		if s.score > best.score || best.kind == "" || (s.score == best.score && s.kind == "sequel") {
			best, bestBy = s, sc
		}
	}
	for _, part := range p.Parts {
		sc := script(part)
		scriptBest[sc] = max(scriptBest[sc], t.best(part, true).score)
	}
	// A comma list ("Матрица, Матрица: Перезагрузка, …") that names the title.
	if best.score < 0.95 {
		for _, part := range p.Parts {
			if s := t.best(part, true); s.score >= 0.95 {
				best, bestBy, collection = s, script(part), true
				reasons = append(reasons, "collection_includes_title")
				break
			}
		}
	}
	if best.kind == "sequel" {
		return reject("sequel_mismatch")
	}
	if best.score < minTitleSim {
		return reject("title_mismatch")
	}
	switch best.kind {
	case "exact":
		reasons = append(reasons, "title_exact")
	case "alt":
		reasons = append(reasons, "title_alt")
	case "fuzzy":
		reasons = append(reasons, "title_fuzzy")
	default:
		reasons = append(reasons, "title_partial")
	}
	conf := 0.6 * best.score
	// The other-script title must agree: "Настоящая война / игра престолов /
	// The Real War of Thrones" matches in Russian only.
	other := map[string]string{"cyr": "lat", "lat": "cyr"}[bestBy]
	if o, ok := scriptBest[other]; ok && t.hasScript(other) {
		switch {
		case o >= minTitleSim:
			conf += 0.05
			reasons = append(reasons, "titles_agree")
		case other == "lat" && o < 0.5 && t.latinOriginal():
			// The original (Latin) title is the canonical identity of a
			// foreign title: "Настоящая война / игра престолов / The Real
			// War of Thrones" is another show.
			return reject("other_title_mismatch")
		case other == "lat" && o < 0.5:
			conf -= 0.3
			reasons = append(reasons, "other_title_mismatch")
		case o < 0.4:
			conf -= 0.15
			reasons = append(reasons, "other_title_mismatch")
		}
	}

	// ---- version (The Office US vs UK) ----
	if p.Country != "" && len(t.Countries) > 0 {
		if !slices.ContainsFunc(t.Countries, func(c string) bool {
			return strings.EqualFold(c, p.Country) || (p.Country == "gb" && strings.EqualFold(c, "uk"))
		}) {
			return reject("version_mismatch")
		}
		reasons = append(reasons, "version_match")
	}

	// ---- year ----
	yc, yr, ok := t.yearScore(p, collection)
	if !ok {
		return reject(yr)
	}
	conf += yc
	reasons = append(reasons, yr)

	// ---- kind / season / episode ----
	if t.Kind == "movie" {
		if len(p.Seasons) > 0 || p.EpisodeTotal > 1 || len(p.Episodes) > 1 {
			return reject("kind_mismatch")
		}
	} else {
		if p.Movie && len(p.Seasons) == 0 {
			return reject("kind_mismatch") // "Атака титанов. Фильм первый"
		}
		ec, er, pack, ok := t.episodeScore(p)
		if !ok {
			return reject(er)
		}
		conf += ec
		m.IsPack = pack
		if er != "" {
			reasons = append(reasons, er)
		}
	}

	if p.Source != "" || p.Resolution != "" || p.VideoCodec != "" {
		conf += 0.05
	}
	if collection {
		conf *= 0.75
		reasons = append(reasons, "collection")
	}
	if p.Extras {
		conf *= 0.3
		reasons = append(reasons, "extras")
	}
	if slices.Contains(reasons, "imdb_match") {
		conf += 0.3
	}
	conf = min(max(conf, 0), 1)
	m.Confidence = float64(int(conf*1000+0.5)) / 1000
	m.Reasons = reasons
	if m.Confidence < MinConfidence {
		m.Rejected = true
		m.Reasons = append(m.Reasons, "low_confidence")
	}
	return m
}

func (t *Target) lastYear() int {
	if t.LastYear > 0 {
		return t.LastYear
	}
	return time.Now().Year()
}

// yearScore returns the year contribution, a reason, and false to reject.
func (t *Target) yearScore(p *Parsed, collection bool) (float64, string, bool) {
	if len(p.Years) == 0 || t.Year == 0 {
		return 0.1, "year_missing", true
	}
	lo, hi := p.Years[0], p.Years[len(p.Years)-1]
	if t.Kind == "movie" {
		switch {
		case lo == hi && lo == t.Year:
			return 0.3, "year_match", true
		case lo == hi && (lo == t.Year-1 || lo == t.Year+1):
			return 0.2, "year_close", true
		case lo != hi && collection && lo <= t.Year && t.Year <= hi:
			return 0.2, "year_in_range", true
		}
		return 0, "year_mismatch", false
	}
	if lo < t.Year-1 || hi > t.lastYear()+1 {
		return 0, "year_mismatch", false
	}
	// A single-season release dated far from that season's air year is
	// suspicious (mis-tagged or another show); not a hard reject.
	if t.SeasonYear > 0 && len(p.Seasons) == 1 && t.Season != nil && p.Seasons[0] == *t.Season &&
		(hi < t.SeasonYear-1 || lo > t.SeasonYear+1) {
		return 0.1, "season_year_mismatch", true
	}
	return 0.3, "year_in_range", true
}

// episodeScore checks a series release against the requested season/episode.
func (t *Target) episodeScore(p *Parsed) (float64, string, bool, bool) {
	if p.Complete {
		return 0.05, "complete_series", true, true
	}
	pack := p.IsPack()
	seasons := p.Seasons
	if len(seasons) == 0 && len(p.Episodes) > 0 && (t.SeasonCount <= 1 || (t.Season != nil && *t.Season == 1)) {
		seasons = []int{1} // "[1-25 из 25]" on a one-season show
		pack = len(p.Episodes) != 1
	}
	if len(seasons) == 0 {
		if len(p.Years) >= 2 && p.Years[0] <= t.Year+1 && p.Years[len(p.Years)-1] >= t.lastYear()-1 {
			return 0, "complete_series", true, true
		}
		if t.Season != nil {
			// No season, no episodes, no multi-year span: a movie, special
			// or something else; never offered for a specific season.
			return 0, "season_unknown", false, false
		}
		return -0.15, "season_unknown", false, true
	}
	if t.Season == nil {
		return 0.05, "", pack, true
	}
	// "S1E1-73 of 73 [2011-2019]": the whole show labelled as one season.
	if len(seasons) == 1 && len(p.Years) >= 2 && len(p.Episodes) > 1 && p.Years[0] <= t.Year+1 &&
		p.Years[len(p.Years)-1] >= t.lastYear()-1 && p.Years[len(p.Years)-1]-p.Years[0] >= 2 {
		return 0.05, "complete_series", true, true
	}
	s := *t.Season
	if !slices.Contains(seasons, s) {
		return 0, "season_mismatch", false, false
	}
	if len(seasons) > 1 {
		return 0.05, "multi_season_pack", true, true
	}
	if t.Episode != nil {
		e := *t.Episode
		switch {
		case len(p.Episodes) == 0:
			return 0.05, "season_pack", true, true
		case !slices.Contains(p.Episodes, e):
			return 0, "episode_mismatch", false, false
		case len(p.Episodes) == 1:
			return 0.1, "episode_match", false, true
		default:
			return 0.05, "episode_in_pack", true, true
		}
	}
	if len(p.Episodes) == 1 && p.EpisodeTotal != 1 {
		return -0.1, "single_episode", false, true
	}
	if len(p.Episodes) == 0 {
		return 0.05, "season_pack", true, true
	}
	return 0.05, "season_match", pack, true
}
