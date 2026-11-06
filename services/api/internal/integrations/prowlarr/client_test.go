package prowlarr

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"martytv/api/internal/config"
)

const testKey = "secret-prowlarr-key-123"

func newTest(t *testing.T, h http.HandlerFunc, timeout time.Duration) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return NewWithTimeout(config.ProwlarrConfig{URL: srv.URL, APIKey: testKey}, timeout), srv
}

func TestSearchSendsKeyHeaderAndParams(t *testing.T) {
	c, _ := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") != testKey || r.URL.Query().Has("apikey") {
			t.Errorf("auth: header %q query %q", r.Header.Get("X-Api-Key"), r.URL.RawQuery)
		}
		q := r.URL.Query()
		if r.URL.Path != "/api/v1/search" || q.Get("query") != "Матрица 1999" || q.Get("type") != "search" ||
			q.Get("limit") != "500" || len(q["indexerIds"]) != 2 {
			t.Errorf("request %s %s", r.URL.Path, r.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`[{"guid":"https://t/1","title":"Матрица / The Matrix (1999) BDRip","size":123,"seeders":5,"leechers":1,
			"indexer":"RuTor","indexerId":2,"infoHash":"ABCDEF0123456789ABCDEF0123456789ABCDEF01","protocol":"torrent",
			"downloadUrl":"http://x/2/download?apikey=k&link=l","publishDate":"2020-01-02T03:04:05Z","imdbId":133093,
			"categories":[{"id":8000,"name":"Other"},{"id":100003,"name":"x"}]}]`))
	}, time.Second)
	res, err := c.Search(context.Background(), SearchRequest{Query: "Матрица 1999", Limit: 500, IndexerIDs: []int{2, 6}})
	if err != nil || len(res) != 1 {
		t.Fatalf("res %v err %v", res, err)
	}
	r := res[0]
	if r.Indexer != "RuTor" || *r.Seeders != 5 || r.IMDbID != 133093 || r.PublishDate == nil || len(r.CategoryIDs()) != 2 {
		t.Fatalf("mapped %+v", r)
	}
}

func TestErrorsNeverContainURLOrKey(t *testing.T) {
	// Connection refused: the transport error includes the URL.
	c := NewWithTimeout(config.ProwlarrConfig{URL: "http://127.0.0.1:1/?apikey=" + testKey, APIKey: testKey}, time.Second)
	_, err := c.Search(context.Background(), SearchRequest{Query: "x"})
	if err == nil || strings.Contains(err.Error(), testKey) || strings.Contains(err.Error(), "127.0.0.1") {
		t.Fatalf("err %v", err)
	}
	c2, _ := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom "+testKey, http.StatusInternalServerError)
	}, time.Second)
	_, err = c2.Search(context.Background(), SearchRequest{Query: "x"})
	var se *StatusError
	if !errors.As(err, &se) || se.Status != 500 || strings.Contains(err.Error(), testKey) {
		t.Fatalf("err %v", err)
	}
}

func TestNoRedirects(t *testing.T) {
	var other int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&other, 1)
		if r.Header.Get("X-Api-Key") != "" {
			t.Errorf("key leaked to redirect target")
		}
	}))
	defer target.Close()
	c, _ := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/steal", http.StatusFound)
	}, time.Second)
	_, err := c.Search(context.Background(), SearchRequest{Query: "x"})
	if err == nil || atomic.LoadInt32(&other) != 0 {
		t.Fatalf("redirect followed: err %v hits %d", err, other)
	}
}

func TestTimeout(t *testing.T) {
	c, _ := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(3 * time.Second):
		}
	}, 200*time.Millisecond)
	start := time.Now()
	_, err := c.Search(context.Background(), SearchRequest{Query: "slow"})
	if err == nil || !strings.Contains(err.Error(), "timed out") || time.Since(start) > 2*time.Second {
		t.Fatalf("err %v after %v", err, time.Since(start))
	}
}

func TestAllIndexersUnavailable(t *testing.T) {
	c, _ := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"Search failed due to all selected indexers being unavailable"}`))
	}, time.Second)
	if _, err := c.Search(context.Background(), SearchRequest{Query: "x"}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err %v", err)
	}
}

func TestSingleflight(t *testing.T) {
	var hits int32
	c, _ := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		time.Sleep(100 * time.Millisecond)
		_, _ = w.Write([]byte(`[]`))
	}, time.Second)
	done := make(chan struct{})
	for i := 0; i < 5; i++ {
		go func() {
			_, _ = c.Search(context.Background(), SearchRequest{Query: "same"})
			done <- struct{}{}
		}()
	}
	for i := 0; i < 5; i++ {
		<-done
	}
	if n := atomic.LoadInt32(&hits); n != 1 {
		t.Fatalf("hits %d", n)
	}
}

func TestIndexerStatuses(t *testing.T) {
	c, _ := newTest(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/indexerstatus":
			_, _ = w.Write([]byte(`[{"id":1,"indexerId":6,"disabledTill":"2030-01-01T00:00:00Z","mostRecentFailure":"2026-10-28T20:00:00Z"}]`))
		case "/api/v1/indexer":
			_, _ = w.Write([]byte(`[{"id":6,"name":"RuTracker.org","enable":true,"protocol":"torrent"}]`))
		}
	}, time.Second)
	sts, err := c.IndexerStatuses(context.Background())
	if err != nil || len(sts) != 1 || sts[0].IndexerID != 6 || sts[0].DisabledTill == nil {
		t.Fatalf("%v %v", sts, err)
	}
	ix, err := c.Indexers(context.Background())
	if err != nil || ix[0].Name != "RuTracker.org" {
		t.Fatalf("%v %v", ix, err)
	}
}

func TestNotConfigured(t *testing.T) {
	c := New(config.ProwlarrConfig{})
	if _, err := c.Search(context.Background(), SearchRequest{Query: "x"}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err %v", err)
	}
}

func TestStripAndRestoreKey(t *testing.T) {
	c := NewWithTimeout(config.ProwlarrConfig{URL: "http://prowlarr:9696", APIKey: testKey}, time.Second)
	link := "http://prowlarr:9696/2/download?apikey=" + testKey + "&link=abc&file=Name"
	stripped := c.StripKey(link)
	if strings.Contains(stripped, testKey) || !strings.Contains(stripped, "link=abc") {
		t.Fatalf("stripped %q", stripped)
	}
	if got := c.WithKey(stripped); !strings.Contains(got, "apikey="+testKey) {
		t.Fatalf("restored %q", got)
	}
	// Foreign hosts are never given the key.
	if got := c.WithKey("http://evil.example/x?link=1"); strings.Contains(got, testKey) {
		t.Fatalf("key added to foreign link %q", got)
	}
}
