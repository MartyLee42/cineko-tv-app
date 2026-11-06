package server_test

import (
	"testing"

	"martytv/api/internal/testutil"
)

// Holiday animations: a profile's seasonal_effects is "off" by default
// (turned on per profile) and validated; the admin's global switch
// (/admin/appearance) is admin-only and shows up for every reader (users and
// TVs) in GET /status.
func TestSeasonalEffectsSettingAndAdminSwitch(t *testing.T) {
	env := testutil.New(t)
	admin, _ := env.NewUserClient("root", "admin")
	alice, _ := env.NewUserClient("alice", "user")

	prof := alice.Do("POST", "/api/v1/profiles", map[string]any{"name": "Alice", "color": "#6366f1"}).Expect(201).JSON()
	id := prof["id"].(string)
	st := alice.Do("GET", "/api/v1/profiles/"+id+"/settings", nil).Expect(200).JSON()
	if st["seasonal_effects"] != "off" {
		t.Fatalf("default seasonal_effects %v", st["seasonal_effects"])
	}
	st = alice.Do("PUT", "/api/v1/profiles/"+id+"/settings", map[string]any{"seasonal_effects": "on"}).Expect(200).JSON()
	if st["seasonal_effects"] != "on" {
		t.Fatalf("enabled %v", st["seasonal_effects"])
	}
	st = alice.Do("PUT", "/api/v1/profiles/"+id+"/settings", map[string]any{"seasonal_effects": "calm"}).Expect(200).JSON()
	if st["seasonal_effects"] != "calm" {
		t.Fatalf("saved %v", st["seasonal_effects"])
	}
	alice.Do("PUT", "/api/v1/profiles/"+id+"/settings", map[string]any{"seasonal_effects": "loud"}).Expect(422)
	if got := alice.Do("GET", "/api/v1/profiles/"+id+"/settings", nil).Expect(200).JSON()["seasonal_effects"]; got != "calm" {
		t.Fatalf("after rejected PUT %v", got)
	}

	// Global switch: on by default, visible in /status.
	if got := alice.Do("GET", "/api/v1/status", nil).Expect(200).JSON()["seasonal_effects"]; got != true {
		t.Fatalf("status default %v", got)
	}
	alice.Do("GET", "/api/v1/admin/appearance", nil).Expect(403)
	alice.Do("PUT", "/api/v1/admin/appearance", map[string]any{"seasonal_effects": false}).Expect(403)
	if got := admin.Do("GET", "/api/v1/admin/appearance", nil).Expect(200).JSON()["seasonal_effects"]; got != true {
		t.Fatalf("admin default %v", got)
	}
	admin.Do("PUT", "/api/v1/admin/appearance", map[string]any{}).Expect(422)
	if got := admin.Do("PUT", "/api/v1/admin/appearance", map[string]any{"seasonal_effects": false}).Expect(200).JSON()["seasonal_effects"]; got != false {
		t.Fatalf("admin put %v", got)
	}
	if got := alice.Do("GET", "/api/v1/status", nil).Expect(200).JSON()["seasonal_effects"]; got != false {
		t.Fatalf("status after off %v", got)
	}
	// TVs read the same flag.
	_, cred := env.Pair(alice, "TV")
	tv := env.Client()
	tv.Bearer = cred
	if got := tv.Do("GET", "/api/v1/status", nil).Expect(200).JSON()["seasonal_effects"]; got != false {
		t.Fatalf("tv status %v", got)
	}
	tv.Do("PUT", "/api/v1/admin/appearance", map[string]any{"seasonal_effects": true}).Expect(403)
	admin.Do("PUT", "/api/v1/admin/appearance", map[string]any{"seasonal_effects": true}).Expect(200)
	if got := admin.Do("GET", "/api/v1/admin/appearance", nil).Expect(200).JSON()["seasonal_effects"]; got != true {
		t.Fatalf("back on %v", got)
	}
}
