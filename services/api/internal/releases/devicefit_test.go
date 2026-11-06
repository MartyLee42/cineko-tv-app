package releases

import (
	"slices"
	"testing"

	"martytv/api/internal/devices"
)

func ptr[T any](v T) *T { return &v }

func eff(a devices.PlaybackAuto, m devices.PlaybackManual) *devices.EffectivePrefs {
	e := devices.Effective(a, m)
	return &e
}

func byTitle(rs []Release, title string) Release {
	for _, r := range rs {
		if r.Title == title {
			return r
		}
	}
	return Release{}
}

// A 1080p H.264 box with AAC/MP3 only, compat streams, ~15 Mbit/s measured:
// a 42 GB remux (≈ 40 Mbit/s over 2 h 22 min) must rank below a 12 GB
// WEB-DL even though the remux has far more seeders.
func TestDeviceRanksHeavyRemuxBelowWebDL(t *testing.T) {
	const remux = "Матрица / The Matrix (1999) BDRemux 1080p | AVC | AC3, DTS | D"
	const web = "Матрица / The Matrix (1999) WEB-DL 1080p | AVC | AC3 | D"
	c := []candidate{cand(t, remux, 200, 42), cand(t, web, 60, 12)}
	for _, x := range c {
		if deref(x.Release.VideoCodec) != "h264" || deref(x.Release.Resolution) != "1080p" || !slices.Contains(x.Release.AudioCodecs, "ac3") {
			t.Fatalf("fixture parse: %+v", x.Release)
		}
	}
	if !slices.Contains(c[0].Release.AudioCodecs, "dts") {
		t.Fatalf("remux audio: %v", c[0].Release.AudioCodecs)
	}
	d := eff(devices.PlaybackAuto{
		Video: []string{"h264", "hevc"}, Audio: []string{"aac", "mp3"}, Compat: ptr(true),
		ThroughputBps: ptr(15e6), ScreenWidth: ptr(1920), ScreenHeight: ptr(1080),
	}, devices.PlaybackManual{})
	prefs := Prefs{Languages: []string{"ru"}, RuntimeSeconds: 8553}

	// Without a device profile the remux wins (more seeders, better source).
	if got := Rank(c, prefs); got[0].Title != remux {
		t.Fatalf("baseline: %v", ids(got))
	}
	prefs.Device = d
	got := Rank(c, prefs)
	if got[0].Title != web {
		t.Fatalf("device profile ignored: %v (scores %v / %v)", ids(got), got[0].Score, got[1].Score)
	}
	rx, wb := byTitle(got, remux), byTitle(got, web)
	if rx.EstBitrateBps == nil || *rx.EstBitrateBps < 40e6 || *rx.EstBitrateBps > 45e6 {
		t.Fatalf("remux bitrate %v", rx.EstBitrateBps)
	}
	if !slices.Contains(rx.Warnings, "too_heavy_for_device") || slices.Contains(wb.Warnings, "too_heavy_for_device") {
		t.Fatalf("warnings %v / %v", rx.Warnings, wb.Warnings)
	}
	// AC3/DTS on an AAC-only box: playable through the compat stream.
	if !slices.Contains(wb.Warnings, "audio_needs_conversion") || slices.Contains(wb.Reasons, "device_fit") {
		t.Fatalf("web audio: %v %v", wb.Warnings, wb.Reasons)
	}
	if slices.Contains(rx.Warnings, "likely_unplayable_codec") {
		t.Fatalf("generic heuristic should yield to the device lists: %v", rx.Warnings)
	}
}

