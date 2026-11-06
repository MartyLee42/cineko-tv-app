package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

// mockKinopoisk serves the unofficial API (by IMDb id) and the keyless
// rating XML, counting requests.
type mockKinopoisk struct {
	mu       sync.Mutex
	api, xml int
	srv      *httptest.Server
}

func newMockKinopoisk(t *testing.T) *mockKinopoisk {
	k := &mockKinopoisk{}
	k.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		k.mu.Lock()
		defer k.mu.Unlock()
		switch r.URL.Path {
		case "/777.xml", "/888.xml":
			k.xml++
			w.Header().Set("Content-Type", "text/xml; charset=Windows-1251")
			_, _ = w.Write([]byte(map[string]string{
				"/777.xml": `<?xml version="1.0" encoding="WINDOWS-1251" standalone="yes"?><rating><kp_rating num_vote="1000">8.123</kp_rating><imdb_rating num_vote="900">7.9</imdb_rating></rating>`,
				"/888.xml": `<?xml version="1.0" encoding="WINDOWS-1251" standalone="yes"?><rating><kp_rating num_vote="5">9.07</kp_rating></rating>`,
			}[r.URL.Path]))
			return
		}
		if r.Header.Get("X-API-KEY") != "kp-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/v1/api_keys/kp-key" {
			_, _ = w.Write([]byte(`{"dailyQuota":{"value":500,"used":3},"totalQuota":{"value":1000,"used":3},"accountType":"FREE"}`))
			return
		}
		k.api++
		if r.URL.Path == "/api/v2.2/films/777/facts" {
			_, _ = w.Write([]byte(`{"total":3,"items":[` +
				`{"text":"Ляп: в кадре виден <a href=\"/name/1/\">микрофон</a> над головой героя.","type":"BLOOPER","spoiler":false},` +
				`{"text":"Фильм снимали в&nbsp;Сиднее, а&nbsp;не в Чикаго, как задумано по &laquo;сценарию&raquo;.","type":"FACT","spoiler":false},` +
				`{"text":"В финале герой оказывается программой — это раскрыли только в последней сцене.","type":"FACT","spoiler":true}]}`))
			return
		}
		switch r.URL.Query().Get("imdbId") {
		case "tt0000100":
			_, _ = w.Write([]byte(`{"items":[{"kinopoiskId":777,"imdbId":"tt0000100","nameRu":"Альфа","nameOriginal":"Alpha","year":1999,"type":"FILM"}]}`))
		case "tt0000200":
			_, _ = w.Write([]byte(`{"items":[{"kinopoiskId":888,"imdbId":"tt0000200","nameOriginal":"Bravo Show","year":2008,"type":"TV_SERIES"}]}`))
		default:
			_, _ = w.Write([]byte(`{"items":[]}`))
		}
	}))
	t.Cleanup(k.srv.Close)
	return k
}

func (k *mockKinopoisk) counts() (int, int) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.api, k.xml
}

