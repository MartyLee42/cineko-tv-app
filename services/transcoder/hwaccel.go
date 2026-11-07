package main

// Hardware video encoding for re-encoded jobs (Job.Video "h264"). Copied
// video never touches an encoder, so this only matters for XviD / MPEG-2 /
// VC-1 sources.
//
// At startup DetectEncoder picks a backend (TRANSCODER_HWACCEL, default
// auto): NVIDIA NVENC, then VAAPI (Intel / AMD), then Intel QSV, then the
// libx264 CPU path. A backend counts only when ffmpeg lists its encoder AND a
// one-second test encode through the real filter chain succeeds — device
// nodes alone prove nothing (no driver, no permission, unsupported profile).
//
// Decoding, deinterlacing and scaling stay on the CPU (cheap for ≤ 1080p
// sources, identical output on every backend); frames are uploaded to the
// GPU only for the encoder. Every backend produces H.264 High, level 4.0,
// 8-bit 4:2:0, a keyframe every x264GOP seconds — what old TV engines play.
//
// Runtime: a GPU job that fails before any output is retried once on the
// CPU; when the CPU attempt works, the GPU is marked broken for
// hwBrokenFor and jobs use the CPU meanwhile (encoderState).

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Backend is a video encoder family.
type Backend string

const (
	BackendCPU   Backend = "cpu" // libx264
	BackendNVENC Backend = "nvenc"
	BackendVAAPI Backend = "vaapi"
	BackendQSV   Backend = "qsv"
)

// Encoder is a backend plus its device (a /dev/dri render node for VAAPI /
// QSV; empty for CPU and NVENC).
type Encoder struct {
	Backend Backend
	Device  string
}

func (e Encoder) hw() bool { return e.Backend != "" && e.Backend != BackendCPU }

// String: "cpu", "nvenc", "vaapi:/dev/dri/renderD128".
func (e Encoder) String() string {
	if !e.hw() {
		return string(BackendCPU)
	}
	if e.Device != "" {
		return string(e.Backend) + ":" + e.Device
	}
	return string(e.Backend)
}

// ffmpeg encoder names per backend.
var encoderName = map[Backend]string{
	BackendCPU:   "libx264",
	BackendNVENC: "h264_nvenc",
	BackendVAAPI: "h264_vaapi",
	BackendQSV:   "h264_qsv",
}

// Hardware encoders have no CRF: average / peak bitrate instead (plenty for
// the ≤ 1080p sources that get re-encoded; the peak matches libx264's).
const (
	hwBitrate = "5M"
	hwMaxrate = "8M"
	hwBufsize = "16M"
	// hwBrokenFor: after a GPU failure the CPU is used this long.
	hwBrokenFor = 10 * time.Minute
)

// cpuFilters: deinterlace interlaced frames, round odd sizes down to even.
const cpuFilters = "yadif=deint=interlaced,scale=trunc(iw/2)*2:trunc(ih/2)*2"

func forceKeyFrames() []string {
	return []string{"-force_key_frames", "expr:gte(t,n_forced*" + strconv.Itoa(x264GOP) + ")"}
}

// hwInputArgs: global options that create the GPU device (placed before -i).
func hwInputArgs(e Encoder) []string {
	switch e.Backend {
	case BackendVAAPI:
		return []string{"-init_hw_device", "vaapi=va:" + e.Device, "-filter_hw_device", "va"}
	case BackendQSV:
		// QSV on Linux runs on top of a VAAPI device.
		return []string{"-init_hw_device", "vaapi=va:" + e.Device, "-init_hw_device", "qsv=qs@va", "-filter_hw_device", "qs"}
	}
	return nil
}

