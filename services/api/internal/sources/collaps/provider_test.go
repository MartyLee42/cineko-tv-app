package collaps

import (
	"context"
	"errors"
	"martytv/api/internal/sources/internal/webfetch"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"martytv/api/internal/sources"
)

// fakeHost serves trimmed real Collaps embed pages (testdata/, fetched
// 2026-10-29 for kp 301 «Матрица» and kp 77044 «Друзья»; CDN hosts
// scrubbed; season 1 episode 3 has its 2nd voice marked "delete").
type fakeHost struct {
	srv   *httptest.Server
	down  atomic.Bool
	mu    sync.Mutex
	paths []string
}

func newFakeHost(t *testing.T) *fakeHost {
	f := &fakeHost{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.Path)
		f.mu.Unlock()
		if f.down.Load() {
			w.WriteHeader(503)
			return
		}
		file := ""
		switch r.URL.Path {
		case "/embed/kp/301", "/embed/imdb/tt0133093":
			file = "embed_301.html"
		case "/embed/kp/77044":
			file = "embed_77044.html"
		case "/embed/kp/7":
			_, _ = w.Write([]byte("<html><body>видео недоступно</body></html>")) // 200 without a player
			return
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte("видео недоступно"))
			return
		}
		b, err := os.ReadFile("testdata/" + file)
		if err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(strings.ReplaceAll(string(b), "{{CDN}}", "https://cdn.example")))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeHost) count(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, p := range f.paths {
		if p == path {
			n++
		}
	}
	return n
}

func newProvider(hosts ...*fakeHost) *Provider {
	var bases []string
	for _, h := range hosts {
		bases = append(bases, h.srv.URL)
	}
	p := New(strings.Join(bases, ", "), http.DefaultClient)
	p.c.Interval = 0
	p.c.Now = func() time.Time { return time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC) }
	return p
}

func TestMovieVoices(t *testing.T) {
	h := newFakeHost(t)
	p := newProvider(h)
	ctx := context.Background()
	vs, err := p.Variants(ctx, sources.Title{Kind: "movie", KPID: 301, IMDbID: "tt0133093"})
	if err != nil {
		t.Fatal(err)
	}
	var labels []string
	for _, v := range vs {
		labels = append(labels, v.Voice+"/"+v.VoiceKind+"/"+v.Language)
		if v.Format != "hls" || v.MaxQuality != 480 || !slices.Equal(v.Qualities, []int{480}) || v.Title != "Матрица" ||
			!slices.Equal(v.SubtitleLangs, []string{"ru", "en", "uk"}) {
			t.Fatalf("variant %+v", v)
		}
	}
	want := []string{"Дубляж/dub/ru", "Многоголосый/mvo/ru", "НТВ//ru", "Двухголосый/dvo/ru", "П.Гланц и И.Королёва//ru",
		"Одноголосый/vo/ru", "C. Визгунов//ru", "А. Гаврилов//ru", "Одноголосый 2/vo/ru", "А. Дольский//ru", "Д. Есарев//ru",
		"Ю. Живов//ru", "А.Кашкин//ru", `Дмитрий "Goblin" Пучков//ru`, "Одноголосый 3/vo/ru", "Многоголосый (uk)/mvo/uk",
		"Оригинал (en)/original/en"}
	if !slices.Equal(labels, want) {
		t.Fatalf("voices\n got %q\nwant %q", labels, want)
	}

	// Resolve: the master (with &vp), the audio track to keep, subtitles,
	// the embed host as Referer.
	st, err := p.Resolve(ctx, vs[2], 1080) // НТВ = 3rd rendition
	if err != nil {
		t.Fatal(err)
	}
	if st.Format != "hls" || st.AudioTrack != 3 || !strings.HasPrefix(st.URL, "https://cdn.example/") ||
		!strings.HasSuffix(st.URL, "&vp") || !strings.Contains(st.URL, "/master.m3u8?") || st.Headers["Referer"] != h.srv.URL+"/" || st.Headers["User-Agent"] != webfetch.UserAgent {
		t.Fatalf("stream %+v", st)
	}
	if len(st.Subtitles) != 3 || st.Subtitles[1].Lang != "en" || st.Subtitles[1].Label != "Eng. full - 2" {
		t.Fatalf("subs %+v", st.Subtitles)
	}
	if !st.Expires.Equal(time.Unix(1794126355, 0)) {
		t.Fatalf("expires %v", st.Expires)
	}
	if st, _ := p.Resolve(ctx, vs[16], 0); st.AudioTrack != 17 {
		t.Fatalf("original track %d", st.AudioTrack)
	}
	if st, _ := p.Resolve(ctx, vs[8], 0); st.AudioTrack != 9 { // "Одноголосый 2"
		t.Fatalf("dup label track %d", st.AudioTrack)
	}
	if h.count("/embed/kp/301") != 1 {
		t.Fatalf("page not cached: %d", h.count("/embed/kp/301"))
	}
	p.Refresh(vs[0])
	if _, err := p.Resolve(ctx, vs[0], 0); err != nil || h.count("/embed/kp/301") != 2 {
		t.Fatal("refresh should refetch")
	}
}

