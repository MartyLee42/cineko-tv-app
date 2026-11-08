package jackett

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"martytv/api/internal/config"
)

func TestClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("apikey") != "secret-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/v2.0/indexers/all/results/torznab/api":
			if r.URL.Query().Get("t") == "indexers" {
				_, _ = w.Write([]byte(`<?xml version="1.0"?><indexers><indexer id="rutor" configured="true"><title>RuTor</title></indexer><indexer id="off" configured="false"><title>Off</title></indexer></indexers>`))
				return
			}
			_, _ = w.Write([]byte(`<caps/>`))
		case "/api/v2.0/indexers/rutor/results":
			if r.URL.Query().Get("Query") != "Матрица 1999" {
				t.Errorf("query %q", r.URL.Query().Get("Query"))
			}
			_, _ = w.Write([]byte(`{"Results":[{"Title":"Матрица 1999 1080p","Guid":"g1","Link":"` + "http://" + r.Host +
				`/dl/rutor/?jackett_apikey=secret-key&path=abc&file=x","Size":123,"Seeders":5,"Peers":7,"Tracker":"RuTor","Category":[2000],"Imdb":133093}],"Indexers":[{"ID":"rutor","Name":"RuTor","Results":1,"Error":null}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	ctx := context.Background()

	c := New(config.JackettConfig{URL: srv.URL, APIKey: "secret-key"})
	if err := c.Caps(ctx); err != nil {
		t.Fatal(err)
	}
	ix, err := c.Indexers(ctx)
	if err != nil || len(ix) != 1 || ix[0].ID != "rutor" || ix[0].Title != "RuTor" {
		t.Fatalf("indexers %v %+v", err, ix)
	}
	res, err := c.SearchIndexer(ctx, "rutor", "Матрица 1999")
	if err != nil || len(res) != 1 || *res[0].Leechers() != 2 || *res[0].IMDb != 133093 {
		t.Fatalf("search %v %+v", err, res)
	}
	stripped := c.StripKey(res[0].Link)
	if strings.Contains(stripped, "secret-key") || !strings.Contains(stripped, "path=abc") {
		t.Fatalf("stripped %s", stripped)
	}
	if back := c.WithKey(stripped); !strings.Contains(back, "jackett_apikey=secret-key") {
		t.Fatalf("with key %s", back)
	}
	if other := "https://example.org/x.torrent?jackett_apikey=z"; c.StripKey(other) != other || c.WithKey(other) != other {
		t.Fatal("foreign link changed")
	}

	// A wrong key: a status error that never carries the URL or key.
	bad := New(config.JackettConfig{URL: srv.URL, APIKey: "wrong"})
	if err := bad.Caps(ctx); err == nil || strings.Contains(err.Error(), "wrong") || strings.Contains(err.Error(), srv.URL) {
		t.Fatalf("bad key err %v", err)
	}
	if New(config.JackettConfig{}).Caps(ctx) != ErrNotConfigured {
		t.Fatal("unconfigured")
	}
}
