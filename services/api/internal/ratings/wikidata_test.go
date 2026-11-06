package ratings

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSPARQL answers the batched Kinopoisk query from a table keyed by
// "tm:<tmdb movie>", "tv:<tmdb tv>" and "i:<imdb>"; each entry lists the
// matching items as (kp, item imdb) pairs. It records every request.
type fakeSPARQL struct {
	mu      sync.Mutex
	data    map[string][][2]string
	queries []string
	values  []int // VALUES entries per query
	ua      []string
	// status: the next responses' codes (popped; empty = 200).
	status     []int
	retryAfter string
	srv        *httptest.Server
}

var valuesRe = regexp.MustCompile(`VALUES \?(tm|tv|i) \{([^}]*)\}`)
var quotedRe = regexp.MustCompile(`"([^"]*)"`)

func newFakeSPARQL(t *testing.T) *fakeSPARQL {
	f := &fakeSPARQL{data: map[string][][2]string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Method != http.MethodPost || r.Header.Get("Accept") != "application/sparql-results+json" ||
			r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		q := r.PostFormValue("query")
		f.queries = append(f.queries, q)
		f.ua = append(f.ua, r.Header.Get("User-Agent"))
		if len(f.status) > 0 {
			code := f.status[0]
			f.status = f.status[1:]
			if f.retryAfter != "" {
				w.Header().Set("Retry-After", f.retryAfter)
			}
			w.WriteHeader(code)
			return
		}
		var bindings []map[string]map[string]string
		n := 0
		for _, m := range valuesRe.FindAllStringSubmatch(q, -1) {
			for _, v := range quotedRe.FindAllStringSubmatch(m[2], -1) {
				n++
				for _, item := range f.data[m[1]+":"+v[1]] {
					b := map[string]map[string]string{
						m[1]: {"type": "literal", "value": v[1]},
						"kp": {"type": "literal", "value": item[0]},
					}
					if item[1] != "" {
						b["imdb"] = map[string]string{"type": "literal", "value": item[1]}
					}
					bindings = append(bindings, b)
				}
			}
		}
		f.values = append(f.values, n)
		w.Header().Set("Content-Type", "application/sparql-results+json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"head":    map[string]any{"vars": []string{"tm", "tv", "i", "kp", "imdb"}},
			"results": map[string]any{"bindings": bindings},
		})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeSPARQL) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.queries)
}

// fakeClock: sleeping advances it (and is recorded) instead of waiting.
type fakeClock struct {
	mu    sync.Mutex
	t     time.Time
	slept []time.Duration
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func (c *fakeClock) sleep(_ context.Context, d time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.slept = append(c.slept, d)
	c.t = c.t.Add(d)
	return nil
}

func newTestWikidata(f *fakeSPARQL) (*WikidataClient, *fakeClock) {
	clk := &fakeClock{t: time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)}
	c := NewWikidata(f.srv.URL, HTTPClient(nil, 5*time.Second))
	c.now, c.sleep = clk.now, clk.sleep
	return c, clk
}

func TestWikidataBatchingAndParsing(t *testing.T) {
	f := newFakeSPARQL(t)
	// Real values (checked live 2026-11): Appaloosa, Shawshank, Dark Knight.
	f.data["tm:12690"] = [][2]string{{"261661", "tt0800308"}}
	f.data["tm:278"] = [][2]string{{"326", "tt0111161"}}
	f.data["tv:12690"] = [][2]string{{"999", ""}} // TMDB tv ids collide with movie ids
	f.data["i:tt0468569"] = [][2]string{{"111543", "tt0468569"}}
	c, _ := newTestWikidata(f)

	titles := []WDTitle{
		{ID: "appaloosa", Kind: "movie", TMDBID: 12690, IMDbID: "tt0800308"},
		{ID: "shawshank", Kind: "movie", TMDBID: 278},
		{ID: "show", Kind: "series", TMDBID: 12690},
		{ID: "dark", Kind: "movie", TMDBID: 155, IMDbID: "tt0468569"}, // only Wikidata's IMDb link known
		{ID: "nokeys", Kind: "movie", IMDbID: "bogus\" } DROP"},       // nothing usable: no request
	}
	for i := range 315 {
		titles = append(titles, WDTitle{ID: "x" + strconv.Itoa(i), Kind: "movie", TMDBID: 100000 + i})
	}
	res, err := c.Lookup(context.Background(), titles)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{"appaloosa": 261661, "shawshank": 326, "show": 999, "dark": 111543}
	if len(res.Found) != len(want) {
		t.Fatalf("found %v", res.Found)
	}
	for id, kp := range want {
		if res.Found[id] != kp {
			t.Fatalf("%s: %d", id, res.Found[id])
		}
	}
	// 319 titles to ask (+1 without keys) → 3 batches of ≤ 150.
	if res.Queries != 3 || f.count() != 3 || len(res.Queried) != len(titles) {
		t.Fatalf("queries %d/%d, queried %d", res.Queries, f.count(), len(res.Queried))
	}
	if f.values[0] != 152 || f.values[2] != 19 { // first: 150 TMDB ids + 2 IMDb ids
		t.Fatalf("values per query %v", f.values)
	}
	q := f.queries[0]
	for _, s := range []string{"wdt:P4947 ?tm", "wdt:P4983 ?tv", "wdt:P345 ?i", "wdt:P2603 ?kp", `"tt0800308"`} {
		if !strings.Contains(q, s) {
			t.Fatalf("query lacks %q:\n%s", s, q)
		}
	}
	if strings.Contains(strings.Join(f.queries, ""), "DROP") {
		t.Fatal("unvalidated IMDb id reached the query")
	}
	if f.ua[0] != "Cineko/1.0 (self-hosted; contact: admin)" {
		t.Fatalf("user agent %q", f.ua[0])
	}
}

