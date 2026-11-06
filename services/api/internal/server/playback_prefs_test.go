package server_test

import (
	"fmt"
	"strings"
	"testing"

	"martytv/api/internal/testutil"
)

// Access matrix for /devices/{id}/playback-prefs: owner, `use` share and any
// super_admin may read/write; `control` share and strangers get 404; a TV
// only its own id (or `me`).
func TestPlaybackPrefsAccess(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	carol, _ := env.NewUserClient("carol", "user")
	eve, _ := env.NewUserClient("eve", "user")
	super, _ := env.NewUserClient("marty", "super_admin")
	admin, _ := env.NewUserClient("root", "admin")

	devID, cred := env.Pair(alice, "Living room")
	otherID, _ := env.Pair(alice, "Bedroom")
	tv := env.Client()
	tv.Bearer = cred
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "bob", "permission": "use"}).Expect(200)
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "carol", "permission": "control"}).Expect(200)

	path := "/api/v1/devices/" + devID + "/playback-prefs"
	empty := alice.Do("GET", path, nil).Expect(200).JSON()
	if empty["updated_at"] != nil || len(empty["constraints"].([]any)) != 0 {
		t.Fatalf("fresh prefs %v", empty)
	}
	if e := empty["effective"].(map[string]any); e["avoid_hdr"] != false || e["video"] != nil || e["max_bitrate_bps"] != nil {
		t.Fatalf("fresh effective %v", e)
	}
	for name, c := range map[string]*testutil.Client{"owner": alice, "use": bob, "super_admin": super} {
		c.Do("GET", path, nil).Expect(200)
		c.Do("PATCH", path, map[string]any{"manual": map[string]any{"max_resolution": "1080p"}}).Expect(200)
		_ = name
	}
	for name, c := range map[string]*testutil.Client{"control": carol, "stranger": eve, "admin": admin} {
		if r := c.Do("GET", path, nil); r.Status != 404 {
			t.Fatalf("%s GET: %d", name, r.Status)
		}
		c.Do("PATCH", path, map[string]any{"manual": map[string]any{}}).Expect(404)
	}

	// The TV: own id and `me` work, another TV of the same owner doesn't.
	tv.Do("GET", path, nil).Expect(200)
	tv.Do("GET", "/api/v1/devices/me/playback-prefs", nil).Expect(200)
	tv.Do("GET", "/api/v1/devices/"+otherID+"/playback-prefs", nil).Expect(404)
	tv.Do("PATCH", "/api/v1/devices/"+otherID+"/playback-prefs", map[string]any{"auto": map[string]any{}}).Expect(404)
	alice.Do("GET", "/api/v1/devices/me/playback-prefs", nil).Expect(404)

	// The TV reports auto; manual stays; effective merges (manual wins).
	got := tv.Do("PATCH", "/api/v1/devices/me/playback-prefs", map[string]any{"auto": map[string]any{
		"screen_width": 1920, "screen_height": 1080, "video": []string{"h264", "HEVC", "h264"}, "audio": []string{"aac", "mp3"},
		"compat": true, "throughput_bps": 15e6, "model": "Box · Android 11", "unknown_field": 1,
	}}).Expect(200).JSON()
	auto := got["auto"].(map[string]any)
	if fmt.Sprint(auto["video"]) != "[h264 hevc]" || auto["model"] != "Box · Android 11" || auto["unknown_field"] != nil {
		t.Fatalf("auto %v", auto)
	}
	if got["manual"].(map[string]any)["max_resolution"] != "1080p" || got["updated_at"] == nil {
		t.Fatalf("manual lost: %v", got)
	}
	e := got["effective"].(map[string]any)
	if e["max_bitrate_bps"] != 13.5e6 || e["max_resolution"] != "1080p" || e["avoid_hdr"] != true || e["compat"] != true {
		t.Fatalf("effective %v", e)
	}
	codes := []string{}
	for _, c := range got["constraints"].([]any) {
		codes = append(codes, c.(map[string]any)["code"].(string))
	}
	if strings.Join(codes, ",") != "max_resolution,max_bitrate,no_hdr,no_audio" {
		t.Fatalf("constraints %v", got["constraints"])
	}
	// The TV may edit manual too (its own Settings → «Это устройство»).
	got = tv.Do("PATCH", "/api/v1/devices/me/playback-prefs", map[string]any{"manual": map[string]any{"max_bitrate_mbps": 0, "preset": "power4k"}}).Expect(200).JSON()
	if got["effective"].(map[string]any)["max_bitrate_bps"] != nil || got["manual"].(map[string]any)["max_resolution"] != nil {
		t.Fatalf("manual replace: %v", got)
	}
	// The owner sees what the TV reported.
	if a := alice.Do("GET", path, nil).Expect(200).JSON()["auto"].(map[string]any); a["throughput_bps"] != 15e6 {
		t.Fatalf("owner view %v", a)
	}

	// Validation.
	bad := []map[string]any{
		{"manual": map[string]any{"max_resolution": "4k"}},
		{"manual": map[string]any{"max_bitrate_mbps": 5000}},
		{"manual": map[string]any{"max_size_gb": -1}},
		{"manual": map[string]any{"hdr": "maybe"}},
		{"manual": map[string]any{"audio": "loud"}},
		{"manual": map[string]any{"default_player": "vlc"}},
		{"manual": map[string]any{"video_codec": "av1"}},
		{"auto": map[string]any{"video": []string{"h266"}}},
		{"auto": map[string]any{"screen_width": 99999}},
		{"auto": map[string]any{"throughput_bps": -5}},
		{"auto": map[string]any{"audio": strings.Split(strings.Repeat("aac,", 17)+"aac", ",")}},
	}
	for _, b := range bad {
		if r := alice.Do("PATCH", path, b).Expect(422); r.ErrorCode() != "validation_failed" {
			t.Fatalf("%v: %s", b, r.Body)
		}
	}
	alice.Do("PATCH", path, map[string]any{"manual": map[string]any{"max_bitrate_mbps": "fast"}}).Expect(400)
	big := map[string]any{"auto": map[string]any{"model": strings.Repeat("x", 9000)}}
	alice.Do("PATCH", path, big).Expect(413)
}

