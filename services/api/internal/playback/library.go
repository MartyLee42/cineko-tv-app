package playback

// Server downloads (internal/downloads) hook into playback here:
//
//   - a fully downloaded file replaces TorrServer in the stream proxy
//     (serveLocal: Range, If-Range, HEAD, same token, same active_streams);
//   - compat streams of a downloaded file make the transcoder read the API's
//     own stream endpoint (fresh token + an internal Authorization value, so
//     the transcoder's read isn't counted as a second active stream);
//   - PlaybackSource.download shows the download state of the source's file;
//   - downloads looks up sources, re-adds torrents to TorrServer and asks
//     which torrents are being streamed right now.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/integrations/torrserver"
)

// DownloadBrief is PlaybackSource.download (contract: DownloadBrief).
type DownloadBrief struct {
	ID          string     `json:"id"`
	Status      string     `json:"status"`
	Progress    float64    `json:"progress"`
	BytesDone   int64      `json:"bytes_done"`
	Size        int64      `json:"size"`
	RateBps     *float64   `json:"rate_bps"`
	ETASeconds  *int64     `json:"eta_seconds"`
	CompletedAt *time.Time `json:"completed_at"`
	KeepUntil   *time.Time `json:"keep_until"`
	Pinned      bool       `json:"pinned"`
	Mine        bool       `json:"mine"`
}

// LocalFile is a completed download on disk.
type LocalFile struct {
	DownloadID string
	Path       string
	Size       int64
	ModTime    time.Time
}

// Library is implemented by internal/downloads.
type Library interface {
	// LocalFile returns the completed download of (hash, index), if any.
	LocalFile(ctx context.Context, hash string, index int) (*LocalFile, bool)
	// Brief is the download state of (hash, index) for userID; nil if none.
	Brief(ctx context.Context, userID, hash string, index int) *DownloadBrief
	// HasCompleted reports whether any file of the torrent is downloaded.
	HasCompleted(ctx context.Context, hash string) bool
	// Watched records that a download is being played (last_watched_at).
	Watched(downloadID string)
}

// SetLibrary connects server downloads (nil = none).
func (s *Service) SetLibrary(l Library) { s.lib = l }

// TorrServer is the shared TorrServer client (downloads read through it).
func (s *Service) TorrServer() *torrserver.Client { return s.ts }

// ---- streaming torrents (admin TorrServer list: "in use") ----

var (
	streamingMu sync.Mutex
	streaming   = map[string]int{} // info hash → open proxied streams
)

// trackStream marks hash as streamed until the returned func is called.
func trackStream(hash string) func() {
	if hash == "" {
		return func() {}
	}
	streamingMu.Lock()
	streaming[hash]++
	streamingMu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			streamingMu.Lock()
			if streaming[hash]--; streaming[hash] <= 0 {
				delete(streaming, hash)
			}
			streamingMu.Unlock()
		})
	}
}

// StreamingHashes returns the info hashes MartyTV is streaming right now
// (proxied TorrServer streams, local files, compat jobs, and HLS compat
// sessions requested within the last minute).
func (s *Service) StreamingHashes() map[string]bool {
	streamingMu.Lock()
	out := make(map[string]bool, len(streaming))
	for h := range streaming {
		out[h] = true
	}
	streamingMu.Unlock()
	s.hls.addTo(out)
	return out
}

// ---- source lookup for downloads ----

// ErrSourceNotFound: no such source, or the caller may not use it.
var ErrSourceNotFound = errors.New("playback source not found")

// SourceFile is a playback source as downloads needs it.
type SourceFile struct {
	ID           string
	Kind         string
	Status       string
	MediaID      string
	EpisodeID    *string
	InfoHash     string
	FileIndex    *int
	FilePath     string
	FileSize     int64
	ReleaseTitle string
	// Files: the torrent's classified files (season packs).
	Files []TorrentFile
}

// SourceFor returns a source the principal may use (same rules as GET
// /playback/sources/{id}); ErrSourceNotFound otherwise.
func (s *Service) SourceFor(ctx context.Context, p *auth.Principal, id string) (*SourceFile, error) {
	who := caller{UserID: p.UserID}
	if p.Kind == auth.KindDevice {
		who.DeviceID = p.DeviceID
	}
	src, err := s.load(ctx, who, id)
	if err != nil {
		var ae *apiError
		if errors.As(err, &ae) && ae.Status == http.StatusNotFound {
			return nil, ErrSourceNotFound
		}
		return nil, err
	}
	out := &SourceFile{ID: src.ID, Kind: src.Kind, Status: src.Status, MediaID: src.MediaID, EpisodeID: src.EpisodeID,
		InfoHash: src.InfoHash, FileIndex: src.FileIndex, FilePath: deref(src.FilePath), ReleaseTitle: src.Release.Title,
		Files: classify(src.Files)}
	if src.FileSize != nil {
		out.FileSize = *src.FileSize
	}
	return out, nil
}

