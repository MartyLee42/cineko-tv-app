package server_test

import (
	"context"
	"strings"
	"testing"

	"martytv/api/internal/devices"
	"martytv/api/internal/testutil"
)

// /devices/{id}/health: only the TV itself posts (its own id or `me`),
// values are validated, one post per minute per TV; the owner, the TV and
// super_admins read; shared users, plain admins and strangers get 404.
func TestDeviceHealth(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	eve, _ := env.NewUserClient("eve", "user")
	super, _ := env.NewUserClient("marty", "super_admin")
	admin, _ := env.NewUserClient("root", "admin")

	devID, cred := env.Pair(alice, "Living room")
	otherID, otherCred := env.Pair(alice, "Bedroom")
	tv := env.Client()
	tv.Bearer = cred
	tv2 := env.Client()
	tv2.Bearer = otherCred
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "bob", "permission": "use"}).Expect(200)

	path := "/api/v1/devices/" + devID + "/health"
	empty := alice.Do("GET", path, nil).Expect(200).JSON()
	if empty["latest"] != nil || len(empty["history"].([]any)) != 0 {
		t.Fatalf("fresh health %v", empty)
	}

	sample := map[string]any{
		"reason": "periodic", "uptime_s": 125, "screen": "home", "playing": false, "model": "TX3 · Android 11",
		"heap_used_mb": 182.44, "heap_total_mb": 240, "heap_limit_mb": 1024, "device_memory_gb": 2, "cores": 4,
		"fps": 58.3, "slow_frames_pct": 1.2, "lag_ms": 12, "lag_max_ms": 40, "long_tasks": 3, "long_task_ms": 410,
		"unknown_field": "x",
	}
	// Users can't post (not a TV); a TV can't post for another TV.
	alice.Do("POST", path, sample).Expect(403)
	tv.Do("POST", "/api/v1/devices/"+otherID+"/health", sample).Expect(404)
	alice.Do("POST", "/api/v1/devices/me/health", sample).Expect(403)

	// Validation (doesn't use up the rate limit).
	bad := []map[string]any{
		{"reason": "boot"},
		{"fps": -1},
		{"fps": 5000},
		{"slow_frames_pct": 101},
		{"heap_used_mb": 1e9},
		{"cores": -2},
		{"screen": "Home Screen!"},
		{"dropped_frames": 10, "total_frames": 5},
		{"uptime_s": -1},
	}
	for _, b := range bad {
		if r := tv.Do("POST", path, b).Expect(422); r.ErrorCode() != "validation_failed" {
			t.Fatalf("%v: %s", b, r.Body)
		}
	}
	tv.Do("POST", path, map[string]any{"fps": "fast"}).Expect(400)
	tv.Do("POST", path, map[string]any{"model": strings.Repeat("x", 5000)}).Expect(413)

	got := tv.Do("POST", "/api/v1/devices/me/health", sample).Expect(201).JSON()
	if got["heap_used_mb"] != 182.4 || got["at"] == nil || got["unknown_field"] != nil || got["cores"] != 4.0 {
		t.Fatalf("saved %v", got)
	}
	// Rate limit: one per minute per TV; another TV is independent.
	if r := tv.Do("POST", path, sample); r.Status != 429 {
		t.Fatalf("second post: %d", r.Status)
	}
	tv2.Do("POST", "/api/v1/devices/me/health", map[string]any{"reason": "playback", "dropped_frames": 12, "total_frames": 3000}).Expect(201)

	// Readers.
	for name, c := range map[string]*testutil.Client{"owner": alice, "super_admin": super, "tv": tv} {
		h := c.Do("GET", path, nil).Expect(200).JSON()
		latest, _ := h["latest"].(map[string]any)
		if latest == nil || latest["fps"] != 58.3 || latest["screen"] != "home" || len(h["history"].([]any)) != 1 {
			t.Fatalf("%s read %v", name, h)
		}
	}
	tv.Do("GET", "/api/v1/devices/me/health", nil).Expect(200)
	for name, c := range map[string]*testutil.Client{"use share": bob, "stranger": eve, "admin": admin, "other tv": tv2} {
		if r := c.Do("GET", path, nil); r.Status != 404 {
			t.Fatalf("%s GET: %d", name, r.Status)
		}
	}
	alice.Do("GET", "/api/v1/devices/me/health", nil).Expect(404)
	alice.Do("GET", "/api/v1/devices/not-a-uuid/health", nil).Expect(404)

	// Unpaired: gone for everyone.
	alice.Do("DELETE", "/api/v1/devices/"+otherID, nil).Expect(204)
	alice.Do("GET", "/api/v1/devices/"+otherID+"/health", nil).Expect(404)
}

// History keeps the newest 50 samples per device; others are untouched.
func TestDeviceHealthPruning(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	devID, _ := env.Pair(alice, "TV")
	otherID, _ := env.Pair(alice, "TV 2")
	store := devices.NewStore(env.Pool, nil)
	ctx := context.Background()
	for i := 0; i < devices.HealthHistory+15; i++ {
		up := int64(i)
		if _, err := store.AddHealth(ctx, devID, devices.HealthSample{Reason: "periodic", UptimeS: &up}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.AddHealth(ctx, otherID, devices.HealthSample{Reason: "periodic"}); err != nil {
		t.Fatal(err)
	}
	var n, m int
	_ = env.Pool.QueryRow(ctx, `SELECT count(*) FROM device_health_samples WHERE device_id = $1`, devID).Scan(&n)
	_ = env.Pool.QueryRow(ctx, `SELECT count(*) FROM device_health_samples WHERE device_id = $1`, otherID).Scan(&m)
	if n != devices.HealthHistory || m != 1 {
		t.Fatalf("kept %d / %d", n, m)
	}
	h := alice.Do("GET", "/api/v1/devices/"+devID+"/health", nil).Expect(200).JSON()
	hist := h["history"].([]any)
	if len(hist) != devices.HealthHistory || h["latest"].(map[string]any)["uptime_s"] != float64(devices.HealthHistory+14) ||
		hist[len(hist)-1].(map[string]any)["uptime_s"] != 15.0 {
		t.Fatalf("history %d latest %v", len(hist), h["latest"])
	}
}
