package config

import (
	"strings"
	"testing"
)

func TestInvidiousRestartConfig(t *testing.T) {
	base := map[string]string{"DATABASE_URL": "postgres://x", "APP_SESSION_SECRET": strings.Repeat("s", 32)}
	with := func(kv ...string) map[string]string {
		m := map[string]string{}
		for k, v := range base {
			m[k] = v
		}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	c, err := LoadFrom(env(base))
	if err != nil {
		t.Fatal(err)
	}
	if r := c.InvidiousRestart; r.Enabled() || r.At() != "off" || r.Hour != 3 || r.Location.String() != "UTC" {
		t.Fatalf("defaults %+v", r)
	}
	c, err = LoadFrom(env(with("TZ", "Asia/Almaty", "NEW_EPISODES_TZ", "Europe/Moscow",
		"INVIDIOUS_RESTART_DOCKER_URL", "http://proxy:2375/", "INVIDIOUS_RESTART_CONTAINERS", "x-companion-1, x-invidious-1,")))
	if err != nil {
		t.Fatal(err)
	}
	r := c.InvidiousRestart
	if !r.Enabled() || r.At() != "03:00" || r.Location.String() != "Asia/Almaty" || r.DockerURL != "http://proxy:2375" ||
		len(r.Containers) != 2 || r.Containers[1] != "x-invidious-1" {
		t.Fatalf("configured %+v", r)
	}
	// A bad TZ (other containers use it too) never fails the API; the next fallback wins.
	c, err = LoadFrom(env(with("TZ", "Nowhere/City", "NEW_EPISODES_TZ", "Europe/Moscow", "INVIDIOUS_RESTART_AT", "off")))
	if err != nil || c.InvidiousRestart.Location.String() != "Europe/Moscow" || !c.InvidiousRestart.Off {
		t.Fatalf("fallback %+v %v", c.InvidiousRestart, err)
	}
	for _, kv := range [][]string{
		{"INVIDIOUS_RESTART_AT", "25:00"},
		{"INVIDIOUS_RESTART_TZ", "Nowhere/City"},
		{"INVIDIOUS_RESTART_DOCKER_URL", "unix:///var/run/docker.sock"},
		{"INVIDIOUS_RESTART_CONTAINERS", "a/../b"},
	} {
		if _, err := LoadFrom(env(with(kv...))); err == nil || !strings.Contains(err.Error(), kv[0]) {
			t.Errorf("%s=%s: want an error, got %v", kv[0], kv[1], err)
		}
	}
}
