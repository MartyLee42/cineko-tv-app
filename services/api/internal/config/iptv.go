package config

import (
	"errors"
	"net/url"
	"strconv"
	"strings"
)

// IPTVConfig drives live TV (internal/iptv).
type IPTVConfig struct {
	// ProxyURL is used for playlists/EPG/logos marked via_proxy and as the
	// fallback when a direct fetch fails. Defaults to TMDB_PROXY_URL. Never log it.
	ProxyURL *url.URL
	// OrgBaseURL is where the iptv-org country playlists live
	// (<base>/countries/<code>.m3u).
	OrgBaseURL string
	// OrgAPIURL serves iptv-org's channels.json (alt names for EPG matching).
	OrgAPIURL string
	// OrgEPGURL overrides the built-in per-country guide lists of iptv-org
	// presets (iptv/countries.go): comma-separated XMLTV URLs where "{CC}" /
	// "{cc}" become the country code. Empty = built-in lists; "off" = none
	// (OrgEPGOff).
	OrgEPGURL string
	OrgEPGOff bool
	// AllowPrivate lets playlists and streams point at private/LAN addresses
	// (a provider's udpxy on the home network). Off by default (SSRF).
	AllowPrivate bool
	// RefreshHours / EPGRefreshHours: background refresh periods.
	RefreshHours    int
	EPGRefreshHours int
}

func loadIPTV(get func(string, string) string, secret func(string) string, tmdbProxy *url.URL, errs *[]error) IPTVConfig {
	c := IPTVConfig{
		OrgBaseURL:      strings.TrimRight(get("IPTV_ORG_BASE_URL", "https://iptv-org.github.io/iptv"), "/"),
		OrgAPIURL:       strings.TrimRight(get("IPTV_ORG_API_URL", "https://iptv-org.github.io/api"), "/"),
		OrgEPGURL:       get("IPTV_ORG_EPG_URL", ""),
		RefreshHours:    12,
		EPGRefreshHours: 6,
	}
	switch strings.ToLower(c.OrgEPGURL) {
	case "off", "none", "false", "-":
		c.OrgEPGURL, c.OrgEPGOff = "", true
	}
	c.ProxyURL = proxyURL("IPTV_PROXY_URL", secret("IPTV_PROXY_URL"), errs)
	if c.ProxyURL == nil {
		c.ProxyURL = tmdbProxy
	}
	if v := get("IPTV_ALLOW_PRIVATE", ""); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			*errs = append(*errs, errors.New("IPTV_ALLOW_PRIVATE must be true or false"))
		}
		c.AllowPrivate = b
	}
	for name, dst := range map[string]*int{"IPTV_REFRESH_HOURS": &c.RefreshHours, "IPTV_EPG_REFRESH_HOURS": &c.EPGRefreshHours} {
		if v := get(name, ""); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 || n > 168 {
				*errs = append(*errs, errors.New(name+" must be 1…168"))
				continue
			}
			*dst = n
		}
	}
	return c
}
