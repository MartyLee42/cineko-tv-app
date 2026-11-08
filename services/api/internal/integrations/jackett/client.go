// Package jackett is a small client for Jackett's JSON search API, the
// alternative torrent search backend to Prowlarr (INDEXER=jackett).
//
// Behaviour this client relies on:
//   - GET /api/v2.0/indexers/all/results?apikey=&Query= searches every
//     configured indexer and answers {"Results": [...], "Indexers": [...]}.
//     Indexers[].Error is set for an indexer whose search failed (the others'
//     results are still returned).
//   - The "all" search waits for the slowest indexer (a blocked tracker
//     makes it take minutes), so Cineko lists the configured indexers
//     (torznab t=indexers&configured=true on "all") and searches each one
//     through /api/v2.0/indexers/{id}/results with its own deadline.
//   - GET /api/v2.0/indexers/all/results/torznab/api?t=caps&apikey= is a cheap
//     authenticated check (torznab capabilities XML).
//   - Download links (Results[].Link) are Jackett proxy links carrying the
//     key in the `jackett_apikey` query parameter; MagnetUri is set when the
//     tracker gives a magnet.
//
// The key travels only in the query string Jackett requires; URLs never
// appear in errors.
package jackett

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"
	"golang.org/x/time/rate"

	"martytv/api/internal/config"
)

var ErrNotConfigured = errors.New("jackett: not configured")

// StatusError is an unexpected HTTP status.
type StatusError struct{ Status int }

func (e *StatusError) Error() string { return fmt.Sprintf("jackett: unexpected HTTP %d", e.Status) }

const (
	maxBody = 16 << 20
	// DefaultTimeout bounds one request.
	DefaultTimeout = 25 * time.Second
	linkKeyParam   = "jackett_apikey"
)

// IndexerTimeout bounds one indexer's search: below the releases search
// deadline (25 s), so a slow tracker becomes a warning while the others'
// results still arrive. A variable for tests.
var IndexerTimeout = 20 * time.Second

// Result is one search result (fields Cineko reads).
type Result struct {
	Title       string     `json:"Title"`
	GUID        string     `json:"Guid"`
	Link        string     `json:"Link"`
	MagnetURI   string     `json:"MagnetUri"`
	InfoHash    string     `json:"InfoHash"`
	Size        int64      `json:"Size"`
	Seeders     *int       `json:"Seeders"`
	Peers       *int       `json:"Peers"`
	PublishDate *time.Time `json:"PublishDate"`
	Tracker     string     `json:"Tracker"`
	TrackerID   string     `json:"TrackerId"`
	Category    []int      `json:"Category"`
	IMDb        *int64     `json:"Imdb"`
}

// Leechers is Peers − Seeders (Jackett's Peers counts both), when known.
func (r *Result) Leechers() *int {
	if r.Peers == nil {
		return nil
	}
	n := *r.Peers
	if r.Seeders != nil {
		n -= *r.Seeders
	}
	if n < 0 {
		n = 0
	}
	return &n
}

// IndexerResult is a per-indexer outcome of a search.
type IndexerResult struct {
	ID      string  `json:"ID"`
	Name    string  `json:"Name"`
	Results int     `json:"Results"`
	Error   *string `json:"Error"`
}

// SearchResponse is GET /api/v2.0/indexers/all/results.
type SearchResponse struct {
	Results  []Result        `json:"Results"`
	Indexers []IndexerResult `json:"Indexers"`
}

// Client calls Jackett.
type Client struct {
	cfg     config.JackettConfig
	http    *http.Client
	limiter *rate.Limiter
	group   singleflight.Group
}

func New(cfg config.JackettConfig) *Client { return NewWithTimeout(cfg, DefaultTimeout) }

// NewWithTimeout is New with a custom per-request timeout (tests).
func NewWithTimeout(cfg config.JackettConfig, timeout time.Duration) *Client {
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
		// One request per indexer and query: a search is ~10–20 requests.
		limiter: rate.NewLimiter(rate.Limit(20), 30),
	}
}

func (c *Client) Configured() bool { return c.cfg.URL != "" && c.cfg.APIKey != "" }

// Search runs a free-text search on every configured indexer. Identical
// concurrent searches share one request.
func (c *Client) Search(ctx context.Context, query string) (*SearchResponse, error) {
	b, err := c.get(ctx, "/api/v2.0/indexers/all/results", url.Values{"Query": {query}})
	if err != nil {
		return nil, err
	}
	var out SearchResponse
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, errors.New("jackett: invalid JSON response")
	}
	return &out, nil
}

// Indexer is a configured Jackett indexer.
type Indexer struct {
	ID    string
	Title string
}

