package server_test

import (
	"testing"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

func TestAdminSystem(t *testing.T) {
	env := testutil.New(t, func(c *config.Config) { c.HostmonSocket = "" })
	admin, _ := env.NewUserClient("root", "admin")
	user, _ := env.NewUserClient("bob", "user")

	user.Do("GET", "/api/v1/admin/system", nil).Expect(403)
	user.Do("GET", "/api/v1/admin/system/history", nil).Expect(403)
	env.Client().Do("GET", "/api/v1/admin/system", nil).Expect(401)

	st := admin.Do("GET", "/api/v1/admin/system", nil).Expect(200).JSON()
	// No hostmon in tests: the API's own /proc.
	if st["scope"] != "container" || st["hostmon"] != "unavailable" {
		t.Fatalf("scope %v hostmon %v", st["scope"], st["hostmon"])
	}
	for _, k := range []string{"collected_at", "uptime_seconds", "load_avg", "cpu", "memory", "disks", "network", "processes", "containers", "app"} {
		if _, ok := st[k]; !ok {
			t.Fatalf("missing %s in %v", k, st)
		}
	}
	mem := st["memory"].(map[string]any)
	if mem["total"].(float64) <= 0 || len(st["load_avg"].([]any)) != 3 || len(st["processes"].([]any)) == 0 {
		t.Fatalf("host %v", st)
	}
	app := st["app"].(map[string]any)
	if app["active_streams"].(float64) != 0 || app["db_size_bytes"].(float64) <= 0 || app["go_routines"].(float64) <= 0 {
		t.Fatalf("app %v", app)
	}
	ws := app["ws_connections"].(map[string]any)
	if ws["users"].(float64) != 0 || ws["devices"].(float64) != 0 {
		t.Fatalf("ws %v", ws)
	}
	if ts := app["torrserver"].(map[string]any); ts["configured"] != false {
		t.Fatalf("torrserver %v", ts)
	}
	if _, ok := app["integrations"].([]any); !ok {
		t.Fatalf("integrations %v", app)
	}

	env.Server.Sysmon.Tick()
	h := admin.Do("GET", "/api/v1/admin/system/history?minutes=5", nil).Expect(200).JSON()
	samples := h["samples"].([]any)
	if h["scope"] != "container" || h["interval_seconds"].(float64) != 10 || len(samples) != 1 {
		t.Fatalf("history %v", h)
	}
	s := samples[0].(map[string]any)
	for _, k := range []string{"t", "cpu_percent", "mem_used", "load1", "rx_bps", "tx_bps", "active_streams"} {
		if _, ok := s[k]; !ok {
			t.Fatalf("sample missing %s: %v", k, s)
		}
	}
}
