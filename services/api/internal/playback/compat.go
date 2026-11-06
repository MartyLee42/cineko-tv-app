package playback

// Browser compatibility stream: the same torrent file remuxed to fragmented
// MP4 with one audio track converted to AAC, for browsers that can't decode
// the original audio (AC3/E-AC3/DTS/TrueHD/FLAC…) or open the container (MKV
// on Safari, raw TS). The video is copied, except with video=h264: old codecs
// TVs can't decode (XviD/DivX, MPEG-2, VC-1, ≤ 1080p — VideoTranscodable) are
// re-encoded to H.264. The work runs in services/transcoder; the API only
// authorizes, builds a signed job from its own records and relays the bytes.
//
//	GET|HEAD /api/v1/stream/<token>/compat.mp4?audio=<stream index>&start=<s>[&ch=6][&video=h264]
//	GET|HEAD /api/v1/stream/<token>/subs/<stream index>.vtt?start=<s>[&burst=<s>]
//
// No Range support (200, Accept-Ranges: none): seeking restarts the stream
// with a new start. The output begins at the keyframe at or before start;
// X-Stream-Start says where (HEAD asks for it without starting a stream), and
// players add it to currentTime. Subtitles requested with the same start use
// the same timeline.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/config"
	"martytv/api/internal/httpx"
)

const (
	compatName = "compat.mp4"
	// Error codes of the compat stream.
	ErrCodeTranscoderDown = "transcoder_unavailable"
	ErrCodeTranscoderBusy = "transcoder_busy"
	ErrCodeCompatOff      = "compat_unavailable"
	// compatMaxStart bounds start= when the duration is unknown.
	compatMaxStart = 48 * 3600
	// subtitleIdle: cues can be minutes apart, and the transcoder reads the
	// file at a capped rate; don't cut a subtitle stream as fast as video.
	subtitleIdle = 15 * time.Minute
)

// textSubtitleCodecs can become WebVTT (image subtitles like PGS/VOBSUB can't).
var textSubtitleCodecs = map[string]bool{
	"subrip": true, "srt": true, "ass": true, "ssa": true, "webvtt": true, "mov_text": true, "text": true, "microdvd": true,
}

// IsTextSubtitle reports whether a subtitle codec can be served as WebVTT.
func IsTextSubtitle(codec string) bool { return textSubtitleCodecs[strings.ToLower(codec)] }

// transcodableVideo: ffprobe video codecs the transcoder may re-encode to
// H.264 (video=h264) — old codecs TV hardware rarely decodes. Modern ones
// (HEVC, VP9, AV1, H.264 10-bit) are not: too heavy for the server's CPU.
var transcodableVideo = map[string]bool{
	"mpeg4": true, "msmpeg4v1": true, "msmpeg4v2": true, "msmpeg4v3": true, "msmpeg4": true,
	"mpeg2video": true, "mpeg1video": true, "vc1": true, "wmv1": true, "wmv2": true, "wmv3": true,
	"h263": true, "flv1": true,
}

// Video re-encoding is limited to 1080p (MPEG-2 1080 is coded as 1088 lines).
const (
	maxTranscodeWidth  = 2048
	maxTranscodeHeight = 1088
)

// VideoTranscodable reports whether the probed video may be re-encoded to
// H.264 (compat video=h264): a known old codec with a known size ≤ 1080p.
func VideoTranscodable(info *MediaInfo) bool {
	if info == nil || info.VideoCodec == nil || info.Width == nil || info.Height == nil {
		return false
	}
	w, h := *info.Width, *info.Height
	return transcodableVideo[strings.ToLower(*info.VideoCodec)] && w > 0 && h > 0 && w <= maxTranscodeWidth && h <= maxTranscodeHeight
}

// compatJob mirrors services/transcoder/job.go (the transcoder rejects
// unknown fields, so keep them in sync).
type compatJob struct {
	V         int     `json:"v"`
	Kind      string  `json:"kind"`
	Input     string  `json:"input"`
	Auth      string  `json:"auth,omitempty"`
	Audio     *int    `json:"audio,omitempty"`
	AudioCopy bool    `json:"audio_copy,omitempty"`
	Channels  int     `json:"channels,omitempty"`
	HVC1      bool    `json:"hvc1,omitempty"`
	Video     string  `json:"video,omitempty"`
	Start     float64 `json:"start,omitempty"`
	Stream    int     `json:"stream,omitempty"`
	Burst     float64 `json:"burst,omitempty"`
	Owner     string  `json:"owner,omitempty"`
	Exp       int64   `json:"exp"`
}

// transcoder is the HTTP client for services/transcoder.
type transcoder struct {
	base string
	key  []byte
	hc   *http.Client // streams: no overall timeout
	api  *http.Client // keyframe probes and metrics
}

