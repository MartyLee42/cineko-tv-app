package releases

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// ---- fixture corpus (testdata/) ----
//
// testdata/corpus/*.json are sanitized results of real Prowlarr searches
// (RuTracker, RuTor, NoNaMe Club, BigFANGroup, ExKinoRay; Oct 2026): title,
// indexer, size, seeders/leechers, standard category ids, imdb id. No links,
// hashes or keys. testdata/scenarios.json pairs a corpus with a requested
// title (TMDB facts as the catalog provides them) and the reviewed decision
// for every corpus entry: indices in "accept" must be accepted, "either" are
// genuinely ambiguous (a parody dub, a fan edit), everything else must be
// rejected.

type corpusRow struct {
	Title      string `json:"title"`
	Indexer    string `json:"indexer"`
	Size       int64  `json:"size"`
	Seeders    int    `json:"seeders"`
	Categories []int  `json:"categories"`
	IMDbID     int    `json:"imdb_id"`
}

type scenario struct {
	Name   string `json:"name"`
	Corpus string `json:"corpus"`
	Target struct {
		Kind             string   `json:"kind"`
		Titles           []string `json:"titles"`
		AltTitles        []string `json:"alt_titles"`
		Year             int      `json:"year"`
		LastYear         int      `json:"last_year"`
		IMDbID           string   `json:"imdb_id"`
		OriginalLanguage string   `json:"original_language"`
		Countries        []string `json:"countries"`
		Season           *int     `json:"season"`
		Episode          *int     `json:"episode"`
		SeasonYear       int      `json:"season_year"`
		SeasonEpisodes   int      `json:"season_episodes"`
		SeasonCount      int      `json:"season_count"`
	} `json:"target"`
	Accept []int `json:"accept"`
	Either []int `json:"either"`
}

func (s *scenario) target() *Target {
	t := s.Target
	return &Target{Kind: t.Kind, Titles: t.Titles, AltTitles: t.AltTitles, Year: t.Year, LastYear: t.LastYear,
		IMDbID: t.IMDbID, OriginalLanguage: t.OriginalLanguage, Countries: t.Countries, Season: t.Season,
		Episode: t.Episode, SeasonYear: t.SeasonYear, SeasonEpisodes: t.SeasonEpisodes, SeasonCount: t.SeasonCount}
}

func loadCorpora(t *testing.T) map[string][]corpusRow {
	t.Helper()
	files, err := filepath.Glob("testdata/corpus/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("no corpus: %v", err)
	}
	out := map[string][]corpusRow{}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var rows []corpusRow
		if err := json.Unmarshal(b, &rows); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		out[strings.TrimSuffix(filepath.Base(f), ".json")] = rows
	}
	return out
}

