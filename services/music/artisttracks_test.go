package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestArtistTracksAllReleases(t *testing.T) {
	dz := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/artist/7/albums":
			_, _ = w.Write([]byte(`{"data":[
				{"id":1,"title":"Old","release_date":"2001-01-01","record_type":"album"},
				{"id":2,"title":"Single","release_date":"2010-01-01","record_type":"single"},
				{"id":3,"title":"New","release_date":"2005-01-01","record_type":"album"},
				{"id":4,"title":"Best of","release_date":"2012-01-01","record_type":"compile"}]}`))
		case "/album/1":
			_, _ = w.Write([]byte(`{"id":1,"title":"Old","nb_tracks":2,"tracks":{"data":[{"id":11,"title":"A","duration":100},{"id":12,"title":"B","duration":100}]}}`))
		case "/album/2":
			_, _ = w.Write([]byte(`{"id":2,"title":"Single","nb_tracks":1,"tracks":{"data":[{"id":21,"title":"a","duration":100}]}}`))
		case "/album/3":
			_, _ = w.Write([]byte(`{"id":3,"title":"New","nb_tracks":1,"tracks":{"data":[{"id":31,"title":"C","duration":100}]}}`))
		default:
			t.Errorf("unexpected %s", r.URL.Path)
			_, _ = w.Write([]byte(`{"data":[]}`))
		}
	}))
	defer dz.Close()
	st, err := openStore(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	a := newApp(config{DataDir: t.TempDir(), DevUser: "me", DeezerURL: dz.URL}, st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ts, err := a.dz.ArtistTracks(context.Background(), 7)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, x := range ts {
		got = append(got, x.ID)
	}
	// Albums newest first, then singles; the single's "a" repeats "A"; no compilation.
	want := []string{"dz:31", "dz:11", "dz:12"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}
