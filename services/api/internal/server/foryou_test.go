package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

// ---- fake TMDB with a small, taste-shaped catalog ----

type fyTitle struct {
	id          int
	kind        string // movie | series
	title, orig string
	lang        string
	year        int
	genres      []int
	votes       int
	avg, pop    float64
	director    int
	cast        []int
	keywords    []int
	runtime     int
}

func fyCatalog() []fyTitle {
	var out []fyTitle
	add := func(t fyTitle) {
		if t.kind == "" {
			t.kind = "movie"
		}
		if t.lang == "" {
			t.lang = "en"
		}
		if t.orig == "" {
			t.orig = t.title
		}
		if t.runtime == 0 {
			t.runtime = 110
		}
		out = append(out, t)
	}
	named := map[int]string{1: "Blade Runner", 2: "Alien", 3: "The Matrix"}
	namedYear := map[int]int{1: 1982, 2: 1979, 3: 1999}
	for i := 1; i <= 20; i++ {
		g := []int{878, 28}
		if i%2 == 0 {
			g = []int{878, 53}
		}
		dir := 900
		if i > 8 && i <= 16 {
			dir = 901
		}
		title, year := named[i], namedYear[i]
		if title == "" {
			title, year = fmt.Sprintf("Space Saga %d", i), 1975+i*2
		}
		add(fyTitle{id: i, title: title, year: year, genres: g, votes: 4000 + i*100, avg: 7.4 + float64(i%5)/10, pop: 80 - float64(i), director: dir, cast: []int{950 + i%3}})
	}
	for i := 21; i <= 36; i++ {
		g := []int{35, 10749}
		if i%3 == 0 {
			g = []int{10749, 18}
		}
		dir := 910
		if i > 28 {
			dir = 911
		}
		add(fyTitle{id: i, title: fmt.Sprintf("Love Story %d", i), year: 1990 + i - 20, genres: g, votes: 3000 + i*50, avg: 7.0 + float64(i%4)/10, pop: 70 - float64(i-20), director: dir, cast: []int{960 + i%2}})
	}
	for i := 121; i <= 140; i++ {
		add(fyTitle{id: i, title: fmt.Sprintf("Rom Com %d", i), year: 1985 + i - 120, genres: []int{35, 10749}, votes: 2500 + i*10, avg: 7.1 + float64(i%3)/10, pop: 40 - float64(i-120)/2, director: 912 + i%2, cast: []int{960}})
	}
	for i := 101; i <= 115; i++ {
		add(fyTitle{id: i, title: fmt.Sprintf("Nebula %d", i), year: 1990 + i - 100, genres: []int{878, 12}, votes: 2500 + i*10, avg: 7.2 + float64(i%3)/10, pop: 45 - float64(i-100)/2, director: 902, cast: []int{951}})
	}
	for i := 41; i <= 48; i++ {
		add(fyTitle{id: i, title: fmt.Sprintf("Dark House %d", i), year: 1980 + i - 40, genres: []int{27, 53}, votes: 2000, avg: 6.9, pop: 30, director: 920, runtime: 95})
	}
	for i := 51; i <= 58; i++ {
		add(fyTitle{id: i, title: fmt.Sprintf("Quiet Drama %d", i), year: 1995 + i - 50, genres: []int{18}, votes: 9000, avg: 8.2, pop: 25, director: 930})
	}
	for i := 61; i <= 63; i++ {
		add(fyTitle{id: i, title: fmt.Sprintf("Anime Film %d", i), orig: fmt.Sprintf("アニメ %d", i), lang: "ja", year: 2001 + i - 60, genres: []int{16, 14}, votes: 3000, avg: 8.4, pop: 60, director: 940})
	}
	for i := 71; i <= 76; i++ {
		g := []int{878}
		if i > 73 {
			g = []int{35}
		}
		add(fyTitle{id: i, title: fmt.Sprintf("Hidden Gem %d", i), year: 2010 + i - 70, genres: g, votes: 300, avg: 7.9, pop: 5, director: 990 + i})
	}
	add(fyTitle{id: 81, title: "Twin Peril", year: 2001, genres: []int{28}, votes: 500, avg: 6, pop: 3, director: 981})
	add(fyTitle{id: 82, title: "Twin Peril", year: 2001, genres: []int{28}, votes: 400, avg: 6, pop: 2, director: 982})
	for i, t := range []struct {
		title string
		year  int
	}{{"Solaris", 1972}, {"Stalker", 1979}, {"Moon", 2009}, {"Primer", 2004}, {"Gattaca", 1997}, {"Arrival", 2016}, {"Contact", 1997}} {
		add(fyTitle{id: 91 + i, title: t.title, year: t.year, genres: []int{878, 18}, votes: 3000, avg: 7.6, pop: 10, director: 991, keywords: []int{4379}})
	}
	for i := 501; i <= 504; i++ {
		add(fyTitle{id: i, kind: "series", title: fmt.Sprintf("Star Show %d", i), year: 2010 + i - 500, genres: []int{10765, 18}, votes: 1500, avg: 8, pop: 40})
	}
	return out
}

type fyTMDB struct {
	srv    *httptest.Server
	titles []fyTitle
	mu     sync.Mutex
	hits   map[string]int
	// queries: every request's query string by path (newest last).
	queries map[string][]url.Values
}

