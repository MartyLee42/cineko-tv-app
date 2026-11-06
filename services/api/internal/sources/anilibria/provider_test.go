package anilibria

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"martytv/api/internal/sources"
)

// fakeAPI serves trimmed real AniLiberty responses (testdata/, fetched
// 2026-10-29) plus releases derived from them.
type fakeAPI struct {
	t        *testing.T
	srv      *httptest.Server
	mu       sync.Mutex
	searches []string
	releases []string
	status   int // forced status for every request (0 = normal)
	rel      map[string][]byte
}

func newFakeAPI(t *testing.T) *fakeAPI {
	f := &fakeAPI{t: t, rel: map[string][]byte{}}
	base, err := os.ReadFile("testdata/release_8789.json")
	if err != nil {
		t.Fatal(err)
	}
	f.rel["8789"] = base
	// Season 2 (9470) and the movie (6826): same shape, different ids/names.
	derive := func(id int, typ, main, en string, year, eps int) []byte {
		var r map[string]any
		_ = json.Unmarshal(base, &r)
		r["id"], r["year"] = id, year
		r["type"] = map[string]any{"value": typ}
		r["name"] = map[string]any{"main": main, "english": en, "alternative": nil}
		list := r["episodes"].([]any)[:eps]
		for i, e := range list {
			m := e.(map[string]any)
			m["id"] = strings.Replace(m["id"].(string), "95d6", "aaaa", 1) + string(rune('a'+i))
			for _, k := range []string{"hls_480", "hls_720", "hls_1080"} {
				m[k] = strings.Replace(m[k].(string), "/8789/", "/"+itoa(id)+"/", 1)
			}
		}
		r["episodes"] = list
		b, _ := json.Marshal(r)
		return b
	}
	f.rel["9470"] = derive(9470, "TV", "Магическая битва 2", "JUJUTSU KAISEN Season 2", 2023, 3)
	f.rel["6826"] = derive(6826, "MOVIE", "Твоё имя", "Kimi no Na wa", 2016, 1)
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.status != 0 {
		w.Header().Set("Retry-After", "5")
		w.WriteHeader(f.status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path == "/api/v1/app/search/releases":
		q := strings.ToLower(r.URL.Query().Get("query"))
		f.searches = append(f.searches, q)
		file := ""
		switch {
		case strings.Contains(q, "магическая битва"):
			file = "search_bitva.json"
		case strings.Contains(q, "jujutsu"):
			file = "search_jujutsu.json"
		case strings.Contains(q, "твоё имя"), strings.Contains(q, "kimi no na wa"):
			file = "search_kiminonawa.json"
		}
		if file == "" {
			_, _ = w.Write([]byte("[]"))
			return
		}
		b, _ := os.ReadFile("testdata/" + file)
		_, _ = w.Write(b)
	case strings.HasPrefix(r.URL.Path, "/api/v1/anime/releases/"):
		id := strings.TrimPrefix(r.URL.Path, "/api/v1/anime/releases/")
		f.releases = append(f.releases, id)
		b, ok := f.rel[id]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"not found"}`))
			return
		}
		_, _ = w.Write(b)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fakeAPI) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.searches), len(f.releases)
}

func newTestProvider(f *fakeAPI) *Provider {
	p := New(f.srv.URL+"/api/v1", f.srv.Client())
	p.c.interval = 5 * time.Millisecond
	return p
}

var jjk = sources.Title{Kind: "tv", TitleRU: "Магическая битва", TitleEN: "Jujutsu Kaisen", Original: "呪術廻戦",
	OriginalLanguage: "ja", Genres: []int{16, 10759}, Year: 2020}

func TestVariantsEpisodeAndResolve(t *testing.T) {
	f := newFakeAPI(t)
	p := newTestProvider(f)
	ctx := context.Background()
	tt := jjk
	tt.Season, tt.Episode = 1, 2
	vs, err := p.Variants(ctx, tt)
	if err != nil || len(vs) != 1 {
		t.Fatalf("variants = %v, %v", vs, err)
	}
	v := vs[0]
	if v.Provider != ID || v.Voice != "AniLibria" || v.VoiceKind != "mvo" || v.Format != "hls" || v.MaxQuality != 1080 ||
		len(v.Qualities) != 3 || v.Season != 1 || v.Episode != 2 || len(v.Ref) == 0 {
		t.Fatalf("variant = %+v", v)
	}
	for _, tc := range []struct{ want, got int }{{0, 1080}, {720, 720}, {1080, 1080}, {600, 480}, {360, 480}} {
		st, err := p.Resolve(ctx, v, tc.want)
		if err != nil || st.Quality != tc.got || st.Format != "hls" ||
			!strings.Contains(st.URL, "/8789/2/"+itoa(tc.got)+"/") {
			t.Fatalf("resolve(%d) = %+v, %v", tc.want, st, err)
		}
	}
	m := p.SkipMarkers(ctx, v)
	if op, ok := m["opening"]; !ok || op != [2]float64{345, 434} {
		t.Fatalf("markers = %v", m)
	}
	if _, ok := m["ending"]; ok {
		t.Fatalf("null ending must be omitted: %v", m)
	}

	// Cached: mapping, search and release are not fetched again.
	s0, r0 := f.counts()
	tt.Episode = 3
	if vs, err := p.Variants(ctx, tt); err != nil || len(vs) != 1 {
		t.Fatalf("variants ep3 = %v, %v", vs, err)
	}
	if s1, r1 := f.counts(); s1 != s0 || r1 != r0 {
		t.Fatalf("expected cache hits, searches %d→%d releases %d→%d", s0, s1, r0, r1)
	}
}

func TestVariantsSeasonAbsoluteAndMovie(t *testing.T) {
	f := newFakeAPI(t)
	p := newTestProvider(f)
	ctx := context.Background()

	// Whole season: one voice with the episode list; Resolve needs Episode.
	tt := jjk
	tt.Season = 1
	vs, err := p.Variants(ctx, tt)
	if err != nil || len(vs) != 1 || len(vs[0].Episodes) != 3 || vs[0].Episodes[0] != 1 || vs[0].Episode != 0 {
		t.Fatalf("season variants = %+v, %v", vs, err)
	}
	if _, err := p.Resolve(ctx, vs[0], 0); !errors.Is(err, sources.ErrNotFound) {
		t.Fatalf("season resolve without episode = %v", err)
	}
	v := vs[0]
	v.Episode = 3
	if st, err := p.Resolve(ctx, v, 720); err != nil || !strings.Contains(st.URL, "/8789/3/720/") {
		t.Fatalf("season resolve ep3 = %+v, %v", st, err)
	}

	// Season 2 by its own release.
	tt.Season, tt.Episode = 2, 1
	vs, err = p.Variants(ctx, tt)
	if err != nil || len(vs) != 1 {
		t.Fatalf("s2 variants = %v, %v", vs, err)
	}
	if st, _ := p.Resolve(ctx, vs[0], 0); st == nil || !strings.Contains(st.URL, "/9470/1/1080/") {
		t.Fatalf("s2 resolve = %+v", st)
	}

	// Absolute numbering: TMDB S1E5 → past the 3 episodes of 8789 → 9470 ep 2.
	tt.Season, tt.Episode = 1, 5
	vs, err = p.Variants(ctx, tt)
	if err != nil || len(vs) != 1 {
		t.Fatalf("absolute variants = %v, %v", vs, err)
	}
	if st, _ := p.Resolve(ctx, vs[0], 0); st == nil || !strings.Contains(st.URL, "/9470/2/1080/") {
		t.Fatalf("absolute resolve = %+v", st)
	}
	// Beyond the chain → nothing.
	tt.Episode = 40
	if vs, err := p.Variants(ctx, tt); err != nil || len(vs) != 0 {
		t.Fatalf("beyond chain = %v, %v", vs, err)
	}

	// Movie.
	mv := sources.Title{Kind: "movie", TitleRU: "Твоё имя", TitleEN: "Your Name.", Original: "君の名は。",
		OriginalLanguage: "ja", Genres: []int{16, 10749}, Year: 2016}
	vs, err = p.Variants(ctx, mv)
	if err != nil || len(vs) != 1 || vs[0].Season != 0 || vs[0].Episode != 0 {
		t.Fatalf("movie variants = %+v, %v", vs, err)
	}
	if st, _ := p.Resolve(ctx, vs[0], 0); st == nil || !strings.Contains(st.URL, "/6826/1/1080/") {
		t.Fatalf("movie resolve = %+v", st)
	}
}

func TestVariantsGatesAndErrors(t *testing.T) {
	f := newFakeAPI(t)
	p := newTestProvider(f)
	ctx := context.Background()

	// Not animation / western animation: no API calls at all.
	for _, tt := range []sources.Title{
		{Kind: "movie", TitleRU: "Матрица", Genres: []int{28, 878}, Year: 1999, OriginalLanguage: "en"},
		{Kind: "tv", TitleRU: "Аркейн", Genres: []int{16}, Year: 2021, OriginalLanguage: "en"},
	} {
		if vs, err := p.Variants(ctx, tt); err != nil || len(vs) != 0 {
			t.Fatalf("gated = %v, %v", vs, err)
		}
	}
	if s, r := f.counts(); s+r != 0 {
		t.Fatalf("gated titles hit the API: %d searches, %d releases", s, r)
	}

	// Unknown anime → empty, miss cached.
	unk := sources.Title{Kind: "tv", TitleRU: "Несуществующее аниме", Genres: []int{16}, Year: 2020, OriginalLanguage: "ja"}
	if vs, err := p.Variants(ctx, unk); err != nil || len(vs) != 0 {
		t.Fatalf("unknown = %v, %v", vs, err)
	}
	s0, _ := f.counts()
	_, _ = p.Variants(ctx, unk)
	if s1, _ := f.counts(); s1 != s0 {
		t.Fatal("miss not cached")
	}

	// 429: error (not cached as "not found"), then the client backs off
	// without calling the API.
	f.mu.Lock()
	f.status = http.StatusTooManyRequests
	f.mu.Unlock()
	tt := jjk
	tt.Season, tt.Episode = 1, 1
	if _, err := p.Variants(ctx, tt); !errors.Is(err, errRateLimited) {
		t.Fatalf("429 err = %v", err)
	}
	s0, _ = f.counts()
	f.mu.Lock()
	f.status = 0
	f.mu.Unlock()
	if _, err := p.Variants(ctx, tt); !errors.Is(err, errRateLimited) {
		t.Fatalf("during back-off err = %v", err)
	}
	if s1, _ := f.counts(); s1 != s0 {
		t.Fatal("called the API during back-off")
	}
	if err := p.Probe(ctx); !errors.Is(err, errRateLimited) {
		t.Fatalf("probe during back-off = %v", err)
	}

	// Bad refs.
	if _, err := p.Resolve(ctx, sources.Variant{Ref: json.RawMessage(`{}`)}, 0); !errors.Is(err, sources.ErrNotFound) {
		t.Fatalf("empty ref = %v", err)
	}
}

func TestProbeAndInfo(t *testing.T) {
	f := newFakeAPI(t)
	p := newTestProvider(f)
	if err := p.Probe(context.Background()); err != nil {
		t.Fatal(err)
	}
	in := p.Info()
	if in.ID != "anilibria" || in.Kind != sources.KindAnime || in.NeedsCredentials || !in.Configured {
		t.Fatalf("info = %+v", in)
	}
	// Admin base URL override.
	p.Configure(sources.Config{BaseURL: "http://127.0.0.1:1/api/v1"})
	if err := p.Probe(context.Background()); err == nil {
		t.Fatal("probe against a dead base URL succeeded")
	}
}
