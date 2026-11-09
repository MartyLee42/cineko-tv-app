package releases

import (
	"strconv"
	"strings"
)

// maxQueries caps Prowlarr requests per search; each one fans out to every
// tracker. Titles with a non-Latin/Cyrillic original get one more for their
// romanized names (maxQueriesRomanized).
const (
	maxQueries          = 5
	maxQueriesRomanized = 6
)

// nativeSearchLanguages: originals in these languages are also searched in
// their own script, last ("도깨비" appears in some dorama/anime uploads).
var nativeSearchLanguages = map[string]bool{"ko": true, "ja": true, "zh": true, "cn": true, "th": true}

// buildQueries returns the free-text searches for a target. The RU trackers
// only support text search; titles are written "Русское / Original", so the
// Russian and original titles are both searched. Movies add the year (it
// narrows RuTracker's 50-result pages); one bare Russian query keeps
// ExKinoRay, which doesn't match "title year". Series search the bare titles
// (complete packs) plus season forms ("Игра престолов 1 сезон", "Game of
// Thrones S01"). A non-Latin/Cyrillic original (도깨비, 千と千尋の神隠し) is
// replaced by the English title, then t.SearchNames ("Dokkaebi") and, for
// CJK/Thai, the native title are added after the usual queries.
func buildQueries(t *Target, titleRU, titleEN, original string) []string {
	var out []string
	limit := maxQueries
	add := func(q string) {
		q = strings.Join(strings.Fields(q), " ")
		if q == "" || len(out) >= limit {
			return
		}
		for _, x := range out {
			if strings.EqualFold(x, q) {
				return
			}
		}
		out = append(out, q)
	}
	clean := func(s string) string {
		// Search engines on the trackers choke on some punctuation.
		return strings.NewReplacer(":", " ", "«", "", "»", "", "\"", "", "—", " ", "–", " ").Replace(s)
	}
	ru, en, orig := clean(titleRU), clean(titleEN), clean(original)
	native := ""
	if script(orig) != "lat" && script(orig) != "cyr" {
		native, orig = orig, "" // 千と千尋の神隠し: trackers use the English/Russian names
	}
	var names []string
	if native != "" {
		for _, n := range t.SearchNames {
			names = append(names, clean(n))
		}
		if !nativeSearchLanguages[t.OriginalLanguage] {
			native = ""
		}
	}
	year := ""
	if t.Year > 0 {
		year = " " + strconv.Itoa(t.Year)
	}
	// extra runs after the usual queries, with the raised cap: each name in
	// its first form, then the later forms, then the native title.
	extra := func(forms func(name string) []string) {
		if len(names) == 0 && native == "" {
			return
		}
		limit = maxQueriesRomanized
		var rest []string
		for _, n := range names {
			f := forms(n)
			add(f[0])
			rest = append(rest, f[1:]...)
		}
		for _, q := range rest {
			add(q)
		}
		add(native)
	}
	if t.Kind == "movie" {
		if orig != "" {
			add(orig + year)
		}
		add(ru + year)
		add(ru)
		if orig == "" || !strings.EqualFold(en, orig) {
			add(en + year)
		}
		extra(func(n string) []string { return []string{n + year} })
		return out
	}
	add(ru)
	if orig != "" {
		add(orig)
	} else {
		add(en)
	}
	sxx := ""
	if t.Season != nil && *t.Season > 0 {
		s := strconv.Itoa(*t.Season)
		add(ru + " " + s + " сезон")
		base := orig
		if base == "" {
			base = en
		}
		if len(s) == 1 {
			s = "0" + s
		}
		sxx = " S" + s
		add(base + sxx)
	}
	if orig != "" && !strings.EqualFold(en, orig) {
		add(en)
	}
	extra(func(n string) []string {
		if sxx == "" {
			return []string{n}
		}
		return []string{n, n + sxx}
	})
	return out
}
