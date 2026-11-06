package releases

import (
	"strconv"
	"strings"
)

// maxQueries caps Prowlarr requests per search; each one fans out to every
// tracker.
const maxQueries = 5

// buildQueries returns the free-text searches for a target. The RU trackers
// only support text search; titles are written "Русское / Original", so the
// Russian and original titles are both searched. Movies add the year (it
// narrows RuTracker's 50-result pages); one bare Russian query keeps
// ExKinoRay, which doesn't match "title year". Series search the bare titles
// (complete packs) plus season forms ("Игра престолов 1 сезон", "Game of
// Thrones S01").
func buildQueries(t *Target, titleRU, titleEN, original string) []string {
	var out []string
	add := func(q string) {
		q = strings.Join(strings.Fields(q), " ")
		if q == "" || len(out) >= maxQueries {
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
	if script(orig) != "lat" && script(orig) != "cyr" {
		orig = "" // 千と千尋の神隠し: trackers use the English/Russian names
	}
	year := ""
	if t.Year > 0 {
		year = " " + strconv.Itoa(t.Year)
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
		return out
	}
	add(ru)
	if orig != "" {
		add(orig)
	} else {
		add(en)
	}
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
		add(base + " S" + s)
	}
	if orig != "" && !strings.EqualFold(en, orig) {
		add(en)
	}
	return out
}
