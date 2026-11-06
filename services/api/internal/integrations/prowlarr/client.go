// Package prowlarr is a small client for the Prowlarr v1 API (verified
// against Prowlarr 2.4.0 with RuTracker, RuTor, NoNaMe Club, BigFANGroup and
// ExKinoRay).
//
// Verified behaviour this client relies on:
//   - GET /api/v1/search?query=&type=search[&indexerIds=][&categories=][&limit=]
//     returns a flat JSON array of releases. Per-indexer failures are NOT
//     reported in the response: Prowlarr logs them and records them in
//     GET /api/v1/indexerstatus (mostRecentFailure / disabledTill). A search
//     where every selected indexer is unavailable returns HTTP 400.
//   - The RU trackers only support free-text `q` (RuTor also imdbId), so
//     callers search by text. The `categories` filter must NOT be used: RuTor
//     tags every result as 8000 (Other), so categories=2000/5000 drops it.
//   - Only RuTor returns infoHash; the others return downloadUrl only.
//     downloadUrl and magnetUrl are Prowlarr proxy links carrying the API key
//     in the `apikey` query parameter (they serve the .torrent file or a 301 to
//     a magnet URI).
//
// The client sends the key in X-Api-Key, never follows redirects, rate
// limits itself, dedupes identical concurrent requests and never puts URLs
// (which can contain the key) in errors.
package prowlarr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"
	"golang.org/x/time/rate"

	"martytv/api/internal/config"
)

var (
	// ErrNotConfigured means PROWLARR_URL or PROWLARR_API_KEY is missing.
	ErrNotConfigured = errors.New("prowlarr: not configured")
	// ErrUnavailable is Prowlarr's 400 "all selected indexers being unavailable".
	ErrUnavailable = errors.New("prowlarr: all indexers unavailable")
)

// StatusError is any other unexpected HTTP status.
type StatusError struct{ Status int }

func (e *StatusError) Error() string { return fmt.Sprintf("prowlarr: unexpected HTTP %d", e.Status) }

const (
	maxBody = 16 << 20 // a 5-indexer search is ~0.5-1 MB
	// DefaultTimeout bounds one search: Prowlarr fans out to the trackers.
	DefaultTimeout = 25 * time.Second
)

// Release is one search result (fields Cineko reads).
type Release struct {
	GUID        string     `json:"guid"`
	Title       string     `json:"title"`
	Size        int64      `json:"size"`
	Seeders     *int       `json:"seeders"`
	Leechers    *int       `json:"leechers"`
	Indexer     string     `json:"indexer"`
	IndexerID   int        `json:"indexerId"`
	InfoHash    string     `json:"infoHash"`
	MagnetURL   string     `json:"magnetUrl"`
	DownloadURL string     `json:"downloadUrl"`
	InfoURL     string     `json:"infoUrl"`
	PublishDate *time.Time `json:"publishDate"`
	IMDbID      int        `json:"imdbId"`
	TMDBID      int        `json:"tmdbId"`
	Protocol    string     `json:"protocol"`
	Categories  []Category `json:"categories"`
}

type Category struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// CategoryIDs returns the release's category ids.
func (r *Release) CategoryIDs() []int {
	out := make([]int, 0, len(r.Categories))
	for _, c := range r.Categories {
		out = append(out, c.ID)
	}
	return out
}

// Indexer is an entry of GET /api/v1/indexer.
type Indexer struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Enable   bool   `json:"enable"`
	Protocol string `json:"protocol"`
}

// IndexerStatus is an entry of GET /api/v1/indexerstatus: indexers with
// recorded failures (and the backoff Prowlarr applies to them).
type IndexerStatus struct {
	IndexerID         int        `json:"indexerId"`
	DisabledTill      *time.Time `json:"disabledTill"`
	MostRecentFailure *time.Time `json:"mostRecentFailure"`
	InitialFailure    *time.Time `json:"initialFailure"`
}

// SearchRequest is a free-text search. Zero values are omitted.
type SearchRequest struct {
	Query      string
	Type       string // search (default), movie, tvsearch
	IndexerIDs []int
	Categories []int
	Limit      int
	Offset     int
}

func (r SearchRequest) values() url.Values {
	q := url.Values{}
	q.Set("query", r.Query)
	t := r.Type
	if t == "" {
		t = "search"
	}
	q.Set("type", t)
	for _, id := range r.IndexerIDs {
		q.Add("indexerIds", strconv.Itoa(id))
	}
	for _, c := range r.Categories {
		q.Add("categories", strconv.Itoa(c))
	}
	if r.Limit > 0 {
		q.Set("limit", strconv.Itoa(r.Limit))
	}
	if r.Offset > 0 {
		q.Set("offset", strconv.Itoa(r.Offset))
	}
	return q
}

// Client calls Prowlarr.
type Client struct {
	cfg     config.ProwlarrConfig
	http    *http.Client
	limiter *rate.Limiter
	group   singleflight.Group
}

