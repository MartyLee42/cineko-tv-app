package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeRelease(t *testing.T, files ...string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>"+strings.Join(files, ",")+"</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		p := filepath.Join(dir, "assets", f)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("// "+f), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// Each release adds its assets; old ones stay while recent or in the last
// few releases, then go. Release lists never pile up.
func TestAssetArchive(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "music")
	day := 24 * time.Hour
	t0 := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	a := writeRelease(t, "index-A.js", "Lazy-A.js")
	if err := archiveAssets(a, archive, t0); err != nil {
		t.Fatal(err)
	}
	// The same build restarting: no new release list.
	if err := archiveAssets(a, archive, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if l, _ := releaseLists(filepath.Join(archive, "releases")); len(l) != 1 {
		t.Fatalf("lists after restart: %v", l)
	}
	// B, much later: A's files are old but A is among the last releases.
	b := writeRelease(t, "index-B.js", "Lazy-B.js", "shared-S.js")
	if err := archiveAssets(b, archive, t0.Add(30*day)); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"Lazy-A.js", "Lazy-B.js", "shared-S.js"} {
		if !exists(filepath.Join(archive, "assets", f)) {
			t.Errorf("%s missing after B", f)
		}
	}
	// C and D: A drops out of the last three releases and is long past the age limit.
	if err := archiveAssets(writeRelease(t, "index-C.js"), archive, t0.Add(31*day)); err != nil {
		t.Fatal(err)
	}
	if err := archiveAssets(writeRelease(t, "index-D.js"), archive, t0.Add(32*day)); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(archive, "assets", "Lazy-A.js")) {
		t.Error("A's chunk kept past both limits")
	}
	// B is out of the last three now too, but still young: kept.
	if err := archiveAssets(writeRelease(t, "index-E.js"), archive, t0.Add(33*day)); err != nil {
		t.Fatal(err)
	}
	if !exists(filepath.Join(archive, "assets", "Lazy-B.js")) {
		t.Error("B's chunk pruned while younger than the age limit")
	}
	if l, _ := releaseLists(filepath.Join(archive, "releases")); len(l) > 4 {
		t.Errorf("release lists pile up: %v", l)
	}
}

// A page of the previous release gets its chunk from the archive; index.html
// never comes from there; a chunk nowhere is a 404 that isn't cached.
func TestServeSPAFallsBackToArchive(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "music")
	if err := archiveAssets(writeRelease(t, "index-A.js", "GhostMeter-A.js"), archive, time.Now()); err != nil {
		t.Fatal(err)
	}
	cur := writeRelease(t, "index-B.js")
	get := func(rel, arch string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		serveSPA(w, httptest.NewRequest(http.MethodGet, "/music/"+rel, nil), cur, arch, rel)
		return w
	}
	if w := get("assets/GhostMeter-A.js", archive); w.Code != 200 || !strings.Contains(w.Header().Get("Cache-Control"), "immutable") || !strings.Contains(w.Body.String(), "GhostMeter-A") {
		t.Errorf("archived chunk: %d %q", w.Code, w.Header().Get("Cache-Control"))
	}
	if w := get("assets/index-B.js", archive); w.Code != 200 {
		t.Errorf("current chunk: %d", w.Code)
	}
	if w := get("assets/GhostMeter-A.js", ""); w.Code != 404 || w.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("archive off: %d %q", w.Code, w.Header().Get("Cache-Control"))
	}
	if w := get("assets/../../index.html", archive); strings.Contains(w.Body.String(), "index-A") {
		t.Error("archive served outside assets")
	}
	if w := get("", archive); !strings.Contains(w.Body.String(), "index-B") {
		t.Errorf("index.html not from the current build: %q", w.Body.String())
	}
}