func TestDeviceResolutionCap(t *testing.T) {
	c := []candidate{
		cand(t, "Матрица / The Matrix (1999) BDRip 720p | AVC | AAC | D", 40, 4),
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p | AVC | AAC | D", 40, 10),
		cand(t, "Матрица / The Matrix (1999) UHD BDRip 2160p | AVC | AAC | D", 40, 30),
	}
	// The profile wants 2160p, but the TV is a 720p panel.
	prefs := Prefs{Languages: []string{"ru"}, Resolution: "2160p",
		Device: eff(devices.PlaybackAuto{ScreenWidth: ptr(1280), ScreenHeight: ptr(720)}, devices.PlaybackManual{})}
	got := Rank(c, prefs)
	if deref(got[0].Resolution) != "720p" {
		t.Fatalf("device max resolution ignored: %v", ids(got))
	}
	for _, r := range got {
		over := deref(r.Resolution) != "720p"
		if over != slices.Contains(r.Warnings, "over_device_resolution") {
			t.Fatalf("%s warnings %v", r.Title, r.Warnings)
		}
		if !over && !slices.Contains(r.Reasons, "device_fit") {
			t.Fatalf("fitting release lacks device_fit: %v", r.Reasons)
		}
	}
	// Manual override wins over the detected screen.
	prefs.Device = eff(devices.PlaybackAuto{ScreenWidth: ptr(1280), ScreenHeight: ptr(720)},
		devices.PlaybackManual{MaxResolution: ptr("2160p")})
	if got := Rank(c, prefs); deref(got[0].Resolution) != "2160p" {
		t.Fatalf("manual resolution: %v", ids(got))
	}
}

func TestDeviceBitrateManualCapAndUnlimited(t *testing.T) {
	c := []candidate{
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p от A | AVC | AAC | D", 40, 20), // ≈ 20 Mbit/s
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p от B | AVC | AAC | D", 40, 6),  // ≈ 6 Mbit/s
	}
	prefs := Prefs{Languages: []string{"ru"}, RuntimeSeconds: 8553}
	prefs.Device = eff(devices.PlaybackAuto{ThroughputBps: ptr(100e6)}, devices.PlaybackManual{MaxBitrateMbps: ptr(8)})
	got := Rank(c, prefs)
	if got[0].SizeBytes != 6<<30 || !slices.Contains(got[1].Warnings, "too_heavy_for_device") {
		t.Fatalf("manual cap: %v %v", ids(got), got[1].Warnings)
	}
	// 0 = unlimited (even with a slow measured connection).
	prefs.Device = eff(devices.PlaybackAuto{ThroughputBps: ptr(2e6)}, devices.PlaybackManual{MaxBitrateMbps: ptr(0)})
	for _, r := range Rank(c, prefs) {
		if slices.Contains(r.Warnings, "too_heavy_for_device") {
			t.Fatalf("unlimited still penalized: %v", r.Warnings)
		}
	}
	// Unknown runtime: no bitrate judgement, no estimate.
	prefs.RuntimeSeconds = 0
	prefs.Device = eff(devices.PlaybackAuto{ThroughputBps: ptr(1e6)}, devices.PlaybackManual{})
	for _, r := range Rank(c, prefs) {
		if r.EstBitrateBps != nil || slices.Contains(r.Warnings, "too_heavy_for_device") {
			t.Fatalf("unknown runtime judged: %v", r.Warnings)
		}
	}
}

func TestDevicePenaltyIsMonotone(t *testing.T) {
	// Heavier always ranks lower for the same release otherwise.
	var prev float64 = 2
	for _, gb := range []float64{8, 14, 18, 25, 40, 80} {
		c := []candidate{cand(t, "Матрица / The Matrix (1999) BDRip 1080p | AVC | AAC | D", 40, gb)}
		r := Rank(c, Prefs{Languages: []string{"ru"}, RuntimeSeconds: 8553,
			Device: eff(devices.PlaybackAuto{ThroughputBps: ptr(15e6)}, devices.PlaybackManual{})})[0]
		if r.Score > prev {
			t.Fatalf("%v GB scored %v > %v", gb, r.Score, prev)
		}
		prev = r.Score
	}
}

