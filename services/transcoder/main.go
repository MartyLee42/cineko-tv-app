// martytv-transcoder: the browser compatibility stream's worker.
//
// A sidecar of the Cineko API on the internal Docker network (no published
// ports). The API sends signed jobs (job.go) naming a TorrServer stream it
// resolved itself; this service runs ffmpeg — video copied, one audio track
// converted to AAC, fragmented MP4 — and streams the result back. It never
// takes URLs from browsers.
//
//	martytv-transcoder              serve (LISTEN_ADDR, default :8090)
//	martytv-transcoder healthcheck  exit 0 if /healthz answers (Docker HEALTHCHECK)
//	martytv-transcoder probe        print the video encoder auto-detection would pick
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if len(os.Args) > 1 && os.Args[1] == "probe" {
		os.Exit(runProbe())
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})).With("service", "transcoder")
	cfg, addr, err := loadConfig(os.Getenv)
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(2)
	}
	// Hardware encoding for re-encoded video (hwaccel.go): probed once.
	dctx, dcancel := context.WithTimeout(context.Background(), 90*time.Second)
	t0 := time.Now()
	cfg.Encoder = DetectEncoder(dctx, cfg.HWMode, scanDevices(), cfg.HWDevice, ffmpegProber{bin: cfg.FFmpeg}, log)
	dcancel()
	log.Info("video encoder", "encoder", cfg.Encoder.String(), "name", encoderName[cfg.Encoder.Backend], "mode", cfg.HWMode,
		"probe_seconds", time.Since(t0).Round(time.Millisecond).Seconds())
	srv := NewServer(cfg, log)
	defer srv.Close()
	hs := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second, // the job body; responses stream without a write timeout
		IdleTimeout:       2 * time.Minute,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	log.Info("listening", "addr", addr, "max_jobs", cfg.MaxJobs, "nice", cfg.Nice)
	if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve", "err", err)
		os.Exit(1)
	}
}

func loadConfig(getenv func(string) string) (Config, string, error) {
	get := func(k, def string) string {
		if v := strings.TrimSpace(getenv(k)); v != "" {
			return v
		}
		return def
	}
	secret := strings.TrimSpace(getenv("TRANSCODER_SECRET"))
	if p := strings.TrimSpace(getenv("TRANSCODER_SECRET_FILE")); p != "" {
		b, err := os.ReadFile(p)
		if err != nil {
			return Config{}, "", fmt.Errorf("TRANSCODER_SECRET_FILE: %w", err)
		}
		secret = strings.TrimSpace(string(b))
	}
	if len(secret) < 32 {
		return Config{}, "", errors.New("TRANSCODER_SECRET must be at least 32 characters")
	}
	var errs []error
	num := func(k string, def int) int {
		v := get(k, "")
		if v == "" {
			return def
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			errs = append(errs, fmt.Errorf("%s must be a non-negative integer", k))
			return def
		}
		return n
	}
	dur := func(k string, def time.Duration) time.Duration {
		v := get(k, "")
		if v == "" {
			return def
		}
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			errs = append(errs, fmt.Errorf("%s must be a positive duration", k))
			return def
		}
		return d
	}
	cfg := Config{
		Key:            jobKey([]byte(secret)),
		MaxJobs:        num("TRANSCODER_MAX_JOBS", 3),
		MaxSubJobs:     num("TRANSCODER_MAX_SUBTITLE_JOBS", 0),
		SlotWait:       dur("TRANSCODER_SLOT_WAIT", 3*time.Second),
		IdleTimeout:    dur("TRANSCODER_IDLE_TIMEOUT", 2*time.Minute),
		SubIdleTimeout: dur("TRANSCODER_SUBTITLE_IDLE_TIMEOUT", 15*time.Minute),
		MaxDuration:    dur("TRANSCODER_MAX_DURATION", 6*time.Hour),
		FFmpeg:         get("FFMPEG_PATH", "ffmpeg"),
		FFprobe:        get("FFPROBE_PATH", "ffprobe"),
		Nice:           num("TRANSCODER_NICE", 10),
		HLSDir:         get("TRANSCODER_HLS_DIR", ""),
		HLSIdle:        dur("TRANSCODER_HLS_IDLE", 2*time.Minute),
		HLSMediaIdle:   dur("TRANSCODER_HLS_MEDIA_IDLE", 10*time.Minute),
		HLSAhead:       dur("TRANSCODER_HLS_AHEAD", 3*time.Minute),
		HLSKeepBehind:  dur("TRANSCODER_HLS_KEEP_BEHIND", 10*time.Minute),
		HLSMaxBytes:    int64(num("TRANSCODER_HLS_MAX_SESSION_MB", 3072)) << 20,
		VideoThreads:   num("TRANSCODER_VIDEO_THREADS", DefaultVideoThreads),
		HWDevice:       get("TRANSCODER_HWACCEL_DEVICE", ""),
	}
	if m, err := parseHWMode(getenv("TRANSCODER_HWACCEL")); err != nil {
		errs = append(errs, err)
	} else {
		cfg.HWMode = m
	}
	if v := get("TRANSCODER_SUBTITLE_READRATE", "4"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil || f < 0 {
			errs = append(errs, errors.New("TRANSCODER_SUBTITLE_READRATE must be a non-negative number"))
		}
		cfg.SubReadRate = f
	}
	if cfg.MaxJobs < 1 {
		errs = append(errs, errors.New("TRANSCODER_MAX_JOBS must be at least 1"))
	}
	if cfg.Nice > 0 {
		if p, err := exec.LookPath("nice"); err == nil {
			cfg.NicePath = p
		}
	}
	return cfg, get("LISTEN_ADDR", ":8090"), errors.Join(errs...)
}

func healthcheck() int {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8090"
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 1
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// runProbe runs the encoder detection with the current environment and prints
// the choice (every attempt is logged to stderr).
func runProbe() int {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	mode, err := parseHWMode(os.Getenv("TRANSCODER_HWACCEL"))
	if err != nil {
		log.Error("config", "err", err)
		return 2
	}
	bin := strings.TrimSpace(os.Getenv("FFMPEG_PATH"))
	if bin == "" {
		bin = "ffmpeg"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	dev := scanDevices()
	log.Info("devices", "nvidia", dev.Nvidia, "render", strings.Join(dev.Render, ","))
	fmt.Println(DetectEncoder(ctx, mode, dev, strings.TrimSpace(os.Getenv("TRANSCODER_HWACCEL_DEVICE")), ffmpegProber{bin: bin}, log))
	return 0
}
