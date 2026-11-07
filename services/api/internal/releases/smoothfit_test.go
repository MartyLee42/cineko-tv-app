package releases

import (
	"slices"
	"testing"

	"martytv/api/internal/devices"
)

// A box that decodes 4K HEVC 10-bit but not smoothly (auto.rough): the 1080p
// H.264 rip ranks first, the 4K one stays listed with may_stutter.
func TestDeviceRoughDemotes(t *testing.T) {
	const uhd = "Матрица / The Matrix (1999) WEB-DL 2160p HDR10 | HEVC | AAC"
	const fhd = "Матрица / The Matrix (1999) WEB-DL 1080p | AVC | AAC"
	c := []candidate{cand(t, uhd, 200, 20), cand(t, fhd, 100, 10)}
	if tok := smoothToken(c[0], &c[0].Release); tok != "hevc_10bit_2160p" {
		t.Fatalf("token %q (%+v)", tok, c[0].Release)
	}
	if tok := smoothToken(c[1], &c[1].Release); tok != "h264_1080p" {
		t.Fatalf("token %q", tok)
	}
	auto := devices.PlaybackAuto{Video: []string{"h264", "hevc", "hdr10"}, ScreenWidth: ptr(3840), ScreenHeight: ptr(2160)}
	prefs := Prefs{Languages: []string{"ru"}, Resolution: "2160p", Device: eff(auto, devices.PlaybackManual{})}
	base := Rank(c, prefs)
	if base[0].Title != uhd {
		t.Fatalf("baseline: %v", ids(base))
	}
	auto.Rough = []string{"hevc_10bit_2160p"}
	prefs.Device = eff(auto, devices.PlaybackManual{})
	got := Rank(c, prefs)
	u := byTitle(got, uhd)
	if len(got) != 2 || u.Score >= byTitle(base, uhd).Score || !slices.Contains(u.Warnings, "may_stutter") || slices.Contains(byTitle(got, fhd).Warnings, "may_stutter") {
		t.Fatalf("rough ignored: %v %v %v", ids(got), u.Score, u.Warnings)
	}
	if got[0].Title != fhd {
		t.Fatalf("smooth first: %v", ids(got))
	}
}

func TestSmoothTokenNotJudged(t *testing.T) {
	for _, title := range []string{
		"Матрица / The Matrix (1999) WEB-DL 720p | AVC | AAC",
		"Матрица / The Matrix (1999) BDRip 1080p Hi10P | AAC",
		"Матрица / The Matrix (1999) DVDRip XviD | AC3",
	} {
		c := cand(t, title, 10, 2)
		if tok := smoothToken(c, &c.Release); tok != "" {
			t.Fatalf("%q → %q", title, tok)
		}
	}
}
