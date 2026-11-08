package video

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/httpx"
)

// Thumbnail proxy: video thumbnails (/vi/<id>/<name>.jpg) and channel
// avatars/banners (/ggpht/<path>) are fetched from Invidious (which reaches
// i.ytimg.com / yt3.ggpht.com through the VPN), kept in the disk cache
// (thumbcache.go: VIDEO_THUMB_CACHE_MB / _DAYS, LRU) and served same-origin
// with a week of immutable browser caching. Lists answered by /video/*
// queue their thumbnails for prefetch (warmThumbs), so the next row is
// usually on disk before the TV asks. Only those two shapes are accepted,
// so this is not an open proxy.

const (
	maxThumbBytes = 2 << 20
	thumbBadTTL   = 10 * time.Minute
	// YouTube keeps a thumbnail URL for the video's life (a new custom
	// thumbnail is rare): browsers and TVs keep it a week without asking.
	thumbCacheControl = "public, max-age=604800, immutable"
)

var thumbNames = regexp.MustCompile(`^(default|mqdefault|hqdefault|sddefault|maxresdefault|hq720|maxres|high|medium|start|middle|end|[1-3])\.jpg$`)

func (s *Service) thumbVideo(c fiber.Ctx) error {
	id, name := c.Params("id"), c.Params("name")
	if !ValidVideoID(id) || !thumbNames.MatchString(name) {
		return httpx.NotFound()
	}
	return s.serveThumb(c, "/vi/"+id+"/"+name)
}

func (s *Service) thumbGgpht(c fiber.Ctx) error {
	p := c.Params("*")
	if !validGgphtPath(p) {
		return httpx.NotFound()
	}
	return s.serveThumb(c, "/ggpht/"+p)
}

func (s *Service) serveThumb(c fiber.Ctx, path string) error {
	if !s.client.Configured() {
		return httpx.NotFound()
	}
	// Detached: a viewer scrolling away must not fail the others waiting on the same fetch.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Context()), thumbFetchWait)
	defer cancel()
	b, ct, err := s.thumbs.load(ctx, path)
	switch {
	case errors.Is(err, errThumbBad):
		return httpx.NotFound()
	case err != nil:
		return httpx.NewError(fiber.StatusBadGateway, "thumbnail_unavailable", "The image could not be loaded.")
	}
	return sendThumb(c, ct, b)
}

// warmThumbs queues the thumbnails of a list for prefetch: the cards' size
// (hqdefault: TV cards and the PWA grid) and, with small, the 320x180 one
// (the PWA's compact rows: related videos).
func (s *Service) warmThumbs(items []Item, small bool) {
	if !s.client.Configured() {
		return
	}
	paths := make([]string, 0, 2*len(items))
	for _, it := range items {
		for _, u := range []string{it.ThumbnailHD, it.Thumbnail} {
			if p, ok := strings.CutPrefix(u, thumbPrefix); ok && strings.HasPrefix(p, "vi/") {
				paths = append(paths, "/"+p)
			}
			if !small {
				break
			}
		}
	}
	s.thumbs.warm(paths...)
}

func (s *Service) fetchThumb(ctx context.Context, path string) (string, []byte, error) {
	u, err := s.client.Resolve(path)
	if err != nil {
		return "", nil, err
	}
	for i := 0; i < 3; i++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return "", nil, err
		}
		resp, err := s.client.HTTP().Do(req)
		if err != nil {
			return "", nil, err
		}
		if loc := resp.Header.Get("Location"); resp.StatusCode >= 300 && resp.StatusCode < 400 && loc != "" {
			resp.Body.Close()
			next, err := u.Parse(loc)
			if err != nil || !s.client.SameOrigin(next) {
				return "", nil, errors.New("redirect refused")
			}
			u = next
			continue
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return "", nil, errors.New("upstream " + resp.Status)
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, maxThumbBytes+1))
		if err != nil || len(b) == 0 || len(b) > maxThumbBytes {
			return "", nil, errors.New("thumbnail read failed")
		}
		ct := sniffThumb(b)
		if ct == "" {
			return "", nil, errors.New("not an image")
		}
		return ct, b, nil
	}
	return "", nil, errors.New("too many redirects")
}

func sniffThumb(b []byte) string {
	switch ct := http.DetectContentType(b); ct {
	case "image/jpeg", "image/png", "image/webp", "image/gif":
		return ct
	}
	return ""
}

func sendThumb(c fiber.Ctx, ct string, b []byte) error {
	sum := sha256.Sum256(b)
	etag := `"` + hex.EncodeToString(sum[:8]) + `"`
	c.Set(fiber.HeaderCacheControl, thumbCacheControl)
	c.Set(fiber.HeaderETag, etag)
	c.Set("X-Content-Type-Options", "nosniff")
	if inm := c.Get(fiber.HeaderIfNoneMatch); inm != "" && strings.Contains(inm, etag) {
		return c.SendStatus(fiber.StatusNotModified)
	}
	c.Set(fiber.HeaderContentType, ct)
	return c.Send(b)
}
