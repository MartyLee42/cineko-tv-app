// Package ivrestart restarts Invidious (and its companion) every night.
//
// Invidious degrades the longer it runs (memory, a pool of stale YouTube
// connections, rate limits), and its docs recommend restarting it regularly.
// At INVIDIOUS_RESTART_AT (03:00 in the household's timezone) the API asks a
// Docker socket proxy to restart the containers — the proxy only allows
// POST /containers/<those names>/restart, nothing else. If a YouTube video is
// playing (/api/v1/vstream activity in the last few minutes) the restart waits
// and re-checks every 15 minutes; if someone is still watching two hours
// later, it is skipped until the next night.
package ivrestart

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"martytv/api/internal/config"
)

const (
	retryEvery = 15 * time.Minute
	window     = 2 * time.Hour   // 03:00 → last try at 05:00
	busyFor    = 5 * time.Minute // stream activity this recent = someone is watching
	stopWait   = 10              // seconds Docker waits before killing a container
)

// NextRun is the next h:m (strictly after now) in loc.
func NextRun(now time.Time, h, m int, loc *time.Location) time.Time {
	l := now.In(loc)
	next := time.Date(l.Year(), l.Month(), l.Day(), h, m, 0, 0, loc)
	if !next.After(l) {
		next = time.Date(l.Year(), l.Month(), l.Day()+1, h, m, 0, 0, loc)
	}
	return next
}

type action int

const (
	actRestart action = iota
	actWait           // someone is watching: check again in retryEvery
	actSkip           // still watching at the end of the window: next night
)

// decide is one check of tonight's window that began at start.
func decide(now, start, lastActive time.Time) action {
	if lastActive.IsZero() || now.Sub(lastActive) >= busyFor {
		return actRestart
	}
	if now.Add(retryEvery).After(start.Add(window)) {
		return actSkip
	}
	return actWait
}

// Restarter is the nightly loop (Run from main).
type Restarter struct {
	cfg        config.InvidiousRestartConfig
	lastActive func() time.Time
	hc         *http.Client
	log        *slog.Logger
	now        func() time.Time
	sleep      func(context.Context, time.Duration) bool
}

// New builds the restarter; lastActive reports the latest YouTube stream
// activity (playback.LastVideoStream).
func New(cfg config.InvidiousRestartConfig, lastActive func() time.Time, log *slog.Logger) *Restarter {
	return &Restarter{
		cfg: cfg, lastActive: lastActive, log: log.With("module", "ivrestart"),
		hc:  &http.Client{Timeout: time.Duration(stopWait+60) * time.Second},
		now: time.Now, sleep: sleepCtx,
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// Run sleeps until each night's window and restarts (or postpones / skips).
func (r *Restarter) Run(ctx context.Context) {
	if !r.cfg.Enabled() {
		r.log.Info("nightly Invidious restart off")
		return
	}
	r.log.Info("nightly Invidious restart scheduled", "at", r.cfg.At(), "tz", r.cfg.Location.String(), "containers", r.cfg.Containers)
	for {
		start := NextRun(r.now(), r.cfg.Hour, r.cfg.Minute, r.cfg.Location)
		if !r.sleep(ctx, time.Until(start)) {
			return
		}
		if !r.night(ctx, start) {
			return
		}
	}
}

// night runs one window; false when ctx ended.
func (r *Restarter) night(ctx context.Context, start time.Time) bool {
	for {
		switch decide(r.now(), start, r.lastActive()) {
		case actRestart:
			r.RestartAll(ctx)
			return ctx.Err() == nil
		case actSkip:
			r.log.Info("Invidious restart skipped tonight: a video is still playing")
			return true
		default:
			r.log.Info("Invidious restart postponed: a video is playing", "retry_in", retryEvery.String())
			if !r.sleep(ctx, retryEvery) {
				return false
			}
		}
	}
}

// RestartAll restarts the containers in order (companion before Invidious).
func (r *Restarter) RestartAll(ctx context.Context) {
	for _, name := range r.cfg.Containers {
		if err := r.restart(ctx, name); err != nil {
			r.log.Warn("Invidious restart failed", "container", name, "err", err)
			continue
		}
		r.log.Info("restarted", "container", name)
	}
}

func (r *Restarter) restart(ctx context.Context, name string) error {
	u := fmt.Sprintf("%s/containers/%s/restart?t=%d", r.cfg.DockerURL, url.PathEscape(name), stopWait)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, nil)
	if err != nil {
		return err
	}
	resp, err := r.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("docker: HTTP %d %s", resp.StatusCode, b)
	}
	return nil
}
