package server

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/config"
	"martytv/api/internal/integrations"
	"martytv/api/internal/playback"
)

// statusTTL is how long one status answer is reused: TVs poll it for their
// status line, and it must never turn into load on TorrServer.
const statusTTL = 15 * time.Second

// ServiceStatus is the non-admin view of the backend: just enough for a
// TV's status corner / ticker (no versions, errors or URLs).
type ServiceStatus struct {
	TorrServer struct {
		OK        bool   `json:"ok"`
		LatencyMS *int64 `json:"latency_ms"`
	} `json:"torrserver"`
	Prowlarr struct {
		OK bool `json:"ok"`
	} `json:"prowlarr"`
	// ActiveStreams counts streams being proxied right now (all users).
	ActiveStreams int64     `json:"active_streams"`
	ServerTime    time.Time `json:"server_time"`
	// SeasonalEffects is the admin's global switch of the holiday
	// animations (internal/appsettings); false = off for everyone.
	SeasonalEffects bool `json:"seasonal_effects"`
	// CPUPercent is the server's CPU use right now (player stats panel);
	// null until the first 10 s sample.
	CPUPercent *float64 `json:"cpu_percent"`
}

// statusService answers GET /status from the shared integrations checker
// plus a timed TorrServer /echo round trip, cached for statusTTL.
type statusService struct {
	statuses func(context.Context) []integrations.Status
	echoURL  string
	client   *http.Client
	streams  func() int64
	now      func() time.Time
	seasonal func(context.Context) bool
	cpu      func() *float64

	mu   sync.Mutex
	last *ServiceStatus
	at   time.Time
}

func newStatusService(cfg config.TorrServerConfig, statuses func(context.Context) []integrations.Status) *statusService {
	s := &statusService{
		statuses: statuses,
		client:   &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		streams:  playback.ActiveStreams,
		now:      time.Now,
	}
	if cfg.URL != "" {
		s.echoURL = cfg.URL + "/echo"
	}
	return s
}

// withCPU sets the source of cpu_percent (sysmon's latest sample).
func (s *statusService) withCPU(f func() *float64) *statusService {
	s.cpu = f
	return s
}

// withSeasonal sets the source of the seasonal_effects flag.
func (s *statusService) withSeasonal(f func(context.Context) bool) *statusService {
	s.seasonal = f
	return s
}

// get returns the cached status, refreshing it when older than statusTTL.
func (s *statusService) get(ctx context.Context) ServiceStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.last == nil || s.now().Sub(s.at) >= statusTTL {
		st := s.probe(ctx)
		s.last, s.at = &st, s.now()
	}
	out := *s.last
	// Cheap and live: not cached.
	out.ActiveStreams = s.streams()
	out.ServerTime = s.now().UTC()
	out.SeasonalEffects = s.seasonal == nil || s.seasonal(ctx) // in-memory, not cached here
	if s.cpu != nil {
		out.CPUPercent = s.cpu()
	}
	return out
}

func (s *statusService) probe(ctx context.Context) ServiceStatus {
	var st ServiceStatus
	for _, it := range s.statuses(ctx) {
		switch it.Name {
		case "torrserver":
			st.TorrServer.OK = it.OK
		case "prowlarr":
			st.Prowlarr.OK = it.OK
		}
	}
	if st.TorrServer.OK && s.echoURL != "" {
		ms, ok := s.ping(ctx)
		if ok {
			st.TorrServer.LatencyMS = &ms
		} else {
			// The checker's answer may be up to 30 s old; a failed echo wins.
			st.TorrServer.OK = false
		}
	}
	return st
}

// ping times one GET /echo (no credentials needed).
func (s *statusService) ping(ctx context.Context) (int64, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.echoURL, nil)
	if err != nil {
		return 0, false
	}
	start := time.Now()
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, false
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, false
	}
	return time.Since(start).Milliseconds(), true
}

// Routes registers GET /status for any signed-in reader (users, TVs, tokens).
func (s *statusService) Routes(api fiber.Router) {
	api.Get("/status", auth.RequireReader(), func(c fiber.Ctx) error {
		return c.JSON(s.get(c.Context()))
	})
}
