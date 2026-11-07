package iptv

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"

	"martytv/api/internal/audit"
	"martytv/api/internal/config"
	"martytv/api/internal/profiles"
)

// Deps wires the service.
type Deps struct {
	Pool     *pgxpool.Pool
	Config   config.IPTVConfig
	Profiles *profiles.Store
	Audit    *audit.Logger
	// LogoDir caches proxied channel logos (under IMAGE_CACHE_DIR).
	LogoDir string
	Log     *slog.Logger
}

// Service manages playlists, channels, the guide and per-profile prefs.
type Service struct {
	st       *store
	pool     *pgxpool.Pool
	cfg      config.IPTVConfig
	profiles *profiles.Store
	audit    *audit.Logger
	log      *slog.Logger

	short *fetcher // playlists, logos, probes
	long  *fetcher // XMLTV guides, iptv-org metadata

	logoDir string
	logoMu  sync.Mutex
	logoBad map[string]time.Time // url hash → don't retry before

	mu      sync.Mutex
	running map[string]bool // playlist ids being refreshed
	epgRun  map[string]bool // epg source ids being refreshed
	org     orgCache

	// Guide downloads: no client timeout (dlOpts.Total bounds them), temp
	// files under guideDir.
	dl       *fetcher
	dlOpts   downloadOpts
	guideDir string
	progress progressMap
	logoSem  chan struct{}
	logoSF   singleflight.Group

	now func() time.Time
	bg  sync.WaitGroup
}

func NewService(d Deps) *Service {
	s := &Service{
		st: &store{q: d.Pool}, pool: d.Pool, cfg: d.Config, profiles: d.Profiles, audit: d.Audit,
		log:     d.Log.With("module", "iptv"),
		short:   newFetcher(d.Config.ProxyURL, d.Config.AllowPrivate, 60*time.Second),
		long:    newFetcher(d.Config.ProxyURL, d.Config.AllowPrivate, 15*time.Minute),
		logoDir: d.LogoDir, logoBad: map[string]time.Time{},
		dl:      newFetcher(d.Config.ProxyURL, d.Config.AllowPrivate, 0),
		dlOpts:  defaultDownloadOpts(),
		logoSem: make(chan struct{}, 6),
		running: map[string]bool{}, epgRun: map[string]bool{},
		now: time.Now,
	}
	if d.LogoDir != "" {
		s.guideDir = filepath.Join(filepath.Dir(d.LogoDir), "iptv-guides")
	}
	return s
}

// SetDownloadOpts replaces the guide download limits (tests).
func (s *Service) SetDownloadOpts(total, idle time.Duration) {
	s.dlOpts.Total, s.dlOpts.Idle = total, idle
}

// Wait blocks until background refreshes finish (tests).
func (s *Service) Wait() { s.bg.Wait() }

// PlaylistIDs lists every playlist id (profile settings validation).
func (s *Service) PlaylistIDs() []string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	rows, err := s.pool.Query(ctx, `SELECT id::text FROM iptv_playlists`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out
}

// ---------------------------------------------------------------- scheduling

