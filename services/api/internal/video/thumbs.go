package video

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/httpx"
)

// Thumbnail proxy: video thumbnails (/vi/<id>/<name>.jpg) and channel
// avatars/banners (/ggpht/<path>) are fetched from Invidious (which reaches
// i.ytimg.com / yt3.ggpht.com through the VPN), cached on disk under
// ThumbDir/<sha256> for 7 days and served same-origin. Only those two
// shapes are accepted, so this is not an open proxy.

const (
	maxThumbBytes = 2 << 20
	thumbBadTTL   = 10 * time.Minute
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
	key := sha256.Sum256([]byte(path))
	name := hex.EncodeToString(key[:])
	var file string
	if s.thumbDir != "" {
		file = filepath.Join(s.thumbDir, name[:2], name)
		if b, err := os.ReadFile(file); err == nil {
			if ct := sniffThumb(b); ct != "" {
				return sendThumb(c, ct, b)
			}
		}
	}
	if at, ok := s.thumbBad.Load(name); ok && time.Since(at.(time.Time)) < thumbBadTTL {
		return httpx.NotFound()
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Context()), 15*time.Second)
	defer cancel()
	ct, b, err := s.fetchThumb(ctx, path)
	if err != nil {
		s.thumbBad.Store(name, time.Now())
		return httpx.NewError(fiber.StatusBadGateway, "thumbnail_unavailable", "The image could not be loaded.")
	}
	if file != "" {
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err == nil {
			tmp := file + ".tmp"
			if os.WriteFile(tmp, b, 0o644) == nil {
				_ = os.Rename(tmp, file)
			}
		}
	}
	return sendThumb(c, ct, b)
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
	c.Set(fiber.HeaderContentType, ct)
	c.Set(fiber.HeaderCacheControl, "public, max-age=86400")
	c.Set("X-Content-Type-Options", "nosniff")
	return c.Send(b)
}
