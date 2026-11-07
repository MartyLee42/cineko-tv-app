package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Config is read from the environment (main.go).
type Config struct {
	Key         []byte // derived job key (jobKey)
	MaxJobs     int    // concurrent remux jobs
	MaxSubJobs  int    // concurrent subtitle extractions
	MaxProbes   int    // concurrent keyframe probes
	SlotWait    time.Duration
	IdleTimeout time.Duration // no output for this long → kill
	// SubIdleTimeout: subtitle cues can be minutes apart (default 15 min).
	SubIdleTimeout time.Duration
	MaxDuration    time.Duration // hard cap per job
	FFmpeg         string
	FFprobe        string
	Nice           int // niceness for ffmpeg/ffprobe; 0 = don't wrap
	NicePath       string
	SubReadRate    float64 // ×real time for subtitle extraction; 0 = unlimited
	VideoThreads   int     // libx264 threads per re-encoded stream; 0 = DefaultVideoThreads
	// Encoder: the video encoder of re-encoding jobs (DetectEncoder at
	// startup; zero = CPU).
	Encoder  Encoder
	HWMode   HWMode // TRANSCODER_HWACCEL (main.go)
	HWDevice string // TRANSCODER_HWACCEL_DEVICE: render node for vaapi / qsv

	// HLS sessions (hls.go).
	HLSDir        string        // per-session directories (on disk: segments are large)
	HLSIdle       time.Duration // no request at all → session removed
	HLSMediaIdle  time.Duration // no init/segment request → removed (player paused, polling the playlist)
	HLSAhead      time.Duration // ffmpeg paused this far ahead of the last requested segment
	HLSKeepBehind time.Duration // segments further behind it are deleted
	HLSMaxBytes   int64         // segment bytes kept per session
	HLSStartWait  time.Duration // the first segments must appear within this
	HLSTick       time.Duration // janitor period
	// HLSEvictAfter: when all slots are taken, a running session without
	// requests for this long gives its slot to the new job (its player
	// seeked elsewhere or left).
	HLSEvictAfter time.Duration
	// HLSSegmentWait: a requested segment that isn't written yet is waited
	// for this long (ffmpeg resumed) before 404.
	HLSSegmentWait time.Duration
}

// Server runs ffmpeg jobs for the API.
type Server struct {
	cfg    Config
	log    *slog.Logger
	jobs   chan struct{}
	subs   chan struct{}
	probes chan struct{}
	kf     *keyframeCache
	enc    *encoderState

	hls       *hlsManager
	hlsDirErr error
	quit      chan struct{}
	closeOnce sync.Once

	started  atomic.Int64
	rejected atomic.Int64
	failed   atomic.Int64
}

func NewServer(cfg Config, log *slog.Logger) *Server {
	if cfg.MaxJobs < 1 {
		cfg.MaxJobs = 1
	}
	if cfg.MaxSubJobs < 1 {
		cfg.MaxSubJobs = cfg.MaxJobs * 2
	}
	if cfg.MaxProbes < 1 {
		cfg.MaxProbes = 4
	}
	def := func(d *time.Duration, v time.Duration) {
		if *d <= 0 {
			*d = v
		}
	}
	def(&cfg.HLSIdle, 2*time.Minute)
	def(&cfg.HLSMediaIdle, 10*time.Minute)
	def(&cfg.HLSAhead, 3*time.Minute)
	def(&cfg.HLSKeepBehind, 10*time.Minute)
	def(&cfg.HLSStartWait, 150*time.Second)
	def(&cfg.HLSTick, time.Second)
	def(&cfg.HLSEvictAfter, 20*time.Second)
	def(&cfg.HLSSegmentWait, 10*time.Second)
	if cfg.HLSMaxBytes <= 0 {
		cfg.HLSMaxBytes = 3 << 30
	}
	if cfg.HLSDir == "" {
		cfg.HLSDir = filepath.Join(os.TempDir(), "martytv-hls")
	}
	s := &Server{
		cfg: cfg, log: log,
		jobs:   make(chan struct{}, cfg.MaxJobs),
		subs:   make(chan struct{}, cfg.MaxSubJobs),
		probes: make(chan struct{}, cfg.MaxProbes),
		kf:     newKeyframeCache(512, 30*time.Minute),
		enc:    newEncoderState(cfg.Encoder),
		hls:    newHLSManager(),
		quit:   make(chan struct{}),
	}
	// Sessions of a previous process are gone with it.
	if err := cleanHLSDir(cfg.HLSDir); err != nil {
		s.hlsDirErr = err
		log.Error("hls dir unusable", "dir", cfg.HLSDir, "err", err)
	}
	go s.hlsJanitor()
	return s
}

