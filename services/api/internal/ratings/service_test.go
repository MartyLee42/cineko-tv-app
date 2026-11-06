package ratings

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeStore is an in-memory Store that counts batched reads.
type fakeStore struct {
	mu       sync.Mutex
	rows     map[string]Row
	targets  map[string]Target
	ratings  map[string]Values
	misses   map[string]int
	wdMisses map[string]int
	imdb     map[string]string
	rowCalls int
	budget   memBudget
}

func newFakeStore() *fakeStore {
	return &fakeStore{rows: map[string]Row{}, targets: map[string]Target{}, ratings: map[string]Values{},
		misses: map[string]int{}, wdMisses: map[string]int{}, imdb: map[string]string{}, budget: memBudget{days: map[string]int{}}}
}

func (f *fakeStore) add(id string, t Target) {
	f.rows[id] = Row{ID: id}
	f.targets[id] = t
}

func (f *fakeStore) Rows(_ context.Context, ids []string) (map[string]Row, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rowCalls++
	out := map[string]Row{}
	for _, id := range ids {
		if r, ok := f.rows[id]; ok {
			out[id] = r
		}
	}
	return out, nil
}

func (f *fakeStore) Target(_ context.Context, id string) (Target, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.targets[id], nil
}

func (f *fakeStore) SaveIMDb(_ context.Context, id, imdb string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.imdb[id] = imdb
	return nil
}

func (f *fakeStore) SaveKPID(_ context.Context, id string, kp int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.rows[id]
	r.KPID, r.LookupFailedAt = &kp, nil
	f.rows[id] = r
	return nil
}

func (f *fakeStore) SaveMiss(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	r := f.rows[id]
	r.LookupFailedAt = &now
	f.rows[id] = r
	f.misses[id]++
	return nil
}

func (f *fakeStore) WDTitles(_ context.Context, ids []string) ([]WDTitle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []WDTitle
	for _, id := range ids {
		if t, ok := f.targets[id]; ok {
			out = append(out, WDTitle{ID: id, Kind: t.Kind, TMDBID: t.TMDBID, IMDbID: t.IMDbID})
		}
	}
	return out, nil
}

func (f *fakeStore) SaveWikidataMiss(_ context.Context, ids []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	for _, id := range ids {
		r := f.rows[id]
		if r.KPID == nil {
			r.WikidataAt = &now
			f.rows[id] = r
			f.wdMisses[id]++
		}
	}
	return nil
}

// WikidataBacklog: ids without kp_id and no Wikidata answer, sorted.
func (f *fakeStore) WikidataBacklog(_ context.Context, _ time.Duration, limit int) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for id, r := range f.rows {
		if r.KPID == nil && r.WikidataAt == nil {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out[:min(limit, len(out))], nil
}

func (f *fakeStore) SaveRatings(_ context.Context, id string, v Values) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	r := f.rows[id]
	r.KP, r.IMDb, r.FetchedAt = v.KP, v.IMDb, &now
	f.rows[id] = r
	f.ratings[id] = v
	return nil
}

func (f *fakeStore) LoadBudget(ctx context.Context, day string) (int, error) {
	return f.budget.LoadBudget(ctx, day)
}
func (f *fakeStore) SaveBudget(ctx context.Context, day string, used int) error {
	return f.budget.SaveBudget(ctx, day, used)
}

// mockKP serves the unofficial API and the rating XML, counting requests.
type mockKP struct {
	mu       sync.Mutex
	api, xml int
	quota    bool
	delay    time.Duration
	srv      *httptest.Server
}

