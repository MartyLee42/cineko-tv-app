package awards

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"martytv/api/internal/catalog"
	"martytv/api/internal/ratings"
)

// The fixture is a live Wikidata answer (2026-11) to buildQuery for
// Parasite (2019), Anora (2024) and Leviathan (2014), by IMDb id.
var fixtureTitles = []ratings.WDTitle{
	{ID: "parasite", Kind: "movie", TMDBID: 496243, IMDbID: "tt6751668"},
	{ID: "anora", Kind: "movie", TMDBID: 1064213, IMDbID: "tt28607951"},
	{ID: "leviathan", Kind: "movie", TMDBID: 265189, IMDbID: "tt2802154"},
	{ID: "unknown", Kind: "movie", TMDBID: 1, IMDbID: "tt0000001"},
}

func fixtureAwards(t *testing.T) map[string][]Award {
	t.Helper()
	body, err := os.ReadFile("testdata/wikidata_awards.json")
	if err != nil {
		t.Fatal(err)
	}
	var queries []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.PostFormValue("query"))
		w.Header().Set("Content-Type", "application/sparql-results+json")
		_, _ = w.Write(body)
	}))
	defer srv.Close()
	c := ratings.NewWikidata(srv.URL, nil)
	rows, err := c.Select(context.Background(), buildQuery(fixtureTitles))
	if err != nil {
		t.Fatal(err)
	}
	if len(queries) != 1 || !strings.Contains(queries[0], `VALUES ?i { "tt6751668" "tt28607951" "tt2802154" "tt0000001" }`) {
		t.Fatalf("query %v", queries)
	}
	return parse(fixtureTitles, rows)
}

func labels(es []catalog.AwardEntry) string {
	var out []string
	for _, e := range es {
		y := "?"
		if e.Year != nil {
			y = strconv.Itoa(*e.Year)
		}
		out = append(out, y+" "+e.Label)
	}
	return strings.Join(out, "; ")
}

func TestParseFixtureGrouped(t *testing.T) {
	got := fixtureAwards(t)
	if _, ok := got["unknown"]; ok {
		t.Fatal("a title without an item has no awards")
	}
	for _, a := range got["parasite"] {
		if a.QID == "Q125506406" {
			t.Fatal("the Oscar submission is not a nomination")
		}
		if a.QID == "Q102427" && !a.Won {
			t.Fatal("a nomination for an award also won is dropped")
		}
	}

	ru := Grouped(got["parasite"], "ru")
	if len(ru) < 4 || ru[0].Group != "oscar" || ru[0].GroupLabel != "Оскар" || ru[0].Tier != 1 {
		t.Fatalf("first group %+v", ru[0])
	}
	if s := labels(ru[0].Wins); s != "2020 лучший фильм; 2020 лучшая режиссёрская работа; 2020 лучший оригинальный сценарий; 2020 лучший фильм на иностранном языке" {
		t.Fatalf("oscar wins %q", s)
	}
	if s := labels(ru[0].Nominations); s != "2020 лучшая работа художника-постановщика; 2020 лучший монтаж" {
		t.Fatalf("oscar nominations %q", s)
	}
	if ru[1].Group != "cannes" || ru[1].Tier != 1 || labels(ru[1].Wins) != "2019 Золотая пальмовая ветвь" {
		t.Fatalf("cannes %+v", ru[1])
	}
	if last := ru[len(ru)-1]; last.Group != "other" || last.Tier != 3 || last.GroupLabel != "Другие награды" {
		t.Fatalf("other last: %+v", last)
	}
	en := Grouped(got["parasite"], "en")
	if s := labels(en[0].Wins); s != "2020 Best Picture; 2020 Best Director; 2020 Best International Feature Film; 2020 Best Original Screenplay" {
		t.Fatalf("en oscar wins %q", s)
	}
	if en[1].GroupLabel != "Cannes" || labels(en[1].Wins) != "2019 Palme d'Or" {
		t.Fatalf("en cannes %+v", en[1])
	}

	lev := Grouped(got["leviathan"], "ru")
	// Tier first: the Oscar nomination before the Golden Globe win.
	if lev[0].Group != "oscar" || len(lev[0].Wins) != 0 || labels(lev[0].Nominations) != "2015 лучший фильм на иностранном языке" {
		t.Fatalf("leviathan oscar %+v", lev[0])
	}
	var gg *catalog.AwardGroup
	for i := range lev {
		if lev[i].Group == "golden_globe" {
			gg = &lev[i]
		}
	}
	if gg == nil || len(gg.Wins) != 1 || gg.Wins[0].Year != nil {
		t.Fatalf("leviathan golden globe (no year on Wikidata) %+v", gg)
	}
}