// Close stops the HLS janitor, kills every session's ffmpeg and removes
// their files (waits up to 5 s).
func (s *Server) Close() {
	s.closeOnce.Do(func() {
		close(s.quit)
		sessions := s.hls.list()
		for _, sess := range sessions {
			s.closeHLS(sess, "shutdown")
		}
		deadline := time.After(5 * time.Second)
		for _, sess := range sessions {
			select {
			case <-sess.done:
			case <-deadline:
			}
			_ = os.RemoveAll(sess.dir)
		}
	})
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/remux", s.remux)
	mux.HandleFunc("POST /v1/keyframe", s.keyframe)
	mux.HandleFunc("POST /v1/subtitles", s.subtitles)
	mux.HandleFunc("POST /v1/hls", s.hlsStart)
	mux.HandleFunc("GET /v1/hls/{id}/{file}", s.hlsFile)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok\n") })
	mux.HandleFunc("GET /metrics", s.metrics)
	return mux
}

// Metrics is GET /metrics (the API's admin Server tab shows it).
type Metrics struct {
	ActiveJobs         int   `json:"active_jobs"`
	ActiveSubtitleJobs int   `json:"active_subtitle_jobs"`
	MaxJobs            int   `json:"max_jobs"`
	JobsStarted        int64 `json:"jobs_started"`
	JobsRejected       int64 `json:"jobs_rejected"`
	JobsFailed         int64 `json:"jobs_failed"`
	// HLS sessions (running or finished, files on disk) and their segment bytes.
	HLSSessions int   `json:"hls_sessions"`
	HLSBytes    int64 `json:"hls_bytes"`
	// VideoEncoder: the backend re-encoded video uses (cpu, nvenc, vaapi,
	// qsv); VideoEncoderFallback: the GPU failed recently, the CPU is used.
	VideoEncoder         string `json:"video_encoder"`
	VideoEncoderFallback bool   `json:"video_encoder_fallback"`
}

func (s *Server) Metrics() Metrics {
	m := Metrics{
		ActiveJobs: len(s.jobs), ActiveSubtitleJobs: len(s.subs), MaxJobs: cap(s.jobs),
		JobsStarted: s.started.Load(), JobsRejected: s.rejected.Load(), JobsFailed: s.failed.Load(),
		VideoEncoder: string(s.enc.detected().Backend), VideoEncoderFallback: s.enc.fallback(),
	}
	for _, sess := range s.hls.list() {
		m.HLSSessions++
		m.HLSBytes += sess.diskBytes()
	}
	return m
}

func (s *Server) metrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.Metrics())
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

// readJob authenticates the request; on failure it has answered already.
func (s *Server) readJob(w http.ResponseWriter, r *http.Request, kind string) *Job {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxJobBody+1))
	if err != nil || len(body) > maxJobBody {
		writeError(w, http.StatusBadRequest, "bad_job", "Job body too large or unreadable.")
		return nil
	}
	j, err := ParseJob(s.cfg.Key, body, r.Header.Get("X-Job-Signature"), kind, time.Now())
	switch {
	case errors.Is(err, errBadSignature):
		s.log.Warn("job refused", "reason", "bad_signature", "kind", kind)
		writeError(w, http.StatusForbidden, "bad_signature", "Job signature is invalid.")
		return nil
	case errors.Is(err, errExpired):
		writeError(w, http.StatusForbidden, "job_expired", "Job has expired.")
		return nil
	case err != nil:
		writeError(w, http.StatusBadRequest, "bad_job", "Job is invalid.")
		return nil
	}
	j.threads = s.cfg.VideoThreads
	if j.Video == VideoH264 {
		j.enc = s.enc.current()
	}
	return j
}

