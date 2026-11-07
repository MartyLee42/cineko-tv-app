package playback

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/httpx"
	"martytv/api/internal/releases"
)

// YouTube playback (the «Видео» tab, internal/video): POST /playback/sources
// {kind: "video", video_id, quality?, profile_id?} returns a ready source
// whose stream_url is
//
//	/api/v1/vstream/<token>/master.m3u8   (HLS built from DASH: video_hls.go)
//
// and fallback_url the progressive MP4 (itag 18, 360p) when YouTube has one:
//
//	/api/v1/vstream/<token>/p18.mp4
//
// The token binds the video id and the quality cap (its own HMAC label,
// TokenTTL). Every byte is fetched from the Invidious instance (local=true
// stream URLs: Invidious relays googlevideo through the VPN); the proxy
// only ever requests URLs the VideoProvider returned for that video, on the
// Invidious origin, and refuses anything else (no open proxy). Nothing is
// stored here: resume positions are internal/video's video_progress.

// VideoTrack is one YouTube format (adaptive or progressive).
type VideoTrack struct {
	Itag      int
	Width     int
	Height    int // 0 for audio
	FPS       int
	Bandwidth int64
	Codecs    string // avc1.4D401F / mp4a.40.2
	Mime      string // video/mp4, audio/mp4
	URL       string // absolute, on the Invidious origin
	InitEnd   int64  // init segment = bytes [0, InitEnd]; adaptive only
	IndexFrom int64  // sidx = bytes [IndexFrom, IndexTo]; adaptive only
	IndexTo   int64
	Size      int64 // content length (0 = unknown)
}

// VideoCaption is a subtitle track (VTT from Invidious /api/v1/captions).
type VideoCaption struct {
	Label    string
	Language string
	URL      string // absolute, on the Invidious origin
}

// VideoStreams is a video's playable formats.
type VideoStreams struct {
	ID          string
	Title       string
	Duration    float64
	Live        bool           // live / premiere: not playable (DASH live)
	Video       []VideoTrack   // adaptive H.264 fMP4 with init+index ranges
	Audio       []VideoTrack   // adaptive AAC fMP4
	Progressive []VideoTrack   // muxed MP4 (itag 18 / 22)
	Captions    []VideoCaption // in Invidious order
}

// VideoProvider is implemented by internal/video.
type VideoProvider interface {
	// VideoStreams returns the formats of a video (cached; fresh=true
	// refetches after the upstream rejected a stale URL). ErrVideoNotFound
	// for unknown/removed videos; ErrVideoUnavailable when Invidious is down
	// or not configured.
	VideoStreams(ctx context.Context, videoID string, fresh bool) (*VideoStreams, error)
	// VideoQuality is the profile's quality cap (video_quality, default 720).
	VideoQuality(ctx context.Context, profileID *string) int
	// VideoResume is the saved position of an unfinished video (0 = none).
	VideoResume(ctx context.Context, profileID, videoID string) float64
	// VideoHTTP is the client for the Invidious origin.
	VideoHTTP() *http.Client
	// VideoOrigin reports whether u is on the Invidious origin.
	VideoOrigin(u *url.URL) bool
}

var (
	ErrVideoNotFound    = errors.New("video not found")
	ErrVideoUnavailable = errors.New("video service unavailable")
)

type videoDeps struct {
	p      VideoProvider
	tokens *videoSigner

	mu       sync.Mutex
	sidx     map[string]sidxCached    // id|itag|size → fragments
	inflight map[string]chan struct{} // sidx fetches under way (one per key)
}

type sidxCached struct {
	segs []sidxSegment
	init []byte // the init segment, bytes [0, InitEnd], when fetched with the sidx
	at   time.Time
}

const (
	maxSidxCached  = 300
	maxSidxBytes   = 1 << 20
	maxInitBytes   = 512 << 10
	videoMaxRedirs = 3
)

// SetVideo enables YouTube playback (wired in server.New).
func (s *Service) SetVideo(p VideoProvider) {
	m := hmac.New(sha256.New, s.cfg.SessionSecret)
	m.Write([]byte("martytv/playback/video-token/v1"))
	s.video = &videoDeps{p: p, tokens: &videoSigner{key: m.Sum(nil)}, sidx: map[string]sidxCached{}, inflight: map[string]chan struct{}{}}
}

