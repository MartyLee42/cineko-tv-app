package cdnvideohub

import (
	"context"
	"encoding/json"
	"errors"
	"martytv/api/internal/sources/internal/webfetch"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"martytv/api/internal/sources"
)

// fakeAPI serves trimmed real CDNVideoHub responses (testdata/, fetched
// 2026-10-29 for kp 301 «Матрица» and kp 77044 «Друзья»; CDN hosts and IPs
// scrubbed).
type fakeAPI struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	paths  []string
	status int
}

func newFakeAPI(t *testing.T) *fakeAPI {
	f := &fakeAPI{t: t}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.paths = append(f.paths, r.URL.Path+"?"+r.URL.RawQuery)
	status := f.status
	f.mu.Unlock()
	if status != 0 {
		w.WriteHeader(status)
		return
	}
	file := func(name string) []byte {
		b, err := os.ReadFile("testdata/" + name)
		if err != nil {
			f.t.Fatal(err)
		}
		return []byte(strings.ReplaceAll(string(b), "{{CDN}}", "https://cdn.example"))
	}
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path == "/sv/playlist":
		q := r.URL.Query()
		if q.Get("pub") != "12" || q.Get("aggr") != "kp" {
			w.WriteHeader(400)
			return
		}
		switch q.Get("id") {
		case "301":
			_, _ = w.Write(file("playlist_301.json"))
		case "77044":
			_, _ = w.Write(file("playlist_77044.json"))
		default:
			_, _ = w.Write([]byte(`{"titleName":"","isSerial":false,"items":[],"ads":{"vast":{"preroll":["https://ads.example/x"]}}}`))
		}
	case strings.HasPrefix(r.URL.Path, "/sv/video/"):
		if strings.HasSuffix(r.URL.Path, "/404") {
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write(file("video_301.json"))
	default:
		w.WriteHeader(404)
	}
}

func (f *fakeAPI) requests(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, p := range f.paths {
		if strings.HasPrefix(p, prefix) {
			n++
		}
	}
	return n
}

// fixed "now": before the fixture URLs' expires (2026-10-30 ~ 08:26 UTC).
var now = time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)

func newProvider(f *fakeAPI) *Provider {
	p := New(f.srv.URL+"/sv", f.srv.Client())
	p.c.Now = func() time.Time { return now }
	p.c.Interval = 0
	return p
}

func TestMovieVariantsAndResolve(t *testing.T) {
	f := newFakeAPI(t)
	p := newProvider(f)
	ctx := context.Background()
	vs, err := p.Variants(ctx, sources.Title{Kind: "movie", KPID: 301})
	if err != nil {
		t.Fatal(err)
	}
	type row struct{ voice, kind string }
	var got []row
	for _, v := range vs {
		got = append(got, row{v.Voice, v.VoiceKind})
		if v.Format != "mp4" || v.MaxQuality != 2160 || !slices.Equal(v.Qualities, []int{2160, 1440, 1080, 720, 480, 360, 240, 144}) ||
			v.Title != "Матрица (1999)" || v.Season != 0 || len(v.Episodes) != 0 || v.Language != "ru" || v.Provider != ID {
			t.Fatalf("variant %+v", v)
		}
	}
	want := []row{{"Дубляж", "dub"}, {"SDI Media", "mvo"}, {"Гланц и Королёва", "mvo"}, {"Андрей Гаврилов", "avo"}}
	if !slices.Equal(got, want) {
		t.Fatalf("voices %v", got)
	}
	if strings.Contains(string(vs[0].Ref), "ads") || !strings.Contains(string(vs[0].Ref), "19023318440670") {
		t.Fatalf("ref %s", vs[0].Ref)
	}

	st, err := p.Resolve(ctx, vs[0], 720)
	if err != nil {
		t.Fatal(err)
	}
	if st.Format != "mp4" || st.Quality != 720 || !strings.Contains(st.URL, "type=3") || !strings.HasPrefix(st.URL, "https://cdn.example/") ||
		st.Duration != 8178 || st.AudioTrack != 0 ||
		// URLs are signed for the resolver's UA (srcAg): the proxy must reuse it.
		st.Headers["User-Agent"] != webfetch.UserAgent {
		t.Fatalf("stream %+v", st)
	}
	if want := time.UnixMilli(1793348774601); !st.Expires.Equal(want) {
		t.Fatalf("expires %v", st.Expires)
	}
	// 0 = best (the API's "mpeg2kUrl" is the 2160p one: type=7).
	if st, _ := p.Resolve(ctx, vs[0], 0); st.Quality != 2160 || !strings.Contains(st.URL, "type=7") {
		t.Fatalf("best %+v", st)
	}
	// Not offered: best below.
	if st, _ := p.Resolve(ctx, vs[0], 900); st.Quality != 720 {
		t.Fatalf("900 → %d", st.Quality)
	}
	// Videos are cached until shortly before the URLs expire; Refresh drops.
	n := f.requests("/sv/video/19023318440670")
	p.Refresh(vs[0])
	if _, err := p.Resolve(ctx, vs[0], 720); err != nil || f.requests("/sv/video/19023318440670") != n+1 {
		t.Fatalf("refresh refetch: %v %d→%d", err, n, f.requests("/sv/video/19023318440670"))
	}
	// Playlist cached too.
	if _, err := p.Variants(ctx, sources.Title{Kind: "movie", KPID: 301}); err != nil || f.requests("/sv/playlist") != 1 {
		t.Fatalf("playlist cache: %d", f.requests("/sv/playlist"))
	}
	// A movie lookup never returns series uploads and vice versa.
	if vs, _ := p.Variants(ctx, sources.Title{Kind: "series", KPID: 301, Season: 1}); len(vs) != 0 {
		t.Fatalf("series lookup of a film: %d", len(vs))
	}
}

