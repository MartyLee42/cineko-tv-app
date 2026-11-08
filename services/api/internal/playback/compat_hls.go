package playback

// HLS variant of the compat stream, for Safari / iOS / iPadOS (incl. web
// views such as Media Station X): AVFoundation doesn't play a progressive MP4
// without byte ranges (compat.mp4 is 200, Accept-Ranges: none), but it plays
// fMP4 HLS. The transcoder writes an EVENT playlist per session
// (services/transcoder/hls.go); the API authorizes with the stream token,
// starts or reuses the session and relays its files.
//
//	GET|HEAD /api/v1/stream/<token>/compat.m3u8?audio=&start=&ch=
//	    multivariant playlist with one variant: compat/<session>/index.m3u8
//	    (HEAD: X-Stream-Start only, like compat.mp4)
//	GET|HEAD /api/v1/stream/<token>/compat/<session>/index.m3u8   media playlist (rewritten)
//	GET|HEAD /api/v1/stream/<token>/compat/<session>/init.mp4      Range
//	GET|HEAD /api/v1/stream/<token>/compat/<session>/seg<N>.m4s    Range
//
// The session id sits in the media playlist's URL, so a playlist reload
// never silently lands on a different (restarted) conversion: a session that
// is gone answers 404 compat_session_gone and the player restarts at its
// position. Seeking beyond the generated segments = a new compat.m3u8 with
// start= (X-Stream-Start says where it begins, as for compat.mp4).

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/httpx"
)

const (
	compatHLSName = "compat.m3u8"
	mpegURL       = "application/vnd.apple.mpegurl"
	// ErrCodeCompatSessionGone: the HLS conversion ended (idle, evicted,
	// transcoder restarted); request compat.m3u8 again.
	ErrCodeCompatSessionGone = "compat_session_gone"
	// hlsMinTarget: EXT-X-TARGETDURATION floor. Copied video is cut at
	// keyframes, so segments run longer than ffmpeg's 4 s; a steady target
	// keeps later (longer) segments within it.
	hlsMinTarget = 10
)

var (
	hlsSessionID = regexp.MustCompile(`^[0-9a-f]{32}$`)
	hlsFileName  = regexp.MustCompile(`^(index\.m3u8|init\.mp4|seg\d{1,6}\.m4s)$`)
	hlsSegURI    = regexp.MustCompile(`^seg\d{1,6}\.m4s$`)
)

// hlsActivity: info hashes with HLS compat requests lately. HLS has no
// long-lived stream to count, so a recent request stands for "streaming".
type hlsActivity struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

const hlsSeenFor = time.Minute

func (a *hlsActivity) note(hash string) {
	if hash == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	if a.seen == nil {
		a.seen = map[string]time.Time{}
	}
	a.seen[hash] = now
	for h, t := range a.seen {
		if now.Sub(t) > hlsSeenFor {
			delete(a.seen, h)
		}
	}
}

// any: an HLS compat stream ran within hlsSeenFor.
func (a *hlsActivity) any() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, t := range a.seen {
		if time.Since(t) <= hlsSeenFor {
			return true
		}
	}
	return false
}

func (a *hlsActivity) addTo(out map[string]bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for h, t := range a.seen {
		if time.Since(t) <= hlsSeenFor {
			out[h] = true
		}
	}
}

