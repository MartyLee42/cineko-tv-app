package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/watch"
)

// fakeShows serves /tv/{id} and /tv/{id}/season/{n} for series whose
// episodes' air dates are given in days from today (UTC, the default).
type fakeShows struct {
	mu     sync.Mutex
	shows  map[int]map[int][]int // tmdb id → season → air day offsets (episode n = index+1)
	status map[int]string        // tmdb id → TMDB status (default "Returning Series")
}

func (f *fakeShows) set(id, season int, days ...int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.shows[id] == nil {
		f.shows[id] = map[int][]int{}
	}
	f.shows[id][season] = days
}

func almatyDay(off int) string {
	loc, _ := time.LoadLocation("UTC")
	return time.Now().In(loc).AddDate(0, 0, off).Format("2006-01-02")
}

func (f *fakeShows) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var id, n int
	w.Header().Set("Content-Type", "application/json")
	if c, _ := fmt.Sscanf(r.URL.Path, "/tv/%d/season/%d", &id, &n); c == 2 {
		days, ok := f.shows[id][n]
		if !ok {
			w.WriteHeader(404)
			return
		}
		eps := []map[string]any{}
		for i, d := range days {
			eps = append(eps, map[string]any{"id": id*1000 + n*100 + i + 1, "season_number": n, "episode_number": i + 1,
				"name": fmt.Sprintf("Серия %d", i+1), "air_date": almatyDay(d)})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id*10 + n, "season_number": n, "name": fmt.Sprintf("Season %d", n), "episodes": eps})
		return
	}
	if c, _ := fmt.Sscanf(r.URL.Path, "/tv/%d", &id); c == 1 && !strings.Contains(strings.TrimPrefix(r.URL.Path, "/tv/"), "/") {
		seasons := []map[string]any{}
		for s, days := range f.shows[id] {
			seasons = append(seasons, map[string]any{"id": id*10 + s, "season_number": s, "episode_count": len(days), "air_date": almatyDay(days[0])})
		}
		status := f.status[id]
		if status == "" {
			status = "Returning Series"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "name": fmt.Sprintf("Show %d", id), "original_name": fmt.Sprintf("Show %d", id),
			"status": status, "first_air_date": "2020-01-01", "seasons": seasons})
		return
	}
	w.WriteHeader(404)
}