// encodeArgs: the filter chain and video encoder options of a re-encoding
// job on e (threads: libx264 / filter threads).
func encodeArgs(e Encoder, threads int) []string {
	level := []string{"-profile:v", "high", "-level:v", "40"}
	switch e.Backend {
	case BackendNVENC:
		// NVENC takes system-memory yuv420p frames directly.
		a := []string{"-filter_threads", "1", "-vf", cpuFilters + ",format=yuv420p",
			"-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq", "-rc", "vbr",
			"-b:v", hwBitrate, "-maxrate", hwMaxrate, "-bufsize", hwBufsize}
		a = append(a, level...)
		a = append(a, "-pix_fmt", "yuv420p", "-forced-idr", "1")
		return append(a, forceKeyFrames()...)
	case BackendVAAPI:
		a := []string{"-filter_threads", "1", "-vf", cpuFilters + ",format=nv12,hwupload",
			"-c:v", "h264_vaapi", "-b:v", hwBitrate, "-maxrate", hwMaxrate, "-bufsize", hwBufsize}
		a = append(a, level...)
		return append(a, forceKeyFrames()...)
	case BackendQSV:
		a := []string{"-filter_threads", "1", "-vf", cpuFilters + ",format=nv12,hwupload=extra_hw_frames=64,format=qsv",
			"-c:v", "h264_qsv", "-preset", "veryfast", "-b:v", hwBitrate, "-maxrate", hwMaxrate, "-bufsize", hwBufsize}
		a = append(a, level...)
		a = append(a, "-forced_idr", "1")
		return append(a, forceKeyFrames()...)
	}
	a := []string{
		"-filter_threads", "1", "-vf", cpuFilters,
		"-c:v", "libx264", "-preset", x264Preset, "-crf", x264CRF,
		"-maxrate", hwMaxrate, "-bufsize", hwBufsize,
		"-profile:v", "high", "-level:v", "4.0", "-pix_fmt", "yuv420p",
	}
	a = append(a, forceKeyFrames()...)
	return append(a, "-threads", strconv.Itoa(threads))
}

// ---------------------------------------------------------------- detection

// HWMode is TRANSCODER_HWACCEL: auto, none, or one backend to require.
type HWMode string

const (
	HWAuto HWMode = "auto"
	HWNone HWMode = "none"
)

func parseHWMode(v string) (HWMode, error) {
	switch m := HWMode(strings.ToLower(strings.TrimSpace(v))); m {
	case "":
		return HWAuto, nil
	case "cpu":
		return HWNone, nil
	case HWAuto, HWNone, HWMode(BackendNVENC), HWMode(BackendVAAPI), HWMode(BackendQSV):
		return m, nil
	}
	return "", errors.New("TRANSCODER_HWACCEL must be auto, none, nvenc, vaapi or qsv")
}

// prober runs ffmpeg for detection (fakeable in tests).
type prober interface {
	// Encoders: the output of `ffmpeg -encoders`.
	Encoders(ctx context.Context) (string, error)
	// TestEncode encodes one second of a test pattern with e to null.
	TestEncode(ctx context.Context, e Encoder) error
}

// Devices: what the container can see.
type Devices struct {
	Nvidia bool     // /dev/nvidiactl (the NVIDIA runtime passed a GPU)
	Render []string // /dev/dri/renderD* nodes
}

func scanDevices() Devices {
	var d Devices
	if _, err := os.Stat("/dev/nvidiactl"); err == nil {
		d.Nvidia = true
	}
	d.Render, _ = filepath.Glob("/dev/dri/renderD*")
	slices.Sort(d.Render)
	return d
}

// candidates in probe order for mode. device (TRANSCODER_HWACCEL_DEVICE)
// replaces the scanned render nodes.
func candidates(mode HWMode, dev Devices, device string) []Encoder {
	if mode == HWNone {
		return nil
	}
	render := dev.Render
	if device != "" {
		render = []string{device}
	}
	var out []Encoder
	want := func(b Backend) bool { return mode == HWAuto || mode == HWMode(b) }
	// An explicit nvenc is tried even without /dev/nvidiactl (other setups).
	if want(BackendNVENC) && (dev.Nvidia || mode == HWMode(BackendNVENC)) {
		out = append(out, Encoder{Backend: BackendNVENC})
	}
	for _, b := range []Backend{BackendVAAPI, BackendQSV} {
		if want(b) {
			for _, r := range render {
				out = append(out, Encoder{Backend: b, Device: r})
			}
		}
	}
	return out
}