func newMockKP(t *testing.T) *mockKP {
	m := &mockKP{}
	m.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/api_keys/") { // quota status: not counted
			_, _ = w.Write([]byte(`{"dailyQuota":{"value":500,"used":0},"accountType":"FREE"}`))
			return
		}
		m.mu.Lock()
		quota, delay := m.quota, m.delay
		if strings.HasSuffix(r.URL.Path, ".xml") {
			m.xml++
		} else {
			m.api++
		}
		m.mu.Unlock()
		time.Sleep(delay)
		if strings.HasSuffix(r.URL.Path, ".xml") {
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/"), ".xml")
			w.Header().Set("Content-Type", "text/xml")
			_, _ = w.Write([]byte(`<rating><kp_rating num_vote="100">7.` + id[:1] + `1</kp_rating><imdb_rating num_vote="50">6.9</imdb_rating></rating>`))
			return
		}
		if quota {
			w.WriteHeader(http.StatusPaymentRequired)
			return
		}
		q := r.URL.Query()
		item := func(kp int, imdb, ru, orig string, year int, typ string) string {
			b, _ := json.Marshal(map[string]any{"kinopoiskId": kp, "imdbId": imdb, "nameRu": ru, "nameOriginal": orig, "year": year, "type": typ})
			return string(b)
		}
		var items []string
		switch {
		case q.Get("imdbId") == "tt0133093":
			items = append(items, item(301, "tt0133093", "Матрица", "The Matrix", 1999, "FILM"))
		case q.Get("keyword") == "Alpha":
			items = append(items, item(501, "", "Альфа", "Alpha", 2000, "FILM"), item(502, "", "Альфа", "Alpha", 2010, "FILM"))
		case q.Get("keyword") == "Twin":
			items = append(items, item(601, "", "", "Twin", 2005, "FILM"), item(602, "", "", "Twin", 2005, "FILM"))
		}
		_, _ = w.Write([]byte(`{"items":[` + strings.Join(items, ",") + `]}`))
	}))
	t.Cleanup(m.srv.Close)
	return m
}

func (m *mockKP) counts() (int, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.api, m.xml
}

type fakeTMDB struct{ hits int }

func (f *fakeTMDB) Configured() bool { return true }
func (f *fakeTMDB) Get(_ context.Context, path string, _ url.Values) ([]byte, error) {
	f.hits++
	if path == "/movie/603/external_ids" {
		return []byte(`{"id":603,"imdb_id":"tt0133093"}`), nil
	}
	return []byte(`{"imdb_id":null}`), nil
}

