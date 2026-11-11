package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestContinueSeeds(t *testing.T) {
	ts := []Track{
		{ID: "dz:1", Artist: "Кино", ArtistID: 10},
		{ID: "yq:a", Artist: "Сплин, Би-2"},
		{ID: "dz:2", Artist: "Кино", ArtistID: 10},
		{ID: "yq:b", Artist: "сплин feat. Кто-то"},
		{ID: "yq:c", Artist: "Simon & Garfunkel"},
		{ID: "yq:d", Artist: "  "},
	}
	s := continueSeedsFor(ts)
	if len(s) != 3 {
		t.Fatalf("seeds %+v", s)
	}
	// Ties go to the more recent artist.
	if s[0].name != "Сплин" || s[0].count != 2 || s[1].id != 10 || s[1].count != 2 || s[2].name != "Simon & Garfunkel" {
		t.Errorf("order %+v", s)
	}
}

func TestNoStoreWriter(t *testing.T) {
	rec := httptest.NewRecorder()
	w := &noStore{ResponseWriter: rec}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	_, _ = w.Write([]byte("audio"))
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control %q", got)
	}
	rec = httptest.NewRecorder()
	http.ServeContent(&noStore{ResponseWriter: rec}, httptest.NewRequest("GET", "/", nil), "", time.Unix(1700000000, 0), strings.NewReader("abc"))
	if got := rec.Header().Get("Cache-Control"); got != "no-store" || rec.Body.String() != "abc" {
		t.Errorf("ServeContent: %q %q", got, rec.Body.String())
	}
}

func TestSourceMatchClearsBad(t *testing.T) {
	e := newAIEnv(t, 0)
	memo.markBad("dz:77", "dQw4w9WgXcQ")
	if c := e.do(t, http.MethodPut, "/music/api/sources/match", `{"trackId":"dz:77","value":"dQw4w9WgXcQ"}`); c != 204 {
		t.Fatalf("match: %d", c)
	}
	if memo.isBad("dz:77", "dQw4w9WgXcQ") {
		t.Error("a chosen source stays marked bad: resolve would skip it")
	}
}

// fakeDeezer: /search/artist by name, /artist/{id}/radio with 10 tracks each.
func fakeDeezer(t *testing.T) *httptest.Server {
	artists := map[string]int64{"кино": 10, "сплин": 20}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/search/artist":
			q := strings.ToLower(r.URL.Query().Get("q"))
			out := []dzArtist{}
			if id, ok := artists[q]; ok {
				out = append(out, dzArtist{ID: id, Name: r.URL.Query().Get("q")})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": out})
		case strings.HasPrefix(r.URL.Path, "/artist/") && strings.HasSuffix(r.URL.Path, "/radio"):
			var id int64
			fmt.Sscanf(r.URL.Path, "/artist/%d/radio", &id)
			out := []dzTrack{}
			for i := 1; i <= 10; i++ {
				out = append(out, dzTrack{ID: id*100 + int64(i), Title: fmt.Sprintf("Song %d", i), Duration: 200,
					Artist: &dzArtist{ID: id, Name: fmt.Sprintf("Artist %d", id)}})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": out})
		default:
			_, _ = w.Write([]byte(`{"data":[]}`))
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func TestContinueFromPlaylist(t *testing.T) {
	st, err := openStore(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	app := newApp(config{DataDir: t.TempDir(), DevUser: "me", DeezerURL: fakeDeezer(t).URL}, st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	body := `{"tracks":[
		{"id":"yq:aaaaaaaaaaaaaaaaaaaa","artist":"Кино","title":"Звезда"},
		{"id":"yq:bbbbbbbbbbbbbbbbbbbb","artist":"Сплин","title":"Романс"},
		{"id":"dz:1001","artist":"Artist 10","artistId":10,"title":"Song 1"}],
		"exclude":["dz:1002"]}`
	req := httptest.NewRequest(http.MethodPost, "/music/api/continue", strings.NewReader(body))
	req.Header.Set("X-Requested-With", "marty-music")
	rec := httptest.NewRecorder()
	app.routes().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	var out []Track
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	by := map[int64]int{}
	for _, tr := range out {
		if tr.ID == "dz:1001" || tr.ID == "dz:1002" {
			t.Errorf("excluded track %s came back", tr.ID)
		}
		by[tr.ArtistID]++
	}
	// Both artists, the imported one found by name.
	if by[10] == 0 || by[20] == 0 || len(out) != 18 {
		t.Errorf("got %d tracks, by artist %v", len(out), by)
	}
}
