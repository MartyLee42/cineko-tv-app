package config

import (
	"strings"
	"testing"
)

func TestFeatureSwitches(t *testing.T) {
	base := func(kv ...string) map[string]string {
		m := map[string]string{"DATABASE_URL": "postgres://x", "APP_SESSION_SECRET": strings.Repeat("s", 32),
			"PROWLARR_URL": "http://prowlarr:9696", "PROWLARR_API_KEY": "pk", "JACKETT_URL": "http://jackett:9117/",
			"JACKETT_API_KEY": "jk", "INVIDIOUS_URL": "http://invidious:3000"}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	// Defaults: everything on, Prowlarr is the backend, Jackett unused.
	c, err := LoadFrom(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if !c.Video.Enabled || c.Video.InvidiousURL == "" || !c.MusicEnabled || c.Indexer != IndexerProwlarr ||
		c.Prowlarr.APIKey != "pk" || c.Jackett != (JackettConfig{}) || c.InvidiousRestart.Off {
		t.Fatalf("defaults: %+v %+v %v %q %+v", c.Video, c.InvidiousRestart, c.MusicEnabled, c.Indexer, c.Jackett)
	}
	// Video and music off.
	c, err = LoadFrom(env(base("VIDEO_ENABLED", "false", "MUSIC_ENABLED", "0")))
	if err != nil {
		t.Fatal(err)
	}
	if c.Video.Enabled || c.Video.InvidiousURL != "" || !c.InvidiousRestart.Off || c.MusicEnabled {
		t.Fatalf("off: %+v %+v %v", c.Video, c.InvidiousRestart, c.MusicEnabled)
	}
	// Jackett: Prowlarr unconfigured.
	c, err = LoadFrom(env(base("INDEXER", "Jackett")))
	if err != nil {
		t.Fatal(err)
	}
	if c.Indexer != IndexerJackett || c.Prowlarr != (ProwlarrConfig{}) || c.Jackett.URL != "http://jackett:9117" || c.Jackett.APIKey != "jk" {
		t.Fatalf("jackett: %q %+v %+v", c.Indexer, c.Prowlarr, c.Jackett)
	}
	// None: neither.
	if c, err = LoadFrom(env(base("INDEXER", "none"))); err != nil || c.Prowlarr != (ProwlarrConfig{}) || c.Jackett != (JackettConfig{}) {
		t.Fatalf("none: %v %+v %+v", err, c.Prowlarr, c.Jackett)
	}
	for _, kv := range [][2]string{{"INDEXER", "sonarr"}, {"VIDEO_ENABLED", "maybe"}, {"MUSIC_ENABLED", "2"}} {
		if _, err := LoadFrom(env(base(kv[0], kv[1]))); err == nil {
			t.Errorf("%s=%s accepted", kv[0], kv[1])
		}
	}
}