// Run refreshes playlists every RefreshHours, guides every EPGRefreshHours
// and prunes old programmes; healthLoop checks streams alongside.
func (s *Service) Run(ctx context.Context) {
	_, _ = s.pool.Exec(ctx, `UPDATE iptv_playlists SET refresh_status = 'error', refresh_error = 'interrupted' WHERE refresh_status = 'running'`)
	_, _ = s.pool.Exec(ctx, `UPDATE iptv_playlists SET epg_status = 'error', epg_error = 'interrupted' WHERE epg_status = 'running'`)
	if s.guideDir != "" { // temp files of downloads a restart interrupted
		if parts, _ := filepath.Glob(filepath.Join(s.guideDir, "*.part")); len(parts) > 0 {
			for _, p := range parts {
				_ = os.Remove(p)
			}
		}
	}
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	var lastPrune time.Time
	select {
	case <-ctx.Done():
		return
	case <-time.After(30 * time.Second):
	}
	go s.healthLoop(ctx)
	for {
		s.tick(ctx)
		if time.Since(lastPrune) > 6*time.Hour {
			_, _ = s.pool.Exec(ctx, `DELETE FROM iptv_programmes WHERE stop_at < now() - interval '1 day'`)
			lastPrune = time.Now()
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Service) tick(ctx context.Context) {
	pls, err := s.st.playlists(ctx, true)
	if err != nil {
		return
	}
	due := s.now().Add(-time.Duration(s.cfg.RefreshHours) * time.Hour)
	for _, p := range pls {
		if ctx.Err() != nil {
			return
		}
		switch {
		case p.RefreshStatus == "running":
			continue
		case p.RefreshStatus == "error" && p.RefreshedAt != nil && p.RefreshedAt.After(s.now().Add(-time.Hour)):
			continue // retry failures hourly, not every minute
		case p.RefreshStatus == "ok" && p.RefreshedAt != nil && p.RefreshedAt.After(due):
			continue
		}
		s.refreshPlaylist(ctx, p.ID, false)
	}
	s.refreshDueGuides(ctx)
}

// StartRefresh starts a playlist refresh (then its guide) in the
// background; false when one is already running.
func (s *Service) StartRefresh(id string) bool {
	s.mu.Lock()
	if s.running[id] {
		s.mu.Unlock()
		return false
	}
	s.running[id] = true
	s.mu.Unlock()
	_ = s.st.setStatus(context.Background(), id, "running", nil, "")
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
		defer cancel()
		s.refreshPlaylist(ctx, id, true)
	}()
	return true
}

// refreshPlaylist downloads/parses one playlist and stores its channels,
// then refreshes its guide. claimed = the caller already marked it running.
func (s *Service) refreshPlaylist(ctx context.Context, id string, claimed bool) {
	if !claimed {
		s.mu.Lock()
		if s.running[id] {
			s.mu.Unlock()
			return
		}
		s.running[id] = true
		s.mu.Unlock()
		_ = s.st.setStatus(ctx, id, "running", nil, "")
	}
	defer func() {
		s.mu.Lock()
		delete(s.running, id)
		s.mu.Unlock()
	}()
	log := s.log.With("playlist_id", id)
	started := time.Now()
	p, err := s.st.playlist(ctx, id)
	if err != nil {
		return
	}
	pl, via, err := s.loadPlaylist(ctx, p)
	if err == nil && len(pl.Entries) == 0 {
		err = errors.New("no channels found in the playlist")
	}
	if err != nil {
		msg := err.Error()
		log.Warn("iptv playlist refresh failed", "err", msg)
		_ = s.st.setStatus(context.WithoutCancel(ctx), id, "error", &msg, "")
		return
	}
	var alt map[string][]string
	if p.Kind == "iptv_org_country" {
		ids := map[string]bool{}
		for _, e := range pl.Entries {
			if b := baseTvgID(e.TvgID); b != "" {
				ids[b] = true
			}
		}
		alt = s.orgAltNames(ctx, p.ViaProxy, ids)
	}
	n, err := s.st.upsertChannels(ctx, id, pl.Entries, alt)
	if err != nil {
		msg := "storing channels failed"
		log.Error("iptv store channels failed", "err", err)
		_ = s.st.setStatus(context.WithoutCancel(ctx), id, "error", &msg, "")
		return
	}
	header := strings.Join(pl.EPGURLs, "\n")
	_, _ = s.pool.Exec(ctx, `UPDATE iptv_playlists SET header_epg_url = NULLIF($2, '') WHERE id = $1`, id, header)
	_ = s.st.setStatus(ctx, id, "ok", nil, via)
	log.Info("iptv playlist refreshed", "channels", n, "skipped", pl.Skipped, "via", via, "took", time.Since(started).Round(time.Millisecond))
	if p.Enabled {
		s.refreshGuideFor(ctx, id)
	}
}

const maxPlaylistBytes = 20 << 20

// loadPlaylist fetches (or reads the uploaded) M3U of a playlist.
func (s *Service) loadPlaylist(ctx context.Context, p *playlistRow) (*Playlist, string, error) {
	var (
		body io.ReadCloser
		via  string
		err  error
	)
	switch p.Kind {
	case "m3u_file":
		c, err := s.st.content(ctx, p.ID)
		if err != nil {
			return nil, "", err
		}
		if c == "" {
			return nil, "", errors.New("no file uploaded")
		}
		body, via = io.NopCloser(strings.NewReader(c)), "upload"
	default:
		u := s.playlistURL(p)
		if u == "" {
			return nil, "", errors.New("playlist has no URL")
		}
		headers := map[string]string{}
		if p.UserAgent != nil {
			headers["User-Agent"] = *p.UserAgent
		}
		if p.Referrer != nil {
			headers["Referer"] = *p.Referrer
		}
		body, via, err = s.short.open(ctx, u, p.ViaProxy, headers)
		if err != nil {
			return nil, "", err
		}
	}
	defer body.Close()
	r, err := MaybeGunzip(&limitReader{r: body, n: maxPlaylistBytes})
	if err != nil {
		return nil, "", errors.New("invalid gzip")
	}
	pl, err := ParseM3U(r)
	if errors.Is(err, errTooLarge) {
		return nil, "", errors.New("playlist larger than 20 MB")
	}
	if err != nil {
		return nil, "", errors.New("playlist read failed")
	}
	return pl, via, nil
}

func (s *Service) playlistURL(p *playlistRow) string {
	switch p.Kind {
	case "iptv_org_country":
		if p.Country == nil {
			return ""
		}
		return s.cfg.OrgBaseURL + "/countries/" + *p.Country + ".m3u"
	case "m3u_url":
		if p.URL != nil {
			return *p.URL
		}
	}
	return ""
}

func epgSourceID(u string) string {
	h := sha256.Sum256([]byte(u))
	return hex.EncodeToString(h[:8])
}

func hash8(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:4])
}

// healthLoop probes favorite/recent channels every 30 min and sweeps all
// channels (each about daily, healthBatch per 10 min) — off the main loop,
// a sweep can take minutes.
func (s *Service) healthLoop(ctx context.Context) {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	var lastWatched time.Time
	for {
		if time.Since(lastWatched) > 30*time.Minute {
			s.probeWatched(ctx)
			lastWatched = time.Now()
		}
		s.checkDue(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
