package server_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/fasthttp/websocket"

	"martytv/api/internal/testutil"
)

// «Демо TV» (POST /devices/demo, /demo_tv): a hidden device per browser
// session with short-lived credentials.

func demoCred(t *testing.T, c *testutil.Client) (deviceID, cred string) {
	t.Helper()
	r := c.Do("POST", "/api/v1/devices/demo", nil).Expect(201).JSON()
	if r["expires_at"] == nil {
		t.Fatalf("demo %v", r)
	}
	return r["device_id"].(string), r["credential"].(string)
}

func TestDemoTVCredential(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")
	prof := alice.Do("POST", "/api/v1/profiles", map[string]string{"name": "Alice"}).Expect(201).JSON()
	bob, _ := env.NewUserClient("bob", "user")
	bob.Do("POST", "/api/v1/profiles", map[string]string{"name": "Bob"}).Expect(201)

	devID, cred := demoCred(t, alice)
	tv := env.Client()
	tv.Bearer = cred
	if me := tv.Do("GET", "/api/v1/devices/me", nil).Expect(200).JSON(); me["id"] != devID {
		t.Fatalf("me %v", me)
	}
	// Exactly the user's own profiles (nothing shared in).
	if ps := tv.Do("GET", "/api/v1/profiles", nil).Expect(200).Items(); len(ps) != 1 || ps[0]["id"] != prof["id"] {
		t.Fatalf("profiles %v", ps)
	}

	// The same browser session reuses its device; earlier tabs keep working.
	devID2, cred2 := demoCred(t, alice)
	if devID2 != devID || cred2 == cred {
		t.Fatalf("reuse: %s %s", devID2, devID)
	}
	tv.Do("GET", "/api/v1/devices/me", nil).Expect(200)
	// Another browser (session) of the same user gets a device of its own.
	other := env.Client().Login("alice", "password-alice")
	if d, _ := demoCred(t, other); d == devID {
		t.Fatal("second session shares the demo device")
	}

	// Hidden: no device list, no access by id, no commands, not in the admin list.
	if l := alice.Do("GET", "/api/v1/devices", nil).Expect(200).Items(); len(l) != 0 {
		t.Fatalf("devices %v", l)
	}
	alice.Do("GET", "/api/v1/devices/"+devID, nil).Expect(404)
	alice.Do("GET", "/api/v1/devices/"+devID+"/state", nil).Expect(404)
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "bob", "permission": "use"}).Expect(404)
	alice.Do("POST", "/api/v1/devices/"+devID+"/commands", map[string]any{"type": "device.request_state"}).Expect(404)
	super, _ := env.NewUserClient("root", "super_admin")
	for _, d := range super.Do("GET", "/api/v1/admin/devices", nil).Expect(200).Items() {
		if d["id"] == devID {
			t.Fatal("demo device in the admin list")
		}
	}
	for _, d := range super.Do("GET", "/api/v1/devices?scope=all", nil).Expect(200).Items() {
		if d["id"] == devID {
			t.Fatal("demo device in scope=all")
		}
	}

	// Permission parity: still a TV credential (no account endpoints).
	tv.Do("GET", "/api/v1/devices", nil).Expect(403)
	tv.Do("POST", "/api/v1/devices/demo", nil).Expect(403)

	// Health samples are not recorded.
	tv.Do("POST", "/api/v1/devices/me/health", map[string]any{"reason": "periodic", "uptime_s": 1}).Expect(204)
	var n int
	if err := env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM device_health_samples WHERE device_id = $1`, devID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("health samples %d %v", n, err)
	}

	// No realtime socket (no presence, no remote control).
	c, _, err := websocket.DefaultDialer.Dial(env.WSURL(), nil)
	if err != nil {
		t.Fatal(err)
	}
	w := newWSConn(t, c)
	w.send(msg{Type: "auth", Payload: json.RawMessage(`{"token":"` + cred + `"}`)})
	w.expectClosed()
}

func TestDemoTVAuth(t *testing.T) {
	env := testutil.New(t)
	alice, _ := env.NewUserClient("alice", "user")

	env.Client().Do("POST", "/api/v1/devices/demo", nil).Expect(401)
	// Cookie without the CSRF token, or from a foreign origin.
	noCSRF := *alice
	noCSRF.CSRF = ""
	if r := noCSRF.Do("POST", "/api/v1/devices/demo", nil).Expect(403); r.ErrorCode() != "csrf_failed" {
		t.Fatalf("got %s", r.ErrorCode())
	}
	evil := *alice
	evil.Origin = "https://evil.example"
	evil.Do("POST", "/api/v1/devices/demo", nil).Expect(403)

	// API tokens and paired TVs can't mint one.
	tok := alice.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "t", "scopes": []string{"read", "write"}}).Expect(201).JSON()["secret"].(string)
	api := env.Client()
	api.Bearer = tok
	if r := api.Do("POST", "/api/v1/devices/demo", nil).Expect(403); r.ErrorCode() != "session_required" {
		t.Fatalf("got %s", r.ErrorCode())
	}
	_, paired := env.Pair(alice, "Lounge")
	tv := env.Client()
	tv.Bearer = paired
	tv.Do("POST", "/api/v1/devices/demo", nil).Expect(403)
	// The paired TV is still listed (only demo devices are hidden).
	if l := alice.Do("GET", "/api/v1/devices", nil).Expect(200).Items(); len(l) != 1 {
		t.Fatalf("devices %v", l)
	}
}

func TestDemoTVLifetime(t *testing.T) {
	env := testutil.New(t)
	ctx := context.Background()
	alice, _ := env.NewUserClient("alice", "user")
	devID, cred := demoCred(t, alice)
	tv := env.Client()
	tv.Bearer = cred

	// An expired credential stops working; a fresh one is issued on request.
	if _, err := env.Pool.Exec(ctx, `UPDATE device_credentials SET expires_at = now() - interval '1 second' WHERE device_id = $1`, devID); err != nil {
		t.Fatal(err)
	}
	tv.Do("GET", "/api/v1/devices/me", nil).Expect(401)
	_, cred = demoCred(t, alice)
	tv.Bearer = cred
	tv.Do("GET", "/api/v1/devices/me", nil).Expect(200)

	// Live credentials per device are bounded.
	for range 8 {
		demoCred(t, alice)
	}
	var live int
	if err := env.Pool.QueryRow(ctx, `SELECT count(*) FROM device_credentials WHERE device_id = $1 AND revoked_at IS NULL`, devID).Scan(&live); err != nil || live > 5 {
		t.Fatalf("live credentials %d %v", live, err)
	}

	// Signing out of the browser ends the demo TV too.
	_, cred = demoCred(t, alice)
	tv.Bearer = cred
	tv.Do("GET", "/api/v1/devices/me", nil).Expect(200)
	alice.Do("POST", "/api/v1/auth/logout", nil).Expect(204)
	tv.Do("GET", "/api/v1/devices/me", nil).Expect(401)

	// Cleanup unpairs it and drops its credentials.
	if err := env.Server.Auth.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	var revoked bool
	var creds int
	if err := env.Pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL, (SELECT count(*) FROM device_credentials WHERE device_id = $1)
		FROM devices WHERE id = $1`, devID).Scan(&revoked, &creds); err != nil || !revoked || creds != 0 {
		t.Fatalf("after cleanup revoked=%v creds=%d %v", revoked, creds, err)
	}
}
