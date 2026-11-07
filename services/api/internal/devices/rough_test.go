package devices

import "testing"

func TestRoughTokens(t *testing.T) {
	a := PlaybackAuto{Rough: []string{"HEVC_2160p", "hevc_2160p"}}
	f := map[string]string{}
	a.Normalize(f)
	if len(f) != 0 || len(a.Rough) != 1 || a.Rough[0] != "hevc_2160p" {
		t.Fatalf("normalize: %v %v", a.Rough, f)
	}
	if e := Effective(a, PlaybackManual{}); len(e.Rough) != 1 {
		t.Fatalf("effective: %v", e.Rough)
	}
	if e := Effective(PlaybackAuto{}, PlaybackManual{}); e.Rough != nil {
		t.Fatalf("empty: %v", e.Rough)
	}
	bad := PlaybackAuto{Rough: []string{"mpeg2_1080p"}}
	bad.Normalize(f)
	if f["auto.rough"] == "" {
		t.Fatal("unknown token accepted")
	}
}
