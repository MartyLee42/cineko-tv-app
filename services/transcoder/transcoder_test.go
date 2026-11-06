package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

var testKey = jobKey([]byte(strings.Repeat("k", 40)))

func intp(n int) *int { return &n }

func signed(t *testing.T, j Job) ([]byte, string) {
	t.Helper()
	if j.V == 0 {
		j.V = 1
	}
	if j.Exp == 0 {
		j.Exp = time.Now().Add(time.Minute).Unix()
	}
	b, err := json.Marshal(j)
	if err != nil {
		t.Fatal(err)
	}
	return b, Sign(testKey, b)
}

// ---------------------------------------------------------------- arguments

func argAfter(args []string, flag string) string {
	i := slices.Index(args, flag)
	if i < 0 || i+1 >= len(args) {
		return ""
	}
	return args[i+1]
}

func TestRemuxArgs(t *testing.T) {
	j := &Job{Input: "http://ts:5665/stream?link=h&index=1&play", Auth: "Basic dTpw", Audio: intp(2)}
	a := RemuxArgs(j, 118.5)
	s := strings.Join(a, " ")
	for _, want := range []string{
		"-ss 118.650 -i http://ts:5665/stream?link=h&index=1&play",
		"-map 0:V:0 -map 0:2",
		"-c:v copy",
		"-c:a aac -ac 2 -b:a 192k",
		"-movflags frag_keyframe+empty_moov+default_base_moof",
		"-f mp4 pipe:1",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in %s", want, s)
		}
	}
	if argAfter(a, "-headers") != "Authorization: Basic dTpw\r\n" {
		t.Errorf("headers %q", argAfter(a, "-headers"))
	}
	// -ss must be an input option (before -i): fast seek to a keyframe.
	if slices.Index(a, "-ss") > slices.Index(a, "-i") {
		t.Error("-ss after -i")
	}
	if strings.Contains(s, "hvc1") || strings.Contains(s, "-c:a copy") {
		t.Error("unexpected options", s)
	}
	// Copy is the default: no encoder, no filters, no genpts.
	for _, no := range []string{"libx264", "-vf", "genpts", "-threads"} {
		if strings.Contains(s, no) {
			t.Errorf("copy job has %q: %s", no, s)
		}
	}

	// Start 0: no seek; no audio index: first audio track, optional.
	a = RemuxArgs(&Job{Input: "http://ts/x", HVC1: true, AudioCopy: true}, 0)
	s = strings.Join(a, " ")
	if slices.Contains(a, "-ss") || slices.Contains(a, "-headers") || !strings.Contains(s, "-map 0:a:0?") ||
		!strings.Contains(s, "-tag:v hvc1") || !strings.Contains(s, "-c:a copy") || strings.Contains(s, "aac") {
		t.Errorf("args %s", s)
	}
	// 5.1.
	if s := strings.Join(RemuxArgs(&Job{Input: "http://ts/x", Channels: 6}, 0), " "); !strings.Contains(s, "-ac 6 -b:a 384k") {
		t.Errorf("5.1 args %s", s)
	}
}

func TestVideoTranscodeArgs(t *testing.T) {
	j := &Job{Input: "http://ts/x", Audio: intp(1), Video: VideoH264}
	for name, a := range map[string][]string{"remux": RemuxArgs(j, 118.5), "hls": HLSArgs(j, 118.5)} {
		s := strings.Join(a, " ")
		for _, want := range []string{
			// Accurate seek: the keyframe itself is t=0 (no pad), genpts for AVI.
			"-ss 118.500 -fflags +genpts -threads 2 -i http://ts/x",
			"-map 0:V:0 -map 0:1",
			"-filter_threads 1 -vf yadif=deint=interlaced,scale=trunc(iw/2)*2:trunc(ih/2)*2",
			"-c:v libx264 -preset veryfast -crf 21",
			"-profile:v high -level:v 4.0 -pix_fmt yuv420p",
			"-force_key_frames expr:gte(t,n_forced*2)",
			"-force_key_frames expr:gte(t,n_forced*2) -threads 2 -c:a",
			"-c:a aac -ac 2 -b:a 192k",
		} {
			if !strings.Contains(s, want) {
				t.Errorf("%s: missing %q in %s", name, want, s)
			}
		}
		if strings.Contains(s, "-c:v copy") || strings.Contains(s, "hvc1") {
			t.Errorf("%s: %s", name, s)
		}
	}
	// Threads from the config; start 0: no seek.
	j.threads = 3
	if s := strings.Join(RemuxArgs(j, 0), " "); strings.Count(s, "-threads 3") != 2 || strings.Contains(s, "-ss") {
		t.Errorf("threads: %s", s)
	}
}