// New returns a client; calls fail with ErrNotConfigured without URL and key.
func New(cfg config.ProwlarrConfig) *Client {
	return NewWithTimeout(cfg, DefaultTimeout)
}

// NewWithTimeout is New with a custom per-request timeout (tests).
func NewWithTimeout(cfg config.ProwlarrConfig, timeout time.Duration) *Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.DialContext = (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	tr.MaxIdleConnsPerHost = 8
	return &Client{
		cfg: cfg,
		http: &http.Client{
			Timeout:       timeout,
			Transport:     tr,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		// Each search fans out to every tracker; stay gentle with them.
		limiter: rate.NewLimiter(rate.Limit(4), 6),
	}
}

func (c *Client) Configured() bool { return c.cfg.URL != "" && c.cfg.APIKey != "" }

// Search runs a search. Identical concurrent searches share one request.
func (c *Client) Search(ctx context.Context, req SearchRequest) ([]Release, error) {
	var out []Release
	if err := c.get(ctx, "/api/v1/search", req.values(), &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Indexers lists configured indexers.
func (c *Client) Indexers(ctx context.Context) ([]Indexer, error) {
	var out []Indexer
	return out, c.get(ctx, "/api/v1/indexer", nil, &out)
}

// IndexerStatuses lists indexers with recorded failures.
func (c *Client) IndexerStatuses(ctx context.Context) ([]IndexerStatus, error) {
	var out []IndexerStatus
	return out, c.get(ctx, "/api/v1/indexerstatus", nil, &out)
}

func (c *Client) get(ctx context.Context, path string, q url.Values, out any) error {
	if !c.Configured() {
		return ErrNotConfigured
	}
	key := path + "?" + q.Encode()
	ch := c.group.DoChan(key, func() (any, error) {
		// Detached from one caller's cancellation so it can't fail the others.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.http.Timeout+time.Second)
		defer cancel()
		return c.once(ctx, path, q)
	})
	select {
	case <-ctx.Done():
		return sanitizeCtx(ctx.Err())
	case r := <-ch:
		if r.Err != nil {
			return r.Err
		}
		if err := json.Unmarshal(r.Val.([]byte), out); err != nil {
			return errors.New("prowlarr: invalid JSON response")
		}
		return nil
	}
}

func (c *Client) once(ctx context.Context, path string, q url.Values) ([]byte, error) {
	if err := c.limiter.Wait(ctx); err != nil {
		return nil, sanitizeCtx(err)
	}
	u := c.cfg.URL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, errors.New("prowlarr: bad request URL")
	}
	req.Header.Set("X-Api-Key", c.cfg.APIKey)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, sanitize(err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
		if err != nil {
			return nil, sanitize(err)
		}
		if len(b) > maxBody {
			return nil, errors.New("prowlarr: response too large")
		}
		return b, nil
	case http.StatusBadRequest:
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if strings.Contains(string(b), "indexers being unavailable") {
			return nil, ErrUnavailable
		}
		return nil, &StatusError{Status: resp.StatusCode}
	default:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil, &StatusError{Status: resp.StatusCode}
	}
}

// sanitize drops the URL from transport errors.
func sanitize(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		if ue.Timeout() {
			return errors.New("prowlarr: request timed out")
		}
		inner := errors.Unwrap(ue)
		var ne *net.OpError
		if errors.As(inner, &ne) {
			return fmt.Errorf("prowlarr: connection failed (%s)", ne.Op)
		}
		return errors.New("prowlarr: request failed")
	}
	return errors.New("prowlarr: request failed")
}

func sanitizeCtx(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return errors.New("prowlarr: request timed out")
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	return errors.New("prowlarr: request failed")
}

// StripKey removes the apikey query parameter from a Prowlarr proxy link so
// it can be stored; WithKey restores it. Links to other hosts are returned
// unchanged.
func (c *Client) StripKey(link string) string {
	u, ok := c.ownLink(link)
	if !ok {
		return link
	}
	q := u.Query()
	if !q.Has("apikey") {
		return link
	}
	q.Del("apikey")
	u.RawQuery = q.Encode()
	return u.String()
}

// WithKey adds the current API key to a Prowlarr proxy link.
func (c *Client) WithKey(link string) string {
	u, ok := c.ownLink(link)
	if !ok || c.cfg.APIKey == "" {
		return link
	}
	q := u.Query()
	q.Set("apikey", c.cfg.APIKey)
	u.RawQuery = q.Encode()
	return u.String()
}

func (c *Client) ownLink(link string) (*url.URL, bool) {
	if link == "" || c.cfg.URL == "" {
		return nil, false
	}
	base, err := url.Parse(c.cfg.URL)
	if err != nil {
		return nil, false
	}
	u, err := url.Parse(link)
	if err != nil || !strings.EqualFold(u.Host, base.Host) || u.Scheme != base.Scheme {
		return nil, false
	}
	return u, true
}