func newFyTMDB(t *testing.T) *fyTMDB {
	f := &fyTMDB{titles: fyCatalog(), hits: map[string]int{}, queries: map[string][]url.Values{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fyTMDB) hit(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for p, c := range f.hits {
		if strings.HasPrefix(p, prefix) {
			n += c
		}
	}
	return n
}

func (f *fyTMDB) item(t fyTitle, withType bool) map[string]any {
	m := map[string]any{"id": t.id, "original_language": t.lang, "overview": "", "poster_path": "/p" + strconv.Itoa(t.id) + ".jpg",
		"backdrop_path": "/b" + strconv.Itoa(t.id) + ".jpg", "vote_average": t.avg, "vote_count": t.votes, "popularity": t.pop, "genre_ids": t.genres}
	date := fmt.Sprintf("%d-06-01", t.year)
	if t.kind == "series" {
		m["name"], m["original_name"], m["first_air_date"] = t.title, t.orig, date
	} else {
		m["title"], m["original_title"], m["release_date"] = t.title, t.orig, date
	}
	if withType {
		m["media_type"] = map[string]string{"movie": "movie", "series": "tv"}[t.kind]
	}
	return m
}

func ids(s string, sep string) []int {
	var out []int
	for _, p := range strings.Split(s, sep) {
		if n, err := strconv.Atoi(strings.TrimSpace(p)); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func (f *fyTMDB) discover(kind string, q url.Values) []fyTitle {
	var out []fyTitle
	for _, t := range f.titles {
		if t.kind != kind {
			continue
		}
		if g := q.Get("with_genres"); g != "" {
			if strings.Contains(g, "|") {
				if !slices.ContainsFunc(ids(g, "|"), func(x int) bool { return slices.Contains(t.genres, x) }) {
					continue
				}
			} else if slices.ContainsFunc(ids(g, ","), func(x int) bool { return !slices.Contains(t.genres, x) }) {
				continue
			}
		}
		if g := q.Get("without_genres"); g != "" && slices.ContainsFunc(ids(g, ","), func(x int) bool { return slices.Contains(t.genres, x) }) {
			continue
		}
		if c := q.Get("with_crew"); c != "" && !slices.Contains(ids(c, "|"), t.director) {
			continue
		}
		if c := q.Get("with_cast"); c != "" && !slices.ContainsFunc(ids(c, "|"), func(x int) bool { return slices.Contains(t.cast, x) }) {
			continue
		}
		if k := q.Get("with_keywords"); k != "" && !slices.ContainsFunc(ids(k, "|"), func(x int) bool { return slices.Contains(t.keywords, x) }) {
			continue
		}
		if l := q.Get("with_original_language"); l != "" && l != t.lang {
			continue
		}
		num := func(k string) (float64, bool) {
			v, err := strconv.ParseFloat(q.Get(k), 64)
			return v, err == nil
		}
		if v, ok := num("vote_count.gte"); ok && float64(t.votes) < v {
			continue
		}
		if v, ok := num("vote_count.lte"); ok && float64(t.votes) > v {
			continue
		}
		if v, ok := num("vote_average.gte"); ok && t.avg < v {
			continue
		}
		if v, ok := num("with_runtime.gte"); ok && float64(t.runtime) < v {
			continue
		}
		if v, ok := num("with_runtime.lte"); ok && float64(t.runtime) > v {
			continue
		}
		field := "primary_release_date"
		if kind == "series" {
			field = "first_air_date"
		}
		if d := q.Get(field + ".gte"); len(d) >= 4 {
			if y, _ := strconv.Atoi(d[:4]); t.year < y {
				continue
			}
		}
		if d := q.Get(field + ".lte"); len(d) >= 4 {
			if y, _ := strconv.Atoi(d[:4]); t.year > y {
				continue
			}
		}
		out = append(out, t)
	}
	switch q.Get("sort_by") {
	case "vote_average.desc":
		sort.SliceStable(out, func(i, j int) bool { return out[i].avg > out[j].avg })
	case "popularity.desc":
		sort.SliceStable(out, func(i, j int) bool { return out[i].pop > out[j].pop })
	}
	return out
}

func (f *fyTMDB) pageOf(list []fyTitle, q url.Values, withType bool) map[string]any {
	p, _ := strconv.Atoi(q.Get("page"))
	if p < 1 {
		p = 1
	}
	res := []map[string]any{}
	for i := (p - 1) * 20; i < len(list) && i < p*20; i++ {
		res = append(res, f.item(list[i], withType))
	}
	return map[string]any{"page": p, "total_pages": (len(list) + 19) / 20, "total_results": len(list), "results": res}
}

func normFy(s string) string {
	s = strings.ToLower(s)
	s = strings.TrimPrefix(s, "the ")
	return strings.TrimSpace(s)
}

func (f *fyTMDB) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") == "" {
		w.WriteHeader(401)
		return
	}
	f.mu.Lock()
	f.hits[r.URL.Path]++
	f.queries[r.URL.Path] = append(f.queries[r.URL.Path], r.URL.Query())
	f.mu.Unlock()
	q := r.URL.Query()
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	var body any
	switch {
	case r.URL.Path == "/trending/all/week":
		all := f.discover("movie", url.Values{"sort_by": {"popularity.desc"}})
		body = f.pageOf(append(all[:10:10], f.discover("series", url.Values{})...), q, true)
	case r.URL.Path == "/movie/top_rated":
		body = f.pageOf(f.discover("movie", url.Values{"sort_by": {"vote_average.desc"}, "vote_count.gte": {"1000"}}), q, false)
	case r.URL.Path == "/movie/popular":
		body = f.pageOf(f.discover("movie", url.Values{"sort_by": {"popularity.desc"}}), q, false)
	case r.URL.Path == "/discover/movie":
		body = f.pageOf(f.discover("movie", q), q, false)
	case r.URL.Path == "/discover/tv":
		body = f.pageOf(f.discover("series", q), q, false)
	case r.URL.Path == "/search/movie" || r.URL.Path == "/search/tv":
		kind := map[string]string{"/search/movie": "movie", "/search/tv": "series"}[r.URL.Path]
		want := normFy(q.Get("query"))
		year := q.Get("year") + q.Get("first_air_date_year")
		var list []fyTitle
		for _, t := range f.titles {
			if t.kind != kind || !(strings.Contains(normFy(t.title), want) || strings.Contains(normFy(t.orig), want)) {
				continue
			}
			if year != "" && year != strconv.Itoa(t.year) {
				continue
			}
			list = append(list, t)
		}
		body = f.pageOf(list, q, false)
	case r.URL.Path == "/genre/movie/list":
		body = map[string]any{"genres": []map[string]any{{"id": 878, "name": "Science Fiction"}, {"id": 35, "name": "Comedy"}}}
	case len(parts) == 3 && parts[0] == "movie" && parts[2] == "recommendations":
		id, _ := strconv.Atoi(parts[1])
		var seed *fyTitle
		for i := range f.titles {
			if f.titles[i].id == id && f.titles[i].kind == "movie" {
				seed = &f.titles[i]
			}
		}
		if seed == nil {
			w.WriteHeader(404)
			return
		}
		var list []fyTitle
		for _, t := range f.discover("movie", url.Values{"sort_by": {"popularity.desc"}}) {
			if t.id != id && t.genres[0] == seed.genres[0] {
				list = append(list, t)
			}
		}
		body = f.pageOf(list, q, true)
	case len(parts) == 3 && parts[0] == "person" && parts[2] == "movie_credits":
		pid, _ := strconv.Atoi(parts[1])
		cast, crew := []map[string]any{}, []map[string]any{}
		for _, t := range f.titles {
			if t.kind != "movie" {
				continue
			}
			if t.director == pid {
				m := f.item(t, false)
				m["job"], m["department"] = "Director", "Directing"
				crew = append(crew, m)
				p := f.item(t, false)
				p["job"], p["department"] = "Producer", "Production"
				crew = append(crew, p)
			}
			if i := slices.Index(t.cast, pid); i >= 0 {
				m := f.item(t, false)
				m["order"], m["character"] = i, "X"
				cast = append(cast, m)
			}
		}
		// A produced-only title must not count as directed.
		if pid == 900 {
			m := f.item(f.titles[slices.IndexFunc(f.titles, func(t fyTitle) bool { return t.id == 41 })], false)
			m["job"], m["department"] = "Producer", "Production"
			crew = append(crew, m)
		}
		body = map[string]any{"id": pid, "cast": cast, "crew": crew}
	case len(parts) == 2 && parts[0] == "movie":
		id, _ := strconv.Atoi(parts[1])
		var t *fyTitle
		for i := range f.titles {
			if f.titles[i].id == id && f.titles[i].kind == "movie" {
				t = &f.titles[i]
			}
		}
		if t == nil {
			w.WriteHeader(404)
			return
		}
		d := f.item(*t, false)
		gs := []map[string]any{}
		for _, g := range t.genres {
			gs = append(gs, map[string]any{"id": g, "name": fmt.Sprint(g)})
		}
		cast := []map[string]any{}
		for i, c := range t.cast {
			cast = append(cast, map[string]any{"id": c, "name": fmt.Sprintf("Actor %d", c), "original_name": fmt.Sprintf("Actor %d", c), "character": "X", "order": i})
		}
		d["genres"], d["runtime"], d["status"], d["tagline"] = gs, t.runtime, "Released", ""
		d["production_countries"] = []map[string]any{{"iso_3166_1": "US"}}
		d["credits"] = map[string]any{"cast": cast, "crew": []map[string]any{
			{"id": t.director, "name": fmt.Sprintf("Director %d", t.director), "original_name": fmt.Sprintf("Director %d", t.director), "job": "Director", "department": "Directing"}}}
		d["external_ids"] = map[string]any{"imdb_id": nil}
		d["videos"] = map[string]any{"results": []any{}}
		body = d
	default:
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"status_code":34}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

// ---- fake DeepSeek ----

type fakeAI struct {
	srv     *httptest.Server
	mu      sync.Mutex
	content string
	calls   atomic.Int32
	block   chan struct{}
	prompts []string
	// balance: the /user/balance reply ("" → 500).
	balance string
}

func newFakeAI(t *testing.T) *fakeAI {
	f := &fakeAI{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer test-deepseek-key" && r.URL.Path == "/user/balance" && r.Method == "GET" {
			f.mu.Lock()
			b := f.balance
			f.mu.Unlock()
			if b == "" {
				w.WriteHeader(500)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(b))
			return
		}
		if r.Header.Get("Authorization") != "Bearer test-deepseek-key" || r.URL.Path != "/chat/completions" {
			w.WriteHeader(401)
			return
		}
		var req struct {
			Messages []struct{ Content string } `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.calls.Add(1)
		f.mu.Lock()
		content, block := f.content, f.block
		if len(req.Messages) == 2 {
			f.prompts = append(f.prompts, req.Messages[1].Content)
		}
		f.mu.Unlock()
		if block != nil {
			<-block
		}
		b, _ := json.Marshal(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"role": "assistant", "content": content}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": 700, "completion_tokens": 500, "total_tokens": 1200},
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAI) set(content string) {
	f.mu.Lock()
	f.content = content
	f.mu.Unlock()
}

func aiJSON(cols ...[]string) string {
	type item struct {
		Title         string `json:"title"`
		OriginalTitle string `json:"original_title"`
		Year          int    `json:"year"`
		Kind          string `json:"kind"`
	}
	var out []map[string]any
	for i, c := range cols {
		var items []item
		for _, s := range c[1:] {
			title, y, _ := strings.Cut(s, "|")
			year, _ := strconv.Atoi(y)
			items = append(items, item{title, title, year, "movie"})
		}
		out = append(out, map[string]any{"title_ru": c[0] + " (ru)", "title_en": c[0], "description_ru": "Описание " + strconv.Itoa(i),
			"description_en": "Description", "items": items})
	}
	b, _ := json.Marshal(map[string]any{"collections": out})
	return string(b)
}

// ---- env ----

type fyEnv struct {
	env   *testutil.Env
	tmdb  *fyTMDB
	ai    *fakeAI
	alice *testutil.Client
	admin *testutil.Client
	ids   map[int]string // tmdb movie id → media id
}

func newFyEnv(t *testing.T, opts ...testutil.Options) *fyEnv {
	t.Helper()
	tm := newFyTMDB(t)
	ai := newFakeAI(t)
	all := append([]testutil.Options{func(c *config.Config) {
		c.TMDB.BaseURL = tm.srv.URL
		c.TMDB.AccessToken = "test-token"
		c.TMDB.ImageBaseURL = tm.srv.URL + "/img"
		c.Catalog.ImageCacheDir = t.TempDir()
		c.ForYou.DeepSeekAPIKey = "test-deepseek-key"
		c.ForYou.DeepSeekBaseURL = ai.srv.URL
	}}, opts...)
	env := testutil.New(t, all...)
	env.Server.ForYou.SetPace(1000)
	env.Server.ForYou.SetAIBackoff(time.Millisecond)
	alice, _ := env.NewUserClient("alice", "user")
	admin, _ := env.NewUserClient("root", "admin")
	f := &fyEnv{env: env, tmdb: tm, ai: ai, alice: alice, admin: admin, ids: map[int]string{}}
	// Materialize the catalog (stable ids) through the normal catalog API.
	for p := 1; p <= 7; p++ {
		res := alice.Do("GET", "/api/v1/catalog/discover?kind=movie&page="+strconv.Itoa(p), nil).Expect(200).JSON()
		for _, it := range res["items"].([]any) {
			m := it.(map[string]any)
			f.ids[int(m["tmdb_id"].(float64))] = m["id"].(string)
		}
	}
	if len(f.ids) < 100 {
		t.Fatalf("materialized %d titles", len(f.ids))
	}
	return f
}

func (f *fyEnv) rate(t *testing.T, c *testutil.Client, pid string, tmdbID, rating int) {
	t.Helper()
	c.Do("PUT", "/api/v1/profiles/"+pid+"/ratings/"+f.ids[tmdbID], map[string]any{"rating": rating}).Expect(204)
}

func (f *fyEnv) tmdbOf(id string) int {
	for k, v := range f.ids {
		if v == id {
			return k
		}
	}
	return 0
}

// sciFiProfile / romComProfile: two clearly different tastes.
func (f *fyEnv) sciFiProfile(t *testing.T, c *testutil.Client, name string) string {
	pid := newProfile(t, c, name)
	for _, id := range []int{1, 2, 3, 4, 5, 9, 10} {
		f.rate(t, c, pid, id, 10-id%2)
	}
	f.rate(t, c, pid, 21, 2)
	c.Do("PUT", "/api/v1/profiles/"+pid+"/lists/favorites/"+f.ids[1], nil).Expect(204)
	return pid
}

func (f *fyEnv) romComProfile(t *testing.T, c *testutil.Client, name string) string {
	pid := newProfile(t, c, name)
	for _, id := range []int{21, 22, 23, 24, 25, 29} {
		f.rate(t, c, pid, id, 9+id%2)
	}
	f.rate(t, c, pid, 1, 3)
	return pid
}

func rowsOf(t *testing.T, c *testutil.Client, pid string) map[string]any {
	t.Helper()
	return c.Do("GET", "/api/v1/foryou/rows?lang=en&profile_id="+pid, nil).Expect(200).JSON()
}

// itemTMDB lists tmdb ids per row id.
func (f *fyEnv) rowItems(res map[string]any) (map[string][]int, []map[string]any) {
	out := map[string][]int{}
	var rows []map[string]any
	for _, r := range res["rows"].([]any) {
		row := r.(map[string]any)
		rows = append(rows, row)
		for _, it := range row["items"].([]any) {
			m := it.(map[string]any)["media"].(map[string]any)
			out[row["id"].(string)] = append(out[row["id"].(string)], int(m["tmdb_id"].(float64)))
		}
	}
	return out, rows
}

func genreShare(f *fyEnv, ids []int, genres ...int) float64 {
	n := 0
	for _, id := range ids {
		for _, t := range f.tmdb.titles {
			if t.id == id && t.kind == "movie" && slices.ContainsFunc(genres, func(g int) bool { return slices.Contains(t.genres, g) }) {
				n++
			}
		}
	}
	return float64(n) / float64(max(len(ids), 1))
}

func waitRun(t *testing.T, c *testutil.Client, runID string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		res := c.Do("GET", "/api/v1/admin/foryou/runs", nil).Expect(200).JSON()
		for _, it := range res["items"].([]any) {
			r := it.(map[string]any)
			if r["id"] == runID && r["status"] != "running" {
				return r
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("run %s did not finish", runID)
	return nil
}

// ---- tests ----

// Acceptance: different profiles get meaningfully different rows, with
// typed reasons, never containing what they rated or dismissed.
func TestForYouRowsDifferPerProfile(t *testing.T) {
	f := newFyEnv(t)
	a := f.sciFiProfile(t, f.alice, "Sci")
	b := f.romComProfile(t, f.alice, "Rom")

	ra, rb := rowsOf(t, f.alice, a), rowsOf(t, f.alice, b)
	ia, rowsA := f.rowItems(ra)
	ib, _ := f.rowItems(rb)
	if ra["cold_start"] != false || ra["stale"] != false || ra["generated_at"] == nil {
		t.Fatalf("meta %v", ra)
	}
	if rowsA[0]["kind"] != "top_picks" || rowsA[0]["title"] != "Picked for you" {
		t.Fatalf("first row %v", rowsA[0]["kind"])
	}
	var allA, allB []int
	for _, v := range ia {
		allA = append(allA, v...)
	}
	for _, v := range ib {
		allB = append(allB, v...)
	}
	// The tiny fixture catalog runs out of liked titles, so compare the
	// two profiles rather than absolute shares.
	if a, b := genreShare(f, allA, 878), genreShare(f, allB, 878); a-b < 0.3 {
		t.Fatalf("sci-fi share A %.2f vs B %.2f: %v / %v", a, b, ia, ib)
	}
	if a, b := genreShare(f, allA, 35, 10749), genreShare(f, allB, 35, 10749); b-a < 0.3 {
		t.Fatalf("comedy/romance share A %.2f vs B %.2f: %v / %v", a, b, ia, ib)
	}
	for id, items := range ib {
		if strings.HasPrefix(id, "byr:") && genreShare(f, items, 35, 10749) < 1 {
			t.Fatalf("B's because row %v", items)
		}
	}
	common := 0
	for _, id := range ia["top_picks"] {
		if slices.Contains(ib["top_picks"], id) {
			common++
		}
	}
	if common > len(ia["top_picks"])/3 {
		t.Fatalf("top picks too similar: %v vs %v", ia["top_picks"], ib["top_picks"])
	}
	// Exclusions: rated titles never appear; items are unique across rows.
	seen := map[int]bool{}
	for _, id := range allA {
		if slices.Contains([]int{1, 2, 3, 4, 5, 9, 10, 21}, id) {
			t.Fatalf("rated title %d recommended", id)
		}
		if seen[id] {
			t.Fatalf("title %d in two rows", id)
		}
		seen[id] = true
	}
	// Typed reasons: a "because you liked" row and a director row.
	kinds := map[string]map[string]any{}
	for _, r := range rowsA {
		kinds[r["kind"].(string)] = r
	}
	byr := kinds["because_you_rated"]
	if byr == nil {
		t.Fatalf("no because_you_rated row: %v", ia)
	}
	reason := byr["reason"].(map[string]any)
	if reason["media_id"] == nil || reason["media_title"] == nil || !strings.HasPrefix(byr["title"].(string), "Because you liked “") {
		t.Fatalf("byr row %v", byr["title"])
	}
	item := byr["items"].([]any)[0].(map[string]any)
	if item["reason"].(map[string]any)["type"] != "because_you_rated" || item["media"].(map[string]any)["me"] == nil {
		t.Fatalf("byr item %v", item)
	}
	// Localized.
	ru := f.alice.Do("GET", "/api/v1/foryou/rows?lang=ru&profile_id="+a, nil).Expect(200).JSON()
	if ru["rows"].([]any)[0].(map[string]any)["title"] != "Подобрано для вас" {
		t.Fatalf("ru title %v", ru["rows"].([]any)[0].(map[string]any)["title"])
	}

	// Dismiss the top pick: gone at once; impressions are recorded.
	top := ia["top_picks"][0]
	f.alice.Do("POST", "/api/v1/foryou/feedback", map[string]any{"profile_id": a, "media_id": f.ids[top], "action": "dismiss", "row_id": "top_picks"}).Expect(202)
	var evs []map[string]any
	for _, id := range ia["top_picks"][1:4] {
		evs = append(evs, map[string]any{"media_id": f.ids[id], "action": "impression", "row_id": "top_picks"})
	}
	res := f.alice.Do("POST", "/api/v1/foryou/feedback", map[string]any{"profile_id": a, "events": evs}).Expect(202).JSON()
	if num(res["accepted"]) != 3 {
		t.Fatalf("accepted %v", res)
	}
	after, _ := f.rowItems(rowsOf(t, f.alice, a))
	for _, v := range after {
		if slices.Contains(v, top) {
			t.Fatalf("dismissed %d still shown", top)
		}
	}
	// Rating a recommended title removes it immediately (read-time patch).
	next := after["top_picks"][0]
	f.rate(t, f.alice, a, next, 8)
	r2 := rowsOf(t, f.alice, a)
	after2, _ := f.rowItems(r2)
	for _, v := range after2 {
		if slices.Contains(v, next) {
			t.Fatalf("rated %d still shown", next)
		}
	}
	var n int
	_ = f.env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM foryou_feedback WHERE profile_id = $1`, a).Scan(&n)
	if n != 4 {
		t.Fatalf("feedback rows %d", n)
	}
	f.alice.Do("POST", "/api/v1/foryou/feedback", map[string]any{"profile_id": a, "media_id": f.ids[top], "action": "nope"}).Expect(422)
	f.alice.Do("POST", "/api/v1/foryou/feedback", map[string]any{"profile_id": a}).Expect(422)

	// Access: another account gets 404; profile_id is required.
	bob, _ := f.env.NewUserClient("bob", "user")
	bob.Do("GET", "/api/v1/foryou/rows?profile_id="+a, nil).Expect(404)
	bob.Do("POST", "/api/v1/foryou/feedback", map[string]any{"profile_id": a, "media_id": f.ids[top], "action": "open"}).Expect(404)
	f.alice.Do("GET", "/api/v1/foryou/rows", nil).Expect(422)
	f.env.Server.ForYou.Wait()
}

func TestForYouColdStartAndHideAnime(t *testing.T) {
	f := newFyEnv(t)
	c := newProfile(t, f.alice, "New")
	res := rowsOf(t, f.alice, c)
	items, rows := f.rowItems(res)
	if res["cold_start"] != true || len(rows) == 0 || rows[0]["kind"] != "popular" {
		t.Fatalf("cold start %v", res)
	}
	hasAnime := func(items map[string][]int) bool {
		for _, v := range items {
			for _, id := range v {
				if id >= 61 && id <= 63 {
					return true
				}
			}
		}
		return false
	}
	if !hasAnime(items) {
		t.Fatalf("fixture: expected anime among popular titles: %v", items)
	}
	f.alice.Do("PUT", "/api/v1/profiles/"+c+"/settings", map[string]any{"hide_anime": true}).Expect(200)
	items, _ = f.rowItems(rowsOf(t, f.alice, c))
	if hasAnime(items) {
		t.Fatalf("anime shown with hide_anime: %v", items)
	}
}

func TestForYouSurprise(t *testing.T) {
	f := newFyEnv(t)
	a := f.sciFiProfile(t, f.alice, "Sci")
	svc := f.env.Server.ForYou
	svc.SetRand(func() float64 { return 0 }) // always the best match

	post := func(body map[string]any) map[string]any {
		body["profile_id"] = a
		return f.alice.Do("POST", "/api/v1/foryou/surprise?lang=en", body).Expect(200).JSON()
	}
	r := post(map[string]any{})
	if r["source"] != "pool" || r["media"] == nil || r["reason"] == nil || num(r["pool_size"]) < 10 {
		t.Fatalf("surprise %v", r)
	}
	first := r["media"].(map[string]any)["id"].(string)
	// Re-roll excludes what was shown.
	ex := r["reroll"].(map[string]any)["exclude_ids"].([]any)
	r2 := post(map[string]any{"exclude_ids": ex})
	if r2["media"].(map[string]any)["id"] == first {
		t.Fatal("re-roll repeated the pick")
	}
	// Mood from the pool.
	r3 := post(map[string]any{"mood": "scary"})
	m3 := r3["media"].(map[string]any)
	if r3["source"] != "pool" || !slices.Contains(toInts(m3["genre_ids"]), 27) || r3["reason"].(map[string]any)["type"] != "mood" ||
		r3["reason"].(map[string]any)["text"] != "For the mood: scary" {
		t.Fatalf("scary %v", r3)
	}
	// Runtime is unknown for list-only titles → TMDB discover fallback.
	rt := post(map[string]any{"runtime_min": 90, "runtime_max": 100})
	if id := num(rt["media"].(map[string]any)["tmdb_id"]); rt["source"] != "discover" || id < 41 || id > 48 {
		t.Fatalf("runtime fallback %v", rt)
	}
	// Decade + genre filters from the pool.
	r4 := post(map[string]any{"genres": []int{35}, "decade": 2010})
	if r4["media"] != nil {
		m := r4["media"].(map[string]any)
		if y := num(m["year"]); y < 2010 || y > 2019 || !slices.Contains(toInts(m["genre_ids"]), 35) {
			t.Fatalf("filters %v", m)
		}
	}
	// Rated titles never come back unless include_watched.
	for i := 0; i < 5; i++ {
		svc.SetRand(func() float64 { return float64(i) / 5 })
		m := post(map[string]any{"genres": []int{878}})["media"].(map[string]any)
		if slices.Contains([]int{1, 2, 3, 4, 5, 9, 10}, f.tmdbOf(m["id"].(string))) {
			t.Fatalf("seen title surprised: %v", m)
		}
	}
	svc.SetRand(func() float64 { return 0 })
	var unseen []string
	for id, mid := range f.ids {
		if !slices.Contains([]int{1, 2, 3, 4, 5, 9, 10}, id) {
			unseen = append(unseen, mid)
		}
	}
	rw := post(map[string]any{"include_watched": true, "exclude_ids": unseen[:min(len(unseen), 200)]})
	if rw["media"] == nil || rw["reason"].(map[string]any)["type"] != "rewatch" {
		t.Fatalf("include_watched %v", rw)
	}
	// Nothing at all → media null.
	none := post(map[string]any{"mood": "scary", "decade": 1950})
	if none["media"] != nil || none["source"] != "none" {
		t.Fatalf("none %v", none)
	}
	f.alice.Do("POST", "/api/v1/foryou/surprise", map[string]any{"profile_id": a, "mood": "bad"}).Expect(422)
	f.alice.Do("POST", "/api/v1/foryou/surprise", map[string]any{"profile_id": a, "decade": 1985}).Expect(422)
	opts := f.alice.Do("GET", "/api/v1/foryou/surprise/options?lang=ru", nil).Expect(200).JSON()
	if len(opts["moods"].([]any)) != 7 || opts["moods"].([]any)[0].(map[string]any)["title"] != "Уютное" {
		t.Fatalf("options %v", opts)
	}
	f.env.Server.ForYou.Wait()
}

func toInts(v any) []int {
	var out []int
	for _, x := range v.([]any) {
		out = append(out, int(x.(float64)))
	}
	return out
}

func TestForYouExploreAndBrowse(t *testing.T) {
	f := newFyEnv(t)
	a := f.sciFiProfile(t, f.alice, "Sci")
	ex := f.alice.Do("GET", "/api/v1/foryou/explore?lang=ru&profile_id="+a, nil).Expect(200).JSON()
	secs := map[string]map[string]any{}
	for _, s := range ex["sections"].([]any) {
		sec := s.(map[string]any)
		secs[sec["kind"].(string)] = sec
	}
	for _, k := range []string{"moods", "decades", "countries", "genres", "keywords"} {
		if secs[k] == nil || len(secs[k]["tiles"].([]any)) == 0 {
			t.Fatalf("section %s missing: %v", k, ex)
		}
	}
	// Every tile gets a picture from the top of its own selection (cached:
	// the second visit is served from the tile image cache, fast).
	start := time.Now()
	ex2 := f.alice.Do("GET", "/api/v1/foryou/explore?lang=ru&profile_id="+a, nil).Expect(200).JSON()
	if d := time.Since(start); d > time.Second {
		t.Fatalf("second explore took %v (tile images not cached)", d)
	}
	// The test catalog is small, so only tiles whose selection has titles
	// can get one: all moods do, and so does the time-travel theme.
	tiles := map[string]map[string]any{}
	seen := map[string]int{}
	for _, s := range ex2["sections"].([]any) {
		for _, ti := range s.(map[string]any)["tiles"].([]any) {
			tile := ti.(map[string]any)
			tiles[tile["id"].(string)] = tile
			if p, _ := tile["image_path"].(string); p != "" {
				seen[p]++
			}
		}
	}
	for _, id := range []string{"mood:cozy", "mood:scary", "mood:funny", "kw:4379"} {
		if p, _ := tiles[id]["image_path"].(string); !strings.HasPrefix(p, "/b") {
			t.Fatalf("tile %s has no picture: %v", id, tiles[id])
		}
	}
	for p, n := range seen {
		if n > 3 {
			t.Fatalf("picture %s repeats on %d tiles", p, n)
		}
	}
	// Taste-ordered: sci-fi first among genres.
	g0 := secs["genres"]["tiles"].([]any)[0].(map[string]any)
	if g0["id"] != "genre:878" || g0["discover"].(map[string]any)["genres"] != "878" {
		t.Fatalf("first genre tile %v", g0)
	}
	browse := func(tile string) map[string]any {
		return f.alice.Do("GET", "/api/v1/foryou/browse?lang=en&profile_id="+a+"&tile="+url.QueryEscape(tile), nil).Expect(200).JSON()
	}
	scary := browse("mood:scary")
	if len(scary["items"].([]any)) == 0 || scary["title"] != "Scary" {
		t.Fatalf("scary %v", scary)
	}
	for _, it := range scary["items"].([]any) {
		m := it.(map[string]any)
		if !slices.Contains(toInts(m["genre_ids"]), 27) || m["me"] == nil {
			t.Fatalf("scary item %v", m)
		}
	}
	kw := browse("kw:4379")
	if len(kw["items"].([]any)) != 7 || kw["title"] != "Time travel" {
		t.Fatalf("keyword %v", kw)
	}
	dec := browse("decade:1970")
	for _, it := range dec["items"].([]any) {
		if y := num(it.(map[string]any)["year"]); y < 1970 || y > 1979 {
			t.Fatalf("decade item year %v", y)
		}
	}
	f.alice.Do("GET", "/api/v1/foryou/browse?profile_id="+a+"&tile=nope:1", nil).Expect(422)
	f.alice.Do("GET", "/api/v1/foryou/browse?profile_id="+a+"&tile=mood:unknown", nil).Expect(422)
}

func TestForYouAICollectionsAndAdminRerun(t *testing.T) {
	f := newFyEnv(t)
	a := f.sciFiProfile(t, f.alice, "Sci")
	good := aiJSON(
		[]string{"Cerebral sci-fi", "Solaris|1972", "Stalker|1979", "Moon|2009", "Primer|2005", "Gattaca|1997", "Arrival|2016",
			"Contact|1997", "Twin Peril|2001", "Nonexistent Film|1999", "Blade Runner|1982"},
		[]string{"Too few", "Moon|2009", "Nope One|2000", "Nope Two|2001", "Nope Three|2002", "Nope Four|2003"},
	)
	f.ai.set(good)

	// Users can't rerun.
	f.alice.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "all"}).Expect(403)
	f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "bogus"}).Expect(422)
	f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "profile", "id": "00000000-0000-0000-0000-000000000000"}).Expect(404)

	ws := dialUser(t, f.env, f.alice)
	run := f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "profile", "id": a, "ai": true}).Expect(202).JSON()
	done := waitRun(t, f.admin, run["run_id"].(string))
	if done["status"] != "completed" || num(done["profiles_done"]) != 1 || num(done["profiles_total"]) != 1 ||
		num(done["ai_calls"]) != 1 || num(done["ai_tokens"]) != 1200 || num(done["collections_created"]) != 1 || done["duration_ms"] == nil {
		t.Fatalf("run %v", done)
	}
	if done["requested_by"].(map[string]any)["username"] != "root" {
		t.Fatalf("requested_by %v", done["requested_by"])
	}
	ws.expect("foryou.updated")
	// The prompt carries a taste summary, no identifiers.
	f.ai.mu.Lock()
	prompt := f.ai.prompts[0]
	f.ai.mu.Unlock()
	if !strings.Contains(prompt, "Blade Runner (1982)") || !strings.Contains(prompt, "Science Fiction") ||
		strings.Contains(prompt, a) || strings.Contains(prompt, "alice") || strings.Contains(prompt, "Sci\"") {
		t.Fatalf("prompt %s", prompt)
	}

	cols := f.alice.Do("GET", "/api/v1/foryou/collections?lang=ru&profile_id="+a, nil).Expect(200).JSON()
	items := cols["items"].([]any)
	if cols["ai_enabled"] != true || len(items) != 1 {
		t.Fatalf("collections %v", cols)
	}
	col := items[0].(map[string]any)
	var got []int
	for _, it := range col["items"].([]any) {
		got = append(got, int(it.(map[string]any)["tmdb_id"].(float64)))
	}
	// Resolved: 7 real titles (Primer ±1 year); dropped: ambiguous twins,
	// the nonexistent one, and Blade Runner (already rated).
	if !slices.Equal(got, []int{91, 92, 93, 94, 95, 96, 97}) || col["title"] != "Cerebral sci-fi (ru)" || col["scope"] != "profile" || col["model"] != "deepseek-chat" {
		t.Fatalf("collection %v (%v)", col, got)
	}
	one := f.alice.Do("GET", "/api/v1/foryou/collections/"+col["id"].(string)+"?profile_id="+a, nil).Expect(200).JSON()
	if one["title"] != "Cerebral sci-fi" {
		t.Fatalf("one %v", one)
	}
	b := newProfile(t, f.alice, "Other")
	f.alice.Do("GET", "/api/v1/foryou/collections/"+col["id"].(string)+"?profile_id="+b, nil).Expect(404)

	// The collection becomes a For You row with ai_collection reasons.
	_, rows := f.rowItems(rowsOf(t, f.alice, a))
	var aiRow map[string]any
	for _, r := range rows {
		if r["kind"] == "ai_collection" {
			aiRow = r
		}
	}
	if aiRow == nil || aiRow["title"] != "Cerebral sci-fi" ||
		aiRow["items"].([]any)[0].(map[string]any)["reason"].(map[string]any)["collection_title"] != "Cerebral sci-fi" {
		t.Fatalf("ai row %v", rows)
	}
	// Explore lists it as a tile that browses to its items.
	br := f.alice.Do("GET", "/api/v1/foryou/browse?profile_id="+a+"&tile=collection:"+col["id"].(string), nil).Expect(200).JSON()
	if len(br["items"].([]any)) != 7 {
		t.Fatalf("browse collection %v", br)
	}

	// Scope all: profiles + global collections.
	f.ai.set(aiJSON([]string{"Autumn evenings", "Solaris|1972", "Stalker|1979", "Moon|2009", "Primer|2004", "Gattaca|1997", "Blade Runner|1982"}))
	run = f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "all", "ai": true}).Expect(202).JSON()
	done = waitRun(t, f.admin, run["run_id"].(string))
	if done["status"] != "completed" || num(done["profiles_total"]) < 2 {
		t.Fatalf("all run %v", done)
	}
	var global int
	_ = f.env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM foryou_collections WHERE profile_id IS NULL`).Scan(&global)
	if global != 1 {
		t.Fatalf("global collections %d", global)
	}
	cols = f.alice.Do("GET", "/api/v1/foryou/collections?profile_id="+b, nil).Expect(200).JSON()
	if len(cols["items"].([]any)) != 1 || cols["items"].([]any)[0].(map[string]any)["scope"] != "global" ||
		len(cols["items"].([]any)[0].(map[string]any)["items"].([]any)) != 6 {
		t.Fatalf("global for b %v", cols)
	}

	// Invalid JSON → the profile is skipped with an error, the run completes.
	f.ai.set("this is not json")
	run = f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "profile", "id": a}).Expect(202).JSON()
	done = waitRun(t, f.admin, run["run_id"].(string))
	errs := done["errors"].([]any)
	if done["status"] != "completed" || len(errs) != 1 || errs[0].(map[string]any)["step"] != "ai" ||
		errs[0].(map[string]any)["message"] != "ai returned invalid JSON" || num(done["collections_created"]) != 0 {
		t.Fatalf("invalid run %v", done)
	}

	// 409 while running.
	f.ai.set(good)
	block := make(chan struct{})
	f.ai.mu.Lock()
	f.ai.block = block
	f.ai.mu.Unlock()
	run = f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "profile", "id": a}).Expect(202).JSON()
	conflict := f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "all"}).Expect(409).JSON()
	if conflict["run_id"] != run["run_id"] || conflict["error"].(map[string]any)["code"] != "run_in_progress" {
		t.Fatalf("409 %v", conflict)
	}
	running := f.admin.Do("GET", "/api/v1/admin/foryou/runs", nil).Expect(200).JSON()
	if running["items"].([]any)[0].(map[string]any)["status"] != "running" || running["ai"].(map[string]any)["enabled"] != true ||
		num(running["ai"].(map[string]any)["tokens_today"]) < 1200 || running["daily_at"] != "05:00" || running["next_run_at"] == nil {
		t.Fatalf("runs %v", running)
	}
	close(block)
	f.ai.mu.Lock()
	f.ai.block = nil
	f.ai.mu.Unlock()
	waitRun(t, f.admin, run["run_id"].(string))
	f.alice.Do("GET", "/api/v1/admin/foryou/runs", nil).Expect(403)

	// Audited.
	var audited int
	_ = f.env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events WHERE action = 'foryou.rerun'`).Scan(&audited)
	if audited != 4 { // the 409 is not a run
		t.Fatalf("audit events %d", audited)
	}
	f.env.Server.ForYou.Wait()
}

