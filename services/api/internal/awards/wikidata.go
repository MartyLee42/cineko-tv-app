package awards

import (
	"regexp"
	"strconv"
	"strings"

	"martytv/api/internal/ratings"
)

// Award is one stored row: an award item won or nominated for in a year
// (0 = unknown), with its Wikidata labels and curated group/tier.
type Award struct {
	QID     string
	Group   string
	Tier    int
	LabelRU string
	LabelEN string
	Year    int
	Won     bool
}

var (
	imdbRe = regexp.MustCompile(`^tt\d{5,10}$`)
	qidRe  = regexp.MustCompile(`^Q\d+$`)
)

// buildQuery asks for the awards (P166) and nominations (P1411) of a batch
// of titles found by TMDB id (P4947 movie / P4983 TV series) or IMDb id
// (P345). Per statement: point in time (P585) or the date of the event it
// is about (P805 → P585), the award's ru/en labels and the curated anchors
// it reaches. ?item and its IMDb id let the parser reject ambiguous matches.
func buildQuery(ts []ratings.WDTitle) string {
	var movies, shows, imdb []string
	seen := map[string]bool{}
	add := func(list *[]string, key, v string) {
		if !seen[key+v] {
			seen[key+v] = true
			*list = append(*list, `"`+v+`"`)
		}
	}
	for _, t := range ts {
		if t.TMDBID > 0 {
			if t.Kind == "series" {
				add(&shows, "s", strconv.Itoa(t.TMDBID))
			} else if t.Kind == "movie" {
				add(&movies, "m", strconv.Itoa(t.TMDBID))
			}
		}
		if imdbRe.MatchString(t.IMDbID) {
			add(&imdb, "i", t.IMDbID)
		}
	}
	var parts []string
	if len(movies) > 0 {
		parts = append(parts, `{ VALUES ?tm { `+strings.Join(movies, " ")+` } ?item wdt:P4947 ?tm . }`)
	}
	if len(shows) > 0 {
		parts = append(parts, `{ VALUES ?tv { `+strings.Join(shows, " ")+` } ?item wdt:P4983 ?tv . }`)
	}
	if len(imdb) > 0 {
		parts = append(parts, `{ VALUES ?i { `+strings.Join(imdb, " ")+` } ?item wdt:P345 ?i . }`)
	}
	if len(parts) == 0 {
		return ""
	}
	return "SELECT ?tm ?tv ?i ?item ?imdb ?award ?won ?time ?evTime ?grp ?ru ?en WHERE {\n  " +
		strings.Join(parts, "\n  UNION ") + `
  { ?item p:P166 ?st . ?st ps:P166 ?award . BIND(1 AS ?won) }
  UNION { ?item p:P1411 ?st . ?st ps:P1411 ?award . BIND(0 AS ?won) }
  OPTIONAL { ?item wdt:P345 ?imdb . }
  OPTIONAL { ?st pq:P585 ?time . }
  OPTIONAL { ?st pq:P805 ?ev . ?ev wdt:P585 ?evTime . }
  OPTIONAL { VALUES ?grp { wd:` + strings.Join(anchors(), " wd:") + ` }
             ?award (wdt:P31|wdt:P361|wdt:P1027)/wdt:P361? ?grp . }
  OPTIONAL { ?award rdfs:label ?ru . FILTER(lang(?ru) = "ru") }
  OPTIONAL { ?award rdfs:label ?en . FILTER(lang(?en) = "en") }
}`
}

// qid strips the entity IRI prefix ("" when v is not an item IRI).
func qid(v string) string {
	if i := strings.LastIndexByte(v, '/'); i >= 0 {
		v = v[i+1:]
	}
	if !qidRe.MatchString(v) {
		return ""
	}
	return v
}

// yearOf reads the year of an xsd:dateTime ("2020-02-09T00:00:00Z"); 0 when
// absent or implausible.
func yearOf(v string) int {
	if len(v) < 4 {
		return 0
	}
	y, err := strconv.Atoi(v[:4])
	if err != nil || y < 1900 || y > 2100 {
		return 0
	}
	return y
}