// Indexers lists the configured indexers.
func (c *Client) Indexers(ctx context.Context) ([]Indexer, error) {
	b, err := c.get(ctx, "/api/v2.0/indexers/all/results/torznab/api", url.Values{"t": {"indexers"}, "configured": {"true"}})
	if err != nil {
		return nil, err
	}
	var doc struct {
		Indexers []struct {
			ID         string `xml:"id,attr"`
			Configured string `xml:"configured,attr"`
			Title      string `xml:"title"`
		} `xml:"indexer"`
	}
	if err := xml.Unmarshal(b, &doc); err != nil {
		return nil, errors.New("jackett: invalid indexer list")
	}
	out := []Indexer{}
	for _, ix := range doc.Indexers {
		if ix.ID == "" || ix.Configured == "false" || strings.ContainsAny(ix.ID, "/?#") {
			continue
		}
		t := ix.Title
		if t == "" {
			t = ix.ID
		}
		out = append(out, Indexer{ID: ix.ID, Title: t})
	}
	return out, nil
}

// SearchIndexer searches one indexer, bounded by IndexerTimeout.
func (c *Client) SearchIndexer(ctx context.Context, id, query string) ([]Result, error) {
	ctx, cancel := context.WithTimeout(ctx, IndexerTimeout)
	defer cancel()
	b, err := c.get(ctx, "/api/v2.0/indexers/"+url.PathEscape(id)+"/results", url.Values{"Query": {query}})
	if err != nil {
		return nil, err
	}
	var out SearchResponse
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, errors.New("jackett: invalid JSON response")
	}
	for _, ix := range out.Indexers {
		if ix.Error != nil && *ix.Error != "" {
			return out.Results, errors.New("jackett: indexer search failed")
		}
	}
	return out.Results, nil
}

// Caps fetches the torznab capabilities (a cheap authenticated probe).
func (c *Client) Caps(ctx context.Context) error {
	_, err := c.get(ctx, "/api/v2.0/indexers/all/results/torznab/api", url.Values{"t": {"caps"}})
	return err
}

func (c *Client) get(ctx context.Context, path string, q url.Values) ([]byte, error) {
	if !c.Configured() {
		return nil, ErrNotConfigured
	}
	key := path + "?" + q.Encode()
	ch := c.group.DoChan(key, func() (any, error) {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.http.Timeout+time.Second)
		defer cancel()
		return c.once(ctx, path, q)
	})
	select {
	case <-ctx.Done():
		return nil, sanitizeCtx(ctx.Err())
	case r := <-ch:
		if r.Err != nil {
			return nil, r.Err
		}
		return r.Val.([]byte), nil
	}
}

func (c *Client) once(ctx context.Context, path string, q url.Values) ([]byte, error) {
	if err := c.limiter.Wait(ctx); err != nil {
		return nil, sanitizeCtx(err)
	}
	qq := url.Values{}
	for k, v := range q {
		qq[k] = v
	}
	qq.Set("apikey", c.cfg.APIKey)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.URL+path+"?"+qq.Encode(), nil)
	if err != nil {
		return nil, errors.New("jackett: bad request URL")
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, sanitize(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return nil, &StatusError{Status: resp.StatusCode}
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, sanitize(err)
	}
	if len(b) > maxBody {
		return nil, errors.New("jackett: response too large")
	}
	return b, nil
}

func sanitize(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		if ue.Timeout() {
			return errors.New("jackett: request timed out")
		}
		var ne *net.OpError
		if errors.As(errors.Unwrap(ue), &ne) {
			return fmt.Errorf("jackett: connection failed (%s)", ne.Op)
		}
	}
	return errors.New("jackett: request failed")
}

func sanitizeCtx(err error) error {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return errors.New("jackett: request timed out")
	case errors.Is(err, context.Canceled):
		return context.Canceled
	}
	return errors.New("jackett: request failed")
}

// StripKey removes the key from a Jackett proxy link so it can be stored;
// WithKey restores it. Links to other hosts are returned unchanged.
func (c *Client) StripKey(link string) string {
	u, ok := c.ownLink(link)
	if !ok {
		return link
	}
	q := u.Query()
	if !q.Has(linkKeyParam) && !q.Has("apikey") {
		return link
	}
	q.Del(linkKeyParam)
	q.Del("apikey")
	u.RawQuery = q.Encode()
	return u.String()
}

// WithKey adds the current key to a Jackett proxy link.
func (c *Client) WithKey(link string) string {
	u, ok := c.ownLink(link)
	if !ok || c.cfg.APIKey == "" {
		return link
	}
	q := u.Query()
	q.Set(linkKeyParam, c.cfg.APIKey)
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