func TestBadges(t *testing.T) {
	got := fixtureAwards(t)
	count := func(id string) map[string]int {
		c := map[string]int{}
		for _, a := range got[id] {
			if a.Won && a.Tier == 1 {
				c[a.Group]++
			}
		}
		return c
	}
	if b := pickBadge(count("anora")); b == nil || *b != (catalog.AwardBadge{Group: "oscar", Count: 5}) {
		t.Fatalf("anora %+v", b)
	}
	if b := pickBadge(count("parasite")); b == nil || *b != (catalog.AwardBadge{Group: "oscar", Count: 4}) {
		t.Fatalf("parasite %+v", b)
	}
	if b := pickBadge(count("leviathan")); b != nil {
		t.Fatalf("leviathan has no tier-1 win: %+v", b)
	}
	if b := pickBadge(map[string]int{"cannes": 1, "venice": 1}); b.Group != "cannes" {
		t.Fatalf("ties follow the curated order: %+v", b)
	}
}

func row(kv ...string) map[string]string {
	m := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return m
}

const ent = "http://www.wikidata.org/entity/"

func TestPickItem(t *testing.T) {
	movie := ratings.WDTitle{ID: "a", Kind: "movie", TMDBID: 10, IMDbID: "tt0000010"}
	// Two items share the TMDB id: ambiguous → none.
	two := []map[string]string{row("tm", "10", "item", ent+"Q1"), row("tm", "10", "item", ent+"Q2")}
	if got := pickItem(movie, two); got != "" {
		t.Fatalf("ambiguous: %q", got)
	}
	// The IMDb match wins over TMDB matches.
	withIMDb := append(two, row("i", "tt0000010", "item", ent+"Q2"))
	if got := pickItem(movie, withIMDb); got != "Q2" {
		t.Fatalf("imdb: %q", got)
	}
	// A TMDB match whose IMDb id contradicts ours is another title.
	other := []map[string]string{row("tm", "10", "item", ent+"Q3", "imdb", "tt0000099")}
	if got := pickItem(movie, other); got != "" {
		t.Fatalf("contradicted: %q", got)
	}
	// Series match by the TV property only.
	show := ratings.WDTitle{ID: "s", Kind: "series", TMDBID: 10}
	if got := pickItem(show, []map[string]string{row("tm", "10", "item", ent+"Q4")}); got != "" {
		t.Fatalf("movie id used for a series: %q", got)
	}
	if got := pickItem(show, []map[string]string{row("tv", "10", "item", ent+"Q4")}); got != "Q4" {
		t.Fatalf("series: %q", got)
	}
}

