package playback

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/httpx"
	"martytv/api/internal/livecheck"
	"martytv/api/internal/releases"
)

// Live (IPTV) playback: POST /playback/sources {kind: "iptv", channel_id}
// returns a ready, sourceless PlaybackSource whose stream_url is
//
//	/api/v1/live/<token>/index.m3u8   (HLS channels)
//	/api/v1/live/<token>/stream.ts    (plain MPEG-TS / HTTP channels)
//
// The token binds the channel id (its own HMAC label, 12 h). createLive
// opens the channel's URL (then its mirrors: other URLs of the same tvg-id)
// with short timeouts, so a dead channel fails in seconds with a cause
// (geo / offline / timeout / format) instead of a generic player error; the
// URL that worked is remembered per channel and its playlist serves the
// player's first request. The proxy asks the LiveProvider (internal/iptv)
// for the channel on every request and reuses the HLS machinery of hls.go:
// every playlist is fetched fresh and rewritten (live playlists slide) with
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
	// Mirrors are other URLs of the same channel (same tvg-id), tried in
	// order when URL fails.
	Mirrors []LiveMirror
	// VideoCodec / AudioCodec: what the last health check saw ("" = unknown).
	VideoCodec, AudioCodec string
}

// LiveMirror is an alternative stream URL of a channel.
type LiveMirror struct {
	URL     string
	Headers map[string]string
}

// LiveProvider resolves channels (implemented by internal/iptv).
type LiveProvider interface {
	// LiveChannel returns an active channel of an enabled playlist, or
	// ErrLiveNotFound.
	LiveChannel(ctx context.Context, id string) (*LiveChannel, error)
	// ReportLive records a stream success/failure (health; format when
	// known). cause is a livecheck cause when every URL of the channel just
	// failed to start ("" for other failures).
	ReportLive(ctx context.Context, id string, ok bool, format, cause string)
}

// ErrLiveNotFound: no such playable channel.
var ErrLiveNotFound = errors.New("channel not found")

// Live timeouts: a dead upstream must fail in seconds, not after the 15 s
// of VOD CDNs (people zap through channels).
const (
	liveDialTimeout   = 4 * time.Second
	liveHeaderTimeout = 6 * time.Second
	// liveStartBudget bounds trying the URL and its mirrors in createLive.
	liveStartBudget = 12 * time.Second
	// liveFailTTL: a channel whose URLs all just failed answers at once
	// with the same cause for this long (zapping back, client retries).
	liveFailTTL = 45 * time.Second
	// liveEntryTTL: createLive's fetched playlist serves the player's first
	// index.m3u8 request.
	liveEntryTTL = 10 * time.Second
	// liveStateTTL: per-channel decisions are forgotten after this.
	liveStateTTL = 6 * time.Hour
	// maxLiveTries: URLs tried per start (the channel's + its mirrors).
	maxLiveTries = 3
)

type liveDeps struct {
	provider LiveProvider
	hc       *http.Client // segments, nested playlists
	entry    *http.Client // entry playlists / probes: fail fast
	tokens   *signer
	urls     *urlSigner

	mu    sync.Mutex
	state map[string]*liveState // channel id → which URL works / the last failure
	long  map[string]longRef    // long upstream URLs by MAC (see ref)
}

// liveState is the per-channel decision: the URL that worked last (the
// channel's or a mirror's), a recent failure, the playlist just fetched.
type liveState struct {
	url        string
	failCause  string
	failedAt   time.Time
	entry      []byte
	entryFinal *url.URL
	entryAt    time.Time
	touched    time.Time
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
		entry:  newUpstreamClientT(allowPrivate, liveDialTimeout, liveHeaderTimeout),
		tokens: &signer{key: derive("martytv/playback/live-token/v1")},
		urls:   &urlSigner{key: derive("martytv/playback/live-url/v1")},
		state:  map[string]*liveState{}}
}

// SetLiveUpstreamClient replaces the live CDN clients (tests).
func (s *Service) SetLiveUpstreamClient(hc *http.Client) {
	if s.live != nil {
		s.live.hc, s.live.entry = hc, hc
	}
}

// liveCand is one URL of a channel with its headers.
type liveCand struct {
	url     string
	headers map[string]string
}

// candidates: the URL that worked last first, then the channel's URL, then
// its mirrors.
func (d *liveDeps) candidates(ch *LiveChannel) []liveCand {
	all := []liveCand{{ch.URL, ch.Headers}}
	for _, m := range ch.Mirrors {
		all = append(all, liveCand{m.URL, m.Headers})
	}
	d.mu.Lock()
	st := d.state[ch.ID]
	d.mu.Unlock()
	if st != nil && st.url != "" {
		for i, c := range all {
			if c.url == st.url && i > 0 {
				return append([]liveCand{c}, append(all[:i:i], all[i+1:]...)...)
			}
		}
	}
	return all
}

