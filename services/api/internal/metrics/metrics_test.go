package metrics

import (
	"context"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"

	"martytv/api/internal/devices"
	"martytv/api/internal/foryou"
	"martytv/api/internal/integrations"
	"martytv/api/internal/sysmon"
)

func scrape(t *testing.T, app *fiber.App, auth string) (int, string) {
	t.Helper()
	req := httptest.NewRequest("GET", "/metrics", nil)
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func TestHandlerAuth(t *testing.T) {
	off := fiber.New()
	New("", "test").Routes(off)
	if code, _ := scrape(t, off, "Bearer anything"); code != 404 {
		t.Fatalf("disabled: %d, want 404", code)
	}

	app := fiber.New()
	New("s3cret", "1.2.3").Routes(app)
	for _, h := range []string{"", "Bearer wrong", "Basic s3cret", "s3cret", "Bearer s3cret2"} {
		if code, _ := scrape(t, app, h); code != 401 {
			t.Fatalf("auth %q: %d, want 401", h, code)
		}
	}
	code, body := scrape(t, app, "Bearer s3cret")
	if code != 200 {
		t.Fatalf("authorized: %d", code)
	}
	for _, want := range []string{"go_goroutines", "process_", `cineko_build_info{version="1.2.3"} 1`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body lacks %q", want)
		}
	}
	if code, _ := scrape(t, app, "bearer s3cret"); code != 200 {
		t.Fatalf("scheme is case-insensitive: %d", code)
	}
}

