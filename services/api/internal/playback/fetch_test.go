package playback

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const fakeTorrent = "d8:announce3:udp4:infod6:lengthi1e4:name1:a12:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaaee"

func TestTorrentFetcher(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(fakeTorrent))
	}))
	defer other.Close()
	prowlarr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/torrent":
			_, _ = w.Write([]byte(fakeTorrent))
		case "/magnet":
			http.Redirect(w, r, "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567", http.StatusMovedPermanently)
		case "/self":
			http.Redirect(w, r, "/torrent", http.StatusFound)
		case "/elsewhere":
			http.Redirect(w, r, other.URL+"/x", http.StatusFound)
		case "/html":
			_, _ = w.Write([]byte("<html>login</html>"))
		case "/huge":
			_, _ = w.Write([]byte("d4:info"))
			_, _ = w.Write(make([]byte, maxTorrentSize+10))
		default:
			w.WriteHeader(404)
		}
	}))
	defer prowlarr.Close()
	f := newTorrentFetcher(prowlarr.URL)
	ctx := context.Background()

	got, err := f.Fetch(ctx, prowlarr.URL+"/torrent?apikey=SECRET")
	if err != nil || string(got.Torrent) != fakeTorrent {
		t.Fatalf("torrent: %v %+v", err, got)
	}
	got, err = f.Fetch(ctx, prowlarr.URL+"/magnet?apikey=SECRET")
	if err != nil || !strings.HasPrefix(got.Magnet, "magnet:?xt=urn:btih:0123") {
		t.Fatalf("magnet redirect: %v %+v", err, got)
	}
	if got, err = f.Fetch(ctx, prowlarr.URL+"/self"); err != nil || got.Torrent == nil {
		t.Fatalf("same-origin redirect: %v", err)
	}
	for _, bad := range []string{
		other.URL + "/torrent",      // not Prowlarr
		prowlarr.URL + "/elsewhere", // redirect off-host
		prowlarr.URL + "/html",      // not a torrent
		prowlarr.URL + "/huge",      // too big
		prowlarr.URL + "/missing",   // 404
		"file:///etc/passwd",        // scheme
		"http://user:pw@" + strings.TrimPrefix(prowlarr.URL, "http://") + "/torrent", // userinfo
	} {
		if _, err := f.Fetch(ctx, bad); err == nil {
			t.Fatalf("accepted %s", bad)
		} else if strings.Contains(err.Error(), "SECRET") || strings.Contains(err.Error(), "127.0.0.1") {
			t.Fatalf("error leaks URL: %v", err)
		}
	}
	// Transient failures (rate limit, tracker hiccup → Prowlarr 500) are retried.
	saved := fetchRetries
	fetchRetries = []time.Duration{time.Millisecond, time.Millisecond}
	defer func() { fetchRetries = saved }()
	var flakyCalls, brokenCalls, htmlCalls atomic.Int32
	flaky := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/flaky":
			if flakyCalls.Add(1) < 3 {
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			_, _ = w.Write([]byte(fakeTorrent))
		case "/broken":
			brokenCalls.Add(1)
			w.WriteHeader(http.StatusInternalServerError)
		default:
			htmlCalls.Add(1)
			_, _ = w.Write([]byte("<html>login</html>"))
		}
	}))
	defer flaky.Close()
	ff := newTorrentFetcher(flaky.URL)
	if got, err := ff.Fetch(ctx, flaky.URL+"/flaky"); err != nil || got.Torrent == nil {
		t.Fatalf("retry: %v", err)
	}
	if _, err := ff.Fetch(ctx, flaky.URL+"/broken"); err == nil || !errors.Is(err, errFetch) || !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("broken: %v", err)
	}
	if brokenCalls.Load() != 3 {
		t.Fatalf("500 tried %d times, want 3", brokenCalls.Load())
	}
	if _, err := ff.Fetch(ctx, flaky.URL+"/html"); err == nil || htmlCalls.Load() != 1 {
		t.Fatalf("non-torrent body must fail without retry: %v, %d calls", err, htmlCalls.Load())
	}

	// Unconfigured Prowlarr refuses everything but magnets.
	if _, err := newTorrentFetcher("").Fetch(ctx, prowlarr.URL+"/torrent"); err == nil {
		t.Fatal("unconfigured fetcher fetched")
	}
}