// ratingsEnv is the catalog env plus Kinopoisk; TMDB additionally answers
// /movie/100/external_ids (list titles have no IMDb id until fetched).
func ratingsEnv(t *testing.T, withKey bool, opts ...func(*config.Config)) (*testutil.Env, *mockKinopoisk) {
	t.Helper()
	m := newMockTMDB(t)
	k := newMockKinopoisk(t)
	wrap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/movie/100/external_ids" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":100,"imdb_id":"tt0000100"}`))
			return
		}
		m.serve(w, r)
	}))
	t.Cleanup(wrap.Close)
	dir := t.TempDir()
	env := testutil.New(t, func(c *config.Config) {
		c.TMDB.BaseURL = wrap.URL
		c.TMDB.AccessToken = "test-token"
		c.TMDB.ImageBaseURL = m.srv.URL + "/img"
		c.Catalog.ImageCacheDir = dir
		c.Kinopoisk.APIBaseURL = k.srv.URL
		c.Kinopoisk.RatingBaseURL = k.srv.URL
		if withKey {
			c.Kinopoisk.APIKey = "kp-key"
		}
		for _, o := range opts {
			o(c)
		}
	})
	return env, k
}

// mockWikidata is a SPARQL endpoint that knows TMDB movie 100 (→ KP 777)
// and movie 12690 (→ KP 888), nothing else; it counts queries.
type mockWikidata struct {
	mu      sync.Mutex
	queries int
	srv     *httptest.Server
}

func newMockWikidata(t *testing.T) *mockWikidata {
	w := &mockWikidata{}
	known := map[string][2]string{"100": {"777", "tt0000100"}, "12690": {"888", "tt0800308"}}
	movieValues := regexp.MustCompile(`VALUES \?tm \{([^}]*)\}`)
	w.srv = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.PostFormValue("query"), "P1411") {
			// The awards lookup (internal/awards) shares the endpoint: no awards, not counted.
			rw.Header().Set("Content-Type", "application/sparql-results+json")
			_, _ = rw.Write([]byte(`{"head":{"vars":[]},"results":{"bindings":[]}}`))
			return
		}
		w.mu.Lock()
		w.queries++
		w.mu.Unlock()
		if r.Header.Get("User-Agent") == "" || r.Header.Get("Accept") != "application/sparql-results+json" {
			rw.WriteHeader(http.StatusForbidden)
			return
		}
		var bindings []string
		if m := movieValues.FindStringSubmatch(r.PostFormValue("query")); m != nil {
			for _, v := range strings.Fields(m[1]) {
				if k, ok := known[strings.Trim(v, `"`)]; ok {
					bindings = append(bindings, `{"tm":{"type":"literal","value":`+v+`},"kp":{"type":"literal","value":"`+k[0]+`"},"imdb":{"type":"literal","value":"`+k[1]+`"}}`)
				}
			}
		}
		rw.Header().Set("Content-Type", "application/sparql-results+json")
		_, _ = rw.Write([]byte(`{"head":{"vars":["tm","tv","i","kp","imdb"]},"results":{"bindings":[` + strings.Join(bindings, ",") + `]}}`))
	}))
	t.Cleanup(w.srv.Close)
	return w
}

func (w *mockWikidata) count() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.queries
}

// Wikidata resolves Kinopoisk ids first (lists batched, Details
// synchronously, a backfill for the whole catalog) without touching the
// keyed API budget; only its misses go to the keyed API.
func TestRatingsWikidata(t *testing.T) {
	wd := newMockWikidata(t)
	env, k := ratingsEnv(t, true, func(c *config.Config) { c.Kinopoisk.WikidataURL = wd.srv.URL })
	c, _ := env.NewUserClient("alice", "user")
	admin, _ := env.NewUserClient("root", "admin")
	ctx := context.Background()

	list := "/api/v1/catalog/lists/popular?kind=movie"
	movie := findItem(t, itemsOf(c.Do("GET", list, nil).Expect(200).JSON()), "movie", 100)
	if wd.count() != 0 {
		t.Fatal("lists must not wait for Wikidata")
	}
	// Details: Wikidata first, synchronously.
	d := c.Do("GET", "/api/v1/media/"+movie["id"].(string), nil).Expect(200).JSON()
	if d["kp_rating"] != 8.1 || d["external_ids"].(map[string]any)["kinopoisk"] != float64(777) {
		t.Fatalf("detail kp=%v ext=%v", d["kp_rating"], d["external_ids"])
	}
	if api, xml := k.counts(); api != 0 || xml != 1 || wd.count() != 1 {
		t.Fatalf("api %d xml %d wikidata %d", api, xml, wd.count())
	}
	var ext string
	if err := env.Pool.QueryRow(ctx, `SELECT external_id FROM media_external_ids WHERE media_id = $1 AND provider = 'kinopoisk'`,
		movie["id"]).Scan(&ext); err != nil || ext != "777" {
		t.Fatalf("external id %q %v", ext, err)
	}

	// The series is not on Wikidata: marked, then the keyed API (Details).
	home := c.Do("GET", "/api/v1/catalog/home", nil).Expect(200).JSON()
	tv := findItem(t, itemsOf(home["rows"].([]any)[0].(map[string]any)), "series", 100)
	c.Do("GET", "/api/v1/media/"+tv["id"].(string), nil).Expect(200)
	env.Server.Ratings.Drain() // two lookups may outlast the 1.5 s Details deadline
	d = c.Do("GET", "/api/v1/media/"+tv["id"].(string), nil).Expect(200).JSON()
	if d["kp_rating"] != 9.1 {
		t.Fatalf("series detail %v", d["kp_rating"])
	}
	var checked *time.Time
	if err := env.Pool.QueryRow(ctx, `SELECT kp_wikidata_checked_at FROM media WHERE id = $1`, tv["id"]).Scan(&checked); err != nil || checked == nil {
		t.Fatalf("wikidata miss not marked: %v", err)
	}
	if api, _ := k.counts(); api != 1 {
		t.Fatalf("api %d", api)
	}
	n := wd.count()

	// Backfill: a title nobody has displayed yet.
	var appaloosa string
	if err := env.Pool.QueryRow(ctx, `INSERT INTO media (kind, tmdb_id, original_title, year) VALUES ('movie', 12690, 'Appaloosa', 2008) RETURNING id`).
		Scan(&appaloosa); err != nil {
		t.Fatal(err)
	}
	got, err := env.Server.Ratings.BackfillWikidataOnce(ctx)
	if err != nil || got < 1 || wd.count() != n+1 {
		t.Fatalf("backfill %d %v, %d queries", got, err, wd.count()-n)
	}
	if got, _ := env.Server.Ratings.BackfillWikidataOnce(ctx); got != 0 || wd.count() != n+1 {
		t.Fatalf("backlog must be empty after one pass: %d", got)
	}
	env.Server.Ratings.Drain()
	var kp *int
	var rating *float64
	if err := env.Pool.QueryRow(ctx, `SELECT kp_id, kp_rating FROM media WHERE id = $1`, appaloosa).Scan(&kp, &rating); err != nil ||
		kp == nil || *kp != 888 || rating == nil {
		t.Fatalf("appaloosa kp %v rating %v %v", kp, rating, err)
	}
	var missing int
	if err := env.Pool.QueryRow(ctx, `SELECT count(*) FROM media WHERE kp_id IS NULL AND kp_wikidata_checked_at IS NULL`).Scan(&missing); err != nil || missing != 0 {
		t.Fatalf("%d titles never asked %v", missing, err)
	}

	// Only the series' Details lookup spent the keyed budget.
	if api, _ := k.counts(); api != 1 {
		t.Fatalf("keyed api %d", api)
	}
	var used int
	if err := env.Pool.QueryRow(ctx, `SELECT COALESCE(sum(used), 0) FROM ratings_budget`).Scan(&used); err != nil || used != 1 {
		t.Fatalf("budget %d %v", used, err)
	}
	st := integrationNamed(t, admin, "kinopoisk")
	if st["ok"] != true || st["version"] != "kinopoiskapiunofficial.tech FREE + wikidata" {
		t.Fatalf("status %v", st)
	}
}

