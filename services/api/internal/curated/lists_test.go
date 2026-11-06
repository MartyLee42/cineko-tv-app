package curated

import (
	"strings"
	"testing"
	"testing/fstest"
	"unicode/utf8"

	"martytv/api/internal/catalog"
)

// The embedded list files are valid: unique ids, known groups, sane years,
// no duplicate TMDB id per list, notes short.
func TestEmbeddedListsValid(t *testing.T) {
	lists, err := Embedded()
	if err != nil {
		t.Fatal(err)
	}
	if len(lists) < 2 {
		t.Fatalf("lists %d", len(lists))
	}
	ids := map[string]bool{}
	for _, l := range lists {
		if ids[l.ID] {
			t.Fatalf("duplicate %s", l.ID)
		}
		ids[l.ID] = true
		if strings.TrimSpace(l.DescriptionRU) == "" || strings.TrimSpace(l.DescriptionEN) == "" {
			t.Errorf("%s: descriptions are required", l.ID)
		}
		for _, it := range l.Items {
			for _, n := range []string{it.NoteRU, it.NoteEN} {
				if utf8.RuneCountInString(n) > 80 {
					t.Errorf("%s: note too long (%d): %s", l.ID, utf8.RuneCountInString(n), n)
				}
			}
		}
	}
	// The constructivism «Рекомендовано Госкино» row reads this list.
	if !ids["soviet-goskino"] {
		t.Fatal("soviet-goskino list missing")
	}
	// Groups come in display order.
	last := -1
	for _, l := range lists {
		i := indexOf(Groups, l.Group)
		if i < last {
			t.Fatalf("group order: %s after a later group", l.ID)
		}
		last = i
	}
}

func indexOf(xs []string, x string) int {
	for i, v := range xs {
		if v == x {
			return i
		}
	}
	return -1
}

func TestParseRejectsBadLists(t *testing.T) {
	good := `{"id":"x","group":"polls","title_ru":"Х","title_en":"X","author":"A","source":"S","description_ru":"д","description_en":"d","ordered":true,
		"items":[{"tmdb_id":1,"kind":"movie","title":"A","original_title":"A","year":1950}]}`
	if _, err := Parse(fstest.MapFS{"x.json": {Data: []byte(good)}}); err != nil {
		t.Fatalf("good list: %v", err)
	}
	cases := map[string]string{
		"group":     strings.Replace(good, `"polls"`, `"misc"`, 1),
		"year":      strings.Replace(good, `1950`, `1750`, 1),
		"kind":      strings.Replace(good, `"movie"`, `"short"`, 1),
		"unknown":   strings.Replace(good, `"ordered":true`, `"ordered":true,"extra":1`, 1),
		"duplicate": strings.Replace(good, `"year":1950}]`, `"year":1950},{"tmdb_id":1,"kind":"movie","title":"B","original_title":"B","year":1951}]`, 1),
		"empty":     strings.Replace(good, `[{"tmdb_id":1,"kind":"movie","title":"A","original_title":"A","year":1950}]`, `[]`, 1),
		"title":     strings.Replace(good, `"title_en":"X"`, `"title_en":""`, 1),
	}
	for name, body := range cases {
		if _, err := Parse(fstest.MapFS{"x.json": {Data: []byte(body)}}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// The file name must match the id.
	if _, err := Parse(fstest.MapFS{"y.json": {Data: []byte(good)}}); err == nil {
		t.Error("file name mismatch accepted")
	}
	// Published ranks (ties allowed) and series are accepted; rank 0 is not.
	ranked := strings.Replace(good, `"year":1950}]`, `"year":1950,"rank":1},{"tmdb_id":2,"kind":"series","title":"B","original_title":"B","year":1984,"rank":1}]`, 1)
	if _, err := Parse(fstest.MapFS{"x.json": {Data: []byte(ranked)}}); err != nil {
		t.Errorf("ranks/series: %v", err)
	}
	if _, err := Parse(fstest.MapFS{"x.json": {Data: []byte(strings.Replace(good, `"year":1950}`, `"year":1950,"rank":0}`, 1))}}); err == nil {
		t.Error("rank 0 accepted")
	}
	// A null tmdb_id is allowed (not on TMDB: resolved by title + year).
	noID := strings.Replace(good, `"tmdb_id":1`, `"tmdb_id":null`, 1)
	if _, err := Parse(fstest.MapFS{"x.json": {Data: []byte(noID)}}); err != nil {
		t.Errorf("null tmdb_id: %v", err)
	}
}

func TestItemKeyChangesWithEntry(t *testing.T) {
	id := 5
	a := Item{TMDBID: &id, Kind: "movie", OriginalTitle: "A", Year: 1950}
	b := a
	b.Year = 1951
	c := a
	c.NoteRU = "заметка" // notes don't need a new lookup
	if a.key() == b.key() || a.key() != c.key() {
		t.Fatalf("keys %q %q %q", a.key(), b.key(), c.key())
	}
}

func TestMatchResult(t *testing.T) {
	y := func(n int) *int { return &n }
	res := []catalog.MediaSummary{
		{ID: "a", Title: "Tokyo Story", OriginalTitle: "東京物語", Year: y(1953)},
		{ID: "b", Title: "Tokyo Story", OriginalTitle: "Tokyo Story", Year: y(2020)},
		{ID: "c", Title: "Mirror", OriginalTitle: "Зеркало", Year: y(1975)},
	}
	if m := MatchResult("Токийская повесть", "東京物語", 1953, res); m == nil || m.ID != "a" {
		t.Fatalf("original title: %v", m)
	}
	// ±1 year; never a far year.
	if m := MatchResult("Зеркало", "Зеркало", 1974, res); m == nil || m.ID != "c" {
		t.Fatalf("year ±1: %v", m)
	}
	if m := MatchResult("Mirror", "Mirror", 1990, res); m != nil {
		t.Fatalf("far year matched %v", m.ID)
	}
	// Two different titles at the same level: ambiguous → nothing.
	amb := append(res, catalog.MediaSummary{ID: "d", Title: "Tokyo Story", OriginalTitle: "Tokyo Story", Year: y(1953)})
	if m := MatchResult("Tokyo Story", "", 1953, amb); m != nil {
		t.Fatalf("ambiguous matched %v", m.ID)
	}
	// Exact year beats ±1.
	near := []catalog.MediaSummary{{ID: "x", Title: "Heat", Year: y(1996)}, {ID: "z", Title: "Heat", Year: y(1995)}}
	if m := MatchResult("Heat", "Heat", 1995, near); m == nil || m.ID != "z" {
		t.Fatalf("exact year: %v", m)
	}
}
