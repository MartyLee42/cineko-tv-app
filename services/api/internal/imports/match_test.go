package imports

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"martytv/api/internal/catalog"
)

// fakeCatalog answers searches from a fixed list: a query matches a title
// whose Russian or original name equals it (normalized), like TMDB's
// search does for exact names. SearchYear filters by year.
type fakeCatalog struct {
	titles []catalog.MediaSummary
	// total pretends the plain search has more pages than it returns.
	total   int
	pageCap int
	fail    bool
	calls   []string
}

func title(id, kind, ru, orig string, year, votes int) catalog.MediaSummary {
	y := year
	return catalog.MediaSummary{ID: id, Kind: kind, Title: ru, OriginalTitle: orig, Year: &y, VoteCount: votes}
}

func (f *fakeCatalog) find(query, kind string, year int) []catalog.MediaSummary {
	var out []catalog.MediaSummary
	for _, t := range f.titles {
		if t.Kind != kind || (normalize(t.Title) != normalize(query) && normalize(t.OriginalTitle) != normalize(query)) {
			continue
		}
		if year != 0 && *t.Year != year {
			continue
		}
		out = append(out, t)
	}
	return out
}

func (f *fakeCatalog) Search(_ context.Context, query, kind, _ string, _ int) (*catalog.MediaPage, error) {
	f.calls = append(f.calls, fmt.Sprintf("search %s %s", kind, query))
	if f.fail {
		return nil, errors.New("tmdb down")
	}
	items := f.find(query, kind, 0)
	total := len(items)
	if f.pageCap > 0 && len(items) > f.pageCap {
		items = items[:f.pageCap]
	}
	if f.total > total {
		total = f.total
	}
	return &catalog.MediaPage{Items: items, Page: 1, TotalResults: total}, nil
}

func (f *fakeCatalog) SearchYear(_ context.Context, query, kind, _ string, year int) (*catalog.MediaPage, error) {
	f.calls = append(f.calls, fmt.Sprintf("year %s %s %d", kind, query, year))
	items := f.find(query, kind, year)
	return &catalog.MediaPage{Items: items, Page: 1, TotalResults: len(items)}, nil
}

func row(kind, ru, orig string, year int) Row {
	return Row{KPID: 1, Type: kind, TitleRU: ru, TitleOriginal: orig, Year: year, MyRating: 7}
}

func TestMatchRules(t *testing.T) {
	ctx := context.Background()
	cat := &fakeCatalog{titles: []catalog.MediaSummary{
		title("heat95", "movie", "Схватка", "Heat", 1995, 9000),
		title("heat86", "movie", "Жара", "Heat", 1986, 200),
		title("late", "movie", "Поздний", "Late Release", 2001, 50),
		title("ru-only", "movie", "Брат", "Брат", 1997, 3000),
		title("twin-a", "movie", "Близнец", "Twin", 2010, 100),
		title("twin-b", "movie", "Близнец", "Twin", 2010, 90),
		title("show", "series", "Шоу", "The Show", 2013, 400),
		title("show-film", "movie", "Шоу", "The Show", 2013, 400),
		title("dup-big", "movie", "Дубль", "Double", 2020, 5000),
		title("dup-small", "movie", "Дубль", "Double", 2020, 3),
	}}
	cases := []struct {
		name   string
		row    Row
		id     string
		how    string
		reason string
	}{
		{"exact original title + year", row("film", "Схватка", "Heat", 1995), "heat95", "exact", ""},
		{"year ±1", row("film", "Поздний", "Late Release", 2000), "late", "year_pm1", ""},
		{"beyond ±1 is not found", row("film", "Поздний", "Late Release", 1998), "", "", ReasonNotFound},
		{"empty original: Russian title", row("film", "Брат", "", 1997), "ru-only", "exact", ""},
		{"Russian fallback after an original miss", row("film", "Схватка", "Heat (Director's cut)", 1995), "heat95", "exact", ""},
		{"ambiguous namesakes", row("film", "Близнец", "Twin", 2010), "", "", ReasonAmbiguous},
		{"series searched as tv", row("series", "Шоу", "The Show", 2013), "show", "exact", ""},
		{"film searched as movie", row("film", "Шоу", "The Show", 2013), "show-film", "exact", ""},
		{"unknown type: both kinds → ambiguous", row("anime", "Шоу", "The Show", 2013), "", "", ReasonAmbiguous},
		{"dominant duplicate wins", row("film", "Дубль", "Double", 2020), "dup-big", "exact", ""},
		{"nothing", row("film", "Нет", "Nothing", 2000), "", "", ReasonNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, reason, err := matchTMDB(ctx, cat, tc.row)
			if err != nil {
				t.Fatal(err)
			}
			if tc.id == "" {
				if m != nil || reason != tc.reason {
					t.Fatalf("want %s, got %+v %q", tc.reason, m, reason)
				}
				return
			}
			if m == nil || m.MediaID != tc.id || m.How != tc.how {
				t.Fatalf("want %s/%s, got %+v %q", tc.id, tc.how, m, reason)
			}
		})
	}
}

