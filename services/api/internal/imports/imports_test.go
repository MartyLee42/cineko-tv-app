package imports_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode"

	"martytv/api/internal/audit"
	"martytv/api/internal/config"
	"martytv/api/internal/imports"
	"martytv/api/internal/testutil"
)

// fakeTMDB answers /search/movie and /search/tv from a fixed list (exact
// normalized names, like TMDB for these simple titles), honoring year /
// first_air_date_year. A query listed in block hangs until released.
type fakeTMDB struct {
	srv     *httptest.Server
	mu      sync.Mutex
	block   map[string]chan struct{}
	queries int
}

type tmdbTitle struct {
	kind           string
	id             int
	ru, orig, date string
	votes          int
}

var tmdbTitles = []tmdbTitle{
	{"movie", 101, "Альфа", "Alpha", "1999-03-31", 1000},
	{"movie", 102, "Браво, Чарли", "Bravo, Charlie", "2006-02-01", 500}, // CSV says 2005: year ±1
	{"movie", 103, "Дельта", "Delta", "2010-05-05", 300},                // CSV has no original title
	{"tv", 104, "Эхо", "Echo Show", "2013-09-01", 700},
	{"movie", 104, "Эхо", "Echo Show", "2013-01-01", 650}, // a film namesake: the series row must pick tv
	{"movie", 108, "Отель", `Hotel "Grand"`, "2003-01-01", 200},
	{"movie", 118, "Отель", `Hotel "Grand"`, "2003-06-01", 190}, // namesake: ambiguous
	{"movie", 110, "Джульетта", "Juliet", "2015-01-01", 80},
}

func fold(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func newFakeTMDB(t *testing.T) *fakeTMDB {
	f := &fakeTMDB{block: map[string]chan struct{}{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		kind := strings.TrimPrefix(r.URL.Path, "/search/")
		if kind != "movie" && kind != "tv" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		f.mu.Lock()
		f.queries++
		ch := f.block[q.Get("query")]
		f.mu.Unlock()
		if ch != nil {
			select {
			case <-ch:
			case <-r.Context().Done():
				return
			}
		}
		year := q.Get("year") + q.Get("first_air_date_year")
		results := []map[string]any{}
		for _, tt := range tmdbTitles {
			if tt.kind != kind || (fold(tt.ru) != fold(q.Get("query")) && fold(tt.orig) != fold(q.Get("query"))) {
				continue
			}
			if year != "" && !strings.HasPrefix(tt.date, year) {
				continue
			}
			it := map[string]any{"id": tt.id, "original_language": "en", "overview": "", "vote_average": 7.5,
				"vote_count": tt.votes, "popularity": 10, "genre_ids": []int{18}, "poster_path": nil, "backdrop_path": nil}
			if kind == "tv" {
				it["name"], it["original_name"], it["first_air_date"] = tt.ru, tt.orig, tt.date
			} else {
				it["title"], it["original_title"], it["release_date"] = tt.ru, tt.orig, tt.date
			}
			results = append(results, it)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"page": 1, "total_pages": 1, "total_results": len(results), "results": results})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeTMDB) blockQuery(q string) chan struct{} {
	f.mu.Lock()
	defer f.mu.Unlock()
	ch := make(chan struct{})
	f.block[q] = ch
	return ch
}

type env struct {
	*testutil.Env
	tmdb *fakeTMDB
}

func newEnv(t *testing.T) *env {
	t.Helper()
	f := newFakeTMDB(t)
	e := testutil.New(t, func(c *config.Config) {
		c.TMDB.BaseURL = f.srv.URL
		c.TMDB.AccessToken = "test-token"
		c.Catalog.ImageCacheDir = t.TempDir()
	})
	e.Server.Imports.SetRetryWait(time.Millisecond)
	return &env{Env: e, tmdb: f}
}

// runner starts the background runner until the test ends.
func (e *env) runner() {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.Server.Imports.Run(ctx); close(done) }()
	e.T.Cleanup(func() { cancel(); <-done })
}

// user is a signed-in user with a profile and a write token (multipart
// uploads go through a plain HTTP client with the bearer token).
type user struct {
	c     *testutil.Client
	token string
	pid   string
}

func (e *env) user(name string) *user {
	c, _ := e.NewUserClient(name, "user")
	pid := c.Do("POST", "/api/v1/profiles", map[string]string{"name": name}).Expect(201).JSON()["id"].(string)
	tok := c.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "imp", "scopes": []string{"read", "write"}}).Expect(201).JSON()["secret"].(string)
	return &user{c: c, token: tok, pid: pid}
}

