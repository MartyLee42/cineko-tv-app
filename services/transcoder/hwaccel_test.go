package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

var discardLog = slog.New(slog.NewTextHandler(io.Discard, nil))

// ---------------------------------------------------------------- arguments

func TestEncodeArgsPerBackend(t *testing.T) {
	vaapi := Encoder{Backend: BackendVAAPI, Device: "/dev/dri/renderD128"}
	qsv := Encoder{Backend: BackendQSV, Device: "/dev/dri/renderD129"}
	for _, tc := range []struct {
		enc       Encoder
		want, not []string
	}{
		{Encoder{}, []string{"-vf " + cpuFilters + " -c:v libx264", "-crf 21", "-level:v 4.0 -pix_fmt yuv420p", "-threads 2"}, []string{"hwupload", "nvenc"}},
		{Encoder{Backend: BackendNVENC}, []string{"-vf " + cpuFilters + ",format=yuv420p -c:v h264_nvenc", "-maxrate 8M -bufsize 16M", "-pix_fmt yuv420p -forced-idr 1"}, []string{"libx264", "-crf", "hwupload", "-threads"}},
		{vaapi, []string{"-vf " + cpuFilters + ",format=nv12,hwupload -c:v h264_vaapi", "-b:v 5M -maxrate 8M -bufsize 16M"}, []string{"libx264", "-crf", "-threads"}},
		{qsv, []string{",format=nv12,hwupload=extra_hw_frames=64,format=qsv -c:v h264_qsv", "-forced_idr 1"}, []string{"libx264", "-crf", "-threads"}},
	} {
		s := strings.Join(encodeArgs(tc.enc, 2), " ")
		// Every backend: H.264 High 4.0, keyframe every x264GOP seconds, one filter thread.
		want := append(tc.want, "-filter_threads 1", "-force_key_frames expr:gte(t,n_forced*2)", "-profile:v high -level:v 4")
		for _, w := range want {
			if !strings.Contains(s, w) {
				t.Errorf("%s: missing %q in %s", tc.enc, w, s)
			}
		}
		for _, n := range tc.not {
			if strings.Contains(s, n) {
				t.Errorf("%s: unexpected %q in %s", tc.enc, n, s)
			}
		}
	}
	if s := strings.Join(hwInputArgs(vaapi), " "); s != "-init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va" {
		t.Errorf("vaapi input %s", s)
	}
	if s := strings.Join(hwInputArgs(qsv), " "); s != "-init_hw_device vaapi=va:/dev/dri/renderD129 -init_hw_device qsv=qs@va -filter_hw_device qs" {
		t.Errorf("qsv input %s", s)
	}
	if hwInputArgs(Encoder{Backend: BackendNVENC}) != nil || hwInputArgs(Encoder{}) != nil {
		t.Error("nvenc / cpu need no device options")
	}
}

func TestJobArgsWithGPU(t *testing.T) {
	enc := Encoder{Backend: BackendVAAPI, Device: "/dev/dri/renderD128"}
	j := &Job{Input: "http://ts/x", Video: VideoH264, enc: enc}
	for name, a := range map[string][]string{"remux": RemuxArgs(j, 10), "hls": HLSArgs(j, 10)} {
		// The device is a global option: before -i.
		if d, i := slices.Index(a, "-init_hw_device"), slices.Index(a, "-i"); d < 0 || d > i {
			t.Errorf("%s: device options misplaced: %v", name, a)
		}
		if argAfter(a, "-c:v") != "h264_vaapi" || argAfter(a, "-c:a") != "aac" {
			t.Errorf("%s: %v", name, a)
		}
	}
	// Copied video never opens the GPU, even with an encoder set.
	c := &Job{Input: "http://ts/x", enc: enc}
	if s := strings.Join(RemuxArgs(c, 10), " "); strings.Contains(s, "hw_device") || !strings.Contains(s, "-c:v copy") {
		t.Errorf("copy job: %s", s)
	}
	// The probe encodes through the same chain to null.
	s := strings.Join(testEncodeArgs(enc), " ")
	if !strings.Contains(s, "-init_hw_device vaapi=va:/dev/dri/renderD128 -filter_hw_device va -f lavfi -i testsrc2") ||
		!strings.Contains(s, "-c:v h264_vaapi") || !strings.HasSuffix(s, "-f null -") {
		t.Errorf("probe: %s", s)
	}
}

// ---------------------------------------------------------------- detection

func TestParseHWMode(t *testing.T) {
	for in, want := range map[string]HWMode{"": HWAuto, "auto": HWAuto, " VAAPI ": "vaapi", "none": HWNone, "cpu": HWNone, "nvenc": "nvenc", "qsv": "qsv"} {
		if m, err := parseHWMode(in); err != nil || m != want {
			t.Errorf("%q → %q %v", in, m, err)
		}
	}
	if _, err := parseHWMode("cuda"); err == nil {
		t.Error("cuda accepted")
	}
	env := map[string]string{"TRANSCODER_SECRET": strings.Repeat("s", 32), "TRANSCODER_HWACCEL": "gpu"}
	if _, _, err := loadConfig(func(k string) string { return env[k] }); err == nil {
		t.Error("bad TRANSCODER_HWACCEL accepted")
	}
	env["TRANSCODER_HWACCEL"], env["TRANSCODER_HWACCEL_DEVICE"] = "", "/dev/dri/renderD129"
	if cfg, _, err := loadConfig(func(k string) string { return env[k] }); err != nil || cfg.HWMode != HWAuto || cfg.HWDevice != "/dev/dri/renderD129" {
		t.Errorf("%v %v %v", cfg.HWMode, cfg.HWDevice, err)
	}
}

