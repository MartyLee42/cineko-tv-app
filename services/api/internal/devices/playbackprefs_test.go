package devices

import (
	"encoding/json"
	"testing"
)

func p[T any](v T) *T { return &v }

// Same merge as effectivePrefs()/constraints() in @martytv/media-types.
func TestEffectiveMatchesTS(t *testing.T) {
	cases := []struct {
		auto   PlaybackAuto
		manual PlaybackManual
		eff    string
		cons   string
	}{
		{PlaybackAuto{}, PlaybackManual{},
			`{"max_resolution":null,"max_bitrate_bps":null,"max_size_gb":null,"video_codec":null,"avoid_hdr":false,"audio":null,"prefer_smaller":false,"video":null,"audio_codecs":null,"compat":false,"default_player":null}`,
			`[]`},
		{PlaybackAuto{ScreenWidth: p(1920), ScreenHeight: p(1080), Video: []string{"h264", "hevc"}, Audio: []string{"aac", "mp3"}, Compat: p(true), ThroughputBps: p(15e6)}, PlaybackManual{},
			`{"max_resolution":"1080p","max_bitrate_bps":13500000,"max_size_gb":null,"video_codec":null,"avoid_hdr":true,"audio":null,"prefer_smaller":false,"video":["h264","hevc"],"audio_codecs":["aac","mp3"],"compat":true,"default_player":null}`,
			`[{"code":"max_resolution","value":"1080p"},{"code":"max_bitrate","mbps":14},{"code":"no_hdr"},{"code":"no_audio","codecs":["ac3","eac3","dts","truehd"]}]`},
		// The "weak" preset over a 4K HDR TV: manual wins everywhere.
		{PlaybackAuto{ScreenWidth: p(3840), ScreenHeight: p(2160), Video: []string{"hevc", "hdr10"}, ThroughputBps: p(100e6)},
			PlaybackManual{MaxResolution: p("720p"), MaxBitrateMbps: p(8), VideoCodec: p("h264"), HDR: p("avoid"), Audio: p("always_compat"), PreferSmaller: p(true), DefaultPlayer: p("msx")},
			`{"max_resolution":"720p","max_bitrate_bps":8000000,"max_size_gb":null,"video_codec":"h264","avoid_hdr":true,"audio":"always_compat","prefer_smaller":true,"video":["hevc","hdr10"],"audio_codecs":null,"compat":false,"default_player":"msx"}`,
			`[{"code":"max_resolution","value":"720p"},{"code":"max_bitrate","mbps":8},{"code":"codec","value":"h264"},{"code":"no_hdr"},{"code":"compat_audio"},{"code":"smaller"}]`},
		// 0 = unlimited; 2160p is not a constraint; size limit.
		{PlaybackAuto{ScreenWidth: p(3840), ScreenHeight: p(2160), ThroughputBps: p(5e6)}, PlaybackManual{MaxBitrateMbps: p(0), MaxSizeGB: p(4.5), Audio: p("avoid_dts_truehd")},
			`{"max_resolution":"2160p","max_bitrate_bps":null,"max_size_gb":4.5,"video_codec":null,"avoid_hdr":false,"audio":"avoid_dts_truehd","prefer_smaller":false,"video":null,"audio_codecs":null,"compat":false,"default_player":null}`,
			`[{"code":"max_size","gb":4.5},{"code":"no_audio","codecs":["dts","truehd"]}]`},
	}
	for i, c := range cases {
		e := Effective(c.auto, c.manual)
		got, _ := json.Marshal(e)
		if string(got) != c.eff {
			t.Errorf("%d effective\n got %s\nwant %s", i, got, c.eff)
		}
		cons, _ := json.Marshal(Constraints(e))
		if string(cons) != c.cons {
			t.Errorf("%d constraints\n got %s\nwant %s", i, cons, c.cons)
		}
	}
}

func TestResolutionForScreen(t *testing.T) {
	for _, c := range []struct {
		w, h int
		want string
	}{{1280, 720, "720p"}, {1920, 1080, "1080p"}, {1080, 1920, "1080p"}, {3840, 2160, "2160p"}, {2560, 1800, "2160p"}, {800, 480, "720p"}, {0, 0, ""}} {
		if got := ResolutionForScreen(&c.w, &c.h); got != c.want {
			t.Errorf("%dx%d: %s", c.w, c.h, got)
		}
	}
}

// A TV box that never measured its link (Nata's TX3 on its first play) gets
// the «normal» preset's 15 Mbit/s instead of no limit; browsers/phones don't;
// a measurement or a manual value wins.
func TestUnmeasuredTVCap(t *testing.T) {
	tv := PlaybackAuto{Platform: p("android-tv"), Video: []string{"h264", "hevc"}}
	e := Effective(tv, PlaybackManual{})
	if e.MaxBitrateBps == nil || *e.MaxBitrateBps != 15e6 || !UnmeasuredCap(tv, PlaybackManual{}) {
		t.Fatalf("unmeasured TV: %v", e.MaxBitrateBps)
	}
	for _, pl := range []string{"tizen", "webos", "msx"} {
		if e := Effective(PlaybackAuto{Platform: p(pl)}, PlaybackManual{}); e.MaxBitrateBps == nil {
			t.Fatalf("%s: no cap", pl)
		}
	}
	if e := Effective(PlaybackAuto{Platform: p("browser")}, PlaybackManual{}); e.MaxBitrateBps != nil {
		t.Fatalf("browser capped: %v", *e.MaxBitrateBps)
	}
	measured := tv
	measured.ThroughputBps = p(40e6)
	if e := Effective(measured, PlaybackManual{}); *e.MaxBitrateBps != 36e6 || UnmeasuredCap(measured, PlaybackManual{}) {
		t.Fatalf("measured: %v", *e.MaxBitrateBps)
	}
	if e := Effective(tv, PlaybackManual{MaxBitrateMbps: p(0)}); e.MaxBitrateBps != nil {
		t.Fatalf("manual unlimited lost")
	}
}
