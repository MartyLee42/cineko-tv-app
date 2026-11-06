// Package iptv implements live TV (Phase 7): M3U playlists (iptv-org
// country presets, provider URLs, uploaded files), XMLTV programme guides,
// per-profile favorites/order/numbers/hidden channels, channel health and
// the admin API. Playback goes through internal/playback's signed live proxy
// (live.go there); this package only answers which upstream URL and headers
// a channel id stands for.
package iptv

import (
	"bufio"
	"io"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Entry is one channel parsed from an M3U playlist.
type Entry struct {
	TvgID     string
	TvgName   string
	Name      string // display name (resolution/status tags removed)
	Logo      string
	Group     string
	URL       string
	UserAgent string
	Referrer  string
}

// Playlist is a parsed M3U.
type Playlist struct {
	// EPGURLs from the header (x-tvg-url / url-tvg), comma separated there.
	EPGURLs []string
	Entries []Entry
	// Skipped counts entries dropped as broken (no URL, non-http URL, …).
	Skipped int
}

const (
	maxEntries   = 20000
	maxLineBytes = 64 << 10
	maxAttrLen   = 2048
)

// ParseM3U reads an M3U/M3U8 channel list. It is lenient: a missing
// #EXTM3U header, CRLF line ends, a BOM, blank lines, unknown directives,
// #EXTINF lines without a URL and URLs without #EXTINF are tolerated
// (broken entries are skipped and counted). Catchup attributes are ignored.
func ParseM3U(r io.Reader) (*Playlist, error) {
	pl := &Playlist{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), maxLineBytes)
	var (
		cur      *Entry
		group    string // #EXTGRP for the current entry
		ua, ref  string // #EXTVLCOPT for the current entry
		first    = true
		haveInfo bool
	)
	reset := func() {
		cur, group, ua, ref, haveInfo = nil, "", "", "", false
	}
	for sc.Scan() {
		line := strings.TrimSpace(strings.TrimRight(sc.Text(), "\r"))
		if first {
			line = strings.TrimSpace(strings.TrimPrefix(line, "\ufeff"))
			first = false
		}
		if line == "" {
			continue
		}
		upper := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(upper, "#EXTM3U"):
			attrs, _ := parseAttrs(line[len("#EXTM3U"):])
			for _, k := range []string{"x-tvg-url", "url-tvg", "tvg-url"} {
				for _, u := range strings.Split(attrs[k], ",") {
					if u = strings.TrimSpace(u); isHTTP(u) {
						pl.EPGURLs = appendUnique(pl.EPGURLs, u)
					}
				}
			}
		case strings.HasPrefix(upper, "#EXTINF:"):
			if haveInfo {
				pl.Skipped++ // previous #EXTINF had no URL
			}
			reset()
			cur = parseExtinf(line[len("#EXTINF:"):])
			haveInfo = true
		case strings.HasPrefix(upper, "#EXTGRP:"):
			group = strings.TrimSpace(line[len("#EXTGRP:"):])
		case strings.HasPrefix(upper, "#EXTVLCOPT:"):
			k, v, ok := strings.Cut(line[len("#EXTVLCOPT:"):], "=")
			if !ok {
				continue
			}
			switch strings.ToLower(strings.TrimSpace(k)) {
			case "http-user-agent":
				ua = clip(strings.TrimSpace(v), 300)
			case "http-referrer", "http-referer":
				ref = clip(strings.TrimSpace(v), maxAttrLen)
			}
		case strings.HasPrefix(line, "#"):
			// #KODIPROP, #EXT-X-…, comments: ignored.
		default:
			if !haveInfo {
				pl.Skipped++ // a bare URL without #EXTINF
				continue
			}
			u, pipeUA, pipeRef := splitPipeHeaders(line)
			if !isHTTP(u) || len(u) > maxAttrLen {
				pl.Skipped++
				reset()
				continue
			}
			e := *cur
			e.URL = u
			if e.Group == "" {
				e.Group = group
			}
			e.UserAgent = firstNonEmpty(ua, pipeUA)
			e.Referrer = firstNonEmpty(ref, pipeRef)
			if e.Name == "" {
				e.Name = firstNonEmpty(e.TvgName, e.TvgID, hostOf(u))
			}
			if len(pl.Entries) < maxEntries {
				pl.Entries = append(pl.Entries, e)
			} else {
				pl.Skipped++
			}
			reset()
		}
	}
	if haveInfo {
		pl.Skipped++
	}
	if err := sc.Err(); err != nil {
		return pl, err
	}
	return pl, nil
}

