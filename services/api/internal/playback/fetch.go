package playback

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// maxTorrentSize caps a downloaded .torrent file.
const maxTorrentSize = 8 << 20

var errFetch = errors.New("release download failed")

// fetched is what a release download URL produced: a magnet or .torrent bytes.
type fetched struct {
	Magnet  string
	Torrent []byte
}

// torrentFetcher downloads .torrent files from Prowlarr only. It is the only
// place the server fetches a URL that came from somewhere else (a Prowlarr
// search result), so it refuses every host but the configured Prowlarr, any
// redirect except to a magnet: URI, and oversized bodies (SSRF guard).
type torrentFetcher struct {
	allowed *url.URL // Prowlarr base URL
	client  *http.Client
}

func newTorrentFetcher(prowlarrURL string) *torrentFetcher {
	f := &torrentFetcher{}
	if u, err := url.Parse(prowlarrURL); err == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https") {
		f.allowed = u
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	f.client = &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           dialer.DialContext,
			ResponseHeaderTimeout: 25 * time.Second,
			MaxIdleConnsPerHost:   2,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return f
}

func sameOrigin(a, b *url.URL) bool {
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Hostname(), b.Hostname()) && port(a) == port(b)
}

func port(u *url.URL) string {
	if p := u.Port(); p != "" {
		return p
	}
	if strings.EqualFold(u.Scheme, "https") {
		return "443"
	}
	return "80"
}

// fetchRetries are the waits before retrying a transient failure (network
// error, 429, 5xx): trackers behind Prowlarr rate-limit and hiccup, and
// Prowlarr answers 500 when the tracker returned a page instead of a torrent.
var fetchRetries = []time.Duration{time.Second, 2500 * time.Millisecond}

// fetchError says why a download failed (never the URL: it embeds the key).
type fetchError struct {
	reason    string
	transient bool
}

func (e *fetchError) Error() string        { return "release download failed: " + e.reason }
func (e *fetchError) Is(target error) bool { return target == errFetch }

// Fetch downloads raw (a Prowlarr download URL). Errors never include it:
// it embeds the Prowlarr API key.
func (f *torrentFetcher) Fetch(ctx context.Context, raw string) (*fetched, error) {
	for attempt := 0; ; attempt++ {
		got, err := f.fetchOnce(ctx, raw)
		var fe *fetchError
		if err == nil || !errors.As(err, &fe) || !fe.transient || attempt >= len(fetchRetries) {
			return got, err
		}
		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(fetchRetries[attempt]):
		}
	}
}

func (f *torrentFetcher) fetchOnce(ctx context.Context, raw string) (*fetched, error) {
	fail := func(reason string, transient bool) (*fetched, error) {
		return nil, &fetchError{reason: reason, transient: transient}
	}
	if strings.HasPrefix(strings.ToLower(raw), "magnet:") {
		return &fetched{Magnet: raw}, nil
	}
	u, err := url.Parse(raw)
	if err != nil || f.allowed == nil || u.User != nil || !sameOrigin(u, f.allowed) {
		return fail("not a Prowlarr URL", false)
	}
	for hop := 0; hop < 3; hop++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return fail("bad request", false)
		}
		req.Header.Set("Accept", "application/x-bittorrent, */*")
		resp, err := f.client.Do(req)
		if err != nil {
			return fail("network error", ctx.Err() == nil)
		}
		switch {
		case resp.StatusCode >= 300 && resp.StatusCode < 400:
			loc := resp.Header.Get("Location")
			resp.Body.Close()
			if strings.HasPrefix(strings.ToLower(loc), "magnet:") {
				return &fetched{Magnet: loc}, nil
			}
			next, err := u.Parse(loc)
			// Same-origin hops only (Prowlarr redirecting to itself).
			if err != nil || next.User != nil || !sameOrigin(next, f.allowed) {
				return fail("redirect off Prowlarr", false)
			}
			u = next
			continue
		case resp.StatusCode != http.StatusOK:
			resp.Body.Close()
			return fail("HTTP "+strconv.Itoa(resp.StatusCode), resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500)
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxTorrentSize+1))
		resp.Body.Close()
		if err != nil {
			return fail("read error", true)
		}
		if len(body) > maxTorrentSize {
			return fail("too large", false)
		}
		trimmed := bytes.TrimSpace(body)
		if bytes.HasPrefix(bytes.ToLower(trimmed), []byte("magnet:")) {
			return &fetched{Magnet: string(trimmed)}, nil
		}
		// A bencoded dictionary with an info section.
		if len(body) > 0 && body[0] == 'd' && bytes.Contains(body, []byte("4:info")) {
			return &fetched{Torrent: body}, nil
		}
		return fail("not a torrent", false)
	}
	return fail("too many redirects", false)
}