func TestWikidataConflicts(t *testing.T) {
	f := newFakeSPARQL(t)
	// Two Kinopoisk ids for one TMDB id, no IMDb to choose by → conflict.
	f.data["tm:1"] = [][2]string{{"11", ""}, {"12", ""}}
	// Two, one of them carrying our IMDb id → that one.
	f.data["tm:2"] = [][2]string{{"21", "tt0000021"}, {"22", "tt0000022"}}
	// TMDB match whose IMDb id contradicts ours → conflict.
	f.data["tm:3"] = [][2]string{{"31", "tt0000099"}}
	// IMDb and TMDB disagree: the IMDb match wins.
	f.data["tm:4"] = [][2]string{{"41", ""}}
	f.data["i:tt0000042"] = [][2]string{{"42", "tt0000042"}}
	// Two items share our IMDb id with different Kinopoisk ids → conflict.
	f.data["i:tt0000050"] = [][2]string{{"51", "tt0000050"}, {"52", "tt0000050"}}
	// One item with two IMDb ids (two rows, same Kinopoisk id) → fine.
	f.data["tm:6"] = [][2]string{{"61", "tt0000061"}, {"61", "tt0000062"}}
	// Junk Kinopoisk value is ignored.
	f.data["tm:7"] = [][2]string{{"film/71", ""}}
	c, _ := newTestWikidata(f)
	res, err := c.Lookup(context.Background(), []WDTitle{
		{ID: "a", Kind: "movie", TMDBID: 1},
		{ID: "b", Kind: "movie", TMDBID: 2, IMDbID: "tt0000021"},
		{ID: "c", Kind: "movie", TMDBID: 3, IMDbID: "tt0000031"},
		{ID: "d", Kind: "movie", TMDBID: 4, IMDbID: "tt0000042"},
		{ID: "e", Kind: "movie", TMDBID: 5, IMDbID: "tt0000050"},
		{ID: "f", Kind: "movie", TMDBID: 6, IMDbID: "tt0000062"},
		{ID: "g", Kind: "movie", TMDBID: 7},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Found) != 3 || res.Found["b"] != 21 || res.Found["d"] != 42 || res.Found["f"] != 61 {
		t.Fatalf("found %v", res.Found)
	}
	if res.Conflicts != 3 || len(res.Queried) != 7 || res.Queries != 1 {
		t.Fatalf("conflicts %d queried %d queries %d", res.Conflicts, len(res.Queried), res.Queries)
	}
}

func TestWikidataBackoffAndSpacing(t *testing.T) {
	ctx := context.Background()
	f := newFakeSPARQL(t)
	f.data["tm:1"] = [][2]string{{"10", ""}}
	c, clk := newTestWikidata(f)
	one := []WDTitle{{ID: "a", Kind: "movie", TMDBID: 1}}

	// Back-to-back queries are spaced ≥ 1 s (the first one doesn't wait).
	for range 3 {
		if _, err := c.Lookup(ctx, one); err != nil {
			t.Fatal(err)
		}
	}
	if len(clk.slept) != 2 || clk.slept[0] != time.Second || clk.slept[1] != time.Second {
		t.Fatalf("spacing %v", clk.slept)
	}
	clk.advance(5 * time.Second) // idle long enough: no wait
	clk.slept = nil
	if _, err := c.Lookup(ctx, one); err != nil || len(clk.slept) != 0 {
		t.Fatalf("%v %v", err, clk.slept)
	}

	// 429 with Retry-After: no request until it has passed.
	f.mu.Lock()
	f.status, f.retryAfter = []int{429}, "120"
	f.mu.Unlock()
	clk.advance(2 * time.Second)
	if _, err := c.Lookup(ctx, one); err == nil {
		t.Fatal("429 must fail")
	}
	n := f.count()
	if _, err := c.Lookup(ctx, one); !errors.Is(err, ErrWikidataBackoff) || f.count() != n {
		t.Fatalf("during back-off: %v, %d requests", err, f.count()-n)
	}
	if d := c.BackoffRemaining(); d != 120*time.Second {
		t.Fatalf("back-off %v", d)
	}
	if _, err := c.Health(); err == nil {
		t.Fatal("health must report the failure")
	}
	clk.advance(121 * time.Second)
	if res, err := c.Lookup(ctx, one); err != nil || res.Found["a"] != 10 {
		t.Fatalf("after back-off: %v %v", res, err)
	}
	if _, err := c.Health(); err != nil {
		t.Fatal("health must recover")
	}

	// 5xx without Retry-After: exponential back-off from 30 s.
	f.mu.Lock()
	f.status, f.retryAfter = []int{503, 503}, ""
	f.mu.Unlock()
	clk.advance(2 * time.Second)
	_, _ = c.Lookup(ctx, one)
	if d := c.BackoffRemaining(); d != 30*time.Second {
		t.Fatalf("first 5xx back-off %v", d)
	}
	clk.advance(31 * time.Second)
	_, _ = c.Lookup(ctx, one)
	if d := c.BackoffRemaining(); d != 60*time.Second {
		t.Fatalf("second 5xx back-off %v", d)
	}
	if retryAfter("Wed, 21 Oct 2015 07:28:00 GMT", time.Date(2015, 10, 21, 7, 27, 0, 0, time.UTC)) != time.Minute {
		t.Fatal("retry-after date")
	}
}

func newWDService(t *testing.T, store *fakeStore, m *mockKP, f *fakeSPARQL, withKey bool) *Service {
	s := newTestService(t, store, m, 100, withKey)
	s.wd, _ = newTestWikidata(f)
	return s
}

// Lists queue Wikidata lookups (batched); matches are refreshed keylessly,
// misses are marked and only then go to the keyed API.
func TestServiceWikidataFirst(t *testing.T) {
	ctx := context.Background()
	store, m, f := newFakeStore(), newMockKP(t), newFakeSPARQL(t)
	f.data["tm:12690"] = [][2]string{{"261661", "tt0800308"}}
	f.data["tv:5"] = [][2]string{{"555", ""}}
	store.add("appaloosa", Target{Kind: "movie", TMDBID: 12690, Year: 2008, Titles: []string{"Appaloosa"}})
	store.add("show", Target{Kind: "series", TMDBID: 5})
	// Not on Wikidata; the keyed API knows it by IMDb id.
	store.add("matrix", Target{Kind: "movie", TMDBID: 603, IMDbID: "tt0133093", Year: 1999})
	s := newWDService(t, store, m, f, true)

	if _, err := s.Ratings(ctx, []string{"appaloosa", "show", "matrix"}); err != nil {
		t.Fatal(err)
	}
	if r, _ := s.Pending(); r != 3 || f.count() != 0 {
		t.Fatalf("pending %d, %d queries (lists must not query)", r, f.count())
	}
	s.Drain()
	if f.count() != 1 {
		t.Fatalf("one batched query expected, got %d", f.count())
	}
	if r := store.rows["appaloosa"]; r.KPID == nil || *r.KPID != 261661 || store.ratings["appaloosa"].KP == nil {
		t.Fatalf("appaloosa %+v", r)
	}
	if r := store.rows["show"]; r.KPID == nil || *r.KPID != 555 {
		t.Fatalf("show %+v", r)
	}
	if r := store.rows["matrix"]; r.KPID == nil || *r.KPID != 301 || store.wdMisses["matrix"] != 1 {
		t.Fatalf("matrix %+v (wd misses %v)", r, store.wdMisses)
	}
	if api, xml := m.counts(); api != 1 || xml != 3 { // only matrix used the keyed API
		t.Fatalf("api %d xml %d", api, xml)
	}
	if s.budget.Remaining(ctx, High) != 99 {
		t.Fatal("wikidata must not spend the budget")
	}

	// A marked miss is not asked again (30 days).
	store.add("nowhere", Target{Kind: "movie", TMDBID: 7})
	_, _ = s.Ratings(ctx, []string{"nowhere"})
	s.Drain()
	_, _ = s.Ratings(ctx, []string{"nowhere"})
	s.Drain()
	if f.count() != 2 || store.wdMisses["nowhere"] != 1 {
		t.Fatalf("queries %d, misses %v", f.count(), store.wdMisses)
	}
}

func TestServiceDetailWikidataFirst(t *testing.T) {
	ctx := context.Background()
	store, m, f := newFakeStore(), newMockKP(t), newFakeSPARQL(t)
	f.data["tm:12690"] = [][2]string{{"261661", "tt0800308"}}
	store.add("appaloosa", Target{Kind: "movie", TMDBID: 12690, IMDbID: "tt0800308", Year: 2008})
	store.add("matrix", Target{Kind: "movie", TMDBID: 603, IMDbID: "tt0133093", Year: 1999})
	s := newWDService(t, store, m, f, true)

	r, err := s.DetailRatings(ctx, "appaloosa")
	if err != nil || r.KPID == nil || *r.KPID != 261661 || r.KP == nil {
		t.Fatalf("%+v %v", r, err)
	}
	if api, _ := m.counts(); api != 0 || f.count() != 1 {
		t.Fatalf("api %d wikidata %d", api, f.count())
	}
	// Wikidata miss → the keyed API, same request.
	if r, _ := s.DetailRatings(ctx, "matrix"); r.KPID == nil || *r.KPID != 301 {
		t.Fatalf("%+v", r)
	}
	if api, _ := m.counts(); api != 1 || store.wdMisses["matrix"] != 1 {
		t.Fatalf("api %d", api)
	}
	// Wikidata backing off: Details go straight to the keyed API.
	f.mu.Lock()
	f.status = []int{429}
	f.mu.Unlock()
	store.add("m2", Target{Kind: "movie", TMDBID: 1, IMDbID: "tt0133093"})
	store.add("m3", Target{Kind: "movie", TMDBID: 2, IMDbID: "tt0133093"})
	_, _ = s.DetailRatings(ctx, "m2") // the 429 itself
	n := f.count()
	if r, _ := s.DetailRatings(ctx, "m3"); r.KPID == nil || f.count() != n || store.wdMisses["m3"] != 0 {
		t.Fatalf("%+v, %d queries", r, f.count()-n)
	}
}

func TestServiceWikidataWithoutKeyAndBackfill(t *testing.T) {
	ctx := context.Background()
	store, m, f := newFakeStore(), newMockKP(t), newFakeSPARQL(t)
	for i := range 160 {
		store.add("t"+strconv.Itoa(1000+i), Target{Kind: "movie", TMDBID: 1000 + i})
		f.data["tm:"+strconv.Itoa(1000+i)] = [][2]string{}
	}
	f.data["tm:1003"] = [][2]string{{"3", ""}}
	f.data["tm:1155"] = [][2]string{{"155", ""}}
	s := newWDService(t, store, m, f, false)
	if !s.Configured() {
		t.Fatal("wikidata alone resolves ids")
	}

	n, err := s.BackfillWikidataOnce(ctx)
	if err != nil || n != 150 || f.count() != 1 {
		t.Fatalf("batch 1: %d %v, %d queries", n, err, f.count())
	}
	n, err = s.BackfillWikidataOnce(ctx)
	if err != nil || n != 10 {
		t.Fatalf("batch 2: %d %v", n, err)
	}
	if n, _ := s.BackfillWikidataOnce(ctx); n != 0 || f.count() != 2 {
		t.Fatalf("backlog must be empty: %d, %d queries", n, f.count())
	}
	if *store.rows["t1003"].KPID != 3 || *store.rows["t1155"].KPID != 155 || len(store.wdMisses) != 158 {
		t.Fatalf("misses %d", len(store.wdMisses))
	}
	if _, f := s.Pending(); f != 2 { // matches wait for the keyless refresh
		t.Fatalf("refresh pending %d", f)
	}
	s.Drain()
	if api, xml := m.counts(); api != 0 || xml != 2 {
		t.Fatalf("api %d xml %d", api, xml)
	}
	st := s.Probe(ctx)
	if !st.Configured || !st.OK || st.Version != "wikidata" || st.BudgetRemaining != nil || st.Error != "" {
		t.Fatalf("status %+v", st)
	}
}
