package video

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
)

// Defaults of the per-profile settings (ProfileSettings.video_quality /
// video_hide_shorts).
const (
	DefaultQuality    = 720
	DefaultHideShorts = true

	minResumeSeconds = 15
	feedRefreshEvery = 30 * time.Minute
	healthEvery      = time.Minute
	feedPerChannel   = 30
	thumbMaxAge      = 7 * 24 * time.Hour
)

// Qualities are the allowed video_quality values.
var Qualities = []int{480, 720, 1080}

// Prefs are a profile's video settings.
type Prefs struct {
	Quality    int
	HideShorts bool
}

// ProfileAccess is profiles.Store (CanUse).
type ProfileAccess interface {
	CanUse(ctx context.Context, p *auth.Principal, profileID string) (bool, error)
}

// Deps wires the service (server.New).
type Deps struct {
	Pool     *pgxpool.Pool
	Client   *Client
	Profiles ProfileAccess
	// Prefs reads a profile's video settings (defaults when unset).
	Prefs func(ctx context.Context, profileID string) Prefs
	// Region for trending/search (ISO 3166-1 alpha-2, default RU).
	Region string
	// ThumbDir caches proxied thumbnails/avatars ("" = no disk cache).
	ThumbDir string
	Log      *slog.Logger
}

// Service is the «Видео» tab backend.
type Service struct {
	pool     *pgxpool.Pool
	client   *Client
	profiles ProfileAccess
	prefs    func(ctx context.Context, profileID string) Prefs
	region   string
	thumbDir string
	log      *slog.Logger
	st       *store

	health health

	refreshMu sync.Mutex // one feed refresh at a time
	kick      chan string
	thumbBad  sync.Map // path → time.Time of a failed fetch
}

// NewService builds the service; Client may be unconfigured (every call
// then answers 503 video_unavailable).
func NewService(d Deps) *Service {
	if d.Region == "" {
		d.Region = "RU"
	}
	if d.Log == nil {
		d.Log = slog.Default()
	}
	s := &Service{pool: d.Pool, client: d.Client, profiles: d.Profiles, prefs: d.Prefs, region: d.Region,
		thumbDir: d.ThumbDir, log: d.Log.With("module", "video"), st: &store{q: d.Pool}, kick: make(chan string, 64)}
	if s.client == nil {
		s.client, _ = NewClient("", nil)
	}
	s.client.onResult = s.health.record
	return s
}

// Routes mounts /video/* on the authenticated /api/v1 group. The thumbnail
// proxy is public like the IPTV logos (<img> on TVs can't send a bearer).
func (s *Service) Routes(r fiber.Router) {
	r.Get("/video/thumbs/vi/:id/:name", s.thumbVideo)
	r.Get("/video/thumbs/ggpht/*", s.thumbGgpht)
	pc := profiles.RequireProfileCaller()
	r.Get("/video/search", pc, s.search)
	r.Get("/video/search/suggestions", pc, s.suggestions)
	r.Get("/video/trending", pc, s.trending)
	r.Get("/video/videos/:id", pc, s.videoDetail)
	r.Get("/video/channels/:id", pc, s.channel)
	r.Get("/video/channels/:id/videos", pc, s.channelVideos)
	r.Get("/video/playlists/:id", pc, s.playlist)
	r.Get("/video/feed", pc, s.feed)
	r.Get("/video/subscriptions", pc, s.listSubscriptions)
	r.Put("/video/subscriptions/:channel_id", pc, s.subscribe)
	r.Delete("/video/subscriptions/:channel_id", pc, s.unsubscribe)
	r.Get("/video/watch-later", pc, s.listWatchLater)
	r.Put("/video/watch-later/:video_id", pc, s.addWatchLater)
	r.Delete("/video/watch-later/:video_id", pc, s.removeWatchLater)
	r.Get("/video/history", pc, s.listHistory)
	r.Delete("/video/history/:video_id", pc, s.removeHistory)
	r.Get("/video/continue", pc, s.listContinue)
	r.Post("/video/progress", pc, s.postProgress)
}

// AdminRoutes mounts /admin/video (health card).
func (s *Service) AdminRoutes(admin fiber.Router) {
	admin.Get("/video/status", s.adminStatus)
}

// errUnavailable is the 503 every catalog call answers while Invidious is
// down or not configured.
func errUnavailable() error {
	return httpx.NewError(fiber.StatusServiceUnavailable, "video_unavailable", "The video service is not responding.")
}

// apiErr maps client errors.
func apiErr(err error) error {
	switch {
	case errors.Is(err, ErrNotFound):
		return httpx.NotFound()
	case errors.Is(err, ErrNotConfigured):
		return errUnavailable()
	}
	var ue *UpstreamError
	if errors.As(err, &ue) {
		return errUnavailable()
	}
	return err
}

// Run probes Invidious every minute and refreshes the subscriptions feed
// every 30 min (and right after a new subscription). Also prunes the
// thumbnail cache.
func (s *Service) Run(ctx context.Context) {
	if !s.client.Configured() {
		return
	}
	probe := time.NewTicker(healthEvery)
	defer probe.Stop()
	feed := time.NewTimer(20 * time.Second) // let Invidious start first
	defer feed.Stop()
	prune := time.NewTicker(6 * time.Hour)
	defer prune.Stop()
	s.probe(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-probe.C:
			s.probe(ctx)
		case <-feed.C:
			s.RefreshFeeds(ctx)
			feed.Reset(feedRefreshEvery)
		case id := <-s.kick:
			s.refreshChannel(ctx, id)
		case <-prune.C:
			s.pruneThumbs()
		}
	}
}

