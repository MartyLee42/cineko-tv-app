package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"martytv/api/internal/config"
)

// personalizedCatalogEnv wraps the catalog mock: /movie/top_rated also
// returns a Japanese animation (anime), a Japanese live-action film and a
// western animation.
func personalizedCatalogEnv(t *testing.T) *watchEnv {
	t.Helper()
	m := newMockTMDB(t)
	wrap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/movie/top_rated" {
			m.serve(w, r)
			return
		}
		item := func(id int, title, lang string, genres []int) map[string]any {
			return map[string]any{"id": id, "title": title, "original_title": title, "original_language": lang,
				"overview": "", "poster_path": nil, "release_date": "2001-07-20", "vote_average": 8, "vote_count": 100,
				"popularity": 1.0, "genre_ids": genres}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(page(movieItem(false, "Alpha"),
			item(201, "Spirited", "ja", []int{16, 14}), item(202, "Drive My Car", "ja", []int{18}), item(203, "Shrek", "en", []int{16, 35})))
	}))
	t.Cleanup(wrap.Close)
	dir := t.TempDir()
	return newWatchEnv(t, func(c *config.Config) {
		c.TMDB.BaseURL = wrap.URL
		c.TMDB.AccessToken = "test-token"
		c.TMDB.ImageBaseURL = m.srv.URL + "/img"
		c.Catalog.ImageCacheDir = dir
	})
}

func tmdbIDs(items []any) []int {
	var out []int
	for _, it := range items {
		out = append(out, int(it.(map[string]any)["tmdb_id"].(float64)))
	}
	return out
}