func TestSubtitleAndKeyframeArgs(t *testing.T) {
	j := &Job{Input: "http://ts/x", Stream: 5, Burst: 90}
	a := SubtitleArgs(j, 60, 4)
	s := strings.Join(a, " ")
	for _, want := range []string{"-ss 60.150", "-readrate 4.000 -readrate_initial_burst 90.000 -i http://ts/x", "-map 0:5 -output_ts_offset 0.150 -c:s webvtt", "-f webvtt pipe:1"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in %s", want, s)
		}
	}
	if s := strings.Join(SubtitleArgs(&Job{Input: "http://ts/x", Stream: 3}, 0, 0), " "); strings.Contains(s, "readrate") || strings.Contains(s, "-ss") {
		t.Errorf("unlimited subs %s", s)
	}

	k := KeyframeArgs(&Job{Input: "http://ts/x"}, 600)
	if argAfter(k, "-read_intervals") != "600.000%+#8" || argAfter(k, "-select_streams") != "V:0" || k[len(k)-1] != "http://ts/x" {
		t.Errorf("keyframe args %v", k)
	}
	got, err := ParseKeyframe([]byte(`{"packets":[{"pts_time":"N/A","dts_time":"601.5","flags":"K_"}],"format":{"start_time":"1.400000"}}`))
	if err != nil || got != 600.1 {
		t.Errorf("keyframe %v %v", got, err)
	}
	if _, err := ParseKeyframe([]byte(`{"packets":[{"pts_time":"3","flags":"__"}]}`)); err == nil {
		t.Error("no keyframe accepted")
	}
}

func TestSanitize(t *testing.T) {
	j := &Job{Input: "http://ts.local:5665/stream?link=abc&index=1", Auth: "Basic c2VjcmV0"}
	out := sanitize("Error opening http://ts.local:5665/stream?link=abc&index=1 with Basic c2VjcmV0; also https://other/x?y", j)
	if strings.Contains(out, "ts.local") || strings.Contains(out, "c2VjcmV0") || strings.Contains(out, "other") {
		t.Fatal(out)
	}
}

// ---------------------------------------------------------------- signatures

