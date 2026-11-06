package jacred_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"martytv/api/internal/config"
	"martytv/api/internal/integrations/jacred"
	"martytv/api/internal/sources"
)

// testdata/matrix.json is a trimmed real response of jr.maxvol.pro
// (search=Матрица&altname=The Matrix&exact=true, 2026-10-29); the last
// item's hash was replaced to collide with the releases Prowlarr mock.
func fixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/matrix.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSearchTorrents(t *testing.T) {
	body := fixture(t)
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1.0/torrents" {
			http.NotFound(w, r)
			return
		}
		got = append(got, r.URL.RawQuery)
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	var p sources.TorrentProvider = jacred.NewProvider(config.JacredConfig{URL: srv.URL, APIKey: "k3y"})
	in := p.Info()
	if in.ID != "jacred" || in.Kind != sources.KindTorrent || !in.Configured {
		t.Fatalf("info %+v", in)
	}
	res, err := p.SearchTorrents(context.Background(), sources.Title{TitleRU: "Матрица", Original: "The Matrix", TitleEN: "The Matrix",
		Queries: []string{"ignored"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || !strings.Contains(got[0], "exact=true") || !strings.Contains(got[0], "altname=The+Matrix") ||
		!strings.Contains(got[0], "apikey=k3y") || !strings.Contains(got[0], "search=%D0%9C") {
		t.Fatalf("query %v", got)
	}
	if len(res.Torrents) != 7 {
		t.Fatalf("torrents %d", len(res.Torrents))
	}
	first := res.Torrents[0]
	if first.Indexer != "RuTor" || first.InfoHash != "bd25c3ccb27fd04219bc3b083ef976a1b47f57a6" ||
		!strings.HasPrefix(first.MagnetURI, "magnet:?") || first.Seeders == nil || *first.Seeders != 4 ||
		first.Size == 0 || first.PublishDate == nil || len(first.Voices) != 1 || first.Voices[0] != "Дубляж" || first.Protocol != "torrent" {
		t.Fatalf("first %+v", first)
	}
	last := res.Torrents[len(res.Torrents)-1]
	if last.InfoHash != "0123456789abcdef0123456789abcdef01234567" { // upper-case magnet hash is lowered
		t.Fatalf("hash %q", last.InfoHash)
	}

	// The user's own text: no exact match, no altname.
	if _, err := p.SearchTorrents(context.Background(), sources.Title{UserQuery: "Neo", Queries: []string{"Neo"}}); err != nil {
		t.Fatal(err)
	}
	if q := got[len(got)-1]; strings.Contains(q, "exact") || !strings.Contains(q, "search=Neo") {
		t.Fatalf("user query %q", q)
	}
}

func TestErrorsNeverLeakKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	p := jacred.NewProvider(config.JacredConfig{URL: srv.URL, APIKey: "s3cret"})
	_, err := p.SearchTorrents(context.Background(), sources.Title{TitleRU: "Матрица"})
	if err == nil || !strings.Contains(err.Error(), "403") || strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("err %v", err)
	}
	if p.Probe(context.Background()) == nil {
		t.Fatal("probe should fail")
	}
	// Unreachable host: the URL (with key) is not echoed.
	p = jacred.NewProvider(config.JacredConfig{URL: "http://127.0.0.1:1", APIKey: "s3cret"})
	if _, err := p.SearchTorrents(context.Background(), sources.Title{TitleRU: "x"}); err == nil || strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("err %v", err)
	}
	if jacred.New(config.JacredConfig{}) != nil {
		t.Fatal("New without URL must return nil")
	}
}

func TestConfigureOverridesBaseURL(t *testing.T) {
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	p := jacred.NewProvider(config.JacredConfig{URL: "http://127.0.0.1:1"})
	p.Configure(sources.Config{Enabled: true, BaseURL: srv.URL + "/"})
	res, err := p.SearchTorrents(context.Background(), sources.Title{TitleRU: "Матрица"})
	if err != nil || !hit || len(res.Torrents) != 0 {
		t.Fatalf("res %+v err %v hit %v", res, err, hit)
	}
}
