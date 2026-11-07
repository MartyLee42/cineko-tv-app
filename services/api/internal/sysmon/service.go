package sysmon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"math"
	"net"
	"net/http"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/integrations"
	"martytv/api/internal/integrations/torrserver"
)

// SystemStatus is GET /api/v1/admin/system.
type SystemStatus struct {
	HostStatus
	// Hostmon is "ok" when the host service answered, "unavailable" when the
	// numbers come from the API container's own /proc (scope "container").
	Hostmon string `json:"hostmon"`
	App     App    `json:"app"`
}

type App struct {
	MartyTVVersion  string                `json:"martytv_version"`
	GoRoutines      int                   `json:"go_routines"`
	GoHeapBytes     uint64                `json:"go_heap_bytes"`
	ActiveStreams   int                   `json:"active_streams"`
	WSConnections   WSCounts              `json:"ws_connections"`
	DBSizeBytes     *int64                `json:"db_size_bytes"`
	ImageCacheBytes *int64                `json:"image_cache_bytes"`
	TorrServer      TorrServerStats       `json:"torrserver"`
	Integrations    []integrations.Status `json:"integrations"`
	// Transcoder (browser compatibility streams); null when not configured.
	Transcoder *TranscoderStats `json:"transcoder"`
}

// TranscoderStats are services/transcoder's counters (ok: false when it
// doesn't answer).
type TranscoderStats struct {
	OK                 bool  `json:"ok"`
	ActiveJobs         int   `json:"active_jobs"`
	ActiveSubtitleJobs int   `json:"active_subtitle_jobs"`
	MaxJobs            int   `json:"max_jobs"`
	JobsStarted        int64 `json:"jobs_started"`
	JobsRejected       int64 `json:"jobs_rejected"`
	JobsFailed         int64 `json:"jobs_failed"`
	// VideoEncoder: what re-encoded video runs on (cpu, nvenc, vaapi, qsv);
	// VideoEncoderFallback: the GPU failed recently and the CPU is used.
	VideoEncoder         string `json:"video_encoder,omitempty"`
	VideoEncoderFallback bool   `json:"video_encoder_fallback,omitempty"`
}

type WSCounts struct {
	Users   int `json:"users"`
	Devices int `json:"devices"`
}

type TorrServerStats struct {
	Configured       bool    `json:"configured"`
	OK               bool    `json:"ok"`
	Version          string  `json:"version,omitempty"`
	Torrents         int     `json:"torrents"`
	Active           int     `json:"active"`
	Peers            int     `json:"peers"`
	DownloadSpeedBps float64 `json:"download_speed_bps"`
	UploadSpeedBps   float64 `json:"upload_speed_bps"`
}

// Deps are the API pieces the service reads. Any may be nil/zero.
type Deps struct {
	Version       string
	Socket        string // HOSTMON_SOCKET
	ImageCacheDir string
	Pool          *pgxpool.Pool
	TorrServer    *torrserver.Client
	Hub           interface{ Counts() (users, devices int) }
	ActiveStreams func() int64
	Integrations  func(ctx context.Context) []integrations.Status
	// Transcoder returns nil when compat streams are off.
	Transcoder func(ctx context.Context) *TranscoderStats
}

// Service answers the admin endpoints in the API.
type Service struct {
	d     Deps
	hc    *http.Client
	local *Collector
	ring  *Ring // local samples (fallback + active streams), every 10 s

	cacheMu   sync.Mutex
	dbSize    cached[*int64]
	imgSize   cached[*int64]
	tsStats   cached[TorrServerStats]
	tcStats   cached[*TranscoderStats]
	tsVersion string
}

type cached[T any] struct {
	v  T
	at time.Time
}

func (c *cached[T]) get(ttl time.Duration, fill func() T) T {
	if !c.at.IsZero() && time.Since(c.at) < ttl {
		return c.v
	}
	c.v, c.at = fill(), time.Now()
	return c.v
}