func TestForYouAIBudgetAndDisabled(t *testing.T) {
	// Budget too small for one call: nothing is sent.
	f := newFyEnv(t, func(c *config.Config) { c.ForYou.AIDailyTokens = 3000 })
	a := f.sciFiProfile(t, f.alice, "Sci")
	run := f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "profile", "id": a}).Expect(202).JSON()
	done := waitRun(t, f.admin, run["run_id"].(string))
	errs := done["errors"].([]any)
	if f.ai.calls.Load() != 0 || len(errs) != 1 || errs[0].(map[string]any)["message"] != "ai token budget exhausted" || done["status"] != "completed" {
		t.Fatalf("budget run %v (calls %d)", done, f.ai.calls.Load())
	}
	// Rows still work.
	if len(rowsOf(t, f.alice, a)["rows"].([]any)) == 0 {
		t.Fatal("no rows")
	}
	f.env.Server.ForYou.Wait()

	// Without a key: AI disabled, everything else works.
	g := newFyEnv(t, func(c *config.Config) { c.ForYou.DeepSeekAPIKey = "" })
	b := g.sciFiProfile(t, g.alice, "Sci")
	cols := g.alice.Do("GET", "/api/v1/foryou/collections?profile_id="+b, nil).Expect(200).JSON()
	if cols["ai_enabled"] != false || len(cols["items"].([]any)) != 0 {
		t.Fatalf("disabled %v", cols)
	}
	run = g.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "all", "ai": true}).Expect(202).JSON()
	done = waitRun(t, g.admin, run["run_id"].(string))
	if done["status"] != "completed" || len(done["errors"].([]any)) != 0 || g.ai.calls.Load() != 0 {
		t.Fatalf("no-key run %v", done)
	}
	if g.admin.Do("GET", "/api/v1/admin/foryou/runs", nil).Expect(200).JSON()["ai"].(map[string]any)["enabled"] != false {
		t.Fatal("ai status")
	}
	g.env.Server.ForYou.Wait()
}