// List titles may spend 80% of the daily keyed budget; the rest is kept
// for Details (persisted counter, Moscow day).
func TestRatingsBudgetReservation(t *testing.T) {
	env, k := ratingsEnv(t, true, func(c *config.Config) { c.Kinopoisk.DailyBudget = 5 })
	c, _ := env.NewUserClient("alice", "user")
	ctx := context.Background()
	day := time.Now().In(time.FixedZone("MSK", 3*3600)).Format("2006-01-02")
	if _, err := env.Pool.Exec(ctx, `INSERT INTO ratings_budget (day, used) VALUES ($1::date, 4)`, day); err != nil {
		t.Fatal(err)
	}
	list := "/api/v1/catalog/lists/popular?kind=movie"
	movie := findItem(t, itemsOf(c.Do("GET", list, nil).Expect(200).JSON()), "movie", 100)
	env.Server.Ratings.Drain()
	if api, _ := k.counts(); api != 0 {
		t.Fatalf("list used the reserve: %d", api)
	}
	d := c.Do("GET", "/api/v1/media/"+movie["id"].(string), nil).Expect(200).JSON()
	if d["kp_rating"] != 8.1 {
		t.Fatalf("detail %v", d["kp_rating"])
	}
	var used int
	if err := env.Pool.QueryRow(ctx, `SELECT used FROM ratings_budget WHERE day = $1::date`, day).Scan(&used); err != nil || used != 5 {
		t.Fatalf("used %d %v", used, err)
	}
}

func integrationNamed(t *testing.T, c *testutil.Client, name string) map[string]any {
	t.Helper()
	for _, it := range c.Do("GET", "/api/v1/admin/integrations", nil).Expect(200).Items() {
		if it["name"] == name {
			return it
		}
	}
	t.Fatalf("no %s integration", name)
	return nil
}

