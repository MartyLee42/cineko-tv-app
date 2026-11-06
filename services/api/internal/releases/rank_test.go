package releases

import (
	"slices"
	"testing"

	"martytv/api/internal/sources"
)

// cand builds an accepted candidate the way the service does.
func cand(t *testing.T, title string, seeders int, sizeGB float64) candidate {
	t.Helper()
	tg := matrix()
	p := Parse(title)
	m := tg.Match(&p, 0, nil)
	if m.Rejected {
		t.Fatalf("fixture %q rejected: %v", title, m.Reasons)
	}
	r := tagged{Torrent: sources.Torrent{Title: title, Indexer: "RuTor", Size: int64(sizeGB * (1 << 30)), Seeders: &seeders, GUID: title}, ref: prowlarrRef}
	return toCandidate(releaseID(&r), &r, &p, m, tg)
}

func ids(rs []Release) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.Title
	}
	return out
}

func TestRankPrefersResolutionPreference(t *testing.T) {
	c := []candidate{
		cand(t, "Матрица / The Matrix (1999) BDRip 720p | D", 40, 4),
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p | D", 40, 10),
		cand(t, "Матрица / The Matrix (1999) UHD BDRip 2160p | HDR | D", 40, 30),
	}
	got := Rank(c, Prefs{Languages: []string{"ru"}})
	if got[0].Resolution == nil || *got[0].Resolution != "1080p" {
		t.Fatalf("default should prefer 1080p: %v", ids(got))
	}
	got = Rank(c, Prefs{Languages: []string{"ru"}, Resolution: "2160p"})
	if *got[0].Resolution != "2160p" {
		t.Fatalf("2160p preference: %v", ids(got))
	}
	got = Rank(c, Prefs{Languages: []string{"ru"}, Resolution: "720p"})
	if *got[0].Resolution != "720p" {
		t.Fatalf("720p preference: %v", ids(got))
	}
}

func TestRankSizeLimitAndWarnings(t *testing.T) {
	c := []candidate{
		cand(t, "Матрица / The Matrix (1999) BDRemux 1080p | D", 40, 40),
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p | D", 40, 8),
	}
	limit := 15.0
	got := Rank(c, Prefs{Languages: []string{"ru"}, MaxSizeGB: &limit})
	if got[0].SizeBytes > 15<<30 {
		t.Fatalf("size limit ignored: %v", ids(got))
	}
	if !slices.Contains(got[1].Warnings, "over_size_limit") {
		t.Fatalf("warnings: %v", got[1].Warnings)
	}
	// Without the limit the remux wins.
	got = Rank(c, Prefs{Languages: []string{"ru"}})
	if *got[0].SourceQuality != "remux" {
		t.Fatalf("no limit: %v", ids(got))
	}
}

func TestRankLanguages(t *testing.T) {
	c := []candidate{
		cand(t, "The.Matrix.1999.1080p.BluRay.x264-GRP", 40, 8), // original audio only
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p | D", 40, 8),
	}
	c[0].Release.Languages = []string{"en"}
	ru := Rank(c, Prefs{Languages: []string{"ru", "en"}})
	en := Rank(c, Prefs{Languages: []string{"en"}})
	if ru[0].Title == en[0].Title {
		t.Fatalf("language preference doesn't change order: %v / %v", ids(ru), ids(en))
	}
	de := Rank(c, Prefs{Languages: []string{"de"}})
	for _, r := range de {
		if !slices.Contains(r.Warnings, "no_preferred_language") {
			t.Fatalf("missing warning: %+v", r.Warnings)
		}
	}
}

func TestRankAvailabilityAndCam(t *testing.T) {
	c := []candidate{
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p | D", 0, 8),
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p от X | D", 2, 8),
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p от Y | D", 200, 8),
		cand(t, "Матрица / The Matrix (1999) CAMRip | D", 500, 2),
	}
	got := Rank(c, Prefs{Languages: []string{"ru"}})
	if got[0].Seeders != 200 || got[len(got)-1].Seeders != 0 {
		t.Fatalf("order: %v", ids(got))
	}
	for _, r := range got {
		if r.Seeders < 3 && !slices.Contains(r.Warnings, "low_seeders") {
			t.Errorf("low_seeders missing on %q", r.Title)
		}
		if *r.SourceQuality == "cam" && !slices.Contains(r.Warnings, "cam_quality") {
			t.Errorf("cam_quality missing")
		}
	}
	if *got[1].SourceQuality == "cam" {
		t.Fatalf("CAM ranked too high: %v", ids(got))
	}
}

func TestRankUnplayableCodecs(t *testing.T) {
	c := []candidate{
		cand(t, "Матрица / The Matrix (1999) BDRip [H.265/1080p] [10-bit] | D", 40, 8),
		cand(t, "Матрица / The Matrix (1999) BDRip [H.264/1080p] | D", 40, 8),
	}
	got := Rank(c, Prefs{Languages: []string{"ru"}})
	if *got[0].VideoCodec != "h264" || !slices.Contains(got[1].Warnings, "likely_unplayable_codec") {
		t.Fatalf("got %v / %v", ids(got), got[1].Warnings)
	}
	// A profile that prefers HEVC (e.g. a TV that plays it) flips the order.
	got = Rank(c, Prefs{Languages: []string{"ru"}, Codecs: []string{"hevc"}})
	if *got[0].VideoCodec != "hevc" || slices.Contains(got[0].Warnings, "likely_unplayable_codec") {
		t.Fatalf("hevc preference: %v %v", ids(got), got[0].Warnings)
	}
	dtsOnly := cand(t, "Матрица / The Matrix (1999) BDRip 1080p | DTS | D", 40, 8)
	if r := Rank([]candidate{dtsOnly}, Prefs{})[0]; !slices.Contains(r.Warnings, "likely_unplayable_codec") {
		t.Fatalf("DTS-only audio not flagged: %v", r.Warnings)
	}
}

func TestRankDeterministic(t *testing.T) {
	c := []candidate{
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p от A | D", 10, 8),
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p от B | D", 10, 8),
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p от C | D", 10, 8),
	}
	first := ids(Rank(c, Prefs{}))
	for i := 0; i < 20; i++ {
		slices.Reverse(c)
		if got := ids(Rank(c, Prefs{})); !slices.Equal(got, first) {
			t.Fatalf("order changed: %v vs %v", got, first)
		}
	}
}
