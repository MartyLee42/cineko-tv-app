package integrations

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"martytv/api/internal/config"
)

// Mock Prowlarr: only /api/v1/system/status with the right key.
func mockProwlarr(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") != "k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/api/v1/system/status" {
			_, _ = w.Write([]byte(`{"appName":"Prowlarr","version":"2.4.0.5397"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
}

// Mock TorrServer MatriX: /echo is public, /torrents needs basic auth.
func mockTorrServer(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/echo":
			_, _ = w.Write([]byte("MatriX.141"))
		case "/torrents":
			u, p, ok := r.BasicAuth()
			if !ok || u != "user" || p != "pass" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_, _ = w.Write([]byte(`[]`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestProwlarrProbe(t *testing.T) {
	srv := mockProwlarr(t)
	defer srv.Close()
	ctx := context.Background()

	if st := NewProwlarr(config.ProwlarrConfig{}).Probe(ctx); st.Configured || st.OK {
		t.Fatalf("unconfigured %+v", st)
	}
	st := NewProwlarr(config.ProwlarrConfig{URL: srv.URL, APIKey: "k"}).Probe(ctx)
	if !st.OK || st.Version != "2.4.0.5397" {
		t.Fatalf("ok probe %+v", st)
	}
	st = NewProwlarr(config.ProwlarrConfig{URL: srv.URL, APIKey: "bad"}).Probe(ctx)
	if st.OK || !strings.Contains(st.Error, "401") {
		t.Fatalf("bad key %+v", st)
	}
	if strings.Contains(st.Error, "bad") {
		t.Fatal("error must not echo the key")
	}
}

func TestTorrServerProbe(t *testing.T) {
	srv := mockTorrServer(t)
	defer srv.Close()
	ctx := context.Background()
	st := NewTorrServer(config.TorrServerConfig{URL: srv.URL, Username: "user", Password: "pass"}).Probe(ctx)
	if !st.OK || st.Version != "MatriX.141" {
		t.Fatalf("ok probe %+v", st)
	}
	st = NewTorrServer(config.TorrServerConfig{URL: srv.URL, Username: "user", Password: "nope"}).Probe(ctx)
	if st.OK || st.Version != "MatriX.141" || !strings.Contains(st.Error, "credentials") {
		t.Fatalf("bad creds %+v", st)
	}
	st = NewTorrServer(config.TorrServerConfig{URL: "http://127.0.0.1:1"}).Probe(ctx)
	if st.OK || st.Error == "" {
		t.Fatalf("unreachable %+v", st)
	}
}

func TestTMDBProbePrefersBearer(t *testing.T) {
	var gotAuth, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotKey = r.Header.Get("Authorization"), r.URL.Query().Get("api_key")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	st := NewTMDB(config.TMDBConfig{BaseURL: srv.URL, APIKey: "v3", AccessToken: "v4"}).Probe(context.Background())
	if !st.OK || gotAuth != "Bearer v4" || gotKey != "" {
		t.Fatalf("st=%+v auth=%q key=%q", st, gotAuth, gotKey)
	}
}

func TestProbesNeverFollowRedirects(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data", http.StatusFound)
	}))
	defer srv.Close()
	st := NewProwlarr(config.ProwlarrConfig{URL: srv.URL, APIKey: "k"}).Probe(context.Background())
	if st.OK || !strings.Contains(st.Error, "302") {
		t.Fatalf("redirect should not be followed: %+v", st)
	}
}

// The TMDB probe honors TMDB_PROXY_URL: an HTTP proxy that answers on behalf
// of an unreachable host proves the request went through it.
func TestTMDBProbeUsesProxy(t *testing.T) {
	var seen string
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.URL.String()
		_, _ = w.Write([]byte(`{}`))
	}))
	defer proxy.Close()
	pu, _ := url.Parse(proxy.URL)
	st := NewTMDB(config.TMDBConfig{BaseURL: "http://tmdb.invalid/3", AccessToken: "v4", ProxyURL: pu}).Probe(context.Background())
	if !st.OK || seen != "http://tmdb.invalid/3/configuration" {
		t.Fatalf("st=%+v proxy saw %q", st, seen)
	}
}
