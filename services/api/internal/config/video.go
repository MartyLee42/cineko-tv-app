package config

import (
	"errors"
	"net/url"
	"strings"
)

// VideoConfig drives the YouTube «Видео» tab (internal/video).
type VideoConfig struct {
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
}

func loadVideo(get func(string, string) string, errs *[]error) VideoConfig {
	c := VideoConfig{
		InvidiousURL: strings.TrimRight(strings.TrimSpace(get("INVIDIOUS_URL", "")), "/"),
		Region:       strings.ToUpper(strings.TrimSpace(get("VIDEO_REGION", "RU"))),
		Lang:         strings.ToLower(strings.TrimSpace(get("VIDEO_LANG", "ru"))),
	}
	if c.InvidiousURL != "" {
		u, err := url.Parse(c.InvidiousURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
			*errs = append(*errs, errors.New("INVIDIOUS_URL must be an http(s) URL without credentials"))
			c.InvidiousURL = ""
		}
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