func newTranscoder(cfg config.TranscoderConfig) *transcoder {
	if !cfg.Configured() {
		return nil
	}
	m := hmac.New(sha256.New, []byte(cfg.Secret))
	m.Write([]byte("martytv/transcoder/job/v1"))
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	tr := &http.Transport{
		Proxy:       nil, // internal network only
		DialContext: (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		// The transcoder answers once ffmpeg produced output; a cold torrent
		// can take a while to deliver its first megabytes.
		ResponseHeaderTimeout: 3 * time.Minute,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       60 * time.Second,
		DisableCompression:    true,
	}
	return &transcoder{
		base: strings.TrimRight(cfg.URL, "/"),
		key:  m.Sum(nil),
		hc:   &http.Client{Transport: tr, CheckRedirect: noRedirect},
		api:  &http.Client{Transport: tr, CheckRedirect: noRedirect, Timeout: 45 * time.Second},
	}
}

// post sends a signed job. The caller closes the body.
func (t *transcoder) post(ctx context.Context, hc *http.Client, j compatJob) (*http.Response, error) {
	j.V, j.Exp = 1, time.Now().Add(time.Minute).Unix()
	body, err := json.Marshal(j)
	if err != nil {
		return nil, err
	}
	m := hmac.New(sha256.New, t.key)
	m.Write(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.base+"/v1/"+j.Kind, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("transcoder: bad request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Job-Signature", hex.EncodeToString(m.Sum(nil)))
	resp, err := hc.Do(req)
	if err != nil {
		return nil, errors.New("transcoder unreachable") // no URLs in errors
	}
	return resp, nil
}

// TranscoderMetrics is the transcoder's GET /metrics (admin Server tab).
type TranscoderMetrics struct {
	ActiveJobs         int   `json:"active_jobs"`
	ActiveSubtitleJobs int   `json:"active_subtitle_jobs"`
	MaxJobs            int   `json:"max_jobs"`
	JobsStarted        int64 `json:"jobs_started"`
	JobsRejected       int64 `json:"jobs_rejected"`
	JobsFailed         int64 `json:"jobs_failed"`
}

// CompatConfigured reports whether compat streams are offered.
func (s *Service) CompatConfigured() bool { return s.tc != nil }

// TranscoderMetrics asks the transcoder for its counters; nil when it isn't
// configured or doesn't answer.
func (s *Service) TranscoderMetrics(ctx context.Context) *TranscoderMetrics {
	if s.tc == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.tc.base+"/metrics", nil)
	if err != nil {
		return nil
	}
	resp, err := s.tc.api.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var m TranscoderMetrics
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&m) != nil {
		return nil
	}
	return &m
}

// compatSource checks that the token's source can have a compat stream.
func (h *Handlers) compatSource(src *source, err error) (*source, error) {
	if errors.Is(err, errNotFound) || (err == nil && (src.Kind == "online" || src.Status != "ready" || src.FileIndex == nil)) {
		return nil, httpx.NotFound()
	}
	if err != nil {
		return nil, err
	}
	if h.svc.tc == nil {
		return nil, httpx.NewError(fiber.StatusNotFound, ErrCodeCompatOff, "Compatibility streams are not enabled on this server.")
	}
	return src, nil
}

// compatInput is the TorrServer stream the transcoder reads (from the row).
func (h *Handlers) compatInput(src *source) (compatJob, error) {
	// Downloaded to the server: read the local copy through the API.
	if lf := h.svc.localFor(context.Background(), src); lf != nil {
		if j, ok := h.svc.localCompatInput(src, lf); ok {
			h.svc.lib.Watched(lf.DownloadID)
			return j, nil
		}
	}
	in, auth, err := h.svc.ts.StreamInput(src.InfoHash, *src.FileIndex)
	if err != nil {
		return compatJob{}, httpx.NewError(fiber.StatusBadGateway, ErrCodeTorrServerDown, "The streaming server is not configured.")
	}
	return compatJob{Input: in, Auth: auth}, nil
}