func TestCatalogProfileFiltersAndAnnotations(t *testing.T) {
	w := personalizedCatalogEnv(t)
	c := w.alice
	list := "/api/v1/catalog/lists/top_rated?kind=movie"
	withProfile := list + "&profile_id=" + w.pid

	plain := c.Do("GET", list, nil).Expect(200).JSON()
	if ids := tmdbIDs(itemsOf(plain)); len(ids) != 4 {
		t.Fatalf("unfiltered %v", ids)
	}
	if _, ok := itemsOf(plain)[0].(map[string]any)["me"]; ok {
		t.Fatal("me without profile_id")
	}
	res := c.Do("GET", withProfile, nil).Expect(200).JSON()
	alpha := findItem(t, itemsOf(res), "movie", 100)
	if me := alpha["me"].(map[string]any); me["completed"] != false || me["progress_percent"] != nil || me["in_watchlist"] != false {
		t.Fatalf("me %v", me)
	}
	if len(itemsOf(res)) != 4 {
		t.Fatal("hide_anime defaults to off")
	}

	// hide_anime: only genre 16 AND original language ja disappears.
	c.Do("PUT", "/api/v1/profiles/"+w.pid+"/settings", map[string]any{"hide_anime": true}).Expect(200)
	if ids := tmdbIDs(itemsOf(c.Do("GET", withProfile, nil).Expect(200).JSON())); len(ids) != 3 || ids[0] != 100 || ids[1] != 202 || ids[2] != 203 {
		t.Fatalf("hide_anime %v", ids)
	}

	// hide_watched: param, then setting, and the param overrides the setting.
	alphaID := alpha["id"].(string)
	c.Do("PUT", "/api/v1/media/"+alphaID+"/watched", map[string]any{"profile_id": w.pid, "watched": true}).Expect(200)
	c.Do("PUT", "/api/v1/profiles/"+w.pid+"/ratings/"+alphaID, map[string]any{"rating": 7}).Expect(204)
	c.Do("PUT", "/api/v1/profiles/"+w.pid+"/lists/watchlist/"+alphaID, nil).Expect(204)
	if ids := tmdbIDs(itemsOf(c.Do("GET", withProfile+"&hide_watched=true", nil).Expect(200).JSON())); len(ids) != 2 {
		t.Fatalf("hide_watched param %v", ids)
	}
	c.Do("PUT", "/api/v1/profiles/"+w.pid+"/settings", map[string]any{"hide_watched": true}).Expect(200)
	if ids := tmdbIDs(itemsOf(c.Do("GET", withProfile, nil).Expect(200).JSON())); len(ids) != 2 {
		t.Fatalf("hide_watched setting %v", ids)
	}
	shown := c.Do("GET", withProfile+"&hide_watched=false", nil).Expect(200).JSON()
	if me := findItem(t, itemsOf(shown), "movie", 100)["me"].(map[string]any); me["completed"] != true || me["rating"].(float64) != 7 ||
		me["in_watchlist"] != true || me["progress_percent"].(float64) != 1 {
		t.Fatalf("annotated %v", me)
	}
	// Cached TMDB body is unaffected: another user's unpersonalized view.
	bob, _ := w.env.NewUserClient("bob", "user")
	if ids := tmdbIDs(itemsOf(bob.Do("GET", list, nil).Expect(200).JSON())); len(ids) != 4 {
		t.Fatalf("cache polluted %v", ids)
	}

	// Home: the setting applies; every item carries me.
	home := c.Do("GET", "/api/v1/catalog/home?profile_id="+w.pid, nil).Expect(200).JSON()
	for _, r := range home["rows"].([]any) {
		row := r.(map[string]any)
		for _, it := range itemsOf(row) {
			m := it.(map[string]any)
			if m["me"] == nil {
				t.Fatalf("home item without me %v", m)
			}
			if row["key"] == "top_rated_movies" && (m["tmdb_id"].(float64) == 100 || m["tmdb_id"].(float64) == 201) {
				t.Fatalf("home not filtered %v", m)
			}
		}
	}
	// Search never hides watched titles.
	search := c.Do("GET", "/api/v1/catalog/search?q=alpha&profile_id="+w.pid, nil).Expect(200).JSON()
	if findItem(t, itemsOf(search), "movie", 100)["me"].(map[string]any)["completed"] != true {
		t.Fatal("search")
	}
	// Detail: annotated, never filtered.
	d := c.Do("GET", "/api/v1/media/"+alphaID+"?profile_id="+w.pid, nil).Expect(200).JSON()
	if me := d["me"].(map[string]any); me["completed"] != true || me["rating"].(float64) != 7 {
		t.Fatalf("detail me %v", d["me"])
	}
	if _, ok := c.Do("GET", "/api/v1/media/"+alphaID, nil).Expect(200).JSON()["me"]; ok {
		t.Fatal("detail me without profile")
	}
	// Similar/recommendations keep watched titles (marked), even with hide_watched.
	for _, q := range []string{"", "&hide_watched=true"} {
		items := itemsOf(c.Do("GET", "/api/v1/media/"+alphaID+"/similar?profile_id="+w.pid+q, nil).Expect(200).JSON())
		marked := false
		for _, it := range items {
			if me, ok := it.(map[string]any)["me"].(map[string]any); ok && me["completed"] == true {
				marked = true
			}
		}
		if !marked {
			t.Fatalf("similar%s: watched title missing or unmarked %v", q, items)
		}
	}

	// Validation and authorization.
	c.Do("GET", list+"&profile_id=nope", nil).Expect(422)
	c.Do("GET", withProfile+"&hide_watched=maybe", nil).Expect(422)
	bob.Do("GET", withProfile, nil).Expect(404)
	bob.Do("GET", "/api/v1/media/"+alphaID+"?profile_id="+w.pid, nil).Expect(404)
	_, cred := w.env.Pair(c, "TV")
	deviceClient(w.env, cred).Do("GET", withProfile, nil).Expect(200)

	// A fully watched series: marking season 1 loads it lazily from TMDB
	// (episode 2 has no air date, so only episode 1 counts).
	series := findItem(t, itemsOf(c.Do("GET", "/api/v1/catalog/lists/popular?kind=series&profile_id="+w.pid+"&hide_watched=false", nil).Expect(200).JSON()), "series", 100)
	c.Do("GET", "/api/v1/media/"+series["id"].(string), nil).Expect(200) // seasons
	mp := c.Do("PUT", "/api/v1/media/"+series["id"].(string)+"/watched", map[string]any{"profile_id": w.pid, "watched": true, "season_number": 1}).Expect(200).JSON()
	if len(mp["episodes"].([]any)) != 1 {
		t.Fatalf("season mark %v", mp)
	}
	if items := itemsOf(c.Do("GET", "/api/v1/catalog/lists/popular?kind=series&profile_id="+w.pid, nil).Expect(200).JSON()); len(items) != 0 {
		t.Fatalf("watched series shown %v", items)
	}
	seriesMe := findItem(t, itemsOf(c.Do("GET", "/api/v1/catalog/lists/popular?kind=series&profile_id="+w.pid+"&hide_watched=0", nil).Expect(200).JSON()), "series", 100)["me"].(map[string]any)
	if seriesMe["completed"] != true || seriesMe["progress_percent"].(float64) != 1 {
		t.Fatalf("series me %v", seriesMe)
	}
	c.Do("PUT", "/api/v1/media/"+series["id"].(string)+"/watched", map[string]any{"profile_id": w.pid, "watched": true, "season_number": 7}).Expect(404)
}