// acquire takes a slot, waiting up to SlotWait (a seek restarts the stream:
// the old job may still be shutting down when the new one arrives).
func (s *Server) acquire(ctx context.Context, sem chan struct{}, wait time.Duration) bool {
	select {
	case sem <- struct{}{}:
		return true
	default:
	}
	if wait <= 0 {
		return false
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case sem <- struct{}{}:
		return true
	case <-t.C:
	case <-ctx.Done():
	}
	return false
}

func (s *Server) busy(w http.ResponseWriter, kind string) {
	s.rejected.Add(1)
	s.log.Info("job rejected", "reason", "busy", "kind", kind)
	writeError(w, http.StatusServiceUnavailable, "transcoder_busy", "Too many conversions are running; try again later.")
}

func (s *Server) remux(w http.ResponseWriter, r *http.Request) {
	j := s.readJob(w, r, KindRemux)
	if j == nil {
		return
	}
	if !s.acquireJob(r.Context()) {
		s.busy(w, KindRemux)
		return
	}
	defer func() { <-s.jobs }()
	start := s.resolveStart(r.Context(), j)
	if s.run(w, r, j, KindRemux, s.cfg.FFmpeg, RemuxArgs(j, start), "video/mp4", start, j.enc.hw()) != runRetry {
		return
	}
	// The GPU encode failed before any output: once more on the CPU.
	c := cpuCopy(j)
	if s.run(w, r, c, KindRemux, s.cfg.FFmpeg, RemuxArgs(c, start), "video/mp4", start, false) == runSent {
		s.gpuBroken(j.enc)
	}
}

// gpuBroken: a job failed on e and worked on the CPU.
func (s *Server) gpuBroken(e Encoder) {
	s.enc.broken()
	s.log.Warn("hwaccel: gpu encode failed where cpu worked; using cpu for a while", "encoder", e.String(), "for", hwBrokenFor.String())
}

func (s *Server) subtitles(w http.ResponseWriter, r *http.Request) {
	j := s.readJob(w, r, KindSubtitles)
	if j == nil {
		return
	}
	if !s.acquire(r.Context(), s.subs, s.cfg.SlotWait) {
		s.busy(w, KindSubtitles)
		return
	}
	defer func() { <-s.subs }()
	start := s.resolveStart(r.Context(), j)
	s.run(w, r, j, KindSubtitles, s.cfg.FFmpeg, SubtitleArgs(j, start, s.cfg.SubReadRate), "text/vtt; charset=utf-8", start, false)
}

