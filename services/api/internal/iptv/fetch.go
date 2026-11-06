package iptv

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"syscall"
	"time"
)

// fetcher downloads playlists, guides and logos, directly or through the
// configured proxy (IPTV_PROXY_URL, default TMDB_PROXY_URL). Direct
// connections dial only public addresses unless allowPrivate. Errors never
// include URLs (they may carry provider credentials).
type fetcher struct {
	direct *http.Client
	proxy  *http.Client // nil = no proxy configured
}

var errBlocked = errors.New("address not allowed")

func newFetcher(proxyURL *url.URL, allowPrivate bool, timeout time.Duration) *fetcher {
	f := &fetcher{direct: newClient(nil, allowPrivate, timeout)}
	if proxyURL != nil {
		f.proxy = newClient(proxyURL, true, timeout)
	}
	return f
}

func newClient(proxyURL *url.URL, allowPrivate bool, timeout time.Duration) *http.Client {
	d := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	if !allowPrivate && proxyURL == nil {
		d.Control = func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return errBlocked
			}
			ip := net.ParseIP(host)
			if ip == nil || !PublicIP(ip) {
				return errBlocked
			}
			return nil
		}
	}
	tr := &http.Transport{
		DialContext:           d.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	if proxyURL != nil {
		tr.Proxy = http.ProxyURL(proxyURL)
	}
	return &http.Client{
		Transport: tr,
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errBlocked
			}
			return nil
		},
	}
}

// PublicIP reports whether ip is a routable public address.
func PublicIP(ip net.IP) bool {
	return !(ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() ||
		(&net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}).Contains(ip))
}

// fetchError is a sanitized fetch failure.
type fetchError struct {
	Status int
	msg    string
}

func (e *fetchError) Error() string { return e.msg }

// open GETs u and returns the body (caller closes) and how it was fetched
// ("direct" or "proxy"). viaProxy tries the proxy first; either way the
// other path (when configured) is the fallback after a failure other than
// a 404.
func (f *fetcher) open(ctx context.Context, u string, viaProxy bool, headers map[string]string) (io.ReadCloser, string, error) {
	try := func(hc *http.Client) (io.ReadCloser, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, &fetchError{msg: "invalid url"}
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Cineko IPTV)")
		for k, v := range headers {
			if v != "" {
				req.Header.Set(k, v)
			}
		}
		resp, err := hc.Do(req)
		if err != nil {
			return nil, &fetchError{msg: sanitizeErr(err)}
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, &fetchError{Status: resp.StatusCode, msg: fmt.Sprintf("HTTP %d", resp.StatusCode)}
		}
		return resp.Body, nil
	}
	type route struct {
		name string
		hc   *http.Client
	}
	routes := []route{{"direct", f.direct}}
	if f.proxy != nil {
		if viaProxy {
			routes = []route{{"proxy", f.proxy}, {"direct", f.direct}}
		} else {
			routes = append(routes, route{"proxy", f.proxy})
		}
	}
	var first error
	for _, r := range routes {
		rc, err := try(r.hc)
		if err == nil {
			return rc, r.name, nil
		}
		if first == nil {
			first = err
		}
		var fe *fetchError
		if ctx.Err() != nil || (errors.As(err, &fe) && fe.Status == http.StatusNotFound) {
			break
		}
	}
	return nil, "", first
}

// sanitizeErr turns a transport error into a short message without the URL.
func sanitizeErr(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	var ne net.Error
	switch {
	case errors.Is(err, errBlocked):
		return "address not allowed"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns lookup failed"
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return "connection failed"
	}
	return "fetch failed"
}

// limitReader fails once more than n bytes were read.
type limitReader struct {
	r io.Reader
	n int64
}

var errTooLarge = errors.New("response too large")

func (l *limitReader) Read(p []byte) (int, error) {
	if l.n <= 0 {
		return 0, errTooLarge
	}
	if int64(len(p)) > l.n {
		p = p[:l.n]
	}
	n, err := l.r.Read(p)
	l.n -= int64(n)
	return n, err
}
