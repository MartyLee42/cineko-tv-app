package realtime

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestValidatePayload(t *testing.T) {
	const id = "4f1c9a3e-6b1d-4e5f-9a2b-1c3d4e5f6a7b"
	cases := []struct {
		cmd, payload string
		ok           bool
		want         string // canonical output when ok ("" = nil)
	}{
		{"media.open", `{"media_id":"` + id + `","extra":1}`, true, `{"media_id":"` + id + `"}`},
		{"media.open", `{"media_id":"` + id + `","season_number":2,"episode_number":3,"force":true}`, true, `{"media_id":"` + id + `","season_number":2,"episode_number":3,"force":true}`},
		{"media.open", `{"media_id":"nope"}`, false, ""},
		{"media.open", `{"media_id":"` + id + `","episode_number":3}`, false, ""},
		{"media.open", `{"media_id":"` + id + `","season_number":-1}`, false, ""},
		{"media.open", ``, false, ""},
		{"media.open", `[1]`, false, ""},
		{"media.play", `{"media_id":"` + id + `","position_seconds":-5}`, false, ""},
		{"media.play", `{"media_id":"` + id + `","episode_id":"x"}`, false, ""},
		{"media.play", `{"media_id":"` + id + `","player":"msx"}`, true, `{"media_id":"` + id + `","player":"msx"}`},
		{"media.play", `{"media_id":"` + id + `","player":"winamp"}`, false, ""},
		{"media.play", `{"media_id":"` + id + `","release_id":"rel-1080","quality":720}`, true, `{"media_id":"` + id + `","release_id":"rel-1080","quality":720}`},
		{"media.play", `{"media_id":"` + id + `","release_id":""}`, false, ""},
		{"media.play", `{"media_id":"` + id + `","release_id":"r","quality":0}`, false, ""},
		{"media.seek", `{"position_seconds":120.5}`, true, `{"position_seconds":120.5}`},
		{"media.seek", `{}`, false, ""},
		{"media.pause", `{"anything":true}`, true, ""},
		{"device.request_state", ``, true, ""},
		{"playback.set_subtitles", `{"track_id":null}`, true, `{"track_id":null}`},
		{"playback.set_audio", `{"track_id":null}`, false, ""},
		{"playback.set_audio", `{"track_id":"a1"}`, true, `{"track_id":"a1"}`},
		{"playback.set_audio", `{}`, false, ""},
		{"device.show_message", `{"text":""}`, false, ""},
		{"device.show_message", `{"text":"привет"}`, true, `{"text":"привет"}`},
		{"media.select_source", `{"source_id":""}`, false, ""},
		{"playback.set_volume", `{"volume":0.6}`, true, `{"volume":0.6}`},
		{"playback.set_volume", `{"delta":-0.1,"extra":1}`, true, `{"delta":-0.1}`},
		{"playback.set_volume", `{"muted":true}`, true, `{"muted":true}`},
		{"playback.set_volume", `{"volume":0,"muted":false}`, true, `{"volume":0,"muted":false}`},
		{"playback.set_volume", `{}`, false, ""},
		{"playback.set_volume", ``, false, ""},
		{"playback.set_volume", `{"volume":1.5}`, false, ""},
		{"playback.set_volume", `{"volume":-0.1}`, false, ""},
		{"playback.set_volume", `{"delta":2}`, false, ""},
		{"playback.set_volume", `{"delta":0}`, false, ""},
		{"playback.set_volume", `{"volume":"loud"}`, false, ""},
		{"playback.set_volume", `{"muted":"yes"}`, false, ""},
		{"playback.set_volume", `{"volume":null}`, false, ""},
		{"system.shutdown", `{}`, false, ""},
	}
	for _, c := range cases {
		out, ids, err := ValidatePayload(c.cmd, json.RawMessage(c.payload))
		if c.ok != (err == nil) {
			t.Errorf("%s %s: ok=%v err=%v", c.cmd, c.payload, c.ok, err)
			continue
		}
		if err != nil && !errors.Is(err, ErrInvalidPayload) {
			t.Errorf("%s: error should wrap ErrInvalidPayload: %v", c.cmd, err)
		}
		if c.ok && string(out) != c.want {
			t.Errorf("%s: got %s want %s", c.cmd, out, c.want)
		}
		if c.ok && (c.cmd == "media.open" || c.cmd == "media.play") && (len(ids) != 1 || ids[0] != id) {
			t.Errorf("%s: media ids %v", c.cmd, ids)
		}
	}
}
