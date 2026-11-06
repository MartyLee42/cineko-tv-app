package catalog

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"golang.org/x/sync/singleflight"

	"martytv/api/internal/config"
	"martytv/api/internal/httpx"
	"martytv/api/internal/integrations/tmdb"
)

// The proxy only accepts TMDB sizes and plain file names, so it can't be used
// to fetch arbitrary URLs or escape the cache directory.
var (
	imageSizes = map[string]bool{
		"w92": true, "w154": true, "w185": true, "w300": true, "w342": true,
		"w500": true, "w780": true, "w1280": true, "h632": true, "original": true,
	}
	imageFile = regexp.MustCompile(`^[A-Za-z0-9_-]+\.(jpg|png|svg)$`)
	imageType = map[string]string{".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml"}
)

const maxImageBytes = 10 << 20

var (
	errImageNotFound = errors.New("image not found")
	errImageUpstream = errors.New("image upstream failed")
)

// ImageProxy serves TMDB images from a disk cache, fetching misses from
// TMDB_IMAGE_BASE_URL (through TMDB_PROXY_URL when set). It needs no TMDB
// credentials. Files are immutable on TMDB (new art gets a new name), so the
// cache never revalidates.
type ImageProxy struct {
	base   string
	dir    string
	client *http.Client
	group  singleflight.Group
	log    *slog.Logger
}

func NewImageProxy(tmdbCfg config.TMDBConfig, dir string, log *slog.Logger) *ImageProxy {
	return &ImageProxy{base: tmdbCfg.ImageBaseURL, dir: dir, client: tmdb.HTTPClient(tmdbCfg, 20*time.Second), log: log}
}

// Handle is GET /api/v1/images/{size}/{file}. It is public: TV <img> tags
// can't send bearer tokens, and the images are public TMDB artwork anyway.
func (p *ImageProxy) Handle(c fiber.Ctx) error {
	size, file := strings.Clone(c.Params("size")), strings.Clone(c.Params("file"))
	if !imageSizes[size] || !imageFile.MatchString(file) {
		return httpx.NotFound()
	}
	path := filepath.Join(p.dir, size, file)
	body, err := os.ReadFile(path)
	if err != nil {
		v, ferr, _ := p.group.Do(size+"/"+file, func() (any, error) {
			// Detached: a cancelled first viewer must not fail the others.
			ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Context()), 25*time.Second)
			defer cancel()
			return p.fetch(ctx, size, file, path)
		})
		switch {
		case errors.Is(ferr, errImageNotFound):
			return httpx.NotFound()
		case ferr != nil:
			p.log.WarnContext(c.Context(), "image fetch failed", "size", size, "file", file, "err", ferr)
			return httpx.NewError(fiber.StatusBadGateway, "image_unavailable", "The image could not be loaded.")
		}
		body = v.([]byte)
	}
	c.Set(fiber.HeaderContentType, imageType[filepath.Ext(file)])
	c.Set(fiber.HeaderCacheControl, "public, max-age=2592000, immutable")
	c.Set("X-Content-Type-Options", "nosniff")
	if strings.HasSuffix(file, ".svg") {
		// SVG can carry script; never let it run in our origin.
		c.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	}
	return c.Send(body)
}

func (p *ImageProxy) fetch(ctx context.Context, size, file, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.base+"/"+size+"/"+file, nil)
	if err != nil {
		return nil, errImageUpstream
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: transport", errImageUpstream)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, errImageNotFound
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("%w: HTTP %d", errImageUpstream, resp.StatusCode)
	}
	mt, _, _ := mime.ParseMediaType(resp.Header.Get(fiber.HeaderContentType))
	if !strings.HasPrefix(mt, "image/") {
		return nil, fmt.Errorf("%w: content type %q", errImageUpstream, mt)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxImageBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: read", errImageUpstream)
	}
	if len(body) > maxImageBytes {
		return nil, fmt.Errorf("%w: too large", errImageUpstream)
	}
	// Cache write failures only cost a re-fetch; still serve the image.
	if err := writeAtomic(path, body); err != nil {
		p.log.Warn("image cache write failed", "err", err)
	}
	return body, nil
}

// writeAtomic writes via a temp file + rename so readers never see a
// partial image.
func writeAtomic(path string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}
