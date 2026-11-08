package playback

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/httpx"
	"martytv/api/internal/integrations/torrserver"
)

// stream proxies GET|HEAD /api/v1/stream/:token to TorrServer.
//
// The token is the only input taken from the client (plus Range/If-Range);
// the info hash and file index come from the source row it is bound to, so a
// client cannot make the server fetch anything else.
func (h *Handlers) stream(c fiber.Ctx) error {
	// Only the token is read; a trailing /:filename is ignored.
	token := strings.Clone(c.Params("token"))
	filename := strings.Clone(c.Params("filename"))
	// Keep the capability out of request logs.
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
	if filename == compatName {
		return h.streamCompat(c, src, err)
	}
	if filename == compatHLSName {
		return h.streamCompatHLS(c, src, err)
	}
	if err == nil && src.Kind == "online" {
		return h.streamOnline(c, token, filename, src)
	}
	if errors.Is(err, errNotFound) || (err == nil && (src.Status != "ready" || src.FileIndex == nil)) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	mime := MimeType(deref(src.FilePath))
	if mime == "" {
		mime = "application/octet-stream"
	}
	c.Set(fiber.HeaderContentDisposition, contentDisposition(deref(src.FilePath)))
	log := h.svc.log.With("request_id", httpx.RequestID(c), "source_id", src.ID)

	// Downloaded to the server (internal/downloads): serve the local file.
	if lf := h.svc.localFor(c.Context(), src); lf != nil {
		if handled, err := h.serveLocal(c, token, src, lf, mime, log); handled {
			return err
		}
	}

	if c.Method() == fiber.MethodHead {
		return headResponse(c, src, mime)
	}

	// The upstream request outlives this handler: fasthttp streams the body
	// after we return and closes it (cancelling upstream) when done or when
	// the client goes away.
	ctx, cancel := context.WithCancel(context.Background())
	resp, err := h.svc.ts.Stream(ctx, src.InfoHash, *src.FileIndex, c.Get(fiber.HeaderRange), c.Get(fiber.HeaderIfRange))
	if err != nil {
		cancel()
		log.Warn("stream upstream failed", "err", err)
		if errors.Is(err, torrserver.ErrNotFound) {
			return httpx.NewError(fiber.StatusBadGateway, "stream_unavailable", "The file is not available on the streaming server.")
		}
		return httpx.NewError(fiber.StatusBadGateway, ErrCodeTorrServerDown, "The streaming server is unavailable.")
	}

	c.Status(resp.StatusCode)
	for _, k := range []string{"Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if v := resp.Header.Get(k); v != "" {
			c.Set(k, v)
		}
	}
	if c.Response().Header.Peek("Accept-Ranges") == nil {
		c.Set("Accept-Ranges", "bytes")
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" || strings.HasPrefix(ct, "application/octet-stream") || strings.HasPrefix(ct, "text/") {
		ct = mime
	}
	c.Set(fiber.HeaderContentType, ct)

	if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		resp.Body.Close()
		cancel()
		return nil
	}
	body := newIdleReader(resp.Body, cancel, h.svc.t.StreamIdle, newStreamMeta(c, log, "torrent"))
	body.onClose = trackStream(src.InfoHash)
	size := -1
	if resp.ContentLength >= 0 && resp.ContentLength <= int64(^uint(0)>>1) {
		size = int(resp.ContentLength)
	}
	return c.SendStream(body, size)
}

// contentDisposition builds `inline; filename="…"; filename*=UTF-8”…` from
// the real file's base name: quotes, control characters and path
// separators are removed, the ASCII fallback replaces non-ASCII with "_".
func contentDisposition(p string) string {
	name := path.Base(strings.ReplaceAll(p, "\\", "/"))
	var clean, ascii strings.Builder
	for _, r := range name {
		if r < 0x20 || r == 0x7f || r == '"' || r == '\\' || r == '/' || r == ';' {
			continue
		}
		clean.WriteRune(r)
		if r < 0x80 {
			ascii.WriteRune(r)
		} else {
			ascii.WriteByte('_')
		}
	}
	if clean.Len() == 0 || name == "." || name == "/" {
		return "inline"
	}
	return `inline; filename="` + ascii.String() + `"; filename*=UTF-8''` + url.PathEscape(clean.String())
}

var singleRange = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

// headResponse answers HEAD from the stored file size without touching
// TorrServer (players probe with HEAD; no need to start the torrent).
func headResponse(c fiber.Ctx, src *source, mime string) error {
	c.Set(fiber.HeaderContentType, mime)
	c.Set("Accept-Ranges", "bytes")
	size := int64(-1)
	if src.FileSize != nil {
		size = *src.FileSize
	}
	if size < 0 {
		c.Status(fiber.StatusOK)
		return nil
	}
	start, end, partial := int64(0), size-1, false
	if m := singleRange.FindStringSubmatch(strings.TrimSpace(c.Get(fiber.HeaderRange))); m != nil && (m[1] != "" || m[2] != "") {
		partial = true
		switch {
		case m[1] == "": // suffix range
			n, _ := strconv.ParseInt(m[2], 10, 64)
			if n <= 0 {
				return rangeNotSatisfiable(c, size)
			}
			if n < size {
				start = size - n
			}
		default:
			start, _ = strconv.ParseInt(m[1], 10, 64)
			if m[2] != "" {
				end, _ = strconv.ParseInt(m[2], 10, 64)
			}
			if end >= size {
				end = size - 1
			}
			if start >= size || start > end {
				return rangeNotSatisfiable(c, size)
			}
		}
	}
	if partial {
		c.Status(fiber.StatusPartialContent)
		c.Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(size, 10))
	} else {
		c.Status(fiber.StatusOK)
	}
	c.Response().Header.SetContentLength(int(end - start + 1))
	c.Response().SkipBody = true
	return nil
}

