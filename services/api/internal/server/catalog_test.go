package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

// mockTMDB serves tiny fixtures shaped like the real v3 API and records
// every request.
type mockTMDB struct {
	t   *testing.T
	srv *httptest.Server
	mu  sync.Mutex
	// hits counts requests per path; queries keeps the last query per path.
	hits    map[string]int
	queries map[string]url.Values
	// movieTitle overrides the English title of movie 100 (stale-refresh test).
	movieTitle string
}

func newMockTMDB(t *testing.T) *mockTMDB {
	m := &mockTMDB{t: t, hits: map[string]int{}, queries: map[string]url.Values{}, movieTitle: "Alpha"}
	m.srv = httptest.NewServer(http.HandlerFunc(m.serve))
	t.Cleanup(m.srv.Close)
	return m
}

func (m *mockTMDB) hit(path string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.hits[path]
}

func (m *mockTMDB) query(path string) url.Values {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.queries[path]
}

func (m *mockTMDB) setMovieTitle(s string) {
	m.mu.Lock()
	m.movieTitle = s
	m.mu.Unlock()
}

// Fixture items. Movie 100 and tv 100 share a numeric id on purpose.
func movieItem(ru bool, title string) map[string]any {
	if ru {
		title = "Альфа"
	}
	return map[string]any{"id": 100, "title": title, "original_title": "Alpha", "original_language": "en",
		"overview": "A movie.", "poster_path": "/alpha.jpg", "backdrop_path": nil, "release_date": "1999-03-31",
		"vote_average": 8.25, "vote_count": 1000, "popularity": 50.5, "genre_ids": []int{28, 878}}
}

func tvItem(ru bool) map[string]any {
	name := "Bravo Show"
	if ru {
		name = "Браво шоу"
	}
	return map[string]any{"id": 100, "name": name, "original_name": "Bravo Show", "original_language": "en",
		"overview": "A show.", "poster_path": nil, "first_air_date": "", "vote_average": 9.9, "vote_count": 2,
		"popularity": 10.0, "genre_ids": []int{18}, "origin_country": []string{"US"}}
}

func withType(item map[string]any, t string) map[string]any {
	out := map[string]any{"media_type": t}
	for k, v := range item {
		out[k] = v
	}
	return out
}

func merge(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		out[k] = v
	}
	return out
}

func page(results ...map[string]any) map[string]any {
	if results == nil {
		results = []map[string]any{}
	}
	return map[string]any{"page": 1, "total_pages": 1000, "total_results": len(results), "results": results}
}

var person = map[string]any{"id": 7, "media_type": "person", "name": "Some Person", "known_for": []any{}}