// ---- token: base64url(0x02 | id (11) | quality (2) | exp (8) | HMAC (32)) ----

type videoSigner struct{ key []byte }

const videoTokenVersion = 2

var videoIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

func (v *videoSigner) mac(b []byte) []byte {
	m := hmac.New(sha256.New, v.key)
	m.Write(b)
	return m.Sum(nil)
}

func (v *videoSigner) Sign(id string, quality int, exp time.Time) (string, error) {
	if !videoIDPattern.MatchString(id) || quality < 0 || quality > 0xffff {
		return "", errBadToken
	}
	buf := make([]byte, 0, 1+11+2+8+32)
	buf = append(buf, videoTokenVersion)
	buf = append(buf, id...)
	buf = binary.BigEndian.AppendUint16(buf, uint16(quality))
	buf = binary.BigEndian.AppendUint64(buf, uint64(exp.Unix()))
	buf = append(buf, v.mac(buf)...)
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func (v *videoSigner) Verify(tok string, now time.Time) (string, int, error) {
	if len(tok) > 128 {
		return "", 0, errBadToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil || len(raw) != 1+11+2+8+32 || raw[0] != videoTokenVersion {
		return "", 0, errBadToken
	}
	payload, sum := raw[:22], raw[22:]
	if !hmac.Equal(sum, v.mac(payload)) {
		return "", 0, errBadToken
	}
	if now.Unix() >= int64(binary.BigEndian.Uint64(payload[14:22])) {
		return "", 0, errExpiredToken
	}
	id := string(payload[1:12])
	if !videoIDPattern.MatchString(id) {
		return "", 0, errBadToken
	}
	return id, int(binary.BigEndian.Uint16(payload[12:14])), nil
}

// VideoSource is the PlaybackSource of a YouTube video (kind video).
type VideoSource struct {
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
	Provider        *ProviderRef     `json:"provider"`
	Format          string           `json:"format"`
	Quality         *int             `json:"quality"`
	Qualities       []int            `json:"qualities"`
	Subtitles       []StreamSubtitle `json:"subtitles"`
	DurationSeconds *float64         `json:"duration_seconds"`
	VideoID         string           `json:"video_id"`
	FallbackURL     *string          `json:"fallback_url"`
	PositionSeconds *float64         `json:"position_seconds"`
}

// maxVideoHeight caps every request (the task: 480/720/1080).
const maxVideoHeight = 1080

// createVideo handles POST /playback/sources {kind: "video"}.
func (h *Handlers) createVideo(c fiber.Ctx, in CreateInput) error {
	fields := map[string]string{}
	if in.VideoID == nil || !videoIDPattern.MatchString(*in.VideoID) {
		fields["video_id"] = "Required, an 11-character YouTube video id."
	}
	if in.ProfileID != nil && !validUUID(*in.ProfileID) {
		fields["profile_id"] = "Must be a UUID."
	}
	if in.Quality != nil && (*in.Quality < 0 || *in.Quality > 4320) {
		fields["quality"] = "A resolution height such as 720, or 0 for the profile default."
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	out, err := h.svc.createVideo(c.Context(), callerFrom(c), *in.VideoID, in.ProfileID, in.Quality, h.logger(c))
	if err != nil {
		return toHTTP(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.Status(fiber.StatusCreated).JSON(out)
}

var (
	errVideoNotFound    = &apiError{Status: 404, Code: "not_found", Msg: "Video not found."}
	errVideoUnavailable = &apiError{Status: 503, Code: "video_unavailable", Msg: "The video service is not responding."}
	errVideoLive        = &apiError{Status: 422, Code: "video_live_unsupported", Msg: "Live streams and premieres can't be played yet."}
	errVideoUnplayable  = &apiError{Status: 422, Code: "video_unplayable", Msg: "This video has no playable format."}
)

func videoErr(err error) error {
	switch {
	case errors.Is(err, ErrVideoNotFound):
		return errVideoNotFound
	case errors.Is(err, ErrVideoUnavailable):
		return errVideoUnavailable
	}
	return err
}

func (s *Service) createVideo(ctx context.Context, who caller, id string, profileID *string, quality *int, log *slog.Logger) (*VideoSource, error) {
	if s.video == nil {
		return nil, errVideoUnavailable
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
	vs, err := s.video.p.VideoStreams(ctx, id, false)
	if err != nil {
		return nil, videoErr(err)
	}
	if vs.Live {
		return nil, errVideoLive
	}
	q := 0
	if quality != nil {
		q = *quality
	}
	if q <= 0 {
		q = s.video.p.VideoQuality(ctx, profileID)
	}
	q = min(q, maxVideoHeight)
	exp := time.Now().Add(s.t.TokenTTL).UTC().Truncate(time.Second)
	tok, err := s.video.tokens.Sign(vs.ID, q, exp)
	if err != nil {
		return nil, err
	}
	base := "/api/v1/vstream/" + tok + "/"
	src := &VideoSource{
		ID: uuid.NewString(), Release: videoRelease(vs.Title), Status: "ready", StreamExpiresAt: exp,
		CreatedAt: time.Now().UTC(), Kind: "video", VideoID: vs.ID, Qualities: videoQualities(vs), Subtitles: []StreamSubtitle{},
		Provider: &ProviderRef{ID: "youtube", Name: "YouTube", Kind: "online"},
	}
	if vs.Duration > 0 {
		d := vs.Duration
		src.DurationSeconds = &d
	}
	var fallback *VideoTrack
	if p := pickVideoTrack(vs.Progressive, q); p != nil {
		fallback = p
		u := base + "p" + strconv.Itoa(p.Itag) + ".mp4"
		src.FallbackURL = &u
	}
	if v := pickVideoTrack(vs.Video, q); v != nil && len(vs.Audio) > 0 {
		h := v.Height
		src.Quality, src.Format, src.StreamURL, src.MimeType = &h, "hls", base+"master.m3u8", hlsMime
		// The player asks for the master, then both media playlists and
		// init segments one after another, each a round trip to YouTube:
		// fetch the two indexes (with their init segments) right away.
		go s.warmVideo(vs.ID, *v, vs.Audio[0])
	} else if fallback != nil {
		h := fallback.Height
		src.Quality, src.Format, src.StreamURL, src.MimeType = &h, "mp4", *src.FallbackURL, "video/mp4"
		src.FallbackURL = nil
	} else {
		return nil, errVideoUnplayable
	}
	for i, cc := range vs.Captions {
		if i >= 20 {
			break
		}
		lang, label := cc.Language, cc.Label
		src.Subtitles = append(src.Subtitles, StreamSubtitle{URL: base + "cc" + strconv.Itoa(i) + ".vtt", Lang: &lang, Label: &label})
	}
	if profileID != nil {
		if pos := s.video.p.VideoResume(ctx, *profileID, vs.ID); pos > 0 {
			src.PositionSeconds = &pos
		}
	}
	log.Info("playback source", "kind", "video", "video_id", vs.ID, "format", src.Format, "quality", *src.Quality)
	return src, nil
}

func videoRelease(title string) releases.Release {
	return releases.Release{ID: "video", Title: title, Indexer: "YouTube", AudioCodecs: []string{}, Languages: []string{},
		Voiceovers: []releases.Voiceover{}, Seasons: []int{}, Episodes: []int{}, Confidence: 1, Reasons: []string{}, Warnings: []string{}}
}

// videoQualities: playable heights ≤ 1080, descending.
func videoQualities(vs *VideoStreams) []int {
	seen := map[int]bool{}
	var out []int
	add := func(ts []VideoTrack) {
		for _, t := range ts {
			if t.Height > 0 && t.Height <= maxVideoHeight && !seen[t.Height] {
				seen[t.Height] = true
				out = append(out, t.Height)
			}
		}
	}
	if len(vs.Audio) > 0 {
		add(vs.Video)
	}
	add(vs.Progressive)
	slices.Sort(out)
	slices.Reverse(out)
	if out == nil {
		out = []int{}
	}
	return out
}

// ---- GET|HEAD /api/v1/vstream/<token>/<name> ----

var videoName = regexp.MustCompile(`^(master\.m3u8|([va])(\d{1,4})\.m3u8|([mp])(\d{1,4})\.mp4|cc(\d{1,2})\.vtt)$`)

func videoStreamError() error {
	return httpx.NewError(fiber.StatusBadGateway, "stream_unavailable", "The video is not responding.")
}

func (h *Handlers) videoStream(c fiber.Ctx) error {
	s := h.svc
	token := strings.Clone(c.Params("token"))
	name := strings.Clone(c.Params("name"))
	c.Path("/api/v1/vstream/-") // keep the capability out of request logs
	c.Set("X-Content-Type-Options", "nosniff")
	c.Set("Referrer-Policy", "no-referrer")
	if s.video == nil {
		return httpx.NotFound()
	}
	id, q, err := s.video.tokens.Verify(token, time.Now())
	if err != nil {
		code, msg := "invalid_stream_token", "The stream link is invalid."
		if errors.Is(err, errExpiredToken) {
			code, msg = "stream_token_expired", "The stream link has expired; start the video again."
		}
		return httpx.NewError(fiber.StatusForbidden, code, msg)
	}
	noteVideoStream()
	m := videoName.FindStringSubmatch(name)
	if m == nil {
		return httpx.NotFound()
	}
	ctx := c.Context()
	log := s.log.With("request_id", httpx.RequestID(c), "video_id", id)
	vs, err := s.video.p.VideoStreams(ctx, id, false)
	if err != nil {
		log.Info("video streams failed", "err", errString(err))
		if errors.Is(err, ErrVideoNotFound) {
			return httpx.NotFound()
		}
		return videoStreamError()
	}
	switch {
	case m[1] == "master.m3u8":
		v := pickVideoTrack(vs.Video, q)
		if v == nil || len(vs.Audio) == 0 {
			return httpx.NotFound()
		}
		return sendVODPlaylist(c, masterPlaylist(v, &vs.Audio[0]))
	case m[2] != "":
		itag, _ := strconv.Atoi(m[3])
		tracks := vs.Video
		if m[2] == "a" {
			tracks = vs.Audio
		}
		t := findTrack(tracks, itag)
		if t == nil || t.InitEnd <= 0 || t.IndexTo <= t.IndexFrom {
			return httpx.NotFound()
		}
		segs, err := s.videoSidx(ctx, id, *t, log)
		if err != nil {
			log.Info("video sidx failed", "itag", itag, "err", errString(err))
			return videoStreamError()
		}
		return sendVODPlaylist(c, mediaPlaylist("m"+strconv.Itoa(itag)+".mp4", t.InitEnd+1, segs))
	case m[4] != "":
		itag, _ := strconv.Atoi(m[5])
		var t *VideoTrack
		if m[4] == "m" {
			if t = findTrack(vs.Video, itag); t == nil {
				t = findTrack(vs.Audio, itag)
			}
		} else {
			t = findTrack(vs.Progressive, itag)
		}
		if t == nil {
			return httpx.NotFound()
		}
		return h.videoBytes(c, id, itag, m[4] == "p", *t, log)
	default:
		n, _ := strconv.Atoi(m[6])
		if n >= len(vs.Captions) {
			return httpx.NotFound()
		}
		return h.videoCaption(c, vs.Captions[n].URL, log)
	}
}

func findTrack(ts []VideoTrack, itag int) *VideoTrack {
	for i := range ts {
		if ts[i].Itag == itag {
			return &ts[i]
		}
	}
	return nil
}

// sendVODPlaylist answers a generated (static) playlist.
func sendVODPlaylist(c fiber.Ctx, b []byte) error {
	c.Set(fiber.HeaderContentType, hlsMime)
	c.Set(fiber.HeaderCacheControl, "private, max-age=300")
	if c.Method() == fiber.MethodHead {
		c.Response().Header.SetContentLength(len(b))
		c.Response().SkipBody = true
		return nil
	}
	return c.Send(b)
}

// videoGet requests an Invidious-origin URL, following same-origin
// redirects only. rng is a Range header value ("" = none).
func (s *Service) videoGet(ctx context.Context, method, u, rng string) (*http.Response, error) {
	for i := 0; ; i++ {
		pu, err := url.Parse(u)
		if err != nil || !s.video.p.VideoOrigin(pu) {
			return nil, errBlockedTarget
		}
		req, err := http.NewRequestWithContext(ctx, method, pu.String(), nil)
		if err != nil {
			return nil, err
		}
		if rng != "" {
			req.Header.Set(fiber.HeaderRange, rng)
		}
		resp, err := s.videoDo(ctx, req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode < 300 || resp.StatusCode >= 400 || resp.Header.Get("Location") == "" {
			return resp, nil
		}
		loc := resp.Header.Get("Location")
		resp.Body.Close()
		if i >= videoMaxRedirs {
			return nil, errors.New("too many redirects")
		}
		next, err := pu.Parse(loc)
		if err != nil {
			return nil, err
		}
		u = next.String()
	}
}

// videoDo sends req, retrying once when the upstream hasn't started
// answering within VideoHeaderWait: a stalled YouTube request usually
// answers at once on a fresh connection, instead of failing after
// upstreamTimeout.
func (s *Service) videoDo(ctx context.Context, req *http.Request) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		actx, cancel := context.WithCancel(ctx)
		timer := time.AfterFunc(s.t.VideoHeaderWait, cancel)
		resp, err := s.video.p.VideoHTTP().Do(req.Clone(actx))
		inTime := timer.Stop()
		if err == nil && inTime {
			resp.Body = &cancelBody{ReadCloser: resp.Body, cancel: cancel}
			return resp, nil
		}
		if resp != nil {
			resp.Body.Close()
		}
		cancel()
		if inTime || ctx.Err() != nil {
			return nil, err
		}
		if attempt > 0 {
			return nil, errors.New("upstream not answering")
		}
		s.log.Info("video upstream slow; retrying", "after", s.t.VideoHeaderWait)
	}
}

// staleStatus: googlevideo URLs expire or get rejected (403/410); refetch
// the video once and retry.
func staleStatus(code int) bool { return code == http.StatusForbidden || code == http.StatusGone }

func sidxKey(id string, t VideoTrack) string {
	return id + "|" + strconv.Itoa(t.Itag) + "|" + strconv.FormatInt(t.Size, 10)
}

// videoSidx fetches and parses a track's sidx (cached per id/itag/size).
func (s *Service) videoSidx(ctx context.Context, id string, t VideoTrack, log *slog.Logger) ([]sidxSegment, error) {
	c, err := s.videoIndex(ctx, id, t, log)
	return c.segs, err
}

// cachedInit is the track's init segment if a sidx fetch already brought it.
func (s *Service) cachedInit(id string, t VideoTrack) []byte {
	s.video.mu.Lock()
	defer s.video.mu.Unlock()
	return s.video.sidx[sidxKey(id, t)].init
}

// warmVideo fetches both tracks' indexes in the background (see createVideo).
func (s *Service) warmVideo(id string, v, a VideoTrack) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*upstreamTimeout)
	defer cancel()
	log := s.log.With("video_id", id)
	var wg sync.WaitGroup
	for _, t := range []VideoTrack{v, a} {
		if t.InitEnd <= 0 || t.IndexTo <= t.IndexFrom {
			continue
		}
		wg.Add(1)
		go func(t VideoTrack) {
			defer wg.Done()
			if _, err := s.videoIndex(ctx, id, t, log); err != nil {
				log.Debug("video warm-up failed", "itag", t.Itag, "err", errString(err))
			}
		}(t)
	}
	wg.Wait()
}

// videoIndex fetches a track's sidx — with the init segment in the same
// request when it sits right before the sidx, as YouTube lays them out —
// once per key: concurrent callers wait for the fetch under way.
func (s *Service) videoIndex(ctx context.Context, id string, t VideoTrack, log *slog.Logger) (sidxCached, error) {
	key := sidxKey(id, t)
	var mine chan struct{}
	for mine == nil {
		s.video.mu.Lock()
		if c, ok := s.video.sidx[key]; ok {
			s.video.mu.Unlock()
			return c, nil
		}
		if ch, ok := s.video.inflight[key]; ok {
			s.video.mu.Unlock()
			select {
			case <-ch:
				continue
			case <-ctx.Done():
				return sidxCached{}, ctx.Err()
			}
		}
		mine = make(chan struct{})
		s.video.inflight[key] = mine
		s.video.mu.Unlock()
	}
	defer func() {
		s.video.mu.Lock()
		delete(s.video.inflight, key)
		s.video.mu.Unlock()
		close(mine)
	}()
	if t.IndexTo-t.IndexFrom+1 > maxSidxBytes {
		return sidxCached{}, errBadSidx
	}
	ctx, cancel := context.WithTimeout(ctx, upstreamTimeout)
	defer cancel()
	var body, init []byte
	for attempt := 0; attempt < 2; attempt++ {
		from := t.IndexFrom
		withInit := t.InitEnd > 0 && t.IndexFrom == t.InitEnd+1 && t.InitEnd+1 <= maxInitBytes
		if withInit {
			from = 0
		}
		rng := "bytes=" + strconv.FormatInt(from, 10) + "-" + strconv.FormatInt(t.IndexTo, 10)
		resp, err := s.videoGet(ctx, http.MethodGet, t.URL, rng)
		if err != nil {
			return sidxCached{}, err
		}
		// YouTube refusing the server shows up as 403/410, or through the
		// Invidious proxy as an empty 200: refresh the stream URLs once.
		empty := resp.StatusCode == http.StatusOK && resp.ContentLength == 0
		if (staleStatus(resp.StatusCode) || empty) && attempt == 0 {
			resp.Body.Close()
			vs, err := s.video.p.VideoStreams(ctx, id, true)
			if err != nil {
				return sidxCached{}, err
			}
			nt := findTrack(append(append([]VideoTrack{}, vs.Video...), vs.Audio...), t.Itag)
			if nt == nil {
				return sidxCached{}, errors.New("track vanished")
			}
			t = *nt
			continue
		}
		if resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return sidxCached{}, errors.New("upstream status " + strconv.Itoa(resp.StatusCode))
		}
		if empty {
			resp.Body.Close()
			return sidxCached{}, errors.New("upstream sent no data (video blocked for the server)")
		}
		body, err = io.ReadAll(io.LimitReader(resp.Body, t.IndexTo-from+1))
		resp.Body.Close()
		if err != nil {
			return sidxCached{}, err
		}
		if withInit {
			if int64(len(body)) != t.IndexTo+1 {
				return sidxCached{}, errBadSidx
			}
			init, body = body[:t.InitEnd+1:t.InitEnd+1], body[t.InitEnd+1:]
		}
		break
	}
	segs, err := parseSidx(body, t.IndexFrom)
	if err != nil {
		return sidxCached{}, err
	}
	c := sidxCached{segs: segs, init: init, at: time.Now()}
	s.video.mu.Lock()
	if len(s.video.sidx) >= maxSidxCached {
		for k := range s.video.sidx {
			delete(s.video.sidx, k)
			if len(s.video.sidx) < maxSidxCached/2 {
				break
			}
		}
	}
	s.video.sidx[key] = c
	s.video.mu.Unlock()
	log.Debug("video sidx", "itag", t.Itag, "segments", len(segs), "init", len(init))
	return c, nil
}

// videoBytes proxies a media file (adaptive fragment ranges or the
// progressive MP4) from Invidious, passing Range through.
func (h *Handlers) videoBytes(c fiber.Ctx, id string, itag int, progressive bool, t VideoTrack, log *slog.Logger) error {
	s := h.svc
	method := http.MethodGet
	if c.Method() == fiber.MethodHead {
		method = http.MethodHead
	}
	clientRange := c.Get(fiber.HeaderRange)
	if !progressive && t.Size > 0 && t.InitEnd > 0 && clientRange == "bytes=0-"+strconv.FormatInt(t.InitEnd, 10) {
		if init := s.cachedInit(id, t); init != nil {
			return sendVideoInit(c, t, init)
		}
	}
	rng := clientRange
	if rng == "" {
		rng = "bytes=0-" // Invidious answers range-less /videoplayback with a short probe
	}
	ctx, cancel := context.WithCancel(context.Background())
	var resp *http.Response
	for attempt := 0; ; attempt++ {
		r, err := s.videoGet(ctx, method, t.URL, rng)
		if err != nil {
			cancel()
			log.Info("video upstream failed", "itag", itag, "err", errString(err))
			return videoStreamError()
		}
		if staleStatus(r.StatusCode) && attempt == 0 {
			r.Body.Close()
			vs, err := s.video.p.VideoStreams(c.Context(), id, true)
			if err != nil {
				cancel()
				return videoStreamError()
			}
			all := append(append(append([]VideoTrack{}, vs.Video...), vs.Audio...), vs.Progressive...)
			nt := findTrack(all, itag)
			if nt == nil {
				cancel()
				return httpx.NotFound()
			}
			t = *nt
			continue
		}
		resp = r
		break
	}
	switch resp.StatusCode {
	case http.StatusOK, http.StatusPartialContent, http.StatusRequestedRangeNotSatisfiable:
	default:
		resp.Body.Close()
		cancel()
		log.Info("video upstream status", "itag", itag, "status", resp.StatusCode)
		if resp.StatusCode == http.StatusNotFound {
			return httpx.NotFound()
		}
		return videoStreamError()
	}
	status := resp.StatusCode
	if clientRange == "" && status == http.StatusPartialContent {
		status = http.StatusOK // we asked bytes=0- on the client's behalf
	} else {
		for _, k := range []string{"Content-Range"} {
			if v := resp.Header.Get(k); v != "" {
				c.Set(k, v)
			}
		}
	}
	c.Status(status)
	c.Set("Accept-Ranges", "bytes")
	ct := "video/mp4"
	if strings.HasPrefix(t.Mime, "audio/") {
		ct = "audio/mp4"
	}
	c.Set(fiber.HeaderContentType, ct)
	c.Set(fiber.HeaderCacheControl, "private, max-age=3600")
	size := -1
	if resp.ContentLength >= 0 && resp.ContentLength <= int64(^uint(0)>>1) {
		size = int(resp.ContentLength)
	}
	if method == http.MethodHead || status == http.StatusRequestedRangeNotSatisfiable {
		resp.Body.Close()
		cancel()
		if size >= 0 {
			c.Response().Header.SetContentLength(size)
		}
		c.Response().SkipBody = method == http.MethodHead
		return nil
	}
	kind := "video"
	if progressive {
		kind = "video_mp4"
	}
	body := newIdleReader(resp.Body, cancel, s.t.StreamIdle, newStreamMeta(c, log, kind))
	return c.SendStream(activityReader{body}, size)
}

// sendVideoInit answers the init segment's range from the sidx cache.
func sendVideoInit(c fiber.Ctx, t VideoTrack, init []byte) error {
	c.Status(fiber.StatusPartialContent)
	c.Set("Content-Range", "bytes 0-"+strconv.FormatInt(t.InitEnd, 10)+"/"+strconv.FormatInt(t.Size, 10))
	c.Set("Accept-Ranges", "bytes")
	ct := "video/mp4"
	if strings.HasPrefix(t.Mime, "audio/") {
		ct = "audio/mp4"
	}
	c.Set(fiber.HeaderContentType, ct)
	c.Set(fiber.HeaderCacheControl, "private, max-age=3600")
	if c.Method() == fiber.MethodHead {
		c.Response().Header.SetContentLength(len(init))
		c.Response().SkipBody = true
		return nil
	}
	return c.Send(init)
}

// videoCaption proxies one VTT caption track.
func (h *Handlers) videoCaption(c fiber.Ctx, u string, log *slog.Logger) error {
	s := h.svc
	ctx, cancel := context.WithTimeout(c.Context(), upstreamTimeout)
	defer cancel()
	resp, err := s.videoGet(ctx, http.MethodGet, u, "")
	if err != nil {
		log.Info("video caption failed", "err", errString(err))
		return videoStreamError()
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return httpx.NotFound()
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return videoStreamError()
	}
	c.Set(fiber.HeaderContentType, "text/vtt; charset=utf-8")
	c.Set(fiber.HeaderCacheControl, "private, max-age=3600")
	return c.Send(b)
}
