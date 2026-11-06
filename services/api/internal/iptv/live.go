package iptv

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"martytv/api/internal/playback"
)

// LiveChannel implements playback.LiveProvider: the upstream URL and
// headers of an active channel in an enabled playlist (channel
// #EXTVLCOPT values win over the playlist's overrides).
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
	return &playback.LiveChannel{ID: r.ID, Name: r.Name, URL: r.URL, Headers: streamHeaders(r), Format: deref(r.Format)}, nil
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
// a channel offline (shown dimmed), one success heals it.
func (s *Service) ReportLive(ctx context.Context, id string, ok bool, format string) {
	if err := s.st.report(ctx, id, ok, format); err != nil {
		s.log.Warn("iptv health update failed", "err", err)
	}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// probeWatched checks the streams people actually use — favorites and
// channels watched in the last 7 days — least recently checked first.
// Other channels are only judged when played (lazily).
func (s *Service) probeWatched(ctx context.Context) {
	rows, err := s.pool.Query(ctx, `SELECT c.id FROM iptv_channels c JOIN iptv_playlists p ON p.id = c.playlist_id AND p.enabled
		WHERE c.active AND (EXISTS (SELECT 1 FROM iptv_profile_channels pc WHERE pc.channel_id = c.id AND pc.favorite)
			OR EXISTS (SELECT 1 FROM iptv_profile_state ps WHERE ps.last_channel_id = c.id AND ps.last_watched_at > now() - interval '7 days'))
		ORDER BY c.checked_at NULLS FIRST LIMIT 60`)
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
	sem := make(chan struct{}, 4)
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

// ProbeChannel GETs a channel's master playlist / stream head once and
// records the result.
func (s *Service) ProbeChannel(ctx context.Context, id string) {
	r, err := s.st.stream(ctx, id)
	if err != nil {
		return
	}
	pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	format, err := s.probe(pctx, r.URL, streamHeaders(r))
	if ctx.Err() != nil {
		return
	}
	s.ReportLive(ctx, id, err == nil, format)
}

func (s *Service) probe(ctx context.Context, u string, headers map[string]string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Cineko)")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := s.short.direct.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", errors.New("bad status")
	}
	head := make([]byte, 376)
	n, _ := io.ReadFull(resp.Body, head)
	head = head[:n]
	t := bytes.TrimLeft(bytes.TrimPrefix(head, []byte("\xef\xbb\xbf")), " \t\r\n")
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	switch {
	case bytes.HasPrefix(t, []byte("#EXTM3U")) || strings.Contains(ct, "mpegurl"):
		return "hls", nil
	case n > 0 && head[0] == 0x47, strings.HasPrefix(ct, "video/"):
		return "ts", nil
	}
	return "", errors.New("not a stream")
}
