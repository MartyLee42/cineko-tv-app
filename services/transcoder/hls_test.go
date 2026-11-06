package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------- arguments

func TestHLSArgs(t *testing.T) {
	a := HLSArgs(&Job{Input: "http://ts/x", Audio: intp(2)}, 30)
	s := strings.Join(a, " ")
	for _, want := range []string{
		"-ss 30.150 -i http://ts/x",
		"-map 0:V:0 -map 0:2 -c:v copy -c:a aac -ac 2 -b:a 192k",
		"-f hls -hls_time 4 -hls_playlist_type event -hls_list_size 0 -hls_segment_type fmp4",
		"-hls_fmp4_init_filename init.mp4 -hls_segment_filename seg%d.m4s",
		"-hls_flags independent_segments+temp_file -start_number 0 index.m3u8",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in %s", want, s)
		}
	}
	if strings.Contains(s, "hvc1") || strings.Contains(s, "pipe:1") || strings.Contains(s, "movflags") {
		t.Errorf("unexpected options %s", s)
	}
	if s := strings.Join(HLSArgs(&Job{Input: "http://ts/x", HVC1: true, Channels: 6}, 0), " "); !strings.Contains(s, "-tag:v hvc1") || !strings.Contains(s, "-ac 6 -b:a 384k") {
		t.Errorf("hevc 5.1 args %s", s)
	}
}

func TestParsePlaylist(t *testing.T) {
	segs, ended := parsePlaylist([]byte("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.000000,\nseg0.m4s\n#EXTINF:6.5,\nseg1.m4s\n#EXTINF:2,\nseg7.m4s\n"))
	if len(segs) != 2 || segs[1].start != 4 || segs[1].dur != 6.5 || ended {
		t.Fatalf("%+v %v", segs, ended)
	}
	if _, ended := parsePlaylist([]byte("#EXTM3U\n#EXTINF:4,\nseg0.m4s\n#EXT-X-ENDLIST\n")); !ended {
		t.Fatal("ENDLIST not seen")
	}
}

// ---------------------------------------------------------------- helpers

