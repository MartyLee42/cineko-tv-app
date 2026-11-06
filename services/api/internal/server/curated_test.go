package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"testing"

	"martytv/api/internal/config"
	"martytv/api/internal/curated"
)

// «Подборки» (internal/curated): resolver (TMDB id, title + year fallback,
// ambiguity, retry window, changed entries), the API with watched counts,
// the daily Home row and the Explore section. TMDB is the foryou fake.

func intp(n int) *int { return &n }

func testLists() []curated.List {
	return []curated.List{
		{ID: "test-sf", Group: "thinkers", TitleRU: "Тест: фантастика", TitleEN: "Test SF", Author: "A. Critic", Source: "Book, 1990",
			DescriptionRU: "д", DescriptionEN: "d", Items: []curated.Item{
				{TMDBID: intp(91), Kind: "movie", Title: "Солярис", OriginalTitle: "Solaris", Year: 1972, NoteRU: "кристалл", NoteEN: "crystal"},
				{TMDBID: intp(92), Kind: "movie", Title: "Сталкер", OriginalTitle: "Stalker", Year: 1979},
				{TMDBID: intp(93), Kind: "movie", Title: "Луна", OriginalTitle: "Moon", Year: 2009},
				{TMDBID: intp(94), Kind: "movie", Title: "Primer", OriginalTitle: "Primer", Year: 2004},
				// A stale id (404) → found by title + year.
				{TMDBID: intp(99999), Kind: "movie", Title: "Гаттака", OriginalTitle: "Gattaca", Year: 1997},
				// An id whose year is far off (wrong film) → found by title + year.
				{TMDBID: intp(96), Kind: "movie", Title: "Контакт", OriginalTitle: "Contact", Year: 1997},
				// No id, two films with this title and year → ambiguous, not shown.
				{Kind: "movie", Title: "Twin Peril", OriginalTitle: "Twin Peril", Year: 2001},
			}},
		{ID: "test-drama", Group: "polls", TitleRU: "Тест: драмы", TitleEN: "Test dramas", Author: "Poll", Source: "Poll, 2000", Ordered: true,
			DescriptionRU: "д", DescriptionEN: "d", Items: []curated.Item{
				{TMDBID: intp(51), Kind: "movie", Title: "Quiet Drama 51", OriginalTitle: "Quiet Drama 51", Year: 1996},
				{TMDBID: intp(52), Kind: "movie", Title: "Quiet Drama 52", OriginalTitle: "Quiet Drama 52", Year: 1997},
				{TMDBID: intp(53), Kind: "movie", Title: "Quiet Drama 53", OriginalTitle: "Quiet Drama 53", Year: 1998},
				{TMDBID: intp(54), Kind: "movie", Title: "Quiet Drama 54", OriginalTitle: "Quiet Drama 54", Year: 1999},
				{TMDBID: intp(55), Kind: "movie", Title: "Quiet Drama 55", OriginalTitle: "Quiet Drama 55", Year: 2000},
				// A series by its TMDB id, with a published rank tied with position 5.
				{TMDBID: intp(777), Kind: "series", Title: "Родина", OriginalTitle: "Heimat", Year: 1984, Rank: intp(5)},
			}},
	}
}

// resolvedTMDB maps list positions to the TMDB ids they resolved to (0 = none).
func resolvedTMDB(t *testing.T, f *fyEnv, list string) map[int]int {
	t.Helper()
	rows, err := f.env.Pool.Query(context.Background(), `
		SELECT c.position, COALESCE(m.tmdb_id, 0) FROM curated_items c LEFT JOIN media m ON m.id = c.media_id WHERE c.list_id = $1`, list)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[int]int{}
	for rows.Next() {
		var pos, id int
		if err := rows.Scan(&pos, &id); err != nil {
			t.Fatal(err)
		}
		out[pos] = id
	}
	return out
}