func NewService(d Deps) *Service {
	s := &Service{d: d, ring: NewRing(HistorySize)}
	s.local = NewCollector("/proc", "container", "/", d.ImageCacheDir)
	if d.Socket != "" {
		sock := d.Socket
		s.hc = &http.Client{
			Timeout: 3 * time.Second,
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					var dl net.Dialer
					return dl.DialContext(ctx, "unix", sock)
				},
				MaxIdleConnsPerHost: 2,
				IdleConnTimeout:     30 * time.Second,
			},
		}
	}
	return s
}

// Run samples locally every SampleInterval (the container fallback history
// and the active-stream count merged into hostmon's history).
func (s *Service) Run(ctx context.Context) {
	t := time.NewTicker(SampleInterval)
	defer t.Stop()
	s.local.Collect(false) // baseline for CPU/network deltas
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.Tick()
		}
	}
}

// Tick takes one local sample.
func (s *Service) Tick() {
	smp := SampleFrom(s.local.Collect(false))
	n := s.activeStreams()
	smp.ActiveStreams = &n
	s.ring.Add(smp)
}

// CPUNow is the server's CPU use (% of all cores) from the latest local
// sample, nil before the first one or when it is stale (> 1 min).
func (s *Service) CPUNow() *float64 {
	smp, ok := s.ring.Latest()
	if !ok || time.Since(smp.T) > time.Minute {
		return nil
	}
	v := math.Round(smp.CPUPercent*10) / 10
	return &v
}

func (s *Service) activeStreams() int {
	if s.d.ActiveStreams == nil {
		return 0
	}
	return int(s.d.ActiveStreams())
}

var errHostmon = errors.New("hostmon unavailable")

func (s *Service) hostmon(ctx context.Context, path string, out any) error {
	if s.hc == nil {
		return errHostmon
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://hostmon"+path, nil)
	if err != nil {
		return err
	}
	resp, err := s.hc.Do(req)
	if err != nil {
		return errHostmon
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return errHostmon
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
		return errHostmon
	}
	return nil
}

// Status gathers everything for the admin tab.
func (s *Service) Status(ctx context.Context) SystemStatus {
	out := SystemStatus{Hostmon: "ok"}
	if err := s.hostmon(ctx, "/v1/status", &out.HostStatus); err != nil {
		out.Hostmon = "unavailable"
		out.HostStatus = s.local.Collect(true)
	} else if d, ok := StatDisk(s.d.ImageCacheDir); ok && s.d.ImageCacheDir != "" && !sameDisk(out.Disks, d) {
		out.Disks = append(out.Disks, d)
	}
	nilToEmpty(&out.HostStatus)
	out.App = s.app(ctx)
	return out
}

// sameDisk guesses whether d is a filesystem already listed (statfs ids
// differ between the host and the container, sizes don't).
func sameDisk(list []Disk, d Disk) bool {
	for _, x := range list {
		if x.Total == d.Total {
			return true
		}
	}
	return false
}

func nilToEmpty(h *HostStatus) {
	if h.Disks == nil {
		h.Disks = []Disk{}
	}
	if h.Network == nil {
		h.Network = []NetIface{}
	}
	if h.Processes == nil {
		h.Processes = []Process{}
	}
	if h.Containers == nil {
		h.Containers = []Container{}
	}
	if h.CPU.PerCore == nil {
		h.CPU.PerCore = []float64{}
	}
}

func (s *Service) app(ctx context.Context) App {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	a := App{
		MartyTVVersion: s.d.Version,
		GoRoutines:     runtime.NumGoroutine(),
		GoHeapBytes:    ms.HeapAlloc,
		ActiveStreams:  s.activeStreams(),
		Integrations:   []integrations.Status{},
	}
	if s.d.Hub != nil {
		a.WSConnections.Users, a.WSConnections.Devices = s.d.Hub.Counts()
	}
	if s.d.Integrations != nil {
		a.Integrations = s.d.Integrations(ctx)
	}
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	a.DBSizeBytes = s.dbSize.get(time.Minute, func() *int64 { return s.queryDBSize(ctx) })
	a.ImageCacheBytes = s.imgSize.get(5*time.Minute, func() *int64 { return dirSize(s.d.ImageCacheDir, 200_000) })
	a.TorrServer = s.tsStats.get(5*time.Second, func() TorrServerStats { return s.torrServer(ctx) })
	if s.d.Transcoder != nil {
		a.Transcoder = s.tcStats.get(2*time.Second, func() *TranscoderStats { return s.d.Transcoder(ctx) })
	}
	return a
}

func (s *Service) queryDBSize(ctx context.Context) *int64 {
	if s.d.Pool == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var n int64
	if err := s.d.Pool.QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&n); err != nil {
		return nil
	}
	return &n
}

