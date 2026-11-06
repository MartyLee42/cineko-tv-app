package releases_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	"martytv/api/internal/config"
	"martytv/api/internal/integrations/jacred"
	"martytv/api/internal/sources"
	"martytv/api/internal/testutil"
)

func newMockJacred(t *testing.T) (*httptest.Server, *int) {
	t.Helper()
	body, err := os.ReadFile("../integrations/jacred/testdata/matrix.json")
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		if strings.Contains(r.URL.Query().Get("search"), "Матрица") {
			_, _ = w.Write(body)
			return
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	t.Cleanup(srv.Close)
	return srv, &n
}

func TestReleasesMergeJacredWithProwlarr(t *testing.T) {
	tm, pm := newMockTMDB(t), newMockProwlarr(t)
	jm, jcalls := newMockJacred(t)
	env := testutil.New(t, configure(tm.URL, pm))
	env.Server.Sources.Register(jacred.NewProvider(config.JacredConfig{URL: jm.URL}))
	c, _ := env.NewUserClient("alice", "user")
	id := insertMedia(t, env, "movie", 603)

	l := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases?lang=ru", nil).Expect(200))
	if *jcalls != 1 {
		t.Fatalf("jacred calls %d", *jcalls)
	}
	byProvider := map[string]int{}
	seen := map[string]bool{}
	for _, it := range l.Items {
		p, ok := it["provider"].(map[string]any)
		if !ok || p["kind"] != "torrent" || p["name"] == "" {
			t.Fatalf("provider chip %v", it["provider"])
		}
		byProvider[p["id"].(string)]++
		rid := it["id"].(string)
		if seen[rid] {
			t.Fatalf("duplicate release %s", rid)
		}
		seen[rid] = true
		if rid == matrixResults[0].hash && p["id"] != "prowlarr" {
			t.Fatalf("shared info hash should keep the Prowlarr copy: %v", p)
		}
	}
	if byProvider["prowlarr"] != 3 || byProvider["jacred"] < 4 {
		t.Fatalf("by provider %v (%q)", byProvider, titles(l))
	}
	// Jacred's own voices[] are merged into voiceovers.
	for _, it := range l.Items {
		if strings.HasPrefix(it["title"].(string), "Матрица / The Matrix (1999) UHD BDRemux 2160p от ExKinoRay") {
			if vo := it["voiceovers"].([]any); len(vo) == 0 {
				t.Fatalf("no voiceovers on jacred item")
			}
		}
	}
	// A Jacred release is playable: retrieval stored with its magnet.
	var magnet, provider string
	if err := env.Pool.QueryRow(context.Background(), `SELECT magnet_uri, provider FROM release_sources
		WHERE release_id = 'bd25c3ccb27fd04219bc3b083ef976a1b47f57a6'`).Scan(&magnet, &provider); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(magnet, "magnet:?xt=urn:btih:bd25") || provider != "jacred" {
		t.Fatalf("stored %q %q", magnet, provider)
	}
	// A profile that only uses Jacred: Prowlarr is not searched.
	prof := c.Do("POST", "/api/v1/profiles", map[string]string{"name": "J"}).Expect(201).JSON()
	pid := prof["id"].(string)
	st := c.Do("PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"sources": map[string]any{"enabled": []string{"jacred"}}}).Expect(200).JSON()
	if en := st["sources"].(map[string]any)["enabled"]; len(en.([]any)) != 1 {
		t.Fatalf("settings %v", st["sources"])
	}
	before := pm.searches.Load()
	l2 := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases?profile_id="+pid, nil).Expect(200))
	if pm.searches.Load() != before || len(l2.Items) == 0 {
		t.Fatalf("prowlarr searched %d→%d, items %d", before, pm.searches.Load(), len(l2.Items))
	}
	for _, it := range l2.Items {
		if it["provider"].(map[string]any)["id"] != "jacred" {
			t.Fatalf("non-jacred item %v", it["provider"])
		}
	}
	// Profile with no torrent source at all: empty list, nothing searched.
	c.Do("PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"sources": map[string]any{"enabled": []string{}}}).Expect(200)
	calls := *jcalls
	l3 := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases?profile_id="+pid, nil).Expect(200))
	if len(l3.Items) != 0 || *jcalls != calls {
		t.Fatalf("empty selection searched: %d items", len(l3.Items))
	}
}

func TestReleasesOneProviderFailing(t *testing.T) {
	tm, pm := newMockTMDB(t), newMockProwlarr(t)
	env := testutil.New(t, configure(tm.URL, pm))
	env.Server.Sources.Register(&sources.FakeTorrent{Fake: sources.Fake{
		Desc: sources.Info{ID: "broken", Kind: sources.KindTorrent, Title: "Broken", Configured: true},
		Err:  errors.New("boom")}})
	c, _ := env.NewUserClient("alice", "user")
	id := insertMedia(t, env, "movie", 603)
	l := decode(t, c.Do("GET", "/api/v1/media/"+id+"/releases", nil).Expect(200))
	if len(l.Items) != 3 {
		t.Fatalf("items %q", titles(l))
	}
	found := slices.ContainsFunc(l.IndexerErrors, func(e map[string]any) bool {
		return e["indexer"] == "Broken" && strings.Contains(e["message"].(string), "boom")
	})
	if !found {
		t.Fatalf("indexer errors %v", l.IndexerErrors)
	}
	// Admin disables Prowlarr for everyone → only the broken one remains → 502.
	admin, _ := env.NewUserClient("root", "admin")
	admin.Do("PATCH", "/api/v1/admin/sources/prowlarr", map[string]any{"enabled": false}).Expect(200)
	if r := c.Do("GET", "/api/v1/media/"+id+"/releases?refresh=true", nil); r.Status != 502 {
		t.Fatalf("status %d %s", r.Status, r.Body)
	}
}
