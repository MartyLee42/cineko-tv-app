package config

import (
	"strings"
	"testing"
)

func TestTranscoderConfig(t *testing.T) {
	base := map[string]string{"DATABASE_URL": "postgres://x", "APP_SESSION_SECRET": strings.Repeat("s", 32)}
	load := func(extra map[string]string) (*Config, error) {
		env := map[string]string{}
		for k, v := range base {
			env[k] = v
		}
		for k, v := range extra {
			env[k] = v
		}
		return LoadFrom(func(k string) string { return env[k] })
	}
	c, err := load(nil)
	if err != nil || c.Transcoder.Configured() {
		t.Fatalf("default: %+v %v", c.Transcoder, err)
	}
	c, err = load(map[string]string{"TRANSCODER_URL": "http://transcoder:8090/", "TRANSCODER_SECRET": strings.Repeat("t", 32)})
	if err != nil || !c.Transcoder.Configured() || c.Transcoder.URL != "http://transcoder:8090" {
		t.Fatalf("set: %+v %v", c.Transcoder, err)
	}
	if _, err := load(map[string]string{"TRANSCODER_URL": "http://transcoder:8090", "TRANSCODER_SECRET": "short"}); err == nil || !strings.Contains(err.Error(), "TRANSCODER_SECRET") {
		t.Fatalf("short secret: %v", err)
	}
	if _, err := load(map[string]string{"TRANSCODER_URL": "transcoder:8090", "TRANSCODER_SECRET": strings.Repeat("t", 32)}); err == nil {
		t.Fatal("relative URL accepted")
	}
}
