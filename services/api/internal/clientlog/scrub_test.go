package clientlog

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestScrub(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"session token", "cookie mts_AbCdEf123456_-xyz leaked", "cookie mts_[redacted] leaked"},
		{"api token", "Authorization failed for mtp_0123456789abcdef", "Authorization failed for mtp_[redacted]"},
		{"device token", `{"token":"mtd_zzzzzzzzzzzz"}`, `{"token":"[redacted]"}`},
		{"bearer", "Bearer abc.def-ghi", "Bearer [redacted]"},
		{"stream token", "GET /api/v1/stream/Zx9_abcDEF123/movie.mkv failed", "GET /api/v1/stream/[redacted]/movie.mkv failed"},
		{"report token query", "/api/v1/playback/sessions/1/progress?token=secret123&x=1", "/api/v1/playback/sessions/1/progress?token=[redacted]&x=1"},
		{"report_token field", "report_token=abc123", "report_token=[redacted]"},
		{"report_token json", `{"report_token": "abc"}`, `{"report_token":"[redacted]"}`},
		{"apikey", "https://prowlarr/download?apikey=deadbeef&link=1", "https://prowlarr/download?apikey=[redacted]&link=1"},
		{"auth param", "/ws?auth=token", "/ws?auth=[redacted]"},
		{"password", "password=hunter2 rest", "password=[redacted] rest"},
		{"password json", `{"password":"hunter2"}`, `{"password":"[redacted]"}`},
		{"email", "user alice.smith+tv@example.co.uk not found", "user [email] not found"},
		{"magnet", "magnet:?xt=urn:btih:ABCDEF&dn=Movie", "magnet:[redacted]"},
		{"infohash", "hash 0123456789abcdef0123456789abcdef01234567 gone", "hash [infohash] gone"},
		{"btih", "urn:btih:XYZXYZ", "urn:btih:[redacted]"},
		{"plain", "Cannot read properties of undefined (reading 'id')", "Cannot read properties of undefined (reading 'id')"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Scrub(c.in); got != c.want {
				t.Fatalf("Scrub(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestScrubURL(t *testing.T) {
	cases := map[string]string{
		"https://tv.example.com/media/42?profile_id=1&token=x#top": "/media/42#top",
		"/tv/#/details/5?token=abc":                                "/tv/#/details/5",
		"/api/v1/stream/TOKEN123/file.mkv":                         "/api/v1/stream/[redacted]/file.mkv",
		"/settings":                                                "/settings",
	}
	for in, want := range cases {
		if got := ScrubURL(in); got != want {
			t.Errorf("ScrubURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFingerprintGrouping(t *testing.T) {
	stackA := "TypeError: x is undefined\n    at render (https://tv.example.com/assets/index-Bx7k_2aQ.js:10:200)\n    at a (https://tv.example.com/assets/index-Bx7k_2aQ.js:1:1)"
	stackB := "TypeError: x is undefined\n    at render (https://other.host/assets/index-Zz9y_1bW.js:12:5)"
	if topFrame(stackA) != "render (/assets/index.js)" {
		t.Fatalf("topFrame = %q", topFrame(stackA))
	}
	if topFrame("render@https://h/assets/index-Bx7k_2aQ.js:10:20\n") != "render@/assets/index.js" {
		t.Fatalf("firefox frame = %q", topFrame("render@https://h/assets/index-Bx7k_2aQ.js:10:20"))
	}
	// Same error across releases/hosts and with different ids/numbers groups together.
	fa := Fingerprint("web", "error", "Media 3fa85f64-5717-4562-b3fc-2c963f66afa6 failed after 12 ms", topFrame(stackA))
	fb := Fingerprint("web", "error", "Media 9c858901-8a57-4791-81fe-4c455b099bc9 failed after 345 ms", topFrame(stackB))
	if fa != fb {
		t.Fatal("same error should share a fingerprint")
	}
	if fa == Fingerprint("tv", "error", "Media 1 failed after 1 ms", topFrame(stackA)) {
		t.Fatal("app must split groups")
	}
	if fa == Fingerprint("web", "react", "Media 1 failed after 1 ms", topFrame(stackA)) {
		t.Fatal("kind must split groups")
	}
	if fa == Fingerprint("web", "error", "Media 1 failed after 1 ms", "other (/assets/x.js)") {
		t.Fatal("top frame must split groups")
	}
	if fa == Fingerprint("web", "error", "Something else", topFrame(stackA)) {
		t.Fatal("message must split groups")
	}
}

func TestSanitizeLimits(t *testing.T) {
	now := time.Now()
	e := Event{
		Message:    strings.Repeat("é", 2000) + " mts_secretsecret",
		Stack:      strings.Repeat("s", 20000),
		URL:        "/x?token=1",
		Extra:      json.RawMessage(`{"big":"` + strings.Repeat("a", 3000) + `"}`),
		OccurredAt: now.Add(48 * time.Hour),
		Count:      5000,
	}
	e.sanitize(now)
	if len(e.Message) > maxMessage+len("…") || strings.Contains(e.Message, "secret") {
		t.Fatalf("message %d bytes", len(e.Message))
	}
	if len(e.Stack) > maxStack+len("…") {
		t.Fatalf("stack %d", len(e.Stack))
	}
	if e.Extra != nil || e.URL != "/x" || e.Count != maxCount || !e.OccurredAt.Equal(now) {
		t.Fatalf("sanitize: extra=%s url=%q count=%d at=%v", e.Extra, e.URL, e.Count, e.OccurredAt)
	}
	small := Event{Message: " ", Extra: json.RawMessage(`{"password":"x","n":1}`)}
	small.sanitize(now)
	if small.Message != "(no message)" || string(small.Extra) != `{"password":"[redacted]","n":1}` || small.Count != 1 {
		t.Fatalf("small %+v %s", small, small.Extra)
	}
	notObject := Event{Message: "m", Extra: json.RawMessage(`[1,2]`)}
	notObject.sanitize(now)
	if notObject.Extra != nil {
		t.Fatal("extra must be an object")
	}
}