// keyframe answers {"start": K}: where a stream requested at j.Start really
// begins (the keyframe ffmpeg will cut at).
func (s *Server) keyframe(w http.ResponseWriter, r *http.Request) {
	j := s.readJob(w, r, KindKeyframe)
	if j == nil {
		return
	}
	k, ok := s.findKeyframe(r.Context(), j)
	if !ok {
		writeError(w, http.StatusBadGateway, "probe_failed", "Could not read the file at that position.")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Stream-Start", fmtSeconds(k))
	_ = json.NewEncoder(w).Encode(map[string]float64{"start": k})
}

// resolveStart maps the requested start to the keyframe the output begins at
// (cached, so the probe the player made a moment ago is free). If the probe
// fails, the requested time is used as is.
func (s *Server) resolveStart(ctx context.Context, j *Job) float64 {
	if j.Start <= 0 {
		return 0
	}
	if k, ok := s.findKeyframe(ctx, j); ok {
		return k
	}
	return j.Start
}

func (s *Server) findKeyframe(ctx context.Context, j *Job) (float64, bool) {
	if j.Start <= 0 {
		return 0, true
	}
	if k, ok := s.kf.get(j.Input, j.Start); ok {
		return k, true
	}
	if !s.acquire(ctx, s.probes, s.cfg.SlotWait) {
		return 0, false
	}
	defer func() { <-s.probes }()
	pctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	cmd := s.command(pctx, s.cfg.FFprobe, KeyframeArgs(j, j.Start))
	var stderr bytes.Buffer
	cmd.Stderr = &limitedBuffer{b: &stderr, max: 4096}
	out, err := cmd.Output()
	if err != nil {
		s.log.Warn("keyframe probe failed", "err", errString(err), "stderr", sanitize(stderr.String(), j))
		return 0, false
	}
	k, err := ParseKeyframe(out)
	if err != nil || k > j.Start+60 {
		s.log.Warn("keyframe probe unusable", "err", errString(err))
		return 0, false
	}
	s.kf.put(j.Input, j.Start, k)
	// A stream requested at the keyframe itself starts there too.
	s.kf.put(j.Input, k, k)
	return k, true
}

// command wraps the binary in `nice -n N` (lower CPU priority than the API,
// TorrServer and Postgres). The context kills the process.
func (s *Server) command(ctx context.Context, bin string, args []string) *exec.Cmd {
	var cmd *exec.Cmd
	if s.cfg.Nice > 0 && s.cfg.NicePath != "" {
		cmd = exec.CommandContext(ctx, s.cfg.NicePath, append([]string{"-n", strconv.Itoa(s.cfg.Nice), bin}, args...)...)
	} else {
		cmd = exec.CommandContext(ctx, bin, args...)
	}
	cmd.WaitDelay = 3 * time.Second
	return cmd
}

// runOutcome: how run ended.
type runOutcome int

const (
	runSent   runOutcome = iota // output was streamed (to the end or not)
	runFailed                   // failed before output; answered 502 (or the client left)
	runRetry                    // failed before output with retry set; nothing answered
)

// run starts ffmpeg and streams its stdout to w. Headers are sent once the
// first bytes arrive, so a file that can't be opened still gets a clean 502.
// ffmpeg is killed when the client goes away, when nothing was written for
// IdleTimeout (stalled torrent or a paused player that stopped reading), or
// after MaxDuration. retry: an ffmpeg error before any output returns
// runRetry without answering (the caller tries again on the CPU).
func (s *Server) run(w http.ResponseWriter, r *http.Request, j *Job, kind, bin string, args []string, contentType string, start float64, retry bool) runOutcome {
	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.MaxDuration)
	defer cancel()
	cmd := s.command(ctx, bin, args)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "Could not start the converter.")
		return runFailed
	}
	var stderr bytes.Buffer
	cmd.Stderr = &limitedBuffer{b: &stderr, max: 8192, tail: true}
	t0 := time.Now()
	if err := cmd.Start(); err != nil {
		s.failed.Add(1)
		s.log.Error("ffmpeg start failed", "kind", kind, "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "Could not start the converter.")
		return runFailed
	}
	s.started.Add(1)
	audio := -1
	if j.Audio != nil {
		audio = *j.Audio
	}
	log := s.log.With("kind", kind, "start", fmtSeconds(start), "audio", audio, "stream", j.Stream, "video", j.Video)
	if j.Video == VideoH264 {
		log = log.With("encoder", j.enc.String())
	}
	log.Info("job started")

	idle := s.cfg.IdleTimeout
	if kind == KindSubtitles && s.cfg.SubIdleTimeout > idle {
		idle = s.cfg.SubIdleTimeout
	}
	var idled atomic.Bool
	watchdog := time.AfterFunc(idle, func() {
		idled.Store(true)
		cancel()
	})
	defer watchdog.Stop()

	buf := make([]byte, 64<<10)
	var written int64
	n, rerr := io.ReadFull(stdout, buf[:1])
	headerSent := false
	if n > 0 {
		h := w.Header()
		h.Set("Content-Type", contentType)
		h.Set("Cache-Control", "no-store")
		h.Set("X-Stream-Start", fmtSeconds(start))
		w.WriteHeader(http.StatusOK)
		headerSent = true
		flusher, _ := w.(http.Flusher)
		pending := buf[:1]
		for {
			if len(pending) > 0 {
				if _, werr := w.Write(pending); werr != nil {
					cancel()
					break
				}
				written += int64(len(pending))
				watchdog.Reset(idle)
				if flusher != nil {
					flusher.Flush()
				}
			}
			if rerr != nil {
				break
			}
			var m int
			m, rerr = stdout.Read(buf)
			pending = buf[:m]
		}
	}
	if !errors.Is(rerr, io.EOF) && !errors.Is(rerr, io.ErrUnexpectedEOF) {
		// Stopped early (client gone, write error): kill ffmpeg, and drain so
		// it isn't blocked on a full pipe meanwhile.
		cancel()
		_, _ = io.Copy(io.Discard, stdout)
	}
	werr := cmd.Wait()

	reason := "done"
	switch {
	case idled.Load():
		reason = "idle_timeout"
	case r.Context().Err() != nil:
		reason = "client_gone"
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		reason = "max_duration"
	case werr != nil:
		reason = "ffmpeg_error"
	}
	attrs := []any{"reason", reason, "bytes", written, "seconds", time.Since(t0).Round(time.Millisecond).Seconds()}
	if reason == "ffmpeg_error" || !headerSent {
		attrs = append(attrs, "stderr", sanitize(stderr.String(), j))
	}
	if !headerSent {
		s.failed.Add(1)
		if retry && reason == "ffmpeg_error" {
			log.Warn("job failed before output, retrying on cpu", attrs...)
			return runRetry
		}
		log.Warn("job failed before output", attrs...)
		if r.Context().Err() == nil {
			writeError(w, http.StatusBadGateway, "stream_unavailable", "The file could not be opened or converted.")
		}
		return runFailed
	}
	if reason == "ffmpeg_error" {
		s.failed.Add(1)
	}
	log.Info("job ended", attrs...)
	return runSent
}

