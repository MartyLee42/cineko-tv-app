package playback

import (
	"strings"
	"testing"
)

func TestPickAudio(t *testing.T) {
	// The provider's order (VIDEO_LANG ru first, then the original, …); en twice (plain, then volume-levelled).
	ts := []VideoTrack{
		{Itag: 140, Lang: "ru", Bandwidth: 3},
		{Itag: 140, Lang: "en", Original: true, Bandwidth: 2},
		{Itag: 140, Lang: "en", Original: true, Bandwidth: 1},
		{Itag: 140, Lang: "pt-br"},
		{Itag: 140, Lang: "ja"},
	}
	cases := map[string]string{"": "ru", "original": "en", "ORIGINAL": "en", "ja": "ja", "pt": "pt-br", "pt-pt": "pt-br", "de": "ru", "en": "en"}
	for pref, want := range cases {
		if got := pickAudio(ts, pref); got == nil || got.Lang != want {
			t.Errorf("pref %q: %v", pref, got)
		}
	}
	if a := pickAudio(ts, "en"); a.Bandwidth != 2 {
		t.Error("the plain copy first")
	}
	if pickAudio(nil, "ru") != nil {
		t.Error("no tracks")
	}
	// No track marked original (dubs only): the first.
	if a := pickAudio([]VideoTrack{{Lang: "de"}, {Lang: "ja"}}, "original"); a.Lang != "de" {
		t.Errorf("dubs only: %v", a)
	}

	list := audioTrackList(ts)
	var ids []string
	for _, x := range list {
		ids = append(ids, x.ID)
	}
	if strings.Join(ids, ",") != "ru,en,pt-br,ja" || !list[1].Original || list[0].Original {
		t.Fatalf("list %+v", list)
	}
	if n := len(audioTrackList([]VideoTrack{{Itag: 140}})); n != 0 {
		t.Fatalf("one track listed: %d", n)
	}

	if a := audioByName(ts, 140, ""); a == nil || a.Lang != "ru" {
		t.Errorf("old names: %v", a)
	}
	if a := audioByName(ts, 140, "fr"); a != nil {
		t.Errorf("unknown language: %v", a)
	}
	for p, ok := range map[string]bool{"": true, "original": true, "ru": true, "pt-BR": true, "../x": false, "russian-dub": false, "r": false} {
		if validAudioPref(p) != ok {
			t.Errorf("validAudioPref(%q)", p)
		}
	}
	m := string(masterPlaylist(&VideoTrack{Itag: 136, Height: 720, Width: 1280, Bandwidth: 1}, &ts[3]))
	if !strings.Contains(m, `LANGUAGE="pt-br"`) || !strings.Contains(m, `URI="a140.pt-br.m3u8"`) {
		t.Fatalf("master:\n%s", m)
	}
	if sidxKey("x", ts[0]) == sidxKey("x", ts[4]) {
		t.Fatal("sidx cache mixes languages")
	}
}