func TestMatchNarrowsByYear(t *testing.T) {
	// The plain search's page holds only the famous namesake; the year
	// search finds the right one.
	cat := &fakeCatalog{pageCap: 1, total: 40, titles: []catalog.MediaSummary{
		title("famous", "movie", "Дом", "Home", 2015, 9000),
		title("old", "movie", "Дом", "Home", 1960, 10),
	}}
	m, _, err := matchTMDB(context.Background(), cat, row("film", "Дом", "Home", 1960))
	if err != nil || m == nil || m.MediaID != "old" {
		t.Fatalf("%+v %v (calls %v)", m, err, cat.calls)
	}
}

func TestMatchSkipsRussianQueryOnExactHit(t *testing.T) {
	cat := &fakeCatalog{titles: []catalog.MediaSummary{title("heat95", "movie", "Схватка", "Heat", 1995, 9000)}}
	if _, _, err := matchTMDB(context.Background(), cat, row("film", "Схватка", "Heat", 1995)); err != nil {
		t.Fatal(err)
	}
	if len(cat.calls) != 1 {
		t.Fatalf("calls %v", cat.calls)
	}
}

func TestMatchTMDBDown(t *testing.T) {
	cat := &fakeCatalog{fail: true}
	if _, _, err := matchTMDB(context.Background(), cat, row("film", "Схватка", "Heat", 1995)); err == nil {
		t.Fatal("want error")
	}
}

func TestPickTiers(t *testing.T) {
	w := wanted{names: titleSet("Spirited Away", "Унесённые призраками"), titles: []string{"Spirited Away", "Унесённые призраками"}}
	only := []catalog.MediaSummary{title("chihiro", "movie", "Унесенные призраками!", "千と千尋の神隠し", 2001, 16000)}
	if d := pick(only, 2001, w); d.match == nil || d.match.How != "exact" {
		t.Fatalf("ё/punctuation folding: %+v", d)
	}
	if d := pick(only, 2003, w); d.match == nil || d.match.How != "year_pm2" {
		t.Fatalf("unique title two years off: %+v", d)
	}
	two := append(only, title("chihiro2", "movie", "Унесённые призраками", "Spirited Away", 1999, 10))
	if d := pick(two, 2001, w); d.match == nil || d.match.MediaID != "chihiro" {
		t.Fatalf("exact beats ±2: %+v", d)
	}
	if d := pick(two, 2000, w); d.match == nil || d.match.MediaID != "chihiro" || d.match.How != "year_pm1" {
		t.Fatalf("two titles one year off: the far more voted one wins: %+v", d)
	}

	// year_only needs shared words; inflected Russian words count.
	sw := wanted{names: titleSet("Шерлок Холмс и доктор Ватсон: Смертельная схватка"), titles: []string{"Шерлок Холмс и доктор Ватсон: Смертельная схватка"}}
	longer := []catalog.MediaSummary{title("sh", "movie", "Приключения Шерлока Холмса и доктора Ватсона: Смертельная схватка", "x", 1980, 50)}
	if d := pick(longer, 1980, sw); d.match == nil || d.match.How != "year_only" {
		t.Fatalf("inflected overlap: %+v", d)
	}
	fw := wanted{names: titleSet("Форсаж да Винчи"), titles: []string{"Форсаж да Винчи"}}
	unrelated := []catalog.MediaSummary{title("tr", "movie", "Охотники за сокровищами", "Treasure Raiders", 2007, 40)}
	if d := pick(unrelated, 2007, fw); d.match != nil || d.ambiguous || d.tier != 0 {
		t.Fatalf("no shared words must not match: %+v", d)
	}
	vw := wanted{names: titleSet("Вий 3D"), titles: []string{"Вий 3D"}}
	viy := []catalog.MediaSummary{title("viy", "movie", "Вий", "Вий", 2014, 400), title("viy2", "movie", "Вий 2", "Вий 2", 2015, 300)}
	if d := pick(viy, 2014, vw); d.match != nil || !d.ambiguous {
		t.Fatalf("a similar title a year off makes year_only unsafe: %+v", d)
	}
}

func TestMatchOtherKindFallback(t *testing.T) {
	// Kinopoisk calls it a film; TMDB has it as a series.
	cat := &fakeCatalog{titles: []catalog.MediaSummary{title("mb", "series", "Разрушители легенд", "MythBusters", 2003, 900)}}
	m, _, err := matchTMDB(context.Background(), cat, row("film", "Разрушители легенд", "MythBusters", 2003))
	if err != nil || m == nil || m.MediaID != "mb" {
		t.Fatalf("%+v %v", m, err)
	}
	// Only exact title + year counts across kinds.
	m, reason, _ := matchTMDB(context.Background(), cat, row("film", "Разрушители легенд", "MythBusters", 2004))
	if m != nil || reason != ReasonNotFound {
		t.Fatalf("%+v %s", m, reason)
	}
}
