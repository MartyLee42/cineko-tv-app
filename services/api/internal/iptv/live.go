package iptv

import (
	"context"
	"errors"
	"sync"
	"time"

	"martytv/api/internal/livecheck"
	"martytv/api/internal/playback"
)

// LiveChannel implements playback.LiveProvider: the upstream URL and
// headers of an active channel in an enabled playlist (channel
// #EXTVLCOPT values win over the playlist's overrides), plus its mirrors —
// the playlist's other URLs for the same tvg-id, then the same tvg-id in
// other enabled playlists.
func (s *Service) LiveChannel(ctx context.Context, id string) (*playback.LiveChannel, error) {
	if !validUUID(id) {
		return nil, playback.ErrLiveNotFound
	}
	r, err := s.st.stream(ctx, id)
	if errors.Is(err, errNotFound) || (err == nil && (!r.Active || !r.PlaylistOn)) {
		return nil, playback.ErrLiveNotFound
	}
	if err != nil {
		return nil, err
	}
	ch := &playback.LiveChannel{ID: r.ID, Name: r.Name, URL: r.URL, Headers: streamHeaders(r), Format: deref(r.Format),
		VideoCodec: deref(r.VideoCodec), AudioCodec: deref(r.AudioCodec)}
	seen := map[string]bool{r.URL: true}
	add := func(m mirror) {
		if seen[m.URL] || len(ch.Mirrors) >= maxMirrors {
			return
		}
		seen[m.URL] = true
		h := map[string]string{}
		if ua := firstNonEmpty(m.UserAgent, deref(r.PUserAgent)); ua != "" {
			h["User-Agent"] = ua
		}
		if ref := firstNonEmpty(m.Referrer, deref(r.PReferrer)); ref != "" {
			h["Referer"] = ref
		}
		ch.Mirrors = append(ch.Mirrors, playback.LiveMirror{URL: m.URL, Headers: h})
	}
	for _, m := range r.Mirrors {
		add(m)
	}
	if r.TvgID != nil && *r.TvgID != "" && len(ch.Mirrors) < maxMirrors {
		if more, err := s.st.sameChannel(ctx, r.ID, *r.TvgID); err == nil {
			for _, m := range more {
				add(m)
			}
		}
	}
	return ch, nil
}

func streamHeaders(r *streamRow) map[string]string {
	h := map[string]string{}
	if ua := firstNonEmpty(deref(r.UserAgent), deref(r.PUserAgent)); ua != "" {
		h["User-Agent"] = ua
	}
	if ref := firstNonEmpty(deref(r.Referrer), deref(r.PReferrer)); ref != "" {
		h["Referer"] = ref
	}
	return h
}

// ReportLive implements playback.LiveProvider: 3 consecutive failures mark
// a channel offline (shown dimmed), one success heals it. A start whose
// every URL failed with a definite cause (DNS, 404, 403…) is recorded like a
// health check: dead / geo channels go offline at once.
func (s *Service) ReportLive(ctx context.Context, id string, ok bool, format, cause string) {
	var err error
	if !ok && cause != "" {
		err = s.st.recordHealth(ctx, id, livecheck.Failed(cause))
	} else {
		err = s.st.report(ctx, id, ok, format)
	}
	if err != nil {
		s.log.Warn("iptv health update failed", "err", err)
	}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// ---------------------------------------------------------------- health checks

const (
	// healthEvery: every channel is checked about once a day.
	healthEvery = 24 * time.Hour
	// healthBatch channels are checked per sweep (every 10 min), healthParallel at a time.
	healthBatch    = 150
	healthParallel = 6
)

// CheckChannel walks a channel's stream directly from this server (its
// headers applied) and returns the verdict (not stored).
func (s *Service) CheckChannel(ctx context.Context, id string) (livecheck.Result, error) {
	r, err := s.st.stream(ctx, id)
	if err != nil {
		return livecheck.Result{}, err
	}
	return livecheck.Check(ctx, s.short.direct, r.URL, streamHeaders(r)), nil
}

// ProbeChannel checks a channel and records the verdict.
func (s *Service) ProbeChannel(ctx context.Context, id string) {
	res, err := s.CheckChannel(ctx, id)
	if err != nil || ctx.Err() != nil {
		return
	}
	if err := s.st.recordHealth(ctx, id, res); err != nil {
		s.log.Warn("iptv health update failed", "err", err)
	}
}

// probeWatched checks the streams people actually use — favorites and
// channels watched in the last 7 days — least recently checked first.
func (s *Service) probeWatched(ctx context.Context) {
	s.probeIDs(ctx, `SELECT c.id FROM iptv_channels c JOIN iptv_playlists p ON p.id = c.playlist_id AND p.enabled
		WHERE c.active AND (EXISTS (SELECT 1 FROM iptv_profile_channels pc WHERE pc.channel_id = c.id AND pc.favorite)
			OR EXISTS (SELECT 1 FROM iptv_profile_state ps WHERE ps.last_channel_id = c.id AND ps.last_watched_at > now() - interval '7 days'))
		ORDER BY c.checked_at NULLS FIRST LIMIT 60`)
}

// checkDue is the daily sweep: every active channel of an enabled playlist
// whose last full check is older than healthEvery, a batch at a time.
func (s *Service) checkDue(ctx context.Context) {
	s.probeIDs(ctx, `SELECT c.id FROM iptv_channels c JOIN iptv_playlists p ON p.id = c.playlist_id AND p.enabled
		WHERE c.active AND (c.health_checked_at IS NULL OR c.health_checked_at < now() - make_interval(secs => $1))
		ORDER BY c.health_checked_at NULLS FIRST LIMIT $2`, healthEvery.Seconds(), healthBatch)
}

func (s *Service) probeIDs(ctx context.Context, q string, args ...any) {
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	sem := make(chan struct{}, healthParallel)
	var wg sync.WaitGroup
	for _, id := range ids {
		if ctx.Err() != nil {
			break
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(id string) {
			defer func() { <-sem; wg.Done() }()
			s.ProbeChannel(ctx, id)
		}(id)
	}
	wg.Wait()
}
