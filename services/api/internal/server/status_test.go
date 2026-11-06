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