func fixture(t *testing.T) []byte {
	b, err := os.ReadFile("testdata/kinopoisk_sample.csv")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// upload posts the CSV; fields are extra form values.
func (e *env) upload(u *user, profileID string, csv []byte, fields map[string]string) (int, map[string]any) {
	e.T.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for k, v := range fields {
		_ = mw.WriteField(k, v)
	}
	if csv != nil {
		fw, _ := mw.CreateFormFile("file", "kinopoisk_ratings.csv")
		_, _ = fw.Write(csv)
	}
	_ = mw.Close()
	req, _ := http.NewRequest("POST", e.BaseURL+"/api/v1/profiles/"+profileID+"/imports/kinopoisk", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+u.token)
	req.Header.Set("Origin", e.Origin)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.T.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return res.StatusCode, m
}

func (e *env) start(u *user, fields map[string]string) string {
	e.T.Helper()
	st, m := e.upload(u, u.pid, fixture(e.T), fields)
	if st != 202 {
		e.T.Fatalf("upload: %d %v", st, m)
	}
	return m["job_id"].(string)
}

// wait polls the job until it is done (or failed).
func (e *env) wait(u *user, id string) map[string]any {
	e.T.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		j := u.c.Do("GET", "/api/v1/imports/"+id, nil).Expect(200).JSON()
		if j["status"] == "done" || j["status"] == "failed" {
			return j
		}
		time.Sleep(50 * time.Millisecond)
	}
	e.T.Fatal("import did not finish")
	return nil
}

func counts(j map[string]any) [5]int {
	return [5]int{int(j["total"].(float64)), int(j["matched"].(float64)), int(j["rated"].(float64)),
		int(j["skipped"].(float64)), len(j["unmatched"].([]any))}
}

func (e *env) mediaID(kind string, tmdbID int) string {
	e.T.Helper()
	var id string
	if err := e.Pool.QueryRow(context.Background(), `SELECT id FROM media WHERE kind = $1 AND tmdb_id = $2`, kind, tmdbID).Scan(&id); err != nil {
		e.T.Fatalf("media %s/%d: %v", kind, tmdbID, err)
	}
	return id
}

func (e *env) rating(pid, mediaID string) (int, time.Time) {
	e.T.Helper()
	var r int
	var at time.Time
	err := e.Pool.QueryRow(context.Background(), `SELECT rating, created_at FROM ratings WHERE profile_id = $1 AND media_id = $2`, pid, mediaID).Scan(&r, &at)
	if err != nil {
		return 0, at
	}
	return r, at
}

// seedIndia stores the series for kp 1009 as already mapped (no TMDB search needed).
func (e *env) seedIndia() string {
	var id string
	if err := e.Pool.QueryRow(context.Background(), `INSERT INTO media (kind, tmdb_id, original_title, year, kp_id, kp_rating, kp_votes)
		VALUES ('series', 109, 'India', 2024, 1009, 7.7, 5000) RETURNING id`).Scan(&id); err != nil {
		e.T.Fatal(err)
	}
	return id
}

