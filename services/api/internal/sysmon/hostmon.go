package sysmon

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Hostmon is the host-side monitor served by cmd/martytv-hostmon.
type Hostmon struct {
	col    *Collector
	docker *Docker // nil = no Docker
	ring   *Ring
	log    *slog.Logger

	mu         sync.Mutex
	containers []Container
	now        func() time.Time
}

func NewHostmon(col *Collector, docker *Docker, log *slog.Logger) *Hostmon {
	return &Hostmon{col: col, docker: docker, ring: NewRing(HistorySize), log: log, containers: []Container{}, now: time.Now}
}

// Run samples every SampleInterval until ctx ends.
func (h *Hostmon) Run(ctx context.Context) {
	t := time.NewTicker(SampleInterval)
	defer t.Stop()
	// Baseline for CPU/network deltas; the first real sample follows.
	h.col.Collect(true)
	if h.docker != nil {
		_, _ = h.docker.Containers(ctx, 0)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.Tick(ctx)
		}
	}
}

// Tick takes one history sample and refreshes container stats.
func (h *Hostmon) Tick(ctx context.Context) {
	st := h.col.Collect(true)
	h.ring.Add(SampleFrom(st))
	if h.docker == nil {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	cs, err := h.docker.Containers(cctx, st.Memory.Total)
	if err != nil {
		h.log.Debug("docker stats failed", "err", err)
		cs = []Container{}
	}
	h.mu.Lock()
	h.containers = cs
	h.mu.Unlock()
}

// Status is the current snapshot (containers from the last tick).
func (h *Hostmon) Status() HostStatus {
	st := h.col.Collect(true)
	h.mu.Lock()
	st.Containers = append([]Container{}, h.containers...)
	h.mu.Unlock()
	return st
}

func (h *Hostmon) History(minutes int) History {
	m := ClampMinutes(minutes)
	st := h.col.Collect(false)
	return History{
		Scope: h.col.Scope, IntervalSeconds: int(SampleInterval / time.Second),
		MemTotal: st.Memory.Total, Cores: st.CPU.Cores,
		Samples: h.ring.Since(h.now().Add(-time.Duration(m) * time.Minute)),
	}
}

// Handler serves GET /v1/status and GET /v1/history?minutes=N.
func (h *Hostmon) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, h.Status())
	})
	mux.HandleFunc("GET /v1/history", func(w http.ResponseWriter, r *http.Request) {
		m, _ := strconv.Atoi(r.URL.Query().Get("minutes"))
		writeJSON(w, h.History(m))
	})
	return mux
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}
