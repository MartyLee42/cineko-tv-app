package playback

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/httpx"
	"martytv/api/internal/releases"
)

// Live (IPTV) playback: POST /playback/sources {kind: "iptv", channel_id}
// returns a ready, sourceless PlaybackSource whose stream_url is
//
//	/api/v1/live/<token>/index.m3u8   (HLS channels)
//	/api/v1/live/<token>/stream.ts    (plain MPEG-TS / HTTP channels)
//
// The token binds the channel id (its own HMAC label, 12 h). The proxy asks
// the LiveProvider (internal/iptv) for the channel's upstream URL and
// headers on every request and reuses the HLS machinery of hls.go: every
// playlist is fetched fresh and rewritten (live playlists slide) with
// "no-cache", nested URIs become signed refs bound to the channel id, and
// segments / TS bytes stream through the idle-guarded reader. Nothing is
// stored: no playback_sources row, no progress, no duration.

// LiveChannel is what the proxy needs to play a channel.
type LiveChannel struct {
	ID      string
	Name    string
	URL     string
	Headers map[string]string // User-Agent / Referer from #EXTVLCOPT or the playlist
	Format  string            // "hls", "ts" or "" (unknown until probed)
}

// LiveProvider resolves channels (implemented by internal/iptv).
type LiveProvider interface {
	// LiveChannel returns an active channel of an enabled playlist, or
	// ErrLiveNotFound.
	LiveChannel(ctx context.Context, id string) (*LiveChannel, error)
	// ReportLive records a stream success/failure (health; format when known).
	ReportLive(ctx context.Context, id string, ok bool, format string)
}

// ErrLiveNotFound: no such playable channel.
var ErrLiveNotFound = errors.New("channel not found")

type liveDeps struct {
	provider LiveProvider
	hc       *http.Client
	tokens   *signer
	urls     *urlSigner
}

// SetLive enables IPTV playback (wired in server.New). allowPrivate lets
// channels point at LAN addresses (IPTV_ALLOW_PRIVATE).
func (s *Service) SetLive(p LiveProvider, allowPrivate bool) {
	derive := func(label string) []byte {
		m := hmac.New(sha256.New, s.cfg.SessionSecret)
		m.Write([]byte(label))
		return m.Sum(nil)
	}
	s.live = &liveDeps{provider: p, hc: newUpstreamClient(allowPrivate),
		tokens: &signer{key: derive("martytv/playback/live-token/v1")},
		urls:   &urlSigner{key: derive("martytv/playback/live-url/v1")}}
}

// SetLiveUpstreamClient replaces the live CDN client (tests).
func (s *Service) SetLiveUpstreamClient(hc *http.Client) {
	if s.live != nil {
		s.live.hc = hc
	}
}

// LiveSource is the PlaybackSource of a live channel (kind iptv).
type LiveSource struct {
	ID              string           `json:"id"`
	MediaID         *string          `json:"media_id"`
	EpisodeID       *string          `json:"episode_id"`
	Release         releases.Release `json:"release"`
	Status          string           `json:"status"`
	Error           *string          `json:"error"`
	File            *TorrentFile     `json:"file"`
	StreamURL       string           `json:"stream_url"`
	StreamExpiresAt time.Time        `json:"stream_expires_at"`
	CompatURL       *string          `json:"compat_url"`
	MimeType        string           `json:"mime_type"`
	MediaInfo       *MediaInfo       `json:"media_info"`
	Torrent         *TorrentStats    `json:"torrent"`
	CreatedAt       time.Time        `json:"created_at"`
	Kind            string           `json:"kind"`
	Live            bool             `json:"live"`
	ChannelID       string           `json:"channel_id"`
	Provider        *ProviderRef     `json:"provider"`
	Format          string           `json:"format"`
	Quality         *int             `json:"quality"`
	Qualities       []int            `json:"qualities"`
	Subtitles       []StreamSubtitle `json:"subtitles"`
}

var errLiveUnavailable = &apiError{Status: 502, Code: "channel_unavailable", Msg: "The channel is not responding."}

