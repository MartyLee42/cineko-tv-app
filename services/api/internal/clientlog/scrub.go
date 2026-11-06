package clientlog

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Scrubbing runs on every stored string (message, stack, url, component,
// extra) before it reaches the database. Order matters: magnet links carry
// infohashes and key=value pairs, so they go first.
var scrubRules = []struct {
	re   *regexp.Regexp
	repl string
}{
	{regexp.MustCompile(`(?i)magnet:\?[^\s"'<>]+`), "magnet:[redacted]"},
	{regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+`), "Bearer [redacted]"},
	// Session, API token and device credentials.
	{regexp.MustCompile(`\b(mt[spd])_[A-Za-z0-9_-]{6,}`), "${1}_[redacted]"},
	// Stream capabilities: /stream/{token}[/{filename}].
	{regexp.MustCompile(`/stream/[^/\s?#"'<>]+`), "/stream/[redacted]"},
	// key=value pairs whose name mentions a credential (query strings, forms).
	{regexp.MustCompile(`(?i)([\w.-]*(?:token|key|auth|pass(?:word|wd)?|secret|session|sig)[\w.-]*)=([^&\s#"'<>]+)`), "${1}=[redacted]"},
	// The same in JSON: "password": "…".
	{regexp.MustCompile(`(?i)"([\w.-]*(?:token|key|auth|pass(?:word|wd)?|secret|session)[\w.-]*)"\s*:\s*"(?:[^"\\]|\\.)*"`), `"${1}":"[redacted]"`},
	{regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`), "[email]"},
	{regexp.MustCompile(`(?i)\burn:btih:[A-Za-z0-9]+`), "urn:btih:[redacted]"},
	{regexp.MustCompile(`\b[0-9a-fA-F]{40}\b`), "[infohash]"},
}

// Scrub removes secrets and personal data from free text.
func Scrub(s string) string {
	if s == "" {
		return s
	}
	for _, r := range scrubRules {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	return s
}

var (
	reQuery  = regexp.MustCompile(`\?[^#]*`)
	reOrigin = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*`)
)

// ScrubURL keeps only the path (and a hash route's path): scheme, host and
// every query string are dropped, then the result is scrubbed.
func ScrubURL(u string) string {
	u = strings.TrimSpace(u)
	u = reOrigin.ReplaceAllString(u, "")
	u = reQuery.ReplaceAllString(u, "")
	return Scrub(u)
}

// truncate cuts s to at most n bytes on a rune boundary.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

var (
	reUUID    = regexp.MustCompile(`(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`)
	reURL     = regexp.MustCompile(`(?i)\bhttps?://[^\s"'<>)]+`)
	reHex     = regexp.MustCompile(`\b(?:0x)?[0-9a-fA-F]{8,}\b`)
	reNumber  = regexp.MustCompile(`\d+`)
	reSpace   = regexp.MustCompile(`\s+`)
	reFrameV8 = regexp.MustCompile(`^\s*at\s+`)
	reFrameFF = regexp.MustCompile(`^[^\s@]*@\S+`)
	reLineCol = regexp.MustCompile(`(:\d+)+\)?$`)
	reHashed  = regexp.MustCompile(`[-.][A-Za-z0-9_-]{8}(\.m?js)\b`)
)

// normalizeMessage makes variable parts (ids, numbers, URLs) uniform so the
// same error with different data groups together.
func normalizeMessage(msg string) string {
	m := reUUID.ReplaceAllString(msg, "<id>")
	m = reURL.ReplaceAllString(m, "<url>")
	m = reHex.ReplaceAllStringFunc(m, func(h string) string {
		if strings.ContainsAny(h, "0123456789") {
			return "<hex>"
		}
		return h
	})
	m = reNumber.ReplaceAllString(m, "<n>")
	m = strings.TrimSpace(reSpace.ReplaceAllString(m, " "))
	return truncate(m, 300)
}

// topFrame returns the first stack frame without line/column numbers,
// origins or build hashes in file names, so a release does not split groups.
func topFrame(stack string) string {
	for _, line := range strings.Split(stack, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !(reFrameV8.MatchString(line) || reFrameFF.MatchString(line)) {
			continue
		}
		f := reFrameV8.ReplaceAllString(line, "")
		f = reURL.ReplaceAllStringFunc(f, func(u string) string { return reOrigin.ReplaceAllString(u, "") })
		f = reQuery.ReplaceAllString(f, "")
		f = reLineCol.ReplaceAllString(f, "")
		f = strings.TrimSuffix(strings.TrimSpace(f), "(")
		f = reHashed.ReplaceAllString(f, "$1")
		if strings.Count(f, "(") > strings.Count(f, ")") {
			f += ")"
		}
		return truncate(strings.TrimSpace(f), 200)
	}
	return ""
}

// Fingerprint groups identical errors: app + kind + normalized message +
// top stack frame (+ component for API errors, whose route identifies them).
func Fingerprint(app, kind, message, frame string) string {
	h := sha256.Sum256([]byte(app + "\x00" + kind + "\x00" + normalizeMessage(message) + "\x00" + frame))
	return hex.EncodeToString(h[:16])
}