func TestItemAwardsDedupAndYears(t *testing.T) {
	rows := []map[string]string{
		// Same statement through two events (dates differ, same year).
		row("item", ent+"Q1", "award", ent+"Q387380", "won", "1", "evTime", "2020-01-01T00:00:00Z", "grp", ent+"Q1011547", "en", "Golden Globe Award for Best Non-English Language Film"),
		row("item", ent+"Q1", "award", ent+"Q387380", "won", "1", "evTime", "2020-01-05T00:00:00Z", "grp", ent+"Q1011547", "en", "Golden Globe Award for Best Non-English Language Film"),
		// A nomination the next year for the same award won: dropped.
		row("item", ent+"Q1", "award", ent+"Q387380", "won", "0", "time", "2021-02-09T00:00:00Z", "en", "Golden Globe Award for Best Non-English Language Film"),
		// Festival main prize: tier 1 whatever the anchors.
		row("item", ent+"Q1", "award", ent+"Q209459", "won", "1", "time", "1999-01-01T00:00:00Z", "ru", "Золотой лев"),
		// No label at all: skipped.
		row("item", ent+"Q1", "award", ent+"Q999", "won", "1"),
		// Ignored: submission.
		row("item", ent+"Q1", "award", ent+"Q125506406", "won", "0", "en", "International Submission to the Academy Awards"),
		// Reaches several anchors: the higher-priority group wins.
		row("item", ent+"Q1", "award", ent+"Q5", "won", "0", "time", "2010-01-01T00:00:00Z", "grp", ent+"Q732997", "en", "BAFTA Award for Best Film"),
		row("item", ent+"Q1", "award", ent+"Q5", "won", "0", "time", "2010-01-01T00:00:00Z", "grp", ent+"Q19020", "en", "BAFTA Award for Best Film"),
		// The award item is an anchor itself (Brother, 1998: "Nika Award").
		row("item", ent+"Q1", "award", ent+"Q431668", "won", "1", "time", "1998-01-01T00:00:00Z", "ru", "Ника", "en", "Nika Award"),
	}
	got := itemAwards(rows)
	if len(got) != 4 {
		t.Fatalf("%+v", got)
	}
	want := []Award{
		{QID: "Q387380", Group: "golden_globe", Tier: 2, LabelEN: "Golden Globe Award for Best Non-English Language Film", Year: 2020, Won: true},
		{QID: "Q209459", Group: "venice", Tier: 1, LabelRU: "Золотой лев", Year: 1999, Won: true},
		{QID: "Q5", Group: "oscar", Tier: 1, LabelEN: "BAFTA Award for Best Film", Year: 2010},
		{QID: "Q431668", Group: "nika", Tier: 2, LabelRU: "Ника", LabelEN: "Nika Award", Year: 1998, Won: true},
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%d: %+v want %+v", i, got[i], want[i])
		}
	}
	// ru falls back to the en label (and vice versa).
	if l := got[0].label("ru"); l != "Golden Globe Award for Best Non-English Language Film" {
		t.Fatal(l)
	}
	if l := got[1].label("en"); l != "Золотой лев" {
		t.Fatal(l)
	}
}

func TestShortLabel(t *testing.T) {
	for _, c := range [][3]string{
		{"oscar", "премия «Оскар» за лучший фильм", "лучший фильм"},
		{"oscar", "премия «Оскар» за лучшую мужскую роль", "лучшая мужская роль"},
		{"oscar", "Academy Award for Best Writing, Original Screenplay", "Best Original Screenplay"},
		{"efa", "премия Европейской киноакадемии лучшему режиссёру", "лучший режиссёр"},
		{"emmy", "Primetime Emmy Award for Outstanding Drama Series", "Outstanding Drama Series"},
		{"emmy", "Прайм-тайм премия «Эмми» за лучший сценарий драматического телесериала", "лучший сценарий драматического телесериала"},
		{"emmy", "премия «Эмми» в категории «Лучший приглашённый актёр»", "Лучший приглашённый актёр"},
		{"cannes", "Palme d'Or", "Palme d'Or"},
		{"cannes", "Cannes Film Festival Award for Best Director", "Best Director"},
		{"other", "Premio «Something» for Best", "Premio «Something» for Best"},
		{"oscar", "Academy Honorary Award", "Academy Honorary Award"},
	} {
		if got := ShortLabel(c[0], c[1]); got != c[2] {
			t.Errorf("%s %q → %q, want %q", c[0], c[1], got, c[2])
		}
	}
}

func TestBuildQuery(t *testing.T) {
	q := buildQuery([]ratings.WDTitle{
		{ID: "m", Kind: "movie", TMDBID: 5},
		{ID: "s", Kind: "series", TMDBID: 7, IMDbID: "bad"},
		{ID: "x", Kind: "person", TMDBID: 9},
	})
	for _, want := range []string{`VALUES ?tm { "5" }`, `VALUES ?tv { "7" }`, "p:P166", "p:P1411", "pq:P585", "pq:P805", "wd:Q19020", "wd:Q431668"} {
		if !strings.Contains(q, want) {
			t.Errorf("query lacks %q:\n%s", want, q)
		}
	}
	if strings.Contains(q, "?i {") || strings.Contains(q, `"9"`) {
		t.Errorf("invalid ids queried:\n%s", q)
	}
	if buildQuery([]ratings.WDTitle{{ID: "x"}}) != "" {
		t.Error("nothing to ask: empty query")
	}
}