// limitedBuffer keeps at most max bytes of stderr (the first, or the last
// with tail).
type limitedBuffer struct {
	mu   sync.Mutex
	b    *bytes.Buffer
	max  int
	tail bool
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.tail {
		if room := l.max - l.b.Len(); room > 0 {
			l.b.Write(p[:min(room, len(p))])
		}
		return len(p), nil
	}
	l.b.Write(p)
	if over := l.b.Len() - l.max; over > 0 {
		l.b.Next(over)
	}
	return len(p), nil
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// keyframeCache remembers (input, requested start) → keyframe.
type keyframeCache struct {
	mu  sync.Mutex
	max int
	ttl time.Duration
	m   map[string]kfEntry
}

type kfEntry struct {
	k  float64
	at time.Time
}

func newKeyframeCache(max int, ttl time.Duration) *keyframeCache {
	return &keyframeCache{max: max, ttl: ttl, m: map[string]kfEntry{}}
}

func kfKey(input string, start float64) string { return fmtSeconds(start) + "|" + input }

func (c *keyframeCache) get(input string, start float64) (float64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[kfKey(input, start)]
	if !ok || time.Since(e.at) > c.ttl {
		return 0, false
	}
	return e.k, true
}

func (c *keyframeCache) put(input string, start, k float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= c.max {
		// Drop expired entries, else everything (cheap to recompute).
		for key, e := range c.m {
			if time.Since(e.at) > c.ttl {
				delete(c.m, key)
			}
		}
		if len(c.m) >= c.max {
			clear(c.m)
		}
	}
	c.m[kfKey(input, start)] = kfEntry{k: k, at: time.Now()}
}