func TestSeriesEpisodes(t *testing.T) {
	h := newFakeHost(t)
	p := newProvider(h)
	ctx := context.Background()
	vs, err := p.Variants(ctx, sources.Title{Kind: "series", KPID: 77044, Season: 1})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]int{}
	for _, v := range vs {
		got[v.Voice] = v.Episodes
		if v.Season != 1 || v.Episode != 0 || v.Format != "hls" {
			t.Fatalf("variant %+v", v)
		}
	}
	// СТС is "delete"d in episode 3.
	if len(vs) != 4 || !slices.Equal(got["Paramount comedy"], []int{1, 2, 3}) || !slices.Equal(got["СТС"], []int{1, 2}) ||
		!slices.Equal(got["Оригинал (en)"], []int{1, 2, 3}) {
		t.Fatalf("episodes %v", got)
	}
	// Episode 3 of «1+1»: 3rd rendition; duration known.
	var v sources.Variant
	for _, x := range vs {
		if x.Voice == "1+1" {
			v = x
		}
	}
	v.Episode = 3
	st, err := p.Resolve(ctx, v, 0)
	if err != nil || st.AudioTrack != 3 || st.Duration != 1371 || len(st.Subtitles) != 2 {
		t.Fatalf("episode 3: %+v %v", st, err)
	}
	if _, err := p.Resolve(ctx, sources.Variant{Ref: v.Ref}, 0); !errors.Is(err, sources.ErrNotFound) {
		t.Fatalf("season ref without episode: %v", err)
	}
	// Double episode "17-18" serves both numbers.
	vs, err = p.Variants(ctx, sources.Title{Kind: "series", KPID: 77044, Season: 10})
	if err != nil || len(vs) == 0 || !slices.Equal(vs[0].Episodes, []int{1, 2, 3, 17, 18}) {
		t.Fatalf("season 10: %+v %v", vs, err)
	}
	ep, err := p.Variants(ctx, sources.Title{Kind: "series", KPID: 77044, Season: 10, Episode: 18})
	if err != nil || len(ep) != 4 || ep[0].Episode != 18 || len(ep[0].Episodes) != 0 {
		t.Fatalf("episode 18: %+v %v", ep, err)
	}
	if st, err := p.Resolve(ctx, ep[0], 0); err != nil || st.Duration != 2855 {
		t.Fatalf("resolve 18: %+v %v", st, err)
	}
	if vs, _ := p.Variants(ctx, sources.Title{Kind: "series", KPID: 77044, Season: 4}); len(vs) != 0 {
		t.Fatal("missing season should be empty")
	}
	if h.count("/embed/kp/77044") != 1 {
		t.Fatalf("page fetched %d times", h.count("/embed/kp/77044"))
	}
}

func TestLookupFallbacks(t *testing.T) {
	primary, mirror := newFakeHost(t), newFakeHost(t)
	p := newProvider(primary, mirror)
	ctx := context.Background()
	// kp unknown (404) → IMDb id.
	vs, err := p.Variants(ctx, sources.Title{Kind: "movie", KPID: 999, IMDbID: "tt0133093"})
	if err != nil || len(vs) != 17 || primary.count("/embed/kp/999") != 1 || primary.count("/embed/imdb/tt0133093") != 1 {
		t.Fatalf("imdb fallback: %d %v", len(vs), err)
	}
	// No ids at all: no request.
	if vs, err := p.Variants(ctx, sources.Title{Kind: "movie", IMDbID: "nope"}); err != nil || len(vs) != 0 {
		t.Fatal("no ids")
	}
	// A page without a player is "not found".
	if vs, err := p.Variants(ctx, sources.Title{Kind: "movie", KPID: 7}); err != nil || len(vs) != 0 {
		t.Fatalf("no player: %v", err)
	}
	// Primary down → mirror; the stream Referer is the mirror.
	primary.down.Store(true)
	vs, err = p.Variants(ctx, sources.Title{Kind: "series", KPID: 77044, Season: 7})
	if err != nil || len(vs) != 4 || mirror.count("/embed/kp/77044") != 1 {
		t.Fatalf("mirror: %d %v", len(vs), err)
	}
	vs[0].Episode = 1
	if st, err := p.Resolve(ctx, vs[0], 0); err != nil || st.Headers["Referer"] != mirror.srv.URL+"/" {
		t.Fatalf("mirror referer: %+v %v", st, err)
	}
	// Everything down: an error (never cached as "not found").
	mirror.down.Store(true)
	if _, err := p.Variants(ctx, sources.Title{Kind: "movie", KPID: 12345}); err == nil || strings.Contains(err.Error(), "127.0.0.1") {
		t.Fatalf("all down: %v", err)
	}
	if err := p.Probe(ctx); err == nil {
		t.Fatal("probe should fail")
	}
	mirror.down.Store(false)
	if err := p.Probe(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestConfigure(t *testing.T) {
	p := New("", nil)
	if got := p.baseURLs(); !slices.Equal(got, []string{"https://api.nextembed.ws", "https://api.kinogram.best"}) {
		t.Fatal(got)
	}
	p.Configure(sources.Config{BaseURL: " https://a.example/ ,https://b.example;https://a.example"})
	if got := p.baseURLs(); !slices.Equal(got, []string{"https://a.example", "https://b.example"}) {
		t.Fatal(got)
	}
	p.Configure(sources.Config{})
	if len(p.baseURLs()) != 2 {
		t.Fatal(p.baseURLs())
	}
}

func TestParsePageIgnoresScripts(t *testing.T) {
	pg, err := parsePage(`<script>var x = 1;</script>`)
	if pg != nil || err != nil {
		t.Fatal("no player expected")
	}
	pg, err = parsePage("makePlayer({\n blocked: true ,\n title: \"X\",\n source: { hls: \"https://h/x.m3u8\", audio: {\"names\":[\"A\"]}, cc: [] }\n});")
	if err != nil || pg == nil || !pg.Blocked || pg.Title != "X" || pg.Source.HLS != "https://h/x.m3u8" {
		t.Fatalf("%+v %v", pg, err)
	}
}
