package profiles

import "testing"

func TestSkipSegmentsSetting(t *testing.T) {
	if d := DefaultSettings(); *d.SkipSegments != "button" {
		t.Fatalf("default = %q", *d.SkipSegments)
	}
	for _, m := range SkipModes {
		if w := (Settings{SkipSegments: ptr(m)}).withDefaults(); *w.SkipSegments != m {
			t.Fatalf("%s → %q", m, *w.SkipSegments)
		}
	}
	if f := (Settings{SkipSegments: ptr("always")}).validate(); f["skip_segments"] == "" {
		t.Fatal("bad value accepted")
	}
	if w := (Settings{SkipSegments: ptr("junk")}).withDefaults(); *w.SkipSegments != "button" {
		t.Fatalf("junk kept: %q", *w.SkipSegments)
	}
}
