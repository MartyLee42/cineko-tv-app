package config

import (
	"fmt"
	"net"
	"net/url"
	"strings"

	"golang.org/x/net/publicsuffix"
)

// loadMusicHost reads MUSIC_DOMAIN (Cineko Music on its own host, e.g.
// music.example.com) and COOKIE_DOMAIN. The music origin is allowed like the
// main one, and the session cookie is shared between both hosts when they
// have a common parent domain (or COOKIE_DOMAIN names one).
func (c *Config) loadMusicHost(get func(string) string, errs *[]error) {
	if v := strings.TrimSpace(get("MUSIC_DOMAIN")); v != "" {
		host, err := parseHost(v)
		if err != nil {
			*errs = append(*errs, fmt.Errorf("MUSIC_DOMAIN: %w", err))
		} else {
			c.MusicDomain = host
			scheme := "https"
			if c.PublicBaseURL != nil {
				scheme = c.PublicBaseURL.Scheme
			}
			c.AllowedOrigins = append(c.AllowedOrigins, scheme+"://"+host)
		}
	}
	if c.PublicBaseURL == nil {
		return
	}
	main := c.PublicBaseURL.Hostname()
	switch v := strings.ToLower(strings.TrimSpace(get("COOKIE_DOMAIN"))); v {
	case "":
		if c.MusicDomain != "" {
			c.CookieDomain = DeriveCookieDomain(main, hostOnly(c.MusicDomain))
		}
	case "off", "none", "host":
		// Host-only cookie, even with MUSIC_DOMAIN.
	default:
		d := strings.TrimPrefix(v, ".")
		if !domainMatch(main, d) || !strings.Contains(d, ".") {
			*errs = append(*errs, fmt.Errorf("COOKIE_DOMAIN %q must be the host of PUBLIC_BASE_URL or a parent of it", v))
		} else {
			c.CookieDomain = d
		}
	}
}

// parseHost accepts "music.example.com", "music.example.com:8443" or a URL
// and returns the lower-case host[:port].
func parseHost(v string) (string, error) {
	v = strings.ToLower(strings.TrimRight(v, "/"))
	if strings.Contains(v, "://") {
		u, err := url.Parse(v)
		if err != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.User != nil {
			return "", fmt.Errorf("expected a host name, got %q", v)
		}
		v = u.Host
	}
	h := hostOnly(v)
	if h == "" || strings.ContainsAny(v, "/?#@ ") || strings.HasPrefix(h, ".") || strings.HasSuffix(h, ".") {
		return "", fmt.Errorf("expected a host name, got %q", v)
	}
	return v, nil
}

func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return hostport
}

// domainMatch reports whether host is domain or one of its subdomains.
func domainMatch(host, domain string) bool {
	host, domain = strings.ToLower(host), strings.ToLower(domain)
	return host == domain || strings.HasSuffix(host, "."+domain)
}

// DeriveCookieDomain returns the closest common parent of two host names that
// a browser accepts as a cookie Domain (never a public suffix such as "co.uk"
// or "github.io"), or "" when there is none: equal hosts, IP addresses,
// single-label names, unrelated domains.
//
//	tv.example.com + music.example.com → example.com
//	example.com    + music.example.com → example.com
func DeriveCookieDomain(a, b string) string {
	a, b = strings.ToLower(strings.TrimSuffix(a, ".")), strings.ToLower(strings.TrimSuffix(b, "."))
	if a == "" || b == "" || a == b || net.ParseIP(a) != nil || net.ParseIP(b) != nil {
		return ""
	}
	la, lb := strings.Split(a, "."), strings.Split(b, ".")
	n := 0
	for n < len(la) && n < len(lb) && la[len(la)-1-n] == lb[len(lb)-1-n] {
		n++
	}
	if n < 2 {
		return ""
	}
	common := strings.Join(la[len(la)-n:], ".")
	reg, err := publicsuffix.EffectiveTLDPlusOne(a)
	if err != nil || !domainMatch(common, reg) {
		return ""
	}
	return common
}
