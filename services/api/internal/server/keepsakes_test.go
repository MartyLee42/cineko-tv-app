package server_test

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"martytv/api/internal/keepsakes"
	"martytv/api/internal/testutil"
)

func insertFilm(t *testing.T, env *testutil.Env, title, lang string, released string) string {
	t.Helper()
	tmdbSeq++
	var rel any
	if released != "" {
		rel = released
	}
	var id string
	if err := env.Pool.QueryRow(context.Background(), `
		INSERT INTO media (kind, tmdb_id, original_title, original_language, release_date, poster_path, translations)
		VALUES ('movie', $1, $2, $3, $4::date, '/p.jpg', jsonb_build_object('en', jsonb_build_object('title', $2::text)))
		RETURNING id`, tmdbSeq, title, lang, rel).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// finished writes a completed progress row as if the history had it.
func finished(t *testing.T, env *testutil.Env, pid, media string, episode *string, at time.Time, manual bool) {
	t.Helper()
	if _, err := env.Pool.Exec(context.Background(), `
		INSERT INTO watch_progress (profile_id, media_id, episode_id, position_seconds, duration_seconds, percent, completed, completed_at, manual, updated_at)
		VALUES ($1, $2, $3, 5000, 5000, 1, true, $4, $5, $4)`, pid, media, episode, at, manual); err != nil {
		t.Fatal(err)
	}
}

// runBackfill executes the migration's backfill statement (the schema is
// already migrated, so it is run by hand on the history written above).
func runBackfill(t *testing.T, env *testutil.Env) {
	t.Helper()
	raw, err := os.ReadFile("../db/migrations/00040_keepsakes.sql")
	if err != nil {
		t.Fatal(err)
	}
	s := string(raw)
	from := strings.Index(s, "INSERT INTO ticket_stubs")
	to := strings.Index(s, "-- +goose Down")
	if from < 0 || to < from {
		t.Fatal("backfill statement not found")
	}
	if _, err := env.Pool.Exec(context.Background(), s[from:to]); err != nil {
		t.Fatal(err)
	}
}

func TestKeepsakesTickets(t *testing.T) {
	w := newWatchEnv(t)
	ctx := context.Background()
	casablanca := insertFilm(t, w.env, "Casablanca", "en", "1942-11-26")
	amelie := insertFilm(t, w.env, "Amelie", "fr", "2001-04-25")
	heat := insertFilm(t, w.env, "Heat", "en", "1995-12-15")
	half := insertFilm(t, w.env, "Half Watched", "en", "2010-01-01")
	show, eps := insertSeries(t, w.env, "Show")
	ep := eps["S1E1"]

	// History from before the feature: Amélie first, then Casablanca (manual).
	finished(t, w.env, w.pid, casablanca, nil, time.Date(2026, 1, 10, 20, 30, 0, 0, time.UTC), true)
	finished(t, w.env, w.pid, amelie, nil, time.Date(2026, 1, 5, 22, 15, 0, 0, time.UTC), false)
	finished(t, w.env, w.pid, show, &ep, time.Date(2026, 1, 6, 20, 0, 0, 0, time.UTC), false) // series: no stub
	if _, err := w.env.Pool.Exec(ctx, `INSERT INTO watch_progress (profile_id, media_id, position_seconds, percent) VALUES ($1, $2, 600, 0.2)`, w.pid, half); err != nil {
		t.Fatal(err)
	}
	runBackfill(t, w.env)

	page := w.alice.Do("GET", "/api/v1/profiles/"+w.pid+"/tickets?lang=en", nil).Expect(200).JSON()
	if page["total"] != 2.0 || page["cinema"] != "Cineko" || page["timezone"] != "Europe/Moscow" || page["next_cursor"] != nil {
		t.Fatalf("page %v", page)
	}
	items := page["items"].([]any)
	first, second := items[0].(map[string]any), items[1].(map[string]any)
	if first["number"] != 2.0 || first["media"].(map[string]any)["id"] != casablanca || second["number"] != 1.0 || second["media"].(map[string]any)["id"] != amelie {
		t.Fatalf("order %v", items)
	}
	// The household clock: 2026-01-05 22:15 UTC is 01:15 on the 6th in Moscow.
	if second["date"] != "2026-01-06" || second["time"] != "01:15" || second["finished_at"] != "2026-01-05T22:15:00Z" || second["rating"] != nil {
		t.Fatalf("stub %v", second)
	}
	seat := keepsakes.SeatFor(w.pid, amelie)
	if second["hall"] != float64(seat.Hall) || second["row"] != float64(seat.Row) || second["seat"] != float64(seat.Seat) {
		t.Fatalf("seat %v, want %+v", second, seat)
	}

	// The rating is punched live.
	w.alice.Do("PUT", "/api/v1/profiles/"+w.pid+"/ratings/"+amelie, map[string]any{"rating": 8}).Expect(204)
	// A film finished by playback gets the next number.
	s := startSession(t, w.alice, map[string]any{"profile_id": w.pid, "media_id": heat})
	report(t, w.alice, s["id"].(string), 1, 6000, 6000, "ended")
	page = w.alice.Do("GET", "/api/v1/profiles/"+w.pid+"/tickets?lang=en&limit=2", nil).Expect(200).JSON()
	items = page["items"].([]any)
	if page["total"] != 3.0 || len(items) != 2 || items[0].(map[string]any)["media"].(map[string]any)["id"] != heat ||
		items[0].(map[string]any)["number"] != 3.0 || page["next_cursor"] != "2" {
		t.Fatalf("after playback %v", page)
	}
	page = w.alice.Do("GET", "/api/v1/profiles/"+w.pid+"/tickets?cursor=2&limit=2", nil).Expect(200).JSON()
	items = page["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["number"] != 1.0 || items[0].(map[string]any)["rating"] != 8.0 || page["next_cursor"] != nil {
		t.Fatalf("second page %v", page)
	}

	// A stub is a keepsake: marking the film unwatched (or rewatching it) keeps it, once.
	w.alice.Do("PUT", "/api/v1/media/"+heat+"/watched", map[string]any{"profile_id": w.pid, "watched": false}).Expect(200)
	w.alice.Do("PUT", "/api/v1/media/"+heat+"/watched", map[string]any{"profile_id": w.pid, "watched": true}).Expect(200)
	page = w.alice.Do("GET", "/api/v1/profiles/"+w.pid+"/tickets", nil).Expect(200).JSON()
	if page["total"] != 3.0 {
		t.Fatalf("rewatch %v", page)
	}
	var stubs int
	if err := w.env.Pool.QueryRow(ctx, `SELECT count(*) FROM ticket_stubs WHERE profile_id = $1 AND media_id = $2`, w.pid, heat).Scan(&stubs); err != nil || stubs != 1 {
		t.Fatalf("heat stubs %d %v", stubs, err)
	}

	for _, q := range []string{"limit=0", "limit=101", "cursor=abc", "cursor=0", "lang=de"} {
		w.alice.Do("GET", "/api/v1/profiles/"+w.pid+"/tickets?"+q, nil).Expect(422)
	}
}

func TestKeepsakesPermissions(t *testing.T) {
	w := newWatchEnv(t)
	bob, _ := w.env.NewUserClient("bob", "user")
	admin, _ := w.env.NewUserClient("root", "admin")
	_, cred := w.env.Pair(w.alice, "Living room")
	tv := deviceClient(w.env, cred)
	for _, path := range []string{"/tickets", "/achievements"} {
		u := "/api/v1/profiles/" + w.pid + path
		w.alice.Do("GET", u, nil).Expect(200)
		tv.Do("GET", u, nil).Expect(200)
		admin.Do("GET", u, nil).Expect(200)
		bob.Do("GET", u, nil).Expect(404)
		w.env.Client().Do("GET", u, nil).Expect(401)
		admin.Do("GET", "/api/v1/profiles/00000000-0000-0000-0000-000000000000"+path, nil).Expect(404)
		admin.Do("GET", "/api/v1/profiles/nope"+path, nil).Expect(404)
	}
	// Bob's TV cannot read Alice's profile either.
	_, bobCred := w.env.Pair(bob, "Bob's TV")
	deviceClient(w.env, bobCred).Do("GET", "/api/v1/profiles/"+w.pid+"/tickets", nil).Expect(404)
}

func achievementIDs(t *testing.T, res map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, it := range res["items"].([]any) {
		m := it.(map[string]any)
		out[m["id"].(string)] = m
	}
	return out
}

func TestKeepsakesAchievements(t *testing.T) {
	w := newWatchEnv(t)
	ctx := context.Background()
	u := "/api/v1/profiles/" + w.pid + "/achievements?lang=en"
	total := float64(len(keepsakes.Rules))
	res := w.alice.Do("GET", u, nil).Expect(200).JSON()
	if len(res["items"].([]any)) != 0 || len(res["progress"].([]any)) != 0 || res["secret"] != total || res["total"] != total {
		t.Fatalf("empty %v", res)
	}

	casablanca := insertFilm(t, w.env, "Casablanca", "en", "1942-11-26")
	show, eps := insertSeries(t, w.env, "Show")
	// Casablanca marked watched by hand at 03:10 Moscow: an archaeologist, not a night owl.
	finished(t, w.env, w.pid, casablanca, nil, time.Date(2026, 3, 1, 0, 10, 0, 0, time.UTC), true)
	// S1 (3 aired episodes) over one weekend: Sat 7 Nov 2026, the last at 02:40 Sunday Moscow.
	for i, at := range []time.Time{
		time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC),
		time.Date(2026, 11, 7, 15, 0, 0, 0, time.UTC),
		time.Date(2026, 11, 7, 23, 40, 0, 0, time.UTC),
	} {
		e := eps[fmt.Sprintf("S1E%d", i+1)]
		finished(t, w.env, w.pid, show, &e, at, false)
	}
	// Casablanca's genres, countries and an Oscar come from the catalog tables.
	if _, err := w.env.Pool.Exec(ctx, `UPDATE media SET countries = '{US}', runtime = 102 WHERE id = $1`, casablanca); err != nil {
		t.Fatal(err)
	}
	if _, err := w.env.Pool.Exec(ctx, `INSERT INTO media_genres (media_id, genre_id) VALUES ($1, 18), ($1, 10749)`, casablanca); err != nil {
		t.Fatal(err)
	}
	if _, err := w.env.Pool.Exec(ctx, `INSERT INTO media_awards (media_id, award_qid, group_key, won, tier) VALUES ($1, 'Q102427', 'oscar', true, 1)`, casablanca); err != nil {
		t.Fatal(err)
	}
	res = w.alice.Do("GET", u, nil).Expect(200).JSON()
	got := achievementIDs(t, res)
	for _, id := range []string{"marathon", "archaeologist", "night_owl", "films_1", "decade_1940s", "oscar"} {
		if got[id] == nil {
			t.Fatalf("no %s in %v", id, res)
		}
	}
	if got["polyglot"] != nil || got["early_bird"] != nil {
		t.Fatalf("unlocked %v", res)
	}
	// Counter stickers on their way: 1 language of 5, 1 film of 10, 3 episodes of 10.
	progress := map[string]map[string]any{}
	for _, it := range res["progress"].([]any) {
		m := it.(map[string]any)
		progress[m["id"].(string)] = m
	}
	if p := progress["polyglot"]; p == nil || p["have"] != 1.0 || p["need"] != 5.0 {
		t.Fatalf("progress %v", res["progress"])
	}
	if p := progress["films_10"]; p == nil || p["have"] != 1.0 {
		t.Fatalf("progress %v", res["progress"])
	}
	if p := progress["episodes_10"]; p == nil || p["have"] != 3.0 {
		t.Fatalf("progress %v", res["progress"])
	}
	if res["secret"] != total-float64(len(got))-float64(len(progress)) {
		t.Fatalf("secret %v", res)
	}
	if a := got["archaeologist"]; a["media_id"] != casablanca || a["media_title"] != "Casablanca" || a["unlocked_at"] != "2026-03-01T00:10:00Z" || a["date"] != "2026-03-01" {
		t.Fatalf("archaeologist %v", a)
	}
	if a := got["marathon"]; a["media_id"] != show || a["unlocked_at"] != "2026-11-07T23:40:00Z" || a["date"] != "2026-11-08" {
		t.Fatalf("marathon %v", a)
	}
	if a := got["night_owl"]; a["media_id"] != show || a["unlocked_at"] != "2026-11-07T23:40:00Z" {
		t.Fatalf("night owl %v", a)
	}
	// Oldest first.
	if first := res["items"].([]any)[0].(map[string]any); first["id"] != "archaeologist" {
		t.Fatalf("order %v", res["items"])
	}

	// Five original languages → «Полиглот» (en already there).
	for i, l := range []string{"fr", "ja", "ko", "ru"} {
		m := insertFilm(t, w.env, "Film "+l, l, "2000-01-01")
		finished(t, w.env, w.pid, m, nil, time.Date(2026, 6, 1+i, 18, 0, 0, 0, time.UTC), false)
	}
	res = w.alice.Do("GET", u, nil).Expect(200).JSON()
	got = achievementIDs(t, res)
	if p := got["polyglot"]; p == nil || p["unlocked_at"] != "2026-06-04T18:00:00Z" || p["media_title"] != "Film ru" {
		t.Fatalf("polyglot %v", res)
	}
	// The profile's own ratings: a 10.
	w.alice.Do("PUT", "/api/v1/profiles/"+w.pid+"/ratings/"+casablanca, map[string]any{"rating": 10}).Expect(204)
	res = w.alice.Do("GET", u, nil).Expect(200).JSON()
	got = achievementIDs(t, res)
	if p := got["perfect_10"]; p == nil || p["media_id"] != casablanca {
		t.Fatalf("perfect_10 %v", res)
	}
	earned := len(got)

	// Stickers stay when the history goes away.
	if _, err := w.env.Pool.Exec(ctx, `DELETE FROM watch_progress WHERE profile_id = $1`, w.pid); err != nil {
		t.Fatal(err)
	}
	res = w.alice.Do("GET", u, nil).Expect(200).JSON()
	if len(res["items"].([]any)) != earned {
		t.Fatalf("after clearing history %v", res)
	}
	// Another profile of the same account starts from scratch.
	other := newProfile(t, w.alice, "Kid")
	res = w.alice.Do("GET", "/api/v1/profiles/"+other+"/achievements", nil).Expect(200).JSON()
	if len(res["items"].([]any)) != 0 {
		t.Fatalf("other profile %v", res)
	}
}