func TestRatingsWithoutKey(t *testing.T) {
	env, k := ratingsEnv(t, false)
	c, _ := env.NewUserClient("alice", "user")
	admin, _ := env.NewUserClient("root", "admin")

	items := itemsOf(c.Do("GET", "/api/v1/catalog/lists/popular?kind=movie", nil).Expect(200).JSON())
	it := findItem(t, items, "movie", 100)
	if v, ok := it["kp_rating"]; !ok || v != nil || it["imdb_rating"] != nil {
		t.Fatalf("kp_rating must be present and null: %v", it)
	}
	d := c.Do("GET", "/api/v1/media/"+it["id"].(string), nil).Expect(200).JSON()
	if d["kp_rating"] != nil || d["external_ids"].(map[string]any)["kinopoisk"] != nil {
		t.Fatalf("detail %v", d)
	}
	env.Server.Ratings.Drain()
	if api, xml := k.counts(); api+xml != 0 {
		t.Fatal("no key: no Kinopoisk requests")
	}
	if st := integrationNamed(t, admin, "kinopoisk"); st["configured"] != false || st["ok"] != false {
		t.Fatalf("status %v", st)
	}
}

func TestRatingsResolveAnnotateDetail(t *testing.T) {
	env, k := ratingsEnv(t, true)
	c, _ := env.NewUserClient("alice", "user")
	admin, _ := env.NewUserClient("root", "admin")
	ctx := context.Background()

	// A list view returns null ratings and queues the lookups.
	list := "/api/v1/catalog/lists/popular?kind=movie"
	it := findItem(t, itemsOf(c.Do("GET", list, nil).Expect(200).JSON()), "movie", 100)
	if it["kp_rating"] != nil {
		t.Fatalf("%v", it)
	}
	env.Server.Ratings.Drain()
	if api, xml := k.counts(); api != 1 || xml != 1 {
		t.Fatalf("api %d xml %d", api, xml)
	}
	// Annotated (rounded) on the next view; the TMDB cache body stays rating-free.
	it = findItem(t, itemsOf(c.Do("GET", list, nil).Expect(200).JSON()), "movie", 100)
	if it["kp_rating"] != 8.1 || it["imdb_rating"] != 7.9 {
		t.Fatalf("%v", it)
	}
	var cached int
	if err := env.Pool.QueryRow(ctx, `SELECT count(*) FROM tmdb_cache WHERE body::text LIKE '%kp_rating%'`).Scan(&cached); err != nil || cached != 0 {
		t.Fatalf("cache polluted: %d %v", cached, err)
	}
	// Home rows and profile-free search are annotated too.
	home := c.Do("GET", "/api/v1/catalog/home", nil).Expect(200).JSON()
	trending := home["rows"].([]any)[0].(map[string]any)
	if m := findItem(t, itemsOf(trending), "movie", 100); m["kp_rating"] != 8.1 {
		t.Fatalf("home %v", m)
	}

	// Details resolve synchronously (the series' IMDb id comes with details).
	tv := findItem(t, itemsOf(trending), "series", 100)
	d := c.Do("GET", "/api/v1/media/"+tv["id"].(string), nil).Expect(200).JSON()
	if d["kp_rating"] != 9.1 || d["imdb_rating"] != nil || d["external_ids"].(map[string]any)["kinopoisk"] != float64(888) {
		t.Fatalf("detail kp=%v imdb=%v ext=%v", d["kp_rating"], d["imdb_rating"], d["external_ids"])
	}
	var ext string
	if err := env.Pool.QueryRow(ctx, `SELECT external_id FROM media_external_ids WHERE media_id = $1 AND provider = 'kinopoisk'`,
		tv["id"]).Scan(&ext); err != nil || ext != "888" {
		t.Fatalf("external id %q %v", ext, err)
	}
	// Repeated views cost no further Kinopoisk requests.
	c.Do("GET", "/api/v1/media/"+tv["id"].(string), nil).Expect(200)
	c.Do("GET", list, nil).Expect(200)
	env.Server.Ratings.Drain()
	if api, xml := k.counts(); api != 2 || xml != 2 {
		t.Fatalf("api %d xml %d", api, xml)
	}

	st := integrationNamed(t, admin, "kinopoisk")
	if st["configured"] != true || st["ok"] != true || st["budget_remaining"] != float64(448) {
		t.Fatalf("status %v", st)
	}
	var used int
	if err := env.Pool.QueryRow(ctx, `SELECT used FROM ratings_budget`).Scan(&used); err != nil || used != 2 {
		t.Fatalf("budget %d %v", used, err)
	}
}