func TestSeriesVariants(t *testing.T) {
	f := newFakeAPI(t)
	p := newProvider(f)
	ctx := context.Background()
	vs, err := p.Variants(ctx, sources.Title{Kind: "series", KPID: 77044, Season: 7})
	if err != nil {
		t.Fatal(err)
	}
	if len(vs) != 2 || vs[0].Voice != "True Dubbing Studio" || vs[1].Voice != "Нота" {
		t.Fatalf("voices %+v", vs)
	}
	for _, v := range vs {
		if v.Season != 7 || !slices.Equal(v.Episodes, []int{1, 2, 3}) || v.Episode != 0 || v.VoiceKind != "mvo" {
			t.Fatalf("variant %+v", v)
		}
	}
	// Season variant: the episode picks the upload.
	v := vs[1]
	if _, err := p.Resolve(ctx, v, 0); !errors.Is(err, sources.ErrNotFound) {
		t.Fatalf("no episode: %v", err)
	}
	v.Episode = 2
	if _, err := p.Resolve(ctx, v, 480); err != nil || f.requests("/sv/video/10087911807570") != 1 {
		t.Fatalf("episode 2 → %v %v", err, f.paths)
	}
	v.Episode = 9
	if _, err := p.Resolve(ctx, v, 480); !errors.Is(err, sources.ErrNotFound) {
		t.Fatalf("missing episode: %v", err)
	}
	// Episode lookup: per-episode variants.
	eps, err := p.Variants(ctx, sources.Title{Kind: "series", KPID: 77044, Season: 1, Episode: 3})
	if err != nil || len(eps) != 2 || eps[0].Episode != 3 || len(eps[0].Episodes) != 0 {
		t.Fatalf("episode variants %+v %v", eps, err)
	}
	var rf ref
	_ = json.Unmarshal(eps[1].Ref, &rf)
	if rf.VK != "10087362943570" {
		t.Fatalf("episode ref %+v", rf)
	}
	// Season 0 means season 1; an absent season is empty.
	if vs, _ := p.Variants(ctx, sources.Title{Kind: "series", KPID: 77044}); len(vs) != 2 || vs[0].Season != 1 {
		t.Fatalf("default season %+v", vs)
	}
	if vs, _ := p.Variants(ctx, sources.Title{Kind: "series", KPID: 77044, Season: 4}); len(vs) != 0 {
		t.Fatalf("season 4 %+v", vs)
	}
}

func TestNotFoundAndErrors(t *testing.T) {
	f := newFakeAPI(t)
	p := newProvider(f)
	ctx := context.Background()
	// No Kinopoisk id: nothing to ask.
	if vs, err := p.Variants(ctx, sources.Title{Kind: "movie", IMDbID: "tt0133093"}); err != nil || len(vs) != 0 || f.requests("/") != 0 {
		t.Fatalf("no kp: %v %v", vs, err)
	}
	if vs, err := p.Variants(ctx, sources.Title{Kind: "movie", KPID: 5}); err != nil || len(vs) != 0 {
		t.Fatalf("unknown: %v %v", vs, err)
	}
	if _, err := p.Resolve(ctx, sources.Variant{Ref: json.RawMessage(`{"vk":"404"}`)}, 0); !errors.Is(err, sources.ErrNotFound) {
		t.Fatalf("gone video: %v", err)
	}
	f.status = 502
	if _, err := p.Variants(ctx, sources.Title{Kind: "movie", KPID: 77}); err == nil || strings.Contains(err.Error(), f.srv.URL) {
		t.Fatalf("502: %v", err)
	}
	if err := p.Probe(ctx); err == nil {
		t.Fatal("probe should fail")
	}
	f.status = 0
	if err := p.Probe(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestConfigureBaseURL(t *testing.T) {
	f := newFakeAPI(t)
	p := New("https://unused.invalid", f.srv.Client())
	p.c.Now = func() time.Time { return now }
	p.Configure(sources.Config{Enabled: true, BaseURL: f.srv.URL + "/sv/"})
	if err := p.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	p.Configure(sources.Config{Enabled: true})
	if p.baseURL() != DefaultBaseURL {
		t.Fatal(p.baseURL())
	}
	if in := p.Info(); in.ID != "cdnvideohub" || in.Kind != sources.KindOnline || !in.Configured {
		t.Fatalf("%+v", in)
	}
}
