package config

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// VideoConfig drives the YouTube «Видео» tab (internal/video).
type VideoConfig struct {
	// Enabled is VIDEO_ENABLED (default true). false = YouTube «Видео» is not
	// installed: InvidiousURL is cleared, so the tab answers 503
	// video_unavailable, no background work runs and nothing is monitored.
	Enabled bool
	// InvidiousURL is the self-hosted Invidious on the internal network
	// (e.g. http://invidious:3000). Empty = the tab answers 503
	// video_unavailable. It must match Invidious' own domain/external_port
	// setting: stream URLs (local=true) carry that origin and the proxy only
	// fetches URLs on it.
	InvidiousURL string
	// Region (ISO 3166-1 alpha-2) for trending, search and videos, default RU.
	Region string
	// Lang is the `hl` sent to Invidious (its own strings: "2 дня назад"),
	// ISO 639-1, default ru.
	Lang string
	// ThumbCacheMB bounds the thumbnail/avatar disk cache (least recently
	// used files go first), VIDEO_THUMB_CACHE_MB, default 500; 0 = no disk cache.
	ThumbCacheMB int
	// ThumbMaxAge drops thumbnails not used for this long,
	// VIDEO_THUMB_CACHE_DAYS, default 14.
	ThumbMaxAge time.Duration
}

func loadVideo(get func(string, string) string, errs *[]error) VideoConfig {
	c := VideoConfig{
		Enabled:      boolSetting(get, "VIDEO_ENABLED", true, errs),
		InvidiousURL: strings.TrimRight(strings.TrimSpace(get("INVIDIOUS_URL", "")), "/"),
		Region:       strings.ToUpper(strings.TrimSpace(get("VIDEO_REGION", "RU"))),
		Lang:         strings.ToLower(strings.TrimSpace(get("VIDEO_LANG", "ru"))),
	}
	c.ThumbCacheMB = 500
	if v := strings.TrimSpace(get("VIDEO_THUMB_CACHE_MB", "")); v != "" {
		if n, err := strconv.Atoi(v); err != nil || n < 0 {
			*errs = append(*errs, errors.New("VIDEO_THUMB_CACHE_MB must be a non-negative integer"))
		} else {
			c.ThumbCacheMB = n
		}
	}
	c.ThumbMaxAge = 14 * 24 * time.Hour
	if v := strings.TrimSpace(get("VIDEO_THUMB_CACHE_DAYS", "")); v != "" {
		if n, err := strconv.Atoi(v); err != nil || n < 1 {
			*errs = append(*errs, errors.New("VIDEO_THUMB_CACHE_DAYS must be a positive integer"))
		} else {
			c.ThumbMaxAge = time.Duration(n) * 24 * time.Hour
		}
	}
	if c.InvidiousURL != "" {
		u, err := url.Parse(c.InvidiousURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
			*errs = append(*errs, errors.New("INVIDIOUS_URL must be an http(s) URL without credentials"))
			c.InvidiousURL = ""
		}
	}
	if !c.Enabled {
		c.InvidiousURL = ""
	}
	if len(c.Region) != 2 {
		*errs = append(*errs, errors.New("VIDEO_REGION must be a 2-letter country code"))
		c.Region = "RU"
	}
	if len(c.Lang) != 2 || c.Lang[0] < 'a' || c.Lang[0] > 'z' || c.Lang[1] < 'a' || c.Lang[1] > 'z' {
		*errs = append(*errs, errors.New("VIDEO_LANG must be a 2-letter language code"))
		c.Lang = "ru"
	}
	return c
}
