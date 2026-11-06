package playback

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/httpx"
	"martytv/api/internal/releases"
	"martytv/api/internal/segments"
	"martytv/api/internal/sources"
)

// Online sources (kind "online"): a variant from GET /media/{id}/online
// (release_id "o…") played through an online provider (AniLiberty). The
// source is ready immediately; the stream URL is the same signed
// /api/v1/stream/<token> capability as for torrents, ending in /index.m3u8
// for HLS. The provider's upstream URLs never reach the client: playlists
// are rewritten so every URI goes through the proxy (see hls.go).

// OnlineProviders is what playback needs from the sources registry.
type OnlineProviders interface {
	Online(ctx context.Context, id string) (sources.OnlineProvider, error)
}

// Optional provider extensions.
type (
	streamRefresher interface{ Refresh(v sources.Variant) }
	skipMarkerer    interface {
		SkipMarkers(ctx context.Context, v sources.Variant) map[string][2]float64
	}
)

// ProviderRef names the provider of an online source (contract: ProviderRef).
type ProviderRef struct {
	ID   string       `json:"id"`
	Name string       `json:"name"`
	Kind sources.Kind `json:"kind"`
}

// StreamSubtitle is an external subtitle track, proxied (contract: Subtitle).
type StreamSubtitle struct {
	URL   string  `json:"url"`
	Lang  *string `json:"lang"`
	Label *string `json:"label"`
}

// SkipMarker is an opening/ending range the player may offer to skip.
type SkipMarker struct {
	Kind         string  `json:"kind"` // opening | recap | ending
	StartSeconds float64 `json:"start_seconds"`
	EndSeconds   float64 `json:"end_seconds"`
	// Source: chapters | provider | theintrodb | introdb.
	Source string `json:"source,omitempty"`
}

const (
	onlinePrefix       = "o"
	resolvedDefaultTTL = 30 * time.Minute
	resolvedSlack      = 10 * time.Minute
	maxResolvedCached  = 2000
)

type onlineDeps struct {
	providers OnlineProviders
	lookup    sources.VariantLookup
	hc        *http.Client
	urls      *urlSigner

	mu       sync.Mutex
	resolved map[string]resolvedStream // source id → upstream stream
}

type resolvedStream struct {
	st    *sources.Stream
	until time.Time
}

// SetOnline enables online sources (wired in server.New).
func (s *Service) SetOnline(p OnlineProviders, l sources.VariantLookup) {
	s.online = &onlineDeps{
		providers: p, lookup: l, hc: newUpstreamClient(false), urls: newURLSigner(s.cfg.SessionSecret),
		resolved: map[string]resolvedStream{},
	}
}

// SetUpstreamClient replaces the CDN client (tests: allow loopback).
func (s *Service) SetUpstreamClient(hc *http.Client) {
	if s.online != nil {
		s.online.hc = hc
	}
}

func isOnlineRelease(id string) bool { return strings.HasPrefix(id, onlinePrefix) }

// onlineState is playback_sources.online_ref (server-only).
type onlineState struct {
	Variant  sources.Variant `json:"variant"`
	Ref      json.RawMessage `json:"ref"`
	Quality  int             `json:"quality"` // requested; 0 = best
	Provider ProviderRef     `json:"provider"`
	Duration float64         `json:"duration,omitempty"` // seconds, from the provider (0 = unknown)
}

func (o *onlineState) variant() sources.Variant {
	v := o.Variant
	v.Ref = o.Ref
	return v
}

