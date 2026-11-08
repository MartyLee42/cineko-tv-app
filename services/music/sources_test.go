package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func (e *aiEnv) do(t *testing.T, method, path, body string) int {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("X-Requested-With", "marty-music")
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: "sess"})
	rec := httptest.NewRecorder()
	e.app.routes().ServeHTTP(rec, req)
	return rec.Code
}

func TestSourceMatchForImportedTrack(t *testing.T) {
	e := newAIEnv(t, 0)
	ctx := context.Background()
	id := yqID("Кино", "Группа крови")
	// An "always from this torrent" choice would win over the recording: dropped.
	if err := e.app.st.SetManualTorrent(ctx, id, &TorrentSrc{Hash: strings.Repeat("a", 40), File: 1, Ext: "flac"}); err != nil {
		t.Fatal(err)
	}
	body := `{"trackId":"` + id + `","artist":"Кино","title":"Группа крови","value":"zv:123"}`
	if c := e.do(t, http.MethodPut, "/music/api/sources/match", body); c != 204 {
		t.Fatalf("match: %d", c)
	}
	if v, ok := e.app.st.Match(ctx, id); !ok || v != "zv:123" {
		t.Fatalf("stored %q %v", v, ok)
	}
	if _, ok := e.app.st.ManualTorrent(ctx, id); ok {
		t.Fatal("torrent choice kept")
	}
	if c := e.do(t, http.MethodPut, "/music/api/sources/match", `{"trackId":"dz:42","value":"dQw4w9WgXcQ"}`); c != 204 {
		t.Fatalf("dz match: %d", c)
	}
	for _, bad := range []string{
		`{"trackId":"` + id + `","artist":"Кино","title":"Другая","value":"zv:1"}`, // id doesn't fit the title
		`{"trackId":"yt:dQw4w9WgXcQ","value":"zv:1"}`,                              // plain uploads aren't matched
		`{"trackId":"dz:42","value":"not a video"}`,
	} {
		if c := e.do(t, http.MethodPut, "/music/api/sources/match", bad); c != 400 {
			t.Errorf("%s: %d", bad, c)
		}
	}
}

func TestSourcesValidatesTrack(t *testing.T) {
	e := newAIEnv(t, 0)
	q := url.Values{"id": {yqID("Кино", "Звезда")}, "artist": {"Кино"}, "title": {"Звезда"}}
	if c := e.do(t, http.MethodGet, "/music/api/sources/nope?"+q.Encode(), ""); c != 404 {
		t.Errorf("unknown provider: %d", c)
	}
	q.Set("title", "Другая")
	if c := e.do(t, http.MethodGet, "/music/api/sources/youtube?"+q.Encode(), ""); c != 400 {
		t.Errorf("forged yq: %d", c)
	}
	if c := e.do(t, http.MethodGet, "/music/api/sources/youtube?id=bogus&title=x", ""); c != 400 {
		t.Errorf("bad id: %d", c)
	}
	if c := e.do(t, http.MethodGet, "/music/api/resolveq?"+q.Encode(), ""); c != 400 {
		t.Errorf("resolveq forged yq: %d", c)
	}
	if matchKey("yt:dQw4w9WgXcQ") != "" || matchKey("dz:1") != "dz:1" {
		t.Error("matchKey")
	}
}
