package server_test

import (
	"slices"
	"strings"
	"testing"
)

// «Cineko TV»: GET /profiles/{id}/channel builds a programme on request.
func TestForYouChannel(t *testing.T) {
	f := newFyEnv(t)
	a := f.sciFiProfile(t, f.alice, "Sci")
	f.env.Server.ForYou.SetRand(func() float64 { return 0 })
	get := func(q string) map[string]any {
		t.Helper()
		return f.alice.Do("GET", "/api/v1/profiles/"+a+"/channel?lang=en"+q, nil).Expect(200).JSON()
	}
	items := func(r map[string]any) []map[string]any {
		var out []map[string]any
		for _, it := range r["items"].([]any) {
			out = append(out, it.(map[string]any))
		}
		return out
	}
	media := func(it map[string]any) map[string]any { return it["media"].(map[string]any) }

	r := items(get("&count=6"))
	if len(r) != 6 {
		t.Fatalf("programme %v", r)
	}
	rated := []int{1, 2, 3, 4, 5, 9, 10, 21}
	firstGenres := map[int]bool{}
	var ids []string
	for i, it := range r {
		m := media(it)
		if slices.Contains(rated, f.tmdbOf(m["id"].(string))) {
			t.Fatalf("rated title on the channel: %v", m)
		}
		if m["kind"] != "movie" || it["source"] != "foryou" || it["episode"] != nil || num(it["runtime_minutes"]) <= 0 || it["reason"] == nil {
			t.Fatalf("item %v", it)
		}
		g := toInts(m["genre_ids"])
		if len(g) > 0 {
			firstGenres[g[0]] = true
		}
		if i > 0 {
			pg := toInts(media(r[i-1])["genre_ids"])
			if len(g) > 0 && len(pg) > 0 && g[0] == pg[0] && slices.Equal(g, pg) {
				t.Fatalf("same genres twice in a row at %d: %v / %v", i, g, pg)
			}
		}
		ids = append(ids, m["id"].(string))
	}
	if len(firstGenres) < 2 {
		t.Fatalf("no variety: %v", firstGenres)
	}

	// exclude: what is already on the programme doesn't come back.
	more := items(get("&count=6&exclude=" + strings.Join(ids, ",")))
	for _, it := range more {
		if slices.Contains(ids, media(it)["id"].(string)) {
			t.Fatalf("excluded title again: %v", it)
		}
	}

	// «Не то»: a dismissal (feedback from the channel) drops the title.
	f.alice.Do("POST", "/api/v1/foryou/feedback", map[string]any{"profile_id": a, "events": []map[string]any{
		{"media_id": ids[0], "action": "play", "row_id": "channel"},
		{"media_id": ids[0], "action": "dismiss", "row_id": "channel"},
	}}).Expect(202)
	for _, it := range items(get("&count=20")) {
		if media(it)["id"] == ids[0] {
			t.Fatal("dismissed title still on the channel")
		}
	}

	// hide_anime is respected.
	f.alice.Do("PUT", "/api/v1/profiles/"+a+"/settings", map[string]any{"hide_anime": true}).Expect(200)
	for _, it := range items(get("&count=20")) {
		if id := f.tmdbOf(media(it)["id"].(string)); id >= 61 && id <= 63 {
			t.Fatalf("anime with hide_anime: %d", id)
		}
	}

	// A series in progress: its next episode joins the programme.
	series, eps := insertSeries(t, f.env, "Lost")
	f.alice.Do("PUT", "/api/v1/media/"+series+"/watched", map[string]any{"profile_id": a, "watched": true, "season_number": 1}).Expect(200)
	var ep map[string]any
	n := 0
	for _, it := range items(get("&count=8")) {
		if it["source"] == "continue" {
			n++
			if media(it)["id"] != series {
				t.Fatalf("continue item %v", it)
			}
			ep = it["episode"].(map[string]any)
		}
	}
	if n != 1 || ep["id"] != eps["S2E1"] || num(ep["season_number"]) != 2 || num(ep["episode_number"]) != 1 {
		t.Fatalf("series in progress: %d %v", n, ep)
	}

	// Validation and access.
	f.alice.Do("GET", "/api/v1/profiles/"+a+"/channel?count=0", nil).Expect(422)
	f.alice.Do("GET", "/api/v1/profiles/"+a+"/channel?count=21", nil).Expect(422)
	f.alice.Do("GET", "/api/v1/profiles/"+a+"/channel?exclude=nope", nil).Expect(422)
	bob, _ := f.env.NewUserClient("bob", "user")
	bob.Do("GET", "/api/v1/profiles/"+a+"/channel", nil).Expect(404)
	f.env.Client().Do("GET", "/api/v1/profiles/"+a+"/channel", nil).Expect(401)
	f.env.Server.ForYou.Wait()
}