func TestDeviceVideoCodecAndHDR(t *testing.T) {
	const hevc = "Матрица / The Matrix (1999) BDRip [H.265/1080p] [10-bit] | AAC | D"
	const avc = "Матрица / The Matrix (1999) BDRip [H.264/1080p] | AAC | D"
	c := []candidate{cand(t, hevc, 80, 8), cand(t, avc, 40, 8)}
	noHevc := eff(devices.PlaybackAuto{Video: []string{"h264"}}, devices.PlaybackManual{})
	got := Rank(c, Prefs{Languages: []string{"ru"}, Device: noHevc})
	if got[0].Title != avc || !slices.Contains(got[1].Warnings, "codec_unsupported") {
		t.Fatalf("codec: %v %v", ids(got), got[1].Warnings)
	}
	// A device that decodes HEVC and prefers it: HEVC wins, no warning.
	hevcTV := eff(devices.PlaybackAuto{Video: []string{"h264", "hevc", "hdr10"}}, devices.PlaybackManual{VideoCodec: ptr("hevc")})
	got = Rank(c, Prefs{Languages: []string{"ru"}, Device: hevcTV})
	if got[0].Title != hevc || slices.Contains(got[0].Warnings, "codec_unsupported") {
		t.Fatalf("hevc tv: %v %v", ids(got), got[0].Warnings)
	}

	const hdr = "Матрица / The Matrix (1999) UHD BDRip 1080p HDR10 | AVC | AAC | D"
	c = []candidate{cand(t, hdr, 80, 8), cand(t, avc, 40, 8)}
	if c[0].Release.HDR == nil {
		t.Fatalf("fixture HDR: %+v", c[0].Release)
	}
	// No HDR in the detected video list → avoid HDR automatically.
	got = Rank(c, Prefs{Languages: []string{"ru"}, Device: noHevc})
	if got[0].Title != avc || !slices.Contains(got[1].Warnings, "hdr_avoided") {
		t.Fatalf("hdr: %v %v", ids(got), got[1].Warnings)
	}
	// hdr: allow overrides it.
	allow := eff(devices.PlaybackAuto{Video: []string{"h264"}}, devices.PlaybackManual{HDR: ptr("allow")})
	if got = Rank(c, Prefs{Languages: []string{"ru"}, Device: allow}); slices.Contains(byTitle(got, hdr).Warnings, "hdr_avoided") {
		t.Fatalf("hdr allow: %v", byTitle(got, hdr).Warnings)
	}
}

func TestDeviceAudio(t *testing.T) {
	const dts = "Матрица / The Matrix (1999) BDRip 1080p | AVC | DTS | D"
	const aac = "Матрица / The Matrix (1999) BDRip 1080p | AVC | AAC | D"
	c := []candidate{cand(t, dts, 80, 8), cand(t, aac, 40, 8)}
	if !slices.Equal(c[0].Release.AudioCodecs, []string{"dts"}) {
		t.Fatalf("fixture: %v", c[0].Release.AudioCodecs)
	}
	// No compat: DTS is unsupported.
	got := Rank(c, Prefs{Languages: []string{"ru"}, Device: eff(devices.PlaybackAuto{Audio: []string{"aac", "ac3"}}, devices.PlaybackManual{})})
	if got[0].Title != aac || !slices.Contains(got[1].Warnings, "audio_unsupported") {
		t.Fatalf("no compat: %v %v", ids(got), got[1].Warnings)
	}
	// With compat: needs conversion (milder).
	got = Rank(c, Prefs{Languages: []string{"ru"}, Device: eff(devices.PlaybackAuto{Audio: []string{"aac"}, Compat: ptr(true)}, devices.PlaybackManual{})})
	if !slices.Contains(byTitle(got, dts).Warnings, "audio_needs_conversion") {
		t.Fatalf("compat: %v", byTitle(got, dts).Warnings)
	}
	// avoid_dts_truehd without a detected list.
	got = Rank(c, Prefs{Languages: []string{"ru"}, Device: eff(devices.PlaybackAuto{}, devices.PlaybackManual{Audio: ptr("avoid_dts_truehd")})})
	if got[0].Title != aac || !slices.Contains(got[1].Warnings, "audio_unsupported") {
		t.Fatalf("avoid dts: %v %v", ids(got), got[1].Warnings)
	}
	// always_compat with compat: no audio penalty.
	got = Rank(c, Prefs{Languages: []string{"ru"}, Device: eff(devices.PlaybackAuto{Audio: []string{"aac"}, Compat: ptr(true)}, devices.PlaybackManual{Audio: ptr("always_compat")})})
	if w := byTitle(got, dts).Warnings; slices.Contains(w, "audio_needs_conversion") || slices.Contains(w, "audio_unsupported") {
		t.Fatalf("always_compat: %v", w)
	}
}

