// Package webfetch is the small HTTP client the scraping online providers
// (CDNVideoHub, Collaps) share: GET only, per-provider rate limit, timeout,
// body cap, 429 back-off, no redirects to elsewhere, plus a bounded TTL
// cache. Errors never include upstream URLs (they end up in provider health
// and logs).
package webfetch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// UserAgent is a desktop browser UA: the balancer APIs serve browsers.
const UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

const maxRetryAfter = 30 * time.Second

var (
	// ErrUnavailable: network error, timeout, 5xx or garbage.
	ErrUnavailable = errors.New("upstream unavailable")
	// ErrRateLimited: upstream answered 429 (or we are backing off after one).
	ErrRateLimited = errors.New("upstream rate limited")
	// ErrNotFound: upstream answered 404.
	ErrNotFound = errors.New("upstream: not found")
)

// Client is safe for concurrent use.
type Client struct {
	HTTP     *http.Client
	Now      func() time.Time
	Interval time.Duration // min spacing between requests
	Timeout  time.Duration // per request
	MaxBody  int64

	mu        sync.Mutex
	next      time.Time
	blockedTo time.Time
}

// New builds a client. hc nil = a client that refuses redirects.
func New(hc *http.Client, interval, timeout time.Duration, maxBody int64) *Client {
	if hc == nil {
		hc = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &Client{HTTP: hc, Now: time.Now, Interval: interval, Timeout: timeout, MaxBody: maxBody}
}

func (c *Client) wait(ctx context.Context) error {
	c.mu.Lock()
	now := c.Now()
	if now.Before(c.blockedTo) {
		c.mu.Unlock()
		return ErrRateLimited
	}
	at := c.next
	if at.Before(now) {
		at = now
	}
	c.next = at.Add(c.Interval)
	c.mu.Unlock()
	if d := at.Sub(now); d > 0 {
		t := time.NewTimer(d)
		defer t.Stop()
		select {
		case <-t.C:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// Get fetches u. A 404 returns ErrNotFound together with the body (some
// APIs explain "not available" in it).
func (c *Client) Get(ctx context.Context, u string, headers map[string]string) ([]byte, error) {
	if err := c.wait(ctx); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: bad url", ErrUnavailable)
	}
	req.Header.Set("User-Agent", UserAgent)
	req.Header.Set("Accept-Language", "ru-RU,ru;q=0.9,en;q=0.5")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("%w: timeout", ErrUnavailable)
		}
		return nil, fmt.Errorf("%w: request failed", ErrUnavailable)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		d := maxRetryAfter
		if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s >= 0 && time.Duration(s)*time.Second < d {
			d = time.Duration(s) * time.Second
		}
		c.mu.Lock()
		c.blockedTo = c.Now().Add(d)
		c.mu.Unlock()
		return nil, ErrRateLimited
	}
	b, rerr := io.ReadAll(io.LimitReader(resp.Body, c.MaxBody+1))
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return b, ErrNotFound
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("%w: status %d", ErrUnavailable, resp.StatusCode)
	case rerr != nil:
		return nil, fmt.Errorf("%w: read failed", ErrUnavailable)
	case int64(len(b)) > c.MaxBody:
		return nil, fmt.Errorf("%w: response too large", ErrUnavailable)
	}
	return b, nil
}

// ---------------------------------------------------------------- cache

type entry[T any] struct {
	v   T
	exp time.Time
}

// Cache is a small bounded TTL cache (when full: drop expired, then all).
type Cache[T any] struct {
	max int
	mu  sync.Mutex
	m   map[string]entry[T]
}

func NewCache[T any](max int) *Cache[T] { return &Cache[T]{max: max, m: map[string]entry[T]{}} }

func (c *Cache[T]) Get(k string, now time.Time) (T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok || !now.Before(e.exp) {
		var zero T
		return zero, false
	}
	return e.v, true
}

func (c *Cache[T]) Put(k string, v T, until time.Time, now time.Time) {
	if !until.After(now) {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= c.max {
		for key, e := range c.m {
			if !now.Before(e.exp) {
				delete(c.m, key)
			}
		}
		if len(c.m) >= c.max {
			c.m = map[string]entry[T]{}
		}
	}
	c.m[k] = entry[T]{v: v, exp: until}
}

func (c *Cache[T]) Drop(k string) {
	c.mu.Lock()
	delete(c.m, k)
	c.mu.Unlock()
}

// ChooseQuality picks from a descending list: exact, else the best below,
// else the lowest above; want 0 = best. 0 when have is empty.
func ChooseQuality(have []int, want int) int {
	if len(have) == 0 {
		return 0
	}
	if want <= 0 {
		return have[0]
	}
	for _, q := range have {
		if q <= want {
			return q
		}
	}
	return have[len(have)-1]
}