func TestCuratedResolveAndAPI(t *testing.T) {
	// The foryou fake has no /tv/{id}: serve one series in front of it.
	f := newFyEnv(t, func(c *config.Config) {
		up, err := url.Parse(c.TMDB.BaseURL)
		if err != nil {
			t.Fatal(err)
		}
		proxy := httputil.NewSingleHostReverseProxy(up)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/tv/777" {
				proxy.ServeHTTP(w, r)
				return
			}
			name := "Heimat"
			if r.URL.Query().Get("language") == "ru-RU" {
				name = "Родина"
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 777, "name": name, "original_name": "Heimat", "original_language": "de",
				"first_air_date": "1984-09-16", "poster_path": "/heimat.jpg", "vote_average": 8.1, "vote_count": 90,
				"genres": []map[string]any{{"id": 18, "name": "Drama"}}})
		}))
		t.Cleanup(srv.Close)
		c.TMDB.BaseURL = srv.URL
	})
	ctx := context.Background()
	svc := f.env.Server.Curated
	svc.SetPace(1000)
	lists := testLists()
	svc.SetLists(lists)

	// ---- resolver ----
	st, err := svc.Resolve(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Checked != 13 || st.Resolved != 12 || st.Unresolved != 1 || st.Errors != 0 {
		t.Fatalf("first pass %+v", st)
	}
	got := resolvedTMDB(t, f, "test-sf")
	want := map[int]int{1: 91, 2: 92, 3: 93, 4: 94, 5: 95, 6: 97, 7: 0}
	for pos, id := range want {
		if got[pos] != id {
			t.Fatalf("position %d → %d, want %d (all %v)", pos, got[pos], id, got)
		}
	}
	// Nothing changed: nothing looked up again.
	if st, _ = svc.Resolve(ctx); st.Checked != 0 {
		t.Fatalf("second pass %+v", st)
	}
	// An unresolved entry is retried only after the retry window.
	if _, err := f.env.Pool.Exec(ctx, `UPDATE curated_items SET checked_at = now() - interval '8 days' WHERE list_id = 'test-sf' AND position = 7`); err != nil {
		t.Fatal(err)
	}
	if st, _ = svc.Resolve(ctx); st.Checked != 1 || st.Unresolved != 1 {
		t.Fatalf("retry pass %+v", st)
	}
	// A changed file entry is resolved again; the others are left alone.
	lists = testLists()
	lists[0].Items[2].Year = 2010
	svc.SetLists(lists)
	if st, _ = svc.Resolve(ctx); st.Checked != 1 || st.Resolved != 1 {
		t.Fatalf("changed entry pass %+v", st)
	}

	// ---- API ----
	pid := newProfile(t, f.alice, "Curator")
	solaris, stalker := f.ids[91], f.ids[92]
	if solaris == "" || stalker == "" {
		t.Fatal("fixture titles not materialized")
	}
	f.alice.Do("PUT", "/api/v1/media/"+solaris+"/watched", map[string]any{"profile_id": pid, "watched": true}).Expect(200)
	f.rate(t, f.alice, pid, 92, 8) // rated = watched

	ov := f.alice.Do("GET", "/api/v1/curated?lang=ru&profile_id="+pid, nil).Expect(200).JSON()
	groups := ov["groups"].([]any)
	if len(groups) != 2 || groups[0].(map[string]any)["id"] != "thinkers" || groups[1].(map[string]any)["id"] != "polls" {
		t.Fatalf("groups %v", groups)
	}
	g0 := groups[0].(map[string]any)
	if g0["title"] != "Мыслители и критики" {
		t.Fatalf("group title %v", g0["title"])
	}
	sf := g0["lists"].([]any)[0].(map[string]any)
	if sf["title"] != "Тест: фантастика" || num(sf["count"]) != 7 || num(sf["resolved"]) != 6 || num(sf["watched"]) != 2 {
		t.Fatalf("summary %v", sf)
	}
	if covers := sf["covers"].([]any); len(covers) != 4 || covers[0] != "/p91.jpg" {
		t.Fatalf("covers %v", covers)
	}
	// Without a profile nothing is watched.
	anon := f.alice.Do("GET", "/api/v1/curated?lang=en", nil).Expect(200).JSON()
	if l := anon["groups"].([]any)[0].(map[string]any)["lists"].([]any)[0].(map[string]any); num(l["watched"]) != 0 || l["title"] != "Test SF" {
		t.Fatalf("anon %v", l)
	}

	one := f.alice.Do("GET", "/api/v1/curated/test-sf?lang=ru&profile_id="+pid, nil).Expect(200).JSON()
	items := one["items"].([]any)
	if len(items) != 7 || num(one["watched"]) != 2 || one["author"] != "A. Critic" {
		t.Fatalf("list %v", one)
	}
	first := items[0].(map[string]any)
	if first["watched"] != true || first["note"] != "кристалл" || first["rank"] != nil ||
		first["media"].(map[string]any)["me"].(map[string]any)["completed"] != true {
		t.Fatalf("first item %v", first)
	}
	if items[1].(map[string]any)["watched"] != true || items[2].(map[string]any)["watched"] != false {
		t.Fatal("watched flags")
	}
	if last := items[6].(map[string]any); last["media"] != nil || last["title"] != "Twin Peril" || num(last["year"]) != 2001 {
		t.Fatalf("unresolved item %v", last)
	}
	ranked := f.alice.Do("GET", "/api/v1/curated/test-drama?profile_id="+pid, nil).Expect(200).JSON()
	if r := ranked["items"].([]any)[2].(map[string]any)["rank"]; num(r) != 3 {
		t.Fatalf("rank %v", r)
	}
	// The series: resolved through /tv/{id}, localized, with its published rank.
	heimat := ranked["items"].([]any)[5].(map[string]any)
	if hm, _ := heimat["media"].(map[string]any); num(heimat["rank"]) != 5 || heimat["kind"] != "series" || hm == nil ||
		hm["kind"] != "series" || hm["title"] != "Heimat" || num(hm["year"]) != 1984 {
		t.Fatalf("series item %v", heimat)
	}
	if ru := f.alice.Do("GET", "/api/v1/curated/test-drama?lang=ru", nil).Expect(200).JSON(); ru["items"].([]any)[5].(map[string]any)["media"].(map[string]any)["title"] != "Родина" {
		t.Fatal("series ru title")
	}
	f.alice.Do("GET", "/api/v1/curated/nope", nil).Expect(404)
	f.alice.Do("GET", "/api/v1/curated/test-sf?lang=xx", nil).Expect(422)
	// Someone else's profile: 404.
	bob, _ := f.env.NewUserClient("bob", "user")
	bob.Do("GET", "/api/v1/curated?profile_id="+pid, nil).Expect(404)
	bob.Do("GET", "/api/v1/curated/test-sf?profile_id="+pid, nil).Expect(404)

	// ---- Home row: the partly watched list wins; unwatched titles first ----
	rows := rowsOf(t, f.alice, pid)["rows"].([]any)
	var row map[string]any
	for _, r := range rows {
		if m := r.(map[string]any); m["kind"] == "curated" {
			if row != nil {
				t.Fatal("two curated rows")
			}
			row = m
		}
	}
	if row == nil {
		t.Fatalf("no curated row in %d rows", len(rows))
	}
	if row["id"] != "curated:test-sf" || row["title"] != "Collection: Test SF · 2 of 7" {
		t.Fatalf("row %v %v", row["id"], row["title"])
	}
	if c := row["curated"].(map[string]any); c["list_id"] != "test-sf" || num(c["count"]) != 7 || num(c["watched"]) != 2 {
		t.Fatalf("row info %v", c)
	}
	ritems := row["items"].([]any)
	if len(ritems) != 6 {
		t.Fatalf("row items %d", len(ritems))
	}
	firstID := ritems[0].(map[string]any)["media"].(map[string]any)["id"]
	lastIDs := []any{ritems[4].(map[string]any)["media"].(map[string]any)["id"], ritems[5].(map[string]any)["media"].(map[string]any)["id"]}
	if firstID == solaris || firstID == stalker || !(lastIDs[0] == solaris && lastIDs[1] == stalker) {
		t.Fatalf("order: first %v last %v", firstID, lastIDs)
	}
	if rs := ritems[0].(map[string]any)["reason"].(map[string]any); rs["type"] != "curated" || rs["text"] != "Test SF" {
		t.Fatalf("reason %v", rs)
	}
	// show_curated off: no row.
	f.alice.Do("PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"show_curated": false}).Expect(200)
	for _, r := range rowsOf(t, f.alice, pid)["rows"].([]any) {
		if r.(map[string]any)["kind"] == "curated" {
			t.Fatal("curated row shown with show_curated off")
		}
	}
	if s := f.alice.Do("GET", "/api/v1/profiles/"+pid+"/settings", nil).Expect(200).JSON(); s["show_curated"] != false {
		t.Fatalf("setting %v", s["show_curated"])
	}

	// ---- Explore section and browse ----
	ex := f.alice.Do("GET", "/api/v1/foryou/explore?lang=en&profile_id="+pid, nil).Expect(200).JSON()
	var sec map[string]any
	for _, s := range ex["sections"].([]any) {
		if m := s.(map[string]any); m["kind"] == "curated" {
			sec = m
		}
	}
	if sec == nil || sec["title"] != "Curated lists" {
		t.Fatalf("no curated section: %v", ex["sections"])
	}
	tile := sec["tiles"].([]any)[0].(map[string]any)
	if tile["id"] != "curated:test-sf" || tile["curated_id"] != "test-sf" || tile["progress"] != "2 / 7" || tile["subtitle"] != "A. Critic" ||
		!strings.HasPrefix(tile["image_path"].(string), "/b") {
		t.Fatalf("tile %v", tile)
	}
	br := f.alice.Do("GET", "/api/v1/foryou/browse?tile=curated:test-sf&profile_id="+pid, nil).Expect(200).JSON()
	if len(br["items"].([]any)) != 6 || br["title"] != "Test SF" {
		t.Fatalf("browse %v", br["title"])
	}
	f.alice.Do("GET", "/api/v1/foryou/browse?tile=curated:nope&profile_id="+pid, nil).Expect(404)

	// ---- a shorter list file drops its old positions ----
	lists = testLists()
	lists[0].Items = lists[0].Items[:5]
	svc.SetLists(lists)
	if _, err := svc.Resolve(ctx); err != nil {
		t.Fatal(err)
	}
	if got := resolvedTMDB(t, f, "test-sf"); len(got) != 5 {
		t.Fatalf("after shrink %v", got)
	}
}