// current is the candidate the proxy plays: the remembered one, else the
// channel's own URL.
func (d *liveDeps) current(ch *LiveChannel) liveCand {
	return d.candidates(ch)[0]
}

func (d *liveDeps) update(id string, f func(*liveState)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := time.Now()
	st := d.state[id]
	if st == nil {
		st = &liveState{}
		d.state[id] = st
		if len(d.state) > 4096 { // bound memory: drop stale decisions
			for k, v := range d.state {
				if now.Sub(v.touched) > liveStateTTL {
					delete(d.state, k)
				}
			}
		}
	}
	st.touched = now
	f(st)
}

// recentFailure is the cause of a failure within liveFailTTL, or "".
func (d *liveDeps) recentFailure(id string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if st := d.state[id]; st != nil && st.failCause != "" && time.Since(st.failedAt) < liveFailTTL {
		return st.failCause
	}
	return ""
}

// takeEntry returns (once) the playlist createLive fetched from u.
func (d *liveDeps) takeEntry(id, u string) ([]byte, *url.URL) {
	d.mu.Lock()
	defer d.mu.Unlock()
	st := d.state[id]
	if st == nil || st.entry == nil || st.url != u || time.Since(st.entryAt) > liveEntryTTL {
		return nil, nil
	}
	b, f := st.entry, st.entryFinal
	st.entry, st.entryFinal = nil, nil
	return b, f
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
	// VideoCodec / AudioCodec (iptv): seen by the last health check, null if
	// unknown (h264, hevc, mpeg2 / aac, mp3, mp2, ac3, eac3).
	VideoCodec *string `json:"video_codec"`
	AudioCodec *string `json:"audio_codec"`
}

var errLiveUnavailable = &apiError{Status: 502, Code: "channel_unavailable", Msg: "The channel is not responding."}

// liveError maps a livecheck cause to the API error clients show:
// channel_geo_blocked, channel_timeout, channel_format_unsupported, else
// channel_unavailable (offline: DNS, 404, refused, 5xx).
func liveError(cause string) *apiError {
	switch r := livecheck.Failed(cause); {
	case cause == "not_stream" || cause == "dash" || strings.HasSuffix(cause, "not_playlist"):
		return &apiError{Status: 502, Code: "channel_format_unsupported", Msg: "The channel's stream format is not supported."}
	case r.Health == livecheck.HealthGeo:
		return &apiError{Status: 502, Code: "channel_geo_blocked", Msg: "The channel refuses this server (region or access restricted)."}
	case r.Health == livecheck.HealthTimeout:
		return &apiError{Status: 502, Code: "channel_timeout", Msg: "The channel is not responding."}
	}
	return &apiError{Status: 502, Code: "channel_unavailable", Msg: "The channel is offline."}
}

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
	if cause := s.live.recentFailure(ch.ID); cause != "" {
		return nil, liveError(cause)
	}
	format, err := s.startLive(ctx, ch, log)
	if err != nil {
		return nil, err
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
		Qualities: []int{}, Subtitles: []StreamSubtitle{}, VideoCodec: nonEmptyPtr(ch.VideoCodec), AudioCodec: nonEmptyPtr(ch.AudioCodec),
	}, nil
}

// startLive opens the channel's URLs in order (the one that worked last
// first) until one answers with a playlist or a TS stream, within
// liveStartBudget. It remembers the winner (and its playlist for the first
// index.m3u8) or the first URL's failure cause.
func (s *Service) startLive(ctx context.Context, ch *LiveChannel, log *slog.Logger) (string, error) {
	if _, err := upstreamURL(ch.URL); err != nil {
		return "", errLiveUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, liveStartBudget)
	defer cancel()
	firstCause := ""
	for i, c := range s.live.candidates(ch) {
		if i >= maxLiveTries || ctx.Err() != nil {
			break
		}
		if _, err := upstreamURL(c.url); err != nil {
			continue
		}
		format, body, final, cause := s.openLive(ctx, c)
		if cause == "" {
			s.live.update(ch.ID, func(st *liveState) {
				st.url, st.failCause = c.url, ""
				st.entry, st.entryFinal, st.entryAt = body, final, time.Now()
			})
			s.live.provider.ReportLive(context.WithoutCancel(ctx), ch.ID, true, format, "")
			if i > 0 {
				log.Info("live mirror used", "channel_id", ch.ID, "try", i+1)
			}
			return format, nil
		}
		log.Info("live start failed", "channel_id", ch.ID, "try", i+1, "cause", cause)
		if firstCause == "" {
			firstCause = cause
		}
	}
	if firstCause == "" {
		firstCause = "timeout"
	}
	s.live.update(ch.ID, func(st *liveState) { st.failCause, st.failedAt, st.entry = firstCause, time.Now(), nil })
	s.live.provider.ReportLive(context.WithoutCancel(ctx), ch.ID, false, "", firstCause)
	return "", liveError(firstCause)
}

