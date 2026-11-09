package profiles

import (
	"encoding/json"
	"testing"
)

func TestMergeLayers(t *testing.T) {
	base := []byte(`{"design":"deco","min_votes":300,"theme":"light","autoplay_countdown":false}`)
	class := []byte(`{"design":"matrix","min_votes":5000,"skip_segments":"auto","theme":null}`)
	tv := []byte(`{"design":"wireframe","poster_wobble":false,"loading_style":"bogus"}`)

	got := MergeLayers(base, class)
	if *got.Design != "matrix" || *got.SkipSegments != "auto" || *got.Theme != "light" || *got.AutoplayCountdown {
		t.Fatalf("class over base: %+v", got)
	}
	if *got.MinVotes != 300 {
		t.Fatalf("min_votes is per profile, layer must not override: %d", *got.MinVotes)
	}
	got = MergeLayers(base, class, tv)
	if *got.Design != "wireframe" || *got.PosterWobble || *got.LoadingStyle != "popcorn" {
		t.Fatalf("later layer wins, invalid falls back: %+v", got)
	}
	if got := MergeLayers(nil); *got.Design != "wireframe" || *got.MinVotes != DefaultMinVotes {
		t.Fatalf("defaults: %+v", got)
	}
	if got := MergeLayers([]byte(`garbage`), []byte(`{"design":"deco"}`)); *got.Design != "deco" {
		t.Fatalf("garbled base: %+v", got)
	}
}

func TestSplitPatch(t *testing.T) {
	var in Settings
	_ = json.Unmarshal([]byte(`{"design":"deco","hide_anime":true,"design_favorites":["deco"],"taste_note":"x"}`), &in)
	base, layer, err := SplitPatch(in)
	if err != nil {
		t.Fatal(err)
	}
	var b, l map[string]any
	_ = json.Unmarshal(base, &b)
	_ = json.Unmarshal(layer, &l)
	if len(b) != 2 || b["hide_anime"] != true || b["taste_note"] != "x" {
		t.Fatalf("base %s", base)
	}
	if len(l) != 2 || l["design"] != "deco" {
		t.Fatalf("layer %s", layer)
	}
	if base, layer, _ := SplitPatch(Settings{}); base != nil || layer != nil {
		t.Fatalf("empty: %s %s", base, layer)
	}
}

func TestLayerOnlyAndClass(t *testing.T) {
	st := LayerOnly([]byte(`{"design":"deco","min_votes":5000,"theme":null}`))
	b, _ := json.Marshal(st)
	if string(b) != `{"design":"deco"}` {
		t.Fatalf("layer only %s", b)
	}
	for v, ok := range map[string]bool{"": true, "mobile": true, "desktop": true, "tv": false, "phone": false} {
		if _, got := ParseClass(v); got != ok {
			t.Fatalf("ParseClass(%q) = %v", v, got)
		}
	}
	for _, k := range LayeredKeys {
		if _, ok := map[string]bool{"min_votes": true, "taste_note": true, "sources": true}[k]; ok {
			t.Fatalf("%s must stay per profile", k)
		}
	}
	// Every layered key is a real settings field.
	all, _ := json.Marshal(DefaultSettings())
	var m map[string]any
	_ = json.Unmarshal(all, &m)
	for _, k := range LayeredKeys {
		if _, ok := m[k]; !ok {
			t.Fatalf("unknown layered key %s", k)
		}
	}
}

func TestWithDeviceDefault(t *testing.T) {
	design := func(layer []byte) string {
		return *MergeLayers([]byte(`{"design":"deco"}`), layer).Design
	}
	if got := design(WithDeviceDefault(nil, "wireframe")); got != "wireframe" {
		t.Fatalf("empty layer: %s", got)
	}
	if got := design(WithDeviceDefault([]byte(`{"theme":"light"}`), "wireframe")); got != "wireframe" {
		t.Fatalf("layer without design: %s", got)
	}
	if got := design(WithDeviceDefault([]byte(`{"design":"matrix"}`), "wireframe")); got != "matrix" {
		t.Fatalf("the TV's own pick wins: %s", got)
	}
	if got := design(WithDeviceDefault([]byte(`{"design":null}`), "wireframe")); got != "deco" {
		t.Fatalf("null = follow the profile: %s", got)
	}
	for _, def := range []string{"", "bogus"} {
		if got := design(WithDeviceDefault(nil, def)); got != "deco" {
			t.Fatalf("default %q: %s", def, got)
		}
	}
	if o := LayerOnly(WithDeviceDefault(nil, "wireframe")); o.Design == nil || *o.Design != "wireframe" {
		t.Fatalf("shown as the TV's own %+v", o)
	}
}