// createLive is Create for {kind: "iptv"}.
func (s *Service) createLive(ctx context.Context, who caller, channelID string, profileID *string, log *slog.Logger) (*LiveSource, error) {
	notFound := &apiError{Status: 404, Code: "not_found", Msg: "Channel not found."}
	if s.live == nil {
		return nil, notFound
	}
	if profileID != nil {
		ok, err := s.st.profileAccessible(ctx, *profileID, who.UserID, who.DeviceID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, validation("profile_id", "Unknown profile.")
		}
	}
	ch, err := s.live.provider.LiveChannel(ctx, channelID)
	if errors.Is(err, ErrLiveNotFound) {
		return nil, notFound
	}
	if err != nil {
		return nil, err
	}
	if _, err := upstreamURL(ch.URL); err != nil {
		return nil, errLiveUnavailable
	}
	format := ch.Format
	if format == "" {
		format = guessLiveFormat(ch.URL)
	}
	if format == "" {
		f, err := s.probeLive(ctx, ch)
		if err != nil {
			log.Info("live probe failed", "channel_id", ch.ID, "err", errString(err))
			s.live.provider.ReportLive(context.WithoutCancel(ctx), ch.ID, false, "")
			return nil, errLiveUnavailable
		}
		format = f
		s.live.provider.ReportLive(context.WithoutCancel(ctx), ch.ID, true, f)
	}
	exp := time.Now().Add(s.t.TokenTTL).UTC().Truncate(time.Second)
	tok, err := s.live.tokens.Sign(ch.ID, exp)
	if err != nil {
		return nil, err
	}
	u, mime := "/api/v1/live/"+tok+"/index.m3u8", hlsMime
	if format == "ts" {
		u, mime = "/api/v1/live/"+tok+"/stream.ts", "video/mp2t"
	}
	log.Info("playback source", "kind", "iptv", "channel_id", ch.ID, "format", format)
	return &LiveSource{
		ID: uuid.NewString(), Release: liveRelease(ch.Name), Status: "ready", StreamURL: u, StreamExpiresAt: exp,
		MimeType: mime, CreatedAt: time.Now().UTC(), Kind: "iptv", Live: true, ChannelID: ch.ID, Format: format,
		Qualities: []int{}, Subtitles: []StreamSubtitle{},
	}, nil
}

func liveRelease(name string) releases.Release {
	return releases.Release{ID: "iptv", Title: name, Indexer: "IPTV", AudioCodecs: []string{}, Languages: []string{},
		Voiceovers: []releases.Voiceover{}, Seasons: []int{}, Episodes: []int{}, Confidence: 1, Reasons: []string{}, Warnings: []string{}}
}

// guessLiveFormat decides by the URL path when it is obvious.
func guessLiveFormat(u string) string {
	p := strings.ToLower(pathOf(u))
	switch {
	case strings.HasSuffix(p, ".m3u8"), strings.HasSuffix(p, ".m3u"):
		return "hls"
	case strings.HasSuffix(p, ".ts"), strings.HasSuffix(p, ".mpg"), strings.HasSuffix(p, ".mpeg"), strings.Contains(p, "/udp/"), strings.Contains(p, "/rtp/"):
		return "ts"
	}
	return ""
}

// probeLive opens the stream briefly and sniffs it: a playlist → hls,
// MPEG-TS sync bytes or a video/* type → ts.
func (s *Service) probeLive(ctx context.Context, ch *LiveChannel) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ch.URL, nil)
	if err != nil {
		return "", err
	}
	setUpstreamHeaders(req, ch.Headers)
	resp, err := s.live.hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", errors.New("upstream status " + http.StatusText(resp.StatusCode))
	}
	head := make([]byte, 376)
	n, _ := io.ReadFull(resp.Body, head)
	head = head[:n]
	return sniffLive(resp.Header.Get("Content-Type"), head)
}

func sniffLive(ct string, head []byte) (string, error) {
	t := bytes.TrimLeft(bytes.TrimPrefix(head, []byte("\xef\xbb\xbf")), " \t\r\n")
	switch {
	case bytes.HasPrefix(t, []byte("#EXTM3U")) || strings.Contains(strings.ToLower(ct), "mpegurl"):
		return "hls", nil
	case len(head) > 0 && head[0] == 0x47, strings.HasPrefix(ct, "video/"), strings.Contains(ct, "octet-stream") && len(head) > 0:
		return "ts", nil
	}
	return "", errors.New("unknown stream type")
}