func TestImportLifecycle(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	alice := e.user("alice")
	bob := e.user("bob")
	india := e.seedIndia()

	// A rating set in Cineko before the import: kept (skipped) by default.
	st, m := e.upload(alice, alice.pid, nil, nil)
	if st != 422 {
		t.Fatalf("no file: %d %v", st, m)
	}
	if st, _ := e.upload(alice, alice.pid, []byte("a,b\n1,2\n"), nil); st != 422 {
		t.Fatalf("not a KP export: %d", st)
	}
	// Ownership: someone else's profile is 404, for upload and progress.
	if st, _ := e.upload(bob, alice.pid, fixture(t), nil); st != 404 {
		t.Fatalf("bob → alice's profile: %d", st)
	}

	// Pre-existing rating on Juliet: materialize it through search first.
	alice.c.Do("GET", "/api/v1/catalog/search?q=Juliet&kind=movie", nil).Expect(200)
	juliet := e.mediaID("movie", 110)
	alice.c.Do("PUT", "/api/v1/profiles/"+alice.pid+"/ratings/"+juliet, map[string]int{"rating": 5}).Expect(204)

	// The runner is not started yet: the job stays queued, and a second
	// import for the same profile is refused.
	id := e.start(alice, nil)
	j := alice.c.Do("GET", "/api/v1/imports/"+id, nil).Expect(200).JSON()
	if j["status"] != "queued" || j["total"] != float64(10) || j["mark_watched"] != true || j["overwrite"] != false {
		t.Fatalf("queued job %v", j)
	}
	if st, m := e.upload(alice, alice.pid, fixture(t), nil); st != 409 || m["error"].(map[string]any)["code"] != "import_in_progress" {
		t.Fatalf("second job: %d %v", st, m)
	}
	bob.c.Do("GET", "/api/v1/imports/"+id, nil).Expect(404)
	bob.c.Do("GET", "/api/v1/profiles/"+alice.pid+"/imports/kinopoisk", nil).Expect(404)

	e.runner()
	j = e.wait(alice, id)
	// total, matched, rated, skipped, unmatched
	if got := counts(j); got != [5]int{10, 6, 5, 1, 4} || j["status"] != "done" || j["processed"] != float64(10) || j["finished_at"] == nil {
		t.Fatalf("counts %v: %v", got, j)
	}
	reasons := map[float64]string{}
	for _, u := range j["unmatched"].([]any) {
		um := u.(map[string]any)
		reasons[um["kp_id"].(float64)] = um["reason"].(string)
	}
	want := map[float64]string{1005: "not_found", 0: "invalid_row", 1007: "invalid_row", 1008: "ambiguous"}
	for k, v := range want {
		if reasons[k] != v {
			t.Fatalf("unmatched reasons %v", reasons)
		}
	}
	// The latest-job endpoint returns the same job.
	if l := alice.c.Do("GET", "/api/v1/profiles/"+alice.pid+"/imports/kinopoisk", nil).Expect(200).JSON(); l["id"] != id {
		t.Fatalf("latest %v", l)
	}

	alpha := e.mediaID("movie", 101)
	// Rating with the original (Moscow → UTC) date.
	if r, at := e.rating(alice.pid, alpha); r != 9 || !at.Equal(time.Date(2026, 1, 2, 18, 30, 0, 0, time.UTC)) {
		t.Fatalf("alpha rating %d at %v", r, at)
	}
	if r, _ := e.rating(alice.pid, e.mediaID("movie", 102)); r != 7 {
		t.Fatalf("bravo (year ±1) %d", r)
	}
	if r, _ := e.rating(alice.pid, e.mediaID("movie", 103)); r != 6 {
		t.Fatalf("delta (Russian title) %d", r)
	}
	if r, _ := e.rating(alice.pid, e.mediaID("series", 104)); r != 8 {
		t.Fatalf("echo series %d", r)
	}
	if r, _ := e.rating(alice.pid, india); r != 3 {
		t.Fatalf("india (existing kp_id) %d", r)
	}
	if r, _ := e.rating(alice.pid, juliet); r != 5 {
		t.Fatalf("juliet must keep the Cineko rating: %d", r)
	}

	// Kinopoisk facts: kp_id + mirror, KP rating seeded only where missing.
	var kpID, votes int
	var kp float64
	if err := e.Pool.QueryRow(ctx, `SELECT kp_id, kp_rating, kp_votes FROM media WHERE id = $1`, alpha).Scan(&kpID, &kp, &votes); err != nil ||
		kpID != 1001 || kp != 8.123 || votes != 1500 {
		t.Fatalf("alpha kp %d %v %d %v", kpID, kp, votes, err)
	}
	var ext string
	if err := e.Pool.QueryRow(ctx, `SELECT external_id FROM media_external_ids WHERE media_id = $1 AND provider = 'kinopoisk'`, alpha).Scan(&ext); err != nil || ext != "1001" {
		t.Fatalf("mirror %q %v", ext, err)
	}
	if err := e.Pool.QueryRow(ctx, `SELECT kp_rating, kp_votes FROM media WHERE id = $1`, india).Scan(&kp, &votes); err != nil || kp != 7.7 || votes != 5000 {
		t.Fatalf("india kp must stay: %v %d %v", kp, votes, err)
	}

	// mark_watched: completed rows dated at the rating, not resumable, so
	// continue watching stays empty; series count as completed.
	var n int
	if err := e.Pool.QueryRow(ctx, `SELECT count(*) FROM watch_progress WHERE profile_id = $1 AND completed AND NOT resumable AND episode_id IS NULL`,
		alice.pid).Scan(&n); err != nil || n != 6 {
		t.Fatalf("watched rows %d %v", n, err)
	}
	if err := e.Pool.QueryRow(ctx, `SELECT count(*) FROM watch_events WHERE profile_id = $1`, alice.pid).Scan(&n); err != nil || n != 0 {
		t.Fatalf("watch events %d", n)
	}
	cw := alice.c.Do("GET", "/api/v1/profiles/"+alice.pid+"/continue-watching", nil).Expect(200).JSON()
	if items := cw["items"].([]any); len(items) != 0 {
		t.Fatalf("continue watching flooded: %v", items)
	}
	states, err := e.Server.Watch.UserStates(ctx, alice.pid, []string{e.mediaID("series", 104), alpha})
	if err != nil || !states[e.mediaID("series", 104)].Completed || !states[alpha].Completed || *states[alpha].Rating != 9 {
		t.Fatalf("states %+v %v", states, err)
	}
	// Rows are dropped once done; the audit event has counts only.
	var hasRows bool
	if err := e.Pool.QueryRow(ctx, `SELECT rows IS NOT NULL FROM import_jobs WHERE id = $1`, id).Scan(&hasRows); err != nil || hasRows {
		t.Fatalf("rows kept: %v %v", hasRows, err)
	}
	var meta string
	if err := e.Pool.QueryRow(ctx, `SELECT metadata::text FROM audit_events WHERE action = 'imports.kinopoisk' AND target_id = $1`, alice.pid).Scan(&meta); err != nil ||
		!strings.Contains(meta, `"rated": 5`) || strings.Contains(meta, "Alpha") {
		t.Fatalf("audit %q %v", meta, err)
	}

	// Overwrite: a second import replaces the Cineko rating; the rest are
	// rewritten with the same values.
	id2 := e.start(alice, map[string]string{"overwrite": "true"})
	j = e.wait(alice, id2)
	if got := counts(j); got != [5]int{10, 6, 6, 0, 4} {
		t.Fatalf("overwrite counts %v", got)
	}
	if r, _ := e.rating(alice.pid, juliet); r != 2 {
		t.Fatalf("juliet overwritten: %d", r)
	}
}

