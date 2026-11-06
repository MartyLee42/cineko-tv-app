// Package tmdb is a small client for The Movie Database v3 API.
//
// It returns raw JSON bodies (the catalog caches them verbatim) plus typed
// structs for the responses Cineko reads. The client:
//   - authenticates with the v4 read access token (preferred) or the v3 api_key,
//   - never follows redirects and never puts URLs in errors (api_key may be
//     in the query string),
//   - rate limits itself (TMDB allows ~40-50 req/s; we stay well below),
//   - dedupes identical concurrent requests with singleflight,
//   - retries once on 429, honoring Retry-After,
//   - optionally routes through an HTTP(S)/SOCKS5 proxy (TMDB_PROXY_URL).
package tmdb

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"golang.org/x/sync/singleflight"
	"golang.org/x/time/rate"

	"martytv/api/internal/config"
)

var (
	// ErrNotFound is TMDB's 404 (unknown id or season).
	ErrNotFound = errors.New("tmdb: not found")
	// ErrNotConfigured means no TMDB credentials are set.
	ErrNotConfigured = errors.New("tmdb: not configured")
)

// StatusError is any other non-200 response.
type StatusError struct{ Status int }

func (e *StatusError) Error() string { return fmt.Sprintf("tmdb: unexpected HTTP %d", e.Status) }

const (
	maxBody      = 4 << 20 // tv details with aggregate_credits can exceed 1 MB
	maxRetryWait = 10 * time.Second
)

// HTTPClient builds an HTTP client for TMDB traffic (API and images): no
// redirects (SSRF hardening, keeps credentials on api.themoviedb.org) and the
// optional proxy from TMDB_PROXY_URL. Go's transport understands http, https,
// socks5 and socks5h proxy URLs.
func HTTPClient(cfg config.TMDBConfig, timeout time.Duration) *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil // ignore HTTP_PROXY env: routing is explicit config
	if cfg.ProxyURL != nil {
		tr.Proxy = http.ProxyURL(cfg.ProxyURL)
	}
	tr.DialContext = (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	tr.MaxIdleConnsPerHost = 16
	return &http.Client{
		Timeout:       timeout,
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// Client calls the TMDB v3 API.
type Client struct {
	cfg     config.TMDBConfig
	http    *http.Client
	limiter *rate.Limiter
	group   singleflight.Group
	// sleep is replaceable in tests.
	sleep func(context.Context, time.Duration) error
}

// New returns a client. It works without credentials but every call then
// fails with ErrNotConfigured; check Configured first.
func New(cfg config.TMDBConfig) *Client {
	return &Client{
		cfg:     cfg,
		http:    HTTPClient(cfg, 8*time.Second),
		limiter: rate.NewLimiter(rate.Limit(25), 25),
		sleep:   sleepCtx,
	}
}

func (c *Client) Configured() bool { return c.cfg.Configured() }

// Get fetches path (e.g. "/movie/603") with query and returns the raw body.
// Identical concurrent calls share one HTTP request. The shared request runs
// detached from any single caller's cancellation so one impatient caller
// can't fail the others; each caller still stops waiting when its ctx ends.
func (c *Client) Get(ctx context.Context, path string, query url.Values) ([]byte, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	key := path + "?" + query.Encode()
	ch := c.group.DoChan(key, func() (any, error) {
		return c.do(context.WithoutCancel(ctx), path, query)
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case r := <-ch:
		if r.Err != nil {
			return nil, r.Err
		}
		return r.Val.([]byte), nil
	}
}

func (c *Client) do(ctx context.Context, path string, query url.Values) ([]byte, error) {
	for attempt := 0; ; attempt++ {
		if err := c.limiter.Wait(ctx); err != nil {
			return nil, err
		}
		body, retryAfter, err := c.once(ctx, path, query)
		if retryAfter > 0 && attempt == 0 {
			if err := c.sleep(ctx, retryAfter); err != nil {
				return nil, err
			}
			continue
		}
		return body, err
	}
}

// once performs a single request. A positive duration means "429, retry after".
func (c *Client) once(ctx context.Context, path string, query url.Values) ([]byte, time.Duration, error) {
	q := url.Values{}
	for k, v := range query {
		q[k] = v
	}
	if c.cfg.AccessToken == "" {
		q.Set("api_key", c.cfg.APIKey)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.BaseURL+path+"?"+q.Encode(), nil)
	if err != nil {
		return nil, 0, errors.New("tmdb: bad request path")
	}
	req.Header.Set("Accept", "application/json")
	if c.cfg.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.AccessToken)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, sanitize(err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
		if err != nil {
			return nil, 0, sanitize(err)
		}
		if len(b) > maxBody {
			return nil, 0, errors.New("tmdb: response too large")
		}
		return b, 0, nil
	case http.StatusNotFound:
		return nil, 0, ErrNotFound
	case http.StatusTooManyRequests:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil, retryAfter(resp.Header.Get("Retry-After")), &StatusError{Status: resp.StatusCode}
	default:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil, 0, &StatusError{Status: resp.StatusCode}
	}
}

func retryAfter(h string) time.Duration {
	d := time.Second
	if n, err := strconv.Atoi(h); err == nil && n >= 0 {
		d = time.Duration(n) * time.Second
	}
	if d <= 0 {
		d = 100 * time.Millisecond
	}
	return min(d, maxRetryWait)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// sanitize drops the URL (which may include api_key) from transport errors.
func sanitize(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		if ue.Timeout() {
			return errors.New("tmdb: request timed out")
		}
		return fmt.Errorf("tmdb: request failed: %s", errors.Unwrap(ue).Error())
	}
	return errors.New("tmdb: request failed")
}

// Language maps a catalog language to a TMDB locale.
func Language(lang string) string {
	if lang == "ru" {
		return "ru-RU"
	}
	return "en-US"
}

// MediaType maps a Cineko kind to TMDB's path segment.
func MediaType(kind string) string {
	if kind == "series" {
		return "tv"
	}
	return "movie"
}

// Kind maps TMDB's media_type to a Cineko kind ("" for people and unknowns).
func Kind(mediaType string) string {
	switch mediaType {
	case "movie":
		return "movie"
	case "tv":
		return "series"
	}
	return ""
}
