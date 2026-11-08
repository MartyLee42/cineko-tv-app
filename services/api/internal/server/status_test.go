package server_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

// GET /status: readers (users and TVs) see TorrServer health + latency,
// Prowlarr health and the server time; answers are cached.
func TestServiceStatus(t *testing.T) {
	var echoes atomic.Int64
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/echo":
			echoes.Add(1)
			_, _ = w.Write([]byte("MatriX.141"))
		case "/torrents":
			_, _ = w.Write([]byte("[]"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	env := testutil.New(t, func(c *config.Config) { c.TorrServer.URL = ts.URL })
	env.Client().Do("GET", "/api/v1/status", nil).Expect(401)

	alice, _ := env.NewUserClient("alice", "user")
	got := alice.Do("GET", "/api/v1/status", nil).Expect(200).JSON()
	torr := got["torrserver"].(map[string]any)
	if torr["ok"] != true {
		t.Fatalf("torrserver %v", torr)
	}
	if _, ok := torr["latency_ms"].(float64); !ok {
		t.Fatalf("latency_ms %v", torr["latency_ms"])
	}
	if p := got["prowlarr"].(map[string]any); p["ok"] != false {
		t.Fatalf("prowlarr (not configured) %v", p)
	}
	if _, ok := got["server_time"].(string); !ok {
		t.Fatalf("server_time %v", got["server_time"])
	}
	if _, ok := got["active_streams"].(float64); !ok {
		t.Fatalf("active_streams %v", got["active_streams"])
	}
	// CPU: null before the first sample, a percentage after one.
	if v, ok := got["cpu_percent"]; !ok || v != nil {
		t.Fatalf("cpu_percent before a sample = %v (present %v), want null", v, ok)
	}
	env.Server.Sysmon.Tick()
	if v, ok := alice.Do("GET", "/api/v1/status", nil).Expect(200).JSON()["cpu_percent"].(float64); !ok || v < 0 || v > 100 {
		t.Fatalf("cpu_percent after a sample = %v", v)
	}

	// A paired TV may read it too; the answer comes from the cache.
	before := echoes.Load()
	_, cred := env.Pair(alice, "TV")
	tv := env.Client()
	tv.Bearer = cred
	tv.Do("GET", "/api/v1/status", nil).Expect(200)
	if echoes.Load() != before {
		t.Fatalf("status not cached: %d → %d echoes", before, echoes.Load())
	}
}

// TorrServer down: ok false and no latency.
func TestServiceStatusTorrServerDown(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusBadGateway) }))
	defer ts.Close()
	env := testutil.New(t, func(c *config.Config) { c.TorrServer.URL = ts.URL })
	alice, _ := env.NewUserClient("alice", "user")
	torr := alice.Do("GET", "/api/v1/status", nil).Expect(200).JSON()["torrserver"].(map[string]any)
	if torr["ok"] != false || torr["latency_ms"] != nil {
		t.Fatalf("torrserver %v", torr)
	}
}

// GET /status features follow the install options (VIDEO_ENABLED,
// MUSIC_ENABLED, INDEXER); off = also no Invidious / Prowlarr checks.
func TestServiceStatusFeatures(t *testing.T) {
	env := testutil.New(t, func(c *config.Config) { c.Video.InvidiousURL = "http://invidious.invalid:3000" })
	alice, _ := env.NewUserClient("alice", "user")
	f := alice.Do("GET", "/api/v1/status", nil).Expect(200).JSON()["features"].(map[string]any)
	if f["video"] != true || f["music"] != true || f["torrents"] != true {
		t.Fatalf("defaults %v", f)
	}

	off := testutil.New(t, func(c *config.Config) {
		c.Video.Enabled, c.Video.InvidiousURL = false, ""
		c.MusicEnabled = false
		c.Indexer, c.Prowlarr = config.IndexerNone, config.ProwlarrConfig{}
	})
	bob, _ := off.NewUserClient("bob", "user")
	f = bob.Do("GET", "/api/v1/status", nil).Expect(200).JSON()["features"].(map[string]any)
	if f["video"] != false || f["music"] != false || f["torrents"] != false {
		t.Fatalf("off %v", f)
	}
	if code := bob.Do("GET", "/api/v1/video/trending", nil).Expect(503).ErrorCode(); code != "video_unavailable" {
		t.Fatalf("video off: %s", code)
	}
	admin, _ := off.NewUserClient("root", "admin")
	for _, it := range admin.Do("GET", "/api/v1/admin/integrations", nil).Expect(200).Items() {
		if it["name"] == "prowlarr" || it["name"] == "jackett" {
			t.Fatalf("INDEXER=none still checks %v", it["name"])
		}
	}
}