func TestCandidates(t *testing.T) {
	both := Devices{Nvidia: true, Render: []string{"/dev/dri/renderD128", "/dev/dri/renderD129"}}
	str := func(es []Encoder) string {
		var s []string
		for _, e := range es {
			s = append(s, e.String())
		}
		return strings.Join(s, " ")
	}
	for _, tc := range []struct {
		mode   HWMode
		dev    Devices
		device string
		want   string
	}{
		{HWAuto, both, "", "nvenc vaapi:/dev/dri/renderD128 vaapi:/dev/dri/renderD129 qsv:/dev/dri/renderD128 qsv:/dev/dri/renderD129"},
		{HWAuto, Devices{Render: []string{"/dev/dri/renderD128"}}, "", "vaapi:/dev/dri/renderD128 qsv:/dev/dri/renderD128"},
		{HWAuto, both, "/dev/dri/renderD129", "nvenc vaapi:/dev/dri/renderD129 qsv:/dev/dri/renderD129"},
		{HWAuto, Devices{}, "", ""},
		{HWNone, both, "", ""},
		{"qsv", both, "", "qsv:/dev/dri/renderD128 qsv:/dev/dri/renderD129"},
		{"nvenc", Devices{}, "", "nvenc"}, // explicit: tried without /dev/nvidiactl
		{"vaapi", Devices{Nvidia: true}, "", ""},
	} {
		if got := str(candidates(tc.mode, tc.dev, tc.device)); got != tc.want {
			t.Errorf("%s %+v: %q, want %q", tc.mode, tc.dev, got, tc.want)
		}
	}
}

type fakeProber struct {
	encoders string
	listErr  error
	works    map[string]bool // Encoder.String() → test encode succeeds
	tried    []string
}

func (f *fakeProber) Encoders(context.Context) (string, error) { return f.encoders, f.listErr }

func (f *fakeProber) TestEncode(_ context.Context, e Encoder) error {
	f.tried = append(f.tried, e.String())
	if f.works[e.String()] {
		return nil
	}
	return errors.New("Failed to initialise VAAPI connection")
}

const allEncoders = ` V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
 V..... h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video acceleration) (codec h264)
`

func TestDetectEncoder(t *testing.T) {
	ctx := context.Background()
	dev := Devices{Nvidia: true, Render: []string{"/dev/dri/renderD128"}}
	// NVENC listed but broken (no driver libraries) → VAAPI.
	p := &fakeProber{encoders: allEncoders, works: map[string]bool{"vaapi:/dev/dri/renderD128": true, "qsv:/dev/dri/renderD128": true}}
	if e := DetectEncoder(ctx, HWAuto, dev, "", p, discardLog); e.String() != "vaapi:/dev/dri/renderD128" {
		t.Errorf("auto: %s", e)
	}
	if strings.Join(p.tried, " ") != "nvenc vaapi:/dev/dri/renderD128" {
		t.Errorf("tried %v", p.tried)
	}
	// Not in this ffmpeg build: skipped without a test encode.
	p = &fakeProber{encoders: strings.ReplaceAll(allEncoders, "h264_nvenc", "x"), works: map[string]bool{"nvenc": true, "qsv:/dev/dri/renderD128": true}}
	if e := DetectEncoder(ctx, HWAuto, dev, "", p, discardLog); e.Backend != BackendQSV || slices.Contains(p.tried, "nvenc") {
		t.Errorf("unlisted: %s %v", e, p.tried)
	}
	// Nothing works → CPU.
	p = &fakeProber{encoders: allEncoders}
	if e := DetectEncoder(ctx, HWAuto, dev, "", p, discardLog); e.Backend != BackendCPU || len(p.tried) != 3 {
		t.Errorf("none works: %s %v", e, p.tried)
	}
	// No devices, or none: ffmpeg isn't even asked.
	p = &fakeProber{listErr: errors.New("must not be called")}
	if e := DetectEncoder(ctx, HWAuto, Devices{}, "", p, discardLog); e.Backend != BackendCPU {
		t.Errorf("no devices: %s", e)
	}
	if e := DetectEncoder(ctx, HWNone, dev, "", p, discardLog); e.Backend != BackendCPU || len(p.tried) != 0 {
		t.Errorf("none: %s", e)
	}
	// ffmpeg -encoders fails → CPU.
	if e := DetectEncoder(ctx, HWAuto, dev, "", p, discardLog); e.Backend != BackendCPU || len(p.tried) != 0 {
		t.Errorf("list error: %s", e)
	}
	// Explicit backend: only that one is tried.
	p = &fakeProber{encoders: allEncoders, works: map[string]bool{"nvenc": true, "vaapi:/dev/dri/renderD128": true, "qsv:/dev/dri/renderD128": true}}
	if e := DetectEncoder(ctx, "qsv", dev, "", p, discardLog); e.Backend != BackendQSV || len(p.tried) != 1 {
		t.Errorf("qsv: %s %v", e, p.tried)
	}
}