// streamCompatHLS serves compat.m3u8: starts (or reuses) the transcoder's
// session and answers a multivariant playlist pointing at it.
func (h *Handlers) streamCompatHLS(c fiber.Ctx, src *source, lookupErr error) error {
	src, err := h.compatSource(src, lookupErr)
	if err != nil {
		return err
	}
	job, err := h.compatJobFor(c, src)
	if err != nil {
		return err
	}
	log := h.svc.log.With("request_id", httpx.RequestID(c), "source_id", src.ID)
	c.Set(fiber.HeaderContentType, mpegURL)
	if c.Method() == fiber.MethodHead {
		return h.compatHead(c, job, log)
	}
	job.Kind, job.Owner = "hls", src.ID
	// The transcoder answers once the first segments exist (a cold torrent
	// can take a while); give up when the player does.
	resp, err := h.svc.tc.post(c.Context(), h.svc.tc.hc, job)
	if err != nil {
		log.Warn("compat hls failed", "err", err)
		return transcoderDown()
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return transcoderError(resp, log)
	}
	var out struct {
		Session string  `json:"session"`
		Start   float64 `json:"start"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 1<<12)).Decode(&out) != nil || !hlsSessionID.MatchString(out.Session) {
		log.Warn("compat hls: bad transcoder answer")
		return transcoderDown()
	}
	h.svc.hls.note(src.InfoHash)
	log.Info("compat hls", "start", job.Start, "stream_start", out.Start, "audio", job.Audio != nil && *job.Audio >= 0)
	c.Set("X-Stream-Start", strconv.FormatFloat(out.Start, 'f', 3, 64))
	c.Status(fiber.StatusOK)
	return c.Send(compatMaster(src, out.Session))
}

// compatMaster: one variant. BANDWIDTH is required; the file's average
// bitrate (+ AAC) is a fair peak estimate for copied video.
func compatMaster(src *source, session string) []byte {
	bw := int64(8_000_000)
	info := src.MediaInfo
	if info != nil && info.DurationSeconds != nil && *info.DurationSeconds > 0 && src.FileSize != nil && *src.FileSize > 0 {
		bw = int64(float64(*src.FileSize)*8 / *info.DurationSeconds) + 192_000
	}
	var b bytes.Buffer
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n")
	fmt.Fprintf(&b, "#EXT-X-STREAM-INF:BANDWIDTH=%d", bw)
	if info != nil && info.Width != nil && info.Height != nil && *info.Width > 0 && *info.Height > 0 {
		fmt.Fprintf(&b, ",RESOLUTION=%dx%d", *info.Width, *info.Height)
	}
	fmt.Fprintf(&b, "\ncompat/%s/index.m3u8\n", session)
	return b.Bytes()
}

// streamCompatHLSFile serves GET|HEAD /api/v1/stream/:token/compat/:session/:file.
func (h *Handlers) streamCompatHLSFile(c fiber.Ctx) error {
	token := strings.Clone(c.Params("token"))
	session := strings.Clone(c.Params("session"))
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
	if !hlsSessionID.MatchString(session) || !hlsFileName.MatchString(file) {
		return httpx.NotFound()
	}
	log := h.svc.log.With("request_id", httpx.RequestID(c), "source_id", src.ID)
	playlist := file == "index.m3u8"
	method := http.MethodGet
	if c.Method() == fiber.MethodHead && !playlist {
		method = http.MethodHead
	}
	hdr := http.Header{}
	if !playlist {
		for _, k := range []string{fiber.HeaderRange, fiber.HeaderIfRange} {
			if v := c.Get(k); v != "" {
				hdr.Set(k, v)
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	resp, err := h.svc.tc.getFile(ctx, method, session, file, src.ID, hdr)
	if err != nil {
		cancel()
		log.Warn("compat hls file failed", "err", err)
		return transcoderDown()
	}
	h.svc.hls.note(src.InfoHash)
	switch resp.StatusCode {
	case http.StatusOK, http.StatusPartialContent, http.StatusRequestedRangeNotSatisfiable:
	case http.StatusNotFound:
		defer cancel()
		defer resp.Body.Close()
		return httpx.NewError(fiber.StatusNotFound, ErrCodeCompatSessionGone, "This conversion has ended; request compat.m3u8 again.")
	default:
		defer cancel()
		defer resp.Body.Close()
		return transcoderError(resp, log)
	}

	if playlist {
		defer cancel()
		defer resp.Body.Close()
		b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err != nil {
			return transcoderDown()
		}
		out, err := rewriteHLSPlaylist(b)
		if err != nil {
			log.Warn("compat hls: bad playlist", "err", err)
			return transcoderDown()
		}
		c.Set(fiber.HeaderContentType, mpegURL)
		c.Status(fiber.StatusOK)
		if c.Method() == fiber.MethodHead {
			c.Response().SkipBody = true
			return nil
		}
		return c.Send(out)
	}

	c.Status(resp.StatusCode)
	c.Set(fiber.HeaderContentType, "video/mp4")
	for _, k := range []string{"Content-Range", "Accept-Ranges", "Last-Modified"} {
		if v := resp.Header.Get(k); v != "" {
			c.Set(k, v)
		}
	}
	if method == http.MethodHead || resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		if resp.ContentLength >= 0 && method == http.MethodHead {
			c.Response().Header.SetContentLength(int(resp.ContentLength))
		}
		resp.Body.Close()
		cancel()
		c.Response().SkipBody = true
		return nil
	}
	size := -1
	if resp.ContentLength >= 0 && resp.ContentLength <= int64(^uint(0)>>1) {
		size = int(resp.ContentLength)
	}
	return c.SendStream(&cancelBody{ReadCloser: resp.Body, cancel: cancel}, size)
}

// cancelBody closes the upstream body and its request context (fasthttp
// closes the stream when the response is done or the client is gone).
type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
	once   sync.Once
}

func (b *cancelBody) Close() error {
	b.once.Do(func() {
		b.cancel()
		_ = b.ReadCloser.Close()
	})
	return nil
}

// getFile fetches a session file (signed like services/transcoder/hls.go:
// HMAC(key, "hls-file\n"+id+"\n"+file+"\n"+owner+"\n"+exp)).
func (t *transcoder) getFile(ctx context.Context, method, session, file, owner string, hdr http.Header) (*http.Response, error) {
	exp := time.Now().Add(time.Minute).Unix()
	m := hmac.New(sha256.New, t.key)
	m.Write([]byte("hls-file\n" + session + "\n" + file + "\n" + owner + "\n" + strconv.FormatInt(exp, 10)))
	u := fmt.Sprintf("%s/v1/hls/%s/%s?owner=%s&exp=%d", t.base, session, file, owner, exp)
	req, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil {
		return nil, errors.New("transcoder: bad request")
	}
	req.Header = hdr
	req.Header.Set("X-Job-Signature", hex.EncodeToString(m.Sum(nil)))
	resp, err := t.hc.Do(req)
	if err != nil {
		return nil, errors.New("transcoder unreachable")
	}
	return resp, nil
}

// rewriteHLSPlaylist passes ffmpeg's media playlist through an allowlist
// (only its own tags and file names: the URIs stay relative to
// compat/<session>/), starts playback at the beginning of the EVENT playlist
// rather than its live edge, and keeps the target duration steady.
func rewriteHLSPlaylist(in []byte) ([]byte, error) {
	sc := bufio.NewScanner(bytes.NewReader(in))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	var out bytes.Buffer
	first := true
	started := false
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if first {
			if line != "#EXTM3U" {
				return nil, errors.New("not a playlist")
			}
			first = false
			out.WriteString("#EXTM3U\n")
			continue
		}
		tag, val, _ := strings.Cut(line, ":")
		switch {
		case line == "":
			continue
		case tag == "#EXT-X-VERSION" || tag == "#EXT-X-MEDIA-SEQUENCE" || tag == "#EXTINF":
			out.WriteString(line + "\n")
		case tag == "#EXT-X-TARGETDURATION":
			n, err := strconv.Atoi(val)
			if err != nil {
				return nil, errors.New("bad target duration")
			}
			fmt.Fprintf(&out, "#EXT-X-TARGETDURATION:%d\n", max(n, hlsMinTarget))
		case line == "#EXT-X-PLAYLIST-TYPE:EVENT" || line == "#EXT-X-PLAYLIST-TYPE:VOD" || line == "#EXT-X-INDEPENDENT-SEGMENTS" ||
			line == "#EXT-X-ENDLIST" || line == "#EXT-X-DISCONTINUITY":
			out.WriteString(line + "\n")
		case line == `#EXT-X-MAP:URI="init.mp4"`:
			if !started {
				// Safari starts an EVENT playlist at its live edge otherwise.
				out.WriteString("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n")
				started = true
			}
			out.WriteString(line + "\n")
		case strings.HasPrefix(line, "#"):
			// Anything else ffmpeg might add is dropped.
		case hlsSegURI.MatchString(line):
			out.WriteString(line + "\n")
		default:
			return nil, errors.New("unexpected URI in playlist")
		}
	}
	if err := sc.Err(); err != nil || first {
		return nil, errors.New("unreadable playlist")
	}
	return out.Bytes(), nil
}
