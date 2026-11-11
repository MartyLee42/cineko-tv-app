package releases

import (
	"slices"
	"testing"
)

// pt is one parser expectation; zero fields are not checked unless listed
// in the check flags below.
type pt struct {
	in       string
	titles   []string
	years    []int
	res      string
	codec    string
	hdr      string
	source   string
	audio    []string
	langs    []string // must all be present
	group    string
	seasons  []int
	episodes [2]int // first, last (0 = no episodes expected when checkEp)
	checkEp  bool
	total    int
	pack     *bool
	coll     bool
	nonVideo bool
	extras   bool
	disc     bool
	country  string
}

func bp(b bool) *bool { return &b }

var parseCases = []pt{
	// ---- spec examples ----
	{in: "Матрица / The Matrix (1999) BDRip 1080p | D, P, A", titles: []string{"Матрица", "The Matrix"}, years: []int{1999},
		res: "1080p", source: "bdrip", langs: []string{"ru"}, checkEp: true},
	{in: "Игра престолов / Game of Thrones [S01] (2011) WEB-DL 1080p | LostFilm", titles: []string{"Игра престолов", "Game of Thrones"},
		years: []int{2011}, res: "1080p", source: "web-dl", langs: []string{"ru"}, seasons: []int{1}, checkEp: true, pack: bp(true)},
	{in: "Тед Лассо (Сезон 1-3, серии 1-34 из 34) [2020-2023, WEB-DL 2160p] Dub", titles: []string{"Тед Лассо"},
		years: []int{2020, 2023}, res: "2160p", source: "web-dl", langs: []string{"ru"}, seasons: []int{1, 2, 3},
		episodes: [2]int{1, 34}, checkEp: true, total: 34, pack: bp(true)},
	{in: "The.Matrix.1999.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-FGT", titles: []string{"The Matrix"}, years: []int{1999},
		res: "2160p", codec: "hevc", hdr: "hdr10", source: "remux", group: "FGT", langs: []string{"orig"}},
	{in: "Сериал / Show [S01E01-08 из 10] (2024) WEB-DL 1080p", titles: []string{"Сериал", "Show"}, seasons: []int{1},
		episodes: [2]int{1, 8}, checkEp: true, total: 10, pack: bp(true)},
	{in: "Show.Name.1x05.720p.HDTV.x264-GRP", titles: []string{"Show Name"}, seasons: []int{1}, episodes: [2]int{5, 5},
		checkEp: true, res: "720p", source: "hdtv", codec: "h264", group: "GRP", pack: bp(false)},

	// ---- RuTor ----
	{in: "Матрица / The Matrix (1999) UHD BDRip 2160p | 4K | HDR | D, P2, A", res: "2160p", source: "bdrip", hdr: "hdr10", langs: []string{"ru"}},
	{in: "Матрица / The Matrix (1999) UHD Blu-ray 2160p | 4K | HDR | Remastered | D", source: "bluray", disc: true, res: "2160p"},
	{in: "Матрица: Трилогия / The Matrix: Trilogy (1999-2003) HD-DVDRip-HEVC 1080p от RIPS CLUB | D, P, P2, A, L2, L1",
		titles: []string{"Матрица: Трилогия", "The Matrix: Trilogy"}, years: []int{1999, 2003}, coll: true, codec: "hevc",
		res: "1080p", source: "bdrip", group: "RIPS CLUB"},
	{in: "Матрица / The Matrix (1999) UHD BDRemux 2160p от ExKinoRay | 4K | HDR | Dolby Vision-Лицензия", source: "remux",
		hdr: "dolby_vision", group: "ExKinoRay", langs: []string{"ru"}},
	{in: "Матрица. Трилогия / The Matrix: Trilogy (1999-2003) 3хDVD9", source: "dvd", disc: true, coll: true},
	{in: "Игра престолов / Game of Thrones [S01-08] (2011-2019) BDRip 1080p от Generalfilm | D | P", seasons: []int{1, 2, 3, 4, 5, 6, 7, 8},
		checkEp: true, group: "Generalfilm", pack: bp(true)},
	{in: "Игра престолов / Game of Thrones [s03] (2013) BDRip 720p | Рен ТВ", seasons: []int{3}, res: "720p", langs: []string{"ru"}},
	{in: "Игра престолов / Гра Престолів / Game of Thrones [S01-08] (2011-2019) BDRip-AVC | D, P | UKR",
		titles: []string{"Игра престолов", "Гра Престолів", "Game of Thrones"}, codec: "h264", langs: []string{"ru", "uk"}},
	{in: "Игра престолов / Game of Thrones [S07] (2017) 4xDVD5-Amedia", source: "dvd", disc: true, seasons: []int{7}},
	{in: "Игра престолов / Game of Thrones [S07] (2017) BDRemux 1080р | Amedia, LostFilm", res: "1080p", source: "remux"},
	{in: "Офис / The Office [08х01-18] (2011-2012) WEB-DL 720p | Gravi-TV", seasons: []int{8}, episodes: [2]int{1, 18}, checkEp: true},
	{in: "Офис / The Office [07x01-12] (2010) HDTV", seasons: []int{7}, episodes: [2]int{1, 12}, checkEp: true, source: "hdtv"},
	{in: "Офис / The Office [S01] (2005) WEB-DL | D | американская версия / US", country: "us", seasons: []int{1}},
	{in: "OST - Игра престолов / Game of Thrones: Collection (2011-2019) FLAC", nonVideo: true},
	{in: "Ramin Djawadi & Geek Music - The Best Of Game Of Thrones Vol.1 (2020) FLAC", nonVideo: true},
	{in: "Слово пацана. Кровь на асфальте. Фильм о фильме (2024) WEB-DL 1080p", extras: true},
	{in: "Слово пацана. Кровь на асфальте [S01] (2023) WEBRip 2160p | 4K | SDR", titles: []string{"Слово пацана. Кровь на асфальте"},
		seasons: []int{1}, res: "2160p", source: "webrip", hdr: ""},
	{in: "Аватар / Avatar (2009) AC3 5.1 [Solod] [Extended Collector's Cut]", nonVideo: true, audio: []string{"ac3"}},
	{in: "Брат (1997) WEB-DL 720p-New-Team", titles: []string{"Брат"}, years: []int{1997}, res: "720p", source: "web-dl", langs: []string{"ru"}},
	{in: "Брат и Брат 2 (Дилогия) (1997, 2000) WEBRip [H.265/2160p] [4K, SDR , 10-bit]", years: []int{1997, 2000}, coll: true, codec: "hevc"},
	{in: "Игра престолов / Game of Thrones [S06] (2016) 5xDVD5-Amedia", source: "dvd", disc: true},

	// ---- RuTracker ----
	{in: "Матрица / The Matrix [1999, США, фантастика, BDRemux 1080p] [Remastered] Dub + 3х MVO + 3х DVO + 8х AVO + VO + Original (Eng) + )",
		titles: []string{"Матрица", "The Matrix"}, years: []int{1999}, source: "remux", res: "1080p", langs: []string{"ru", "en"}},
	{in: "Матрица / The Matrix [1999, США, фантастика, боевик, UHD BR-DISK 2160p] [EUR] Dub + Original Eng", source: "bluray", disc: true, res: "2160p"},
	{in: "Матрица / The Matrix [1999, США, фантастика, боевик, Blu-Ray > DVD5 (Custom)] Dub + Original Eng + rus, eng", source: "dvd", disc: true},
	{in: "Матрица: Трилогия / The Matrix: Trilogy [1999, 2003, США, фантастика боевик, HDDVDRip-AVC] Dub + Original (Eng) + )",
		years: []int{1999, 2003}, coll: true, codec: "h264", source: "bdrip"},
	{in: "Матрица, Матрица: Перезагрузка, Матрица: Революция / Matrix, The Matrix Reloaded, The Matrix Revolutions [1999-2003, США, Австралия, фантастика, боевик, BDRip]",
		years: []int{1999, 2003}},
	{in: "Игра престолов / Game of Thrones / S8E1-6 of 6 [2019, США, Великобритания, фэнтези, драма, мелодрама, BDRemux 1080p] Dub + 8x MVO + Ukr",
		titles: []string{"Игра престолов", "Game of Thrones"}, seasons: []int{8}, episodes: [2]int{1, 6}, checkEp: true, total: 6, langs: []string{"ru", "uk"}},
	{in: "Игра престолов / Game of Thrones / Сезоны: 1-8 из 8 / E1-73 of 73 [2011-2019, США, Великобритания, фэнтези]",
		seasons: []int{1, 2, 3, 4, 5, 6, 7, 8}, episodes: [2]int{1, 73}, checkEp: true, total: 73},
	{in: "Игра престолов / Game of Thrones / Сезон 8, серии 1-6 из 6 (Дэвид Наттер / David Nutter) [2019, США, BDRip 1080p]",
		titles: []string{"Игра престолов", "Game of Thrones"}, seasons: []int{8}, episodes: [2]int{1, 6}, checkEp: true},
	{in: "Офис / The Office (UK) / S2E1-6 of 6 (Ricky Gervais, Stephen Merchant) [2002, Великобритания, Комедия, DVDRip]",
		country: "gb", seasons: []int{2}, years: []int{2002}},
	{in: "Деловое предложение / Офисное свидание вслепую / A Business Proposal / Sanae Matseon / The Office Blind Date / S1 / 1- 12 из 12 [2022, Южная Корея, WEB-DL]",
		seasons: []int{1}, episodes: [2]int{1, 12}, checkEp: true, total: 12},
	{in: "[Nintendo Switch] Reigns Kings and Queens / Her Majesty / Game of Thrones / Three Kingdoms / Beyond [NSZ][ENG,RUS]", nonVideo: true},
	{in: "[DL] Game of Thrones - A Telltale Games Series [L] [ENG / ENG] (2014, Adventure) (s106) [GOG]", nonVideo: true},
	{in: "Игра Престолов: Дополнительные материалы [1-8 Сезоны] / Game of Thrones: Extras [1-8 Seasons] [2011-2019, документальный, BDRip 1080p]", extras: true},
	{in: "Слово пацана. Кровь на асфальте / S1E8-я / [2023, Драма, DVDRip]", seasons: []int{1}, episodes: [2]int{8, 8}, checkEp: true},

	// ---- NoNaMe Club ----
	{in: "Матрица / The Matrix (1999) UHD BDRip [H.265/2160p] [4K, HDR10, DV 8.1, 10-bit] [handmade AI]", codec: "hevc", res: "2160p",
		hdr: "dolby_vision", source: "bdrip"},
	{in: "Матрица / The Matrix (1999) BDRip [AV1/2160p] [4K, SDR, 10-bit] [Handmade Upscale AI]", codec: "av1", hdr: ""},
	{in: "Матрица / The Matrix (1999 - 2021) BDRemux [VC-1/H.264/1080p] [Коллекция]", years: []int{1999, 2021}, coll: true, codec: "h264"},
	{in: "Офис / The Office  / S2E1-22 of 22 (2005-2006) WEB-DL [H.264/1080p]  Kubik & Ko, Kravec", titles: []string{"Офис", "The Office"},
		seasons: []int{2}, episodes: [2]int{1, 22}, checkEp: true, years: []int{2005, 2006}, langs: []string{"ru"}},
	{in: "Офис / The Office (2005-2013) WEB-DL [H.264/720p] (S1-9E1-204 of 204) Kubik & Ko, Kravec",
		seasons: []int{1, 2, 3, 4, 5, 6, 7, 8, 9}, episodes: [2]int{1, 204}, checkEp: true},
	{in: "Офис - S4 (полный) / The Office - Season 4 (2007) HDTV", titles: []string{"Офис", "The Office"}, seasons: []int{4}},
	{in: "The Matrix OST (1999) [FLAC|Lossless|tracks] <Soundtrack>", nonVideo: true},
	{in: "Слово пацана. Кровь на асфальте /E1-8 of 8 (2023) WEB-DL 1080p", titles: []string{"Слово пацана. Кровь на асфальте"},
		episodes: [2]int{1, 8}, checkEp: true, total: 8},

	// ---- BigFANGroup ----
	{in: "Игра престолов / Game of Thrones, S1-8E1-73 of 73 (2011-2019) BDRip-AVC", titles: []string{"Игра престолов", "Game of Thrones"},
		seasons: []int{1, 2, 3, 4, 5, 6, 7, 8}, episodes: [2]int{1, 73}, checkEp: true, codec: "h264"},
	{in: "Офис / The Office, S2E1-22 of 22 (2005) DVDRip", titles: []string{"Офис", "The Office"}, seasons: []int{2}, source: "dvd"},
	{in: "Game of Thrones - A Telltale Games Series. Episode 1-6 (2014) PC | RePack от R.G. Механики", nonVideo: true},

	// ---- ExKinoRay ----
	{in: "Игра престолов (S8E1-6 of 6) | Game of Thrones | 2019 | 4K, HEVC, HDR | Blu-Ray Remux (2160p) | Dub (Лицензия)",
		titles: []string{"Игра престолов", "Game of Thrones"}, years: []int{2019}, seasons: []int{8}, source: "remux", res: "2160p", codec: "hevc"},
	{in: "Матрица | The Matrix | 1999 | Open Matte | WEB-DL (AVC) | Dub - ExKinoRay", titles: []string{"Матрица", "The Matrix"},
		years: []int{1999}, codec: "h264", group: "ExKinoRay", langs: []string{"ru"}},
	{in: "Windows Office | Ru | Офис | 2020 | PC (Windows) - RePack", nonVideo: true},

	// ---- anime / misc ----
	{in: "Shingeki no Kyojin / Attack on Titan / Атака титанов / Вторжение титанов [TV-1] [2013, TV, 25 эп.] BDRip 1080p",
		seasons: []int{1}, episodes: [2]int{1, 25}, checkEp: true},
	{in: "Shingeki no Kyojin | Attack on Titan | Атака титанов [ТВ-1] [2013, TV, 25 из 25] BDRip 1080p 10-bit", seasons: []int{1}, total: 25},
	{in: "Shingeki no Kyojin OVA | Атака титанов OVA [2013-2018, OVA, 8 из 8] WEBRip 1080p HEVC 10-bit raw+rus", seasons: []int{0}},
	{in: "Sen to Chihiro no Kamikakushi / Spirited Away / Унесённые призраками [2001, MV] BDrip 1080p Hi10bit",
		titles: []string{"Sen to Chihiro no Kamikakushi", "Spirited Away", "Унесённые призраками"}, years: []int{2001}},
	{in: "Blade.Runner.2049.2017.1080p.BluRay.x264-SPARKS", titles: []string{"Blade Runner 2049"}, years: []int{2017}, source: "bdrip", codec: "h264"},
	{in: "1917.2019.2160p.WEB-DL.DDP5.1.HDR.HEVC-GRP", titles: []string{"1917"}, years: []int{2019}, audio: []string{"eac3"}, hdr: "hdr10"},
	{in: "Some.Movie.2023.HDCAM.x264-ABC", source: "cam"},
	{in: "Фильм / Movie (2024) TS 1080p | Звук с TS", source: "telesync"},
	{in: "Movie (2022) BDRip 1080p | DTS-HD MA, TrueHD Atmos, AC3", audio: []string{"truehd", "dts", "ac3"}},
	{in: "Аватар 3D / Avatar 3D (2009) BDRip [H.264/1080p] [Half OU]", titles: []string{"Аватар", "Avatar"}},
}