func TestMiddlewareRouteTemplates(t *testing.T) {
	m := New("tok", "test")
	app := fiber.New()
	app.Use(m.Middleware())
	api := app.Group("/api/v1", func(c fiber.Ctx) error {
		if c.Get("X-Deny") != "" {
			return fiber.ErrUnauthorized // group middleware rejects before the endpoint
		}
		return c.Next()
	})
	api.Get("/media/:id", func(c fiber.Ctx) error { return c.SendString(c.Params("id")) })
	api.Post("/boom", func(c fiber.Ctx) error { return errors.New("boom") })
	api.Use(func(c fiber.Ctx) error { return fiber.ErrNotFound })

	do := func(method, path string, hdr ...string) {
		req := httptest.NewRequest(method, path, nil)
		if len(hdr) == 2 {
			req.Header.Set(hdr[0], hdr[1])
		}
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	do("GET", "/api/v1/media/abc")
	do("GET", "/api/v1/media/def")
	do("GET", "/api/v1/media/ghi", "X-Deny", "1")
	do("POST", "/api/v1/boom")
	do("GET", "/api/v1/nope/123")
	do("GET", "/wp-login.php")
	do("BREW", "/api/v1/media/abc")

	cases := []struct {
		method, route, status string
		want                  float64
	}{
		{"GET", "/api/v1/media/:id", "2xx", 2},
		{"GET", "/api/v1/media/:id", "4xx", 1},
		{"POST", "/api/v1/boom", "5xx", 1},
		{"GET", "unmatched", "4xx", 2},
	}
	for _, c := range cases {
		if got := testutil.ToFloat64(m.requests.WithLabelValues(c.method, c.route, c.status)); got != c.want {
			t.Errorf("%s %s %s = %v, want %v", c.method, c.route, c.status, got, c.want)
		}
	}
	// Raw paths never become labels.
	n := testutil.CollectAndCount(m.requests)
	if n > 6 {
		t.Errorf("%d request series, want ≤ 6", n)
	}
	if got := testutil.CollectAndCount(m.duration); got == 0 {
		t.Error("no latency series")
	}
}

func TestStatusClass(t *testing.T) {
	for code, want := range map[int]string{200: "2xx", 204: "2xx", 304: "3xx", 404: "4xx", 503: "5xx", 0: "other", 999: "other"} {
		if got := StatusClass(code); got != want {
			t.Errorf("%d → %s, want %s", code, got, want)
		}
	}
}

func TestRefresherSources(t *testing.T) {
	fail := true
	calls := 0
	now := time.Unix(1700000000, 0)
	r := NewRefresher(nil,
		Source{Name: "a", Collect: func(context.Context) ([]Family, error) {
			calls++
			return []Family{Gauge("thing", "A thing.", 3), *Vec("things", "Things.", "kind").Add(1, "x").Add(2, "y")}, nil
		}},
		Source{Name: "b", Collect: func(context.Context) ([]Family, error) {
			if fail {
				return nil, errors.New("down")
			}
			return []Family{Gauge("other", "Other.", 1)}, nil
		}},
	)
	r.now = func() time.Time { return now }
	// The first scrape refreshes inline.
	if n := testutil.CollectAndCount(r, "cineko_thing", "cineko_things"); n != 3 {
		t.Fatalf("source a: %d series", n)
	}
	if n := testutil.CollectAndCount(r, "cineko_other"); n != 0 {
		t.Fatalf("failed source emitted %d", n)
	}
	if calls != 1 {
		t.Fatalf("fresh snapshot re-read: %d calls", calls)
	}
	want := `
# HELP cineko_metrics_source_up 1 when the source's last refresh succeeded.
# TYPE cineko_metrics_source_up gauge
cineko_metrics_source_up{source="a"} 1
cineko_metrics_source_up{source="b"} 0
`
	if err := testutil.CollectAndCompare(r, strings.NewReader(want), "cineko_metrics_source_up"); err != nil {
		t.Fatal(err)
	}
	fail = false
	r.Refresh(context.Background())
	if n := testutil.CollectAndCount(r, "cineko_other"); n != 1 {
		t.Fatalf("recovered source: %d", n)
	}
	// After an idle pause the snapshot is stale: the next scrape refreshes.
	before := calls
	now = now.Add(time.Hour)
	testutil.CollectAndCount(r)
	if calls != before+1 {
		t.Fatalf("stale snapshot not refreshed: %d → %d", before, calls)
	}
}

// The real converters produce a consistent, gatherable set of names.
func TestFamiliesGather(t *testing.T) {
	dbSize := int64(5 << 20)
	budget := 120
	st := sysmon.SystemStatus{
		HostStatus: sysmon.HostStatus{
			Scope: "host", UptimeSeconds: 100, LoadAvg: [3]float64{0.5, 0.4, 0.3},
			CPU:        sysmon.CPUStatus{Cores: 4, UsagePercent: 25},
			Memory:     sysmon.Memory{Total: 8 << 30, Used: 2 << 30},
			Disks:      []sysmon.Disk{{Mount: "/", Total: 100, Used: 40, Free: 60}, {Mount: "/", Total: 100}},
			Network:    []sysmon.NetIface{{Iface: "eth0", RxTotal: 10, TxTotal: 20}},
			Containers: []sysmon.Container{{Name: "cineko-api-1", State: "running", CPUPercent: 50, MemBytes: 1 << 20}},
		},
		Hostmon: "ok",
		App: sysmon.App{
			DBSizeBytes: &dbSize,
			TorrServer:  sysmon.TorrServerStats{Configured: true, OK: true, Torrents: 3},
			Transcoder:  &sysmon.TranscoderStats{OK: true, ActiveJobs: 1, MaxJobs: 2, JobsStarted: 9},
			Integrations: []integrations.Status{
				{Name: "tmdb", Configured: true, OK: true},
				{Name: "kinopoisk", Configured: true, OK: false, BudgetRemaining: &budget},
			},
		},
	}
	fps, heap, model := 58.5, 100.0, "TX3"
	frames := int64(1000)
	devs := []DeviceSample{
		{DeviceID: "d1", At: time.Unix(1700000000, 0), Sample: devices.HealthSample{Model: &model, FPS: &fps, HeapUsedMB: &heap, TotalFrames: &frames}},
		{DeviceID: "d2", At: time.Unix(1700000100, 0)},
	}
	ai := foryou.AIStats{Enabled: true, TokensToday: 1000, CallsToday: 2, DailyBudget: 300000, Balance: &foryou.Balance{Total: 1.5, Currency: "USD"}}
	reachable := true
	r := NewRefresher(nil,
		Source{Name: "system", Collect: func(context.Context) ([]Family, error) { return SystemFamilies(st), nil }},
		Source{Name: "devices", Collect: func(context.Context) ([]Family, error) { return DeviceHealthFamilies(devs), nil }},
		Source{Name: "ai", Collect: func(context.Context) ([]Family, error) { return AIFamilies(ai), nil }},
		VideoSource(func() (bool, *bool, time.Duration) { return true, &reachable, 30 * time.Millisecond }),
	)
	r.Refresh(context.Background())
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(r)
	if _, err := reg.Gather(); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]int{
		"cineko_host_cpu_usage_ratio":             1,
		"cineko_host_disk_total_bytes":            1, // duplicate mount dropped
		"cineko_host_network_receive_bytes_total": 1,
		"cineko_container_running":                1,
		"cineko_db_size_bytes":                    1,
		"cineko_torrserver_torrents":              1,
		"cineko_transcoder_jobs_started_total":    1,
		"cineko_integration_up":                   2,
		"cineko_integration_budget_remaining":     1,
		"cineko_device_health_timestamp_seconds":  2,
		"cineko_device_health_fps":                1, // d2 reported nothing
		"cineko_device_health_heap_used_bytes":    1,
		"cineko_ai_tokens_today":                  1,
		"cineko_ai_balance":                       1,
		"cineko_invidious_up":                     1,
		"cineko_invidious_latency_seconds":        1,
	} {
		if got := testutil.CollectAndCount(r, name); got != want {
			t.Errorf("%s: %d series, want %d", name, got, want)
		}
	}
	want := `
# HELP cineko_device_health_heap_used_bytes JS heap used.
# TYPE cineko_device_health_heap_used_bytes gauge
cineko_device_health_heap_used_bytes{device="d1",model="TX3"} 1.048576e+08
`
	if err := testutil.CollectAndCompare(r, strings.NewReader(want), "cineko_device_health_heap_used_bytes"); err != nil {
		t.Fatal(err)
	}
}
