package server_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

const tcSecret = "transcoder-test-secret-0123456789abcdef"

// fakeTranscoder checks job signatures like services/transcoder and records
// the jobs it accepted.
type fakeTranscoder struct {
	t    *testing.T
	srv  *httptest.Server
	mu   sync.Mutex
	jobs []map[string]any
	busy bool
	// HLS: the session the fake hands out, its files, and the file requests.
	hlsFiles map[string][]byte
	hlsGets  []hlsGet
}

type hlsGet struct {
	method, file, owner, rng string
}

const fakeHLSSession = "0123456789abcdef0123456789abcdef"

func newFakeTranscoder(t *testing.T) *fakeTranscoder {
	f := &fakeTranscoder{t: t}
	m := hmac.New(sha256.New, []byte(tcSecret))
	m.Write([]byte("martytv/transcoder/job/v1"))
	key := m.Sum(nil)
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/metrics" {
			writeJSON(w, map[string]any{"active_jobs": 1, "active_subtitle_jobs": 0, "max_jobs": 3, "jobs_started": 7, "jobs_rejected": 1, "jobs_failed": 0})
			return
		}
		if rest, ok := strings.CutPrefix(r.URL.Path, "/v1/hls/"); ok && (r.Method == "GET" || r.Method == "HEAD") {
			f.serveHLS(w, r, key, rest)
			return
		}
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha256.New, key)
		mac.Write(body)
		if r.Header.Get("X-Job-Signature") != hex.EncodeToString(mac.Sum(nil)) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var j map[string]any
		_ = json.Unmarshal(body, &j)
		if "/v1/"+fmt.Sprint(j["kind"]) != r.URL.Path {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.jobs = append(f.jobs, j)
		busy := f.busy
		f.mu.Unlock()
		if busy {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, `{"error":{"code":"transcoder_busy","message":"busy"}}`)
			return
		}
		start, _ := j["start"].(float64)
		k := max(0, start-1.5) // "keyframe" 1.5 s earlier
		switch r.URL.Path {
		case "/v1/keyframe":
			writeJSON(w, map[string]float64{"start": k})
		case "/v1/remux":
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("X-Stream-Start", fmt.Sprintf("%.3f", k))
			_, _ = fmt.Fprintf(w, "FAKE-FMP4 audio=%v", j["audio"])
		case "/v1/subtitles":
			w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
			_, _ = io.WriteString(w, "WEBVTT\n\n00:01.000 --> 00:02.000\nПривет\n")
		case "/v1/hls":
			w.Header().Set("X-Stream-Start", fmt.Sprintf("%.3f", k))
			writeJSON(w, map[string]any{"session": fakeHLSSession, "start": k})
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// serveHLS checks the file signature like services/transcoder/hls.go and
// serves the fake session's files with Range.
func (f *fakeTranscoder) serveHLS(w http.ResponseWriter, r *http.Request, key []byte, rest string) {
	id, file, _ := strings.Cut(rest, "/")
	owner, exp := r.URL.Query().Get("owner"), r.URL.Query().Get("exp")
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("hls-file\n" + id + "\n" + file + "\n" + owner + "\n" + exp))
	if r.Header.Get("X-Job-Signature") != hex.EncodeToString(mac.Sum(nil)) {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	f.mu.Lock()
	f.hlsGets = append(f.hlsGets, hlsGet{r.Method, file, owner, r.Header.Get("Range")})
	b, ok := f.hlsFiles[file]
	f.mu.Unlock()
	if id != fakeHLSSession || !ok {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":{"code":"hls_session_gone","message":"gone"}}`)
		return
	}
	if file == "index.m3u8" {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		_, _ = w.Write(b)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	http.ServeContent(w, r, file, time.Unix(1700000000, 0), bytes.NewReader(b))
}

func (f *fakeTranscoder) lastGet() hlsGet {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.hlsGets) == 0 {
		return hlsGet{}
	}
	return f.hlsGets[len(f.hlsGets)-1]
}

func (f *fakeTranscoder) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.jobs) == 0 {
		return nil
	}
	return f.jobs[len(f.jobs)-1]
}