func (m *mockTMDB) serve(w http.ResponseWriter, r *http.Request) {
	// The API needs the token; images must be fetched without credentials.
	if isImg := strings.HasPrefix(r.URL.Path, "/img/"); isImg != (r.Header.Get("Authorization") == "") {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	m.mu.Lock()
	m.hits[r.URL.Path]++
	m.queries[r.URL.Path] = r.URL.Query()
	title := m.movieTitle
	m.mu.Unlock()

	ru := r.URL.Query().Get("language") == "ru-RU"
	var body any
	switch p := r.URL.Path; p {
	case "/trending/all/week":
		body = page(withType(movieItem(ru, title), "movie"), withType(tvItem(ru), "tv"), person)
	case "/trending/movie/week", "/movie/popular", "/movie/top_rated", "/movie/upcoming", "/movie/now_playing",
		"/movie/100/similar", "/discover/movie", "/search/movie":
		body = page(movieItem(ru, title))
	case "/trending/tv/week", "/tv/popular", "/tv/top_rated", "/tv/on_the_air", "/tv/airing_today", "/discover/tv":
		body = page(tvItem(ru))
	case "/movie/100/recommendations":
		body = page(withType(movieItem(ru, title), "movie"), withType(tvItem(ru), "tv"))
	case "/search/multi":
		body = page(person, withType(tvItem(ru), "tv"), withType(movieItem(ru, title), "movie"))
	case "/genre/movie/list":
		body = map[string]any{"genres": []map[string]any{{"id": 28, "name": map[bool]string{true: "боевик", false: "Action"}[ru]}}}
	case "/movie/100":
		body = movieDetail(ru, title)
	case "/tv/100":
		body = tvDetail(ru)
	case "/tv/100/season/1":
		body = map[string]any{"id": 501, "season_number": 1, "name": map[bool]string{true: "Сезон 1", false: "Season 1"}[ru],
			"overview": "", "air_date": "2008-01-20", "poster_path": "/s1.jpg", "episodes": []map[string]any{
				{"id": 9001, "season_number": 1, "episode_number": 1, "name": "Pilot", "overview": "First.", "air_date": "2008-01-20",
					"runtime": 58, "still_path": "/e1.jpg", "vote_average": 8.5, "vote_count": 500},
				{"id": 9002, "season_number": 1, "episode_number": 2, "name": "Second", "overview": "", "air_date": nil,
					"runtime": nil, "still_path": nil, "vote_average": 0, "vote_count": 0},
			}}
	case "/person/1":
		bio := "An actor."
		if ru {
			bio = "" // no Russian biography: falls back to English
		}
		talk := withType(tvItem(ru), "tv")
		talk["id"], talk["genre_ids"] = 300, []int{10767}
		self := withType(movieItem(ru, title), "movie")
		self["id"] = 301
		stub := withType(movieItem(ru, title), "movie")
		stub["id"], stub["poster_path"], stub["vote_count"] = 302, nil, 0
		low := withType(tvItem(ru), "tv")
		low["popularity"] = 1.0
		body = map[string]any{"id": 1, "name": "First Actor", "profile_path": "/a1.jpg", "biography": bio,
			"birthday": "1964-09-02", "deathday": nil, "place_of_birth": "Beirut", "known_for_department": "Acting",
			"combined_credits": map[string]any{
				"cast": []map[string]any{
					merge(low, map[string]any{"character": "Guest"}),
					merge(withType(movieItem(ru, title), "movie"), map[string]any{"character": "Neo"}),
					merge(talk, map[string]any{"character": "Himself"}),
					merge(self, map[string]any{"character": "Himself (archive footage)"}),
					merge(stub, map[string]any{"character": "Someone"}),
				},
				"crew": []map[string]any{
					merge(withType(movieItem(ru, title), "movie"), map[string]any{"job": "Director"}),
					merge(withType(movieItem(ru, title), "movie"), map[string]any{"job": "Key Grip"}),
				},
			}}
	case "/movie/100/watch/providers":
		body = map[string]any{"id": 100, "results": map[string]any{"US": map[string]any{
			"link": "https://www.themoviedb.org/movie/100/watch?locale=US",
			"flatrate": []map[string]any{
				{"provider_id": 2, "provider_name": "Second", "logo_path": "/b.png", "display_priority": 5},
				{"provider_id": 1, "provider_name": "First", "logo_path": "/a.png", "display_priority": 1},
			},
		}}}
	case "/img/w500/poster.jpg", "/img/original/logo.svg":
		w.Header().Set("Content-Type", map[bool]string{true: "image/svg+xml", false: "image/jpeg"}[strings.HasSuffix(p, ".svg")])
		_, _ = w.Write([]byte("IMAGEBYTES"))
		return
	case "/img/w500/page.jpg":
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>"))
		return
	default:
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"success":false,"status_code":34}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func movieDetail(ru bool, title string) map[string]any {
	d := movieItem(ru, title)
	d["tagline"] = "Tagline."
	d["status"] = "Released"
	d["runtime"] = 136
	d["genres"] = []map[string]any{{"id": 28, "name": "Action"}, {"id": 878, "name": "Science Fiction"}}
	d["origin_country"] = []string{"US"}
	d["production_countries"] = []map[string]any{{"iso_3166_1": "AU"}}
	d["credits"] = map[string]any{
		"cast": []map[string]any{
			{"id": 2, "name": "Second Actor", "original_name": "Second Actor", "character": "Trinity", "order": 1, "profile_path": nil},
			{"id": 1, "name": map[bool]string{true: "Первый Актёр", false: "First Actor"}[ru], "original_name": "First Actor",
				"character": "Neo", "order": 0, "profile_path": "/a1.jpg"},
		},
		"crew": []map[string]any{
			{"id": 10, "name": "Grip Person", "job": "Key Grip", "department": "Crew"},
			{"id": 11, "name": "Director One", "job": "Director", "department": "Directing", "profile_path": nil},
			{"id": 11, "name": "Director One", "job": "Director", "department": "Directing", "profile_path": nil},
			{"id": 12, "name": "Composer", "job": "Original Music Composer", "department": "Sound"},
		},
	}
	d["external_ids"] = map[string]any{"imdb_id": "tt0000100"}
	d["videos"] = map[string]any{"results": []map[string]any{
		{"iso_639_1": "en", "key": "teaser-en", "name": "Teaser", "site": "YouTube", "type": "Teaser", "official": true},
		{"iso_639_1": "en", "key": "clip-en", "name": "Clip", "site": "YouTube", "type": "Clip", "official": true},
		{"iso_639_1": "en", "key": "trailer-en", "name": "Official Trailer", "site": "YouTube", "type": "Trailer", "official": true},
		{"iso_639_1": "ru", "key": "trailer-ru", "name": "Трейлер", "site": "YouTube", "type": "Trailer", "official": false},
		{"iso_639_1": "en", "key": "vimeo", "name": "Trailer", "site": "Vimeo", "type": "Trailer", "official": true},
	}}
	return d
}

func tvDetail(ru bool) map[string]any {
	d := tvItem(ru)
	d["first_air_date"] = "2008-01-20"
	d["last_air_date"] = "2013-09-29"
	d["status"] = "Ended"
	d["tagline"] = ""
	d["episode_run_time"] = []int{}
	d["last_episode_to_air"] = map[string]any{"runtime": 47}
	d["number_of_seasons"] = 1
	d["number_of_episodes"] = 2
	d["genres"] = []map[string]any{{"id": 18, "name": "Drama"}}
	d["created_by"] = []map[string]any{{"id": 20, "name": "Creator Person", "original_name": "Creator Person", "profile_path": nil}}
	d["seasons"] = []map[string]any{
		{"id": 500, "season_number": 0, "name": "Specials", "overview": "", "air_date": nil, "episode_count": 3, "poster_path": nil},
		{"id": 501, "season_number": 1, "name": "Season 1", "overview": "S1.", "air_date": "2008-01-20", "episode_count": 2, "poster_path": "/s1.jpg"},
	}
	d["aggregate_credits"] = map[string]any{
		"cast": []map[string]any{{"id": 30, "name": "Lead", "original_name": "Lead", "order": 0, "profile_path": nil,
			"roles": []map[string]any{{"character": "Cameo", "episode_count": 1}, {"character": "Walter", "episode_count": 62}}}},
		"crew": []map[string]any{
			{"id": 31, "name": "Music", "original_name": "Music", "department": "Sound", "jobs": []map[string]any{{"job": "Original Music Composer", "episode_count": 62}}},
			{"id": 32, "name": "Ep Director", "original_name": "Ep Director", "department": "Directing", "jobs": []map[string]any{{"job": "Director", "episode_count": 3}}},
		},
	}
	d["external_ids"] = map[string]any{"imdb_id": "tt0000200", "tvdb_id": 81189}
	d["videos"] = map[string]any{"results": []map[string]any{}}
	return d
}

func catalogEnv(t *testing.T, opts ...testutil.Options) (*testutil.Env, *mockTMDB, *testutil.Client) {
	t.Helper()
	m := newMockTMDB(t)
	dir := t.TempDir()
	all := append([]testutil.Options{func(c *config.Config) {
		c.TMDB.BaseURL = m.srv.URL
		c.TMDB.AccessToken = "test-token"
		c.TMDB.ImageBaseURL = m.srv.URL + "/img"
		c.Catalog.ImageCacheDir = dir
	}}, opts...)
	env := testutil.New(t, all...)
	c, _ := env.NewUserClient("alice", "user")
	return env, m, c
}

func findItem(t *testing.T, items []any, kind string, tmdbID int) map[string]any {
	t.Helper()
	for _, it := range items {
		m := it.(map[string]any)
		if m["kind"] == kind && int(m["tmdb_id"].(float64)) == tmdbID {
			return m
		}
	}
	t.Fatalf("no %s/%d in %v", kind, tmdbID, items)
	return nil
}

func itemsOf(r map[string]any) []any { return r["items"].([]any) }

func TestCatalogStableIDs(t *testing.T) {
	env, _, c := catalogEnv(t)

	home := c.Do("GET", "/api/v1/catalog/home", nil).Expect(200).JSON()
	trending := home["rows"].([]any)[0].(map[string]any)
	movie := findItem(t, itemsOf(trending), "movie", 100)
	tv := findItem(t, itemsOf(trending), "series", 100)
	if movie["id"] == tv["id"] {
		t.Fatal("movie and tv with the same TMDB id must get different ids")
	}
	if movie["title"] != "Alpha" || movie["year"].(float64) != 1999 || movie["rating"].(float64) != 8.25 {
		t.Fatalf("movie summary %v", movie)
	}
	// Too few votes → null rating; empty date → null year/date; null poster stays null.
	if tv["rating"] != nil || tv["year"] != nil || tv["release_date"] != nil || tv["poster_path"] != nil {
		t.Fatalf("tv summary %v", tv)
	}

	// Different endpoint + language + repeated calls: same ids.
	for range 2 {
		ru := c.Do("GET", "/api/v1/catalog/lists/popular?kind=movie&lang=ru", nil).Expect(200).JSON()
		m := findItem(t, itemsOf(ru), "movie", 100)
		if m["id"] != movie["id"] || m["title"] != "Альфа" {
			t.Fatalf("ru list %v", m)
		}
	}
	search := c.Do("GET", "/api/v1/catalog/search?q=alpha", nil).Expect(200).JSON()
	if findItem(t, itemsOf(search), "movie", 100)["id"] != movie["id"] || findItem(t, itemsOf(search), "series", 100)["id"] != tv["id"] {
		t.Fatal("search ids differ")
	}
	// A TV (device credential) sees the same id.
	_, cred := env.Pair(c, "TV")
	tvc := env.Client()
	tvc.Bearer = cred
	onAir := tvc.Do("GET", "/api/v1/catalog/lists/on_the_air?kind=series", nil).Expect(200).JSON()
	if findItem(t, itemsOf(onAir), "series", 100)["id"] != tv["id"] {
		t.Fatal("device sees a different id")
	}

	var n int
	if err := env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM media WHERE tmdb_id = 100`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("media rows %d %v", n, err)
	}
	var ext string
	if err := env.Pool.QueryRow(context.Background(),
		`SELECT media_id::text FROM media_external_ids WHERE provider = 'tmdb_tv' AND external_id = '100'`).Scan(&ext); err != nil || ext != tv["id"] {
		t.Fatalf("external id %q %v", ext, err)
	}
	// Both languages are stored.
	var trs string
	_ = env.Pool.QueryRow(context.Background(), `SELECT translations::text FROM media WHERE id = $1`, movie["id"]).Scan(&trs)
	if !strings.Contains(trs, "Альфа") || !strings.Contains(trs, "Alpha") {
		t.Fatalf("translations %s", trs)
	}
}

func TestCatalogHomeAndListValidation(t *testing.T) {
	_, m, c := catalogEnv(t)
	home := c.Do("GET", "/api/v1/catalog/home?lang=ru", nil).Expect(200).JSON()
	want := []string{"trending:all:trending", "popular_movies:movie:popular", "popular_series:series:popular",
		"top_rated_movies:movie:top_rated", "top_rated_series:series:top_rated", "upcoming_movies:movie:upcoming",
		"on_the_air_series:series:on_the_air"}
	rows := home["rows"].([]any)
	if len(rows) != len(want) {
		t.Fatalf("rows %d", len(rows))
	}
	for i, r := range rows {
		row := r.(map[string]any)
		if got := fmt.Sprintf("%s:%s:%s", row["key"], row["kind"], row["list"]); got != want[i] {
			t.Fatalf("row %d = %s, want %s", i, got, want[i])
		}
	}
	// Trending (kind all) drops people.
	if n := len(itemsOf(rows[0].(map[string]any))); n != 2 {
		t.Fatalf("trending items %d", n)
	}
	if m.query("/movie/popular").Get("language") != "ru-RU" {
		t.Fatal("lang not mapped")
	}

	for _, bad := range []string{
		"lists/popular?kind=all", "lists/top_rated?kind=all", "lists/upcoming?kind=series", "lists/now_playing?kind=all",
		"lists/on_the_air?kind=movie", "lists/airing_today?kind=movie", "lists/popular", "lists/popular?kind=tv",
		"lists/popular?kind=movie&page=0", "lists/popular?kind=movie&page=501", "lists/popular?kind=movie&lang=de",
		"home?lang=xx",
	} {
		c.Do("GET", "/api/v1/catalog/"+bad, nil).Expect(422)
	}
	c.Do("GET", "/api/v1/catalog/lists/nope?kind=movie", nil).Expect(404)
	res := c.Do("GET", "/api/v1/catalog/lists/trending?kind=all&page=2", nil).Expect(200).JSON()
	// TMDB never serves past page 500.
	if res["total_pages"].(float64) != 500 || m.query("/trending/all/week").Get("page") != "2" {
		t.Fatalf("page %v", res)
	}
	c.Do("GET", "/api/v1/catalog/lists/airing_today?kind=series", nil).Expect(200)
	c.Do("GET", "/api/v1/catalog/lists/now_playing?kind=movie", nil).Expect(200)
	c.Do("GET", "/api/v1/catalog/lists/trending?kind=series", nil).Expect(200)
	if m.hit("/trending/tv/week") != 1 {
		t.Fatal("trending series path")
	}
}

func TestCatalogCache(t *testing.T) {
	env, m, c := catalogEnv(t)
	a := c.Do("GET", "/api/v1/catalog/lists/top_rated?kind=series", nil).Expect(200).JSON()
	b := c.Do("GET", "/api/v1/catalog/lists/top_rated?kind=series", nil).Expect(200).JSON()
	if m.hit("/tv/top_rated") != 1 {
		t.Fatalf("expected one upstream call, got %d", m.hit("/tv/top_rated"))
	}
	if itemsOf(a)[0].(map[string]any)["id"] != itemsOf(b)[0].(map[string]any)["id"] {
		t.Fatal("cached page changed ids")
	}
	// Other languages and pages are separate cache entries.
	c.Do("GET", "/api/v1/catalog/lists/top_rated?kind=series&lang=ru", nil).Expect(200)
	if m.hit("/tv/top_rated") != 2 {
		t.Fatal("lang should be part of the cache key")
	}
	// Search and genres are cached too.
	c.Do("GET", "/api/v1/catalog/search?q=x", nil).Expect(200)
	c.Do("GET", "/api/v1/catalog/search?q=x", nil).Expect(200)
	g := c.Do("GET", "/api/v1/catalog/genres?kind=movie&lang=ru", nil).Expect(200).Items()
	c.Do("GET", "/api/v1/catalog/genres?kind=movie&lang=ru", nil).Expect(200)
	if m.hit("/search/multi") != 1 || m.hit("/genre/movie/list") != 1 || len(g) != 1 || g[0]["name"] != "боевик" {
		t.Fatalf("search %d genres %d %v", m.hit("/search/multi"), m.hit("/genre/movie/list"), g)
	}
	c.Do("GET", "/api/v1/catalog/genres", nil).Expect(422)

	// An expired entry is refetched; while TMDB is down it is served stale.
	_, _ = env.Pool.Exec(context.Background(), `UPDATE tmdb_cache SET expires_at = now() - interval '1 minute'`)
	m.srv.Close()
	stale := c.Do("GET", "/api/v1/catalog/lists/top_rated?kind=series", nil).Expect(200).JSON()
	if len(itemsOf(stale)) != 1 {
		t.Fatal("stale fallback")
	}
	c.Do("GET", "/api/v1/catalog/lists/popular?kind=series", nil).Expect(502)
}

func TestCatalogDiscover(t *testing.T) {
	_, m, c := catalogEnv(t)
	c.Do("GET", "/api/v1/catalog/discover?kind=movie&genres=28,878&year_from=1990&year_to=1999&runtime_min=60&runtime_max=180&original_language=EN&rating_min=7.5&sort=rating&page=3&lang=ru", nil).Expect(200)
	q := m.query("/discover/movie")
	want := map[string]string{
		"with_genres": "28,878", "primary_release_date.gte": "1990-01-01", "primary_release_date.lte": "1999-12-31",
		"with_runtime.gte": "60", "with_runtime.lte": "180", "with_original_language": "en",
		"vote_average.gte": "7.5", "sort_by": "vote_average.desc", "vote_count.gte": "50",
		"page": "3", "language": "ru-RU", "include_adult": "false",
	}
	for k, v := range want {
		if q.Get(k) != v {
			t.Errorf("%s = %q, want %q", k, q.Get(k), v)
		}
	}

	c.Do("GET", "/api/v1/catalog/discover?kind=series&sort=title&year_from=2010", nil).Expect(200)
	q = m.query("/discover/tv")
	if q.Get("sort_by") != "name.asc" || q.Get("first_air_date.gte") != "2010-01-01" || q.Has("primary_release_date.gte") {
		t.Fatalf("tv discover %v", q)
	}
	c.Do("GET", "/api/v1/catalog/discover?kind=movie&sort=release_date", nil).Expect(200)
	q = m.query("/discover/movie")
	if q.Get("sort_by") != "primary_release_date.desc" || q.Get("primary_release_date.lte") == "" {
		t.Fatalf("release sort %v", q)
	}
	c.Do("GET", "/api/v1/catalog/discover?kind=movie", nil).Expect(200)
	if m.query("/discover/movie").Get("sort_by") != "popularity.desc" {
		t.Fatal("default sort")
	}

	for _, bad := range []string{
		"", "kind=all", "kind=movie&genres=action", "kind=movie&rating_min=11", "kind=movie&year_from=abc",
		"kind=movie&year_from=2000&year_to=1990", "kind=movie&sort=random", "kind=movie&original_language=english",
		"kind=movie&runtime_min=-1",
	} {
		res := c.Do("GET", "/api/v1/catalog/discover?"+bad, nil).Expect(422)
		if res.ErrorCode() != "validation_failed" {
			t.Fatalf("%s: %s", bad, res.Body)
		}
	}
}

func TestCatalogSearch(t *testing.T) {
	_, m, c := catalogEnv(t)
	res := c.Do("GET", "/api/v1/catalog/search?q="+url.QueryEscape(" матрица "), nil).Expect(200).JSON()
	items := itemsOf(res)
	if len(items) != 2 {
		t.Fatalf("people must be dropped: %v", items)
	}
	if q := m.query("/search/multi"); q.Get("query") != "матрица" || q.Get("include_adult") != "false" || q.Get("language") != "en-US" {
		t.Fatalf("query %v", q)
	}
	res = c.Do("GET", "/api/v1/catalog/search?q=alpha&kind=movie", nil).Expect(200).JSON()
	if len(itemsOf(res)) != 1 || m.hit("/search/movie") != 1 {
		t.Fatal("movie search")
	}
	c.Do("GET", "/api/v1/catalog/search?q=", nil).Expect(422)
	c.Do("GET", "/api/v1/catalog/search?q=%20%20", nil).Expect(422)
	c.Do("GET", "/api/v1/catalog/search?q="+strings.Repeat("я", 101), nil).Expect(422)
	c.Do("GET", "/api/v1/catalog/search?q=x&kind=person", nil).Expect(422)
}

func TestCatalogDetails(t *testing.T) {
	env, m, c := catalogEnv(t)
	home := c.Do("GET", "/api/v1/catalog/home", nil).Expect(200).JSON()
	trending := itemsOf(home["rows"].([]any)[0].(map[string]any))
	movieID := findItem(t, trending, "movie", 100)["id"].(string)
	tvID := findItem(t, trending, "series", 100)["id"].(string)

	d := c.Do("GET", "/api/v1/media/"+movieID, nil).Expect(200).JSON()
	if d["id"] != movieID || d["kind"] != "movie" || d["title"] != "Alpha" || d["tagline"] != "Tagline." ||
		d["runtime"].(float64) != 136 || d["status"] != "Released" || d["original_language"] != "en" {
		t.Fatalf("detail %v", d)
	}
	if fmt.Sprint(d["countries"]) != "[US]" || fmt.Sprint(d["genre_ids"]) != "[28 878]" || len(d["seasons"].([]any)) != 0 ||
		d["number_of_seasons"] != nil || d["last_air_date"] != nil {
		t.Fatalf("detail facts %v", d)
	}
	ext := d["external_ids"].(map[string]any)
	if ext["tmdb"].(float64) != 100 || ext["imdb"] != "tt0000100" || ext["tvdb"] != nil {
		t.Fatalf("external ids %v", ext)
	}
	cast := d["cast"].([]any)
	if len(cast) != 2 || cast[0].(map[string]any)["name"] != "First Actor" || cast[0].(map[string]any)["character"] != "Neo" {
		t.Fatalf("cast %v", cast)
	}
	crew := d["crew"].([]any)
	if len(crew) != 2 || crew[0].(map[string]any)["job"] != "Director" || crew[1].(map[string]any)["job"] != "Original Music Composer" {
		t.Fatalf("crew %v", crew)
	}
	if tr := d["trailer"].(map[string]any); tr["key"] != "trailer-en" || tr["site"] != "YouTube" {
		t.Fatalf("trailer %v", tr)
	}
	if q := m.query("/movie/100"); q.Get("append_to_response") != "credits,external_ids,videos" {
		t.Fatalf("append %v", q)
	}

	// Russian: localized title/person names, trailer in Russian, en fallback for genres not yet named in ru.
	ru := c.Do("GET", "/api/v1/media/"+movieID+"?lang=ru", nil).Expect(200).JSON()
	if ru["title"] != "Альфа" || ru["trailer"].(map[string]any)["key"] != "trailer-ru" ||
		ru["cast"].([]any)[0].(map[string]any)["name"] != "Первый Актёр" || m.query("/movie/100").Get("include_video_language") != "ru,en,null" {
		t.Fatalf("ru detail %v", ru)
	}
	// Details are served from the database afterwards.
	c.Do("GET", "/api/v1/media/"+movieID, nil).Expect(200)
	if m.hit("/movie/100") != 2 {
		t.Fatalf("detail calls %d", m.hit("/movie/100"))
	}

	// Series: seasons, creators, aggregate cast, runtime fallback.
	s := c.Do("GET", "/api/v1/media/"+tvID, nil).Expect(200).JSON()
	seasons := s["seasons"].([]any)
	if len(seasons) != 2 || seasons[1].(map[string]any)["name"] != "Season 1" || seasons[1].(map[string]any)["episode_count"].(float64) != 2 {
		t.Fatalf("seasons %v", seasons)
	}
	if s["runtime"].(float64) != 47 || s["number_of_seasons"].(float64) != 1 || s["last_air_date"] != "2013-09-29" ||
		s["external_ids"].(map[string]any)["tvdb"].(float64) != 81189 || s["trailer"] != nil {
		t.Fatalf("series %v", s)
	}
	if c0 := s["cast"].([]any)[0].(map[string]any); c0["character"] != "Walter" {
		t.Fatalf("aggregate cast %v", c0)
	}
	if crew := s["crew"].([]any); len(crew) != 2 || crew[0].(map[string]any)["job"] != "Creator" {
		t.Fatalf("series crew %v", crew)
	}

	// Season episodes get stable ids across calls and languages.
	s1 := c.Do("GET", "/api/v1/media/"+tvID+"/seasons/1", nil).Expect(200).JSON()
	eps := s1["episodes"].([]any)
	if s1["media_id"] != tvID || len(eps) != 2 || s1["name"] != "Season 1" {
		t.Fatalf("season %v", s1)
	}
	e1, e2 := eps[0].(map[string]any), eps[1].(map[string]any)
	if e1["name"] != "Pilot" || e1["runtime"].(float64) != 58 || e1["rating"].(float64) != 8.5 ||
		e2["air_date"] != nil || e2["runtime"] != nil || e2["rating"] != nil || e2["still_path"] != nil {
		t.Fatalf("episodes %v", eps)
	}
	s1ru := c.Do("GET", "/api/v1/media/"+tvID+"/seasons/1?lang=ru", nil).Expect(200).JSON()
	if s1ru["name"] != "Сезон 1" || s1ru["episodes"].([]any)[0].(map[string]any)["id"] != e1["id"] {
		t.Fatalf("ru season %v", s1ru)
	}
	again := c.Do("GET", "/api/v1/media/"+tvID+"/seasons/1", nil).Expect(200).JSON()
	if again["episodes"].([]any)[1].(map[string]any)["id"] != e2["id"] || m.hit("/tv/100/season/1") != 2 {
		t.Fatal("episode ids must be stable and seasons cached")
	}

	// 404s: season of a movie, unknown season, unknown/malformed id, bad season number.
	c.Do("GET", "/api/v1/media/"+movieID+"/seasons/1", nil).Expect(404)
	c.Do("GET", "/api/v1/media/"+tvID+"/seasons/7", nil).Expect(404)
	c.Do("GET", "/api/v1/media/"+tvID+"/seasons/-1", nil).Expect(404)
	c.Do("GET", "/api/v1/media/00000000-0000-0000-0000-000000000000", nil).Expect(404)
	c.Do("GET", "/api/v1/media/not-a-uuid", nil).Expect(404)
	c.Do("GET", "/api/v1/media/"+movieID+"?lang=fr", nil).Expect(422)

	// A title TMDB no longer knows is a 404.
	var goneID string
	_ = env.Pool.QueryRow(context.Background(), `INSERT INTO media (kind, tmdb_id) VALUES ('movie', 999) RETURNING id`).Scan(&goneID)
	c.Do("GET", "/api/v1/media/"+goneID, nil).Expect(404)

	// Similar / recommendations materialize too (recommendations may mix kinds).
	sim := c.Do("GET", "/api/v1/media/"+movieID+"/similar", nil).Expect(200).JSON()
	if findItem(t, itemsOf(sim), "movie", 100)["id"] != movieID {
		t.Fatal("similar ids")
	}
	rec := c.Do("GET", "/api/v1/media/"+movieID+"/recommendations?lang=ru", nil).Expect(200).JSON()
	if findItem(t, itemsOf(rec), "series", 100)["id"] != tvID {
		t.Fatal("recommendation ids")
	}
	// TMDB 404 for related lists → empty page.
	empty := c.Do("GET", "/api/v1/media/"+tvID+"/similar", nil).Expect(200).JSON()
	if len(itemsOf(empty)) != 0 {
		t.Fatal("expected empty similar")
	}

	// Providers: default region (RU) is empty; US is sorted by priority.
	p := c.Do("GET", "/api/v1/media/"+movieID+"/providers", nil).Expect(200).JSON()
	if p["region"] != "RU" || p["link"] != nil || len(p["flatrate"].([]any)) != 0 || len(p["buy"].([]any)) != 0 {
		t.Fatalf("RU providers %v", p)
	}
	p = c.Do("GET", "/api/v1/media/"+movieID+"/providers?region=us", nil).Expect(200).JSON()
	fr := p["flatrate"].([]any)
	if p["region"] != "US" || p["link"] == nil || len(fr) != 2 || fr[0].(map[string]any)["name"] != "First" || len(p["rent"].([]any)) != 0 {
		t.Fatalf("US providers %v", p)
	}
	c.Do("GET", "/api/v1/media/"+movieID+"/providers?region=USA", nil).Expect(422)
}

func TestCatalogStaleDetailRefresh(t *testing.T) {
	env, m, c := catalogEnv(t)
	list := c.Do("GET", "/api/v1/catalog/lists/popular?kind=movie", nil).Expect(200).JSON()
	id := itemsOf(list)[0].(map[string]any)["id"].(string)
	if c.Do("GET", "/api/v1/media/"+id, nil).Expect(200).JSON()["title"] != "Alpha" {
		t.Fatal("initial title")
	}

	m.setMovieTitle("Alpha Renamed")
	_, err := env.Pool.Exec(context.Background(),
		`UPDATE media SET details_fetched_at = jsonb_build_object('en', now() - interval '8 days') WHERE id = $1`, id)
	if err != nil {
		t.Fatal(err)
	}
	// Stale details are served immediately…
	if got := c.Do("GET", "/api/v1/media/"+id, nil).Expect(200).JSON()["title"]; got != "Alpha" {
		t.Fatalf("expected stale title, got %v", got)
	}
	// …and refreshed in the background.
	env.Server.Catalog.WaitBackground()
	if got := c.Do("GET", "/api/v1/media/"+id, nil).Expect(200).JSON()["title"]; got != "Alpha Renamed" {
		t.Fatalf("expected refreshed title, got %v", got)
	}
	if m.hit("/movie/100") != 2 {
		t.Fatalf("detail calls %d", m.hit("/movie/100"))
	}
}

func TestImageProxy(t *testing.T) {
	env, m, _ := catalogEnv(t)
	anon := env.Client() // images are public

	res := anon.Do("GET", "/api/v1/images/w500/poster.jpg", nil).Expect(200)
	if string(res.Body) != "IMAGEBYTES" || res.Header.Get("Content-Type") != "image/jpeg" ||
		res.Header.Get("Cache-Control") != "public, max-age=2592000, immutable" {
		t.Fatalf("image response %v %s", res.Header, res.Body)
	}
	anon.Do("GET", "/api/v1/images/w500/poster.jpg", nil).Expect(200)
	if m.hit("/img/w500/poster.jpg") != 1 {
		t.Fatalf("second request should come from disk, upstream hits %d", m.hit("/img/w500/poster.jpg"))
	}

	svg := anon.Do("GET", "/api/v1/images/original/logo.svg", nil).Expect(200)
	if !strings.Contains(svg.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatal("svg must be sandboxed")
	}

	for _, bad := range []string{
		"w45/poster.jpg", "w501/poster.jpg", "w500/poster.gif", "w500/..", "w500/%2e%2e%2fetc%2fpasswd",
		"w500/..%2F..%2Fpasswd.jpg", "w500/a.b.jpg", "w500/.jpg", "../w500/poster.jpg",
	} {
		r := anon.Do("GET", "/api/v1/images/"+bad, nil)
		if r.Status != 404 {
			t.Fatalf("%s: HTTP %d", bad, r.Status)
		}
	}
	anon.Do("GET", "/api/v1/images/w500/missing.jpg", nil).Expect(404)
	if r := anon.Do("GET", "/api/v1/images/w500/page.jpg", nil).Expect(502); r.ErrorCode() != "image_unavailable" {
		t.Fatal(r.ErrorCode())
	}
}

func TestCatalogAuthAndConfig(t *testing.T) {
	env, _, c := catalogEnv(t, func(cfg *config.Config) { cfg.Catalog.ImageProxy = true })
	anon := env.Client()
	for _, p := range []string{"catalog/config", "catalog/home", "catalog/lists/popular?kind=movie", "catalog/search?q=x",
		"media/00000000-0000-0000-0000-000000000000"} {
		anon.Do("GET", "/api/v1/"+p, nil).Expect(401)
	}

	cfg := c.Do("GET", "/api/v1/catalog/config", nil).Expect(200).JSON()
	if cfg["available"] != true || cfg["image_base_url"] != "/api/v1/images" || cfg["region"] != "RU" ||
		!strings.Contains(cfg["attribution"].(string), "TMDB") || len(cfg["poster_sizes"].([]any)) == 0 {
		t.Fatalf("config %v", cfg)
	}

	// TVs browse with their device credential.
	_, cred := env.Pair(c, "TV")
	tv := env.Client()
	tv.Bearer = cred
	tv.Do("GET", "/api/v1/catalog/home", nil).Expect(200)

	// API tokens need the read scope.
	read := c.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "r", "scopes": []string{"read"}}).Expect(201).JSON()
	bot := env.Client()
	bot.Bearer = read["secret"].(string)
	bot.Do("GET", "/api/v1/catalog/lists/popular?kind=series", nil).Expect(200)
	write := c.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "w", "scopes": []string{"write"}}).Expect(201).JSON()
	bot.Bearer = write["secret"].(string)
	if r := bot.Do("GET", "/api/v1/catalog/home", nil).Expect(403); r.ErrorCode() != "insufficient_scope" {
		t.Fatal(r.ErrorCode())
	}
}

func TestCatalogUnconfigured(t *testing.T) {
	env := testutil.New(t) // no TMDB credentials
	c, _ := env.NewUserClient("alice", "user")
	cfg := c.Do("GET", "/api/v1/catalog/config", nil).Expect(200).JSON()
	if cfg["available"] != false || cfg["image_base_url"] != "https://image.tmdb.org/t/p" {
		t.Fatalf("config %v", cfg)
	}
	for _, p := range []string{"catalog/home", "catalog/lists/popular?kind=movie", "catalog/discover?kind=movie",
		"catalog/search?q=x", "catalog/genres?kind=movie", "media/00000000-0000-0000-0000-000000000000",
		"media/00000000-0000-0000-0000-000000000000/seasons/1"} {
		if r := c.Do("GET", "/api/v1/"+p, nil).Expect(503); r.ErrorCode() != "catalog_unavailable" {
			t.Fatalf("%s: %s", p, r.ErrorCode())
		}
	}
}

func TestCatalogPerson(t *testing.T) {
	_, m, c := catalogEnv(t)
	p := c.Do("GET", "/api/v1/people/1?lang=ru", nil).Expect(200).JSON()
	if p["name"] != "First Actor" || p["biography"] != "An actor." || p["birthday"] != "1964-09-02" || p["deathday"] != nil {
		t.Fatalf("person %v", p)
	}
	if q := m.query("/person/1"); q.Get("append_to_response") != "combined_credits" {
		t.Fatalf("query %v", q)
	}
	credits := p["credits"].([]any)
	if len(credits) != 2 {
		t.Fatalf("talk show, playing oneself and stubs must be dropped: %v", credits)
	}
	first := credits[0].(map[string]any)
	media := first["media"].(map[string]any)
	if media["kind"] != "movie" || media["title"] != "Альфа" || first["role"] != "Neo, Director" || first["crew"] != false {
		t.Fatalf("first credit (most popular, roles merged) %v", first)
	}
	second := credits[1].(map[string]any)
	if second["media"].(map[string]any)["kind"] != "series" || second["role"] != "Guest" {
		t.Fatalf("second credit %v", second)
	}
	c.Do("GET", "/api/v1/people/999", nil).Expect(404)
	c.Do("GET", "/api/v1/people/abc", nil).Expect(404)
	c.Do("GET", "/api/v1/people/1?lang=xx", nil).Expect(422)
}