func TestImportOptions(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.runner()
	carol := e.user("carol")
	dave := e.user("dave")

	// mark_watched=false: ratings only.
	j := e.wait(carol, e.start(carol, map[string]string{"mark_watched": "false"}))
	if got := counts(j); got != [5]int{10, 5, 5, 0, 5} { // 1009 has no seeded mapping here → not_found
		t.Fatalf("counts %v", got)
	}
	var n int
	if err := e.Pool.QueryRow(ctx, `SELECT count(*) FROM watch_progress WHERE profile_id = $1`, carol.pid).Scan(&n); err != nil || n != 0 {
		t.Fatalf("watched rows %d", n)
	}

	// dry_run: matches only, writes nothing (no ratings, no kp ids beyond
	// carol's earlier real import).
	if _, err := e.Pool.Exec(ctx, `UPDATE media SET kp_id = NULL, kp_rating = NULL, kp_votes = NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := e.Pool.Exec(ctx, `DELETE FROM media_external_ids WHERE provider = 'kinopoisk'`); err != nil {
		t.Fatal(err)
	}
	j = e.wait(dave, e.start(dave, map[string]string{"dry_run": "true"}))
	if got := counts(j); got != [5]int{10, 5, 0, 0, 5} || j["dry_run"] != true {
		t.Fatalf("dry run counts %v", got)
	}
	if err := e.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM ratings WHERE profile_id = $1) + (SELECT count(*) FROM watch_progress WHERE profile_id = $1)
		+ (SELECT count(*) FROM media WHERE kp_id IS NOT NULL)`, dave.pid).Scan(&n); err != nil || n != 0 {
		t.Fatalf("dry run wrote %d rows", n)
	}
	if st, _ := e.upload(dave, dave.pid, fixture(t), map[string]string{"overwrite": "maybe"}); st != 422 {
		t.Fatalf("bad switch: %d", st)
	}
}

func TestImportResumesAfterRestart(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	erin := e.user("erin")
	// One line hangs at TMDB, so the job is interrupted mid-way.
	release := e.tmdb.blockQuery("Echo Show")
	id := e.start(erin, nil)

	runCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { e.Server.Imports.Run(runCtx); close(done) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		j := erin.c.Do("GET", "/api/v1/imports/"+id, nil).Expect(200).JSON()
		if j["status"] == "running" && j["processed"].(float64) >= 9 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never reached 9 processed: %v", j)
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop() // "shutdown" while Echo Show is in flight
	<-done
	j := erin.c.Do("GET", "/api/v1/imports/"+id, nil).Expect(200).JSON()
	if j["status"] != "running" || j["processed"] != float64(9) {
		t.Fatalf("after shutdown %v", j)
	}
	close(release)

	// A new process: a fresh service on the same database resumes the job.
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	restarted := imports.NewService(e.Pool, e.Server.Catalog, audit.New(e.Pool, log), log)
	if ran, err := restarted.RunNext(ctx); !ran || err != nil {
		t.Fatalf("resume: %v %v", ran, err)
	}
	j = erin.c.Do("GET", "/api/v1/imports/"+id, nil).Expect(200).JSON()
	if got := counts(j); j["status"] != "done" || got != [5]int{10, 5, 5, 0, 5} {
		t.Fatalf("resumed %v %v", got, j)
	}
	if r, _ := e.rating(erin.pid, e.mediaID("series", 104)); r != 8 {
		t.Fatalf("echo after resume %d", r)
	}
	if ran, _ := restarted.RunNext(ctx); ran {
		t.Fatal("nothing left to run")
	}
}
