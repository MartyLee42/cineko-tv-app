package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // the container may have no zoneinfo
)

// NewEpisodesConfig drives the nightly «Новые серии» check (internal/watch/newepisodes.go).
type NewEpisodesConfig struct {
	// Hour/Minute: local time of the nightly run in Location; Off disables it.
	Hour, Minute int
	Off          bool
	// Location: the household's timezone ("today" for air dates, the run time).
	Location *time.Location
	// Lang: TMDB language the episode titles are refreshed in.
	Lang string
}

// At renders the schedule as HH:MM (or "off").
func (n NewEpisodesConfig) At() string {
	if n.Off {
		return "off"
	}
	return fmt.Sprintf("%02d:%02d", n.Hour, n.Minute)
}

func loadNewEpisodes(get func(string, string) string, errs *[]error) NewEpisodesConfig {
	n := NewEpisodesConfig{Hour: 4, Lang: "ru"}
	tz := get("NEW_EPISODES_TZ", "UTC")
	loc, err := time.LoadLocation(tz)
	if err != nil {
		*errs = append(*errs, fmt.Errorf("NEW_EPISODES_TZ: unknown timezone %q", tz))
		loc = time.UTC
	}
	n.Location = loc
	switch l := strings.ToLower(get("NEW_EPISODES_LANG", "ru")); l {
	case "ru", "en":
		n.Lang = l
	default:
		*errs = append(*errs, errors.New("NEW_EPISODES_LANG must be ru or en"))
	}
	switch at := strings.ToLower(get("NEW_EPISODES_AT", "04:00")); at {
	case "off", "none", "false", "-", "disabled":
		n.Off = true
	default:
		h, m, ok := strings.Cut(at, ":")
		hh, err1 := strconv.Atoi(h)
		mm, err2 := strconv.Atoi(m)
		if !ok || err1 != nil || err2 != nil || hh < 0 || hh > 23 || mm < 0 || mm > 59 {
			*errs = append(*errs, fmt.Errorf("NEW_EPISODES_AT must be HH:MM or off, got %q", at))
		} else {
			n.Hour, n.Minute = hh, mm
		}
	}
	return n
}