// liveStream serves GET|HEAD /api/v1/live/<token>/<name>.
func (h *Handlers) liveStream(c fiber.Ctx) error {
	s := h.svc
	token := strings.Clone(c.Params("token"))
	name := strings.Clone(c.Params("name"))
	c.Path("/api/v1/live/-") // keep the capability out of request logs
	c.Set("X-Content-Type-Options", "nosniff")
	c.Set("Referrer-Policy", "no-referrer")
	c.Set(fiber.HeaderCacheControl, "no-store")
	if s.live == nil {
		return httpx.NotFound()
	}
	id, err := s.live.tokens.Verify(token, time.Now())
	if err != nil {
		code, msg := "invalid_stream_token", "The stream link is invalid."
		if errors.Is(err, errExpiredToken) {
			code, msg = "stream_token_expired", "The stream link has expired; start the channel again."
		}
		return httpx.NewError(fiber.StatusForbidden, code, msg)
	}
	ctx := c.Context()
	ch, err := s.live.provider.LiveChannel(ctx, id)
	if errors.Is(err, ErrLiveNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	log := s.log.With("request_id", httpx.RequestID(c), "channel_id", id)
	mk := func(abs string) string { return "/api/v1/live/" + token + "/" + s.live.urls.ref(id, abs) }

	switch name {
	case "index.m3u8":
		body, final, status, err := fetchPlaylist(ctx, s.live.hc, ch.URL, ch.Headers)
		if err != nil || status != http.StatusOK {
			log.Info("live playlist failed", "status", status, "err", errString(err))
			s.live.provider.ReportLive(context.WithoutCancel(ctx), id, false, "")
			return liveUnavailable()
		}
		out, err := rewritePlaylist(body, final, mk)
		if err != nil {
			log.Info("live playlist invalid", "err", err)
			s.live.provider.ReportLive(context.WithoutCancel(ctx), id, false, "")
			return liveUnavailable()
		}
		s.live.provider.ReportLive(context.WithoutCancel(ctx), id, true, "hls")
		return sendLivePlaylist(c, out)
	case "stream.ts":
		return h.liveProxy(c, id, ch.URL, ch.Headers, mk, log, true)
	}
	u, err := s.live.urls.open(id, name)
	if err != nil {
		return httpx.NewError(fiber.StatusForbidden, "invalid_stream_url", "The stream link is invalid.")
	}
	return h.liveProxy(c, id, u, ch.Headers, mk, log, false)
}

func liveUnavailable() error {
	return httpx.NewError(fiber.StatusBadGateway, "stream_unavailable", "The channel is not responding.")
}

// sendLivePlaylist answers a rewritten (sliding) playlist: never cached.
func sendLivePlaylist(c fiber.Ctx, out []byte) error {
	c.Set(fiber.HeaderContentType, hlsMime)
	c.Set(fiber.HeaderCacheControl, "no-cache, no-store, must-revalidate")
	c.Set("Pragma", "no-cache")
	c.Set("Expires", "0")
	if c.Method() == fiber.MethodHead {
		c.Response().Header.SetContentLength(len(out))
		c.Response().SkipBody = true
		return nil
	}
	return c.Send(out)
}

// liveProxy fetches one upstream URL of a live channel: playlists (variant
// or media) are rewritten fresh on every request; segments, keys and plain
// TS streams are streamed through without buffering. report marks the
// channel healthy/unhealthy (the TS entry point).
func (h *Handlers) liveProxy(c fiber.Ctx, channelID, u string, headers map[string]string, mk func(string) string, log *slog.Logger, report bool) error {
	s := h.svc
	method := http.MethodGet
	if c.Method() == fiber.MethodHead {
		method = http.MethodHead
	}
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		cancel()
		return liveUnavailable()
	}
	setUpstreamHeaders(req, headers)
	for _, k := range []string{fiber.HeaderRange, fiber.HeaderIfRange} {
		if v := c.Get(k); v != "" {
			req.Header.Set(k, v)
		}
	}
	resp, err := s.live.hc.Do(req)
	if err != nil {
		cancel()
		log.Info("live upstream failed", "err", err)
		if report {
			s.live.provider.ReportLive(context.WithoutCancel(c.Context()), channelID, false, "")
		}
		return liveUnavailable()
	}
	switch resp.StatusCode {
	case http.StatusOK, http.StatusPartialContent, http.StatusRequestedRangeNotSatisfiable:
	default:
		resp.Body.Close()
		cancel()
		log.Info("live upstream status", "status", resp.StatusCode)
		if report {
			s.live.provider.ReportLive(context.WithoutCancel(c.Context()), channelID, false, "")
		}
		if resp.StatusCode == http.StatusNotFound {
			return httpx.NotFound()
		}
		return liveUnavailable()
	}
	if resp.StatusCode == http.StatusOK && isPlaylist(resp.Header.Get("Content-Type"), resp.Request.URL.String()) {
		defer cancel()
		defer resp.Body.Close()
		if method == http.MethodHead {
			c.Set(fiber.HeaderContentType, hlsMime)
			c.Set(fiber.HeaderCacheControl, "no-cache, no-store, must-revalidate")
			return nil
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, maxPlaylistBytes+1))
		if err != nil || len(b) > maxPlaylistBytes {
			return liveUnavailable()
		}
		out, err := rewritePlaylist(b, resp.Request.URL, mk)
		if err != nil {
			return liveUnavailable()
		}
		return sendLivePlaylist(c, out)
	}
	if report {
		s.live.provider.ReportLive(context.WithoutCancel(c.Context()), channelID, true, "ts")
	}
	c.Status(resp.StatusCode)
	for _, k := range []string{"Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(k); v != "" {
			c.Set(k, v)
		}
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" || strings.HasPrefix(ct, "text/") || strings.HasPrefix(ct, "application/octet-stream") {
		ct = "video/mp2t"
		if p := strings.ToLower(pathOf(u)); strings.HasSuffix(p, ".aac") {
			ct = "audio/aac"
		} else if strings.HasSuffix(p, ".mp4") || strings.HasSuffix(p, ".m4s") {
			ct = "video/mp4"
		}
	}
	c.Set(fiber.HeaderContentType, ct)
	if method == http.MethodHead || resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		resp.Body.Close()
		cancel()
		return nil
	}
	body := newIdleReader(resp.Body, cancel, s.t.StreamIdle, newStreamMeta(c, log, "live"))
	size := -1
	if resp.ContentLength >= 0 && resp.ContentLength <= int64(^uint(0)>>1) {
		size = int(resp.ContentLength)
	}
	return c.SendStream(body, size)
}