func TestEncoderStateFallback(t *testing.T) {
	now := time.Unix(1000, 0)
	s := newEncoderState(Encoder{Backend: BackendVAAPI, Device: "/dev/dri/renderD128"})
	s.now = func() time.Time { return now }
	if s.current().Backend != BackendVAAPI || s.fallback() {
		t.Fatal("fresh state")
	}
	s.broken()
	if s.current().Backend != BackendCPU || !s.fallback() || s.detected().Backend != BackendVAAPI {
		t.Fatal("broken GPU still used")
	}
	now = now.Add(hwBrokenFor + time.Second)
	if s.current().Backend != BackendVAAPI || s.fallback() {
		t.Fatal("GPU not retried after hwBrokenFor")
	}
	// The CPU can't be "broken".
	c := newEncoderState(Encoder{})
	c.broken()
	if c.current().Backend != BackendCPU || c.fallback() {
		t.Fatal("cpu state")
	}
}

// ---------------------------------------------------------------- per-job fallback

func gpuHarness(t *testing.T, mode, failOn string) (*harness, string) {
	t.Helper()
	runs := filepath.Join(t.TempDir(), "runs")
	t.Setenv("FAKE_FAIL_ON", failOn)
	t.Setenv("FAKE_RUNS", runs)
	h := newHarness(t, mode, func(c *Config) {
		c.Encoder = Encoder{Backend: BackendVAAPI, Device: "/dev/dri/renderD128"}
	})
	return h, runs
}

func countRuns(path string) int {
	b, _ := os.ReadFile(path)
	return strings.Count(string(b), "x")
}

func TestRemuxGPUFailureRetriesOnCPU(t *testing.T) {
	h, runs := gpuHarness(t, "short", "h264_vaapi")
	if m := h.srv.Metrics(); m.VideoEncoder != "vaapi" || m.VideoEncoderFallback {
		t.Fatalf("metrics %+v", m)
	}
	resp := h.post(context.Background(), "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x", Video: VideoH264})
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || string(b) != "ftypfake" || countRuns(runs) != 2 {
		t.Fatalf("retry: %d %q runs=%d", resp.StatusCode, b, countRuns(runs))
	}
	args, _ := os.ReadFile(h.args)
	if !strings.Contains(string(args), "libx264") || strings.Contains(string(args), "hw_device") {
		t.Fatalf("retry not on cpu: %s", args)
	}
	if m := h.srv.Metrics(); !m.VideoEncoderFallback || m.VideoEncoder != "vaapi" {
		t.Fatalf("metrics after fallback %+v", m)
	}
	// While marked broken, jobs go straight to the CPU (one run).
	resp = h.post(context.Background(), "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x", Video: VideoH264})
	resp.Body.Close()
	if resp.StatusCode != 200 || countRuns(runs) != 3 {
		t.Fatalf("after fallback: %d runs=%d", resp.StatusCode, countRuns(runs))
	}
	// Copied video never retries (nothing to do with the GPU).
	h.srv.enc = newEncoderState(Encoder{Backend: BackendVAAPI, Device: "/dev/dri/renderD128"})
	resp = h.post(context.Background(), "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x"})
	resp.Body.Close()
	if resp.StatusCode != 200 || countRuns(runs) != 4 {
		t.Fatalf("copy: %d runs=%d", resp.StatusCode, countRuns(runs))
	}
}

func TestRemuxBrokenInputDoesNotBlameGPU(t *testing.T) {
	// Both attempts fail (the input, not the GPU): 502, GPU stays in use.
	h, runs := gpuHarness(t, "fail", "")
	resp := h.post(context.Background(), "/v1/remux", Job{Kind: KindRemux, Input: "http://ts/x", Video: VideoH264})
	resp.Body.Close()
	if resp.StatusCode != 502 || countRuns(runs) != 2 {
		t.Fatalf("%d runs=%d", resp.StatusCode, countRuns(runs))
	}
	if h.srv.Metrics().VideoEncoderFallback {
		t.Fatal("GPU marked broken for a bad input")
	}
}

func TestHLSGPUFailureRetriesOnCPU(t *testing.T) {
	h, runs := gpuHarness(t, "hls", "h264_vaapi")
	resp, out := h.startHLS(Job{Input: "http://ts/x", Owner: "src-1", Video: VideoH264})
	if resp.StatusCode != 200 || out["session"] == nil || countRuns(runs) != 2 {
		t.Fatalf("hls retry: %d %v runs=%d", resp.StatusCode, out, countRuns(runs))
	}
	if !h.srv.Metrics().VideoEncoderFallback {
		t.Fatal("GPU not marked broken")
	}
	if n := len(h.srv.hls.list()); n != 1 {
		t.Fatalf("%d sessions", n)
	}
}
