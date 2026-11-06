package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"martytv/api/internal/config"
)

// mockWikidataAwards answers the awards query (P166/P1411) for TMDB movie
// 100 (two Oscars, a Palme d'Or, a BAFTA nomination) and nothing else; the
// Kinopoisk query gets no matches. It counts awards queries.
type mockWikidataAwards struct {
	mu     sync.Mutex
	awards int
	srv    *httptest.Server
}

func newMockWikidataAwards(t *testing.T) *mockWikidataAwards {
	w := &mockWikidataAwards{}
	movieValues := regexp.MustCompile(`VALUES \?tm \{([^}]*)\}`)
	const e = "http://www.wikidata.org/entity/"
	lit := func(k, v string) string { return `"` + k + `":{"type":"literal","value":"` + v + `"}` }
	uri := func(k, q string) string { return `"` + k + `":{"type":"uri","value":"` + e + q + `"}` }
	w.srv = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		q := r.PostFormValue("query")
		var bindings []string
		if strings.Contains(q, "P166") {
			w.mu.Lock()
			w.awards++
			w.mu.Unlock()
			if m := movieValues.FindStringSubmatch(q); m != nil && strings.Contains(m[1], `"100"`) {
				base := lit("tm", "100") + "," + uri("item", "Q100") + "," + lit("imdb", "tt0000100")
				for _, b := range [][]string{
					{uri("award", "Q102427"), lit("won", "1"), lit("time", "2001-03-25T00:00:00Z"), uri("grp", "Q19020"), lit("ru", "премия «Оскар» за лучший фильм"), lit("en", "Academy Award for Best Picture")},
					{uri("award", "Q103360"), lit("won", "1"), lit("time", "2001-03-25T00:00:00Z"), uri("grp", "Q19020"), lit("ru", "премия «Оскар» за лучшую режиссёрскую работу"), lit("en", "Academy Award for Best Director")},
					{uri("award", "Q179808"), lit("won", "1"), lit("time", "2000-01-01T00:00:00Z"), uri("grp", "Q28444913"), lit("ru", "Золотая пальмовая ветвь"), lit("en", "Palme d'Or")},
					{uri("award", "Q139184"), lit("won", "0"), lit("evTime", "2001-02-25T00:00:00Z"), uri("grp", "Q732997"), lit("ru", "премия BAFTA за лучший фильм"), lit("en", "BAFTA Award for Best Film")},
				} {
					bindings = append(bindings, "{"+base+","+strings.Join(b, ",")+"}")
				}
			}
		}
		rw.Header().Set("Content-Type", "application/sparql-results+json")
		_, _ = rw.Write([]byte(`{"head":{"vars":[]},"results":{"bindings":[` + strings.Join(bindings, ",") + `]}}`))
	}))
	t.Cleanup(w.srv.Close)
	return w
}

func (w *mockWikidataAwards) count() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.awards
}

