package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func writeBuild(t *testing.T, marker string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"index.html":           "<html>" + marker + "</html>",
		"manifest.webmanifest": `{"scope":"` + marker + `"}`,
		"assets/app-1.js":      "js",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// The /music/ build on the main host, the "/" build on Music's own host.
func TestStaticBothBases(t *testing.T) {
	st, err := openStore(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	cfg := config{DataDir: t.TempDir(), StaticDir: writeBuild(t, "/music/"), RootStaticDir: writeBuild(t, "/")}
	h := newApp(cfg, st, slog.New(slog.NewTextHandler(io.Discard, nil))).routes()
	get := func(path string) (int, string, string) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec.Code, rec.Body.String(), rec.Header().Get("Cache-Control")
	}
	for path, want := range map[string]string{
		"/music/":                     "<html>/music/</html>",
		"/music/album/42":             "<html>/music/</html>",
		"/music/manifest.webmanifest": `{"scope":"/music/"}`,
		"/":                           "<html>/</html>",
		"/album/42":                   "<html>/</html>",
		"/manifest.webmanifest":       `{"scope":"/"}`,
		"/assets/app-1.js":            "js",
		"/music/assets/app-1.js":      "js",
	} {
		code, body, _ := get(path)
		if code != 200 || body != want {
			t.Errorf("%s: %d %q, want %q", path, code, body, want)
		}
	}
	if code, _, cc := get("/assets/app-1.js"); code != 200 || !strings.Contains(cc, "immutable") {
		t.Errorf("root asset cache: %d %q", code, cc)
	}
	if code, _, _ := get("/assets/missing.js"); code != 404 {
		t.Errorf("missing root asset: %d", code)
	}
	if code, _, _ := get("/../etc/passwd"); code == 200 {
		t.Errorf("path traversal served")
	}
	// The API stays under /music/api on both hosts.
	if code, body, _ := get("/music/api/nope"); code != 404 || !strings.Contains(body, "not_found") {
		t.Errorf("api 404: %d %q", code, body)
	}

	// Without a root build nothing is served at "/".
	cfg.RootStaticDir = ""
	h = newApp(cfg, st, slog.New(slog.NewTextHandler(io.Discard, nil))).routes()
	if code, _, _ := get("/"); code != 404 {
		t.Errorf("no root build: %d", code)
	}
}

// Both mt_session cookies (old host-only + shared) reach the Cineko API, and
// /me tells the app where the main site is.
func TestSessionCookiesForwarded(t *testing.T) {
	var got atomic.Value
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var vals []string
		for _, c := range r.CookiesNamed(sessionCookie) {
			vals = append(vals, c.Value)
		}
		got.Store(strings.Join(vals, ","))
		_, _ = w.Write([]byte(`{"kind":"session","user":{"id":"u1","username":"alice","display_name":"Alice","role":"user"},"csrf_token":"c"}`))
	}))
	defer api.Close()
	st, err := openStore(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	a := newApp(config{DataDir: t.TempDir(), APIURL: api.URL, CinekoURL: "https://tv.example.com"}, st,
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	req := httptest.NewRequest(http.MethodGet, "/music/api/me", nil)
	req.Header.Set("Cookie", "mt_session=old; other=x; mt_session=shared")
	rec := httptest.NewRecorder()
	a.routes().ServeHTTP(rec, req)
	if rec.Code != 200 || got.Load() != "old,shared" {
		t.Fatalf("me: %d %q, forwarded %v", rec.Code, rec.Body.String(), got.Load())
	}
	var me struct {
		CinekoURL string `json:"cinekoUrl"`
		User      User   `json:"user"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &me); err != nil || me.CinekoURL != "https://tv.example.com" || me.User.ID != "u1" {
		t.Fatalf("me body %q", rec.Body.String())
	}
}
