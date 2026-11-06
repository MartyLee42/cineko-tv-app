package tmdb

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"martytv/api/internal/config"
)

func newTest(t *testing.T, h http.HandlerFunc, cfg config.TMDBConfig) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	cfg.BaseURL = srv.URL
	c := New(cfg)
	c.sleep = func(context.Context, time.Duration) error { return nil }
	return c
}

func TestBearerPreferred(t *testing.T) {
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" || r.URL.Query().Has("api_key") {
			t.Errorf("auth header %q query %q", r.Header.Get("Authorization"), r.URL.RawQuery)
		}
		if r.URL.Path != "/movie/603" || r.URL.Query().Get("language") != "ru-RU" {
			t.Errorf("path %s query %s", r.URL.Path, r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"id":603}`))
	}, config.TMDBConfig{AccessToken: "tok", APIKey: "key"})
	b, err := c.Get(context.Background(), "/movie/603", url.Values{"language": {Language("ru")}})
	if err != nil || string(b) != `{"id":603}` {
		t.Fatalf("%s %v", b, err)
	}
}

func TestAPIKeyFallback(t *testing.T) {
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" || r.URL.Query().Get("api_key") != "key" {
			t.Errorf("expected api_key auth")
		}
		w.WriteHeader(http.StatusInternalServerError)
	}, config.TMDBConfig{APIKey: "key"})
	_, err := c.Get(context.Background(), "/x", nil)
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 500 || strings.Contains(err.Error(), "key") {
		t.Fatalf("err %v", err)
	}
}

func TestNotConfigured(t *testing.T) {
	c := New(config.TMDBConfig{BaseURL: "http://127.0.0.1:1"})
	if c.Configured() {
		t.Fatal("configured")
	}
	if _, err := c.Get(context.Background(), "/x", nil); !errors.Is(err, ErrNotConfigured) {
		t.Fatal(err)
	}
}

func TestRetryOnceOn429(t *testing.T) {
	var n atomic.Int32
	var waited time.Duration
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) == 1 {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}, config.TMDBConfig{AccessToken: "tok"})
	c.sleep = func(_ context.Context, d time.Duration) error { waited = d; return nil }
	if _, err := c.Get(context.Background(), "/x", nil); err != nil {
		t.Fatal(err)
	}
	if n.Load() != 2 || waited != 2*time.Second {
		t.Fatalf("calls %d waited %v", n.Load(), waited)
	}

	// A second 429 is returned, not retried forever.
	n.Store(0)
	c2 := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	}, config.TMDBConfig{AccessToken: "tok"})
	_, err := c2.Get(context.Background(), "/x", nil)
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 429 || n.Load() != 2 {
		t.Fatalf("err %v calls %d", err, n.Load())
	}
}

func TestNoRedirectsAndNotFound(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer target.Close()
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		http.Redirect(w, r, target.URL+"/steal", http.StatusFound)
	}, config.TMDBConfig{AccessToken: "tok"})
	if _, err := c.Get(context.Background(), "/redir", nil); err == nil {
		t.Fatal("redirect should fail")
	}
	if hits.Load() != 0 {
		t.Fatal("redirect was followed")
	}
	if _, err := c.Get(context.Background(), "/missing", nil); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestSingleflight(t *testing.T) {
	var n atomic.Int32
	release := make(chan struct{})
	c := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		<-release
		_, _ = w.Write([]byte(`{}`))
	}, config.TMDBConfig{AccessToken: "tok"})
	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.Get(context.Background(), "/same", url.Values{"page": {"1"}}); err != nil {
				t.Error(err)
			}
		}()
	}
	time.Sleep(100 * time.Millisecond)
	close(release)
	wg.Wait()
	if n.Load() != 1 {
		t.Fatalf("%d upstream calls", n.Load())
	}
}

func TestProxy(t *testing.T) {
	// The "TMDB" origin is only reached through the recording proxy.
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer origin.Close()
	originURL, _ := url.Parse(origin.URL)
	var seen atomic.Value
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Store(r.URL.String()) // absolute-form URI: a real proxy request
		httputil.NewSingleHostReverseProxy(originURL).ServeHTTP(w, r)
	}))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)

	c := New(config.TMDBConfig{AccessToken: "tok", BaseURL: "http://tmdb.invalid/3", ProxyURL: proxyURL})
	b, err := c.Get(context.Background(), "/configuration", nil)
	if err != nil || string(b) != `{"ok":true}` {
		t.Fatalf("%s %v", b, err)
	}
	if got, _ := seen.Load().(string); !strings.HasPrefix(got, "http://tmdb.invalid/3/configuration") {
		t.Fatalf("proxy saw %q", got)
	}
}

func TestMappings(t *testing.T) {
	if Language("en") != "en-US" || Language("ru") != "ru-RU" {
		t.Fatal("language")
	}
	if MediaType("series") != "tv" || MediaType("movie") != "movie" || Kind("tv") != "series" || Kind("person") != "" {
		t.Fatal("kind")
	}
}