func parseOnline(src *source) (*onlineState, error) {
	var st onlineState
	if err := json.Unmarshal(src.OnlineRef, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

var errOnlineUnavailable = &apiError{Status: 502, Code: ErrCodeReleaseUnavailable, Msg: "The online source is unavailable."}

// createOnline is Create for "o…" release ids (media, episode and profile
// were validated by Create).
func (s *Service) createOnline(ctx context.Context, who caller, in CreateInput, tgt target, log *slog.Logger) (*PlaybackSource, error) {
	notFound := &apiError{Status: 404, Code: "release_not_found", Msg: "Release not found; search again."}
	if s.online == nil || s.online.lookup == nil {
		return nil, notFound
	}
	v, err := s.online.lookup.LookupVariant(ctx, in.MediaID, in.ReleaseID)
	if errors.Is(err, sources.ErrNotFound) || (err == nil && v == nil) {
		return nil, notFound
	}
	if err != nil {
		return nil, err
	}
	if tgt.Episode {
		if v.Episode != 0 && v.Episode != tgt.Number || v.Season != 0 && v.Season != tgt.Season {
			return nil, validation("episode_id", "This variant is for another episode.")
		}
		if v.Episode == 0 && len(v.Episodes) > 0 && !containsInt(v.Episodes, tgt.Number) {
			return nil, validation("episode_id", "This episode is not available from this source.")
		}
		v.Season, v.Episode, v.Episodes = tgt.Season, tgt.Number, nil
	}
	p, err := s.online.providers.Online(ctx, v.Provider)
	if err != nil {
		log.Info("online provider unavailable", "provider", v.Provider, "err", err)
		return nil, errOnlineUnavailable
	}
	quality := 0
	if in.Quality != nil {
		quality = *in.Quality
	} else if in.ProfileID != nil {
		quality = s.st.preferredHeight(ctx, *in.ProfileID)
	}
	st, err := p.Resolve(ctx, *v, quality)
	if err != nil || st == nil || st.URL == "" {
		log.Warn("online resolve failed", "provider", v.Provider, "err", err)
		return nil, errOnlineUnavailable
	}
	if _, err := upstreamURL(st.URL); err != nil {
		return nil, errOnlineUnavailable
	}

	info := p.Info()
	state := onlineState{Variant: *v, Ref: v.Ref, Quality: quality, Duration: st.Duration,
		Provider: ProviderRef{ID: v.Provider, Name: info.Title, Kind: info.Kind}}
	if st.Format != "" {
		state.Variant.Format = st.Format // e.g. an MP4 provider falling back to HLS
	}
	state.Variant.Ref = nil
	row := &source{
		MediaID: in.MediaID, EpisodeID: in.EpisodeID, ReleaseID: in.ReleaseID,
		Release: onlineRelease(*v, info), CreatedByUserID: who.UserID, ProfileID: in.ProfileID,
		Provider: &v.Provider,
	}
	if who.DeviceID != "" {
		row.DeviceID = &who.DeviceID
	}
	src, err := s.st.upsertOnline(ctx, row, state)
	if err != nil {
		return nil, err
	}
	s.online.remember(src.ID, st)
	log.Info("playback source", "source_id", src.ID, "kind", "online", "provider", v.Provider)
	return s.present(ctx, src, false), nil
}

func nonEmptyPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// preferredHeight is the profile's preferred resolution as a height
// (0 = none / best).
func (st *store) preferredHeight(ctx context.Context, profileID string) int {
	var res string
	if err := st.q.QueryRow(ctx, `SELECT preferred_resolution FROM profile_preferences WHERE profile_id = $1`, profileID).Scan(&res); err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSuffix(strings.ToLower(res), "p"))
	return n
}

func containsInt(xs []int, x int) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// onlineRelease renders a variant as the source's Release (the contract
// requires one): the voice shows as a voice-over studio like on torrents.
func onlineRelease(v sources.Variant, in sources.Info) releases.Release {
	r := releases.Release{
		ID: v.ID, Title: v.Title, Indexer: in.Title, AudioCodecs: []string{}, Languages: []string{},
		Voiceovers: []releases.Voiceover{}, Seasons: []int{}, Episodes: []int{}, Confidence: 1,
		Reasons: []string{}, Warnings: []string{},
	}
	if r.Title == "" {
		r.Title = in.Title
	}
	lang := v.Language
	if lang == "" {
		lang = "ru"
	}
	r.Languages = append(r.Languages, lang)
	if v.Voice != "" {
		vo := releases.Voiceover{Language: lang}
		voice := v.Voice
		vo.Studio = &voice
		if v.VoiceKind != "" {
			k := v.VoiceKind
			vo.Kind = &k
		}
		r.Voiceovers = append(r.Voiceovers, vo)
	}
	if v.MaxQuality > 0 {
		res := strconv.Itoa(v.MaxQuality) + "p"
		r.Resolution = &res
	}
	if v.Season > 0 {
		r.Seasons = append(r.Seasons, v.Season)
	}
	if v.Episode > 0 {
		r.Episodes = append(r.Episodes, v.Episode)
	}
	return r
}

// presentOnline renders an online source.
func (s *Service) presentOnline(ctx context.Context, src *source, live bool) *PlaybackSource {
	out := &PlaybackSource{
		ID: src.ID, MediaID: src.MediaID, EpisodeID: src.EpisodeID, Release: src.Release,
		Status: src.Status, Error: src.ErrorCode, CreatedAt: src.CreatedAt, Kind: "online",
		Qualities: []int{}, Subtitles: []StreamSubtitle{},
	}
	st, err := parseOnline(src)
	if err != nil {
		code := ErrCodeReleaseUnavailable
		out.Status, out.Error = "error", &code
		return out
	}
	prov := st.Provider
	if prov.ID == "" && src.Provider != nil {
		prov.ID, prov.Name = *src.Provider, *src.Provider
	}
	out.Provider = &prov
	format := st.Variant.Format
	if format == "" {
		format = "hls"
	}
	out.Format = &format
	out.Qualities = append([]int{}, st.Variant.Qualities...)
	if st.Quality > 0 {
		q := st.Quality
		out.Quality = &q
	}
	var resolved *sources.Stream
	if s.online != nil {
		if r, ok := s.online.cached(src.ID); ok {
			resolved = r
			if r.Quality > 0 {
				q := r.Quality
				out.Quality = &q
			}
		}
	}
	dur := st.Duration
	if resolved != nil && resolved.Duration > 0 {
		dur = resolved.Duration
	}
	if dur > 0 {
		out.DurationSeconds = &dur
	}
	if src.Status == "ready" {
		exp := time.Now().Add(s.t.TokenTTL).UTC().Truncate(time.Second)
		if tok, err := s.signer.Sign(src.ID, exp); err == nil {
			base := "/api/v1/stream/" + tok
			u := base
			if resolved != nil && s.online != nil {
				for _, sub := range resolved.Subtitles {
					if _, err := upstreamURL(sub.URL); err != nil {
						continue
					}
					out.Subtitles = append(out.Subtitles, StreamSubtitle{URL: base + "/" + s.online.urls.ref(src.ID, sub.URL),
						Lang: nonEmptyPtr(sub.Lang), Label: nonEmptyPtr(sub.Label)})
				}
			}
			mime := "video/mp4"
			if format == "hls" {
				u += "/index.m3u8"
				mime = hlsMime
			} else {
				u += "/video.mp4"
			}
			out.StreamURL, out.StreamExpiresAt, out.MimeType = &u, &exp, &mime
		}
	}
	var provider []segments.Segment
	if live && s.online != nil && src.Provider != nil {
		lctx, cancel := context.WithTimeout(ctx, s.t.StatsTimeout)
		defer cancel()
		if p, err := s.online.providers.Online(lctx, *src.Provider); err == nil {
			v := st.variant()
			if m, ok := p.(skipMarkerer); ok {
				marks := m.SkipMarkers(lctx, v)
				for _, k := range []string{segments.Opening, segments.Recap, segments.Ending} {
					if r, ok := marks[k]; ok {
						provider = append(provider, segments.Segment{Kind: k, Start: r[0], End: r[1], Source: "provider"})
					}
				}
			}
		}
	}
	if live && src.Status == "ready" {
		var length float64
		if out.DurationSeconds != nil {
			length = *out.DurationSeconds
		}
		out.Markers = s.markersFor(ctx, src, nil, nil, provider, length)
	}
	return out
}

// SetQuality switches an online source to another quality (PATCH).
func (s *Service) SetQuality(ctx context.Context, who caller, id string, quality int) (*PlaybackSource, error) {
	src, err := s.load(ctx, who, id)
	if err != nil {
		return nil, err
	}
	if src.Kind != "online" {
		return nil, validation("quality", "Only online sources have selectable qualities.")
	}
	st, err := parseOnline(src)
	if err != nil {
		return nil, errOnlineUnavailable
	}
	if quality != 0 && !containsInt(st.Variant.Qualities, quality) {
		return nil, validation("quality", "Not offered by this source.")
	}
	st.Quality = quality
	if err := s.st.setOnlineState(ctx, src.ID, *st); err != nil {
		return nil, err
	}
	if s.online != nil {
		s.online.forget(src.ID)
	}
	if src, err = s.st.get(ctx, src.ID); err != nil {
		return nil, err
	}
	return s.present(ctx, src, true), nil
}

func (o *onlineDeps) remember(id string, st *sources.Stream) {
	until := time.Now().Add(resolvedDefaultTTL)
	if !st.Expires.IsZero() {
		until = st.Expires.Add(-resolvedSlack)
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.resolved) >= maxResolvedCached {
		o.resolved = map[string]resolvedStream{}
	}
	o.resolved[id] = resolvedStream{st: st, until: until}
}

func (o *onlineDeps) cached(id string) (*sources.Stream, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	r, ok := o.resolved[id]
	if !ok || time.Now().After(r.until) {
		return nil, false
	}
	return r.st, true
}

func (o *onlineDeps) forget(id string) {
	o.mu.Lock()
	delete(o.resolved, id)
	o.mu.Unlock()
}

// upstream returns the source's resolved stream (cached until expiry);
// force re-resolves (after an upstream 403/404/410).
func (s *Service) upstream(ctx context.Context, src *source, force bool) (*sources.Stream, error) {
	o := s.online
	if o == nil || src.Provider == nil {
		return nil, errOnlineUnavailable
	}
	if !force {
		if st, ok := o.cached(src.ID); ok {
			return st, nil
		}
	}
	state, err := parseOnline(src)
	if err != nil {
		return nil, errOnlineUnavailable
	}
	p, err := o.providers.Online(ctx, *src.Provider)
	if err != nil {
		return nil, errOnlineUnavailable
	}
	v := state.variant()
	if force {
		if r, ok := p.(streamRefresher); ok {
			r.Refresh(v)
		}
	}
	st, err := p.Resolve(ctx, v, state.Quality)
	if err != nil || st == nil {
		return nil, errOnlineUnavailable
	}
	if _, err := upstreamURL(st.URL); err != nil {
		return nil, errOnlineUnavailable
	}
	o.remember(src.ID, st)
	return st, nil
}

// streamOnline serves /api/v1/stream/<token>[/<name>] for an online
// source: no name / index.m3u8 / video.mp4 = the resolved stream; any other
// name must be a signed upstream reference written by rewritePlaylist.
func (h *Handlers) streamOnline(c fiber.Ctx, token, name string, src *source) error {
	s := h.svc
	if src.Status != "ready" || s.online == nil {
		return httpx.NotFound()
	}
	log := s.log.With("request_id", httpx.RequestID(c), "source_id", src.ID)
	ctx := c.Context()
	mk := func(abs string) string { return "/api/v1/stream/" + token + "/" + s.online.urls.ref(src.ID, abs) }

	if name == "" || name == "index.m3u8" || name == "video.mp4" {
		st, err := s.upstream(ctx, src, false)
		if err != nil {
			return streamUnavailable()
		}
		if st.Format != "hls" {
			// MP4: Range pass-through; an expired/IP-mismatched URL (403/410)
			// is re-resolved once.
			reresolve := func() (*sources.Stream, error) { return s.upstream(ctx, src, true) }
			return h.proxyUpstreamRetry(c, src, st.URL, st.Headers, mk, log, reresolve)
		}
		body, final, status, err := fetchPlaylist(ctx, s.online.hc, st.URL, st.Headers)
		if err != nil || status != http.StatusOK {
			// Expired or rotated upstream URL: resolve again once.
			log.Info("online playlist failed, re-resolving", "status", status, "err", errString(err))
			if st, err = s.upstream(ctx, src, true); err != nil {
				return streamUnavailable()
			}
			body, final, status, err = fetchPlaylist(ctx, s.online.hc, st.URL, st.Headers)
			if err != nil || status != http.StatusOK {
				log.Warn("online playlist unavailable", "status", status, "err", errString(err))
				return streamUnavailable()
			}
		}
		if st.AudioTrack > 0 {
			body = keepAudio(body, st.AudioTrack) // one voice per variant (old TVs can't switch tracks)
		}
		out, err := rewritePlaylist(body, final, mk)
		if err != nil {
			log.Warn("online playlist invalid", "err", err)
			return streamUnavailable()
		}
		c.Set(fiber.HeaderContentType, hlsMime)
		if c.Method() == fiber.MethodHead {
			c.Response().Header.SetContentLength(len(out))
			c.Response().SkipBody = true
			return nil
		}
		return c.Send(out)
	}

	u, err := s.online.urls.open(src.ID, name)
	if err != nil {
		return httpx.NewError(fiber.StatusForbidden, "invalid_stream_url", "The stream link is invalid.")
	}
	st, _ := s.online.cached(src.ID)
	var headers map[string]string
	if st != nil {
		headers = st.Headers
	}
	return h.proxyUpstream(c, src, u, headers, mk, log)
}

func streamUnavailable() error {
	return httpx.NewError(fiber.StatusBadGateway, "stream_unavailable", "The online stream is unavailable.")
}

// proxyUpstream fetches one upstream URL: playlists are rewritten, anything
// else (segments, keys, MP4) is streamed with Range pass-through.
func (h *Handlers) proxyUpstream(c fiber.Ctx, src *source, u string, headers map[string]string, mk func(string) string, log *slog.Logger) error {
	return h.proxyUpstreamRetry(c, src, u, headers, mk, log, nil)
}

// proxyUpstreamRetry is proxyUpstream that, when reresolve is set, resolves
// the stream again once after an upstream 403/410 and retries with the new
// URL (signed CDN URLs expire or are bound to the resolver's IP).
func (h *Handlers) proxyUpstreamRetry(c fiber.Ctx, src *source, u string, headers map[string]string, mk func(string) string, log *slog.Logger,
	reresolve func() (*sources.Stream, error)) error {
	s := h.svc
	method := http.MethodGet
	if c.Method() == fiber.MethodHead {
		method = http.MethodHead
	}
	var (
		ctx    context.Context
		cancel context.CancelFunc
		resp   *http.Response
	)
	for attempt := 0; ; attempt++ {
		ctx, cancel = context.WithCancel(context.Background())
		req, err := http.NewRequestWithContext(ctx, method, u, nil)
		if err != nil {
			cancel()
			return streamUnavailable()
		}
		setUpstreamHeaders(req, headers)
		for _, k := range []string{fiber.HeaderRange, fiber.HeaderIfRange} {
			if v := c.Get(k); v != "" {
				req.Header.Set(k, v)
			}
		}
		resp, err = s.online.hc.Do(req)
		if err != nil {
			cancel()
			log.Warn("online upstream failed", "err", err)
			return streamUnavailable()
		}
		if attempt == 0 && reresolve != nil && (resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusGone) {
			resp.Body.Close()
			cancel()
			log.Info("online upstream expired, re-resolving", "status", resp.StatusCode)
			st, err := reresolve()
			if err != nil {
				return streamUnavailable()
			}
			u, headers = st.URL, st.Headers
			continue
		}
		break
	}
	switch resp.StatusCode {
	case http.StatusOK, http.StatusPartialContent, http.StatusRequestedRangeNotSatisfiable:
	case http.StatusNotFound:
		resp.Body.Close()
		cancel()
		return httpx.NotFound()
	default:
		resp.Body.Close()
		cancel()
		if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusGone {
			s.online.forget(src.ID) // the next playlist request re-resolves
		}
		log.Info("online upstream status", "status", resp.StatusCode)
		return streamUnavailable()
	}

	if resp.StatusCode == http.StatusOK && isPlaylist(resp.Header.Get("Content-Type"), resp.Request.URL.String()) {
		defer cancel()
		defer resp.Body.Close()
		c.Set(fiber.HeaderContentType, hlsMime)
		if method == http.MethodHead {
			return nil
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, maxPlaylistBytes+1))
		if err != nil || len(b) > maxPlaylistBytes {
			return streamUnavailable()
		}
		out, err := rewritePlaylist(b, resp.Request.URL, mk)
		if err != nil {
			return streamUnavailable()
		}
		return c.Send(out)
	}

	c.Status(resp.StatusCode)
	for _, k := range []string{"Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(k); v != "" {
			c.Set(k, v)
		}
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" || strings.HasPrefix(ct, "text/html") {
		ct = "application/octet-stream"
	}
	c.Set(fiber.HeaderContentType, ct)
	if method == http.MethodHead || resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		if resp.ContentLength >= 0 && method == http.MethodHead {
			c.Response().Header.SetContentLength(int(resp.ContentLength))
			c.Response().SkipBody = true
		}
		resp.Body.Close()
		cancel()
		return nil
	}
	body := newIdleReader(resp.Body, cancel, s.t.StreamIdle, newStreamMeta(c, log, "online"))
	size := -1
	if resp.ContentLength >= 0 && resp.ContentLength <= int64(^uint(0)>>1) {
		size = int(resp.ContentLength)
	}
	return c.SendStream(body, size)
}

