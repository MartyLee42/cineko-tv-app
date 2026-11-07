package server_test

import (
	"net/http"
	"strings"
	"testing"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

// Cineko Music on its own host (MUSIC_DOMAIN): logins from the music origin
// pass the Origin check and get a cookie shared by both hosts.
func TestMusicHostSharedSession(t *testing.T) {
	const music = "https://music.example.test"
	env := testutil.New(t, func(c *config.Config) {
		c.AllowedOrigins = append(c.AllowedOrigins, music)
		c.CookieDomain = "example.test"
	})
	env.CreateUser("alice", "alice-password-1", "user")
	c := env.Client()
	c.Origin = music

	r := c.Do("POST", "/api/v1/auth/login", map[string]string{"username": "alice", "password": "alice-password-1"}).Expect(200)
	csrf := r.JSON()["csrf_token"].(string)
	var token string
	for _, raw := range r.Header.Values("Set-Cookie") {
		ck, err := http.ParseSetCookie(raw)
		if err != nil {
			t.Fatal(err)
		}
		if ck.Domain == "example.test" && ck.Value != "" {
			token = ck.Value
		}
	}
	if token == "" {
		t.Fatalf("no shared cookie in %q", r.Header.Values("Set-Cookie"))
	}

	// An old host-only cookie (stale) next to the shared one: the valid one wins.
	cookie := "mt_session=mts_stale-old-cookie; mt_session=" + token
	c.Do("GET", "/api/v1/auth/session", nil, "Cookie", cookie).Expect(200)
	c.CSRF = csrf

	// Other origins are still refused.
	c.Origin = "https://music.evil.test"
	if code := c.Do("POST", "/api/v1/auth/logout", nil, "Cookie", cookie).Expect(403).ErrorCode(); code != "bad_origin" {
		t.Fatalf("evil origin: %s", code)
	}

	// Logout from the music host clears both cookie variants.
	c.Origin = music
	r = c.Do("POST", "/api/v1/auth/logout", nil, "Cookie", cookie).Expect(204)
	sc := strings.Join(r.Header.Values("Set-Cookie"), "\n")
	if strings.Count(sc, "mt_session=;") != 2 || !strings.Contains(sc, "Domain=example.test") {
		t.Fatalf("logout cookies %q", sc)
	}
	c.Do("GET", "/api/v1/auth/session", nil, "Cookie", "mt_session="+token).Expect(401)
}