func TestParseJob(t *testing.T) {
	now := time.Now()
	body, sig := signed(t, Job{Kind: KindRemux, Input: "http://ts/x", Audio: intp(1), Start: 12})
	j, err := ParseJob(testKey, body, sig, KindRemux, now)
	if err != nil || *j.Audio != 1 || j.Start != 12 || j.Video != "" {
		t.Fatalf("valid job: %v %v", j, err)
	}
	b0, s0 := signed(t, Job{Kind: KindRemux, Input: "http://ts/x", Video: VideoH264})
	if j, err := ParseJob(testKey, b0, s0, KindRemux, now); err != nil || j.Video != VideoH264 {
		t.Fatalf("video job: %v %v", j, err)
	}
	// Wrong kind for the endpoint, tampered body, wrong key, junk signature.
	if _, err := ParseJob(testKey, body, sig, KindSubtitles, now); err != errBadJob {
		t.Errorf("kind: %v", err)
	}
	tampered := bytes.Replace(body, []byte(`"audio":1`), []byte(`"audio":2`), 1)
	if _, err := ParseJob(testKey, tampered, sig, KindRemux, now); err != errBadSignature {
		t.Errorf("tampered: %v", err)
	}
	if _, err := ParseJob(jobKey([]byte(strings.Repeat("x", 40))), body, sig, KindRemux, now); err != errBadSignature {
		t.Errorf("other key: %v", err)
	}
	for _, s := range []string{"", "zz", sig[:10]} {
		if _, err := ParseJob(testKey, body, s, KindRemux, now); err != errBadSignature {
			t.Errorf("sig %q: %v", s, err)
		}
	}
	// Expired, or valid for too long.
	b, s := signed(t, Job{Kind: KindRemux, Input: "http://ts/x", Exp: now.Add(-time.Second).Unix()})
	if _, err := ParseJob(testKey, b, s, KindRemux, now); err != errExpired {
		t.Errorf("expired: %v", err)
	}
	b, s = signed(t, Job{Kind: KindRemux, Input: "http://ts/x", Exp: now.Add(time.Hour).Unix()})
	if _, err := ParseJob(testKey, b, s, KindRemux, now); err != errBadJob {
		t.Errorf("long expiry: %v", err)
	}
	// Signed but invalid fields are still refused.
	for _, bad := range []Job{
		{Kind: KindRemux, Input: "file:///etc/passwd"},
		{Kind: KindRemux, Input: "http://ts/x", Auth: "Basic x\r\nX-Evil: 1"},
		{Kind: KindRemux, Input: "http://ts/x", Audio: intp(-1)},
		{Kind: KindRemux, Input: "http://ts/x", Start: -5},
		{Kind: KindRemux, Input: "http://ts/x", Start: 1e9},
		{Kind: KindRemux, Input: "http://ts/x", Channels: 3},
		{Kind: KindRemux, Input: "http://ts/x", V: 2},
		{Kind: KindRemux, Input: "http://ts/x", Video: "hevc"},
		{Kind: KindRemux, Input: "http://ts/x", Video: VideoH264, HVC1: true},
	} {
		b, s := signed(t, bad)
		if _, err := ParseJob(testKey, b, s, KindRemux, now); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
	b = []byte(`{"v":1,"kind":"remux","input":"http://ts/x","exp":` + strconv.FormatInt(now.Add(time.Minute).Unix(), 10) + `,"extra":1}`)
	if _, err := ParseJob(testKey, b, Sign(testKey, b), KindRemux, now); err != errBadJob {
		t.Errorf("unknown field: %v", err)
	}
}

// ---------------------------------------------------------------- server

type harness struct {
	t       *testing.T
	srv     *Server
	hs      *httptest.Server
	pidfile string
	args    string
}

func newHarness(t *testing.T, mode string, tweak func(*Config)) *harness {
	t.Helper()
	dir := t.TempDir()
	td, _ := filepath.Abs("testdata")
	h := &harness{t: t, pidfile: filepath.Join(dir, "pid"), args: filepath.Join(dir, "args")}
	t.Setenv("FAKE_MODE", mode)
	t.Setenv("FAKE_PIDFILE", h.pidfile)
	t.Setenv("FAKE_ARGS", h.args)
	cfg := Config{
		Key: testKey, MaxJobs: 2, SlotWait: 50 * time.Millisecond, IdleTimeout: 5 * time.Second, MaxDuration: time.Minute,
		FFmpeg: filepath.Join(td, "fake-ffmpeg.sh"), FFprobe: filepath.Join(td, "fake-ffprobe.sh"),
		HLSDir: filepath.Join(dir, "hls"),
	}
	if tweak != nil {
		tweak(&cfg)
	}
	h.srv = NewServer(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	h.hs = httptest.NewServer(h.srv.Handler())
	t.Cleanup(h.hs.Close)
	t.Cleanup(h.srv.Close)
	return h
}

func (h *harness) post(ctx context.Context, path string, j Job) *http.Response {
	h.t.Helper()
	body, sig := signed(h.t, j)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.hs.URL+path, bytes.NewReader(body))
	req.Header.Set("X-Job-Signature", sig)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

func (h *harness) pid() int {
	for range 100 {
		if b, err := os.ReadFile(h.pidfile); err == nil && len(bytes.TrimSpace(b)) > 0 {
			n, _ := strconv.Atoi(string(bytes.TrimSpace(b)))
			return n
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.t.Fatal("ffmpeg never started")
	return 0
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func waitDead(t *testing.T, pid int) {
	t.Helper()
	for range 150 {
		if !alive(pid) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("ffmpeg %d still running", pid)
}

func waitActive(t *testing.T, s *Server, n int) {
	t.Helper()
	for range 150 {
		if s.Metrics().ActiveJobs == n {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("active jobs %d, want %d", s.Metrics().ActiveJobs, n)
}

func TestRemuxStreamsAndDisconnectKillsFFmpeg(t *testing.T) {
	h := newHarness(t, "stream", nil)
	ctx, cancel := context.WithCancel(context.Background())
	resp := h.post(ctx, "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x", Audio: intp(3), Start: 120})
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "video/mp4" {
		t.Fatalf("status %d %v", resp.StatusCode, resp.Header)
	}
	// The keyframe probe moved the start to 118.5 (fake-ffprobe).
	if resp.Header.Get("X-Stream-Start") != "118.500" {
		t.Fatalf("X-Stream-Start %q", resp.Header.Get("X-Stream-Start"))
	}
	buf := make([]byte, 200)
	if _, err := io.ReadFull(resp.Body, buf); err != nil {
		t.Fatal(err)
	}
	pid := h.pid()
	if !alive(pid) || h.srv.Metrics().ActiveJobs != 1 {
		t.Fatal("job not running")
	}
	args, _ := os.ReadFile(h.args)
	if !strings.Contains(string(args), "-ss\n118.650\n-i\nhttp://ts/x") || !strings.Contains(string(args), "0:3") {
		t.Fatalf("ffmpeg args:\n%s", args)
	}

	// The player goes away: ffmpeg is killed and the slot freed.
	cancel()
	resp.Body.Close()
	waitDead(t, pid)
	waitActive(t, h.srv, 0)
	if m := h.srv.Metrics(); m.JobsStarted != 1 || m.MaxJobs != 2 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestJobLimit503(t *testing.T) {
	h := newHarness(t, "stream", func(c *Config) { c.MaxJobs = 1 })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := h.post(ctx, "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x"})
	if first.StatusCode != 200 {
		t.Fatal(first.StatusCode)
	}
	defer first.Body.Close()
	second := h.post(context.Background(), "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x"})
	body, _ := io.ReadAll(second.Body)
	second.Body.Close()
	if second.StatusCode != 503 || !strings.Contains(string(body), `"transcoder_busy"`) {
		t.Fatalf("second: %d %s", second.StatusCode, body)
	}
	if h.srv.Metrics().JobsRejected != 1 {
		t.Fatal("rejection not counted")
	}
	// A slot freed within SlotWait is taken (seek = stop old + start new).
	pid := h.pid()
	cancel()
	first.Body.Close()
	waitDead(t, pid)
	waitActive(t, h.srv, 0)
	third := h.post(context.Background(), "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x"})
	third.Body.Close()
	if third.StatusCode != 200 {
		t.Fatal(third.StatusCode)
	}
}

func TestRemuxErrorsAndAuth(t *testing.T) {
	h := newHarness(t, "fail", nil)
	// Unsigned / forged requests never reach ffmpeg.
	req, _ := http.NewRequest(http.MethodPost, h.hs.URL+"/v1/remux", strings.NewReader(`{"v":1,"kind":"remux","input":"http://evil/x","exp":9999999999}`))
	req.Header.Set("X-Job-Signature", strings.Repeat("0", 64))
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("forged: %d", resp.StatusCode)
	}
	// A remux signature doesn't work on the subtitle endpoint.
	body, sig := signed(t, Job{Kind: KindRemux, Input: "http://ts/x"})
	req, _ = http.NewRequest(http.MethodPost, h.hs.URL+"/v1/subtitles", bytes.NewReader(body))
	req.Header.Set("X-Job-Signature", sig)
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("kind mismatch: %d", resp.StatusCode)
	}
	if _, err := os.Stat(h.pidfile); err == nil {
		t.Fatal("ffmpeg ran for a refused job")
	}
	// ffmpeg fails before any output → clean 502 (no URL in the answer).
	resp = h.post(context.Background(), "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x"})
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 502 || !strings.Contains(string(b), "stream_unavailable") || strings.Contains(string(b), "ts.local") {
		t.Fatalf("fail: %d %s", resp.StatusCode, b)
	}
	if h.srv.Metrics().JobsFailed != 1 || h.srv.Metrics().ActiveJobs != 0 {
		t.Fatalf("metrics %+v", h.srv.Metrics())
	}
}

func TestIdleWatchdogKillsStalledJob(t *testing.T) {
	h := newHarness(t, "silent", func(c *Config) { c.IdleTimeout = 300 * time.Millisecond })
	t0 := time.Now()
	resp := h.post(context.Background(), "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x"})
	resp.Body.Close()
	if resp.StatusCode != 502 || time.Since(t0) > 5*time.Second {
		t.Fatalf("stalled job: %d after %v", resp.StatusCode, time.Since(t0))
	}
	waitDead(t, h.pid())
}

func TestMaxDurationCap(t *testing.T) {
	h := newHarness(t, "stream", func(c *Config) { c.MaxDuration = 400 * time.Millisecond })
	resp := h.post(context.Background(), "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x"})
	t0 := time.Now()
	_, _ = io.Copy(io.Discard, resp.Body) // ends when the cap hits
	resp.Body.Close()
	if time.Since(t0) > 5*time.Second {
		t.Fatal("not capped")
	}
	waitDead(t, h.pid())
}

