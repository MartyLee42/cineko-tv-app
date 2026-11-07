package config

import (
	"slices"
	"strings"
	"testing"
)

func TestDeriveCookieDomain(t *testing.T) {
	for _, tc := range []struct{ a, b, want string }{
		{"tv.example.com", "music.example.com", "example.com"},
		{"example.com", "music.example.com", "example.com"},
		{"TV.Example.com", "music.example.com.", "example.com"},
		{"tv.home.example.org", "music.home.example.org", "home.example.org"},
		{"tv.example.com", "music.tv.example.com", "tv.example.com"},
		{"tv.example.co.uk", "music.example.co.uk", "example.co.uk"},
		{"tv.example.com", "music.example.com", "example.com"},
		// Never a public suffix: the browser would drop the cookie.
		{"a.co.uk", "b.co.uk", ""},
		{"alice.github.io", "music.github.io", ""},
		{"tv.example.com", "music.other.com", ""},
		{"tv.example.com", "tv.example.com", ""},
		{"192.168.1.10", "music.example.com", ""},
		{"localhost", "music.localhost", ""},
		{"", "music.example.com", ""},
	} {
		if got := DeriveCookieDomain(tc.a, tc.b); got != tc.want {
			t.Errorf("DeriveCookieDomain(%q, %q) = %q, want %q", tc.a, tc.b, got, tc.want)
		}
	}
}

func musicEnv(extra map[string]string) func(string) string {
	m := map[string]string{
		"DATABASE_URL":       "postgres://x",
		"APP_SESSION_SECRET": strings.Repeat("s", 32),
		"PUBLIC_BASE_URL":    "https://tv.example.com",
	}
	for k, v := range extra {
		m[k] = v
	}
	return env(m)
}

func TestMusicDomain(t *testing.T) {
	c, err := LoadFrom(musicEnv(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.MusicDomain != "" || c.CookieDomain != "" || len(c.AllowedOrigins) != 1 {
		t.Fatalf("unset MUSIC_DOMAIN changed things: %q %q %v", c.MusicDomain, c.CookieDomain, c.AllowedOrigins)
	}

	for _, in := range []string{"music.example.com", " Music.Example.com ", "https://music.example.com/"} {
		c, err := LoadFrom(musicEnv(map[string]string{"MUSIC_DOMAIN": in}))
		if err != nil {
			t.Fatal(err)
		}
		if c.MusicDomain != "music.example.com" || c.CookieDomain != "example.com" {
			t.Fatalf("%q: domain %q cookie %q", in, c.MusicDomain, c.CookieDomain)
		}
		if !slices.Contains(c.AllowedOrigins, "https://music.example.com") || !slices.Contains(c.AllowedOrigins, "https://tv.example.com") {
			t.Fatalf("%q: origins %v", in, c.AllowedOrigins)
		}
	}

	// A plain-HTTP main site keeps the scheme for the music origin.
	c, err = LoadFrom(musicEnv(map[string]string{"PUBLIC_BASE_URL": "http://tv.example.test:8080", "MUSIC_DOMAIN": "music.example.test:8080"}))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(c.AllowedOrigins, "http://music.example.test:8080") || c.CookieDomain != "example.test" {
		t.Fatalf("http: origins %v cookie %q", c.AllowedOrigins, c.CookieDomain)
	}

	// Unrelated domains: allowed origin, but a host-only cookie.
	c, err = LoadFrom(musicEnv(map[string]string{"MUSIC_DOMAIN": "music.example.net"}))
	if err != nil || c.CookieDomain != "" || !slices.Contains(c.AllowedOrigins, "https://music.example.net") {
		t.Fatalf("unrelated: %v %q %v", err, c.CookieDomain, c.AllowedOrigins)
	}

	for _, bad := range []string{"music.example.com/x", "https://music.example.com/path", "user@music.example.com", ".example.com"} {
		if _, err := LoadFrom(musicEnv(map[string]string{"MUSIC_DOMAIN": bad})); err == nil || !strings.Contains(err.Error(), "MUSIC_DOMAIN") {
			t.Errorf("MUSIC_DOMAIN=%q: expected an error, got %v", bad, err)
		}
	}
}

func TestCookieDomainOverride(t *testing.T) {
	c, err := LoadFrom(musicEnv(map[string]string{"MUSIC_DOMAIN": "music.example.com", "COOKIE_DOMAIN": "off"}))
	if err != nil || c.CookieDomain != "" {
		t.Fatalf("off: %v %q", err, c.CookieDomain)
	}
	c, err = LoadFrom(musicEnv(map[string]string{"COOKIE_DOMAIN": ".Example.com"}))
	if err != nil || c.CookieDomain != "example.com" {
		t.Fatalf("explicit: %v %q", err, c.CookieDomain)
	}
	for _, bad := range []string{"other.com", "com", "ample.com"} {
		if _, err := LoadFrom(musicEnv(map[string]string{"COOKIE_DOMAIN": bad})); err == nil || !strings.Contains(err.Error(), "COOKIE_DOMAIN") {
			t.Errorf("COOKIE_DOMAIN=%q: expected an error, got %v", bad, err)
		}
	}
}
