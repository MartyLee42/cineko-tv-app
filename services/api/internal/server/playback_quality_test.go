package server_test

import (
	"testing"
)

func TestPlaybackQualityTelemetry(t *testing.T) {
	w := newWatchEnv(t)
	admin, _ := w.env.NewUserClient("root", "admin")
	media := insertMovie(t, w.env, "Quality Film")
	sid := startSession(t, w.alice, map[string]any{"profile_id": w.pid, "media_id": media})["id"].(string)
	url := "/api/v1/playback/sessions/" + sid + "/progress"
	send := func(seq int, state string, quality any) map[string]any {
		return w.alice.Do("POST", url, map[string]any{"seq": seq, "position_seconds": 300, "duration_seconds": 6000,
			"state": state, "quality": quality}).Expect(200).JSON()
	}
	sample := map[string]any{"app": "tv", "engine": "direct", "startup_ms": 1500, "watched_s": 300, "stalls": 1,
		"stall_ms": 4000, "longest_stall_ms": 4000, "seeks": 0, "seek_wait_ms": 0, "dropped_frames": 300,
		"total_frames": 7500, "width": 1920, "height": 1080, "errors": 0}

	// A malformed sample never costs the progress report.
	expectAccepted(t, send(1, "playing", "garbage"), true, "")
	if got := admin.Do("GET", "/api/v1/admin/playback-quality", nil).Expect(200).JSON(); len(got["groups"].([]any)) != 0 {
		t.Fatalf("bad sample stored: %v", got)
	}
	expectAccepted(t, send(2, "playing", sample), true, "")
	sample["stalls"], sample["stall_ms"] = 2, 9000
	expectAccepted(t, send(3, "stopped", sample), true, "")
	// An old report doesn't overwrite newer totals.
	sample["stalls"] = 99
	send(3, "playing", sample)

	got := admin.Do("GET", "/api/v1/admin/playback-quality?days=7&lang=en", nil).Expect(200).JSON()
	groups := got["groups"].([]any)
	if len(groups) != 1 {
		t.Fatalf("groups = %v", groups)
	}
	g := groups[0].(map[string]any)
	if g["app"] != "tv" || g["source_kind"] != "other" || g["sessions"] != float64(1) || g["smooth_pct"] != float64(0) || g["dropped_pct"] != float64(4) {
		t.Fatalf("group = %v", g)
	}
	worst := got["worst"].([]any)
	if len(worst) != 1 {
		t.Fatalf("worst = %v", worst)
	}
	r := worst[0].(map[string]any)
	if r["title"] != "Quality Film" || r["stalls"] != float64(2) || r["stall_s"] != float64(9) || r["height"] != float64(1080) {
		t.Fatalf("worst row = %v", r)
	}
	w.alice.Do("GET", "/api/v1/admin/playback-quality", nil).Expect(403)
}