func newEpisodesEnv(t *testing.T) (*watchEnv, *fakeShows) {
	t.Helper()
	f := &fakeShows{shows: map[int]map[int][]int{}, status: map[int]string{}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	w := newWatchEnv(t, func(c *config.Config) {
		c.TMDB.BaseURL = srv.URL
		c.TMDB.AccessToken = "test-token"
		c.Catalog.ImageCacheDir = t.TempDir()
	})
	w.env.Server.Watch.SetNewEpisodesPause(0)
	return w, f
}

func insertSeriesTMDB(t *testing.T, w *watchEnv, tmdbID int, title string) string {
	t.Helper()
	var id string
	if err := w.env.Pool.QueryRow(context.Background(), `
		INSERT INTO media (kind, tmdb_id, original_title, translations) VALUES ('series', $1, $2, jsonb_build_object('en', jsonb_build_object('title', $2::text)))
		RETURNING id`, tmdbID, title).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func episodeID(t *testing.T, w *watchEnv, media string, season, ep int) string {
	t.Helper()
	var id string
	if err := w.env.Pool.QueryRow(context.Background(), `SELECT id FROM episodes WHERE media_id = $1 AND season_number = $2 AND episode_number = $3`,
		media, season, ep).Scan(&id); err != nil {
		t.Fatalf("episode S%dE%d: %v", season, ep, err)
	}
	return id
}

func codes(items []any) []string {
	out := []string{}
	for _, it := range items {
		m := it.(map[string]any)
		e := m["episode"].(map[string]any)
		out = append(out, fmt.Sprintf("%s S%dE%d seen=%v", m["media"].(map[string]any)["title"], int(e["season_number"].(float64)), int(e["episode_number"].(float64)), m["seen"]))
	}
	return out
}

func TestNewEpisodesNightlyCheck(t *testing.T) {
	w, shows := newEpisodesEnv(t)
	ctx := context.Background()
	c := w.alice
	svc := w.env.Server.Watch

	// Watched: S1E1–E2 aired long ago; E3 aired 30 days ago (backlog, outside
	// the first-run window); E4 aired 3 days ago (new); E5 airs in 5 days.
	shows.set(9001, 1, -100, -90, -30, -3, 5)
	watched := insertSeriesTMDB(t, w, 9001, "Watched")
	// In the watchlist only, never started: S1E1 aired yesterday.
	shows.set(9002, 1, -1)
	listed := insertSeriesTMDB(t, w, 9002, "Listed")
	// Not mine: nothing.
	shows.set(9003, 1, -1)
	insertSeriesTMDB(t, w, 9003, "Other")

	// First check: fills the episodes; nothing watched yet for "Watched"
	// (not "mine" until progress) → only Listed.
	c.Do("PUT", "/api/v1/profiles/"+w.pid+"/lists/watchlist/"+listed, nil).Expect(204)
	if _, err := svc.CheckNewEpisodes(ctx, "manual"); err != nil {
		t.Fatal(err)
	}
	// Alice opens the season and marks S1E2 watched.
	c.Do("GET", "/api/v1/media/"+watched+"/seasons/1?lang=ru", nil).Expect(200)
	c.Do("PUT", "/api/v1/media/"+watched+"/watched", map[string]any{"profile_id": w.pid, "watched": true, "episode_id": episodeID(t, w, watched, 1, 2)}).Expect(200)
	run, err := svc.CheckNewEpisodes(ctx, "manual")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "completed" || run.SeriesChecked != 2 || run.Found != 1 {
		t.Fatalf("run %+v", run)
	}
	r := c.Do("GET", "/api/v1/profiles/"+w.pid+"/new-episodes?lang=ru", nil).Expect(200).JSON()
	got := codes(r["items"].([]any))
	if fmt.Sprint(got) != "[Show 9002 S1E1 seen=false Show 9001 S1E4 seen=false]" || num(r["unseen"]) != 2 {
		t.Fatalf("items %v unseen %v", got, r["unseen"])
	}
	if ep := r["items"].([]any)[1].(map[string]any)["episode"].(map[string]any); ep["name"] != "Серия 4" || ep["air_date"] != almatyDay(-3) {
		t.Fatalf("episode %v", ep)
	}

	// No duplicates on the next check.
	if run, _ := svc.CheckNewEpisodes(ctx, "manual"); run.Found != 0 {
		t.Fatalf("duplicates: %+v", run)
	}
	// Bob can't read or mark Alice's profile.
	bob, _ := w.env.NewUserClient("bob", "user")
	bob.Do("GET", "/api/v1/profiles/"+w.pid+"/new-episodes", nil).Expect(404)
	bob.Do("POST", "/api/v1/profiles/"+w.pid+"/new-episodes/seen", map[string]any{"all": true}).Expect(404)
	c.Do("POST", "/api/v1/profiles/"+w.pid+"/new-episodes/seen", map[string]any{}).Expect(422)

	// Watching Listed S1E1 marks it seen.
	_, cred := w.env.Pair(c, "TV")
	tv := deviceClient(w.env, cred)
	tv.Do("GET", "/api/v1/profiles/"+w.pid+"/new-episodes", nil).Expect(200)
	sid := startSession(t, tv, map[string]any{"profile_id": w.pid, "media_id": listed, "episode_id": episodeID(t, w, listed, 1, 1)})["id"].(string)
	report(t, tv, sid, 1, 120, 2400, "playing")
	r = c.Do("GET", "/api/v1/profiles/"+w.pid+"/new-episodes", nil).Expect(200).JSON()
	if got := codes(r["items"].([]any)); fmt.Sprint(got) != "[Watched S1E4 seen=false Listed S1E1 seen=true]" || num(r["unseen"]) != 1 {
		t.Fatalf("after watching %v", got)
	}
	// Mark one seen (from the TV).
	tv.Do("POST", "/api/v1/profiles/"+w.pid+"/new-episodes/seen", map[string]any{"episode_ids": []string{episodeID(t, w, watched, 1, 4)}}).Expect(204)
	if r = c.Do("GET", "/api/v1/profiles/"+w.pid+"/new-episodes", nil).Expect(200).JSON(); num(r["unseen"]) != 0 {
		t.Fatalf("unseen %v", r["unseen"])
	}

	// The next night E5 has aired (simulated): found, then «all seen».
	shows.set(9001, 1, -100, -90, -30, -3, 0)
	if run, _ := svc.CheckNewEpisodes(ctx, "schedule"); run.Found != 1 {
		t.Fatalf("E5: %+v", run)
	}
	c.Do("POST", "/api/v1/profiles/"+w.pid+"/new-episodes/seen", map[string]any{"all": true}).Expect(204)
	if r = c.Do("GET", "/api/v1/profiles/"+w.pid+"/new-episodes", nil).Expect(200).JSON(); num(r["unseen"]) != 0 {
		t.Fatalf("all seen: %v", r)
	}

	// Admin: status + run now; users can't.
	c.Do("GET", "/api/v1/admin/new-episodes", nil).Expect(403)
	admin, _ := w.env.NewUserClient("root", "admin")
	st := admin.Do("GET", "/api/v1/admin/new-episodes", nil).Expect(200).JSON()
	if st["at"] != "04:00" || st["timezone"] != "UTC" || len(st["runs"].([]any)) != 4 || st["next_run_at"] == nil {
		t.Fatalf("status %v", st)
	}
	admin.Do("POST", "/api/v1/admin/new-episodes/run", nil).Expect(202)
	for i := 0; i < 100; i++ {
		st = admin.Do("GET", "/api/v1/admin/new-episodes", nil).Expect(200).JSON()
		if st["running"] == false && len(st["runs"].([]any)) == 5 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if last := st["runs"].([]any)[0].(map[string]any); last["trigger"] != "manual" || last["status"] != "completed" {
		t.Fatalf("run now: %v", last)
	}
}

func TestNewEpisodesNextNightly(t *testing.T) {
	loc, _ := time.LoadLocation("UTC")
	cfg := config.NewEpisodesConfig{Hour: 4, Location: loc}
	at := func(s string) time.Time {
		v, err := time.ParseInLocation("2006-01-02 15:04", s, loc)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	for _, c := range []struct{ now, want string }{
		{"2026-10-30 03:59", "2026-10-30 04:00"},
		{"2026-10-30 04:00", "2026-10-31 04:00"},
		{"2026-10-30 23:30", "2026-10-31 04:00"},
		{"2026-12-31 05:00", "2027-01-01 04:00"},
	} {
		got := watch.NextNightly(at(c.now), cfg)
		if got == nil || !got.Equal(at(c.want)) {
			t.Fatalf("%s → %v, want %s", c.now, got, c.want)
		}
	}
	cfg.Off = true
	if watch.NextNightly(time.Now(), cfg) != nil {
		t.Fatal("off")
	}
}

// Kinopoisk-imported series count only while ongoing, and only for episodes
// that aired after the import (no backlog); ended ones are left out.
func TestNewEpisodesKinopoiskImport(t *testing.T) {
	w, shows := newEpisodesEnv(t)
	ctx := context.Background()
	svc := w.env.Server.Watch
	pool := w.env.Pool
	var uid string
	if err := pool.QueryRow(ctx, `SELECT user_id FROM profiles WHERE id = $1`, w.pid).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	// Ongoing: E1 aired before the import (5 days ago) → backlog; E2 three days ago → new.
	shows.set(9101, 1, -30, -3)
	ongoing := insertSeriesTMDB(t, w, 9101, "KP Ongoing")
	// Ended: an episode two days ago still doesn't count.
	shows.set(9102, 1, -2)
	shows.status[9102] = "Ended"
	ended := insertSeriesTMDB(t, w, 9102, "KP Ended")
	// Ongoing on Kinopoisk but imported long ago with no new episodes since: nothing.
	shows.set(9103, 1, -400)
	quiet := insertSeriesTMDB(t, w, 9103, "KP Quiet")

	var job string
	if err := pool.QueryRow(ctx, `
		INSERT INTO import_jobs (profile_id, user_id, source, status, total, created_at, finished_at)
		VALUES ($1, $2, 'kinopoisk', 'done', 3, now() - interval '5 days', now() - interval '5 days') RETURNING id`, w.pid, uid).Scan(&job); err != nil {
		t.Fatal(err)
	}
	for i, m := range []string{ongoing, ended, quiet} {
		if _, err := pool.Exec(ctx, `INSERT INTO import_job_items (job_id, row_no, kp_id, title, result, media_id) VALUES ($1, $2, $3, 'x', 'rated', $4)`,
			job, i, 1000+i, m); err != nil {
			t.Fatal(err)
		}
		// What the import's «mark watched» writes: a per-title row, no episode.
		if _, err := pool.Exec(ctx, `INSERT INTO watch_progress (profile_id, media_id, percent, completed, completed_at, manual, resumable, updated_at)
			VALUES ($1, $2, 1, true, now() - interval '5 days', true, false, now() - interval '5 days')`, w.pid, m); err != nil {
			t.Fatal(err)
		}
	}
	// A dry-run import of another series never counts.
	shows.set(9104, 1, -1)
	dry := insertSeriesTMDB(t, w, 9104, "KP Dry")
	var dryJob string
	_ = pool.QueryRow(ctx, `INSERT INTO import_jobs (profile_id, user_id, source, status, dry_run, total, finished_at)
		VALUES ($1, $2, 'kinopoisk', 'done', true, 1, now()) RETURNING id`, w.pid, uid).Scan(&dryJob)
	_, _ = pool.Exec(ctx, `INSERT INTO import_job_items (job_id, row_no, kp_id, title, result, media_id) VALUES ($1, 0, 2000, 'x', 'matched', $2)`, dryJob, dry)

	run, err := svc.CheckNewEpisodes(ctx, "manual")
	if err != nil {
		t.Fatal(err)
	}
	// Status unknown before the first refresh: all three imported series are refreshed once.
	if run.SeriesChecked != 3 || run.Found != 1 {
		t.Fatalf("run %+v", run)
	}
	r := w.alice.Do("GET", "/api/v1/profiles/"+w.pid+"/new-episodes", nil).Expect(200).JSON()
	items := r["items"].([]any)
	if got := codes(items); fmt.Sprint(got) != "[KP Ongoing S1E2 seen=false]" {
		t.Fatalf("items %v", got)
	}
	if items[0].(map[string]any)["source"] != "kinopoisk" {
		t.Fatalf("source %v", items[0])
	}
	// Next night: the ended series is no longer refreshed (now known to be ended).
	if run, _ = svc.CheckNewEpisodes(ctx, "schedule"); run.SeriesChecked != 2 || run.Found != 0 {
		t.Fatalf("second run %+v", run)
	}
	// Once the profile really watches the ended one, normal rules apply (no source tag).
	w.alice.Do("GET", "/api/v1/media/"+ended+"/seasons/1", nil).Expect(200)
	w.alice.Do("PUT", "/api/v1/media/"+ended+"/watched", map[string]any{"profile_id": w.pid, "watched": true, "episode_id": episodeID(t, w, ended, 1, 1)}).Expect(200)
	shows.set(9102, 1, -2, -1)
	if run, _ = svc.CheckNewEpisodes(ctx, "schedule"); run.Found != 1 {
		t.Fatalf("ended, watched: %+v", run)
	}
	r = w.alice.Do("GET", "/api/v1/profiles/"+w.pid+"/new-episodes", nil).Expect(200).JSON()
	for _, it := range r["items"].([]any) {
		m := it.(map[string]any)
		if m["media"].(map[string]any)["id"] == ended && m["source"] != nil {
			t.Fatalf("own series tagged: %v", m)
		}
	}
}