// EnsureTorrent makes sure TorrServer knows the torrent (it may have been
// removed there, e.g. from Lampa or the admin list): re-adds it from the
// stored magnet of any source with that hash, else a bare magnet.
func (s *Service) EnsureTorrent(ctx context.Context, hash string) error {
	if !torrserver.ValidHash(hash) {
		return torrserver.ErrNotFound
	}
	if _, err := s.ts.Get(ctx, hash); err == nil || !errors.Is(err, torrserver.ErrNotFound) {
		return err
	}
	var magnet, title string
	_ = s.pool.QueryRow(ctx, `SELECT COALESCE(magnet, ''), COALESCE(release->>'title', '') FROM playback_sources
		WHERE kind = 'torrent' AND info_hash = $1 ORDER BY magnet IS NULL, updated_at DESC LIMIT 1`, hash).Scan(&magnet, &title)
	if magnet == "" {
		magnet = "magnet:?xt=urn:btih:" + hash
	}
	_, err := s.ts.Add(ctx, torrserver.AddRequest{Link: magnet, Title: title, SaveToDB: true})
	return err
}

// ---- playing from disk ----

// localFor returns the source file's completed download when it is intact.
func (s *Service) localFor(ctx context.Context, src *source) *LocalFile {
	if s.lib == nil || src.Kind == "online" || src.FileIndex == nil {
		return nil
	}
	lf, ok := s.lib.LocalFile(ctx, src.InfoHash, *src.FileIndex)
	if !ok {
		return nil
	}
	st, err := os.Stat(lf.Path)
	if err != nil || !st.Mode().IsRegular() || st.Size() != lf.Size {
		return nil
	}
	if lf.ModTime.IsZero() {
		lf.ModTime = st.ModTime()
	}
	return lf
}

// internalAuth is the Authorization value the transcoder sends when it reads
// a downloaded file through /api/v1/stream/<token> for a compat job. It binds
// to the token and is derived from APP_SESSION_SECRET, so clients can't
// forge it; it only marks the read as internal (not an extra active stream).
func (s *Service) internalAuth(token string) string {
	m := hmac.New(sha256.New, s.signer.key)
	m.Write([]byte("internal-read\x00" + token))
	return "MartyTV-Internal " + hex.EncodeToString(m.Sum(nil))[:40]
}

func (s *Service) isInternalRead(c fiber.Ctx, token string) bool {
	got := c.Get(fiber.HeaderAuthorization)
	return got != "" && hmac.Equal([]byte(got), []byte(s.internalAuth(token)))
}

// localCompatInput: the transcoder reads the downloaded file through the API.
func (s *Service) localCompatInput(src *source, lf *LocalFile) (compatJob, bool) {
	if s.cfg == nil || s.cfg.Library.InternalURL == "" {
		return compatJob{}, false
	}
	// Long enough for a whole film (ffmpeg reconnects with Range).
	tok, err := s.signer.Sign(src.ID, time.Now().Add(8*time.Hour))
	if err != nil {
		return compatJob{}, false
	}
	ext := strings.ToLower(path.Ext(deref(src.FilePath)))
	if len(ext) > 6 || strings.ContainsAny(ext, "/?#%") {
		ext = ""
	}
	return compatJob{Input: s.cfg.Library.InternalURL + "/api/v1/stream/" + tok + "/local" + ext, Auth: s.internalAuth(tok)}, true
}

// parseByteRange parses a single `bytes=` range against size. ok=false means
// 416; partial=false means the whole file (no or unsupported Range).
func parseByteRange(h string, size int64) (start, end int64, partial, ok bool) {
	start, end = 0, size-1
	m := singleRange.FindStringSubmatch(strings.TrimSpace(h))
	if m == nil || (m[1] == "" && m[2] == "") {
		return start, end, false, true
	}
	if m[1] == "" { // suffix range
		n, _ := strconv.ParseInt(m[2], 10, 64)
		if n <= 0 {
			return 0, 0, true, false
		}
		if n < size {
			start = size - n
		}
		return start, end, true, true
	}
	start, _ = strconv.ParseInt(m[1], 10, 64)
	if m[2] != "" {
		end, _ = strconv.ParseInt(m[2], 10, 64)
	}
	if end >= size {
		end = size - 1
	}
	if start >= size || start > end {
		return 0, 0, true, false
	}
	return start, end, true, true
}

