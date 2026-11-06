package iptv

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/httpx"
)

// Channel logos are fetched server-side from the URL in the channel's
// playlist (never from a client-supplied URL), cached on disk under
// <LogoDir>/<sha256(url)> and served same-origin: many logo hosts
// (i.imgur.com…) are unreachable from TVs or blocked in the server's region,
// so the fetch falls back to the proxy like playlists do.

const (
	maxLogoBytes = 1 << 20
	// A failed logo isn't retried for an hour (10 min after a 429/5xx, which
	// are usually rate limits of a burst), and lists send logo_url: null
	// meanwhile so clients show the channel's initial.
	logoBadTTL     = time.Hour
	logoRetryTTL   = 10 * time.Minute
	logoFetchLimit = 20 * time.Second
)

var logoTypes = map[string]string{
	"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg",
}

func (s *Service) logo(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	var logo *string
	var via bool
	err = s.pool.QueryRow(c.Context(), `SELECT c.logo, p.via_proxy FROM iptv_channels c JOIN iptv_playlists p ON p.id = c.playlist_id
		WHERE c.id = $1`, id).Scan(&logo, &via)
	if err != nil || logo == nil || *logo == "" {
		return httpx.NotFound()
	}
	name := logoKey(*logo)
	if s.logoDir == "" {
		return httpx.NotFound()
	}
	dir := filepath.Join(s.logoDir, name[:2])
	for ct, ext := range logoTypes {
		if b, err := os.ReadFile(filepath.Join(dir, name+ext)); err == nil {
			return sendLogo(c, ct, b)
		}
	}
	if s.logoFailed(*logo) {
		c.Set(fiber.HeaderCacheControl, "public, max-age=600")
		return httpx.NotFound()
	}
	// One fetch per URL (a page shows dozens of logos of the same host at
	// once), at most cap(logoSem) at a time so hosts like i.imgur.com don't
	// rate-limit the burst.
	u := *logo
	v, err, _ := s.logoSF.Do(name, func() (any, error) {
		ctx, cancel := context.WithTimeout(context.Background(), logoFetchLimit)
		defer cancel()
		select {
		case s.logoSem <- struct{}{}:
		case <-ctx.Done():
			return nil, errLogoBusy
		}
		defer func() { <-s.logoSem }()
		ct, b, err := s.fetchLogo(ctx, u, via)
		if err != nil {
			s.markLogoBad(u, err)
			return nil, err
		}
		if err := os.MkdirAll(dir, 0o755); err == nil {
			tmp := filepath.Join(dir, name+".tmp")
			if os.WriteFile(tmp, b, 0o644) == nil {
				_ = os.Rename(tmp, filepath.Join(dir, name+logoTypes[ct]))
			}
		}
		return logoBody{ct, b}, nil
	})
	if err != nil {
		if errors.Is(err, errLogoBusy) {
			return httpx.NewError(fiber.StatusServiceUnavailable, "logo_busy", "Too many logos are loading; try again.")
		}
		return httpx.NewError(fiber.StatusBadGateway, "logo_unavailable", "The logo could not be loaded.")
	}
	lb := v.(logoBody)
	return sendLogo(c, lb.ct, lb.b)
}

type logoBody struct {
	ct string
	b  []byte
}

var errLogoBusy = errors.New("logo fetch queue full")

func logoKey(u string) string {
	h := sha256.Sum256([]byte(u))
	return hex.EncodeToString(h[:])
}

// logoFailed: the logo URL failed recently (lists then omit logo_url).
func (s *Service) logoFailed(u string) bool {
	s.logoMu.Lock()
	defer s.logoMu.Unlock()
	until, ok := s.logoBad[logoKey(u)]
	return ok && time.Now().Before(until)
}

func (s *Service) markLogoBad(u string, err error) {
	ttl := logoBadTTL
	var fe *fetchError
	if errors.As(err, &fe) && (fe.Status == http.StatusTooManyRequests || fe.Status >= 500 || fe.Status == 0) {
		ttl = logoRetryTTL // rate limit, outage or timeout: retry sooner
	}
	s.logoMu.Lock()
	if len(s.logoBad) > 20000 {
		s.logoBad = map[string]time.Time{}
	}
	s.logoBad[logoKey(u)] = time.Now().Add(ttl)
	s.logoMu.Unlock()
}

func sendLogo(c fiber.Ctx, ct string, b []byte) error {
	c.Set(fiber.HeaderContentType, ct)
	c.Set(fiber.HeaderCacheControl, "public, max-age=86400")
	c.Set("X-Content-Type-Options", "nosniff")
	if ct == "image/svg+xml" {
		c.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	}
	return c.Send(b)
}

func (s *Service) fetchLogo(ctx context.Context, u string, viaProxy bool) (string, []byte, error) {
	body, _, err := s.short.open(ctx, u, viaProxy, nil)
	if err != nil {
		return "", nil, err
	}
	defer body.Close()
	b, err := io.ReadAll(&limitReader{r: body, n: maxLogoBytes})
	if err != nil || len(b) == 0 {
		return "", nil, errors.New("logo read failed")
	}
	ct := sniffImage(b)
	if ct == "" {
		return "", nil, errors.New("not an image")
	}
	return ct, b, nil
}

// sniffImage accepts only real images (content sniffing, not the
// upstream header).
func sniffImage(b []byte) string {
	ct := http.DetectContentType(b)
	if i := strings.IndexByte(ct, ';'); i > 0 {
		ct = ct[:i]
	}
	if _, ok := logoTypes[ct]; ok && ct != "image/svg+xml" {
		return ct
	}
	head := bytes.ToLower(b[:min(len(b), 4096)])
	if bytes.Contains(head, []byte("<svg")) {
		return "image/svg+xml"
	}
	return ""
}