// parseExtinf parses `-1 tvg-id="x" group-title="News",Channel name`.
func parseExtinf(s string) *Entry {
	// Skip the duration.
	i := 0
	for i < len(s) && s[i] != ' ' && s[i] != '\t' && s[i] != ',' {
		i++
	}
	attrs, rest := parseAttrs(s[i:])
	name := cleanName(rest)
	return &Entry{
		TvgID:   clip(strings.TrimSpace(attrs["tvg-id"]), 200),
		TvgName: clip(strings.TrimSpace(attrs["tvg-name"]), 200),
		Name:    name,
		Logo:    httpOrEmpty(strings.TrimSpace(attrs["tvg-logo"])),
		Group:   clip(strings.TrimSpace(attrs["group-title"]), 200),
	}
}

// parseAttrs reads key="value" / key=value pairs up to the first comma
// outside quotes and returns them (keys lower-cased) plus the text after
// that comma.
func parseAttrs(s string) (map[string]string, string) {
	attrs := map[string]string{}
	i := 0
	for i < len(s) {
		for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
			i++
		}
		if i >= len(s) {
			break
		}
		if s[i] == ',' {
			return attrs, s[i+1:]
		}
		start := i
		for i < len(s) && s[i] != '=' && s[i] != ' ' && s[i] != ',' {
			i++
		}
		key := strings.ToLower(s[start:i])
		if i >= len(s) || s[i] != '=' {
			continue // a bare word: ignore
		}
		i++ // '='
		var val string
		if i < len(s) && (s[i] == '"' || s[i] == '\'') {
			q := s[i]
			i++
			end := strings.IndexByte(s[i:], q)
			if end < 0 { // unterminated quote: take the rest up to a comma
				end = strings.IndexByte(s[i:], ',')
				if end < 0 {
					end = len(s) - i
				}
				val = s[i : i+end]
				i += end
			} else {
				val = s[i : i+end]
				i += end + 1
			}
		} else {
			start := i
			for i < len(s) && s[i] != ' ' && s[i] != ',' {
				i++
			}
			val = s[start:i]
		}
		if key != "" {
			attrs[key] = clip(val, maxAttrLen)
		}
	}
	return attrs, ""
}

// splitPipeHeaders handles Kodi-style `url|User-Agent=…&Referer=…`.
func splitPipeHeaders(line string) (u, ua, ref string) {
	u, opts, ok := strings.Cut(line, "|")
	u = strings.TrimSpace(u)
	if !ok {
		return u, "", ""
	}
	for _, kv := range strings.Split(opts, "&") {
		k, v, _ := strings.Cut(kv, "=")
		if dv, err := url.QueryUnescape(v); err == nil {
			v = dv
		}
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "user-agent":
			ua = clip(v, 300)
		case "referer", "referrer":
			ref = clip(v, maxAttrLen)
		}
	}
	return u, ua, ref
}

var (
	reResTag    = regexp.MustCompile(`\s*\((?:\d{3,4}[pi]|4K|UHD)\)`)
	reStatusTag = regexp.MustCompile(`\s*\[(?:Geo-blocked|Not 24/7|Geo-Blocked)\]`)
)

// cleanName trims a display name and drops iptv-org's "(1080p)" and
// "[Geo-blocked]"/"[Not 24/7]" tags.
func cleanName(s string) string {
	s = reResTag.ReplaceAllString(s, "")
	s = reStatusTag.ReplaceAllString(s, "")
	s = strings.Join(strings.Fields(s), " ")
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	return clip(s, 200)
}

func isHTTP(u string) bool {
	p, err := url.Parse(u)
	return err == nil && (p.Scheme == "http" || p.Scheme == "https") && p.Host != "" && p.User == nil
}

func httpOrEmpty(u string) string {
	if isHTTP(u) && len(u) <= maxAttrLen {
		return u
	}
	return ""
}

func hostOf(u string) string {
	if p, err := url.Parse(u); err == nil {
		return p.Host
	}
	return ""
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) && len(s) > 0 {
		s = s[:len(s)-1]
	}
	return s
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}

func appendUnique(xs []string, x string) []string {
	for _, y := range xs {
		if y == x {
			return xs
		}
	}
	return append(xs, x)
}