// parseStart reads start= (seconds, ≥ 0, within the file when its length is known).
func parseStart(v string, info *MediaInfo) (float64, bool) {
	if v == "" {
		return 0, true
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > compatMaxStart {
		return 0, false
	}
	if info != nil && info.DurationSeconds != nil && *info.DurationSeconds > 0 && f > *info.DurationSeconds {
		return 0, false
	}
	return math.Round(f*1000) / 1000, true
}

func (h *Handlers) streamCompat(c fiber.Ctx, src *source, lookupErr error) error {
	src, err := h.compatSource(src, lookupErr)
	if err != nil {
		return err
	}
	job, err := h.compatJobFor(c, src)
	if err != nil {
		return err
	}
	job.Kind = "remux"
	start := job.Start

	log := h.svc.log.With("request_id", httpx.RequestID(c), "source_id", src.ID)
	c.Set(fiber.HeaderContentType, "video/mp4")
	c.Set("Accept-Ranges", "none")

	if c.Method() == fiber.MethodHead {
		return h.compatHead(c, job, log)
	}

	// The job outlives this handler: fasthttp streams the body after we
	// return and closes it (cancelling the job → ffmpeg killed) when done or
	// when the player goes away.
	ctx, cancel := context.WithCancel(context.Background())
	resp, err := h.svc.tc.post(ctx, h.svc.tc.hc, job)
	if err != nil {
		cancel()
		log.Warn("compat stream failed", "err", err)
		return transcoderDown()
	}
	if resp.StatusCode != http.StatusOK {
		defer cancel()
		defer resp.Body.Close()
		return transcoderError(resp, log)
	}
	c.Status(fiber.StatusOK)
	c.Set("X-Stream-Start", resp.Header.Get("X-Stream-Start"))
	c.Set(fiber.HeaderContentDisposition, `inline; filename="compat.mp4"`)
	log.Info("compat stream", "start", start, "audio", job.Audio != nil && *job.Audio >= 0, "video", job.Video)
	body := newIdleReader(resp.Body, cancel, h.svc.t.StreamIdle, newStreamMeta(c, log, "compat"))
	body.onClose = trackStream(src.InfoHash)
	return c.SendStream(body, -1)
}

// compatJobFor builds the job from the source row and the query
// (audio=<stream index>, start=<s>, ch=2|6, video=h264); Kind is left to the
// caller.
func (h *Handlers) compatJobFor(c fiber.Ctx, src *source) (compatJob, error) {
	info := src.MediaInfo
	job, err := h.compatInput(src)
	if err != nil {
		return job, err
	}
	// audio: a global stream index that ffprobe listed as audio. Without
	// media info nothing can be checked, so only the default is allowed.
	if v := c.Query("audio"); v != "" {
		n, err := strconv.Atoi(v)
		var track *MediaStream
		if err == nil && info != nil {
			for i := range info.Audio {
				if info.Audio[i].Index == n {
					track = &info.Audio[i]
				}
			}
		}
		if track == nil {
			return job, httpx.NewError(fiber.StatusUnprocessableEntity, "invalid_audio", "No such audio track in this file.")
		}
		job.Audio, job.AudioCopy = &n, strings.EqualFold(track.Codec, "aac")
	} else if info != nil && len(info.Audio) > 0 {
		track := info.Audio[0]
		for _, a := range info.Audio {
			if a.Default {
				track = a
				break
			}
		}
		n := track.Index
		job.Audio, job.AudioCopy = &n, strings.EqualFold(track.Codec, "aac")
	}
	start, ok := parseStart(c.Query("start"), info)
	if !ok {
		return job, httpx.NewError(fiber.StatusUnprocessableEntity, "invalid_start", "start must be a position in seconds within the file.")
	}
	job.Start = start
	switch c.Query("ch") {
	case "", "2":
	case "6":
		job.Channels, job.AudioCopy = 6, false
	default:
		return job, httpx.NewError(fiber.StatusUnprocessableEntity, "invalid_channels", "ch must be 2 or 6.")
	}
	job.HVC1 = info != nil && info.VideoCodec != nil && strings.EqualFold(*info.VideoCodec, "hevc")
	switch c.Query("video") {
	case "":
	case "h264":
		// Only what the server can afford: old codecs, ≤ 1080p (media_info).
		if !VideoTranscodable(info) {
			return job, httpx.NewError(fiber.StatusUnprocessableEntity, "video_not_convertible", "This file's video can't be converted on the server.")
		}
		job.Video, job.HVC1 = "h264", false
	default:
		return job, httpx.NewError(fiber.StatusUnprocessableEntity, "invalid_video", "video must be h264.")
	}
	return job, nil
}

// compatHead answers HEAD: where a stream at start would begin (the
// player's seek offset), from a keyframe probe; no stream is started.
func (h *Handlers) compatHead(c fiber.Ctx, job compatJob, log *slog.Logger) error {
	k := 0.0
	if job.Start > 0 {
		job.Kind = "keyframe"
		resp, err := h.svc.tc.post(c.Context(), h.svc.tc.api, job)
		if err != nil {
			log.Warn("compat keyframe failed", "err", err)
			return transcoderDown()
		}
		defer resp.Body.Close()
		var out struct {
			Start float64 `json:"start"`
		}
		if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<12)).Decode(&out) != nil {
			return transcoderError(resp, log)
		}
		k = out.Start
	}
	c.Set("X-Stream-Start", strconv.FormatFloat(k, 'f', 3, 64))
	c.Status(fiber.StatusOK)
	c.Response().SkipBody = true
	return nil
}

