package server_test

import (
	"encoding/json"
	"testing"
	"time"

	"martytv/api/internal/testutil"
)

func firstProfile(t *testing.T, c *testutil.Client) string {
	t.Helper()
	items := c.Do("GET", "/api/v1/profiles", nil).Expect(200).Items()
	if len(items) == 0 {
		t.Fatal("no profiles")
	}
	return items[0]["id"].(string)
}

// Per-class layers: a phone's look doesn't reach the computer or the base;
// taste settings stay per profile whatever the class.
func TestSettingsClassLayers(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	pid := firstProfile(t, alice)
	base := "/api/v1/profiles/" + pid + "/settings"
	mobile, desktop := base+"?device_class=mobile", base+"?device_class=desktop"

	got := alice.Do("PUT", mobile, map[string]any{"design": "matrix", "autoplay_countdown": false, "min_votes": 300}).Expect(200).JSON()
	if got["design"] != "matrix" || got["autoplay_countdown"] != false || got["min_votes"] != float64(300) {
		t.Fatalf("mobile answer %v", got)
	}
	if d := alice.Do("GET", desktop, nil).Expect(200).JSON(); d["design"] != "kinozal" || d["autoplay_countdown"] != true || d["min_votes"] != float64(300) {
		t.Fatalf("desktop %v", d)
	}
	if b := alice.Do("GET", base, nil).Expect(200).JSON(); b["design"] != "kinozal" || b["min_votes"] != float64(300) {
		t.Fatalf("base %v", b)
	}
	// A legacy client (no class) writes the base: classes without their own value follow it.
	alice.Do("PUT", base, map[string]any{"design": "deco"}).Expect(200)
	if d := alice.Do("GET", desktop, nil).Expect(200).JSON(); d["design"] != "deco" {
		t.Fatalf("desktop follows base %v", d)
	}
	if m := alice.Do("GET", mobile, nil).Expect(200).JSON(); m["design"] != "matrix" {
		t.Fatalf("mobile keeps its own %v", m)
	}
	if r := alice.Do("GET", base+"?device_class=tv", nil); r.Status != 422 {
		t.Fatalf("class tv: %d", r.Status)
	}
	alice.Do("PUT", mobile, map[string]any{"design": "nope"}).Expect(422)
}