// dirSize sums file sizes under dir, giving up (nil) past maxFiles.
func dirSize(dir string, maxFiles int) *int64 {
	if dir == "" {
		return nil
	}
	var total int64
	files := 0
	err := filepath.WalkDir(dir, func(_ string, e fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entries are skipped
		}
		if e.Type().IsRegular() {
			if files++; files > maxFiles {
				return fs.SkipAll
			}
			if info, err := e.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	if err != nil || files > maxFiles {
		return nil
	}
	return &total
}

func (s *Service) torrServer(ctx context.Context) TorrServerStats {
	ts := s.d.TorrServer
	if ts == nil || !ts.Configured() {
		return TorrServerStats{}
	}
	out := TorrServerStats{Configured: true}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	if caps, err := ts.Capabilities(ctx); err == nil {
		out.Version = caps.Version
	}
	list, err := ts.List(ctx)
	if err != nil {
		return out
	}
	out.OK = true
	out.Torrents = len(list)
	for _, t := range list {
		switch t.Stat {
		case torrserver.StatGettingInfo, torrserver.StatPreload, torrserver.StatWorking:
			out.Active++
		}
		out.Peers += t.ActivePeers
		out.DownloadSpeedBps += t.DownloadSpeed
		out.UploadSpeedBps += t.UploadSpeed
	}
	out.DownloadSpeedBps, out.UploadSpeedBps = round1(out.DownloadSpeedBps), round1(out.UploadSpeedBps)
	return out
}

// History returns the last minutes of samples: hostmon's (with the API's
// active-stream counts merged in) or the local fallback ring.
func (s *Service) History(ctx context.Context, minutes int) History {
	m := ClampMinutes(minutes)
	local := s.ring.Since(time.Now().Add(-time.Duration(m) * time.Minute))
	var h History
	if err := s.hostmon(ctx, "/v1/history?minutes="+strconv.Itoa(m), &h); err == nil {
		h.Samples = MergeStreams(h.Samples, local, SampleInterval/2+time.Second)
		if h.Samples == nil {
			h.Samples = []Sample{}
		}
		return h
	}
	st := s.local.Collect(false)
	return History{
		Scope: "container", IntervalSeconds: int(SampleInterval / time.Second),
		MemTotal: st.Memory.Total, Cores: st.CPU.Cores, Samples: local,
	}
}

// MergeStreams copies ActiveStreams from the nearest local sample (within
// tol) onto each host sample. Both slices are oldest first.
func MergeStreams(host, local []Sample, tol time.Duration) []Sample {
	j := 0
	for i := range host {
		t := host[i].T
		for j+1 < len(local) && absDur(local[j+1].T.Sub(t)) <= absDur(local[j].T.Sub(t)) {
			j++
		}
		if j < len(local) && absDur(local[j].T.Sub(t)) <= tol && local[j].ActiveStreams != nil {
			n := *local[j].ActiveStreams
			host[i].ActiveStreams = &n
		}
	}
	return host
}

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}