func TestForYouRunFillsCredits(t *testing.T) {
	f := newFyEnv(t, func(c *config.Config) { c.ForYou.DeepSeekAPIKey = "" })
	a := f.sciFiProfile(t, f.alice, "Sci")
	run := f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "user", "id": sessionUserID(t, f.alice), "ai": false}).Expect(202).JSON()
	waitRun(t, f.admin, run["run_id"].(string))
	if f.tmdb.hit("/movie/1") == 0 {
		t.Fatal("credits of rated titles were not fetched")
	}
	taste := f.alice.Do("GET", "/api/v1/profiles/"+a+"/taste?lang=en", nil).Expect(200).JSON()
	dirs := taste["directors"].([]any)
	if len(dirs) == 0 || dirs[0].(map[string]any)["name"] != "Director 900" || num(dirs[0].(map[string]any)["count"]) < 2 {
		t.Fatalf("directors %v", dirs)
	}
	cov := taste["credits_coverage"].(map[string]any)
	if num(cov["with_credits"]) != num(cov["total"]) || num(cov["total"]) < 7 {
		t.Fatalf("coverage %v", cov)
	}
	// Director rows appear once credits are known.
	_, rows := f.rowItems(rowsOf(t, f.alice, a))
	found := false
	for _, r := range rows {
		if r["kind"] == "director" && r["title"] == "More from director Director 900" {
			found = true
			for _, it := range r["items"].([]any) {
				id := int(it.(map[string]any)["media"].(map[string]any)["tmdb_id"].(float64))
				if !slices.Contains([]int{6, 7, 8, 17, 18, 19, 20}, id) {
					t.Fatalf("director row has %d (not directed by 900)", id)
				}
			}
		}
	}
	if !found {
		t.Fatalf("no director row after credits: %v", rows)
	}
	f.env.Server.ForYou.Wait()
}