func (f *fakeTranscoder) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.jobs)
}

// readySource creates the movie source and waits for its ffprobe info.
func readySource(t *testing.T, pe *playbackEnv, c *testutil.Client) map[string]any {
	t.Helper()
	id := c.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "mov"}).Expect(201).JSON()["id"].(string)
	for range 200 {
		res := c.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200)
		pe.assertClean(res.Body)
		src := res.JSON()
		if src["media_info"] != nil {
			return src
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no media info")
	return nil
}

func TestCompatStream(t *testing.T) {
	tc := newFakeTranscoder(t)
	pe := newPlaybackEnv(t, func(c *config.Config) {
		c.Transcoder = config.TranscoderConfig{URL: tc.srv.URL, Secret: tcSecret}
	})
	alice, _ := pe.NewUserClient("alice", "user")
	src := readySource(t, pe, alice)
	stream := src["stream_url"].(string)
	compat, _ := src["compat_url"].(string)
	if compat != stream+"/compat.mp4" {
		t.Fatalf("compat_url %q for stream %q", compat, stream)
	}
	anon := pe.Client() // the token is the capability, like stream_url

	// Default audio: the default track (index 1, AAC → copied); the input is
	// the source's own TorrServer stream with basic auth.
	r := anon.Do("GET", compat, nil).Expect(200)
	if string(r.Body) != "FAKE-FMP4 audio=1" || r.Header.Get("Content-Type") != "video/mp4" || r.Header.Get("Accept-Ranges") != "none" ||
		r.Header.Get("X-Stream-Start") != "0.000" || r.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("compat: %q %v", r.Body, r.Header)
	}
	pe.assertClean(r.Body)
	j := tc.last()
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte(tsUser+":"+tsPass))
	if j["kind"] != "remux" || j["input"] != pe.ts.srv.URL+"/stream?index=1&link="+hashMov+"&play=" || j["auth"] != wantAuth ||
		j["audio"].(float64) != 1 || j["audio_copy"] != true || j["start"] != nil || j["hvc1"] != nil {
		t.Fatalf("job %v", j)
	}

	// Another track and a start: AC3 is converted; the start goes through.
	r = anon.Do("GET", compat+"?audio=2&start=600.25", nil).Expect(200)
	if j = tc.last(); j["audio"].(float64) != 2 || j["audio_copy"] != nil || j["start"].(float64) != 600.25 || r.Header.Get("X-Stream-Start") != "598.750" {
		t.Fatalf("job %v headers %v", j, r.Header)
	}
	anon.Do("GET", compat+"?audio=2&ch=6", nil).Expect(200)
	if j = tc.last(); j["channels"].(float64) != 6 {
		t.Fatalf("5.1 job %v", j)
	}

	// Forged / foreign parameters never reach the transcoder.
	n := tc.count()
	for _, q := range []string{"audio=3", "audio=0", "audio=99", "audio=-1", "audio=x", "start=-1", "start=NaN", "start=Inf", "start=5401", "start=1e9", "ch=5"} {
		if r := anon.Do("GET", compat+"?"+q, nil); r.Status != 422 {
			t.Fatalf("%s: %d %s", q, r.Status, r.Body)
		}
	}
	if tc.count() != n {
		t.Fatal("refused request reached the transcoder")
	}

	// HEAD: where a stream at start would begin (keyframe probe only).
	h := anon.Do("HEAD", compat+"?start=120", nil).Expect(200)
	if h.Header.Get("X-Stream-Start") != "118.500" || tc.last()["kind"] != "keyframe" || len(h.Body) != 0 {
		t.Fatalf("head %v %v", h.Header, tc.last())
	}
	n = tc.count()
	if h := anon.Do("HEAD", compat, nil).Expect(200); h.Header.Get("X-Stream-Start") != "0.000" || tc.count() != n {
		t.Fatal("HEAD at 0 should not probe")
	}

	// Subtitles: text tracks only.
	base := strings.TrimSuffix(compat, "compat.mp4")
	r = anon.Do("GET", base+"subs/3.vtt?start=118.5&burst=90", nil).Expect(200)
	if !strings.HasPrefix(string(r.Body), "WEBVTT") || r.Header.Get("Content-Type") != "text/vtt; charset=utf-8" {
		t.Fatalf("vtt %q %v", r.Body, r.Header)
	}
	if j = tc.last(); j["kind"] != "subtitles" || j["stream"].(float64) != 3 || j["start"].(float64) != 118.5 || j["burst"].(float64) != 90 {
		t.Fatalf("subs job %v", j)
	}
	anon.Do("GET", base+"subs/1.vtt", nil).Expect(422) // an audio stream
	anon.Do("GET", base+"subs/9.vtt", nil).Expect(422)
	anon.Do("GET", base+"subs/x.vtt", nil).Expect(404)
	anon.Do("GET", base+"subs/3.vtt?start=-4", nil).Expect(422)

	// Forged / expired tokens.
	tok := strings.TrimPrefix(stream, "/api/v1/stream/")
	bad := "/api/v1/stream/" + flip(tok)
	if code := anon.Do("GET", bad+"/compat.mp4", nil).Expect(403).ErrorCode(); code != "invalid_stream_token" {
		t.Fatal(code)
	}
	if code := anon.Do("GET", bad+"/subs/3.vtt", nil).Expect(403).ErrorCode(); code != "invalid_stream_token" {
		t.Fatal(code)
	}

	// Video conversion: refused for this H.264 file (compat_video false)…
	if src["compat_video"] != false {
		t.Fatalf("compat_video %v", src["compat_video"])
	}
	n = tc.count()
	for q, code := range map[string]string{"video=h264": "video_not_convertible", "video=hevc": "invalid_video", "video=1": "invalid_video"} {
		if c := anon.Do("GET", compat+"?"+q, nil).Expect(422).ErrorCode(); c != code {
			t.Fatalf("%s: %s", q, c)
		}
	}
	if tc.count() != n {
		t.Fatal("refused video conversion reached the transcoder")
	}
	// …allowed for XviD SD in AVI: the job asks for H.264 (never hvc1),
	// on compat.mp4, its HEAD probe and compat.m3u8 alike.
	id := src["id"].(string)
	setInfo := func(patch string) {
		t.Helper()
		if _, err := pe.Pool.Exec(context.Background(), `UPDATE playback_sources SET media_info = media_info || $2::jsonb WHERE id = $1`, id, patch); err != nil {
			t.Fatal(err)
		}
	}
	setInfo(`{"container":"avi","video_codec":"mpeg4","video_profile":"Advanced Simple Profile","width":720,"height":304}`)
	if s := alice.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200).JSON(); s["compat_video"] != true {
		t.Fatalf("compat_video for XviD: %v", s["compat_video"])
	}
	anon.Do("GET", compat+"?video=h264&audio=2&start=30", nil).Expect(200)
	if j = tc.last(); j["kind"] != "remux" || j["video"] != "h264" || j["hvc1"] != nil || j["audio"].(float64) != 2 {
		t.Fatalf("video job %v", j)
	}
	anon.Do("GET", compat, nil).Expect(200)
	if j = tc.last(); j["video"] != nil {
		t.Fatalf("copy job %v", j)
	}
	anon.Do("HEAD", compat+"?video=h264&start=120", nil).Expect(200)
	if j = tc.last(); j["kind"] != "keyframe" || j["video"] != "h264" {
		t.Fatalf("head job %v", j)
	}
	// Above 1080p: not offered, refused.
	setInfo(`{"video_codec":"mpeg2video","width":3840,"height":2160}`)
	if s := alice.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200).JSON(); s["compat_video"] != false {
		t.Fatalf("compat_video for 4K MPEG-2: %v", s["compat_video"])
	}
	anon.Do("GET", compat+"?video=h264", nil).Expect(422)
	setInfo(`{"container":"matroska,webm","video_codec":"h264","width":1920,"height":1080}`)

	// Busy transcoder → 503 transcoder_busy.
	tc.mu.Lock()
	tc.busy = true
	tc.mu.Unlock()
	if code := anon.Do("GET", compat, nil).Expect(503).ErrorCode(); code != "transcoder_busy" {
		t.Fatal(code)
	}
	tc.mu.Lock()
	tc.busy = false
	tc.mu.Unlock()

	// Admin Server tab: transcoder counters.
	admin, _ := pe.NewUserClient("root", "admin")
	app := admin.Do("GET", "/api/v1/admin/system", nil).Expect(200).JSON()["app"].(map[string]any)
	tcs, _ := app["transcoder"].(map[string]any)
	if tcs == nil || tcs["ok"] != true || tcs["active_jobs"].(float64) != 1 || tcs["max_jobs"].(float64) != 3 {
		t.Fatalf("admin transcoder %v", app["transcoder"])
	}

	// Transcoder down → 502 with a clear code (no internal URL).
	tc.srv.Close()
	r = anon.Do("GET", compat, nil).Expect(502)
	if r.ErrorCode() != "transcoder_unavailable" || strings.Contains(string(r.Body), strings.TrimPrefix(tc.srv.URL, "http://")) {
		t.Fatalf("down: %s", r.Body)
	}
	app = admin.Do("GET", "/api/v1/admin/system", nil).Expect(200).JSON()["app"].(map[string]any)
	if tcs, _ := app["transcoder"].(map[string]any); tcs == nil || tcs["ok"] != false {
		time.Sleep(2100 * time.Millisecond) // past the 2 s cache
		app = admin.Do("GET", "/api/v1/admin/system", nil).Expect(200).JSON()["app"].(map[string]any)
		if tcs, _ := app["transcoder"].(map[string]any); tcs == nil || tcs["ok"] != false {
			t.Fatalf("admin transcoder down %v", app["transcoder"])
		}
	}
}

