package server_test

import (
	"strings"
	"testing"

	"martytv/api/internal/testutil"
)

func TestDeviceOwnership(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	bob, bobUser := env.NewUserClient("bob", "user")
	devID, cred := env.Pair(alice, "Alice TV")

	// Bob can't see, change or revoke Alice's TV.
	bob.Do("GET", "/api/v1/devices/"+devID, nil).Expect(404)
	bob.Do("PATCH", "/api/v1/devices/"+devID, map[string]string{"name": "mine"}).Expect(404)
	bob.Do("DELETE", "/api/v1/devices/"+devID, nil).Expect(404)
	if n := len(bob.Do("GET", "/api/v1/devices", nil).Expect(200).Items()); n != 0 {
		t.Fatalf("bob sees %d devices", n)
	}

	// Shared with "control": Bob sees it but still can't manage it.
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "bob", "permission": "control"}).Expect(200)
	got := bob.Do("GET", "/api/v1/devices/"+devID, nil).Expect(200).JSON()
	if got["access"] != "control" {
		t.Fatalf("access %v", got["access"])
	}
	bob.Do("PATCH", "/api/v1/devices/"+devID, map[string]string{"name": "mine"}).Expect(403)
	bob.Do("DELETE", "/api/v1/devices/"+devID, nil).Expect(403)
	bob.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "bob", "permission": "use"}).Expect(403)

	// Sharing with unknown users or the owner fails the same way.
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "nobody", "permission": "control"}).Expect(422)
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "alice", "permission": "control"}).Expect(422)

	alice.Do("DELETE", "/api/v1/devices/"+devID+"/permissions/"+bobUser.ID, nil).Expect(204)
	bob.Do("GET", "/api/v1/devices/"+devID, nil).Expect(404)

	// A TV credential is not a user: no account endpoints.
	tv := env.Client()
	tv.Bearer = cred
	tv.Do("GET", "/api/v1/devices", nil).Expect(403)
	tv.Do("GET", "/api/v1/auth/tokens", nil).Expect(403)
	tv.Do("POST", "/api/v1/profiles", map[string]string{"name": "x"}).Expect(403)

	// Rename + revoke by the owner.
	alice.Do("PATCH", "/api/v1/devices/"+devID, map[string]string{"name": "Lounge"}).Expect(200)
	alice.Do("DELETE", "/api/v1/devices/"+devID, nil).Expect(204)
	tv.Do("GET", "/api/v1/devices/me", nil).Expect(401)
}

func TestProfileIsolation(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	ap := alice.Do("POST", "/api/v1/profiles", map[string]any{"name": "Alice", "pin": "1234"}).Expect(201).JSON()
	bp := bob.Do("POST", "/api/v1/profiles", map[string]string{"name": "Bob"}).Expect(201).JSON()
	aID, bID := ap["id"].(string), bp["id"].(string)

	if n := len(bob.Do("GET", "/api/v1/profiles", nil).Items()); n != 1 {
		t.Fatalf("bob sees %d profiles", n)
	}
	bob.Do("PATCH", "/api/v1/profiles/"+aID, map[string]string{"name": "pwned"}).Expect(404)
	bob.Do("DELETE", "/api/v1/profiles/"+aID, nil).Expect(404)
	bob.Do("GET", "/api/v1/profiles/"+aID+"/preferences", nil).Expect(404)
	bob.Do("POST", "/api/v1/profiles/"+aID+"/verify-pin", map[string]string{"pin": "1234"}).Expect(404)
	bob.Do("PATCH", "/api/v1/devices/not-a-uuid", map[string]string{"name": "x"}).Expect(404)

	// A TV sees its owner's profiles, plus a sharer's only at "use" level.
	devID, cred := env.Pair(alice, "TV")
	tv := env.Client()
	tv.Bearer = cred
	if items := tv.Do("GET", "/api/v1/profiles", nil).Items(); len(items) != 1 || items[0]["id"] != aID {
		t.Fatalf("tv profiles %v", items)
	}
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "bob", "permission": "control"}).Expect(200)
	if n := len(tv.Do("GET", "/api/v1/profiles", nil).Items()); n != 1 {
		t.Fatalf("control share must not expose profiles, got %d", n)
	}
	tv.Do("POST", "/api/v1/profiles/"+bID+"/verify-pin", map[string]string{"pin": "0000"}).Expect(404)
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "bob", "permission": "use"}).Expect(200)
	if n := len(tv.Do("GET", "/api/v1/profiles", nil).Items()); n != 2 {
		t.Fatalf("use share should expose bob's profiles, got %d", n)
	}

	// PIN checks from the TV, with lockout.
	tv.Do("POST", "/api/v1/profiles/"+aID+"/verify-pin", map[string]string{"pin": "1234"}).Expect(200)
	for i := 0; i < 5; i++ {
		tv.Do("POST", "/api/v1/profiles/"+aID+"/verify-pin", map[string]string{"pin": "9999"}).Expect(403)
	}
	tv.Do("POST", "/api/v1/profiles/"+aID+"/verify-pin", map[string]string{"pin": "1234"}).Expect(429)

	// A default profile must belong to the device owner.
	alice.Do("PATCH", "/api/v1/devices/"+devID, map[string]string{"default_profile_id": bID}).Expect(422)
	alice.Do("PATCH", "/api/v1/devices/"+devID, map[string]string{"default_profile_id": aID}).Expect(200)
}

func TestHealthEndpoints(t *testing.T) {
	env := testutil.New(t)
	c := env.Client()
	c.Do("GET", "/healthz", nil).Expect(200)
	r := c.Do("GET", "/readyz", nil).Expect(200).JSON()
	if r["database"] != "up" {
		t.Fatalf("readyz %v", r)
	}
	start := c.Do("GET", "/msx/start.json", nil).Expect(200).JSON()
	if p, _ := start["parameter"].(string); !strings.HasPrefix(p, "content:request:interaction:init@") || !strings.HasSuffix(p, "/msx/bridge.html") {
		t.Fatalf("msx start parameter %v", start["parameter"])
	}
	bridge := c.Do("GET", "/msx/bridge.html", nil).Expect(200)
	if !strings.Contains(string(bridge.Body), "TVXInteractionPlugin") || !strings.Contains(string(bridge.Body), "/api/v1/stream/") {
		t.Fatal("bridge page content")
	}
	if menu := c.Do("GET", "/msx/menu.json", nil).Expect(200).JSON(); menu["type"] != "pages" {
		t.Fatalf("menu %v", menu)
	}
	c.Do("GET", "/api/v1/nope", nil).Expect(404)
}

func TestUserDirectory(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	env.NewUserClient("bob", "user")
	admin, _ := env.NewUserClient("root", "admin")
	items := alice.Do("GET", "/api/v1/users/directory", nil).Expect(200).Items()
	if len(items) != 2 {
		t.Fatalf("directory %v", items)
	}
	for _, it := range items {
		if it["username"] == "alice" || it["password_hash"] != nil || it["role"] != nil {
			t.Fatalf("entry %v", it)
		}
	}
	_ = admin
	env.Client().Do("GET", "/api/v1/users/directory", nil).Expect(401)
}