// listsEncoder: `ffmpeg -encoders` has a line for name.
func listsEncoder(list, name string) bool {
	for _, line := range strings.Split(list, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && f[1] == name {
			return true
		}
	}
	return false
}

// DetectEncoder picks the encoder for mode: the first candidate ffmpeg lists
// and test-encodes with, else the CPU. Each attempt is logged.
func DetectEncoder(ctx context.Context, mode HWMode, dev Devices, device string, p prober, log *slog.Logger) Encoder {
	cands := candidates(mode, dev, device)
	if len(cands) == 0 {
		if mode != HWNone && mode != HWAuto {
			log.Warn("hwaccel: no device for the requested backend, using cpu", "mode", mode)
		}
		return Encoder{Backend: BackendCPU}
	}
	list, err := p.Encoders(ctx)
	if err != nil {
		log.Warn("hwaccel: ffmpeg -encoders failed, using cpu", "err", err)
		return Encoder{Backend: BackendCPU}
	}
	for _, e := range cands {
		if !listsEncoder(list, encoderName[e.Backend]) {
			log.Info("hwaccel: encoder not in this ffmpeg build", "encoder", encoderName[e.Backend])
			continue
		}
		if err := p.TestEncode(ctx, e); err != nil {
			log.Info("hwaccel: test encode failed", "encoder", e.String(), "err", err)
			continue
		}
		return e
	}
	if mode != HWAuto {
		log.Warn("hwaccel: the requested backend doesn't work, using cpu", "mode", mode)
	}
	return Encoder{Backend: BackendCPU}
}

// ffmpegProber runs the real ffmpeg.
type ffmpegProber struct{ bin string }

func (f ffmpegProber) Encoders(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, f.bin, "-hide_banner", "-encoders").Output()
	return string(out), err
}

func (f ffmpegProber) TestEncode(ctx context.Context, e Encoder) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, f.bin, testEncodeArgs(e)...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 300 {
			msg = msg[len(msg)-300:]
		}
		if msg == "" {
			return err
		}
		return errors.New(msg)
	}
	return nil
}

// testEncodeArgs: one second of an odd-sized 25 fps pattern through the
// same filters and encoder options as a real job.
func testEncodeArgs(e Encoder) []string {
	a := []string{"-hide_banner", "-nostdin", "-nostats", "-loglevel", "error"}
	a = append(a, hwInputArgs(e)...)
	a = append(a, "-f", "lavfi", "-i", "testsrc2=size=642x362:rate=25:duration=1")
	a = append(a, encodeArgs(e, 1)...)
	return append(a, "-f", "null", "-")
}

// ---------------------------------------------------------------- runtime

// encoderState is the detected encoder plus the "GPU broken" timer.
type encoderState struct {
	mu          sync.Mutex
	enc         Encoder
	brokenUntil time.Time
	now         func() time.Time
}

func newEncoderState(e Encoder) *encoderState {
	if e.Backend == "" {
		e.Backend = BackendCPU
	}
	return &encoderState{enc: e, now: time.Now}
}

// current: the encoder for a new job (the CPU while the GPU is marked broken).
func (s *encoderState) current() Encoder {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.enc.hw() && s.now().Before(s.brokenUntil) {
		return Encoder{Backend: BackendCPU}
	}
	return s.enc
}

// detected: the startup choice (what /metrics reports).
func (s *encoderState) detected() Encoder {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enc
}

// broken: the GPU failed where the CPU worked.
func (s *encoderState) broken() {
	s.mu.Lock()
	s.brokenUntil = s.now().Add(hwBrokenFor)
	s.mu.Unlock()
}

// fallback: whether the GPU is marked broken now.
func (s *encoderState) fallback() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.enc.hw() && s.now().Before(s.brokenUntil)
}

// cpuCopy: the job again, encoding on the CPU.
func cpuCopy(j *Job) *Job {
	c := *j
	c.enc = Encoder{Backend: BackendCPU}
	return &c
}
