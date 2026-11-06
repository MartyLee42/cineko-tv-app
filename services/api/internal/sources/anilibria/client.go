package anilibria

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultBaseURL is the public AniLiberty API (no key).
const DefaultBaseURL = "https://api.anilibria.app/api/v1"

const (
	requestTimeout  = 10 * time.Second
	maxBody         = 8 << 20 // a release with ~1000 episodes is ~1.5 MB
	minInterval     = 250 * time.Millisecond
	maxRetryAfter   = 30 * time.Second
	searchTTL       = 6 * time.Hour
	releaseTTL      = 20 * time.Minute // ongoing titles gain episodes
	cacheMaxEntries = 2000
)

var (
	errUnavailable = errors.New("anilibria: api unavailable")
	errRateLimited = errors.New("anilibria: rate limited")
	errNotFound    = errors.New("anilibria: not found")
)

// apiName is AniLiberty's name block.
type apiName struct {
	Main        string `json:"main"`
	English     string `json:"english"`
	Alternative string `json:"alternative"`
}

type apiValue struct {
	Value string `json:"value"`
}

type apiMarker struct {
	Start *float64 `json:"start"`
	Stop  *float64 `json:"stop"`
}

type apiEpisode struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	NameEnglish string     `json:"name_english"`
	Ordinal     float64    `json:"ordinal"`
	Opening     *apiMarker `json:"opening"`
	Ending      *apiMarker `json:"ending"`
	HLS480      string     `json:"hls_480"`
	HLS720      string     `json:"hls_720"`
	HLS1080     string     `json:"hls_1080"`
	Duration    float64    `json:"duration"`
	SortOrder   int        `json:"sort_order"`
}

// apiRelease covers both a search hit and a full release (episodes only in
// the latter).
type apiRelease struct {
	ID                    int          `json:"id"`
	Type                  *apiValue    `json:"type"`
	Year                  int          `json:"year"`
	Name                  apiName      `json:"name"`
	Alias                 string       `json:"alias"`
	EpisodesTotal         *int         `json:"episodes_total"`
	IsBlockedByGeo        bool         `json:"is_blocked_by_geo"`
	IsBlockedByCopyrights bool         `json:"is_blocked_by_copyrights"`
	Episodes              []apiEpisode `json:"episodes"`
}

func (r *apiRelease) typ() string {
	if r.Type == nil {
		return ""
	}
	return strings.ToUpper(r.Type.Value)
}

type cacheEntry[T any] struct {
	v   T
	exp time.Time
}

// ttlCache is a small bounded in-memory cache (entries expire; when full the
// expired ones are dropped first, then everything).
type ttlCache[T any] struct {
	mu sync.Mutex
	m  map[string]cacheEntry[T]
}

func newTTLCache[T any]() *ttlCache[T] { return &ttlCache[T]{m: map[string]cacheEntry[T]{}} }

func (c *ttlCache[T]) get(k string, now time.Time) (T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok || now.After(e.exp) {
		var zero T
		return zero, false
	}
	return e.v, true
}

func (c *ttlCache[T]) put(k string, v T, ttl time.Duration, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= cacheMaxEntries {
		for key, e := range c.m {
			if now.After(e.exp) {
				delete(c.m, key)
			}
		}
		if len(c.m) >= cacheMaxEntries {
			c.m = map[string]cacheEntry[T]{}
		}
	}
	c.m[k] = cacheEntry[T]{v: v, exp: now.Add(ttl)}
}

func (c *ttlCache[T]) drop(k string) {
	c.mu.Lock()
	delete(c.m, k)
	c.mu.Unlock()
}

// client talks to the AniLiberty API: GETs only, serialized to at most one
// request per minInterval, 429 → back off until Retry-After.
type client struct {
	http     *http.Client
	now      func() time.Time
	interval time.Duration // min spacing between requests

	mu        sync.Mutex
	base      string
	next      time.Time // earliest time for the next request
	blockedTo time.Time // after a 429

	searches *ttlCache[[]apiRelease]
	releases *ttlCache[*apiRelease]
}

func newClient(base string, hc *http.Client) *client {
	if hc == nil {
		hc = &http.Client{
			Timeout: requestTimeout,
			// The API never redirects; refuse instead of following anywhere.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	return &client{http: hc, now: time.Now, interval: minInterval, base: strings.TrimRight(base, "/"),
		searches: newTTLCache[[]apiRelease](), releases: newTTLCache[*apiRelease]()}
}

func (c *client) setBase(base string) {
	c.mu.Lock()
	c.base = strings.TrimRight(base, "/")
	c.mu.Unlock()
}

// wait reserves a request slot (rate limit).
func (c *client) wait(ctx context.Context) (string, error) {
	c.mu.Lock()
	now := c.now()
	if now.Before(c.blockedTo) {
		c.mu.Unlock()
		return "", errRateLimited
	}
	at := c.next
	if at.Before(now) {
		at = now
	}
	c.next = at.Add(c.interval)
	base := c.base
	c.mu.Unlock()
	if d := at.Sub(now); d > 0 {
		t := time.NewTimer(d)
		defer t.Stop()
		select {
		case <-t.C:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	return base, nil
}

func (c *client) getJSON(ctx context.Context, path string, q url.Values, out any) error {
	base, err := c.wait(ctx)
	if err != nil {
		return err
	}
	u := base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Cineko/1.0")
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("%w: timeout", errUnavailable)
		}
		return fmt.Errorf("%w: request failed", errUnavailable)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusTooManyRequests:
		d := maxRetryAfter
		if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s >= 0 && time.Duration(s)*time.Second < d {
			d = time.Duration(s) * time.Second
		}
		c.mu.Lock()
		c.blockedTo = c.now().Add(d)
		c.mu.Unlock()
		return errRateLimited
	case resp.StatusCode == http.StatusNotFound:
		return errNotFound
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("%w: status %d", errUnavailable, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return fmt.Errorf("%w: read failed", errUnavailable)
	}
	if len(b) > maxBody {
		return fmt.Errorf("%w: response too large", errUnavailable)
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("%w: bad json", errUnavailable)
	}
	return nil
}

// search runs app/search/releases (cached per normalized query).
func (c *client) search(ctx context.Context, query string) ([]apiRelease, error) {
	key := strings.ToLower(strings.TrimSpace(query))
	if key == "" {
		return nil, nil
	}
	if v, ok := c.searches.get(key, c.now()); ok {
		return v, nil
	}
	var out []apiRelease
	if err := c.getJSON(ctx, "/app/search/releases", url.Values{"query": {query}}, &out); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Episodes = nil // search hits carry none; keep the cache small
	}
	c.searches.put(key, out, searchTTL, c.now())
	return out, nil
}

// release fetches anime/releases/{id} with its episodes (cached briefly).
func (c *client) release(ctx context.Context, id int, fresh bool) (*apiRelease, error) {
	key := strconv.Itoa(id)
	if !fresh {
		if v, ok := c.releases.get(key, c.now()); ok {
			return v, nil
		}
	}
	var out apiRelease
	if err := c.getJSON(ctx, "/anime/releases/"+key, nil, &out); err != nil {
		return nil, err
	}
	if out.ID != id {
		return nil, fmt.Errorf("%w: unexpected release", errUnavailable)
	}
	c.releases.put(key, &out, releaseTTL, c.now())
	return &out, nil
}
