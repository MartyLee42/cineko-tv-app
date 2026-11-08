package config

import (
	"strings"
	"time"
)

// DefaultHouseholdTZ is used when neither TZ nor NEW_EPISODES_TZ names a
// zone: Cineko's households are mostly Russian-speaking, and the Kinopoisk
// import already reads its dates in Moscow time.
const DefaultHouseholdTZ = "Europe/Moscow"

// loadHouseholdTZ picks the household's wall clock (ticket stub dates,
// «Ночная сова»): TZ from .env (install.sh writes the host's zone), else
// NEW_EPISODES_TZ, else Europe/Moscow. A UTC TZ is usually install.sh's
// fallback for a host without a zone, so a real NEW_EPISODES_TZ wins over it.
// Unknown names are skipped (TZ is shared with other tools: not an error).
func loadHouseholdTZ(get func(string, string) string) *time.Location {
	var utc *time.Location
	for _, k := range []string{"TZ", "NEW_EPISODES_TZ"} {
		v := strings.TrimSpace(get(k, ""))
		if v == "" {
			continue
		}
		loc, err := time.LoadLocation(v)
		if err != nil {
			continue
		}
		if isUTCZone(v) {
			if utc == nil {
				utc = loc
			}
			continue
		}
		return loc
	}
	if utc != nil {
		return utc
	}
	if loc, err := time.LoadLocation(DefaultHouseholdTZ); err == nil {
		return loc
	}
	return time.UTC
}

func isUTCZone(name string) bool {
	switch strings.ToUpper(strings.TrimPrefix(name, ":")) {
	case "UTC", "ETC/UTC", "GMT", "ETC/GMT", "UCT", "ZULU", "ETC/ZULU", "UNIVERSAL", "ETC/UNIVERSAL":
		return true
	}
	return false
}