func newTestService(t *testing.T, store *fakeStore, m *mockKP, budget int, withKey bool) *Service {
	client := HTTPClient(nil, 2*time.Second)
	var prov Provider
	if withKey {
		prov = NewUnofficial(m.srv.URL, testKey, client)
	}
	return New(Options{Store: store, Provider: prov, Ratings: NewRatingClient(m.srv.URL, client),
		TMDB: &fakeTMDB{}, Budget: budget, APIRate: 1000, XMLRate: 1000,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
}

func TestServiceResolveAndAnnotate(t *testing.T) {
	ctx := context.Background()
	store, m := newFakeStore(), newMockKP(t)
	// Matrix has no IMDb id yet: it is fetched from TMDB, then matched.
	store.add("matrix", Target{Kind: "movie", TMDBID: 603, Year: 1999, Titles: []string{"The Matrix"}})
	store.add("alpha", Target{Kind: "movie", TMDBID: 100, Year: 2010, Titles: []string{"Alpha", "Альфа"}})
	store.add("twin", Target{Kind: "movie", TMDBID: 200, Year: 2005, Titles: []string{"Twin"}})
	for i := range 20 {
		store.add("other"+strconv.Itoa(i), Target{Kind: "movie", TMDBID: 1000 + i})
	}
	s := newTestService(t, store, m, 100, true)

	ids := []string{"matrix", "alpha", "twin"}
	for i := range 20 {
		ids = append(ids, "other"+strconv.Itoa(i))
	}
	// Annotation: ONE store read for the whole batch, no Kinopoisk calls.
	got, err := s.Ratings(ctx, ids)
	if err != nil || len(got) != 23 || store.rowCalls != 1 {
		t.Fatalf("%d rows, %d reads, %v", len(got), store.rowCalls, err)
	}
	if api, xml := m.counts(); api+xml != 0 {
		t.Fatal("annotation must not call Kinopoisk")
	}
	if r, _ := s.Pending(); r != 23 {
		t.Fatalf("pending %d", r)
	}
	s.Drain()

	if r := store.rows["matrix"]; r.KPID == nil || *r.KPID != 301 || store.imdb["matrix"] != "tt0133093" || *store.ratings["matrix"].KP != 7.31 {
		t.Fatalf("matrix %+v", r)
	}
	if r := store.rows["alpha"]; r.KPID == nil || *r.KPID != 502 { // title + exact year
		t.Fatalf("alpha %+v", r)
	}
	if store.rows["twin"].KPID != nil || store.misses["twin"] != 1 { // ambiguous → miss
		t.Fatalf("twin %+v", store.rows["twin"])
	}
	api, xml := m.counts()
	// matrix 1 (imdb), alpha 1 (keyword "Alpha" matched), twin 1, others 0
	// requests each (no imdb id, no title) → plus 2 rating fetches.
	if api != 3 || xml != 2 {
		t.Fatalf("api %d xml %d", api, xml)
	}

	// Annotated values are rounded; misses are not re-queued for 30 days;
	// fresh ratings are not refreshed.
	got, _ = s.Ratings(ctx, []string{"matrix", "twin"})
	if *got["matrix"].KP != 7.3 || *got["matrix"].IMDb != 6.9 || *got["matrix"].KPID != 301 {
		t.Fatalf("%+v", got["matrix"])
	}
	if r, f := s.Pending(); r != 0 || f != 0 {
		t.Fatalf("pending %d %d", r, f)
	}
	// A week later the rating is refreshed (keyless), no API request.
	old := time.Now().Add(-8 * 24 * time.Hour)
	r := store.rows["matrix"]
	r.FetchedAt = &old
	store.rows["matrix"] = r
	_, _ = s.Ratings(ctx, []string{"matrix"})
	s.Drain()
	if a, x := m.counts(); a != 3 || x != 3 {
		t.Fatalf("refresh: api %d xml %d", a, x)
	}
}

func TestServiceBudgetAndQuota(t *testing.T) {
	ctx := context.Background()
	store, m := newFakeStore(), newMockKP(t)
	for i := range 5 {
		store.add("t"+strconv.Itoa(i), Target{Kind: "movie", TMDBID: i + 1, Year: 2000, Titles: []string{"Nothing" + strconv.Itoa(i)}})
	}
	// Budget 5: list titles may spend 4 (80%), one is kept for Details.
	s := newTestService(t, store, m, 5, true)
	_, _ = s.Ratings(ctx, []string{"t0", "t1", "t2", "t3", "t4"})
	s.Drain()
	if api, _ := m.counts(); api != 4 {
		t.Fatalf("budget: %d API requests", api)
	}
	if s.budget.Remaining(ctx, Low) != 0 || s.budget.Remaining(ctx, High) != 1 || len(store.misses) != 4 {
		t.Fatalf("remaining %d misses %v", s.budget.Remaining(ctx, High), store.misses)
	}
	left := "" // the one title the low share didn't cover (queue order follows map order)
	for i := range 5 {
		if id := "t" + strconv.Itoa(i); store.misses[id] == 0 {
			left = id
		}
	}
	// Low share gone: nothing new is queued from lists.
	_, _ = s.Ratings(ctx, []string{left})
	if r, _ := s.Pending(); r != 0 {
		t.Fatalf("pending %d", r)
	}
	if st := s.Probe(ctx); !st.Configured || *st.BudgetRemaining != 1 {
		t.Fatalf("status %+v", st)
	}
	// …but a title opened in Details still gets its lookup.
	_, _ = s.DetailRatings(ctx, left)
	s.Drain()
	if api, _ := m.counts(); api != 5 || store.misses[left] != 1 || s.budget.Remaining(ctx, High) != 0 {
		t.Fatalf("detail: api %d misses %v", api, store.misses)
	}
	if st := s.Probe(ctx); *st.BudgetRemaining != 0 {
		t.Fatalf("status %+v", st)
	}

	// HTTP 402 from the API exhausts today's budget immediately.
	store2, m2 := newFakeStore(), newMockKP(t)
	m2.quota = true
	store2.add("a", Target{Kind: "movie", Titles: []string{"A"}})
	store2.add("b", Target{Kind: "movie", Titles: []string{"B"}})
	s2 := newTestService(t, store2, m2, 100, true)
	_, _ = s2.Ratings(ctx, []string{"a", "b"})
	s2.Drain()
	if api, _ := m2.counts(); api != 1 || s2.budget.Remaining(ctx, High) != 0 || len(store2.misses) != 0 {
		t.Fatalf("402: api %d remaining %d misses %v", api, s2.budget.Remaining(ctx, High), store2.misses)
	}
}

func TestServiceRateLimit(t *testing.T) {
	store, m := newFakeStore(), newMockKP(t)
	for i := range 4 {
		store.add("t"+strconv.Itoa(i), Target{Kind: "movie", Titles: []string{"X" + strconv.Itoa(i)}})
	}
	s := newTestService(t, store, m, 100, true)
	s.apiLimit.SetLimit(10) // 10 req/s, burst 1 → 4 requests take ≥ 300 ms
	_, _ = s.Ratings(context.Background(), []string{"t0", "t1", "t2", "t3"})
	start := time.Now()
	s.Drain()
	if el := time.Since(start); el < 250*time.Millisecond {
		t.Fatalf("not rate limited: %v", el)
	}
}

func TestServiceDetailSyncAndPriority(t *testing.T) {
	ctx := context.Background()
	store, m := newFakeStore(), newMockKP(t)
	store.add("matrix", Target{Kind: "movie", TMDBID: 603, IMDbID: "tt0133093", Year: 1999})
	store.add("list", Target{Kind: "movie", Titles: []string{"Zzz"}})
	s := newTestService(t, store, m, 100, true)

	// A list view queues at low priority; Details resolves synchronously.
	_, _ = s.Ratings(ctx, []string{"list"})
	r, err := s.DetailRatings(ctx, "matrix")
	if err != nil || r.KPID == nil || *r.KPID != 301 || r.KP == nil || *r.KP != 7.3 {
		t.Fatalf("%+v %v", r, err)
	}
	// Details work goes ahead of list work in the queue.
	s.resolveQ.Push("matrix", High)
	if id, p, _ := s.resolveQ.TryPop(); id != "matrix" || p != High {
		t.Fatalf("first %q", id)
	}

	// A slow API: Details returns stored data after the deadline; the work
	// finishes in the background.
	m.mu.Lock()
	m.delay = 1700 * time.Millisecond
	m.mu.Unlock()
	store.add("slow", Target{Kind: "movie", IMDbID: "tt0133093", Year: 1999})
	start := time.Now()
	r, _ = s.DetailRatings(ctx, "slow")
	if el := time.Since(start); el > detailWait+500*time.Millisecond || r.KPID != nil {
		t.Fatalf("waited %v, %+v", el, r)
	}
	s.bg.Wait()
	if store.rows["slow"].KPID == nil {
		t.Fatal("background resolve did not finish")
	}
}

func TestServiceWithoutKey(t *testing.T) {
	ctx := context.Background()
	store, m := newFakeStore(), newMockKP(t)
	store.add("a", Target{Kind: "movie", IMDbID: "tt0133093"})
	s := newTestService(t, store, m, 100, false)
	got, err := s.Ratings(ctx, []string{"a"})
	if err != nil || got["a"].KP != nil {
		t.Fatal(err)
	}
	if r, _ := s.DetailRatings(ctx, "a"); r.KPID != nil {
		t.Fatal("resolved without a key")
	}
	s.Drain()
	if api, xml := m.counts(); api+xml != 0 {
		t.Fatal("no key: no requests")
	}
	if st := s.Probe(ctx); st.Configured || st.OK || st.Name != "kinopoisk" {
		t.Fatalf("%+v", st)
	}
}