func (h *harness) startHLS(j Job) (*http.Response, map[string]any) {
	h.t.Helper()
	j.Kind = KindHLS
	resp := h.post(context.Background(), "/v1/hls", j)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

// file GETs a session file the way the API does (signed, owner, exp).
func (h *harness) file(method, id, file, owner string, hdr map[string]string) *http.Response {
	h.t.Helper()
	exp := time.Now().Add(time.Minute).Unix()
	req, _ := http.NewRequest(method, fmt.Sprintf("%s/v1/hls/%s/%s?owner=%s&exp=%d", h.hs.URL, id, file, owner, exp), nil)
	req.Header.Set("X-Job-Signature", FileSignature(testKey, id, file, owner, exp))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

func readAll(t *testing.T, r *http.Response) []byte {
	t.Helper()
	defer r.Body.Close()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for range 250 {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func sessionDirs(t *testing.T, dir string) []string {
	t.Helper()
	m, _ := filepath.Glob(filepath.Join(dir, "hls-*"))
	return m
}

// ---------------------------------------------------------------- fake ffmpeg

func TestHLSReuseAuthAndCleanup(t *testing.T) {
	h := newHarness(t, "hls", func(c *Config) {
		c.HLSIdle = 800 * time.Millisecond
		c.HLSTick = 50 * time.Millisecond
		c.HLSSegmentWait = 200 * time.Millisecond
	})
	hlsDir := h.srv.cfg.HLSDir
	resp, out := h.startHLS(Job{Input: "http://ts/x", Owner: "src-1", Audio: intp(1)})
	if resp.StatusCode != 200 || resp.Header.Get("X-Stream-Start") != "0.000" {
		t.Fatalf("start %d %v", resp.StatusCode, out)
	}
	id := out["session"].(string)
	if !sessionIDPat.MatchString(id) || h.srv.Metrics().ActiveJobs != 1 || h.srv.Metrics().HLSSessions != 1 {
		t.Fatalf("session %q metrics %+v", id, h.srv.Metrics())
	}
	pid := h.pid()
	args, _ := os.ReadFile(h.args)
	if !strings.Contains(string(args), "-f\nhls") {
		t.Fatalf("args %s", args)
	}

	// Same job → same session; another start → another one.
	if _, again := h.startHLS(Job{Input: "http://ts/x", Owner: "src-1", Audio: intp(1)}); again["session"] != id {
		t.Fatalf("not reused: %v", again)
	}
	if _, other := h.startHLS(Job{Input: "http://ts/x", Owner: "src-1", Audio: intp(1), Start: 120}); other["session"] == id || other["start"].(float64) != 118.5 {
		t.Fatalf("other start: %v", other)
	}

	// Files: the playlist (no-store), the init segment, segments with Range.
	r := h.file("GET", id, "index.m3u8", "src-1", nil)
	pl := readAll(t, r)
	if r.StatusCode != 200 || r.Header.Get("Content-Type") != "application/vnd.apple.mpegurl" || r.Header.Get("Cache-Control") != "no-store" ||
		!bytes.Contains(pl, []byte("#EXT-X-PLAYLIST-TYPE:EVENT")) {
		t.Fatalf("playlist %d %v %s", r.StatusCode, r.Header, pl)
	}
	if r := h.file("GET", id, "init.mp4", "src-1", nil); string(readAll(t, r)) != "init" || r.Header.Get("Content-Type") != "video/mp4" {
		t.Fatalf("init %v", r.Header)
	}
	r = h.file("GET", id, "seg1.m4s", "src-1", map[string]string{"Range": "bytes=3-5"})
	if b := readAll(t, r); r.StatusCode != 206 || string(b) != "men" || r.Header.Get("Content-Range") != "bytes 3-5/8" {
		t.Fatalf("range %d %q %v", r.StatusCode, b, r.Header)
	}
	r = h.file("HEAD", id, "seg2.m4s", "src-1", nil)
	readAll(t, r)
	if r.StatusCode != 200 || r.Header.Get("Content-Length") != "8" || r.Header.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("head %d %v", r.StatusCode, r.Header)
	}
	// A segment ffmpeg hasn't written (fake: never) → 404 after the wait;
	// names that aren't session files → 404 without looking.
	for _, f := range []string{"seg99.m4s", "x.mp4", "seg1.mp4"} {
		if r := h.file("GET", id, f, "src-1", nil); r.StatusCode != 404 {
			t.Fatalf("%s: %d", f, r.StatusCode)
		}
	}

	// Another owner, a forged / expired signature, an unknown session.
	if r := h.file("GET", id, "index.m3u8", "src-2", nil); r.StatusCode != 404 {
		t.Fatalf("other owner: %d", r.StatusCode)
	}
	req, _ := http.NewRequest("GET", fmt.Sprintf("%s/v1/hls/%s/index.m3u8?owner=src-1&exp=%d", h.hs.URL, id, time.Now().Add(time.Minute).Unix()), nil)
	req.Header.Set("X-Job-Signature", FileSignature(testKey, id, "seg0.m4s", "src-1", time.Now().Add(time.Minute).Unix()))
	if r, _ := http.DefaultClient.Do(req); r.StatusCode != 403 {
		t.Fatalf("forged: %d", r.StatusCode)
	}
	old := time.Now().Add(-time.Minute).Unix()
	req, _ = http.NewRequest("GET", fmt.Sprintf("%s/v1/hls/%s/index.m3u8?owner=src-1&exp=%d", h.hs.URL, id, old), nil)
	req.Header.Set("X-Job-Signature", FileSignature(testKey, id, "index.m3u8", "src-1", old))
	if r, _ := http.DefaultClient.Do(req); r.StatusCode != 403 {
		t.Fatalf("expired: %d", r.StatusCode)
	}
	if r := h.file("GET", strings.Repeat("a", 32), "index.m3u8", "src-1", nil); r.StatusCode != 404 {
		t.Fatalf("unknown: %d", r.StatusCode)
	}
	// An HLS signature can't start a remux.
	body, sig := signed(t, Job{Kind: KindHLS, Input: "http://ts/x"})
	req, _ = http.NewRequest(http.MethodPost, h.hs.URL+"/v1/remux", bytes.NewReader(body))
	req.Header.Set("X-Job-Signature", sig)
	if r, _ := http.DefaultClient.Do(req); r.StatusCode != 400 {
		t.Fatalf("kind: %d", r.StatusCode)
	}

	// Nobody asks for anything: both sessions are removed, ffmpeg killed,
	// slots freed, directories deleted.
	waitDead(t, pid)
	waitFor(t, "cleanup", func() bool {
		m := h.srv.Metrics()
		return m.HLSSessions == 0 && m.ActiveJobs == 0 && len(sessionDirs(t, hlsDir)) == 0
	})
	if r := h.file("GET", id, "index.m3u8", "src-1", nil); r.StatusCode != 404 {
		t.Fatalf("after cleanup: %d", r.StatusCode)
	}
}

func TestHLSSlotsAndEviction(t *testing.T) {
	h := newHarness(t, "hls", func(c *Config) {
		c.MaxJobs = 1
		c.HLSEvictAfter = 300 * time.Millisecond
	})
	resp, a := h.startHLS(Job{Input: "http://ts/x", Owner: "o"})
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	pidA := h.pid()
	// The only slot is taken by a session asked for just now → busy.
	if resp, _ := h.startHLS(Job{Input: "http://ts/x", Owner: "o", Start: 100}); resp.StatusCode != 503 {
		t.Fatalf("second: %d", resp.StatusCode)
	}
	// Once the first player stopped asking (it seeked elsewhere), the new
	// session takes its slot.
	time.Sleep(400 * time.Millisecond)
	resp, b := h.startHLS(Job{Input: "http://ts/x", Owner: "o", Start: 100})
	if resp.StatusCode != 200 || b["session"] == a["session"] {
		t.Fatalf("after idle: %d %v", resp.StatusCode, b)
	}
	waitDead(t, pidA)
	if r := h.file("GET", a["session"].(string), "index.m3u8", "o", nil); r.StatusCode != 404 {
		t.Fatalf("evicted session still served: %d", r.StatusCode)
	}
	// Remux jobs evict idle HLS sessions too.
	time.Sleep(400 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	t.Setenv("FAKE_MODE", "stream")
	r := h.post(ctx, "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x"})
	defer r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("remux: %d", r.StatusCode)
	}
}

func TestHLSFailureAndRestartCleanup(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, "hls", "hls-123")
	if err := os.MkdirAll(stale, 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(stale, "seg0.m4s"), []byte("old"), 0o600)
	keep := filepath.Join(dir, "hls", "other")
	_ = os.MkdirAll(keep, 0o700)
	h := newHarness(t, "fail", func(c *Config) { c.HLSDir = filepath.Join(dir, "hls") })
	// Sessions of the previous process are removed at start (only ours).
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale session kept")
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatal("foreign directory removed")
	}
	// ffmpeg fails before any segment → 502, nothing left behind.
	resp, out := h.startHLS(Job{Input: "http://ts/x", Owner: "o"})
	if resp.StatusCode != 502 || out["error"] == nil {
		t.Fatalf("fail: %d %v", resp.StatusCode, out)
	}
	waitFor(t, "cleanup", func() bool {
		return h.srv.Metrics().HLSSessions == 0 && h.srv.Metrics().ActiveJobs == 0 && len(sessionDirs(t, h.srv.cfg.HLSDir)) == 0
	})
}

