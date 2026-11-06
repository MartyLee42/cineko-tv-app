package server

import (
	"net/url"
	"testing"

	"martytv/api/internal/config"
)

func TestMSXApps(t *testing.T) {
	u, _ := url.Parse("https://tv.example.com")
	cfg := &config.Config{PublicBaseURL: u}
	apps := msxApps(cfg)
	if len(apps) != 2 || apps[0].URL != "https://tv.example.com/tv/" || apps[1].Label != "Lampa" {
		t.Fatalf("defaults %+v", apps)
	}
	cfg.MSXApps = `[{"label":"YouTube","icon":"smart-display","url":"https://youtube.com/tv"},{"label":"bad","url":"javascript:alert(1)"},{"label":"","url":"https://x"}]`
	apps = msxApps(cfg)
	if len(apps) != 2 || apps[1].Label != "YouTube" {
		t.Fatalf("custom %+v", apps)
	}
	cfg.MSXApps = `not json`
	if apps = msxApps(cfg); len(apps) != 2 || apps[1].Label != "Lampa" {
		t.Fatalf("invalid json should fall back to defaults: %+v", apps)
	}
	if got := msxLayout(0, 2) + " " + msxLayout(1, 2); got != "2,1,4,4 6,1,4,4" {
		t.Fatalf("two-app layout %q", got)
	}
	if got := msxLayout(4, 5); got != "4,3,4,3" {
		t.Fatalf("grid layout %q", got)
	}
}
