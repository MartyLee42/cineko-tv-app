package server_test

import (
	"context"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

func TestLoginAndSession(t *testing.T) {
	env := testutil.New(t)
	env.CreateUser("alice", "alice-password-1", "user")
	c := env.Client()

	c.Do("GET", "/api/v1/auth/session", nil).Expect(401)
	c.Login("alice", "alice-password-1")
	s := c.Do("GET", "/api/v1/auth/session", nil).Expect(200).JSON()
	if s["kind"] != "session" || s["csrf_token"] == "" {
		t.Fatalf("unexpected session %v", s)
	}
	c.Do("POST", "/api/v1/auth/logout", nil).Expect(204)
	c.Do("GET", "/api/v1/auth/session", nil).Expect(401)
}

func TestLoginDoesNotRevealUsernames(t *testing.T) {
	env := testutil.New(t)
	env.CreateUser("alice", "alice-password-1", "user")
	c := env.Client()
	wrongPw := c.Do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "nope-nope-nope"})
	noUser := c.Do("POST", "/api/v1/auth/login", map[string]string{"username": "nobody", "password": "nope-nope-nope"})
	wrongPw.Expect(401)
	noUser.Expect(401)
	if wrongPw.ErrorCode() != noUser.ErrorCode() || wrongPw.JSON()["error"].(map[string]any)["message"] != noUser.JSON()["error"].(map[string]any)["message"] {
		t.Fatal("unknown user and wrong password must look identical")
	}
}

func TestLoginLockout(t *testing.T) {
	env := testutil.New(t)
	env.CreateUser("alice", "alice-password-1", "user")
	c := env.Client()
	for i := 0; i < 5; i++ {
		c.Do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "wrong-password"}).Expect(401)
	}
	r := c.Do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "alice-password-1"})
	r.Expect(429)
	if r.Header.Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header")
	}
}

func TestSessionIdleExpiry(t *testing.T) {
	env := testutil.New(t, func(c *config.Config) { c.SessionIdleTTL = time.Second })
	c, _ := env.NewUserClient("alice", "user")
	c.Do("GET", "/api/v1/auth/session", nil).Expect(200)
	time.Sleep(1500 * time.Millisecond)
	c.Do("GET", "/api/v1/auth/session", nil).Expect(401)
}

func TestCSRFAndOrigin(t *testing.T) {
	env := testutil.New(t)
	c, _ := env.NewUserClient("alice", "user")
	body := map[string]string{"name": "Kids"}

	csrf := c.CSRF
	c.CSRF = ""
	if r := c.Do("POST", "/api/v1/profiles", body).Expect(403); r.ErrorCode() != "csrf_failed" {
		t.Fatalf("got %s", r.ErrorCode())
	}
	c.CSRF = "forged"
	c.Do("POST", "/api/v1/profiles", body).Expect(403)

	c.CSRF = csrf
	c.Origin = "https://evil.example"
	if r := c.Do("POST", "/api/v1/profiles", body).Expect(403); r.ErrorCode() != "bad_origin" {
		t.Fatalf("got %s", r.ErrorCode())
	}
	c.Origin = env.Origin
	c.Do("POST", "/api/v1/profiles", body).Expect(201)
}

func TestAPITokenScopesAndRevocation(t *testing.T) {
	env := testutil.New(t)
	c, _ := env.NewUserClient("alice", "user")

	// Non-admins cannot mint admin tokens.
	c.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "x", "scopes": []string{"admin"}}).Expect(422)

	res := c.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "script", "scopes": []string{"read"}}).Expect(201).JSON()
	secret := res["secret"].(string)
	tokenID := res["token"].(map[string]any)["id"].(string)

	bot := env.Client()
	bot.Bearer = secret
	bot.Do("GET", "/api/v1/profiles", nil).Expect(200)
	if r := bot.Do("POST", "/api/v1/profiles", map[string]string{"name": "Bot"}).Expect(403); r.ErrorCode() != "insufficient_scope" {
		t.Fatalf("got %s", r.ErrorCode())
	}
	// Tokens cannot mint more tokens or change passwords.
	bot.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "y", "scopes": []string{"read"}}).Expect(403)

	c.Do("DELETE", "/api/v1/auth/tokens/"+tokenID, nil).Expect(204)
	bot.Do("GET", "/api/v1/profiles", nil).Expect(401)
}