// TestHLSThrottleAndRetention drives maintain() on a session with a
// stand-in process: paused when far ahead of the player, resumed when it
// catches up; segments far behind deleted.
func TestHLSThrottleAndRetention(t *testing.T) {
	dir := t.TempDir()
	var pl strings.Builder
	pl.WriteString("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI=\"init.mp4\"\n")
	for i := range 100 { // 100 × 10 s
		fmt.Fprintf(&pl, "#EXTINF:10.0,\nseg%d.m4s\n", i)
		_ = os.WriteFile(filepath.Join(dir, "seg"+strconv.Itoa(i)+".m4s"), bytes.Repeat([]byte("x"), 1000), 0o600)
	}
	_ = os.WriteFile(filepath.Join(dir, hlsPlaylist), []byte(pl.String()), 0o600)
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	state := func() string {
		b, _ := os.ReadFile("/proc/" + strconv.Itoa(cmd.Process.Pid) + "/stat")
		f := strings.Fields(string(b))
		if len(f) < 3 {
			return "?"
		}
		return f[2]
	}
	cfg := Config{HLSAhead: 3 * time.Minute, HLSKeepBehind: 2 * time.Minute, HLSMaxBytes: 1 << 30}
	s := &hlsSession{dir: dir, pid: cmd.Process.Pid, lastSeg: -1, done: make(chan struct{})}

	// 1000 s produced, the player at 0: far ahead → stopped.
	s.maintain(cfg)
	waitFor(t, "SIGSTOP", func() bool { return state() == "T" })
	if !s.stopped {
		t.Fatal("not marked stopped")
	}
	// The player reaches segment 90 (900 s): 100 s ahead → resumed; segments
	// ending more than 2 min before 900 s are deleted.
	s.requested(90)
	s.maintain(cfg)
	waitFor(t, "SIGCONT", func() bool { return state() != "T" })
	for i, want := range map[int]bool{0: false, 76: false, 77: true, 90: true, 99: true} {
		_, err := os.Stat(filepath.Join(dir, "seg"+strconv.Itoa(i)+".m4s"))
		if (err == nil) != want {
			t.Errorf("seg%d present=%v, want %v", i, err == nil, want)
		}
	}
	if !s.trimmed || s.reusable() || s.mayAppear(5) || !s.mayAppear(95) {
		t.Fatalf("trimmed %v reusable %v", s.trimmed, s.reusable())
	}
	// Byte budget (9 segments): the oldest behind the player go first, never
	// the ones at or after it; over half the budget ahead → paused again.
	s.requested(95)
	s.maintain(Config{HLSAhead: time.Hour, HLSKeepBehind: time.Hour, HLSMaxBytes: 9000})
	if s.diskBytes() != 9000 {
		t.Fatalf("kept %d bytes", s.diskBytes())
	}
	for i, want := range map[int]bool{90: false, 91: true, 95: true, 99: true} {
		_, err := os.Stat(filepath.Join(dir, "seg"+strconv.Itoa(i)+".m4s"))
		if (err == nil) != want {
			t.Errorf("budget: seg%d present=%v, want %v", i, err == nil, want)
		}
	}
	waitFor(t, "SIGSTOP by bytes", func() bool { return state() == "T" })
}