// ---------------------------------------------------------------- store

func (st *store) upsertOnline(ctx context.Context, s *source, state onlineState) (*source, error) {
	rel, _ := json.Marshal(s.Release)
	ref, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	return scanSource(st.q.QueryRow(ctx, `INSERT INTO playback_sources
		(kind, provider, online_ref, media_id, episode_id, release_id, release, status, created_by_user_id, device_id,
		 profile_id, ready_at)
		VALUES ('online', $1, $2, $3, $4, $5, $6, 'ready', $7, $8, $9, now())
		ON CONFLICT (created_by_user_id, release_id, episode_id) WHERE kind = 'online' DO UPDATE SET
			provider = EXCLUDED.provider, online_ref = EXCLUDED.online_ref, release = EXCLUDED.release,
			status = 'ready', error_code = NULL, device_id = COALESCE(EXCLUDED.device_id, playback_sources.device_id),
			profile_id = COALESCE(EXCLUDED.profile_id, playback_sources.profile_id),
			ready_at = COALESCE(playback_sources.ready_at, now()), updated_at = now()
		RETURNING `+sourceCols,
		s.Provider, ref, s.MediaID, s.EpisodeID, s.ReleaseID, rel, s.CreatedByUserID, s.DeviceID, s.ProfileID))
}

func (st *store) setOnlineState(ctx context.Context, id string, state onlineState) error {
	ref, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = st.q.Exec(ctx, `UPDATE playback_sources SET online_ref = $2, updated_at = now() WHERE id = $1 AND kind = 'online'`, id, ref)
	return err
}