// RefreshFeeds refreshes the latest videos of every subscribed channel.
func (s *Service) RefreshFeeds(ctx context.Context) {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	ids, err := s.st.subscribedChannels(ctx)
	if err != nil {
		s.log.Warn("video feed: list channels failed", "err", err)
		return
	}
	ok, failed := 0, 0
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		if err := s.refreshChannelLocked(ctx, id); err != nil {
			failed++
		} else {
			ok++
		}
	}
	if err := s.st.pruneChannels(ctx); err != nil {
		s.log.Warn("video feed: prune failed", "err", err)
	}
	if len(ids) > 0 {
		s.log.Info("video feed refreshed", "channels", len(ids), "ok", ok, "failed", failed)
	}
}

func (s *Service) refreshChannel(ctx context.Context, id string) {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	_ = s.refreshChannelLocked(ctx, id)
}

func (s *Service) refreshChannelLocked(ctx context.Context, id string) error {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cv, err := s.client.ChannelVideosFresh(cctx, id)
	if err != nil {
		_ = s.st.channelError(ctx, id, clip(err.Error(), 300))
		return err
	}
	// Original titles / channel name from the RSS feed (best effort, fresh).
	s.client.Forget("rss/" + id)
	_, _ = s.client.ChannelFeed(cctx, id)
	items := s.client.Originals(toItems(cv.Videos))
	if len(items) > feedPerChannel {
		items = items[:feedPerChannel]
	}
	return s.st.replaceChannelVideos(ctx, id, items)
}

// kickChannel asks Run to refresh one channel soon (new subscription).
func (s *Service) kickChannel(id string) {
	select {
	case s.kick <- id:
	default:
	}
}

func (s *Service) pruneThumbs() {
	if s.thumbDir == "" {
		return
	}
	cutoff := time.Now().Add(-thumbMaxAge)
	_ = filepath.WalkDir(s.thumbDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(p)
		}
		return nil
	})
}

// ---- health (admin card) ----

type health struct {
	mu          sync.Mutex
	reachable   *bool
	version     string
	latency     time.Duration
	checkedAt   time.Time
	lastError   string
	lastErrorAt time.Time
	lastOKAt    time.Time
}

func (h *health) record(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err == nil {
		h.lastOKAt = time.Now()
		return
	}
	h.lastError = clip(err.Error(), 300)
	h.lastErrorAt = time.Now()
}

func (s *Service) probe(ctx context.Context) {
	cctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	start := time.Now()
	st, err := s.client.Stats(cctx)
	if ctx.Err() != nil {
		return
	}
	s.health.mu.Lock()
	defer s.health.mu.Unlock()
	ok := err == nil
	s.health.reachable = &ok
	s.health.checkedAt = time.Now()
	if ok {
		s.health.latency = time.Since(start)
		s.health.version = st.Software.Version
	}
}

// Health is the last Invidious probe for /metrics (no network call);
// reachable nil = not checked yet.
func (s *Service) Health() (configured bool, reachable *bool, latency time.Duration) {
	s.health.mu.Lock()
	defer s.health.mu.Unlock()
	if s.health.reachable != nil {
		ok := *s.health.reachable
		reachable = &ok
		latency = s.health.latency
	}
	return s.client.Configured(), reachable, latency
}

// Status is GET /admin/video/status.
type Status struct {
	Configured    bool    `json:"configured"`
	Reachable     *bool   `json:"reachable"` // null = not checked yet
	Version       *string `json:"version"`
	LatencyMS     *int64  `json:"latency_ms"`
	CheckedAt     *string `json:"checked_at"`
	LastError     *string `json:"last_error"`
	LastErrorAt   *string `json:"last_error_at"`
	LastOKAt      *string `json:"last_ok_at"`
	Subscriptions int     `json:"subscriptions"`
	Channels      int     `json:"channels"`
	FeedVideos    int     `json:"feed_videos"`
	FeedRefreshed *string `json:"feed_refreshed_at"`
}

func ts(t time.Time) *string {
	if t.IsZero() {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}

func (s *Service) adminStatus(c fiber.Ctx) error {
	if c.Query("check") == "true" && s.client.Configured() {
		s.probe(c.Context())
	}
	out := Status{Configured: s.client.Configured()}
	s.health.mu.Lock()
	out.Reachable = s.health.reachable
	if s.health.version != "" {
		v := s.health.version
		out.Version = &v
	}
	if s.health.reachable != nil && *s.health.reachable {
		ms := s.health.latency.Milliseconds()
		out.LatencyMS = &ms
	}
	out.CheckedAt = ts(s.health.checkedAt)
	if s.health.lastError != "" {
		e := s.health.lastError
		out.LastError = &e
	}
	out.LastErrorAt = ts(s.health.lastErrorAt)
	out.LastOKAt = ts(s.health.lastOKAt)
	s.health.mu.Unlock()
	st, err := s.st.stats(c.Context())
	if err != nil {
		return err
	}
	out.Subscriptions, out.Channels, out.FeedVideos, out.FeedRefreshed = st.subs, st.channels, st.videos, ts(st.refreshed)
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(out)
}