// Browser records: CRUD per user, 20 per user (oldest dropped), no TVs.
func TestPlaybackClients(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	_, cred := env.Pair(alice, "TV")
	tv := env.Client()
	tv.Bearer = cred

	base := "/api/v1/me/playback-clients/"
	alice.Do("GET", base+"laptop-abc123", nil).Expect(404)
	alice.Do("GET", base+"bad!", nil).Expect(404)
	got := alice.Do("PATCH", base+"laptop-abc123", map[string]any{"name": "Laptop", "platform": "Chrome · macOS",
		"auto": map[string]any{"screen_width": 2880, "screen_height": 1800, "throughput_bps": 50e6}}).Expect(200).JSON()
	if got["client_id"] != "laptop-abc123" || got["name"] != "Laptop" || got["effective"].(map[string]any)["max_resolution"] != "2160p" {
		t.Fatalf("upsert %v", got)
	}
	// A partial PATCH keeps the other parts.
	got = alice.Do("PATCH", base+"laptop-abc123", map[string]any{"manual": map[string]any{"preset": "phone", "max_size_gb": 4}}).Expect(200).JSON()
	if got["name"] != "Laptop" || got["auto"].(map[string]any)["screen_width"] != 2880.0 || got["manual"].(map[string]any)["max_size_gb"] != 4.0 {
		t.Fatalf("partial %v", got)
	}
	alice.Do("PATCH", base+"laptop-abc123", map[string]any{"name": strings.Repeat("n", 65)}).Expect(422)
	alice.Do("PATCH", base+"laptop-abc123", map[string]any{"manual": map[string]any{"hdr": "x"}}).Expect(422)

	// Per user: Bob doesn't see it; TVs can't use these routes.
	bob.Do("GET", base+"laptop-abc123", nil).Expect(404)
	if n := len(bob.Do("GET", "/api/v1/me/playback-clients", nil).Expect(200).Items()); n != 0 {
		t.Fatalf("bob sees %d", n)
	}
	tv.Do("GET", "/api/v1/me/playback-clients", nil).Expect(403)
	tv.Do("PATCH", base+"tv-client-1", map[string]any{}).Expect(403)

	// Cap: the 21st record drops the oldest.
	for i := 1; i <= 20; i++ {
		alice.Do("PATCH", fmt.Sprintf("%sclient-%03d", base, i), map[string]any{"name": fmt.Sprint(i)}).Expect(200)
	}
	items := alice.Do("GET", "/api/v1/me/playback-clients", nil).Expect(200).Items()
	if len(items) != 20 || items[0]["client_id"] != "client-020" {
		t.Fatalf("cap: %d items, first %v", len(items), items[0]["client_id"])
	}
	for _, it := range items {
		if it["client_id"] == "laptop-abc123" {
			t.Fatalf("oldest not dropped")
		}
	}

	alice.Do("DELETE", base+"client-020", nil).Expect(204)
	alice.Do("DELETE", base+"client-020", nil).Expect(404)
	alice.Do("GET", base+"client-020", nil).Expect(404)
}
