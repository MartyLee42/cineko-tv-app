package devicesettings

import (
	"encoding/json"
	"testing"
)

func patchOf(t *testing.T, s string) Patch {
	t.Helper()
	var p Patch
	if err := json.Unmarshal([]byte(s), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPatchValidate(t *testing.T) {
	const pid = `"profile_id":"7f0c6f0e-1d2a-4a59-9a43-6a1d6c0f3b11"`
	ok := []string{
		`{"device":{"screensaver":"off","language":"ru","speedtest":false}}`,
		`{"reset_device":["language","calm_motion"]}`,
		`{` + pid + `,"profile":{"design":"deco","design_surprise":"day","autoplay_countdown":false},"reset":["theme"]}`,
	}
	for _, s := range ok {
		if f := patchOf(t, s).validate(); len(f) > 0 {
			t.Fatalf("%s: %v", s, f)
		}
	}
	bad := map[string]string{
		`{"device":{"screensaver":"aquarium"}}`:           "device.screensaver",
		`{"device":{"language":"fr"}}`:                    "device.language",
		`{"reset_device":["design"]}`:                     "reset_device",
		`{` + pid + `,"profile":{"hide_anime":true}}`:     "profile",
		`{` + pid + `,"profile":{"skip_segments":"x"}}`:   "profile.skip_segments",
		`{` + pid + `,"reset":["min_votes"]}`:             "reset",
		`{"profile":{"design":"deco"}}`:                   "profile_id",
		`{"profile_id":"me","profile":{"design":"deco"}}`: "profile_id",
	}
	for s, field := range bad {
		if f := patchOf(t, s).validate(); f[field] == "" {
			t.Fatalf("%s: want %s, got %v", s, field, f)
		}
	}
}

func TestSanitizeAndEvent(t *testing.T) {
	var s Settings
	_ = json.Unmarshal([]byte(`{"screensaver":"lava","language":"kk","ui_sounds":true}`), &s)
	s = s.sanitize()
	if s.Screensaver != nil || *s.Language != "kk" || !*s.UISounds {
		t.Fatalf("sanitize %+v", s)
	}
	if e := Event(""); e.Type != TypeSettingsChanged || string(e.Payload) != `{}` {
		t.Fatalf("event %+v", e)
	}
	if e := Event("p1"); string(e.Payload) != `{"profile_id":"p1"}` {
		t.Fatalf("event %s", e.Payload)
	}
}
