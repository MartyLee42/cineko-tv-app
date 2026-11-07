package playback

import (
	"strings"
	"testing"
	"time"
)

func newTestLive() *liveDeps {
	return &liveDeps{urls: &urlSigner{key: []byte("k")}, state: map[string]*liveState{}}
}

func TestLiveLongRefs(t *testing.T) {
	d := newTestLive()
	short := "https://cdn.example/live/seg1.ts"
	if r := d.ref("ch1", short); strings.HasPrefix(r, "~") {
		t.Fatalf("short URL kept server-side: %s", r)
	}
	long := "https://cdn.example/v/master.m3u8?jwt=" + strings.Repeat("a", 2500)
	r := d.ref("ch1", long)
	if !strings.HasPrefix(r, "~") || !strings.HasSuffix(r, ".m3u8") || len(r) > 64 {
		t.Fatalf("long ref %q", r)
	}
	if u, err := d.open("ch1", r); err != nil || u != long {
		t.Fatalf("open: %v", err)
	}
	// Bound to the channel: another channel's token can't use it.
	if _, err := d.open("ch2", r); err == nil {
		t.Fatal("long ref opened for another channel")
	}
	if _, err := d.open("ch1", "~AAAAAAAAAAAAAAAAAAAAAA.ts"); err == nil {
		t.Fatal("unknown long ref opened")
	}
	// Expired refs are gone.
	d.mu.Lock()
	for k, v := range d.long {
		d.long[k] = longRef{v.url, time.Now().Add(-2 * longRefTTL)}
	}
	d.mu.Unlock()
	if _, err := d.open("ch1", r); err == nil {
		t.Fatal("expired long ref opened")
	}
	// Inline refs still round-trip.
	if u, err := d.open("ch1", d.ref("ch1", short)); err != nil || u != short {
		t.Fatalf("inline: %v", err)
	}
}

func TestLiveCandidatesRememberWinner(t *testing.T) {
	d := newTestLive()
	ch := &LiveChannel{ID: "c", URL: "https://a/1.m3u8", Mirrors: []LiveMirror{{URL: "https://b/1.m3u8"}, {URL: "https://c/1.m3u8"}}}
	urls := func() string {
		var s []string
		for _, c := range d.candidates(ch) {
			s = append(s, c.url)
		}
		return strings.Join(s, " ")
	}
	if got := urls(); got != "https://a/1.m3u8 https://b/1.m3u8 https://c/1.m3u8" {
		t.Fatal(got)
	}
	d.update("c", func(st *liveState) { st.url = "https://c/1.m3u8" })
	if got := urls(); got != "https://c/1.m3u8 https://a/1.m3u8 https://b/1.m3u8" {
		t.Fatal(got)
	}
	if d.current(ch).url != "https://c/1.m3u8" {
		t.Fatal("current")
	}
	// A remembered URL no longer in the channel is ignored.
	d.update("c", func(st *liveState) { st.url = "https://gone/1.m3u8" })
	if d.current(ch).url != "https://a/1.m3u8" {
		t.Fatal("stale decision used")
	}
}

func TestLiveFailureCacheAndEntry(t *testing.T) {
	d := newTestLive()
	if d.recentFailure("c") != "" {
		t.Fatal("no failure yet")
	}
	d.update("c", func(st *liveState) { st.failCause, st.failedAt = "dns", time.Now() })
	if d.recentFailure("c") != "dns" {
		t.Fatal("failure not cached")
	}
	d.update("c", func(st *liveState) { st.failedAt = time.Now().Add(-liveFailTTL - time.Second) })
	if d.recentFailure("c") != "" {
		t.Fatal("failure cached too long")
	}
	d.update("c", func(st *liveState) { st.url, st.entry, st.entryAt = "u", []byte("#EXTM3U"), time.Now() })
	if b, _ := d.takeEntry("c", "other"); b != nil {
		t.Fatal("entry of another URL")
	}
	if b, _ := d.takeEntry("c", "u"); string(b) != "#EXTM3U" {
		t.Fatal("entry not served")
	}
	if b, _ := d.takeEntry("c", "u"); b != nil {
		t.Fatal("entry served twice")
	}
}

func TestLiveErrorCodes(t *testing.T) {
	for cause, code := range map[string]string{
		"http_403": "channel_geo_blocked", "http_451": "channel_geo_blocked", "timeout": "channel_timeout",
		"dns": "channel_unavailable", "http_404": "channel_unavailable", "connect": "channel_unavailable",
		"not_stream": "channel_format_unsupported", "dash": "channel_format_unsupported",
	} {
		if got := liveError(cause).Code; got != code {
			t.Errorf("%s: %s, want %s", cause, got, code)
		}
	}
}

func TestSniffLive(t *testing.T) {
	cases := []struct {
		ct, head, want string
	}{
		{"application/vnd.apple.mpegurl", "#EXTM3U\n", "hls"},
		{"text/plain", "\xef\xbb\xbf #EXTM3U", "hls"},
		{"application/x-mpegurl", "<html>blocked</html>", ""}, // an error page with a playlist type
		{"video/mp2t", "\x47\x40\x00", "ts"},
		{"application/octet-stream", "\x47\x40\x00", "ts"},
		{"text/html", "<html>", ""},
		{"video/mp2t", "<html>", ""},
	}
	for _, c := range cases {
		got, _ := sniffLive(c.ct, []byte(c.head))
		if got != c.want {
			t.Errorf("%q %q: %q, want %q", c.ct, c.head, got, c.want)
		}
	}
}
