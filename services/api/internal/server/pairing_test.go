package server_test

import (
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

func startPairing(t *testing.T, tv *testutil.Client) (id, secret, code string) {
	t.Helper()
	r := tv.Do("POST", "/api/v1/pairing", map[string]string{"device_name": "Living room", "platform": "tizen"}).Expect(201).JSON()
	return r["pairing_id"].(string), r["poll_secret"].(string), r["user_code"].(string)
}

func TestPairingHappyPath(t *testing.T) {
	env := testutil.New(t)
	phone, _ := env.NewUserClient("alice", "user")
	prof := phone.Do("POST", "/api/v1/profiles", map[string]string{"name": "Alice"}).Expect(201).JSON()
	tv := env.Client()
	id, secret, code := startPairing(t, tv)
	auth := []string{"Authorization", "Pairing " + secret}

	tv.Do("GET", "/api/v1/pairing/"+id, nil, auth...).Expect(200)
	if st := tv.Do("GET", "/api/v1/pairing/"+id, nil, auth...).JSON()["status"]; st != "pending" {
		t.Fatalf("status %v", st)
	}
	// Exchange before approval is refused.
	tv.Do("POST", "/api/v1/pairing/"+id+"/exchange", nil, auth...).Expect(409)

	// The phone finds the TV by its code, formatted or not.
	look := phone.Do("GET", "/api/v1/pairing/lookup?code="+code, nil).Expect(200).JSON()
	if look["pairing_id"] != id || look["device_name"] != "Living room" {
		t.Fatalf("lookup %v", look)
	}
	phone.Do("GET", "/api/v1/pairing/lookup?code=k7qm2xpd", nil).Expect(404)

	phone.Do("POST", "/api/v1/pairing/"+id+"/approve", map[string]any{"name": "Lounge TV", "default_profile_id": prof["id"]}).Expect(204)
	if st := tv.Do("GET", "/api/v1/pairing/"+id, nil, auth...).JSON()["status"]; st != "approved" {
		t.Fatalf("status %v", st)
	}

	res := tv.Do("POST", "/api/v1/pairing/"+id+"/exchange", nil, auth...).Expect(200).JSON()
	cred := res["credential"].(string)
	dev := res["device"].(map[string]any)
	if dev["name"] != "Lounge TV" || dev["default_profile_id"] != prof["id"] {
		t.Fatalf("device %v", dev)
	}

	tv.Bearer = cred
	me := tv.Do("GET", "/api/v1/devices/me", nil).Expect(200).JSON()
	if me["id"] != dev["id"] {
		t.Fatal("credential does not identify the device")
	}
	list := phone.Do("GET", "/api/v1/devices", nil).Expect(200).Items()
	if len(list) != 1 || list[0]["access"] != "owner" {
		t.Fatalf("devices %v", list)
	}
}

func TestPairingIsSingleUse(t *testing.T) {
	env := testutil.New(t)
	phone, _ := env.NewUserClient("alice", "user")
	tv := env.Client()
	id, secret, _ := startPairing(t, tv)
	auth := []string{"Authorization", "Pairing " + secret}
	phone.Do("POST", "/api/v1/pairing/"+id+"/approve", nil).Expect(204)
	tv.Do("POST", "/api/v1/pairing/"+id+"/exchange", nil, auth...).Expect(200)

	if r := tv.Do("POST", "/api/v1/pairing/"+id+"/exchange", nil, auth...).Expect(410); r.ErrorCode() != "pairing_consumed" {
		t.Fatalf("got %s", r.ErrorCode())
	}
	// A consumed request cannot be approved again, and its code no longer resolves.
	phone.Do("POST", "/api/v1/pairing/"+id+"/approve", nil).Expect(410)
}

func TestPairingBoundToInitiatingTV(t *testing.T) {
	env := testutil.New(t)
	phone, _ := env.NewUserClient("alice", "user")
	tv := env.Client()
	id, _, _ := startPairing(t, tv)
	phone.Do("POST", "/api/v1/pairing/"+id+"/approve", nil).Expect(204)

	attacker := env.Client()
	attacker.Do("GET", "/api/v1/pairing/"+id, nil, "Authorization", "Pairing wrong-secret").Expect(404)
	attacker.Do("POST", "/api/v1/pairing/"+id+"/exchange", nil, "Authorization", "Pairing wrong-secret").Expect(404)
	attacker.Do("POST", "/api/v1/pairing/"+id+"/exchange", nil).Expect(404)
}

func TestPairingExpiry(t *testing.T) {
	env := testutil.New(t, func(c *config.Config) { c.PairingTTL = time.Second })
	phone, _ := env.NewUserClient("alice", "user")
	tv := env.Client()
	id, secret, code := startPairing(t, tv)
	time.Sleep(1200 * time.Millisecond)

	phone.Do("GET", "/api/v1/pairing/lookup?code="+code, nil).Expect(404)
	phone.Do("POST", "/api/v1/pairing/"+id+"/approve", nil).Expect(410)
	auth := []string{"Authorization", "Pairing " + secret}
	if st := tv.Do("GET", "/api/v1/pairing/"+id, nil, auth...).JSON()["status"]; st != "expired" {
		t.Fatalf("status %v", st)
	}
	if r := tv.Do("POST", "/api/v1/pairing/"+id+"/exchange", nil, auth...).Expect(410); r.ErrorCode() != "pairing_expired" {
		t.Fatalf("got %s", r.ErrorCode())
	}
}

func TestPairingDeny(t *testing.T) {
	env := testutil.New(t)
	phone, _ := env.NewUserClient("alice", "user")
	tv := env.Client()
	id, secret, _ := startPairing(t, tv)
	phone.Do("POST", "/api/v1/pairing/"+id+"/deny", nil).Expect(204)
	auth := []string{"Authorization", "Pairing " + secret}
	if st := tv.Do("GET", "/api/v1/pairing/"+id, nil, auth...).JSON()["status"]; st != "denied" {
		t.Fatalf("status %v", st)
	}
	tv.Do("POST", "/api/v1/pairing/"+id+"/exchange", nil, auth...).Expect(409)
}

func TestPairingApprovalNeedsSignedInUser(t *testing.T) {
	env := testutil.New(t)
	tv := env.Client()
	id, _, code := startPairing(t, tv)
	anon := env.Client()
	anon.Do("GET", "/api/v1/pairing/lookup?code="+code, nil).Expect(401)
	anon.Do("POST", "/api/v1/pairing/"+id+"/approve", nil).Expect(401)

	// Approving with someone else's profile as default is rejected.
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	bobProfile := bob.Do("POST", "/api/v1/profiles", map[string]string{"name": "Bob"}).Expect(201).JSON()
	alice.Do("POST", "/api/v1/pairing/"+id+"/approve", map[string]any{"default_profile_id": bobProfile["id"]}).Expect(422)
}

func TestManualTokenRegistration(t *testing.T) {
	env := testutil.New(t)
	c, _ := env.NewUserClient("alice", "user")
	readOnly := c.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "r", "scopes": []string{"read"}}).Expect(201).JSON()["secret"].(string)
	reg := c.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "tv", "scopes": []string{"device:register"}}).Expect(201).JSON()["secret"].(string)

	tv := env.Client()
	tv.Bearer = readOnly
	tv.Do("POST", "/api/v1/devices/register", map[string]string{"name": "Bedroom"}).Expect(403)
	tv.Bearer = reg
	res := tv.Do("POST", "/api/v1/devices/register", map[string]string{"name": "Bedroom"}).Expect(201).JSON()
	tv.Bearer = res["credential"].(string)
	tv.Do("GET", "/api/v1/devices/me", nil).Expect(200)
}

// A TV app opened in a browser that is signed in to the PWA sends the session
// cookie with its pairing calls; they must still work without a CSRF token.
func TestPairingFromBrowserWithSessionCookie(t *testing.T) {
	env := testutil.New(t)
	browser, _ := env.NewUserClient("alice", "user")
	csrf := browser.CSRF
	browser.CSRF = "" // the TV app has no CSRF token
	id, secret, _ := startPairing(t, browser)
	browser.CSRF = csrf
	browser.Do("POST", "/api/v1/pairing/"+id+"/approve", nil).Expect(204)
	browser.CSRF = ""
	browser.Do("POST", "/api/v1/pairing/"+id+"/exchange", nil, "Authorization", "Pairing "+secret).Expect(200)
	// Other state-changing calls still require the token.
	browser.Do("POST", "/api/v1/profiles", map[string]string{"name": "x"}).Expect(403)
}