// openLive GETs one URL with the fast client and says what it is: an HLS
// playlist (returned, for the first index.m3u8), an MPEG-TS stream, or a
// failure cause.
func (s *Service) openLive(ctx context.Context, c liveCand) (format string, body []byte, final *url.URL, cause string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
	if err != nil {
		return "", nil, nil, "bad_url"
	}
	setUpstreamHeaders(req, c.headers)
	resp, err := s.live.entry.Do(req)
	if err != nil {
		return "", nil, nil, livecheck.NetCause(ctx, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return "", nil, nil, livecheck.HTTPCause(resp.StatusCode)
	}
	br := bufio.NewReaderSize(resp.Body, 512)
	head, _ := br.Peek(376)
	f, err := sniffLive(resp.Header.Get("Content-Type"), head)
	if err != nil {
		return "", nil, nil, "not_stream"
	}
	if f != "hls" {
		return f, nil, nil, ""
	}
	b, err := io.ReadAll(io.LimitReader(br, maxPlaylistBytes+1))
	if err != nil || len(b) > maxPlaylistBytes || !looksLikePlaylist(b) {
		return "", nil, nil, "not_stream"
	}
	return "hls", b, resp.Request.URL, ""
}

func looksLikePlaylist(b []byte) bool {
	return bytes.HasPrefix(bytes.TrimLeft(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")), " \t\r\n"), []byte("#EXTM3U"))
}

func liveRelease(name string) releases.Release {
	return releases.Release{ID: "iptv", Title: name, Indexer: "IPTV", AudioCodecs: []string{}, Languages: []string{},
		Voiceovers: []releases.Voiceover{}, Seasons: []int{}, Episodes: []int{}, Confidence: 1, Reasons: []string{}, Warnings: []string{}}
}

func sniffLive(ct string, head []byte) (string, error) {
	t := bytes.TrimLeft(bytes.TrimPrefix(head, []byte("\xef\xbb\xbf")), " \t\r\n")
	ct = strings.ToLower(ct)
	switch {
	case bytes.HasPrefix(t, []byte("#EXTM3U")):
		return "hls", nil
	case strings.Contains(ct, "mpegurl") && !bytes.HasPrefix(t, []byte("<")):
		return "hls", nil
	case len(head) > 0 && head[0] == 0x47, strings.HasPrefix(ct, "video/") && !bytes.HasPrefix(t, []byte("<")):
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
	mk := func(abs string) string { return "/api/v1/live/" + token + "/" + s.live.ref(id, abs) }
	cur := s.live.current(ch)

	switch name {
	case "index.m3u8":
		body, final := s.live.takeEntry(id, cur.url)
		if body == nil {
			var status int
			body, final, status, err = fetchPlaylist(ctx, s.live.entry, cur.url, cur.headers)
			if err != nil || status != http.StatusOK {
				log.Info("live playlist failed", "status", status, "err", errString(err))
				s.live.provider.ReportLive(context.WithoutCancel(ctx), id, false, "", "")
				return liveUnavailable()
			}
		}
		out, err := rewritePlaylist(body, final, mk)
		if err != nil {
			log.Info("live playlist invalid", "err", err)
			s.live.provider.ReportLive(context.WithoutCancel(ctx), id, false, "", "")
			return liveUnavailable()
		}
		return sendLivePlaylist(c, out)
	case "stream.ts":
		return h.liveProxy(c, id, cur.url, cur.headers, mk, log, true)
	}
	u, err := s.live.open(id, name)
	if err != nil {
		return httpx.NewError(fiber.StatusForbidden, "invalid_stream_url", "The stream link is invalid.")
	}
	return h.liveProxy(c, id, u, cur.headers, mk, log, false)
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
// channel unhealthy on failure (the TS entry point).
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
	hc := s.live.hc
	if report {
		hc = s.live.entry
	}
	resp, err := hc.Do(req)
	if err != nil {
		cancel()
		log.Info("live upstream failed", "err", err)
		if report {
			s.live.provider.ReportLive(context.WithoutCancel(c.Context()), channelID, false, "", "")
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
			s.live.provider.ReportLive(context.WithoutCancel(c.Context()), channelID, false, "", "")
		}
		if resp.StatusCode == http.StatusNotFound {
			return httpx.NotFound()
		}
		return liveUnavailable()
	}
	// Nested playlists are recognised by type, extension or content: some
	// servers send variant playlists as text/plain or octet-stream without
	// .m3u8 — passed through un-rewritten they broke hls.js (raw upstream
	// URIs, mislabelled video/mp2t).
	// A 206 to a request without Range is the whole body too.
	whole := resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusPartialContent && c.Get(fiber.HeaderRange) == ""
	br := bufio.NewReaderSize(resp.Body, 512)
	var head []byte
	if whole && method == http.MethodGet {
		head, _ = br.Peek(16)
	}
	if whole && (isPlaylist(resp.Header.Get("Content-Type"), resp.Request.URL.String()) || looksLikePlaylist(head)) {
		defer cancel()
		defer resp.Body.Close()
		if method == http.MethodHead {
			c.Set(fiber.HeaderContentType, hlsMime)
			c.Set(fiber.HeaderCacheControl, "no-cache, no-store, must-revalidate")
			return nil
		}
		b, err := io.ReadAll(io.LimitReader(br, maxPlaylistBytes+1))
		if err != nil || len(b) > maxPlaylistBytes {
			return liveUnavailable()
		}
		out, err := rewritePlaylist(b, resp.Request.URL, mk)
		if err != nil {
			return liveUnavailable()
		}
		return sendLivePlaylist(c, out)
	}
	c.Status(resp.StatusCode)
	for _, k := range []string{"Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(k); v != "" {
			c.Set(k, v)
		}
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" || strings.HasPrefix(ct, "text/") || strings.HasPrefix(ct, "application/octet-stream") || strings.HasPrefix(ct, "binary/") {
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
	body := newIdleReader(readCloser{br, resp.Body}, cancel, s.t.StreamIdle, newStreamMeta(c, log, "live"))
	size := -1
	if resp.ContentLength >= 0 && resp.ContentLength <= int64(^uint(0)>>1) {
		size = int(resp.ContentLength)
	}
	return c.SendStream(body, size)
}

// readCloser reads through r (a bufio.Reader over c) and closes c.
type readCloser struct {
	r io.Reader
	c io.Closer
}

func (rc readCloser) Read(p []byte) (int, error) { return rc.r.Read(p) }
func (rc readCloser) Close() error               { return rc.c.Close() }

// ---------------------------------------------------------------- long URLs

// Upstream URLs longer than liveInlineURL (Pluto TV & co. put a ~2 KB JWT
// in every playlist and segment URL) don't fit a request line (the server
// reads ≤ 4 KB of headers; refs were capped at 2 KB and answered 403): they
// are kept server-side for longRefTTL and the path carries only their MAC
// ("~<mac>.<ext>").
const (
	liveInlineURL = 1024
	longRefTTL    = time.Hour
	maxLongRefs   = 50000
	maxLongURL    = 16 << 10
)

type longRef struct {
	url string
	at  time.Time
}

func (d *liveDeps) ref(id, abs string) string {
	if len(abs) <= liveInlineURL || len(abs) > maxLongURL {
		return d.urls.ref(id, abs)
	}
	key := base64.RawURLEncoding.EncodeToString(d.urls.mac(id, abs))
	now := time.Now()
	d.mu.Lock()
	if d.long == nil {
		d.long = map[string]longRef{}
	}
	if len(d.long) >= maxLongRefs {
		for k, v := range d.long {
			if now.Sub(v.at) > longRefTTL/4 {
				delete(d.long, k)
			}
		}
	}
	d.long[key] = longRef{abs, now}
	d.mu.Unlock()
	return "~" + key + "." + refExt(abs)
}

func (d *liveDeps) open(id, name string) (string, error) {
	if !strings.HasPrefix(name, "~") {
		return d.urls.open(id, name)
	}
	key, _, _ := strings.Cut(name[1:], ".")
	sum, err := base64.RawURLEncoding.DecodeString(key)
	if err != nil {
		return "", errBadProxyRef
	}
	d.mu.Lock()
	r, ok := d.long[key]
	if ok && time.Since(r.at) > longRefTTL {
		delete(d.long, key)
		ok = false
	}
	if ok {
		d.long[key] = longRef{r.url, time.Now()}
	}
	d.mu.Unlock()
	if !ok || !hmac.Equal(sum, d.urls.mac(id, r.url)) {
		return "", errBadProxyRef
	}
	if _, err := upstreamURL(r.url); err != nil {
		return "", err
	}
	return r.url, nil
}
