package config

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// InvidiousRestartConfig drives the nightly Invidious restart
// (internal/ivrestart). Invidious slows down and gets rate-limited the longer
// it runs, and its docs recommend restarting it regularly; the API does it at
// a quiet hour, through a Docker socket proxy that only allows restarting
// these containers.
type InvidiousRestartConfig struct {
	// Hour/Minute: local time in Location; Off disables the restart.
	Hour, Minute int
	Off          bool
	Location     *time.Location
	// DockerURL: the socket proxy (e.g. http://invidious-restarter:2375).
	// Empty = off (dev stacks, installs without the proxy service).
	DockerURL string
	// Containers are restarted in this order (companion first).
	Containers []string
}

// Enabled reports whether the nightly restart runs at all.
func (c InvidiousRestartConfig) Enabled() bool {
	return !c.Off && c.DockerURL != "" && len(c.Containers) > 0
}

// At renders the schedule as HH:MM (or "off").
func (c InvidiousRestartConfig) At() string {
	if !c.Enabled() {
		return "off"
	}
	return fmt.Sprintf("%02d:%02d", c.Hour, c.Minute)
}

var containerNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

func loadInvidiousRestart(get func(string, string) string, errs *[]error) InvidiousRestartConfig {
	c := InvidiousRestartConfig{Hour: 3, Location: time.UTC}
	// The household's timezone: INVIDIOUS_RESTART_TZ, else TZ from .env
	// (install.sh sets it), else the «Новые серии» one, else UTC. Only an
	// explicit INVIDIOUS_RESTART_TZ is an error when unknown.
	if tz := strings.TrimSpace(get("INVIDIOUS_RESTART_TZ", "")); tz != "" {
		if loc, err := time.LoadLocation(tz); err == nil {
			c.Location = loc
		} else {
			*errs = append(*errs, fmt.Errorf("INVIDIOUS_RESTART_TZ: unknown timezone %q", tz))
		}
	} else {
		for _, k := range []string{"TZ", "NEW_EPISODES_TZ"} {
			if v := get(k, ""); v == "" {
				continue
			} else if loc, err := time.LoadLocation(v); err == nil {
				c.Location = loc
				break
			}
		}
	}
	switch at := strings.ToLower(strings.TrimSpace(get("INVIDIOUS_RESTART_AT", "03:00"))); at {
	case "off", "none", "false", "-", "disabled":
		c.Off = true
	default:
		h, m, ok := strings.Cut(at, ":")
		hh, err1 := strconv.Atoi(h)
		mm, err2 := strconv.Atoi(m)
		if !ok || err1 != nil || err2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
			*errs = append(*errs, fmt.Errorf("INVIDIOUS_RESTART_AT must be HH:MM or off, got %q", at))
		} else {
			c.Hour, c.Minute = hh, mm
		}
	}
	if v := strings.TrimRight(strings.TrimSpace(get("INVIDIOUS_RESTART_DOCKER_URL", "")), "/"); v != "" {
		if u, err := url.Parse(v); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
			*errs = append(*errs, errors.New("INVIDIOUS_RESTART_DOCKER_URL must be an http(s) URL without credentials"))
		} else {
			c.DockerURL = v
		}
	}
	for _, n := range strings.Split(get("INVIDIOUS_RESTART_CONTAINERS", ""), ",") {
		if n = strings.TrimSpace(n); n == "" {
			continue
		}
		if !containerNamePattern.MatchString(n) {
			*errs = append(*errs, fmt.Errorf("INVIDIOUS_RESTART_CONTAINERS: bad container name %q", n))
			continue
		}
		c.Containers = append(c.Containers, n)
	}
	return c
}