var subsFile = regexp.MustCompile(`^(\d{1,4})\.vtt$`)

// streamSubs serves GET|HEAD /api/v1/stream/:token/subs/:file.
func (h *Handlers) streamSubs(c fiber.Ctx) error {
	token := strings.Clone(c.Params("token"))
	file := strings.Clone(c.Params("file"))
	c.Path("/api/v1/stream/-")
	c.Set(fiber.HeaderCacheControl, "no-store")
	c.Set("X-Content-Type-Options", "nosniff")
	c.Set("Referrer-Policy", "no-referrer")
	id, err := h.svc.signer.Verify(token, time.Now())
	if err != nil {
		code, msg := "invalid_stream_token", "The stream link is invalid."
		if errors.Is(err, errExpiredToken) {
			code, msg = "stream_token_expired", "The stream link has expired; fetch the source again."
		}
		return httpx.NewError(fiber.StatusForbidden, code, msg)
	}
	src, err := h.svc.st.get(c.Context(), id)
	if src, err = h.compatSource(src, err); err != nil {
		return err
	}
	m := subsFile.FindStringSubmatch(file)
	if m == nil {
		return httpx.NotFound()
	}
	n, _ := strconv.Atoi(m[1])
	ok := false
	if src.MediaInfo != nil {
		for _, s := range src.MediaInfo.Subtitles {
			ok = ok || (s.Index == n && IsTextSubtitle(s.Codec))
		}
	}
	if !ok {
		return httpx.NewError(fiber.StatusUnprocessableEntity, "invalid_subtitles", "No such text subtitle track in this file.")
	}
	start, ok1 := parseStart(c.Query("start"), src.MediaInfo)
	burst, ok2 := parseStart(c.Query("burst"), nil)
	if !ok1 || !ok2 {
		return httpx.NewError(fiber.StatusUnprocessableEntity, "invalid_start", "start/burst must be positions in seconds within the file.")
	}
	c.Set(fiber.HeaderContentType, "text/vtt; charset=utf-8")
	if c.Method() == fiber.MethodHead {
		c.Status(fiber.StatusOK)
		c.Response().SkipBody = true
		return nil
	}
	job, err := h.compatInput(src)
	if err != nil {
		return err
	}
	job.Kind, job.Stream, job.Start, job.Burst = "subtitles", n, start, burst
	log := h.svc.log.With("request_id", httpx.RequestID(c), "source_id", src.ID)
	ctx, cancel := context.WithCancel(context.Background())
	resp, err := h.svc.tc.post(ctx, h.svc.tc.hc, job)
	if err != nil {
		cancel()
		log.Warn("compat subtitles failed", "err", err)
		return transcoderDown()
	}
	if resp.StatusCode != http.StatusOK {
		defer cancel()
		defer resp.Body.Close()
		return transcoderError(resp, log)
	}
	c.Status(fiber.StatusOK)
	return c.SendStream(newSubtitleReader(resp.Body, cancel, newStreamMeta(c, log, "subtitles")), -1)
}

func transcoderDown() error {
	return httpx.NewError(fiber.StatusBadGateway, ErrCodeTranscoderDown, "The compatibility converter is unavailable.")
}

// transcoderError maps a non-200 transcoder answer.
func transcoderError(resp *http.Response, log interface{ Warn(string, ...any) }) error {
	var e struct {
		Error struct{ Code string } `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<12)).Decode(&e)
	switch {
	case resp.StatusCode == http.StatusServiceUnavailable:
		return httpx.NewError(fiber.StatusServiceUnavailable, ErrCodeTranscoderBusy, "Too many converted streams are playing right now; try again in a minute.")
	case resp.StatusCode == http.StatusBadGateway:
		return httpx.NewError(fiber.StatusBadGateway, "stream_unavailable", "The file could not be opened for conversion.")
	default:
		// 400/403: the job or secret is wrong (configuration), not the user.
		log.Warn("transcoder refused job", "status", resp.StatusCode, "code", e.Error.Code)
		return transcoderDown()
	}
}

// newSubtitleReader: like a compat stream, with a longer idle limit (cues can
// be minutes apart) and not counted as an active video stream.
func newSubtitleReader(r io.ReadCloser, cancel context.CancelFunc, meta streamMeta) *idleReader {
	ir := &idleReader{r: r, cancel: cancel, idle: subtitleIdle, uncounted: true, meta: meta, opened: time.Now()}
	ir.timer = time.AfterFunc(subtitleIdle, ir.onIdle)
	ir.timer.Stop()
	return ir
}