func TestKeyframeAndSubtitles(t *testing.T) {
	h := newHarness(t, "short", nil)
	count := filepath.Join(t.TempDir(), "probes")
	t.Setenv("FAKE_PROBE_COUNT", count)
	resp := h.post(context.Background(), "/v1/keyframe", Job{Kind: KindKeyframe, Input: "http://ts/x", Start: 120})
	var out struct{ Start float64 }
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if resp.StatusCode != 200 || out.Start != 118.5 || resp.Header.Get("X-Stream-Start") != "118.500" {
		t.Fatalf("keyframe %d %v", resp.StatusCode, out)
	}
	// The remux right after (at the keyframe) reuses the probe.
	resp = h.post(context.Background(), "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x", Start: 118.5})
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(b) != "ftypfake" || resp.Header.Get("X-Stream-Start") != "118.500" {
		t.Fatalf("remux %q %v", b, resp.Header)
	}
	if n, _ := os.ReadFile(count); strings.Count(string(n), "x") != 1 {
		t.Fatalf("probes: %q", n)
	}
	// Subtitles: WebVTT content type, -ss from the keyframe.
	resp = h.post(context.Background(), "/v1/subtitles", Job{Kind: KindSubtitles, Input: "http://ts/x", Stream: 4, Start: 120})
	resp.Body.Close()
	args, _ := os.ReadFile(h.args)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "text/vtt; charset=utf-8" ||
		!strings.Contains(string(args), "-ss\n118.650") || !strings.Contains(string(args), "-map\n0:4\n-output_ts_offset\n0.150\n-c:s\nwebvtt") {
		t.Fatalf("subs %d %v\n%s", resp.StatusCode, resp.Header, args)
	}
}

