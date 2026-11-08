package server_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

func getMetrics(t *testing.T, env *testutil.Env, token string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("GET", env.BaseURL+"/metrics", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// GET /metrics: 404 without METRICS_TOKEN; with it, bearer only, and the
// snapshot carries DB counts, device health and request counters by route.
func TestMetricsEndpoint(t *testing.T) {
	off := testutil.New(t)
	if code, _ := getMetrics(t, off, "x"); code != 404 {
		t.Fatalf("disabled: %d", code)
	}
	if off.Server.Metrics != nil {
		t.Fatal("refresher built while disabled")
	}

	env := testutil.New(t, func(c *config.Config) { c.MetricsToken = "scrape-me" })
	if code, _ := getMetrics(t, env, ""); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := getMetrics(t, env, "nope"); code != 401 {
		t.Fatalf("wrong token: %d", code)
	}

	alice, _ := env.NewUserClient("alice", "user")
	devID, cred := env.Pair(alice, "Living room")
	tv := env.Client()
	tv.Bearer = cred
	tv.Do("POST", "/api/v1/devices/me/health", map[string]any{"reason": "periodic", "model": "TX3", "fps": 50, "heap_used_mb": 10}).Expect(201)

	env.Server.Metrics.Refresh(context.Background())
	code, body := getMetrics(t, env, "scrape-me")
	if code != 200 {
		t.Fatalf("authorized: %d", code)
	}
	for _, want := range []string{
		`cineko_device_health_fps{device="` + devID + `",model="TX3"} 50`,
		`cineko_devices_paired 1`,
		`cineko_users 1`,
		`cineko_playback_sessions_active{client="tv"} 0`,
		`cineko_downloads{status="downloading"} 0`,
		`cineko_client_error_groups_open{app="tv"} 0`,
		`cineko_ai_enabled 0`,
		`cineko_ai_daily_token_budget`,
		`cineko_metrics_source_up{source="db"} 1`,
		`cineko_metrics_source_up{source="system"} 1`,
		`cineko_integration_configured{name="tmdb"} 0`,
		`cineko_db_pool_total_conns`,
		`cineko_websocket_connections{kind="devices"}`,
		`cineko_active_streams 0`,
		`cineko_instant_play_total{result="hit"} 0`,
		`cineko_host_memory_total_bytes`,
		`cineko_http_requests_total{method="POST",route="/api/v1/devices/:id/health",status="2xx"} 1`,
		`go_goroutines`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics lack %q", want)
		}
	}
	if strings.Contains(body, "Living room") {
		t.Error("device names must not appear in metrics")
	}
}