func TestExpiredAPIToken(t *testing.T) {
	env := testutil.New(t)
	c, u := env.NewUserClient("alice", "user")
	res := c.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "t", "scopes": []string{"read"}}).Expect(201).JSON()
	_, err := env.Pool.Exec(context.Background(), `UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	bot := env.Client()
	bot.Bearer = res["secret"].(string)
	bot.Do("GET", "/api/v1/profiles", nil).Expect(401)
}

func TestLogoutAllWithDevices(t *testing.T) {
	env := testutil.New(t)
	c, _ := env.NewUserClient("alice", "user")
	other := env.Client().Login("alice", "password-alice")
	_, cred := env.Pair(c, "TV")
	tv := env.Client()
	tv.Bearer = cred
	tv.Do("GET", "/api/v1/devices/me", nil).Expect(200)

	c.Do("POST", "/api/v1/auth/logout-all", map[string]bool{"include_devices": true}).Expect(204)
	c.Do("GET", "/api/v1/auth/session", nil).Expect(401)
	other.Do("GET", "/api/v1/auth/session", nil).Expect(401)
	tv.Do("GET", "/api/v1/devices/me", nil).Expect(401)
}

func TestChangePasswordRevokesOtherSessions(t *testing.T) {
	env := testutil.New(t)
	c, _ := env.NewUserClient("alice", "user")
	other := env.Client().Login("alice", "password-alice")
	c.Do("POST", "/api/v1/auth/password", map[string]string{"current_password": "wrong", "new_password": "new-password-123"}).Expect(422)
	c.Do("POST", "/api/v1/auth/password", map[string]string{"current_password": "password-alice", "new_password": "new-password-123"}).Expect(204)
	c.Do("GET", "/api/v1/auth/session", nil).Expect(200)
	other.Do("GET", "/api/v1/auth/session", nil).Expect(401)
	env.Client().Login("alice", "new-password-123")
}

func TestAdminDisableUser(t *testing.T) {
	env := testutil.New(t)
	admin, adminUser := env.NewUserClient("root", "admin")
	alice, aliceUser := env.NewUserClient("alice", "user")
	_, cred := env.Pair(alice, "TV")

	// Non-admins cannot use admin endpoints.
	alice.Do("GET", "/api/v1/admin/users", nil).Expect(403)
	alice.Do("PATCH", "/api/v1/admin/users/"+aliceUser.ID, map[string]string{"role": "admin"}).Expect(403)

	admin.Do("PATCH", "/api/v1/admin/users/"+aliceUser.ID, map[string]bool{"disabled": true}).Expect(200)
	alice.Do("GET", "/api/v1/auth/session", nil).Expect(401)
	env.Client().Do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "password-alice"}).Expect(401)
	tv := env.Client()
	tv.Bearer = cred
	tv.Do("GET", "/api/v1/devices/me", nil).Expect(401)

	// The last active admin cannot lock themselves out.
	if r := admin.Do("PATCH", "/api/v1/admin/users/"+adminUser.ID, map[string]bool{"disabled": true}).Expect(409); r.ErrorCode() != "self_lockout" {
		t.Fatalf("got %s", r.ErrorCode())
	}
}

func TestAdminCreatedUserGetsDefaultProfile(t *testing.T) {
	env := testutil.New(t)
	admin, _ := env.NewUserClient("root", "admin")
	admin.Do("POST", "/api/v1/admin/users", map[string]string{"username": "kid", "display_name": "Little One", "password": "kid-password-123"}).Expect(201)
	kid := env.Client().Login("kid", "kid-password-123")
	items := kid.Do("GET", "/api/v1/profiles", nil).Expect(200).Items()
	if len(items) != 1 || items[0]["name"] != "Little One" {
		t.Fatalf("profiles %v", items)
	}
	kid.Do("GET", "/api/v1/profiles/"+items[0]["id"].(string)+"/preferences", nil).Expect(200)
}

// A user (or the TV of a user) with no profiles gets one named after them.
func TestDefaultProfileCreatedWhenNone(t *testing.T) {
	env := testutil.New(t)
	c, u := env.NewUserClient("dana", "user")
	if _, err := env.Pool.Exec(context.Background(), `UPDATE users SET display_name = 'Dana K.' WHERE id = $1`, u.ID); err != nil {
		t.Fatal(err)
	}
	items := c.Do("GET", "/api/v1/profiles", nil).Expect(200).Items()
	if len(items) != 1 || items[0]["name"] != "Dana K." {
		t.Fatalf("profiles %v", items)
	}
	// Deleting it brings a fresh default back on the next list (TV path too).
	c.Do("DELETE", "/api/v1/profiles/"+items[0]["id"].(string), nil).Expect(204)
	_, cred := env.Pair(c, "TV")
	tv := env.Client()
	tv.Bearer = cred
	if items := tv.Do("GET", "/api/v1/profiles", nil).Expect(200).Items(); len(items) != 1 || items[0]["name"] != "Dana K." {
		t.Fatalf("tv profiles %v", items)
	}
	// Repeated calls never duplicate it.
	c.Do("GET", "/api/v1/profiles", nil).Expect(200)
	if n := len(c.Do("GET", "/api/v1/profiles", nil).Items()); n != 1 {
		t.Fatalf("duplicated default: %d", n)
	}
}
