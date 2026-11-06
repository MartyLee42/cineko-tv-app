package playback

import (
	"fmt"
	"testing"
)

// files builds a TorrServer file list: alternating path, size in MB.
func files(spec ...any) []fileStat {
	var out []fileStat
	for i := 0; i+1 < len(spec); i += 2 {
		out = append(out, fileStat{ID: len(out) + 1, Path: spec[i].(string), Length: int64(spec[i+1].(int)) << 20})
	}
	return out
}

func episodeRange(prefix string, from, to int, format string, size int) []any {
	var out []any
	for e := from; e <= to; e++ {
		out = append(out, prefix+fmt.Sprintf(format, e), size)
	}
	return out
}

func movie() target      { return target{} }
func ep(s, e int) target { return target{Episode: true, Season: s, Number: e} }

func TestSelectFile(t *testing.T) {
	cases := []struct {
		name  string
		files []fileStat
		tgt   target
		want  string // "" = no match
	}{
		{"movie: main file beats sample and nfo",
			files("Movie.2010.1080p.BluRay.x264/Movie.2010.1080p.BluRay.x264.mkv", 9000,
				"Movie.2010.1080p.BluRay.x264/Sample/movie-sample.mkv", 60,
				"Movie.2010.1080p.BluRay.x264/Movie.nfo", 1),
			movie(), "Movie.2010.1080p.BluRay.x264/Movie.2010.1080p.BluRay.x264.mkv"},
		{"movie: extras ignored even when larger",
			files("Film/Film.mkv", 4000, "Film/Extras/Behind the Scenes.mkv", 6000),
			movie(), "Film/Film.mkv"},
		{"movie: russian bonus folder and trailer",
			files("Фильм (2019) BDRip/Фильм (2019) BDRip.avi", 1400,
				"Фильм (2019) BDRip/Бонусы/Фильм о фильме.avi", 1600,
				"Фильм (2019) BDRip/Трейлер.avi", 50),
			movie(), "Фильм (2019) BDRip/Фильм (2019) BDRip.avi"},
		{"movie: single file torrent",
			files("Big.Buck.Bunny.mp4", 270), movie(), "Big.Buck.Bunny.mp4"},
		{"movie: only a sample falls back to it",
			files("X/x-sample.mkv", 30, "X/readme.txt", 1), movie(), "X/x-sample.mkv"},
		{"movie: no video at all",
			files("Movie/Movie.iso", 8000, "Movie/cover.jpg", 1), movie(), ""},
		{"movie: subtitles and audio tracks are not video",
			files("M/M.mkv", 2000, "M/Subs/M.rus.srt", 1, "M/Audio/M.ac3", 3000), movie(), "M/M.mkv"},

		{"series: S01E02 in a season pack",
			files(episodeRange("Show.S01.1080p.WEB-DL/Show.S01E", 1, 10, "%02d.1080p.WEB-DL.mkv", 1500)...),
			ep(1, 2), "Show.S01.1080p.WEB-DL/Show.S01E02.1080p.WEB-DL.mkv"},
		{"series: 1x02 naming",
			files("show.1x01.hdtv.avi", 350, "show.1x02.hdtv.avi", 350, "show.1x03.hdtv.avi", 350),
			ep(1, 2), "show.1x02.hdtv.avi"},
		{"series: s01.e02 naming",
			files("Show/show.s01.e01.mkv", 700, "Show/show.s01.e02.mkv", 700),
			ep(1, 2), "Show/show.s01.e02.mkv"},
		{"series: 'Серия 2' with season from torrent folder",
			files("Сериал.S02.WEBRip/Серия 1.mkv", 900, "Сериал.S02.WEBRip/Серия 2.mkv", 900),
			ep(2, 2), "Сериал.S02.WEBRip/Серия 2.mkv"},
		{"series: '02 серия' in 'Сезон 1'",
			files("Сериал/Сезон 1/01 серия.avi", 700, "Сериал/Сезон 1/02 серия.avi", 700, "Сериал/Сезон 2/02 серия.avi", 700),
			ep(1, 2), "Сериал/Сезон 1/02 серия.avi"},
		{"series: numbered files in 'Season N' folders spanning seasons",
			files("Show/Season 1/01.mkv", 1000, "Show/Season 1/02.mkv", 1000,
				"Show/Season 2/01.mkv", 1100, "Show/Season 2/02.mkv", 1100),
			ep(2, 1), "Show/Season 2/01.mkv"},
		{"series: 'E02' with 'Season 01' folder",
			files("Show.Complete/Season 01/Show - E01.mkv", 800, "Show.Complete/Season 01/Show - E02.mkv", 800),
			ep(1, 2), "Show.Complete/Season 01/Show - E02.mkv"},
		{"series: anime dash numbering in a single-season torrent",
			files("[Group] Show [1080p]/[Group] Show - 04 [1080p].mkv", 1300, "[Group] Show [1080p]/[Group] Show - 05 [1080p].mkv", 1300),
			ep(1, 5), "[Group] Show [1080p]/[Group] Show - 05 [1080p].mkv"},
		{"series: sample of the episode is skipped",
			files("S/Show.S01E02.Sample.mkv", 40, "S/Show.S01E02.mkv", 1200, "S/Show.S01E03.mkv", 1200),
			ep(1, 2), "S/Show.S01E02.mkv"},
		{"series: episode not in pack",
			files(episodeRange("Show.S01/Show.S01E", 1, 10, "%02d.mkv", 900)...),
			ep(1, 11), ""},
		{"series: multi-season pack with SxxEyy in season folders",
			files("Show.S01-S03/S01/Show.S01E05.mkv", 900, "Show.S01-S03/S02/Show.S02E05.mkv", 950, "Show.S01-S03/S03/Show.S03E05.mkv", 990),
			ep(2, 5), "Show.S01-S03/S02/Show.S02E05.mkv"},
		{"series: numbered files of another season do not match",
			files("Show/Season 2/05.mkv", 900, "Show/Season 2/06.mkv", 900),
			ep(1, 5), ""},
		{"series: single-episode release with an odd file name",
			files("Show.S03E04.WEB-DL/show-final-cut.mkv", 1500, "Show.S03E04.WEB-DL/show.nfo", 1),
			target{Episode: true, Season: 3, Number: 4, ReleaseSeasons: []int{3}, ReleaseEpisodes: []int{4}},
			"Show.S03E04.WEB-DL/show-final-cut.mkv"},
		{"series: russian '1 сезон 3 серия'",
			files("Сериал/Сериал 1 сезон 2 серия.avi", 600, "Сериал/Сериал 1 сезон 3 серия.avi", 600),
			ep(1, 3), "Сериал/Сериал 1 сезон 3 серия.avi"},
		{"series: 'Сезон.2.Серия.07'",
			files("Сериал.Сезон.2.Серия.06.mkv", 800, "Сериал.Сезон.2.Серия.07.mkv", 800),
			ep(2, 7), "Сериал.Сезон.2.Серия.07.mkv"},
		{"series: 'Season 1 Episode 3'",
			files("Show.Season.1.Episode.3.mkv", 800, "Show.Season.1.Episode.4.mkv", 800),
			ep(1, 3), "Show.Season.1.Episode.3.mkv"},
		{"series: resolution is not 20x108",
			files("Show/Show.1920x1080.E03.mkv", 800, "Show/Show.1920x1080.E04.mkv", 800),
			ep(1, 3), "Show/Show.1920x1080.E03.mkv"},
		{"series: year before SxxEyy",
			files("Show.2019.S01E03.1080p.mkv", 800, "Show.2019.S01E04.1080p.mkv", 800),
			ep(1, 4), "Show.2019.S01E04.1080p.mkv"},
		{"series: 'Episode 4' in 'Show Season 1'",
			files("Show Season 1/Episode 3.mp4", 400, "Show Season 1/Episode 4.mp4", 400),
			ep(1, 4), "Show Season 1/Episode 4.mp4"},
		{"series: multi-episode file S01E01E02",
			files("Show.S01E01E02.mkv", 1800, "Show.S01E03.mkv", 900),
			ep(1, 1), "Show.S01E01E02.mkv"},
		{"series: anime brackets [07]",
			files("[SubsPlease] Show [06].mkv", 700, "[SubsPlease] Show [07].mkv", 700),
			ep(1, 7), "[SubsPlease] Show [07].mkv"},
		{"series: '2-й сезон' folder with episode-only names",
			files("Сериал/2-й сезон/Серия 01.mkv", 700, "Сериал/1-й сезон/Серия 01.mkv", 700),
			ep(2, 1), "Сериал/2-й сезон/Серия 01.mkv"},
		{"series: season-only release mismatch is refused",
			files("Show.S02/01.mkv", 700, "Show.S02/02.mkv", 700),
			target{Episode: true, Season: 1, Number: 1, ReleaseSeasons: []int{2}}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := selectFile(classify(tc.files), tc.tgt)
			if tc.want == "" {
				if ok {
					t.Fatalf("expected no match, got %q", got.Path)
				}
				return
			}
			if !ok || got.Path != tc.want {
				t.Fatalf("got %q (ok=%v), want %q", got.Path, ok, tc.want)
			}
		})
	}
}

func TestClassify(t *testing.T) {
	fs := classify(files("Show/Season 3/Show.S03E07.mkv", 900, "Show/Season 3/Show.S03E07.rus.srt", 1, "Show/Сезон 4/05.mp4", 800))
	if !fs[0].IsVideo || fs[0].Season == nil || *fs[0].Season != 3 || *fs[0].Episode != 7 {
		t.Fatalf("mkv: %+v", fs[0])
	}
	if fs[1].IsVideo || fs[1].Season != nil {
		t.Fatalf("srt: %+v", fs[1])
	}
	if fs[2].Season == nil || *fs[2].Season != 4 || *fs[2].Episode != 5 {
		t.Fatalf("mp4: %+v", fs[2])
	}
	if MimeType("a/B.MKV") != "video/x-matroska" || MimeType("x.mp4") != "video/mp4" || MimeType("x.ts") != "video/mp2t" || MimeType("x.srt") != "" {
		t.Fatal("mime types")
	}
}