// ---------------------------------------------------------------- real ffmpeg

// realHarness: the real ffmpeg/ffprobe on a generated MKV served with Range
// (a stand-in for TorrServer). Skipped where ffmpeg isn't installed; run it
// in the test image (Dockerfile target "test").
func realHarness(t *testing.T, vcodec string) (*harness, string) {
	t.Helper()
	ff, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not installed (docker build --target test)")
	}
	fp, _ := exec.LookPath("ffprobe")
	dir := t.TempDir()
	mkv := filepath.Join(dir, "in.mkv")
	size := "320x180"
	if vcodec == "mpeg4" {
		// XviD in AVI (packed B-frames), an odd SD size like real rips.
		mkv, size = filepath.Join(dir, "in.avi"), "640x272"
	}
	gen := exec.Command(ff, "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size="+size+":rate=24:duration=30",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30",
		"-map", "0:v", "-map", "1:a", "-c:v", vcodec, "-pix_fmt", "yuv420p", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
		"-c:a", "ac3", "-b:a", "128k", mkv)
	switch vcodec {
	case "libx265":
		gen.Args = append(gen.Args[:len(gen.Args)-1], "-x265-params", "log-level=error:keyint=48:min-keyint=48:scenecut=0", mkv)
	case "mpeg4":
		gen.Args = append(gen.Args[:len(gen.Args)-1], "-vtag", "XVID", "-bf", "2", "-q:v", "4", "-ac", "6", mkv)
	}
	if out, err := gen.CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v %s", err, out)
	}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != "ts" || p != "pw" {
			w.WriteHeader(401)
			return
		}
		http.ServeFile(w, r, mkv)
	}))
	t.Cleanup(ts.Close)
	h := &harness{t: t}
	h.srv = NewServer(Config{
		Key: testKey, MaxJobs: 2, SlotWait: time.Second, IdleTimeout: 30 * time.Second, MaxDuration: time.Minute,
		FFmpeg: ff, FFprobe: fp, HLSDir: filepath.Join(dir, "hls"),
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.hs = httptest.NewServer(h.srv.Handler())
	t.Cleanup(h.hs.Close)
	t.Cleanup(h.srv.Close)
	return h, ts.URL + "/stream?link=abc&index=1&play"
}

// probe runs ffprobe on a file / playlist and returns its JSON.
func probe(t *testing.T, target string) map[string]any {
	t.Helper()
	out, err := exec.Command("ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", target).Output()
	if err != nil {
		t.Fatalf("ffprobe %s: %v", target, err)
	}
	var p map[string]any
	_ = json.Unmarshal(out, &p)
	return p
}

func codecs(p map[string]any) []string {
	var out []string
	for _, s := range p["streams"].([]any) {
		m := s.(map[string]any)
		out = append(out, m["codec_name"].(string)+"/"+fmt.Sprint(m["codec_tag_string"]))
	}
	return out
}

func waitEnded(t *testing.T, sess *hlsSession) {
	t.Helper()
	waitFor(t, "ENDLIST", func() bool {
		sess.mu.Lock()
		defer sess.mu.Unlock()
		sess.refreshLocked()
		return sess.ended && sess.exited
	})
}

func TestHLSRealFFmpegH264(t *testing.T) {
	h, input := realHarness(t, "libx264")
	auth := "Basic dHM6cHc=" // ts:pw
	resp, out := h.startHLS(Job{Input: input, Auth: auth, Owner: "src", Audio: intp(1)})
	if resp.StatusCode != 200 {
		t.Fatalf("start %d %v", resp.StatusCode, out)
	}
	id := out["session"].(string)
	sess := h.srv.hls.get(id)
	waitEnded(t, sess)

	// What Safari gets: an fMP4 EVENT playlist with ENDLIST, H.264 copied,
	// AC3 → AAC stereo, the whole 30 s.
	r := h.file("GET", id, "index.m3u8", "src", nil)
	pl := string(readAll(t, r))
	for _, want := range []string{"#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-INDEPENDENT-SEGMENTS", `#EXT-X-MAP:URI="init.mp4"`, "seg0.m4s", "#EXT-X-ENDLIST"} {
		if !strings.Contains(pl, want) {
			t.Fatalf("playlist lacks %q:\n%s", want, pl)
		}
	}
	segs, _ := parsePlaylist([]byte(pl))
	if len(segs) < 5 || len(segs) > 9 {
		t.Fatalf("%d segments:\n%s", len(segs), pl)
	}
	p := probe(t, filepath.Join(sess.dir, hlsPlaylist))
	if c := codecs(p); len(c) != 2 || c[0] != "h264/avc1" || !strings.HasPrefix(c[1], "aac/") {
		t.Fatalf("codecs %v", c)
	}
	if d, _ := strconv.ParseFloat(p["format"].(map[string]any)["duration"].(string), 64); d < 29 || d > 31 {
		t.Fatalf("duration %v", d)
	}
	for _, s := range p["streams"].([]any) {
		if m := s.(map[string]any); m["codec_type"] == "audio" && m["channels"].(float64) != 2 {
			t.Fatalf("audio %v", m)
		}
	}
	// init.mp4 is an MP4 header with the movie box; segments are moof/mdat
	// and come with ranges.
	r = h.file("GET", id, "init.mp4", "src", nil)
	init := readAll(t, r)
	if !bytes.Contains(init, []byte("ftyp")) || !bytes.Contains(init, []byte("moov")) || !bytes.Contains(init, []byte("avc1")) {
		t.Fatal("init segment")
	}
	r = h.file("GET", id, "seg1.m4s", "src", map[string]string{"Range": "bytes=0-1023"})
	b := readAll(t, r)
	if r.StatusCode != 206 || len(b) != 1024 || !bytes.Contains(b, []byte("moof")) || !strings.HasPrefix(r.Header.Get("Content-Range"), "bytes 0-1023/") {
		t.Fatalf("segment range %d %v", r.StatusCode, r.Header)
	}

	// A start: the stream begins at the keyframe before it (every 2 s).
	resp, out = h.startHLS(Job{Input: input, Auth: auth, Owner: "src", Audio: intp(1), Start: 11})
	if resp.StatusCode != 200 || resp.Header.Get("X-Stream-Start") != "10.000" || out["session"] == id {
		t.Fatalf("start=11: %d %v %v", resp.StatusCode, resp.Header, out)
	}
	s2 := h.srv.hls.get(out["session"].(string))
	waitEnded(t, s2)
	if d, _ := strconv.ParseFloat(probe(t, filepath.Join(s2.dir, hlsPlaylist))["format"].(map[string]any)["duration"].(string), 64); d < 19 || d > 21 {
		t.Fatalf("duration from 10 s: %v", d)
	}
	// Finished sessions are still reused (all segments kept).
	if _, again := h.startHLS(Job{Input: input, Auth: auth, Owner: "src", Audio: intp(1)}); again["session"] != id {
		t.Fatalf("not reused: %v", again)
	}
	if m := h.srv.Metrics(); m.HLSSessions != 2 || m.ActiveJobs != 0 || m.HLSBytes <= 0 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestHLSRealFFmpegHEVCTag(t *testing.T) {
	h, input := realHarness(t, "libx265")
	resp, out := h.startHLS(Job{Input: input, Auth: "Basic dHM6cHc=", Owner: "src", HVC1: true})
	if resp.StatusCode != 200 {
		t.Fatalf("start %d %v", resp.StatusCode, out)
	}
	sess := h.srv.hls.get(out["session"].(string))
	waitEnded(t, sess)
	init, _ := os.ReadFile(filepath.Join(sess.dir, hlsInit))
	// Safari only plays HEVC tagged hvc1 (ffmpeg's default is hev1).
	if !bytes.Contains(init, []byte("hvc1")) || bytes.Contains(init, []byte("hev1")) {
		t.Fatal("init segment is not tagged hvc1")
	}
	if c := codecs(probe(t, filepath.Join(sess.dir, hlsPlaylist))); len(c) != 2 || c[0] != "hevc/hvc1" {
		t.Fatalf("codecs %v", c)
	}
}

func TestHLSRealFFmpegBadInput(t *testing.T) {
	h, input := realHarness(t, "libx264")
	// Wrong credentials: TorrServer answers 401 → 502, no session left.
	resp, out := h.startHLS(Job{Input: input, Auth: "Basic eDp5", Owner: "src"})
	if resp.StatusCode != 502 || out["error"] == nil {
		t.Fatalf("bad input %d %v", resp.StatusCode, out)
	}
	waitFor(t, "cleanup", func() bool { return h.srv.Metrics().HLSSessions == 0 && h.srv.Metrics().ActiveJobs == 0 })
}

// XviD AVI (MPEG-4 Part 2, AC3 5.1): video re-encoded to H.264, playable
// fMP4 from the start and from a seek; the progressive remux too.
func TestRealFFmpegXviDToH264(t *testing.T) {
	h, input := realHarness(t, "mpeg4")
	auth := "Basic dHM6cHc="
	resp, out := h.startHLS(Job{Input: input, Auth: auth, Owner: "src", Video: VideoH264})
	if resp.StatusCode != 200 {
		t.Fatalf("start %d %v", resp.StatusCode, out)
	}
	sess := h.srv.hls.get(out["session"].(string))
	waitEnded(t, sess)
	p := probe(t, filepath.Join(sess.dir, hlsPlaylist))
	if c := codecs(p); len(c) != 2 || c[0] != "h264/avc1" || !strings.HasPrefix(c[1], "aac/") {
		t.Fatalf("codecs %v", c)
	}
	if d, _ := strconv.ParseFloat(p["format"].(map[string]any)["duration"].(string), 64); d < 29 || d > 31 {
		t.Fatalf("duration %v", d)
	}
	for _, st := range p["streams"].([]any) {
		if m := st.(map[string]any); m["codec_type"] == "video" && (m["width"].(float64) != 640 || m["height"].(float64) != 272 || m["profile"] != "High" || m["pix_fmt"] != "yuv420p") {
			t.Fatalf("video %v", m)
		}
	}
	// Segments of ~4 s (keyframes every 2 s, not the source's GOP).
	pl, _ := os.ReadFile(filepath.Join(sess.dir, hlsPlaylist))
	if segs, _ := parsePlaylist(pl); len(segs) < 6 || len(segs) > 9 {
		t.Fatalf("%d segments:\n%s", len(segs), pl)
	}

	// A seek: starts at the source keyframe ≤ 11 s (every 2 s; AVI's B-frame
	// delay puts it a frame or two before 10 s), ~20 s long.
	resp, out = h.startHLS(Job{Input: input, Auth: auth, Owner: "src", Video: VideoH264, Start: 11})
	if k, _ := strconv.ParseFloat(resp.Header.Get("X-Stream-Start"), 64); resp.StatusCode != 200 || k < 9.8 || k > 10 {
		t.Fatalf("start=11: %d %v %v", resp.StatusCode, resp.Header, out)
	}
	s2 := h.srv.hls.get(out["session"].(string))
	waitEnded(t, s2)
	p2 := probe(t, filepath.Join(s2.dir, hlsPlaylist))
	if d, _ := strconv.ParseFloat(p2["format"].(map[string]any)["duration"].(string), 64); d < 19 || d > 21 {
		t.Fatalf("duration from 10 s: %v", d)
	}

	// compat.mp4 (fragmented MP4 to stdout).
	body, sig := signed(t, Job{Kind: KindRemux, Input: input, Auth: auth, Video: VideoH264, Channels: 6})
	req, _ := http.NewRequest("POST", h.hs.URL+"/v1/remux", bytes.NewReader(body))
	req.Header.Set("X-Job-Signature", sig)
	r, err := http.DefaultClient.Do(req)
	if err != nil || r.StatusCode != 200 {
		t.Fatalf("remux %v %v", r, err)
	}
	mp4 := filepath.Join(t.TempDir(), "out.mp4")
	if err := os.WriteFile(mp4, readAll(t, r), 0o600); err != nil {
		t.Fatal(err)
	}
	p3 := probe(t, mp4)
	if c := codecs(p3); len(c) != 2 || c[0] != "h264/avc1" || !strings.HasPrefix(c[1], "aac/") {
		t.Fatalf("remux codecs %v", c)
	}
	for _, st := range p3["streams"].([]any) {
		if m := st.(map[string]any); m["codec_type"] == "audio" && m["channels"].(float64) != 6 {
			t.Fatalf("audio %v", m)
		}
	}
}