func TestCompatWrongSecretAndNotConfigured(t *testing.T) {
	tc := newFakeTranscoder(t)
	pe := newPlaybackEnv(t, func(c *config.Config) {
		c.Transcoder = config.TranscoderConfig{URL: tc.srv.URL, Secret: strings.Repeat("w", 40)}
	})
	alice, _ := pe.NewUserClient("alice", "user")
	src := readySource(t, pe, alice)
	// The transcoder refuses the signature: a server problem, reported as unavailable.
	if code := pe.Client().Do("GET", src["compat_url"].(string), nil).Expect(502).ErrorCode(); code != "transcoder_unavailable" {
		t.Fatal(code)
	}

	// Without TRANSCODER_URL: compat_url is null and the route says so.
	plain := newPlaybackEnv(t)
	bob, _ := plain.NewUserClient("bob", "user")
	s2 := readySource(t, plain, bob)
	if v, ok := s2["compat_url"]; !ok || v != nil {
		t.Fatalf("compat_url %v (present %v)", v, ok)
	}
	if code := plain.Client().Do("GET", s2["stream_url"].(string)+"/compat.mp4", nil).Expect(404).ErrorCode(); code != "compat_unavailable" {
		t.Fatal(code)
	}
	app := func() map[string]any {
		admin, _ := plain.NewUserClient("root", "admin")
		return admin.Do("GET", "/api/v1/admin/system", nil).Expect(200).JSON()["app"].(map[string]any)
	}()
	if v, ok := app["transcoder"]; !ok || v != nil {
		t.Fatalf("admin transcoder %v", v)
	}
}