// pickItem chooses the Wikidata item of t among the batch rows, like the
// Kinopoisk lookup: items matched by IMDb id win (exactly one, else none);
// otherwise exactly one item matched by the kind's TMDB id whose own IMDb
// id does not contradict ours.
func pickItem(t ratings.WDTitle, rows []map[string]string) string {
	byIMDb, byTMDB := map[string]bool{}, map[string]bool{}
	imdbs := map[string]map[string]bool{}
	tmdb := strconv.Itoa(t.TMDBID)
	hasIMDb := imdbRe.MatchString(t.IMDbID)
	for _, r := range rows {
		item := qid(r["item"])
		if item == "" {
			continue
		}
		if imdbs[item] == nil {
			imdbs[item] = map[string]bool{}
		}
		if v := r["imdb"]; v != "" {
			imdbs[item][strings.ToLower(v)] = true
		}
		if hasIMDb && strings.EqualFold(r["i"], t.IMDbID) {
			byIMDb[item] = true
		}
		if t.TMDBID > 0 && ((t.Kind == "series" && r["tv"] == tmdb) || (t.Kind == "movie" && r["tm"] == tmdb)) {
			byTMDB[item] = true
		}
	}
	only := func(set map[string]bool) string {
		if len(set) != 1 {
			return ""
		}
		for k := range set {
			return k
		}
		return ""
	}
	if len(byIMDb) > 0 {
		return only(byIMDb)
	}
	ok := map[string]bool{}
	for item := range byTMDB {
		if hasIMDb && len(imdbs[item]) > 0 && !imdbs[item][strings.ToLower(t.IMDbID)] {
			continue // the item is another title
		}
		ok[item] = true
	}
	return only(ok)
}

// parse turns the result rows of one batch into each title's awards
// (deduplicated; nominations dropped where the same award was won within
// a year; ignored items skipped). Titles without a confident item get none.
func parse(ts []ratings.WDTitle, rows []map[string]string) map[string][]Award {
	byItem := map[string][]map[string]string{}
	for _, r := range rows {
		if item := qid(r["item"]); item != "" {
			byItem[item] = append(byItem[item], r)
		}
	}
	out := map[string][]Award{}
	for _, t := range ts {
		item := pickItem(t, rows)
		if item == "" {
			continue
		}
		out[t.ID] = itemAwards(byItem[item])
	}
	return out
}

// itemAwards aggregates one item's rows.
func itemAwards(rows []map[string]string) []Award {
	type info struct {
		reached []string
		ru, en  string
	}
	infos := map[string]*info{}
	type key struct {
		qid  string
		year int
		won  bool
	}
	seen := map[key]bool{}
	var keys []key
	for _, r := range rows {
		q := qid(r["award"])
		if q == "" || ignored[q] {
			continue
		}
		in := infos[q]
		if in == nil {
			in = &info{}
			infos[q] = in
		}
		if g := qid(r["grp"]); g != "" {
			in.reached = append(in.reached, g)
		}
		if in.ru == "" {
			in.ru = strings.TrimSpace(r["ru"])
		}
		if in.en == "" {
			in.en = strings.TrimSpace(r["en"])
		}
		y := yearOf(r["time"])
		if y == 0 {
			y = yearOf(r["evTime"])
		}
		k := key{q, y, r["won"] == "1" || r["won"] == "true"}
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	wonYears := map[string][]int{}
	for _, k := range keys {
		if k.won {
			wonYears[k.qid] = append(wonYears[k.qid], k.year)
		}
	}
	var out []Award
	for _, k := range keys {
		if !k.won && wonNear(wonYears[k.qid], k.year) {
			continue
		}
		in := infos[k.qid]
		if in.ru == "" && in.en == "" {
			continue // no usable name
		}
		g, tier := classify(k.qid, in.reached)
		out = append(out, Award{QID: k.qid, Group: g, Tier: tier, LabelRU: in.ru, LabelEN: in.en, Year: k.year, Won: k.won})
	}
	return out
}

// wonNear: the award was won in year (±1; an unknown year matches any).
func wonNear(years []int, year int) bool {
	for _, y := range years {
		if y == 0 || year == 0 || (y-year <= 1 && year-y <= 1) {
			return true
		}
	}
	return false
}
