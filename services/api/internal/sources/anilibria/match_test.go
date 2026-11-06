package anilibria

import (
	"encoding/json"
	"os"
	"testing"
)

func loadCands(t *testing.T, files ...string) []candidate {
	t.Helper()
	var out []candidate
	for _, f := range files {
		b, err := os.ReadFile("testdata/" + f)
		if err != nil {
			t.Fatal(err)
		}
		var rs []apiRelease
		if err := json.Unmarshal(b, &rs); err != nil {
			t.Fatal(err)
		}
		for i := range rs {
			out = append(out, newCandidate(&rs[i]))
		}
	}
	return out
}

func TestSplitSeason(t *testing.T) {
	for _, tc := range []struct {
		in   string
		base string
		n    int
	}{
		{"магическая битва", "магическая битва", 1},
		{"магическая битва 2", "магическая битва", 2},
		{"jujutsu kaisen season 2", "jujutsu kaisen", 2},
		{"shingeki no kyojin 2nd season", "shingeki no kyojin", 2},
		{"токийские мстители тв 2", "токийские мстители", 2},
		{"атака титанов 3 сезон", "атака титанов", 3},
		{"overlord iii", "overlord", 3},
		{"mob psycho 100", "mob psycho 100", 1}, // >30: part of the name
		{"86", "86", 1},
	} {
		b, n := splitSeason(tc.in)
		if b != tc.base || n != tc.n {
			t.Errorf("splitSeason(%q) = %q,%d; want %q,%d", tc.in, b, n, tc.base, tc.n)
		}
	}
	if got := norm("Твоё имя: The Movie!"); got != "твое имя" {
		t.Errorf("norm = %q", got)
	}
}

func TestMatchTable(t *testing.T) {
	all := loadCands(t, "search_bitva.json", "search_jujutsu.json", "search_kiminonawa.json")
	for _, tc := range []struct {
		name   string
		movie  bool
		titles []string
		year   int
		season int
		want   int // 0 = no match
	}{
		{"tv season 1", false, []string{"Магическая битва", "Jujutsu Kaisen", "呪術廻戦"}, 2020, 1, 8789},
		{"tv season 1 year ±1", false, []string{"Магическая битва"}, 2021, 1, 8789},
		{"tv season 2 by number", false, []string{"Магическая битва", "Jujutsu Kaisen"}, 2020, 2, 9470},
		{"tv season 3 (english is a subtitle)", false, []string{"Магическая битва", "Jujutsu Kaisen"}, 2020, 3, 10088},
		{"tv season 9 does not exist", false, []string{"Магическая битва"}, 2020, 9, 0},
		{"wrong year", false, []string{"Магическая битва", "Jujutsu Kaisen"}, 2015, 1, 0},
		{"movie", true, []string{"Магическая битва 0", "Jujutsu Kaisen 0"}, 2021, 0, 9313},
		{"movie by english only", true, []string{"", "Kimi no Na wa"}, 2016, 0, 6826},
		{"movie ru with ё", true, []string{"Твоё имя", "Your Name."}, 2016, 0, 6826},
		{"movie wrong year", true, []string{"Твоё имя"}, 2010, 0, 0},
		{"movie title asked as TV", false, []string{"Твоё имя"}, 2016, 1, 0},
		{"TV title asked as movie", true, []string{"Магическая битва"}, 2020, 0, 0},
		{"unrelated title", false, []string{"Битва"}, 2020, 1, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tg := newTarget(tc.movie, tc.titles, tc.year, tc.season)
			c, ok := tg.pick(all)
			got := 0
			if ok {
				got = c.ID
			}
			if got != tc.want {
				t.Fatalf("pick = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestMatchAmbiguousRefuses(t *testing.T) {
	ep := 12
	mk := func(id int, main, en string, year int, typ string) candidate {
		return newCandidate(&apiRelease{ID: id, Type: &apiValue{Value: typ}, Year: year, Name: apiName{Main: main, English: en}, EpisodesTotal: &ep})
	}
	cands := []candidate{
		mk(1, "Хеллсинг", "Hellsing", 2006, "TV"),
		mk(2, "Хеллсинг", "Hellsing Ultimate", 2006, "TV"),
	}
	tg := newTarget(false, []string{"Хеллсинг", "Hellsing"}, 2006, 1)
	if c, ok := tg.pick(cands); ok {
		t.Fatalf("ambiguous pick returned %d", c.ID)
	}
	// An exact year beats ±1 clearly enough? No: 1.0 vs 0.92 is a real gap.
	cands[1] = mk(2, "Хеллсинг", "Hellsing", 2007, "TV")
	if c, ok := tg.pick(cands); !ok || c.ID != 1 {
		t.Fatalf("pick = %v,%v; want 1", c.ID, ok)
	}
	// The same release seen twice (two queries) is not ambiguous.
	cands = []candidate{cands[0], cands[0]}
	if c, ok := tg.pick(cands); !ok || c.ID != 1 {
		t.Fatalf("duplicate pick = %v,%v", c.ID, ok)
	}
	// OVA vs TV of the same name: the TV one wins for a series.
	cands = []candidate{mk(1, "Хеллсинг", "Hellsing", 2006, "TV"), mk(3, "Хеллсинг", "Hellsing", 2006, "OVA")}
	if c, ok := tg.pick(cands); !ok || c.ID != 1 {
		t.Fatalf("tv vs ova pick = %v,%v", c.ID, ok)
	}
}

func TestMatchWordOrder(t *testing.T) {
	ep := 28
	cands := []candidate{
		newCandidate(&apiRelease{ID: 9542, Type: &apiValue{Value: "TV"}, Year: 2023, EpisodesTotal: &ep,
			Name: apiName{Main: "Провожающая в последний путь Фрирен", English: "Sousou no Frieren"}}),
		newCandidate(&apiRelease{ID: 10085, Type: &apiValue{Value: "TV"}, Year: 2026, EpisodesTotal: &ep,
			Name: apiName{Main: "Провожающая в последний путь Фрирен 2", English: "Sousou no Frieren 2nd Season"}}),
	}
	for season, want := range map[int]int{1: 9542, 2: 10085} {
		tg := newTarget(false, []string{"Фрирен, провожающая в последний путь", "Frieren: Beyond Journey's End"}, 2023, season)
		if c, ok := tg.pick(cands); !ok || c.ID != want {
			t.Fatalf("season %d: pick = %d,%v; want %d", season, c.ID, ok, want)
		}
	}
}

func TestChainOrdersSeasons(t *testing.T) {
	all := loadCands(t, "search_bitva.json")
	tg := newTarget(false, []string{"Магическая битва"}, 2020, 1)
	m, ok := tg.pick(all)
	if !ok {
		t.Fatal("no match")
	}
	ids := []int{}
	for _, c := range chain(m, all) {
		ids = append(ids, c.ID)
	}
	want := []int{8789, 9470, 10088}
	if len(ids) != len(want) {
		t.Fatalf("chain = %v", ids)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("chain = %v, want %v", ids, want)
		}
	}
}