func TestDeviceSizeLimitIsStricterOfBoth(t *testing.T) {
	c := []candidate{cand(t, "Матрица / The Matrix (1999) BDRip 1080p | AVC | AAC | D", 40, 10)}
	profile := 20.0
	r := Rank(c, Prefs{Languages: []string{"ru"}, MaxSizeGB: &profile,
		Device: eff(devices.PlaybackAuto{}, devices.PlaybackManual{MaxSizeGB: ptr(4.0)})})[0]
	if !slices.Contains(r.Warnings, "over_size_limit") || slices.Contains(r.Reasons, "device_fit") {
		t.Fatalf("device size limit: %v %v", r.Warnings, r.Reasons)
	}
}

func TestDevicePreferSmaller(t *testing.T) {
	c := []candidate{
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p от A | AVC | AAC | D", 40, 20),
		cand(t, "Матрица / The Matrix (1999) BDRip 1080p от B | AVC | AAC | D", 40, 6),
	}
	got := Rank(c, Prefs{Languages: []string{"ru"}, RuntimeSeconds: 8553})
	if got[0].SizeBytes != 20<<30 {
		t.Fatalf("baseline: larger wins on the size tie-break: %v", ids(got))
	}
	got = Rank(c, Prefs{Languages: []string{"ru"}, RuntimeSeconds: 8553,
		Device: eff(devices.PlaybackAuto{}, devices.PlaybackManual{PreferSmaller: ptr(true)})})
	if got[0].SizeBytes != 6<<30 {
		t.Fatalf("prefer_smaller: %v", ids(got))
	}
}

func TestDeviceXvidAndLikelyXvid(t *testing.T) {
	// The real case: an AVI «BDRip» with more seeders beat an AVC rip on a Samsung.
	const bare = "Матрица / The Matrix (1999) BDRip"
	const xvid = "Матрица / The Matrix (1999) DVDRip XviD | AC3"
	const avi = "Матрица / The Matrix (1999) BDRip [AVI]"
	const avc = "Матрица / The Matrix (Вачовски / Wachowski) [1999, США, BDRip-AVC] Dub"
	c := []candidate{cand(t, bare, 242, 2.18), cand(t, xvid, 200, 1.5), cand(t, avi, 150, 2), cand(t, avc, 40, 3)}
	tv := eff(devices.PlaybackAuto{Video: []string{"h264", "hevc", "vp9", "av1", "hdr10"}}, devices.PlaybackManual{})
	got := Rank(c, Prefs{Languages: []string{"ru"}, Device: tv})
	if got[0].Title != avc {
		t.Fatalf("AVC should win: %v", ids(got))
	}
	for _, r := range got[1:] {
		if !slices.Contains(r.Warnings, "codec_unsupported") && !slices.Contains(r.Warnings, "codec_unknown") {
			t.Fatalf("%q not flagged: %v", r.Title, r.Warnings)
		}
	}
	// A device that decodes MPEG-4 Part 2: no penalty, the most seeded wins.
	xvidTV := eff(devices.PlaybackAuto{Video: []string{"h264", "mpeg4"}}, devices.PlaybackManual{})
	got = Rank(c, Prefs{Languages: []string{"ru"}, Device: xvidTV})
	for _, r := range got {
		if slices.Contains(r.Warnings, "codec_unsupported") || slices.Contains(r.Warnings, "codec_unknown") {
			t.Fatalf("mpeg4 device flagged %q: %v", r.Title, r.Warnings)
		}
	}
	// A modern rip with a resolution but no codec is not guessed.
	if likelyXvid(&Release{Resolution: ptr("1080p"), SourceQuality: ptr("bdrip")}) {
		t.Fatal("1080p rip guessed as XviD")
	}
}
