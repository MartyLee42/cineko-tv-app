package server_test

import (
	"context"
	"testing"
)

// The nightly learner end to end: impressions logged through the API carry
// their attribution; opens + real plays from one row raise that row's
// source, ignored sources go down (one bounded step per night); the admin
// sees the table, can reset it and switch learning off; the quality report
// counts the funnel and ratings.
func TestForYouLearnedWeights(t *testing.T) {
	f := newFyEnv(t)
	ctx := context.Background()
	pool := f.env.Pool
	a := f.sciFiProfile(t, f.alice, "Sci")

	_, rows := f.rowItems(rowsOf(t, f.alice, a))
	// The liked row: the first specific row with enough items.
	var liked map[string]any
	for _, r := range rows {
		if k := r["kind"]; k != "top_picks" && len(r["items"].([]any)) >= 4 {
			liked = r
			break
		}
	}
	if liked == nil {
		t.Fatalf("no specific row: %v", rows)
	}
	learnKey := map[string]string{"director": "director", "actor": "actor", "because_you_rated": "because_you_rated", "hidden_gems": "hidden_gem",
		"genre": "genre", "something_different": "something_different", "trending": "trending", "theme": "theme"}[liked["kind"].(string)]
	if learnKey == "" {
		t.Fatalf("row kind %v", liked["kind"])
	}
	var events []map[string]any
	var likedIDs []string
	for _, r := range rows {
		for _, it := range r["items"].([]any) {
			id := it.(map[string]any)["media"].(map[string]any)["id"].(string)
			events = append(events, map[string]any{"media_id": id, "action": "impression", "row_id": r["id"]})
			if r["id"] == liked["id"] {
				likedIDs = append(likedIDs, id)
				events = append(events, map[string]any{"media_id": id, "action": "open", "row_id": r["id"]})
			}
		}
	}
	for i := 0; i < len(events); i += 100 {
		f.alice.Do("POST", "/api/v1/foryou/feedback", map[string]any{"profile_id": a, "events": events[i:min(i+100, len(events))]}).Expect(202)
	}
	// Attribution was stored at log time.
	var withSrc, total int
	if err := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE sources IS NOT NULL AND row_pos IS NOT NULL AND score IS NOT NULL), count(*)
		FROM foryou_feedback WHERE profile_id = $1 AND action = 'impression'`, a).Scan(&withSrc, &total); err != nil || withSrc != total || total == 0 {
		t.Fatalf("attribution %d/%d %v", withSrc, total, err)
	}
	// Four weeks of the same behaviour, and real plays (≥ 10 min) of the
	// liked row each day.
	for d := 1; d <= 27; d++ {
		if _, err := pool.Exec(ctx, `INSERT INTO foryou_feedback (profile_id, media_id, action, row_id, sources, row_pos, item_pos, score, created_at)
			SELECT profile_id, media_id, action, row_id, sources, row_pos, item_pos, score, created_at - make_interval(days => $2)
			FROM foryou_feedback WHERE profile_id = $1 AND created_at > now() - interval '1 hour'`, a, d); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO playback_sessions (profile_id, user_id, media_id, started_at, last_position, last_duration)
		SELECT $1, p.user_id, m::uuid, now() - make_interval(days => d), 900, 7200
		FROM profiles p, unnest($2::text[]) AS m, generate_series(0, 27) AS d WHERE p.id = $1`, a, likedIDs); err != nil {
		t.Fatal(err)
	}

	// Users can't see or reset the table.
	f.alice.Do("GET", "/api/v1/admin/foryou/weights", nil).Expect(403)
	f.alice.Do("GET", "/api/v1/admin/foryou/quality", nil).Expect(403)

	run := f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "profile", "id": a, "ai": false}).Expect(202).JSON()
	if done := waitRun(t, f.admin, run["run_id"].(string)); done["status"] != "completed" || len(done["errors"].([]any)) != 0 {
		t.Fatalf("run %v", done)
	}
	weights := func() map[string]map[string]any {
		res := f.admin.Do("GET", "/api/v1/admin/foryou/weights", nil).Expect(200).JSON()
		if res["enabled"] != true || len(res["sources"].([]any)) < 10 {
			t.Fatalf("weights meta %v", res)
		}
		out := map[string]map[string]any{}
		for _, p := range res["items"].([]any) {
			pw := p.(map[string]any)
			if pw["profile_id"] != a {
				continue
			}
			if pw["name"] != "Sci" {
				t.Fatalf("profile %v", pw)
			}
			for _, it := range pw["items"].([]any) {
				m := it.(map[string]any)
				out[m["source"].(string)] = m
			}
		}
		return out
	}
	w := weights()
	up := w[learnKey]
	if up == nil || num(up["weight"]) != 1.15 || num(up["prev_weight"]) != 1 || num(up["target"]) <= 1 || num(up["plays"]) < 10 || num(up["impressions"]) < 30 {
		t.Fatalf("liked source %s: %v (all %v)", learnKey, up, w)
	}
	down := 0
	for k, v := range w {
		if k != learnKey && num(v["weight"]) < 1 {
			if num(v["weight"]) != 0.85 {
				t.Fatalf("step limit %s %v", k, v)
			}
			down++
		}
	}
	if down == 0 {
		t.Fatalf("nothing went down: %v", w)
	}
	// A second run the same day takes no second step.
	run = f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "profile", "id": a, "ai": false}).Expect(202).JSON()
	waitRun(t, f.admin, run["run_id"].(string))
	if w2 := weights(); num(w2[learnKey]["weight"]) != 1.15 {
		t.Fatalf("second step %v", w2[learnKey])
	}

	// The switch: reported and stored.
	f.admin.Do("PUT", "/api/v1/admin/foryou/ai", map[string]any{"learn_weights": false}).Expect(200)
	if res := f.admin.Do("GET", "/api/v1/admin/foryou/runs", nil).Expect(200).JSON(); res["ai"].(map[string]any)["learn_weights"] != false {
		t.Fatalf("switch %v", res["ai"])
	}
	f.admin.Do("PUT", "/api/v1/admin/foryou/ai", map[string]any{"learn_weights": true}).Expect(200)

	// Quality: the played titles, one rated high.
	f.rate(t, f.alice, a, f.tmdbOf(likedIDs[0]), 9)
	q := f.admin.Do("GET", "/api/v1/admin/foryou/quality?window=30&lang=en", nil).Expect(200).JSON()
	f.admin.Do("GET", "/api/v1/admin/foryou/quality?window=7", nil).Expect(422)
	var stats map[string]any
	for _, p := range q["profiles"].([]any) {
		if p.(map[string]any)["profile_id"] == a {
			stats = p.(map[string]any)["stats"].(map[string]any)
		}
	}
	if stats == nil {
		t.Fatalf("quality %v", q)
	}
	fn := stats["funnel"].(map[string]any)
	if num(fn["shown"]) < float64(len(likedIDs)) || num(fn["played"]) != float64(len(likedIDs)) || num(fn["rated"]) != 1 || num(fn["liked"]) != 1 {
		t.Fatalf("funnel %v", fn)
	}
	hits := stats["hits"].([]any)
	if len(hits) != 1 || hits[0].(map[string]any)["media_id"] != likedIDs[0] || hits[0].(map[string]any)["title"] == "" {
		t.Fatalf("hits %v", hits)
	}
	if hh := q["household"].(map[string]any)["funnel"].(map[string]any); num(hh["shown"]) < num(fn["shown"]) {
		t.Fatalf("household %v", hh)
	}

	// Reset: gone, rows rebuild from the defaults.
	f.admin.Do("DELETE", "/api/v1/admin/foryou/weights/"+a, nil).Expect(204)
	f.admin.Do("DELETE", "/api/v1/admin/foryou/weights/"+a, nil).Expect(404)
	if w := weights(); len(w) != 0 {
		t.Fatalf("after reset %v", w)
	}
	f.env.Server.ForYou.Wait()
}