func TestParse(t *testing.T) {
	for _, c := range parseCases {
		t.Run(c.in, func(t *testing.T) {
			p := Parse(c.in)
			if c.titles != nil && !slices.Equal(p.Titles, c.titles) {
				t.Errorf("titles = %q, want %q", p.Titles, c.titles)
			}
			if c.years != nil && !slices.Equal(p.Years, c.years) {
				t.Errorf("years = %v, want %v", p.Years, c.years)
			}
			check := func(name, got, want string) {
				if want != "" && got != want {
					t.Errorf("%s = %q, want %q", name, got, want)
				}
			}
			check("resolution", p.Resolution, c.res)
			check("codec", p.VideoCodec, c.codec)
			check("source", p.Source, c.source)
			check("group", p.ReleaseGroup, c.group)
			check("country", p.Country, c.country)
			if c.hdr != "" || (c.hdr == "" && c.codec == "av1") {
				check("hdr", p.HDR, c.hdr)
			}
			for _, a := range c.audio {
				if !slices.Contains(p.AudioCodecs, a) {
					t.Errorf("audio %v lacks %q", p.AudioCodecs, a)
				}
			}
			for _, l := range c.langs {
				if !slices.Contains(p.Languages, l) {
					t.Errorf("languages %v lack %q", p.Languages, l)
				}
			}
			if c.seasons != nil && !slices.Equal(p.Seasons, c.seasons) {
				t.Errorf("seasons = %v, want %v", p.Seasons, c.seasons)
			}
			if c.checkEp {
				var got [2]int
				if len(p.Episodes) > 0 {
					got = [2]int{p.Episodes[0], p.Episodes[len(p.Episodes)-1]}
				}
				if got != c.episodes {
					t.Errorf("episodes = %v, want %v", got, c.episodes)
				}
			}
			if c.total != 0 && p.EpisodeTotal != c.total {
				t.Errorf("episode total = %d, want %d", p.EpisodeTotal, c.total)
			}
			if c.pack != nil && p.IsPack() != *c.pack {
				t.Errorf("pack = %v, want %v", p.IsPack(), *c.pack)
			}
			if p.Collection != c.coll && (c.coll || c.titles != nil) {
				t.Errorf("collection = %v, want %v", p.Collection, c.coll)
			}
			if p.NonVideo != c.nonVideo {
				t.Errorf("non-video = %v, want %v", p.NonVideo, c.nonVideo)
			}
			if p.Extras != c.extras {
				t.Errorf("extras = %v, want %v", p.Extras, c.extras)
			}
			if c.disc && !p.DiscImage {
				t.Errorf("disc image not detected")
			}
		})
	}
	if len(parseCases) < 50 {
		t.Fatalf("only %d parser cases", len(parseCases))
	}
}

