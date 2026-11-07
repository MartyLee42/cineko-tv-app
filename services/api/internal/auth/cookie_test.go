package auth

import (
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
)

func TestSessionCookies(t *testing.T) {
	for in, want := range map[string][]string{
		"":                                nil,
		"mt_session=a":                    {"a"},
		"x=1; mt_session=a; mt_session=b": {"a", "b"},
		`mt_session="a"; mt_session=a; y=mt_session=c`:                     {"a"},
		"mt_session=; mt_session_x=b; garbage":                             nil,
		"mt_session=1;mt_session=2;mt_session=3;mt_session=4;mt_session=5": {"1", "2", "3", "4"},
	} {
		if got := sessionCookies(in); !slices.Equal(got, want) {
			t.Errorf("sessionCookies(%q) = %q, want %q", in, got, want)
		}
	}
}

func setCookies(t *testing.T, h func(c fiber.Ctx)) []string {
	t.Helper()
	app := fiber.New()
	app.Get("/", func(c fiber.Ctx) error {
		h(c)
		return c.SendStatus(204)
	})
	resp, err := app.Test(httptest.NewRequest("GET", "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	return resp.Header.Values("Set-Cookie")
}

func TestSessionCookieAttributes(t *testing.T) {
	s := &NewSession{Token: "tok", ExpiresAt: time.Now().Add(time.Hour)}

	// Host-only (no MUSIC_DOMAIN): one cookie, exactly as before.
	got := setCookies(t, func(c fiber.Ctx) { (&Middleware{secure: true}).SetCookie(c, s) })
	if len(got) != 1 || !strings.HasPrefix(got[0], "mt_session=tok;") || strings.Contains(got[0], "Domain=") {
		t.Fatalf("host-only set: %q", got)
	}
	for _, attr := range []string{"Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Expires="} {
		if !strings.Contains(got[0], attr) {
			t.Fatalf("missing %s: %q", attr, got[0])
		}
	}
	got = setCookies(t, func(c fiber.Ctx) { (&Middleware{}).ClearCookie(c) })
	if len(got) != 1 || !strings.Contains(got[0], "Max-Age=0") || strings.Contains(got[0], "Domain=") {
		t.Fatalf("host-only clear: %q", got)
	}

	// Shared domain: the old host-only cookie is deleted first, then the
	// shared one is set (order matters).
	mw := NewMiddleware(nil, nil, true).WithCookieDomain(".Example.com")
	got = setCookies(t, func(c fiber.Ctx) { mw.SetCookie(c, s) })
	if len(got) != 2 || strings.Contains(got[0], "Domain=") || !strings.Contains(got[0], "Max-Age=0") ||
		!strings.HasPrefix(got[1], "mt_session=tok;") || !strings.Contains(got[1], "Domain=example.com") ||
		!strings.Contains(got[1], "SameSite=Lax") || !strings.Contains(got[1], "Secure") {
		t.Fatalf("shared set: %q", got)
	}
	got = setCookies(t, func(c fiber.Ctx) { mw.ClearCookie(c) })
	if len(got) != 2 || strings.Contains(got[0], "Domain=") || !strings.Contains(got[1], "Domain=example.com") ||
		!strings.Contains(got[0], "Max-Age=0") || !strings.Contains(got[1], "Max-Age=0") {
		t.Fatalf("shared clear: %q", got)
	}
	// Clear then set in one response (a stale cookie on the login request).
	got = setCookies(t, func(c fiber.Ctx) { mw.ClearCookie(c); mw.SetCookie(c, s) })
	if len(got) != 4 || !strings.HasPrefix(got[3], "mt_session=tok;") {
		t.Fatalf("clear+set: %q", got)
	}
}
