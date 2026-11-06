package imports

import (
	"context"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"martytv/api/internal/catalog"
)

// Catalog is the part of the catalog the matcher uses. Every result is
// materialized by the catalog (stable media ids), through the TMDB client
// with its proxy, rate limit and response cache.
type Catalog interface {
	Search(ctx context.Context, query, kind, lang string, page int) (*catalog.MediaPage, error)
	SearchYear(ctx context.Context, query, kind, lang string, year int) (*catalog.MediaPage, error)
}

// Unmatched reasons (contract: ImportUnmatched.reason).
const (
	ReasonNotFound  = "not_found"   // no TMDB title close enough (see pick)
	ReasonAmbiguous = "ambiguous"   // several equally good candidates
	ReasonInvalid   = "invalid_row" // the CSV line itself is unusable
	ReasonTMDB      = "tmdb_error"  // TMDB kept failing for this row
	ReasonConflict  = "kp_conflict" // the best title is already mapped to another Kinopoisk id
)

// Match is a matcher decision.
type Match struct {
	MediaID string
	Kind    string
	Title   string
	Year    int
	// How: "kp_id" (already mapped), "exact" (title + year), "year_pm1",
	// "year_pm2", "year_only" or "title_only" (row without a year); see pick.
	How string
}

// lang is the search language: Title is then the Russian title, which is
// what Kinopoisk's title_ru is compared with (OriginalTitle covers
// title_original).
const lang = "ru"

// matchTMDB finds the TMDB title for a row: the original title first, then
// the Russian one; per kind (a row of unknown type tries movie and series).
// When nothing at all comes close, the other kind is tried too, accepting
// only an exact title + year (Kinopoisk lists some TV specials as films and
// some film cycles as series). It returns (nil, reason, nil) for a miss and
// an error only when TMDB fails for every search.
func matchTMDB(ctx context.Context, cat Catalog, r Row) (*Match, string, error) {
	var queries []string
	seen := map[string]bool{}
	for _, q := range []string{r.TitleOriginal, r.TitleRU} {
		if n := normalize(q); n != "" && !seen[n] {
			seen[n] = true
			queries = append(queries, q)
		}
	}
	w := wanted{names: titleSet(r.TitleOriginal, r.TitleRU), titles: []string{r.TitleOriginal, r.TitleRU}}
	kinds := r.Kinds()
	m, d, err := searchAll(ctx, cat, queries, kinds, r.Year, w)
	if m != nil || err != nil {
		return m, "", err
	}
	if d.tier == 0 && len(kinds) == 1 {
		other := "series"
		if kinds[0] == "series" {
			other = "movie"
		}
		om, od, err := searchAll(ctx, cat, queries, []string{other}, r.Year, w)
		if err != nil && ctx.Err() != nil {
			return nil, "", err
		}
		if om != nil {
			return om, "", nil
		}
		if od.match != nil && od.tier == tierExact {
			return od.match, "", nil
		}
	}
	switch {
	case d.match != nil:
		return d.match, "", nil
	case d.ambiguous:
		return nil, ReasonAmbiguous, nil
	}
	return nil, ReasonNotFound, nil
}

// searchAll runs every query for the kinds. An exact match returns at once
// (no need for the Russian-title query); otherwise the strongest decision.
func searchAll(ctx context.Context, cat Catalog, queries, kinds []string, year int, w wanted) (*Match, decision, error) {
	var all []decision
	var lastErr error
	searched := false
	for _, q := range queries {
		var perKind []decision
		for _, kind := range kinds {
			d, err := searchKind(ctx, cat, q, kind, year, w)
			if err != nil {
				if ctx.Err() != nil {
					return nil, decision{}, ctx.Err()
				}
				lastErr = err
				continue
			}
			searched = true
			perKind = append(perKind, d)
		}
		d := strongest(perKind)
		if d.match != nil && d.tier == tierExact {
			return d.match, d, nil
		}
		all = append(all, d)
	}
	if !searched && lastErr != nil {
		return nil, decision{}, lastErr
	}
	return nil, strongest(all), nil
}

// wanted is what a row is matched against.
type wanted struct {
	names  map[string]bool // normalized titles
	titles []string        // raw titles (for word overlap)
}

// decision is the outcome of one search (a kind, a query).
type decision struct {
	match     *Match
	tier      int // tierExact … tierYearOnly; 0 = nothing came close
	ambiguous bool
}

const (
	tierYearOnly = 1
	tierPM2      = 2
	tierPM1      = 3
	tierExact    = 4
)

// strongest merges decisions: the highest tier wins; different titles at
// the same tier are ambiguous.
func strongest(ds []decision) decision {
	var out decision
	for _, d := range ds {
		switch {
		case d.tier > out.tier:
			out = d
		case d.tier == out.tier && d.tier > 0:
			if d.match != nil && out.match != nil && d.match.MediaID != out.match.MediaID {
				out = decision{tier: d.tier, ambiguous: true}
			} else if d.ambiguous {
				out.ambiguous, out.match = true, nil
			}
		}
	}
	return out
}

// searchKind runs the plain search and, when the title is common enough
// that page 1 holds no candidate of the right year, the same search
// narrowed to the year.
func searchKind(ctx context.Context, cat Catalog, q, kind string, year int, w wanted) (decision, error) {
	page, err := cat.Search(ctx, q, kind, lang, 1)
	if err != nil {
		return decision{}, err
	}
	d := pick(page.Items, year, w)
	if d.tier == tierExact || year == 0 || page.TotalResults <= len(page.Items) {
		return d, nil
	}
	narrowed, err := cat.SearchYear(ctx, q, kind, lang, year)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return decision{}, err
		}
		return d, nil // keep what the plain search found
	}
	seen := map[string]bool{}
	merged := make([]catalog.MediaSummary, 0, len(page.Items)+len(narrowed.Items))
	for _, it := range append(append([]catalog.MediaSummary{}, page.Items...), narrowed.Items...) {
		if !seen[it.ID] {
			seen[it.ID] = true
			merged = append(merged, it)
		}
	}
	return pick(merged, year, w), nil
}