// A TV writes its own layer; phones see and edit any TV they may use, and
// the TV hears about it.
func TestTvSettings(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	carol, _ := env.NewUserClient("carol", "user")
	eve, _ := env.NewUserClient("eve", "user")
	super, _ := env.NewUserClient("marty", "super_admin")
	admin, _ := env.NewUserClient("root", "admin")
	alicePID, bobPID := firstProfile(t, alice), firstProfile(t, bob)

	devID, cred := env.Pair(alice, "Living room")
	otherID, otherCred := env.Pair(alice, "Bedroom")
	tv, tv2 := env.Client(), env.Client()
	tv.Bearer, tv2.Bearer = cred, otherCred
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "bob", "permission": "use"}).Expect(200)
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "carol", "permission": "control"}).Expect(200)

	// The TV's PUT goes to its own layer: the other TV and the browsers keep theirs.
	settings := "/api/v1/profiles/" + alicePID + "/settings"
	if got := tv.Do("PUT", settings, map[string]any{"design": "retro80", "skip_segments": "auto", "hide_anime": true}).Expect(200).JSON(); got["design"] != "retro80" || got["hide_anime"] != true {
		t.Fatalf("tv answer %v", got)
	}
	if got := tv2.Do("GET", settings, nil).Expect(200).JSON(); got["design"] != "kinozal" || got["skip_segments"] != "button" || got["hide_anime"] != true {
		t.Fatalf("other tv %v", got)
	}
	if got := alice.Do("GET", settings+"?device_class=mobile", nil).Expect(200).JSON(); got["design"] != "kinozal" {
		t.Fatalf("phone %v", got)
	}

	path := "/api/v1/devices/" + devID + "/settings"
	v := alice.Do("GET", path+"?profile_id="+alicePID, nil).Expect(200).JSON()
	eff, over := v["effective"].(map[string]any), v["overrides"].(map[string]any)
	if eff["design"] != "retro80" || over["design"] != "retro80" || over["skip_segments"] != "auto" || over["hide_anime"] != nil || len(over) != 2 {
		t.Fatalf("owner view %v / %v", eff, over)
	}
	if len(v["profiles"].([]any)) != 2 { // alice's + bob's (shared as use)
		t.Fatalf("profiles %v", v["profiles"])
	}

	// The phone changes the TV; the TV is told (profile_id), the other TV not.
	ws, ws2 := dialDevice(t, env, cred), dialDevice(t, env, otherCred)
	v = alice.Do("PATCH", path, map[string]any{
		"device":     map[string]any{"screensaver": "dvd", "language": "kk", "ui_sounds": true},
		"profile_id": alicePID, "profile": map[string]any{"design": "popart"}, "reset": []string{"skip_segments"},
	}).Expect(200).JSON()
	m := ws.expect("settings.changed")
	var pl map[string]any
	_ = json.Unmarshal(m.Payload, &pl)
	if pl["profile_id"] != alicePID {
		t.Fatalf("event %s", m.Payload)
	}
	ws2.expectNone("settings.changed", 300*time.Millisecond)
	if d := v["device"].(map[string]any); d["screensaver"] != "dvd" || d["language"] != "kk" || d["ui_sounds"] != true || v["updated_at"] == nil {
		t.Fatalf("device %v", d)
	}
	if got := tv.Do("GET", settings, nil).Expect(200).JSON(); got["design"] != "popart" || got["skip_segments"] != "button" {
		t.Fatalf("tv after phone %v", got)
	}
	// The TV reads and edits its own via `me` (no event back to itself).
	me := tv.Do("GET", "/api/v1/devices/me/settings", nil).Expect(200).JSON()
	if me["device"].(map[string]any)["screensaver"] != "dvd" {
		t.Fatalf("me %v", me)
	}
	tv.Do("PATCH", "/api/v1/devices/me/settings", map[string]any{"device": map[string]any{"calm_motion": true}, "reset_device": []string{"language"}}).Expect(200)
	ws.expectNone("settings.changed", 300*time.Millisecond)
	if d := alice.Do("GET", path, nil).Expect(200).JSON()["device"].(map[string]any); d["calm_motion"] != true || d["language"] != nil {
		t.Fatalf("after tv patch %v", d)
	}

	// A base (profile-wide) change reaches the owner's TVs.
	alice.Do("PUT", settings, map[string]any{"min_votes": 1000}).Expect(200)
	ws.expect("settings.changed")
	ws2.expect("settings.changed")

	// Access: owner, `use` (own profiles only), super_admin; others 404.
	bobView := bob.Do("GET", path, nil).Expect(200).JSON()
	if ps := bobView["profiles"].([]any); len(ps) != 1 || ps[0].(map[string]any)["id"] != bobPID || bobView["profile_id"] != bobPID {
		t.Fatalf("bob view %v", bobView)
	}
	bob.Do("GET", path+"?profile_id="+alicePID, nil).Expect(404)
	bob.Do("PATCH", path, map[string]any{"profile_id": alicePID, "profile": map[string]any{"design": "deco"}}).Expect(404)
	bob.Do("PATCH", path, map[string]any{"profile_id": bobPID, "profile": map[string]any{"design": "deco"}}).Expect(200)
	if ps := super.Do("GET", path, nil).Expect(200).JSON()["profiles"].([]any); len(ps) != 2 {
		t.Fatalf("super %v", ps)
	}
	super.Do("PATCH", path, map[string]any{"device": map[string]any{"startup_intro": false}}).Expect(200)
	for name, c := range map[string]*testutil.Client{"control": carol, "stranger": eve, "admin": admin} {
		if r := c.Do("GET", path, nil); r.Status != 404 {
			t.Fatalf("%s GET: %d", name, r.Status)
		}
		c.Do("PATCH", path, map[string]any{"device": map[string]any{"ui_sounds": false}}).Expect(404)
	}
	tv.Do("GET", "/api/v1/devices/"+otherID+"/settings", nil).Expect(404)
	alice.Do("GET", "/api/v1/devices/me/settings", nil).Expect(404)

	// Validation.
	bad := []map[string]any{
		{"device": map[string]any{"screensaver": "fish"}},
		{"device": map[string]any{"language": "de"}},
		{"reset_device": []string{"theme"}},
		{"profile_id": alicePID, "profile": map[string]any{"min_votes": 300}},
		{"profile_id": alicePID, "profile": map[string]any{"design": "nope"}},
		{"profile_id": alicePID, "reset": []string{"taste_note"}},
		{"profile": map[string]any{"design": "deco"}},
	}
	for _, b := range bad {
		if r := alice.Do("PATCH", path, b); r.Status != 422 {
			t.Fatalf("%v: %d %s", b, r.Status, r.Body)
		}
	}
}
