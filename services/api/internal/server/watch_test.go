package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"testing"
	"time"

	"martytv/api/internal/testutil"
)

// ---- fixtures ----

type watchEnv struct {
	env   *testutil.Env
	alice *testutil.Client
	pid   string // alice's profile
}

func newWatchEnv(t *testing.T, opts ...testutil.Options) *watchEnv {
	t.Helper()
	env := testutil.New(t, opts...)
	alice, _ := env.NewUserClient("alice", "user")
	return &watchEnv{env: env, alice: alice, pid: newProfile(t, alice, "Alice")}
}

func newProfile(t *testing.T, c *testutil.Client, name string) string {
	t.Helper()
	return c.Do("POST", "/api/v1/profiles", map[string]string{"name": name}).Expect(201).JSON()["id"].(string)
}

func deviceClient(env *testutil.Env, cred string) *testutil.Client {
	c := env.Client()
	c.Bearer = cred
	return c
}

var tmdbSeq = 5000

func insertMovie(t *testing.T, env *testutil.Env, title string) string {
	t.Helper()
	tmdbSeq++
	var id string
	if err := env.Pool.QueryRow(context.Background(), `
		INSERT INTO media (kind, tmdb_id, original_title, translations) VALUES ('movie', $1, $2, jsonb_build_object('en', jsonb_build_object('title', $2::text)))
		RETURNING id`, tmdbSeq, title).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// insertSeries creates a series with S1E1-3, S2E1-2 aired and S2E3 airing
// in the future, plus a special S0E1. Episode ids are keyed "S1E2".
func insertSeries(t *testing.T, env *testutil.Env, title string) (string, map[string]string) {
	t.Helper()
	tmdbSeq++
	ctx := context.Background()
	var id string
	if err := env.Pool.QueryRow(ctx, `
		INSERT INTO media (kind, tmdb_id, original_title, translations) VALUES ('series', $1, $2, jsonb_build_object('en', jsonb_build_object('title', $2::text)))
		RETURNING id`, tmdbSeq, title).Scan(&id); err != nil {
		t.Fatal(err)
	}
	eps := map[string]string{}
	past, future := time.Now().AddDate(-1, 0, 0), time.Now().AddDate(0, 1, 0)
	for _, s := range []struct{ n, count int }{{0, 1}, {1, 3}, {2, 3}} {
		var sid string
		if err := env.Pool.QueryRow(ctx, `INSERT INTO seasons (media_id, season_number, episode_count, air_date) VALUES ($1, $2, $3, $4) RETURNING id`,
			id, s.n, s.count, past).Scan(&sid); err != nil {
			t.Fatal(err)
		}
		for e := 1; e <= s.count; e++ {
			air := past
			if s.n == 2 && e == 3 {
				air = future
			}
			var eid string
			if err := env.Pool.QueryRow(ctx, `
				INSERT INTO episodes (media_id, season_id, season_number, episode_number, air_date, translations)
				VALUES ($1, $2, $3, $4, $5, jsonb_build_object('en', jsonb_build_object('name', $6::text))) RETURNING id`,
				id, sid, s.n, e, air, fmt.Sprintf("Episode %d.%d", s.n, e)).Scan(&eid); err != nil {
				t.Fatal(err)
			}
			eps[fmt.Sprintf("S%dE%d", s.n, e)] = eid
		}
	}
	return id, eps
}

func startSession(t *testing.T, c *testutil.Client, body map[string]any) map[string]any {
	t.Helper()
	return c.Do("POST", "/api/v1/playback/sessions", body).Expect(201).JSON()
}

func report(t *testing.T, c *testutil.Client, sid string, seq int, pos float64, dur any, state string) map[string]any {
	t.Helper()
	return c.Do("POST", "/api/v1/playback/sessions/"+sid+"/progress",
		map[string]any{"seq": seq, "position_seconds": pos, "duration_seconds": dur, "state": state}).Expect(200).JSON()
}

func expectAccepted(t *testing.T, r map[string]any, want bool, reason string) {
	t.Helper()
	if r["accepted"] != want || (reason != "" && r["reason"] != reason) {
		t.Fatalf("report result %v (want accepted=%v reason=%q)", r, want, reason)
	}
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

func progressOf(r map[string]any) map[string]any {
	p, _ := r["progress"].(map[string]any)
	return p
}

// ---- tests ----

// Acceptance: stop on one TV, resume at ~the same position on another; the
// first TV's delayed report can't overwrite the newer session's progress.
func TestWatchResumeOnAnotherTV(t *testing.T) {
	w := newWatchEnv(t)
	movie := insertMovie(t, w.env, "Heat")
	devA, credA := w.env.Pair(w.alice, "Living room")
	devB, credB := w.env.Pair(w.alice, "Bedroom")
	tvA, tvB := deviceClient(w.env, credA), deviceClient(w.env, credB)

	a := startSession(t, tvA, map[string]any{"profile_id": w.pid, "media_id": movie})
	if a["resume_position_seconds"] != nil || a["progress"] != nil || a["report_token"] == "" {
		t.Fatalf("fresh session %v", a)
	}
	sa := a["id"].(string)
	// Opening is not watching.
	expectAccepted(t, report(t, tvA, sa, 1, 12, 7200, "playing"), false, "too_early")
	if r := w.alice.Do("GET", "/api/v1/media/"+movie+"/progress?profile_id="+w.pid, nil).Expect(200).JSON(); r["movie"] != nil {
		t.Fatalf("progress written before 30 s: %v", r)
	}
	expectAccepted(t, report(t, tvA, sa, 2, 600, 7200, "playing"), true, "")
	expectAccepted(t, report(t, tvA, sa, 4, 1200, 7200, "stopped"), true, "")
	// Out-of-order (older seq) is ignored.
	r := report(t, tvA, sa, 3, 900, 7200, "playing")
	expectAccepted(t, r, false, "stale_sequence")
	if num(progressOf(r)["position_seconds"]) != 1200 {
		t.Fatalf("stale report changed progress: %v", r)
	}

	// Another TV resumes at ~1200 s.
	b := startSession(t, tvB, map[string]any{"profile_id": w.pid, "media_id": movie})
	if math.Abs(num(b["resume_position_seconds"])-1200) > 1 {
		t.Fatalf("resume %v", b)
	}
	sb := b["id"].(string)
	expectAccepted(t, report(t, tvB, sb, 0, 1215, 7200, "playing"), true, "")

	// TV A wakes up and sends a delayed report with a higher seq: stale session.
	r = report(t, tvA, sa, 5, 1250, 7200, "playing")
	expectAccepted(t, r, false, "stale_session")
	p := w.alice.Do("GET", "/api/v1/media/"+movie+"/progress?profile_id="+w.pid, nil).Expect(200).JSON()["movie"].(map[string]any)
	if num(p["position_seconds"]) != 1215 || p["device_id"] != devB || p["completed"] != false {
		t.Fatalf("progress %v (devA %s)", p, devA)
	}
	if math.Abs(num(p["percent"])-1215.0/7200) > 1e-6 {
		t.Fatalf("percent %v", p["percent"])
	}

	// TV B may not report on A's session; a browser user may not either.
	tvB.Do("POST", "/api/v1/playback/sessions/"+sa+"/progress", map[string]any{"seq": 9, "position_seconds": 1, "state": "playing"}).Expect(404)
	w.alice.Do("POST", "/api/v1/playback/sessions/"+sa+"/progress", map[string]any{"seq": 9, "position_seconds": 1, "state": "playing"}).Expect(404)
	// Validation.
	tvB.Do("POST", "/api/v1/playback/sessions/"+sb+"/progress", map[string]any{"seq": 9, "position_seconds": -1, "state": "dancing"}).Expect(422)

	var events int
	_ = w.env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM watch_events WHERE media_id = $1`, movie).Scan(&events)
	if events != 3 { // A: 600 playing, 1200 stopped; B: 1215 playing
		t.Fatalf("events %d", events)
	}
}

// A newer session that has started reporting supersedes an older one even
// before it wrote progress; a session that was merely opened does not.
func TestWatchNewerSessionRules(t *testing.T) {
	w := newWatchEnv(t)
	movie := insertMovie(t, w.env, "Ronin")
	s1 := startSession(t, w.alice, map[string]any{"profile_id": w.pid, "media_id": movie})["id"].(string)
	expectAccepted(t, report(t, w.alice, s1, 1, 100, 6000, "playing"), true, "")

	// Opened but never played: s1 keeps reporting.
	startSession(t, w.alice, map[string]any{"profile_id": w.pid, "media_id": movie})
	expectAccepted(t, report(t, w.alice, s1, 2, 115, 6000, "playing"), true, "")

	// A newer session that reports (even too early) wins.
	s3 := startSession(t, w.alice, map[string]any{"profile_id": w.pid, "media_id": movie})
	if num(startSession(t, w.alice, map[string]any{"profile_id": w.pid, "media_id": movie})["resume_position_seconds"]) != 115 {
		t.Fatal("resume")
	}
	// …but its opening seconds don't wipe the saved position.
	expectAccepted(t, report(t, w.alice, s3["id"].(string), 0, 5, 6000, "playing"), false, "too_early")
	expectAccepted(t, report(t, w.alice, s1, 3, 130, 6000, "playing"), false, "stale_session")
}

// A source that fails before seeking to the resume point (reports 0 and
// stops) keeps the saved position; progress names the source it was saved
// with, so Continue can play it again.
func TestWatchKeepsResumeAndSource(t *testing.T) {
	w := newWatchEnv(t)
	ctx := context.Background()
	movie := insertMovie(t, w.env, "Home Sweet Home")
	_, cred := w.env.Pair(w.alice, "Living Room")
	tv := deviceClient(w.env, cred)
	var uid string
	if err := w.env.Pool.QueryRow(ctx, `SELECT id FROM users WHERE username = 'alice'`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	src := func(hash string) string {
		var id string
		if err := w.env.Pool.QueryRow(ctx, `
			INSERT INTO playback_sources (media_id, release_id, release, info_hash, created_by_user_id, status)
			VALUES ($1, $2, '{}', $3, $4, 'ready') RETURNING id`, movie, "r-"+hash[:4], hash, uid).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	good, broken := src("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), src("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")

	s1 := startSession(t, tv, map[string]any{"profile_id": w.pid, "media_id": movie, "source_id": good})["id"].(string)
	expectAccepted(t, report(t, tv, s1, 1, 1553, 5593, "stopped"), true, "")

	s2 := startSession(t, tv, map[string]any{"profile_id": w.pid, "media_id": movie, "source_id": broken})["id"].(string)
	expectAccepted(t, report(t, tv, s2, 1, 0, 5593, "paused"), false, "too_early")
	expectAccepted(t, report(t, tv, s2, 2, 0, 5593, "stopped"), false, "too_early")

	// One session plays on, then the TV engine restarts the stream from 0
	// after a stall and the viewer stops: the spot it reached stays.
	s3 := startSession(t, tv, map[string]any{"profile_id": w.pid, "media_id": movie, "source_id": good})["id"].(string)
	expectAccepted(t, report(t, tv, s3, 1, 1553, 5593, "playing"), true, "")
	expectAccepted(t, report(t, tv, s3, 2, 1620, 5593, "playing"), true, "")
	expectAccepted(t, report(t, tv, s3, 3, 4, 5593, "playing"), false, "position_reset")
	expectAccepted(t, report(t, tv, s3, 4, 9, 5593, "stopped"), false, "position_reset")
	if p := w.alice.Do("GET", "/api/v1/media/"+movie+"/progress?profile_id="+w.pid, nil).Expect(200).JSON()["movie"].(map[string]any); num(p["position_seconds"]) != 1620 {
		t.Fatalf("after a reset: %v (want 1620)", p)
	}
	// A real seek back (reported as seeking) still moves it.
	expectAccepted(t, report(t, tv, s3, 5, 0, 5593, "seeking"), true, "")
	expectAccepted(t, report(t, tv, s3, 6, 1553, 5593, "playing"), true, "")

	p := w.alice.Do("GET", "/api/v1/media/"+movie+"/progress?profile_id="+w.pid, nil).Expect(200).JSON()["movie"].(map[string]any)
	if num(p["position_seconds"]) != 1553 || p["source_id"] != good {
		t.Fatalf("progress %v (want 1553 with source %s)", p, good)
	}
	items := w.alice.Do("GET", "/api/v1/profiles/"+w.pid+"/continue-watching", nil).Expect(200).Items()
	if len(items) != 1 || progressOf(items[0])["source_id"] != good {
		t.Fatalf("continue %v", items)
	}
}

func TestWatchCompletionRules(t *testing.T) {
	w := newWatchEnv(t)
	c := w.alice
	play := func(body map[string]any, steps ...[3]any) map[string]any {
		t.Helper()
		sid := startSession(t, c, body)["id"].(string)
		var last map[string]any
		for i, s := range steps {
			last = report(t, c, sid, i, s[0].(float64), s[1], s[2].(string))
		}
		return last
	}
	movie := func(name string) map[string]any {
		return map[string]any{"profile_id": w.pid, "media_id": insertMovie(t, w.env, name)}
	}

	// ≥ 90 %.
	if p := progressOf(play(movie("A"), [3]any{5450.0, 6000, "playing"})); p["completed"] != true || p["completed_at"] == nil {
		t.Fatalf("90%% rule %v", p)
	}
	// Movie tail: ≤ 180 s left (83 % watched of a 1000 s film).
	if p := progressOf(play(movie("B"), [3]any{830.0, 1000, "paused"})); p["completed"] != true {
		t.Fatalf("movie tail %v", p)
	}
	// Seeking to the end does not complete.
	if p := progressOf(play(movie("C"), [3]any{100.0, 6000, "playing"}, [3]any{5900.0, 6000, "seeking"})); p["completed"] != false {
		t.Fatalf("seek completed %v", p)
	}
	// "ended" completes regardless of duration.
	if p := progressOf(play(movie("D"), [3]any{100.0, nil, "ended"})); p["completed"] != true {
		t.Fatalf("ended %v", p)
	}

	// Episode tail is 90 s.
	series, eps := insertSeries(t, w.env, "Show")
	ep := map[string]any{"profile_id": w.pid, "media_id": series, "episode_id": eps["S1E1"]}
	if p := progressOf(play(ep, [3]any{880.0, 1000, "paused"})); p["completed"] != false || num(p["season_number"]) != 1 || num(p["episode_number"]) != 1 {
		t.Fatalf("episode 120 s left %v", p)
	}
	if p := progressOf(play(ep, [3]any{915.0, 1000, "paused"})); p["completed"] != true {
		t.Fatalf("episode 85 s left %v", p)
	}
	// Series need episode_id; movies refuse one.
	c.Do("POST", "/api/v1/playback/sessions", map[string]any{"profile_id": w.pid, "media_id": series}).Expect(422)
	c.Do("POST", "/api/v1/playback/sessions", map[string]any{"profile_id": w.pid, "media_id": movie("E")["media_id"], "episode_id": eps["S1E1"]}).Expect(422)

	// Re-watch: completed stays true, a new resume point is tracked.
	m := movie("F")
	play(m, [3]any{5800.0, 6000, "ended"})
	s := startSession(t, c, m)
	if s["resume_position_seconds"] != nil || progressOf(s)["completed"] != true {
		t.Fatalf("completed item should start over: %v", s)
	}
	if p := progressOf(report(t, c, s["id"].(string), 0, 300, 6000, "paused")); p["completed"] != true || num(p["position_seconds"]) != 300 {
		t.Fatalf("rewatch %v", p)
	}
	if r := startSession(t, c, m); num(r["resume_position_seconds"]) != 300 {
		t.Fatalf("rewatch resume %v", r)
	}
}

func TestWatchManualOverridesAndNextUp(t *testing.T) {
	w := newWatchEnv(t)
	c := w.alice
	movie := insertMovie(t, w.env, "Alien")
	set := func(media string, body map[string]any) map[string]any {
		t.Helper()
		body["profile_id"] = w.pid
		return c.Do("PUT", "/api/v1/media/"+media+"/watched", body).Expect(200).JSON()
	}
	mp := set(movie, map[string]any{"watched": true})
	if m := mp["movie"].(map[string]any); m["completed"] != true || num(m["percent"]) != 1 {
		t.Fatalf("movie watched %v", mp)
	}
	var manual bool
	_ = w.env.Pool.QueryRow(context.Background(), `SELECT manual FROM watch_progress WHERE media_id = $1`, movie).Scan(&manual)
	if !manual {
		t.Fatal("manual flag")
	}
	if mp := set(movie, map[string]any{"watched": false}); mp["movie"] != nil {
		t.Fatalf("unwatched %v", mp)
	}
	c.Do("PUT", "/api/v1/media/"+movie+"/watched", map[string]any{"profile_id": w.pid, "watched": true, "season_number": 1}).Expect(422)

	series, eps := insertSeries(t, w.env, "Lost")
	// Nothing started → no next_up.
	if mp := c.Do("GET", "/api/v1/media/"+series+"/progress?profile_id="+w.pid, nil).Expect(200).JSON(); mp["next_up"] != nil || mp["kind"] != "series" {
		t.Fatalf("fresh series %v", mp)
	}
	c.Do("PUT", "/api/v1/media/"+series+"/watched", map[string]any{"profile_id": w.pid, "watched": true}).Expect(422)

	// Whole season 1 → next up rolls into season 2.
	mp = set(series, map[string]any{"watched": true, "season_number": 1})
	nu := mp["next_up"].(map[string]any)
	if nu["episode_id"] != eps["S2E1"] || num(nu["season_number"]) != 2 || nu["name"] != "Episode 2.1" {
		t.Fatalf("next up %v", nu)
	}
	if len(mp["episodes"].([]any)) != 3 {
		t.Fatalf("episodes %v", mp["episodes"])
	}
	seasons := map[float64][2]float64{}
	for _, s := range mp["seasons"].([]any) {
		m := s.(map[string]any)
		seasons[num(m["season_number"])] = [2]float64{num(m["completed"]), num(m["total"])}
	}
	if seasons[1] != [2]float64{3, 3} || seasons[2] != [2]float64{0, 2} || seasons[0] != [2]float64{0, 1} {
		t.Fatalf("season counts %v", seasons)
	}

	// Watch S2E1 partially: next up is that in-progress episode.
	sid := startSession(t, c, map[string]any{"profile_id": w.pid, "media_id": series, "episode_id": eps["S2E1"]})["id"].(string)
	report(t, c, sid, 0, 400, 2400, "paused")
	if nu := c.Do("GET", "/api/v1/media/"+series+"/progress?profile_id="+w.pid, nil).JSON()["next_up"].(map[string]any); nu["episode_id"] != eps["S2E1"] {
		t.Fatalf("in-progress next up %v", nu)
	}
	// Finish S2E1 and S2E2 → S2E3 hasn't aired: nothing next.
	report(t, c, sid, 1, 2390, 2400, "ended")
	mp = set(series, map[string]any{"watched": true, "episode_id": eps["S2E2"]})
	if mp["next_up"] != nil {
		t.Fatalf("caught up but next_up %v", mp["next_up"])
	}
	// Unwatching a season deletes its rows.
	mp = set(series, map[string]any{"watched": false, "season_number": 1})
	if len(mp["episodes"].([]any)) != 2 {
		t.Fatalf("after unwatching season 1: %v", mp["episodes"])
	}
	// Manual episode selection of a wrong episode is rejected.
	other, oeps := insertSeries(t, w.env, "Other")
	_ = other
	c.Do("PUT", "/api/v1/media/"+series+"/watched", map[string]any{"profile_id": w.pid, "watched": true, "episode_id": oeps["S1E1"]}).Expect(422)
}

func TestWatchContinueWatchingAndHistory(t *testing.T) {
	w := newWatchEnv(t)
	c := w.alice
	m1, m2, done := insertMovie(t, w.env, "One"), insertMovie(t, w.env, "Two"), insertMovie(t, w.env, "Done")
	series, eps := insertSeries(t, w.env, "Serial")
	watch := func(body map[string]any, pos, dur float64, state string) {
		t.Helper()
		sid := startSession(t, c, body)["id"].(string)
		report(t, c, sid, 0, pos, dur, state)
	}
	watch(map[string]any{"profile_id": w.pid, "media_id": m1}, 600, 6000, "stopped")
	watch(map[string]any{"profile_id": w.pid, "media_id": done}, 5990, 6000, "ended")
	watch(map[string]any{"profile_id": w.pid, "media_id": series, "episode_id": eps["S1E1"]}, 2390, 2400, "ended")
	watch(map[string]any{"profile_id": w.pid, "media_id": m2}, 900, 6000, "paused")

	items := c.Do("GET", "/api/v1/profiles/"+w.pid+"/continue-watching", nil).Expect(200).Items()
	var got []string
	for _, it := range items {
		got = append(got, it["media"].(map[string]any)["id"].(string))
	}
	if fmt.Sprint(got) != fmt.Sprint([]string{m2, series, m1}) {
		t.Fatalf("continue watching order %v (want %v)", got, []string{m2, series, m1})
	}
	if items[1]["progress"] != nil || items[1]["next_up"].(map[string]any)["episode_id"] != eps["S1E2"] {
		t.Fatalf("series item %v", items[1])
	}
	if num(items[0]["progress"].(map[string]any)["position_seconds"]) != 900 || items[0]["media"].(map[string]any)["title"] != "Two" {
		t.Fatalf("movie item %v", items[0])
	}
	if me := items[0]["media"].(map[string]any)["me"].(map[string]any); me["completed"] != false {
		t.Fatalf("me %v", me)
	}

	// History: newest first with cursor pagination.
	h1 := c.Do("GET", "/api/v1/profiles/"+w.pid+"/history?limit=3", nil).Expect(200).JSON()
	if len(h1["items"].([]any)) != 3 || h1["next_cursor"] == nil {
		t.Fatalf("history page 1 %v", h1)
	}
	h2 := c.Do("GET", "/api/v1/profiles/"+w.pid+"/history?limit=3&cursor="+h1["next_cursor"].(string), nil).Expect(200).JSON()
	if len(h2["items"].([]any)) != 1 || h2["next_cursor"] != nil {
		t.Fatalf("history page 2 %v", h2)
	}
	if h2["items"].([]any)[0].(map[string]any)["media"].(map[string]any)["id"] != m1 {
		t.Fatalf("oldest %v", h2)
	}
	c.Do("GET", "/api/v1/profiles/"+w.pid+"/history?cursor=garbage!", nil).Expect(422)
}

func TestWatchListsRatingsAndSettings(t *testing.T) {
	w := newWatchEnv(t)
	c := w.alice
	m1, m2 := insertMovie(t, w.env, "First"), insertMovie(t, w.env, "Second")
	base := "/api/v1/profiles/" + w.pid
	for range 2 { // idempotent
		c.Do("PUT", base+"/lists/watchlist/"+m1, nil).Expect(204)
	}
	c.Do("PUT", base+"/lists/watchlist/"+m2, nil).Expect(204)
	c.Do("PUT", base+"/lists/favorites/"+m2, nil).Expect(204)
	c.Do("PUT", base+"/lists/bogus/"+m2, nil).Expect(404)
	c.Do("PUT", base+"/lists/watchlist/00000000-0000-0000-0000-000000000000", nil).Expect(404)
	page := c.Do("GET", base+"/lists/watchlist", nil).Expect(200).JSON()
	items := itemsOf(page)
	if len(items) != 2 || num(page["total_results"]) != 2 || num(page["total_pages"]) != 1 ||
		items[0].(map[string]any)["id"] != m2 {
		t.Fatalf("watchlist %v", page)
	}
	if me := items[0].(map[string]any)["me"].(map[string]any); me["in_watchlist"] != true || me["favorite"] != true || me["rating"] != nil {
		t.Fatalf("me %v", me)
	}
	for range 2 {
		c.Do("DELETE", base+"/lists/watchlist/"+m1, nil).Expect(204)
	}
	if n := len(itemsOf(c.Do("GET", base+"/lists/watchlist", nil).JSON())); n != 1 {
		t.Fatalf("after delete %d", n)
	}

	c.Do("PUT", base+"/ratings/"+m1, map[string]any{"rating": 8}).Expect(204)
	c.Do("PUT", base+"/ratings/"+m1, map[string]any{"rating": 9}).Expect(204)
	c.Do("PUT", base+"/ratings/"+m1, map[string]any{"rating": 11}).Expect(422)
	c.Do("PUT", base+"/ratings/"+m1, map[string]any{"rating": 7.5}).Expect(422)
	var r int
	_ = w.env.Pool.QueryRow(context.Background(), `SELECT rating FROM ratings WHERE media_id = $1`, m1).Scan(&r)
	if r != 9 {
		t.Fatalf("rating %d", r)
	}
	for range 2 {
		c.Do("DELETE", base+"/ratings/"+m1, nil).Expect(204)
	}

	// Settings: defaults, partial merge, validation.
	st := c.Do("GET", base+"/settings", nil).Expect(200).JSON()
	want := map[string]any{"theme": "system", "hide_anime": false, "hide_watched": false, "autoplay_next_episode": true, "skip_segments": "button", "autoplay_countdown": true, "video_autoplay": true,
		"spoiler_free_episodes": false, "loading_style": "popcorn", "onboarding_completed": false, "design": "kinozal", "poster_rating": "kp"}
	for k, v := range want {
		if st[k] != v {
			t.Fatalf("default %s = %v", k, st[k])
		}
	}
	st = c.Do("PUT", base+"/settings", map[string]any{"theme": "dark", "hide_anime": true}).Expect(200).JSON()
	st = c.Do("PUT", base+"/settings", map[string]any{"loading_style": "film_reel", "onboarding_completed": true, "design": "terminal", "poster_rating": "imdb"}).Expect(200).JSON()
	if st["theme"] != "dark" || st["hide_anime"] != true || st["loading_style"] != "film_reel" || st["autoplay_next_episode"] != true ||
		st["onboarding_completed"] != true || st["design"] != "terminal" || st["poster_rating"] != "imdb" {
		t.Fatalf("merged %v", st)
	}
	res := c.Do("PUT", base+"/settings", map[string]any{"theme": "neon", "loading_style": "x", "design": "retro", "poster_rating": "rt"}).Expect(422).JSON()
	if f := res["error"].(map[string]any)["fields"].(map[string]any); f["theme"] == nil || f["loading_style"] == nil || f["design"] == nil || f["poster_rating"] == nil {
		t.Fatalf("fields %v", f)
	}
	// A TV may change settings of a profile it can use.
	_, cred := w.env.Pair(c, "TV")
	deviceClient(w.env, cred).Do("PUT", base+"/settings", map[string]any{"theme": "light"}).Expect(200)
}

func TestWatchProfileAuthorization(t *testing.T) {
	w := newWatchEnv(t)
	movie := insertMovie(t, w.env, "Secret")
	bob, _ := w.env.NewUserClient("bob", "user")
	bobPid := newProfile(t, bob, "Bob")
	base := "/api/v1/profiles/" + w.pid

	for _, r := range []struct{ method, path string }{
		{"GET", base + "/settings"}, {"PUT", base + "/settings"}, {"GET", base + "/continue-watching"},
		{"GET", base + "/history"}, {"GET", base + "/lists/watchlist"}, {"PUT", base + "/lists/favorites/" + movie},
		{"DELETE", base + "/lists/favorites/" + movie}, {"PUT", base + "/ratings/" + movie}, {"DELETE", base + "/ratings/" + movie},
		{"GET", "/api/v1/media/" + movie + "/progress?profile_id=" + w.pid},
	} {
		var body any
		if r.method == "PUT" {
			body = map[string]any{"rating": 5}
		}
		bob.Do(r.method, r.path, body).Expect(404)
	}
	bob.Do("POST", "/api/v1/playback/sessions", map[string]any{"profile_id": w.pid, "media_id": movie}).Expect(404)
	bob.Do("PUT", "/api/v1/media/"+movie+"/watched", map[string]any{"profile_id": w.pid, "watched": true}).Expect(404)

	// A session can only be reported by its creator.
	sid := startSession(t, w.alice, map[string]any{"profile_id": w.pid, "media_id": movie})["id"].(string)
	bob.Do("POST", "/api/v1/playback/sessions/"+sid+"/progress", map[string]any{"seq": 1, "position_seconds": 50, "state": "playing"}).Expect(404)
	w.env.Client().Do("POST", "/api/v1/playback/sessions/"+sid+"/progress", map[string]any{"seq": 1, "position_seconds": 50, "state": "playing"}).Expect(401)

	// Devices: alice's TV may use alice's profiles, not bob's.
	_, cred := w.env.Pair(w.alice, "TV")
	tv := deviceClient(w.env, cred)
	tv.Do("GET", base+"/continue-watching", nil).Expect(200)
	tv.Do("GET", "/api/v1/profiles/"+bobPid+"/continue-watching", nil).Expect(404)
	tv.Do("POST", "/api/v1/playback/sessions", map[string]any{"profile_id": bobPid, "media_id": movie}).Expect(404)

	// Read-only API tokens can read but not write.
	tok := w.alice.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "ro", "scopes": []string{"read"}}).Expect(201).JSON()
	ro := w.env.Client()
	ro.Bearer = tok["secret"].(string)
	ro.Do("GET", base+"/settings", nil).Expect(200)
	ro.Do("PUT", base+"/lists/watchlist/"+movie, nil).Expect(403)
}

// navigator.sendBeacon: text/plain body, no headers, authenticated by ?token=.
func TestWatchBeaconReport(t *testing.T) {
	w := newWatchEnv(t)
	movie := insertMovie(t, w.env, "Beacon")
	s := startSession(t, w.alice, map[string]any{"profile_id": w.pid, "media_id": movie})
	sid, token := s["id"].(string), s["report_token"].(string)

	beacon := func(tok, origin string, cookie bool, body string) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequest("POST", w.env.BaseURL+"/api/v1/playback/sessions/"+sid+"/progress?token="+tok, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if cookie {
			req.Header.Set("Cookie", "mt_session="+w.alice.SessionCookie())
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		return res.StatusCode, m
	}
	// From a TV app (no cookie, any origin).
	code, r := beacon(token, "http://tv.local", false, `{"seq":1,"position_seconds":321,"duration_seconds":6000,"state":"stopped"}`)
	if code != 200 || r["accepted"] != true {
		t.Fatalf("beacon %d %v", code, r)
	}
	// From the PWA (cookie but no CSRF header): the token is what counts.
	code, r = beacon(token, w.env.Origin, true, `{"seq":2,"position_seconds":330,"duration_seconds":6000,"state":"stopped"}`)
	if code != 200 || r["accepted"] != true {
		t.Fatalf("pwa beacon %d %v", code, r)
	}
	if code, _ = beacon(tamper(token), "", false, `{"seq":3,"position_seconds":340,"state":"stopped"}`); code != 401 {
		t.Fatalf("bad token %d", code)
	}
	// Without a token, a cookie-authenticated text/plain POST still needs CSRF.
	if code, _ = beacon("", w.env.Origin, true, `{"seq":3,"position_seconds":340,"state":"stopped"}`); code != 403 {
		t.Fatalf("csrf-less cookie report %d", code)
	}
	if p := w.alice.Do("GET", "/api/v1/media/"+movie+"/progress?profile_id="+w.pid, nil).JSON()["movie"].(map[string]any); num(p["position_seconds"]) != 330 {
		t.Fatalf("progress %v", p)
	}
}

// tamper flips the token's last character (part of the MAC).
func tamper(tok string) string {
	last := byte('A')
	if tok[len(tok)-1] == 'A' {
		last = 'B'
	}
	return tok[:len(tok)-1] + string(last)
}
