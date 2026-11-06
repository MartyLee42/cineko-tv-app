package torrserver

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"martytv/api/internal/config"
)

func TestCapabilitiesFor(t *testing.T) {
	c := CapabilitiesFor("MatriX.141\n")
	if !c.Supported || !c.FFProbe || !c.Play || !c.Upload || c.Matrix != 141 {
		t.Fatalf("141: %+v", c)
	}
	if c := CapabilitiesFor("MatriX.110"); !c.Supported || c.FFProbe || c.Play {
		t.Fatalf("110: %+v", c)
	}
	for _, v := range []string{"1.1.77", "", "<html>", "MatriX.42"} {
		if CapabilitiesFor(v).Supported {
			t.Fatalf("%q supported", v)
		}
	}
	if got := strings.Join(CapabilitiesFor("MatriX.141").List(), ","); got != "torrents,stream,upload,play,ffprobe,cache" {
		t.Fatal(got)
	}
}

func TestClientErrorsAreSanitized(t *testing.T) {
	var lastAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, _ := r.BasicAuth()
		lastAuth = u + ":" + p
		switch r.URL.Path {
		case "/echo":
			_, _ = io.WriteString(w, "MatriX.141")
		case "/torrents":
			if p != "pw" {
				w.WriteHeader(401)
				return
			}
			w.WriteHeader(500)
		case "/redirect":
			http.Redirect(w, r, "http://169.254.169.254/", http.StatusFound)
		}
	}))
	defer srv.Close()
	ctx := context.Background()

	c := New(config.TorrServerConfig{URL: srv.URL + "/", Username: "admin", Password: "pw"})
	if _, err := c.Get(ctx, strings.Repeat("a", 40)); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("500: %v", err)
	}
	if lastAuth != "admin:pw" {
		t.Fatalf("basic auth not sent: %q", lastAuth)
	}
	bad := New(config.TorrServerConfig{URL: srv.URL, Username: "admin", Password: "nope"})
	if _, err := bad.Get(ctx, strings.Repeat("a", 40)); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("401: %v", err)
	}
	// Invalid hashes never reach the server.
	if _, err := c.Get(ctx, "../settings"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bad hash: %v", err)
	}
	// Unreachable: the error must not echo the URL or credentials.
	down := New(config.TorrServerConfig{URL: "http://127.0.0.1:1", Username: "admin", Password: "s3cret"})
	_, err := down.Add(ctx, AddRequest{Link: "magnet:?xt=urn:btih:" + strings.Repeat("a", 40)})
	if !errors.Is(err, ErrUnavailable) || strings.Contains(err.Error(), "127.0.0.1") || strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("down: %v", err)
	}
	if New(config.TorrServerConfig{}).Configured() {
		t.Fatal("empty config is configured")
	}
	if _, err := New(config.TorrServerConfig{URL: "ftp://x"}).Echo(ctx); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("ftp: %v", err)
	}
}

func TestIdle(t *testing.T) {
	cases := []struct {
		t    *Torrent
		idle bool
	}{
		{nil, false},
		{&Torrent{Stat: StatClosed}, true},
		{&Torrent{Stat: StatInDB}, true},
		{&Torrent{Stat: StatGettingInfo}, false},
		{&Torrent{Stat: StatWorking}, true},
		{&Torrent{Stat: StatWorking, TotalPeers: 5}, false},
		{&Torrent{Stat: StatWorking, DownloadSpeed: 1000}, false},
		{&Torrent{Stat: StatPreload, ActivePeers: 2, TotalPeers: 2}, false},
	}
	for i, c := range cases {
		if got := c.t.Idle(); got != c.idle {
			t.Errorf("case %d: Idle() = %v, want %v", i, got, c.idle)
		}
	}
}

func TestPreload(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Path + "?" + r.URL.RawQuery
		_, _ = io.WriteString(w, `{"stat":2}`)
	}))
	defer srv.Close()
	c := New(config.TorrServerConfig{URL: srv.URL})
	hash := strings.Repeat("b", 40)
	if err := c.Preload(context.Background(), hash, 3); err != nil {
		t.Fatal(err)
	}
	if got != "/stream?index=3&link="+hash+"&preload=" {
		t.Fatalf("request %q", got)
	}
	if err := c.Preload(context.Background(), "../x", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bad hash: %v", err)
	}
}