// fileBody is a section of an open file; Close closes the file.
type fileBody struct {
	io.Reader
	f *os.File
}

func (b fileBody) Close() error { return b.f.Close() }

// serveLocal answers a stream request from the downloaded file with
// http.ServeContent semantics (single Range, If-Range, 206/416, HEAD).
// handled=false falls back to TorrServer (file unreadable).
func (h *Handlers) serveLocal(c fiber.Ctx, token string, src *source, lf *LocalFile, mime string, log *slog.Logger) (bool, error) {
	f, err := os.Open(lf.Path)
	if err != nil {
		log.Warn("local file unreadable; streaming from torrserver", "download_id", lf.DownloadID, "err", err)
		return false, nil
	}
	size := lf.Size
	etag := `"` + strings.ReplaceAll(lf.DownloadID, "-", "")[:16] + "-" + strconv.FormatInt(size, 36) + `"`
	lastMod := lf.ModTime.UTC().Format(http.TimeFormat)
	c.Set(fiber.HeaderContentType, mime)
	c.Set("Accept-Ranges", "bytes")
	c.Set(fiber.HeaderETag, etag)
	c.Set(fiber.HeaderLastModified, lastMod)

	start, end, partial, ok := parseByteRange(c.Get(fiber.HeaderRange), size)
	if ir := strings.TrimSpace(c.Get(fiber.HeaderIfRange)); partial && ir != "" && ir != etag && ir != lastMod {
		start, end, partial, ok = 0, size-1, false, true // validator changed: whole file
	}
	if !ok {
		f.Close()
		return true, rangeNotSatisfiable(c, size)
	}
	n := end - start + 1
	if partial {
		c.Status(fiber.StatusPartialContent)
		c.Set("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(size, 10))
	} else {
		c.Status(fiber.StatusOK)
	}
	if c.Method() == fiber.MethodHead {
		f.Close()
		c.Response().Header.SetContentLength(int(n))
		c.Response().SkipBody = true
		return true, nil
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		f.Close()
		return false, nil
	}
	internal := h.svc.isInternalRead(c, token)
	if !internal {
		h.svc.lib.Watched(lf.DownloadID)
	}
	ir := &idleReader{r: fileBody{Reader: io.LimitReader(f, n), f: f}, cancel: func() {}, idle: h.svc.t.StreamIdle,
		uncounted: internal, meta: newStreamMeta(c, log, "local"), opened: time.Now()}
	ir.timer = time.AfterFunc(ir.idle, ir.onIdle)
	ir.timer.Stop()
	if !internal {
		activeStreams.Add(1)
		ir.onClose = trackStream(src.InfoHash)
	}
	return true, c.SendStream(ir, int(n))
}

// createFromLibrary creates (or revives) a ready source without TorrServer
// when the file it would select is already downloaded. The file list comes
// from another source of the same torrent. nil = take the normal path.
func (s *Service) createFromLibrary(ctx context.Context, row *source, hash, magnet string, tgt target, log *slog.Logger) *source {
	if s.lib == nil || !s.lib.HasCompleted(ctx, hash) {
		return nil
	}
	files, err := s.st.filesForHash(ctx, hash)
	if err != nil || len(files) == 0 {
		return nil
	}
	f, ok := selectFile(classify(files), tgt)
	if !ok {
		return nil
	}
	if _, ok := s.lib.LocalFile(ctx, hash, f.Index); !ok {
		return nil
	}
	r := *row
	r.InfoHash = hash
	if strings.HasPrefix(strings.ToLower(magnet), "magnet:") {
		r.Magnet = &magnet
	}
	src, _, err := s.st.insertOrGet(ctx, &r)
	if err != nil {
		return nil
	}
	if src.Status != "ready" {
		if s.st.setFiles(ctx, src.ID, files) != nil || s.st.setReady(ctx, src.ID, f) != nil {
			return nil
		}
		if src, err = s.st.get(ctx, src.ID); err != nil {
			return nil
		}
	}
	log.Info("playback source from library", "source_id", src.ID, "file_index", f.Index)
	return src
}

// Extra reports samples, trailers and bonus material.
func (f TorrentFile) Extra() bool { return f.extra }