func loadScenarios(t *testing.T) []scenario {
	t.Helper()
	b, err := os.ReadFile("testdata/scenarios.json")
	if err != nil {
		t.Fatal(err)
	}
	var out []scenario
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestCorpusDecisions asserts the reviewed accept/reject decision for every
// (scenario, release) pair and reports accuracy.
func TestCorpusDecisions(t *testing.T) {
	corpora := loadCorpora(t)
	total, correct, accepted := 0, 0, 0
	for _, sc := range loadScenarios(t) {
		rows := corpora[sc.Corpus]
		tgt := sc.target()
		var wrong []string
		for i, r := range rows {
			if slices.Contains(sc.Either, i) {
				continue
			}
			p := Parse(r.Title)
			m := tgt.Match(&p, r.IMDbID, r.Categories)
			want := slices.Contains(sc.Accept, i)
			total++
			if want {
				accepted++
			}
			if want == !m.Rejected {
				correct++
				continue
			}
			wrong = append(wrong, fmt.Sprintf("  want accept=%v got %.2f %v: %s", want, m.Confidence, m.Reasons, r.Title))
		}
		if len(wrong) > 0 {
			t.Errorf("%s: %d wrong decisions:\n%s", sc.Name, len(wrong), strings.Join(wrong, "\n"))
		}
	}
	t.Logf("corpus: %d decisions (%d accepts), %d correct (%.1f%%)", total, accepted, correct, 100*float64(correct)/float64(total))
	if total < 2000 {
		t.Fatalf("corpus decisions: %d", total)
	}
}

// ---- targeted matching cases ----

func intp(n int) *int { return &n }

var (
	matrix = func() *Target {
		return &Target{Kind: "movie", Titles: []string{"The Matrix", "Матрица", "The Matrix"}, Year: 1999,
			IMDbID: "tt0133093", OriginalLanguage: "en", Countries: []string{"US"}, AltTitles: []string{"The Matrix 1"}}
	}
	reloaded = func() *Target {
		return &Target{Kind: "movie", Titles: []string{"The Matrix Reloaded", "Матрица: Перезагрузка", "The Matrix Reloaded"},
			Year: 2003, OriginalLanguage: "en", AltTitles: []string{"Matrix 2", "The Matrix 2"}}
	}
	avatar = func() *Target {
		return &Target{Kind: "movie", Titles: []string{"Avatar", "Аватар", "Avatar"}, Year: 2009, OriginalLanguage: "en"}
	}
	wayOfWater = func() *Target {
		return &Target{Kind: "movie", Titles: []string{"Avatar: The Way of Water", "Аватар: Путь воды", "Avatar: The Way of Water"},
			Year: 2022, OriginalLanguage: "en", AltTitles: []string{"Avatar 2", "Аватар 2"}}
	}
	brat = func() *Target {
		return &Target{Kind: "movie", Titles: []string{"Брат", "Брат", "Brother"}, Year: 1997, OriginalLanguage: "ru",
			AltTitles: []string{"Brat"}}
	}
	got = func(season, episode int) *Target {
		t := &Target{Kind: "series", Titles: []string{"Game of Thrones", "Игра престолов", "Game of Thrones"}, Year: 2011,
			LastYear: 2019, OriginalLanguage: "en", Countries: []string{"US"}, SeasonCount: 8}
		if season >= 0 {
			t.Season = intp(season)
			t.SeasonYear = 2011 + season - 1
			t.SeasonEpisodes = 10
		}
		if episode > 0 {
			t.Episode = intp(episode)
		}
		return t
	}
	officeUS = func(season int) *Target {
		return &Target{Kind: "series", Titles: []string{"The Office", "Офис", "The Office"}, Year: 2005, LastYear: 2013,
			OriginalLanguage: "en", Countries: []string{"US"}, Season: intp(season), SeasonCount: 9}
	}
	officeUK = func(season int) *Target {
		return &Target{Kind: "series", Titles: []string{"The Office", "Офис", "The Office"}, Year: 2001, LastYear: 2003,
			OriginalLanguage: "en", Countries: []string{"GB"}, Season: intp(season), SeasonCount: 2}
	}
)

func TestMatchCases(t *testing.T) {
	cases := []struct {
		name   string
		target *Target
		title  string
		accept bool
		reason string // expected among reasons (reject reason when !accept)
		pack   *bool
	}{
		{"exact", matrix(), "Матрица / The Matrix (1999) BDRip 1080p | D, P, A", true, "year_match", nil},
		{"scene", matrix(), "The.Matrix.1999.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-FGT", true, "title_exact", nil},
		{"reloaded is a sequel", matrix(), "Матрица: Перезагрузка / The Matrix Reloaded (2003) BDRip 1080p", false, "title_mismatch", nil},
		{"revolutions", matrix(), "Матрица: Революция / The Matrix Revolutions [2003, США, BDRip]", false, "title_mismatch", nil},
		{"resurrections", matrix(), "Матрица: Воскрешение / The Matrix Resurrections (2021) WEB-DL 1080p", false, "title_mismatch", nil},
		{"matrix 4", matrix(), "Матрица 4 / The Matrix 4 (2021) WEB-DL", false, "sequel_mismatch", nil},
		{"wrong year", matrix(), "Матрица / The Matrix (2005) BDRip", false, "year_mismatch", nil},
		{"year off by one", matrix(), "Матрица / The Matrix (2000) BDRip", true, "year_close", nil},
		{"trilogy penalised", matrix(), "Матрица: Трилогия / The Matrix: Trilogy (1999-2003) BDRip 1080p", true, "collection", nil},
		{"comma list includes title", matrix(), "Матрица, Матрица: Перезагрузка, Матрица: Революция / Matrix, The Matrix Reloaded, The Matrix Revolutions [1999-2003, США, BDRip]", true, "collection_includes_title", nil},
		{"soundtrack", matrix(), "OST - Матрица / The Matrix [Soundtrack] (1999) FLAC", false, "not_video", nil},
		{"glitch", matrix(), "Сбой в матрице / A Glitch in the Matrix (2021) WEB-DL", false, "title_mismatch", nil},
		{"imdb mismatch", matrix(), "The Matrix 1999 1080p BluRay", false, "imdb_mismatch", nil},
		{"series-looking", matrix(), "Матрица / The Matrix [S01] (1999) WEB-DL", false, "kind_mismatch", nil},
		{"trilogy for reloaded", reloaded(), "Матрица: Трилогия / The Matrix: Trilogy (1999-2003) BDRip 1080p", true, "collection", nil},
		{"matrix 2 alt", reloaded(), "Матрица 2: Перезагрузка / The Matrix Reloaded [2003, США, WEB-DL 2160p]", true, "year_match", nil},
		{"original for reloaded", reloaded(), "Матрица / The Matrix (1999) BDRip 1080p", false, "", nil},
		{"avatar vs way of water", avatar(), "Аватар: Путь воды / Avatar: The Way of Water (2022) BDRip 1080p", false, "title_mismatch", nil},
		{"way of water vs avatar", wayOfWater(), "Аватар / Avatar (2009) BDRip 1080p", false, "year_mismatch", nil},
		{"avatar 2 alt", wayOfWater(), "Аватар 2 / Avatar 2 (2022) WEB-DL", true, "title_alt", nil},
		{"last airbender", avatar(), "Аватар: Легенда об Аанге / Avatar: The Last Airbender (2005) WEB-DL", false, "title_mismatch", nil},
		{"brat", brat(), "Брат (1997) WEB-DL 720p-New-Team", true, "title_exact", nil},
		{"brat 2", brat(), "Брат 2 (2000) WEB-DL-AVC-ExKinoRay", false, "sequel_mismatch", nil},
		{"brat dilogy", brat(), "Брат и Брат 2 (1997, 2000) WEB-DL (H.264/1080p) [Дилогия]", true, "collection_includes_title", nil},
		{"o brother", brat(), "О, где же ты, брат? / O, Brother, Where Art Thou? (2000) BDRemux 1080p", false, "title_mismatch", nil},
		{"pack contains episode", got(1, 3), "Игра престолов / Game of Thrones [S01] (2011) BDRip 1080p", true, "season_pack", bp(true)},
		{"episode range contains", got(1, 3), "Игра престолов / Game of Thrones / S1E1-10 of 10 [2011, США, BDRip]", true, "episode_in_pack", bp(true)},
		{"single episode", got(1, 3), "Game.of.Thrones.S01E03.1080p.BluRay.x264-GRP", true, "episode_match", bp(false)},
		{"wrong episode", got(1, 3), "Game.of.Thrones.S01E04.1080p.BluRay.x264-GRP", false, "episode_mismatch", nil},
		{"partial pack", got(1, 3), "Игра Престолов / Games of Thrones / S1E1-2 of 10 (2011) BDRip", false, "episode_mismatch", nil},
		{"wrong season", got(1, 3), "Игра престолов / Game of Thrones [S02] (2012) BDRip 1080p", false, "season_mismatch", nil},
		{"complete series", got(2, 5), "Игра престолов / Game of Thrones [S01-08] (2011-2019) BDRip 1080p", true, "multi_season_pack", bp(true)},
		{"whole show as S1", got(5, 0), "Игра престолов / Game of Thrones / S1E1-73 of 73 [2011-2019, США, BDRip 1080p]", true, "complete_series", bp(true)},
		{"last watch documentary", got(8, 0), "Игра престолов: Последний дозор / Game of Thrones: The Last Watch (2019) BDRip", false, "title_mismatch", nil},
		{"real war of thrones", got(1, 3), "Настоящая война / игра престолов (3 S01-06 серии из 06) / The Real War of Thrones [2019, Документальный]", false, "other_title_mismatch", nil},
		{"parody", got(-1, 0), "Игрища престолов / Purge of Kingdoms: The Unauthorized Game of Thrones Parody (2019) WEB-DL", false, "title_mismatch", nil},
		{"office us vs uk by year", officeUS(2), "Офис / The Office [S02] (2002-2003) DVDRip-AVC | Ozz", false, "year_mismatch", nil},
		{"office us", officeUS(2), "Офис / The Office / S2E1-22 of 22 [2005-2006, США, Комедия, WEB-DL 1080p]", true, "season_match", nil},
		{"office uk marker", officeUS(1), "Офис / The Office (UK) (2001-2003) DVDRip (S1-3E1-14 of 14)", false, "version_mismatch", nil},
		{"office uk", officeUK(1), "Офис / The Office [S01] (2001) DVDRip-AVC | Ozz", true, "season_pack", nil},
		{"office uk vs us", officeUK(1), "Офис / The Office / S1E1-6 of 6 [2005, США, Комедия, WEB-DL 1080p]", false, "year_mismatch", nil},
		{"us marker on uk", officeUK(1), "Офис / The Office [S01] (2005) WEB-DL | D | американская версия / US", false, "version_mismatch", nil},
		{"series without season info", got(1, 3), "Игра престолов / Game of Thrones (2011) WEB-DL 1080p", false, "season_unknown", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := Parse(c.title)
			imdb := 0
			if c.name == "imdb mismatch" {
				imdb = 234215
			}
			m := c.target.Match(&p, imdb, nil)
			if m.Rejected == c.accept {
				t.Fatalf("accept=%v want %v (%.2f %v)", !m.Rejected, c.accept, m.Confidence, m.Reasons)
			}
			if c.reason != "" && !slices.Contains(m.Reasons, c.reason) {
				t.Errorf("reasons %v lack %q", m.Reasons, c.reason)
			}
			if c.pack != nil && m.IsPack != *c.pack {
				t.Errorf("pack = %v, want %v", m.IsPack, *c.pack)
			}
			if c.accept && (m.Confidence < MinConfidence || m.Confidence > 1) {
				t.Errorf("confidence %.2f", m.Confidence)
			}
		})
	}
}

func TestIMDbMatchBoosts(t *testing.T) {
	p := Parse("The.Matrix.1080p.BluRay.x264-GRP") // no year
	m := matrix().Match(&p, 133093, nil)
	if m.Rejected || !slices.Contains(m.Reasons, "imdb_match") || m.Confidence < 0.95 {
		t.Fatalf("got %+v", m)
	}
}

func TestConfidenceOrdering(t *testing.T) {
	tg := matrix()
	conf := func(title string) float64 {
		p := Parse(title)
		return tg.Match(&p, 0, nil).Confidence
	}
	exact := conf("Матрица / The Matrix (1999) BDRip 1080p")
	noYear := conf("Матрица / The Matrix BDRip 1080p")
	coll := conf("Матрица: Трилогия / The Matrix: Trilogy (1999-2003) BDRip 1080p")
	if !(exact > noYear && noYear > coll && coll >= MinConfidence) {
		t.Fatalf("exact %.2f, no year %.2f, collection %.2f", exact, noYear, coll)
	}
}