// Awards: Details of a never-checked title fetch in the background (the
// first response has an empty list), the next one is grouped; list items
// carry the tier-1 badge; the backfill covers titles nobody opened and
// does not re-ask checked ones.
func TestAwardsWikidata(t *testing.T) {
	wd := newMockWikidataAwards(t)
	env, _ := ratingsEnv(t, false, func(c *config.Config) { c.Kinopoisk.WikidataURL = wd.srv.URL })
	c, _ := env.NewUserClient("alice", "user")
	ctx := context.Background()

	list := "/api/v1/catalog/lists/popular?kind=movie"
	movie := findItem(t, itemsOf(c.Do("GET", list, nil).Expect(200).JSON()), "movie", 100)
	if _, ok := movie["award_badge"]; ok {
		t.Fatalf("no badge before a check: %v", movie)
	}
	id := movie["id"].(string)
	d := c.Do("GET", "/api/v1/media/"+id+"?lang=ru", nil).Expect(200).JSON()
	if aw, ok := d["awards"].([]any); !ok || len(aw) != 0 {
		t.Fatalf("first view: empty list, got %v", d["awards"])
	}
	env.Server.Awards.Wait()
	if wd.count() != 1 {
		t.Fatalf("awards queries %d", wd.count())
	}

	d = c.Do("GET", "/api/v1/media/"+id+"?lang=ru", nil).Expect(200).JSON()
	aw := d["awards"].([]any)
	if len(aw) != 3 {
		t.Fatalf("groups %v", aw)
	}
	oscar := aw[0].(map[string]any)
	wins := oscar["wins"].([]any)
	if oscar["group"] != "oscar" || oscar["group_label"] != "Оскар" || oscar["tier"] != float64(1) || len(wins) != 2 ||
		wins[0].(map[string]any)["label"] != "лучший фильм" || wins[0].(map[string]any)["year"] != float64(2001) ||
		wins[1].(map[string]any)["label"] != "лучшая режиссёрская работа" {
		t.Fatalf("oscar %v", oscar)
	}
	if g := aw[1].(map[string]any); g["group"] != "cannes" || g["tier"] != float64(1) {
		t.Fatalf("cannes %v", g)
	}
	if g := aw[2].(map[string]any); g["group"] != "bafta" || len(g["wins"].([]any)) != 0 ||
		g["nominations"].([]any)[0].(map[string]any)["label"] != "лучший фильм" {
		t.Fatalf("bafta %v", g)
	}
	if b := d["award_badge"].(map[string]any); b["group"] != "oscar" || b["count"] != float64(2) {
		t.Fatalf("detail badge %v", d["award_badge"])
	}
	en := c.Do("GET", "/api/v1/media/"+id+"?lang=en", nil).Expect(200).JSON()
	if g := en["awards"].([]any)[0].(map[string]any); g["group_label"] != "Oscar" ||
		g["wins"].([]any)[0].(map[string]any)["label"] != "Best Picture" {
		t.Fatalf("en %v", g)
	}

	// Lists (catalog, home) carry the badge.
	movie = findItem(t, itemsOf(c.Do("GET", list, nil).Expect(200).JSON()), "movie", 100)
	if b, ok := movie["award_badge"].(map[string]any); !ok || b["group"] != "oscar" || b["count"] != float64(2) {
		t.Fatalf("list badge %v", movie["award_badge"])
	}
	home := c.Do("GET", "/api/v1/catalog/home", nil).Expect(200).JSON()
	trending := home["rows"].([]any)[0].(map[string]any)
	if m := findItem(t, itemsOf(trending), "movie", 100); m["award_badge"] == nil {
		t.Fatalf("home %v", m)
	}
	if s := findItem(t, itemsOf(trending), "series", 100); s["award_badge"] != nil {
		t.Fatalf("series without awards has no badge: %v", s)
	}

	// Checked titles are not fetched again on view.
	c.Do("GET", "/api/v1/media/"+id, nil).Expect(200)
	env.Server.Awards.Wait()
	if wd.count() != 1 {
		t.Fatalf("re-fetched: %d", wd.count())
	}

	// Backfill: everything never checked, in one batch, then nothing.
	n, err := env.Server.Awards.BackfillOnce(ctx)
	if err != nil || n < 1 || wd.count() != 2 {
		t.Fatalf("backfill %d %v (%d queries)", n, err, wd.count())
	}
	if n, err := env.Server.Awards.BackfillOnce(ctx); n != 0 || err != nil {
		t.Fatalf("backlog not empty: %d %v", n, err)
	}
	var unchecked int
	if err := env.Pool.QueryRow(ctx, `SELECT count(*) FROM media WHERE awards_checked_at IS NULL`).Scan(&unchecked); err != nil || unchecked != 0 {
		t.Fatalf("unchecked %d %v", unchecked, err)
	}
	// After 60 days a title is checked again; its rows are replaced.
	if _, err := env.Pool.Exec(ctx, `UPDATE media SET awards_checked_at = now() - interval '61 days' WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}
	if n, err := env.Server.Awards.BackfillOnce(ctx); n != 1 || err != nil {
		t.Fatalf("recheck %d %v", n, err)
	}
	var rows int
	var at time.Time
	if err := env.Pool.QueryRow(ctx, `SELECT count(*), max(m.awards_checked_at) FROM media_awards a JOIN media m ON m.id = a.media_id WHERE a.media_id = $1`, id).
		Scan(&rows, &at); err != nil || rows != 4 || time.Since(at) > time.Minute {
		t.Fatalf("rows %d at %v %v", rows, at, err)
	}
}

// Without Wikidata (KINOPOISK_WIKIDATA_URL=off) details still carry an
// empty awards list and nothing is fetched.
func TestAwardsOff(t *testing.T) {
	env, _ := ratingsEnv(t, false)
	c, _ := env.NewUserClient("alice", "user")
	movie := findItem(t, itemsOf(c.Do("GET", "/api/v1/catalog/lists/popular?kind=movie", nil).Expect(200).JSON()), "movie", 100)
	d := c.Do("GET", "/api/v1/media/"+movie["id"].(string), nil).Expect(200).JSON()
	if aw, ok := d["awards"].([]any); !ok || len(aw) != 0 {
		t.Fatalf("awards %v", d["awards"])
	}
	if n, err := env.Server.Awards.BackfillOnce(context.Background()); n != 0 || err != nil {
		t.Fatalf("backfill without wikidata %d %v", n, err)
	}
}
