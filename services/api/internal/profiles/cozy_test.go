package profiles

import (
	"encoding/json"
	"testing"
)

func TestSettingsCozyAndWobble(t *testing.T) {
	d := DefaultSettings()
	if *d.CozyMode || *d.CozyAmbience != "fireplace" || *d.CozySound || !*d.PosterWobble {
		t.Fatalf("defaults = cozy %v ambience %q sound %v wobble %v", *d.CozyMode, *d.CozyAmbience, *d.CozySound, *d.PosterWobble)
	}
	for _, a := range CozyAmbiences {
		s := Settings{CozyMode: ptr(true), CozyAmbience: ptr(a), CozySound: ptr(true), PosterWobble: ptr(false)}
		if f := s.validate(); len(f) > 0 {
			t.Fatalf("%q rejected: %v", a, f)
		}
		w := s.withDefaults()
		if !*w.CozyMode || *w.CozyAmbience != a || !*w.CozySound || *w.PosterWobble {
			t.Fatalf("withDefaults lost values for %q", a)
		}
	}
	for _, bad := range []string{"", "snow", "RAIN"} {
		if f := (Settings{CozyAmbience: ptr(bad)}).validate(); f["cozy_ambience"] == "" {
			t.Fatalf("%q accepted", bad)
		}
	}
	// Stored junk falls back to the default.
	var st Settings
	if err := json.Unmarshal([]byte(`{"cozy_ambience":"storm","cozy_mode":true}`), &st); err != nil {
		t.Fatal(err)
	}
	w := st.withDefaults()
	if *w.CozyAmbience != "fireplace" || !*w.CozyMode || !*w.PosterWobble {
		t.Fatalf("junk not dropped: %q %v %v", *w.CozyAmbience, *w.CozyMode, *w.PosterWobble)
	}
	// A partial patch carries only the keys it sets.
	b, _ := json.Marshal(Settings{PosterWobble: ptr(false)})
	if string(b) != `{"poster_wobble":false}` {
		t.Fatalf("patch json = %s", b)
	}
}
