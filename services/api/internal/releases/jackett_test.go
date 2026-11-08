package releases

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/integrations/jackett"
	"martytv/api/internal/sources"
)

// Each Jackett indexer is searched on its own: a slow one becomes a warning
// and the fast one's results (with the key stripped) still come back.
func TestJackettProvider(t *testing.T) {
	old := jackett.IndexerTimeout
	jackett.IndexerTimeout = 300 * time.Millisecond
	defer func() { jackett.IndexerTimeout = old }()
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v2.0/indexers/all/results/torznab/api":
			_, _ = w.Write([]byte(`<indexers><indexer id="rutor" configured="true"><title>RuTor</title></indexer><indexer id="slow" configured="true"><title>Slow Tracker</title></indexer><indexer id="broken" configured="true"><title>Broken</title></indexer></indexers>`))
		case "/api/v2.0/indexers/rutor/results":
			_, _ = w.Write([]byte(`{"Results":[{"Title":"Film 2010 1080p","Guid":"g-` + r.URL.Query().Get("Query") + `","Link":"http://` + r.Host +
				`/dl/rutor/?jackett_apikey=k&path=p","MagnetUri":"magnet:?xt=urn:btih:ABCDEF","InfoHash":"ABCDEF","Size":10,"Seeders":3,"Peers":4,"Tracker":"RuTor"}],"Indexers":[{"ID":"rutor","Name":"RuTor","Error":null}]}`))
		case "/api/v2.0/indexers/slow/results":
			select {
			case <-release:
			case <-r.Context().Done():
			}
		case "/api/v2.0/indexers/broken/results":
			_, _ = w.Write([]byte(`{"Results":[],"Indexers":[{"ID":"broken","Name":"Broken","Error":"Cloudflare at https://broken.example/?secret"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	defer close(release)

	p := NewJackettProvider(config.JackettConfig{URL: srv.URL, APIKey: "k"})
	if !p.Info().Configured || p.Info().ID != "jackett" {
		t.Fatalf("info %+v", p.Info())
	}
	res, err := p.SearchTorrents(context.Background(), sources.Title{Queries: []string{"Film 2010", "Фильм 2010"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Torrents) != 2 {
		t.Fatalf("torrents %+v", res.Torrents)
	}
	tr := res.Torrents[0]
	if strings.Contains(tr.DownloadURL, "jackett_apikey") || tr.Indexer != "RuTor" || tr.InfoHash != "abcdef" || *tr.Leechers != 1 ||
		!strings.HasPrefix(tr.MagnetURI, "magnet:") || tr.Protocol != "torrent" {
		t.Fatalf("torrent %+v", tr)
	}
	if !strings.Contains(p.WithKey(tr.DownloadURL), "jackett_apikey=k") {
		t.Fatal("key not restored")
	}
	if len(res.Warnings) != 2 || res.Warnings[0].Indexer != "Broken" || res.Warnings[1].Indexer != "Slow Tracker" {
		t.Fatalf("warnings %+v", res.Warnings)
	}
	for _, w := range res.Warnings {
		if strings.Contains(w.Message, "secret") || strings.Contains(w.Message, "http") {
			t.Fatalf("warning leaks upstream text: %+v", w)
		}
	}
}

// Without an indexer list (old Jackett, or the list failing) the provider
// falls back to the single "all" search.
func TestJackettProviderAllFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v2.0/indexers/all/results":
			_, _ = w.Write([]byte(`{"Results":[{"Title":"X","Guid":"g","MagnetUri":"magnet:?xt=urn:btih:aa","Tracker":"YTS"}],"Indexers":[{"ID":"eztv","Name":"EZTV","Error":"timeout"}]}`))
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer srv.Close()
	p := NewJackettProvider(config.JackettConfig{URL: srv.URL, APIKey: "k"})
	res, err := p.SearchTorrents(context.Background(), sources.Title{Queries: []string{"X"}})
	if err != nil || len(res.Torrents) != 1 || res.Torrents[0].MagnetURI == "" || len(res.Warnings) != 1 || res.Warnings[0].Indexer != "EZTV" {
		t.Fatalf("fallback %v %+v", err, res)
	}
}