// TestParseCorpus runs the parser over every title of the real-search
// fixture corpus: no panics, and every video release yields a title.
func TestParseCorpus(t *testing.T) {
	n := 0
	for _, rows := range loadCorpora(t) {
		for _, r := range rows {
			p := Parse(r.Title)
			n++
			if !p.NonVideo && len(p.Titles) == 0 {
				t.Errorf("no title candidates for %q", r.Title)
			}
		}
	}
	if n < 1000 {
		t.Fatalf("corpus too small: %d titles", n)
	}
}

// Russian subtitles are not Russian audio.
func TestSubtitlesAreNotAudio(t *testing.T) {
	for _, c := range []struct {
		in string
		ru bool
	}{
		{"Последний детектив / The Last Detective / Сезон: 1 / Серии: 1-4 из 4 (Дэвид Такер) [2003, Великобритания, драма, DVDRip-AVC] Original + Rus Sub", false},
		{"Последний детектив / The Last Detective / S1E1-4 of 4 [2003, Великобритания, драма, комедия, DVDRip-AVC] Original + Rus", false},
		{"Фильм / Film [2010, США, драма, BDRip 1080p] Original Eng + Sub (Rus, Eng)", false},
		{"Фильм / Film [2010, США, драма, BDRip 1080p] Original + Sub(rus,eng)", false},
		// A Russian voice is named: Russian audio.
		{"Фильм / Film [2010, США, драма, BDRip 1080p] Dub + Original + Sub (Rus, Eng)", true},
		{"Фильм / Film [2010, США, драма, HDRip, 576p] Dub + Original + rus Sub", true},
		{"Фильм / Film [2010, США, драма, BDRip 1080p] MVO (LostFilm) + Original + Sub Rus", true},
		{"Фильм / Film [2010, США, драма, BDRip 1080p] Original + MVO (Jaskier) + Sub Rus", true},
		// The voice was left out of the title ("+ Original Eng"), or a Russian film: as before.
		{"Фильм / Film [2010, США, драма, BDRip 1080p] + Original Eng + Sub Rus", true},
		{"Слово пацана. Кровь на асфальте [2023, драма, WEBRip 2160p] + Sub (Rus)", true},
		{"Матрица / The Matrix (1999) BDRip 1080p | D, P2, A | Original + Sub", true},
	} {
		p := Parse(c.in)
		if got := slices.Contains(p.Languages, "ru"); got != c.ru {
			t.Errorf("%q: Russian audio = %v (languages %v), want %v", c.in, got, p.Languages, c.ru)
		}
	}
}