func TestMetricsAndConfig(t *testing.T) {
	h := newHarness(t, "short", nil)
	resp, err := http.Get(h.hs.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	var m Metrics
	_ = json.NewDecoder(resp.Body).Decode(&m)
	resp.Body.Close()
	if m.MaxJobs != 2 || m.ActiveJobs != 0 {
		t.Fatalf("%+v", m)
	}

	env := map[string]string{"TRANSCODER_SECRET": "short"}
	if _, _, err := loadConfig(func(k string) string { return env[k] }); err == nil {
		t.Fatal("short secret accepted")
	}
	env = map[string]string{"TRANSCODER_SECRET": strings.Repeat("s", 32), "TRANSCODER_MAX_JOBS": "5", "TRANSCODER_NICE": "0"}
	cfg, addr, err := loadConfig(func(k string) string { return env[k] })
	if err != nil || cfg.MaxJobs != 5 || addr != ":8090" || cfg.IdleTimeout != 2*time.Minute || cfg.NicePath != "" || cfg.SubReadRate != 4 {
		t.Fatalf("%+v %s %v", cfg, addr, err)
	}
	env["TRANSCODER_MAX_JOBS"] = "0"
	if _, _, err := loadConfig(func(k string) string { return env[k] }); err == nil {
		t.Fatal("0 jobs accepted")
	}
}
