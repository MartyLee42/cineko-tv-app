package server_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"martytv/api/internal/config"
)

const hlsTestSecret = "hls-test-session-secret-0123456789abcdef"

// streamToken builds a stream token like internal/playback/token.go (to get
// an expired one).
func streamToken(t *testing.T, sourceID string, exp time.Time) string {
	t.Helper()
	m := hmac.New(sha256.New, []byte(hlsTestSecret))
	m.Write([]byte("martytv/playback/stream-token/v1"))
	key := m.Sum(nil)
	id := uuid.MustParse(sourceID)
	buf := append([]byte{1}, id[:]...)
	buf = binary.BigEndian.AppendUint64(buf, uint64(exp.Unix()))
	mac := hmac.New(sha256.New, key)
	mac.Write(buf)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(buf))
}

const ffmpegPlaylist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-10-31T10:00:00.000Z
#EXTINF:4.000000,
seg0.m4s
#EXTINF:6.120000,
seg1.m4s
`

func TestCompatHLS(t *testing.T) {
	tc := newFakeTranscoder(t)
	seg := bytes.Repeat([]byte("0123456789"), 100)
	tc.hlsFiles = map[string][]byte{"index.m3u8": []byte(ffmpegPlaylist), "init.mp4": []byte("ftypisom-moov"), "seg0.m4s": seg, "seg1.m4s": seg}
	pe := newPlaybackEnv(t, func(c *config.Config) {
		c.Transcoder = config.TranscoderConfig{URL: tc.srv.URL, Secret: tcSecret}
		c.SessionSecret = []byte(hlsTestSecret)
	})
	alice, _ := pe.NewUserClient("alice", "user")
	src := readySource(t, pe, alice)
	srcID := src["id"].(string)
	compat := src["compat_url"].(string)
	master := strings.TrimSuffix(compat, ".mp4") + ".m3u8"
	anon := pe.Client() // the token is the capability

	// compat.m3u8: an HLS session job for this source (owner = source id),
	// answered as a one-variant multivariant playlist.
	r := anon.Do("GET", master+"?audio=2&start=600.25", nil).Expect(200)
	j := tc.last()
	if j["kind"] != "hls" || j["owner"] != srcID || j["audio"].(float64) != 2 || j["start"].(float64) != 600.25 || j["audio_copy"] != nil ||
		!strings.HasPrefix(j["input"].(string), pe.ts.srv.URL+"/stream?") {
		t.Fatalf("job %v", j)
	}
	if r.Header.Get("Content-Type") != "application/vnd.apple.mpegurl" || r.Header.Get("X-Stream-Start") != "598.750" || r.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("master headers %v", r.Header)
	}
	body := string(r.Body)
	if !strings.HasPrefix(body, "#EXTM3U\n") || !strings.Contains(body, "#EXT-X-STREAM-INF:BANDWIDTH=") || !strings.HasSuffix(body, "\ncompat/"+fakeHLSSession+"/index.m3u8\n") {
		t.Fatalf("master:\n%s", body)
	}
	pe.assertClean(r.Body)

	// HEAD: only the keyframe probe (X-Stream-Start), no session.
	n := tc.count()
	h := anon.Do("HEAD", master+"?start=120", nil).Expect(200)
	if h.Header.Get("X-Stream-Start") != "118.500" || tc.last()["kind"] != "keyframe" || tc.count() != n+1 || len(h.Body) != 0 {
		t.Fatalf("head %v %v", h.Header, tc.last())
	}
	// Same validation as compat.mp4; nothing reaches the transcoder.
	n = tc.count()
	for _, q := range []string{"audio=99", "start=-1", "start=1e9", "ch=5", "video=h264", "video=x"} {
		if r := anon.Do("GET", master+"?"+q, nil); r.Status != 422 {
			t.Fatalf("%s: %d", q, r.Status)
		}
	}
	if tc.count() != n {
		t.Fatal("refused request reached the transcoder")
	}

	// The media playlist: ffmpeg's, filtered; starts at the beginning of the
	// EVENT playlist; steady target duration; relative URIs.
	base := strings.TrimSuffix(compat, "compat.mp4") + "compat/" + fakeHLSSession + "/"
	r = anon.Do("GET", base+"index.m3u8", nil).Expect(200)
	pl := string(r.Body)
	if r.Header.Get("Content-Type") != "application/vnd.apple.mpegurl" || r.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("playlist headers %v", r.Header)
	}
	for _, want := range []string{"#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-TARGETDURATION:10\n", "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n#EXT-X-MAP:URI=\"init.mp4\"", "#EXTINF:6.120000,\nseg1.m4s\n"} {
		if !strings.Contains(pl, want) {
			t.Fatalf("playlist lacks %q:\n%s", want, pl)
		}
	}
	if strings.Contains(pl, "PROGRAM-DATE-TIME") || strings.Contains(pl, "http") {
		t.Fatalf("playlist not filtered:\n%s", pl)
	}
	if g := tc.lastGet(); g.file != "index.m3u8" || g.owner != srcID || g.method != "GET" {
		t.Fatalf("transcoder request %+v", g)
	}

	// Segments with Range (Safari asks), HEAD, the init segment.
	r = anon.Do("GET", base+"seg0.m4s", nil, "Range", "bytes=10-19").Expect(206)
	if string(r.Body) != "0123456789" || r.Header.Get("Content-Range") != "bytes 10-19/1000" || r.Header.Get("Content-Type") != "video/mp4" ||
		r.Header.Get("Accept-Ranges") != "bytes" || r.Header.Get("Content-Length") != "10" {
		t.Fatalf("range %d %v %q", r.Status, r.Header, r.Body)
	}
	if g := tc.lastGet(); g.rng != "bytes=10-19" || g.file != "seg0.m4s" {
		t.Fatalf("range not passed on: %+v", g)
	}
	r = anon.Do("GET", base+"seg1.m4s", nil).Expect(200)
	if len(r.Body) != 1000 || r.Header.Get("Content-Length") != "1000" {
		t.Fatalf("segment %v %d", r.Header, len(r.Body))
	}
	r = anon.Do("HEAD", base+"seg1.m4s", nil).Expect(200)
	if r.Header.Get("Content-Length") != "1000" || len(r.Body) != 0 || tc.lastGet().method != "HEAD" {
		t.Fatalf("head segment %v", r.Header)
	}
	anon.Do("GET", base+"seg0.m4s", nil, "Range", "bytes=5000-").Expect(416)
	if r := anon.Do("GET", base+"init.mp4", nil).Expect(200); string(r.Body) != "ftypisom-moov" || r.Header.Get("Content-Type") != "video/mp4" {
		t.Fatalf("init %v %q", r.Header, r.Body)
	}

	// A session the transcoder no longer has; names that aren't session files.
	other := strings.TrimSuffix(compat, "compat.mp4") + "compat/" + strings.Repeat("f", 32) + "/"
	if code := anon.Do("GET", other+"index.m3u8", nil).Expect(404).ErrorCode(); code != "compat_session_gone" {
		t.Fatal(code)
	}
	if code := anon.Do("GET", base+"seg7.m4s", nil).Expect(404).ErrorCode(); code != "compat_session_gone" {
		t.Fatal(code)
	}
	gets := len(tc.hlsGets)
	for _, p := range []string{base + "evil.txt", base + "seg1.ts", base + "..%2F..%2Fx", strings.TrimSuffix(compat, "compat.mp4") + "compat/XYZ/index.m3u8"} {
		anon.Do("GET", p, nil).Expect(404)
	}
	if len(tc.hlsGets) != gets {
		t.Fatal("bad names reached the transcoder")
	}

	// Forged / expired tokens: 403 on the master and the files.
	tok := strings.TrimPrefix(src["stream_url"].(string), "/api/v1/stream/")
	for name, bad := range map[string]string{
		"invalid_stream_token": flip(tok),
		"stream_token_expired": streamToken(t, srcID, time.Now().Add(-time.Minute)),
	} {
		if code := anon.Do("GET", "/api/v1/stream/"+bad+"/compat.m3u8", nil).Expect(403).ErrorCode(); code != name {
			t.Fatalf("master %s: %s", name, code)
		}
		if code := anon.Do("GET", "/api/v1/stream/"+bad+"/compat/"+fakeHLSSession+"/seg0.m4s", nil).Expect(403).ErrorCode(); code != name {
			t.Fatalf("segment %s: %s", name, code)
		}
	}
	// A valid token of this source still works (the helper is right).
	good := streamToken(t, srcID, time.Now().Add(time.Hour))
	anon.Do("GET", "/api/v1/stream/"+good+"/compat/"+fakeHLSSession+"/index.m3u8", nil).Expect(200)

	// Busy transcoder → 503 transcoder_busy.
	tc.mu.Lock()
	tc.busy = true
	tc.mu.Unlock()
	if code := anon.Do("GET", master, nil).Expect(503).ErrorCode(); code != "transcoder_busy" {
		t.Fatal(code)
	}
	tc.mu.Lock()
	tc.busy = false
	tc.mu.Unlock()

	// Transcoder down → 502 transcoder_unavailable.
	tc.srv.Close()
	if code := anon.Do("GET", base+"index.m3u8", nil).Expect(502).ErrorCode(); code != "transcoder_unavailable" {
		t.Fatal(code)
	}
}