// pick applies the rules to one result set, strongest first:
//
//  1. exact: a normalized title (Russian or original) equal to the row's,
//     same year;
//  2. year_pm1: same title, year ±1 (Kinopoisk and TMDB disagree on premiere
//     vs. release years);
//  3. year_pm2: same title, year ±2, and the only such result (festival
//     films released two years later);
//  4. year_only: no title equality (subtitles, "3D", episode numbers), but
//     exactly one result of exactly that year shares most words with the
//     row's title (see overlaps).
//
// Several different titles at the best tier are ambiguous, unless one has
// at least dominanceFactor× the votes of every other (TMDB duplicates and
// obscure namesakes of a famous film). Titles without a year never match.
func pick(items []catalog.MediaSummary, year int, w wanted) decision {
	named := func(it catalog.MediaSummary) bool {
		return w.names[normalize(it.Title)] || w.names[normalize(it.OriginalTitle)]
	}
	if year == 0 {
		// No year: only a single exact-title result is safe.
		var hits []catalog.MediaSummary
		for _, it := range items {
			if named(it) {
				hits = append(hits, it)
			}
		}
		if len(hits) == 1 {
			return decision{tier: tierYearOnly, match: toMatch(hits[0], "title_only")}
		}
		if len(hits) > 1 {
			return decision{tier: tierYearOnly, ambiguous: true}
		}
		return decision{}
	}
	var exact, pm1, pm2, similar []catalog.MediaSummary
	similarNear := 0 // similar titles one year off: they make year_only unsafe
	for _, it := range items {
		if it.Year == nil {
			continue
		}
		d := abs(*it.Year - year)
		n := named(it)
		switch {
		case n && d == 0:
			exact = append(exact, it)
		case n && d == 1:
			pm1 = append(pm1, it)
		case n && d == 2:
			pm2 = append(pm2, it)
		case !n && d == 0 && overlaps(w.titles, it):
			similar = append(similar, it)
		case !n && d == 1 && overlaps(w.titles, it):
			similarNear++
		}
	}
	switch {
	case len(exact) > 0:
		return decide(exact, tierExact, "exact")
	case len(pm1) > 0:
		return decide(pm1, tierPM1, "year_pm1")
	case len(pm2) == 1:
		return decision{tier: tierPM2, match: toMatch(pm2[0], "year_pm2")}
	case len(pm2) > 1:
		return decision{tier: tierPM2, ambiguous: true}
	case len(similar) == 1 && similarNear == 0:
		return decision{tier: tierYearOnly, match: toMatch(similar[0], "year_only")}
	case len(similar)+similarNear > 1:
		return decision{tier: tierYearOnly, ambiguous: true}
	}
	return decision{}
}

// overlaps: some pair of (row title, result title) shares at least half of
// the shorter title's words. Words of one letter are ignored; a word
// matches another that it prefixes when both have 4+ letters (Russian
// inflection: «Шерлок» ~ «Шерлока»).
func overlaps(rowTitles []string, it catalog.MediaSummary) bool {
	for _, a := range rowTitles {
		wa := words(a)
		if len(wa) == 0 {
			continue
		}
		for _, b := range []string{it.Title, it.OriginalTitle} {
			wb := words(b)
			if len(wb) == 0 {
				continue
			}
			short, long := wa, wb
			if len(short) > len(long) {
				short, long = long, short
			}
			hits := 0
			for _, x := range short {
				for _, y := range long {
					if x == y || (min(utf8.RuneCountInString(x), utf8.RuneCountInString(y)) >= 4 && (strings.HasPrefix(x, y) || strings.HasPrefix(y, x))) {
						hits++
						break
					}
				}
			}
			if hits > 0 && hits*2 >= len(short) {
				return true
			}
		}
	}
	return false
}

// words splits a title into folded words (ё→е, lower case, 2+ characters).
func words(s string) []string {
	s = strings.NewReplacer("ё", "е", "Ё", "е").Replace(strings.ToLower(s))
	var out []string
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if utf8.RuneCountInString(f) >= 2 {
			out = append(out, f)
		}
	}
	return out
}

const dominanceFactor = 10

func decide(c []catalog.MediaSummary, tier int, how string) decision {
	if len(c) == 1 {
		return decision{tier: tier, match: toMatch(c[0], how)}
	}
	top, second := 0, -1
	for i := 1; i < len(c); i++ {
		if c[i].VoteCount > c[top].VoteCount {
			second, top = top, i
		} else if second < 0 || c[i].VoteCount > c[second].VoteCount {
			second = i
		}
	}
	if c[top].VoteCount >= 20 && c[top].VoteCount >= dominanceFactor*max(c[second].VoteCount, 1) {
		return decision{tier: tier, match: toMatch(c[top], how)}
	}
	return decision{tier: tier, ambiguous: true}
}

func toMatch(it catalog.MediaSummary, how string) *Match {
	m := &Match{MediaID: it.ID, Kind: it.Kind, Title: it.Title, How: how}
	if it.Year != nil {
		m.Year = *it.Year
	}
	return m
}

func titleSet(ts ...string) map[string]bool {
	out := map[string]bool{}
	for _, t := range ts {
		if n := normalize(t); n != "" {
			out[n] = true
		}
	}
	return out
}

// normalize folds case, ё→е and & → and, and keeps only letters and digits
// ("Spider-Man: No Way Home" == "spider man no way home"); the same rule as
// internal/ratings.
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