func TestForYouDiaryAndTasteOwnership(t *testing.T) {
	f := newFyEnv(t, func(c *config.Config) { c.ForYou.DeepSeekAPIKey = "" })
	a := f.sciFiProfile(t, f.alice, "Sci")
	ctx := context.Background()
	// Pin dates: ratings on Oct 3 and 10 (Moscow), a completion on Oct 10,
	// another rating in September.
	at := func(day int, hour int) time.Time { return time.Date(2026, 10, day, hour, 0, 0, 0, time.UTC) }
	for tm, d := range map[int]time.Time{1: at(3, 10), 2: at(10, 20), 3: at(10, 21), 4: time.Date(2026, 9, 15, 10, 0, 0, 0, time.UTC)} {
		if _, err := f.env.Pool.Exec(ctx, `UPDATE ratings SET updated_at = $3 WHERE profile_id = $1 AND media_id = $2`, a, f.ids[tm], d); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.env.Pool.Exec(ctx, `UPDATE ratings SET updated_at = '2026-08-01' WHERE profile_id = $1 AND media_id NOT IN ($2, $3, $4, $5)`,
		a, f.ids[1], f.ids[2], f.ids[3], f.ids[4]); err != nil {
		t.Fatal(err)
	}
	if _, err := f.env.Pool.Exec(ctx, `INSERT INTO watch_progress (profile_id, media_id, position_seconds, duration_seconds, percent, completed, completed_at, updated_at)
		VALUES ($1, $2, 7200, 7200, 1, true, $3, $3)`, a, f.ids[1], at(10, 22)); err != nil {
		t.Fatal(err)
	}
	d := f.alice.Do("GET", "/api/v1/profiles/"+a+"/diary?month=2026-10&lang=en", nil).Expect(200).JSON()
	days := d["days"].([]any)
	if d["month"] != "2026-10" || len(days) != 3 {
		t.Fatalf("diary %v", d)
	}
	// 2026-10-10 20:00/21:00 UTC are 23:00/00:00 MSK: the 21:00 rating is on the 11th.
	day1 := days[0].(map[string]any)
	if day1["date"] != "2026-10-03" || len(day1["entries"].([]any)) != 1 {
		t.Fatalf("day1 %v", day1)
	}
	st := d["stats"].(map[string]any)
	if num(st["movies_watched"]) != 1 || num(st["hours_watched"]) != 2 || num(st["ratings_count"]) != 3 || st["average_rating"] == nil ||
		len(st["top_rated"].([]any)) != 3 || len(st["favorite_genres"].([]any)) == 0 {
		t.Fatalf("stats %v", st)
	}
	d2 := f.alice.Do("GET", "/api/v1/profiles/"+a+"/diary?month=2026-10", nil).Expect(200).JSON()["days"].([]any)
	last := d2[len(d2)-1].(map[string]any)
	if last["date"] != "2026-10-11" {
		t.Fatalf("moscow dates %v", d2)
	}
	f.alice.Do("GET", "/api/v1/profiles/"+a+"/diary?month=2026-13", nil).Expect(422)

	taste := f.alice.Do("GET", "/api/v1/profiles/"+a+"/taste?lang=ru", nil).Expect(200).JSON()
	g := taste["genres"].([]any)[0].(map[string]any)
	if g["key"] != "878" || g["name"] != "Science Fiction" && g["name"] != "фантастика" || num(taste["signals"].(map[string]any)["ratings"]) != 8 ||
		len(taste["rating_histogram"].([]any)) != 10 {
		t.Fatalf("taste %v", taste)
	}

	// Owner only: other accounts and TVs get nothing.
	bob, _ := f.env.NewUserClient("bob", "user")
	bob.Do("GET", "/api/v1/profiles/"+a+"/diary", nil).Expect(404)
	bob.Do("GET", "/api/v1/profiles/"+a+"/taste", nil).Expect(404)
	_, cred := f.env.Pair(f.alice, "TV")
	tv := deviceClient(f.env, cred)
	tv.Do("GET", "/api/v1/profiles/"+a+"/taste", nil).Expect(403)
	tv.Do("GET", "/api/v1/profiles/"+a+"/diary", nil).Expect(403)
	// …but a TV may read rows of profiles it can use.
	tv.Do("GET", "/api/v1/foryou/rows?profile_id="+a, nil).Expect(200)
	f.env.Server.ForYou.Wait()
}