func rangeNotSatisfiable(c fiber.Ctx, size int64) error {
	c.Status(fiber.StatusRequestedRangeNotSatisfiable)
	c.Set("Content-Range", "bytes */"+strconv.FormatInt(size, 10))
	return nil
}

// activeStreams counts proxied stream bodies currently open (admin monitor).
var activeStreams atomic.Int64

// ActiveStreams is the number of video streams being proxied right now.
func ActiveStreams() int64 { return activeStreams.Load() }

// compatStreams counts open compat (transcoded MP4) streams: instant play
// stays off meanwhile (warm.go).
var compatStreams atomic.Int64

// streamMeta describes a proxied stream for the "stream closed" log line.
type streamMeta struct {
	log        *slog.Logger // carries request_id / source_id; never the token
	kind       string       // torrent | online | compat | subtitles
	client     string       // web | tv | other (from the User-Agent)
	rangeStart int64        // -1 without a Range header
}

var (
	tvAgent    = regexp.MustCompile(`(?i)tizen|web0s|webos|smart-?tv|netcast|hbbtv|bravia|vidaa|viera|philipstv|maple|googletv|android ?tv|\bAFT|crkey|msx`)
	rangeStart = regexp.MustCompile(`^bytes=(\d+)-`)
)

// clientKind classifies a User-Agent without logging it.
func clientKind(ua string) string {
	switch {
	case tvAgent.MatchString(ua):
		return "tv"
	case strings.HasPrefix(ua, "Mozilla/"):
		return "web"
	default:
		return "other"
	}
}

func newStreamMeta(c fiber.Ctx, log *slog.Logger, kind string) streamMeta {
	m := streamMeta{log: log, kind: kind, client: clientKind(c.Get(fiber.HeaderUserAgent)), rangeStart: -1}
	if r := rangeStart.FindStringSubmatch(strings.TrimSpace(c.Get(fiber.HeaderRange))); r != nil {
		m.rangeStart, _ = strconv.ParseInt(r[1], 10, 64)
	}
	return m
}

// Close reasons of a proxied stream.
const (
	closeClient   = "client_closed"  // fasthttp closed the body: client gone, or response finished after EOF
	closeIdle     = "idle_timeout"   // a Read waited longer than idle for upstream bytes
	closeEOF      = "upstream_eof"   // upstream finished
	closeUpstream = "upstream_error" // upstream read failed
)

// idleReader wraps the upstream body. Close (called by fasthttp when the
// response is done or the client disconnected) cancels the upstream request.
//
// The idle timer runs only while a Read is pending, i.e. while we are waiting
// for upstream: a client that is connected but not reading (buffer full,
// paused) is back-pressure, not a stall, and keeps its connection until it
// disconnects. A Read blocked longer than idle cancels the upstream request
// so the blocked read ends.
type idleReader struct {
	r      io.ReadCloser
	cancel context.CancelFunc
	timer  *time.Timer
	idle   time.Duration
	once   sync.Once
	// uncounted readers (compat subtitles) don't count as active streams.
	uncounted bool
	// onClose runs once when the stream closes (streaming-hash tracking).
	onClose func()

	meta    streamMeta
	opened  time.Time
	bytes   atomic.Int64
	mu      sync.Mutex
	reason  string
	timeout atomic.Bool
}

func newIdleReader(r io.ReadCloser, cancel context.CancelFunc, idle time.Duration, meta streamMeta) *idleReader {
	ir := &idleReader{r: r, cancel: cancel, idle: idle, meta: meta, opened: time.Now()}
	ir.timer = time.AfterFunc(idle, ir.onIdle)
	ir.timer.Stop() // armed only while a Read is pending
	if !ir.uncounted {
		activeStreams.Add(1)
	}
	if meta.kind == "compat" {
		compatStreams.Add(1)
	}
	return ir
}

func (ir *idleReader) onIdle() {
	ir.timeout.Store(true)
	ir.setReason(closeIdle)
	ir.cancel()
}

// setReason keeps the first reason recorded.
func (ir *idleReader) setReason(r string) {
	ir.mu.Lock()
	if ir.reason == "" {
		ir.reason = r
	}
	ir.mu.Unlock()
}

func (ir *idleReader) Read(p []byte) (int, error) {
	ir.timer.Reset(ir.idle)
	n, err := ir.r.Read(p)
	ir.timer.Stop()
	if n > 0 {
		ir.bytes.Add(int64(n))
	}
	switch {
	case err == nil:
	case errors.Is(err, io.EOF):
		ir.setReason(closeEOF)
	case ir.timeout.Load():
		ir.setReason(closeIdle)
	default:
		ir.setReason(closeUpstream)
	}
	return n, err
}

func (ir *idleReader) Close() error {
	ir.once.Do(func() {
		if !ir.uncounted {
			activeStreams.Add(-1)
		}
		if ir.meta.kind == "compat" {
			compatStreams.Add(-1)
		}
		ir.timer.Stop()
		if ir.onClose != nil {
			ir.onClose()
		}
		ir.setReason(closeClient)
		ir.cancel()
		_ = ir.r.Close()
		if ir.meta.log != nil {
			ir.mu.Lock()
			reason := ir.reason
			ir.mu.Unlock()
			ir.meta.log.Info("stream closed", "kind", ir.meta.kind, "client", ir.meta.client, "range_start", ir.meta.rangeStart,
				"bytes", ir.bytes.Load(), "duration_s", time.Since(ir.opened).Round(time.Millisecond).Seconds(), "reason", reason)
		}
	})
	return nil
}

// closeReason is the recorded close reason (tests).
func (ir *idleReader) closeReason() string {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	return ir.reason
}
