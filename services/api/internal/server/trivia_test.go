package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"martytv/api/internal/config"
)

// fakeWikimedia: Wikidata answers the TMDB 100 movie with ru/en Wikiquote
// pages; Wikiquote serves their wikitext. Counts requests.
type fakeWikimedia struct {
	mu        sync.Mutex
	sparql    int
	pages     int
	noRuPage  bool
	wd, quote *httptest.Server
}

const ruQuotesPage = `{{Карточка}}
'''«Альфа»''' — фильм.
== Цитаты ==
=== Нео ===
{{q|Мистер Волшебник! Вытащи меня отсюда!|Оригинал=Mr. Wizard, get me the hell out of here.}}
* Я знаю кунг-фу.
=== Морфеус ===
* Добро пожаловать в [[w:Реальность|реальный мир]].
* ''(Нео)'' Следуй за белым кроликом.
== Диалоги ==
* Нео: Ты кто?<br>Тринити: Тринити.
== Ссылки ==
* [https://example.org Сайт фильма]
`

func newFakeWikimedia(t *testing.T) *fakeWikimedia {
	f := &fakeWikimedia{}
	f.wd = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.sparql++
		noRu := f.noRuPage
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/sparql-results+json")
		q := r.URL.Query().Get("query")
		if !strings.Contains(q, `wdt:P4947 "100"`) {
			_, _ = w.Write([]byte(`{"results":{"bindings":[]}}`))
			return
		}
		ru := `"ru":{"type":"literal","value":"Альфа (фильм)"},`
		if noRu {
			ru = ""
		}
		_, _ = w.Write([]byte(`{"results":{"bindings":[{` + ru + `"en":{"type":"literal","value":"Alpha (film)"}}]}}`))
	}))
	f.quote = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.pages++
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		page, lang := r.URL.Query().Get("page"), strings.TrimPrefix(r.URL.Path, "/")
		text := ""
		switch {
		case lang == "ru/w/api.php" && page == "Альфа (фильм)":
			text = ruQuotesPage
		case lang == "en/w/api.php" && page == "Alpha (film)":
			text = "== Neo ==\n* [''At a [[w:Telephone booth|phonebooth]]''] '''I know you're out there.'''\n* Whoa.\n* I know kung fu, really.\n* There is no spoon, they say.\n"
		default:
			_, _ = w.Write([]byte(`{"error":{"code":"missingtitle"}}`))
			return
		}
		b := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(text)
		_, _ = w.Write([]byte(`{"parse":{"title":"x","wikitext":"` + b + `"}}`))
	}))
	t.Cleanup(f.wd.Close)
	t.Cleanup(f.quote.Close)
	return f
}

func (f *fakeWikimedia) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sparql, f.pages
}

func TestTriviaQuotes(t *testing.T) {
	env, _ := ratingsEnv(t, false)
	wm := newFakeWikimedia(t)
	env.Server.Trivia.SetWikimedia(wm.wd.URL, func(lang string) string { return wm.quote.URL + "/" + lang + "/w/api.php" })
	c, _ := env.NewUserClient("alice", "user")
	movie := findItem(t, itemsOf(c.Do("GET", "/api/v1/catalog/lists/popular?kind=movie", nil).Expect(200).JSON()), "movie", 100)
	id := movie["id"].(string)

	q := c.Do("GET", "/api/v1/media/"+id+"/quotes?lang=ru", nil).Expect(200).JSON()
	items := q["items"].([]any)
	if q["source"] != "wikiquote" || q["lang"] != "ru" || !strings.HasPrefix(q["source_url"].(string), "https://ru.wikiquote.org/wiki/") || len(items) != 4 {
		t.Fatalf("quotes %v", q)
	}
	// Round-robin across speakers; links, stage directions and templates cleaned; dialogues and links sections skipped.
	want := []struct{ text, speaker string }{
		{"Мистер Волшебник! Вытащи меня отсюда!", "Нео"},
		{"Добро пожаловать в реальный мир.", "Морфеус"},
		{"Я знаю кунг-фу.", "Нео"},
		{"Следуй за белым кроликом.", "Морфеус"},
	}
	for i, w := range want {
		it := items[i].(map[string]any)
		if it["text"] != w.text || it["speaker"] != w.speaker {
			t.Fatalf("quote %d = %v, want %v", i, it, w)
		}
	}
	// Cached: no more Wikimedia requests.
	sp, pg := wm.counts()
	c.Do("GET", "/api/v1/media/"+id+"/quotes?lang=ru", nil).Expect(200)
	if s2, p2 := wm.counts(); s2 != sp || p2 != pg {
		t.Fatalf("cache missed: %d/%d → %d/%d", sp, pg, s2, p2)
	}
	// English: the en page (bold part of a long line, stage directions dropped).
	en := c.Do("GET", "/api/v1/media/"+id+"/quotes?lang=en", nil).Expect(200).JSON()
	if en["lang"] != "en" || en["items"].([]any)[0].(map[string]any)["text"] != "I know you're out there." {
		t.Fatalf("en quotes %v", en)
	}
	// No Wikiquote page: an empty answer, cached.
	// (series 100: Wikidata is asked P4983, which has nothing).
	other := findItem(t, itemsOf(c.Do("GET", "/api/v1/catalog/lists/popular?kind=series", nil).Expect(200).JSON()), "series", 100)
	none := c.Do("GET", "/api/v1/media/"+other["id"].(string)+"/quotes", nil).Expect(200).JSON()
	if len(none["items"].([]any)) != 0 || none["source"] != nil {
		t.Fatalf("no page %v", none)
	}
	c.Do("GET", "/api/v1/media/00000000-0000-0000-0000-000000000000/quotes", nil).Expect(404)
	c.Do("GET", "/api/v1/media/not-a-uuid/quotes", nil).Expect(404)
	c.Do("GET", "/api/v1/media/"+id+"/quotes?lang=de", nil).Expect(422)
}

func TestTriviaFacts(t *testing.T) {
	ai := newAskFake(t)
	env, _ := ratingsEnv(t, true, func(c *config.Config) {
		c.ForYou.DeepSeekAPIKey = "test-deepseek-key"
		c.ForYou.DeepSeekBaseURL = ai.srv.URL
	})
	c, _ := env.NewUserClient("alice", "user")
	ctx := context.Background()
	items := itemsOf(c.Do("GET", "/api/v1/catalog/lists/popular?kind=movie", nil).Expect(200).JSON())
	id := findItem(t, items, "movie", 100)["id"].(string)
	other := findItem(t, itemsOf(c.Do("GET", "/api/v1/catalog/lists/popular?kind=series", nil).Expect(200).JSON()), "series", 100)["id"].(string)
	if _, err := env.Pool.Exec(ctx, `UPDATE media SET kp_id = CASE WHEN id = $1 THEN 777 ELSE NULL END WHERE id IN ($1, $2)`, id, other); err != nil {
		t.Fatal(err)
	}

	// Kinopoisk facts: plain text, facts before bloopers, spoiler flag kept; no AI call.
	f := c.Do("GET", "/api/v1/media/"+id+"/facts?lang=ru", nil).Expect(200).JSON()
	fi := f["items"].([]any)
	if f["source"] != "kinopoisk" || f["source_url"] != "https://www.kinopoisk.ru/film/777/facts/" || len(fi) != 3 {
		t.Fatalf("facts %v", f)
	}
	first := fi[0].(map[string]any)
	if first["kind"] != "fact" || first["text"] != "Фильм снимали в Сиднее, а не в Чикаго, как задумано по «сценарию»." {
		t.Fatalf("first fact %v", first)
	}
	if fi[1].(map[string]any)["spoiler"] != true || fi[2].(map[string]any)["kind"] != "blooper" ||
		fi[2].(map[string]any)["text"] != "Ляп: в кадре виден микрофон над головой героя." {
		t.Fatalf("facts order %v", fi)
	}
	if ai.calls() != 0 {
		t.Fatalf("AI called for a Kinopoisk title")
	}

	// No Kinopoisk id yet: DeepSeek writes them, told only catalog data.
	ai.reply(`{"facts":[{"text":"Этот фильм стал первым в истории студии, снятым целиком на натуре.","spoiler":false},{"text":"коротко","spoiler":false}]}`)
	g := c.Do("GET", "/api/v1/media/"+other+"/facts?lang=ru", nil).Expect(200).JSON()
	if g["source"] != "ai" || len(g["items"].([]any)) != 1 || ai.calls() != 1 {
		t.Fatalf("ai facts %v (calls %d)", g, ai.calls())
	}
	if u := ai.lastUser(); !strings.Contains(u, `"kind":"series"`) || !strings.Contains(u, `"title"`) {
		t.Fatalf("ai user message %q", u)
	}
	if got := ai.lastTemp(); got != 0.7 {
		t.Fatalf("facts temperature %v", got)
	}
	// Cached for a while (Kinopoisk may resolve the id later).
	c.Do("GET", "/api/v1/media/"+other+"/facts?lang=ru", nil).Expect(200)
	if ai.calls() != 1 {
		t.Fatalf("AI facts not cached")
	}
	var ttlDays float64
	if err := env.Pool.QueryRow(ctx, `SELECT EXTRACT(EPOCH FROM expires_at - now()) / 86400 FROM media_trivia WHERE media_id = $1 AND kind = 'facts'`, other).Scan(&ttlDays); err != nil || ttlDays > 1.01 {
		t.Fatalf("ai facts ttl %v days (%v)", ttlDays, err)
	}

	// The admin switches AI «Факты» off: stored ones are hidden, no new calls.
	admin, _ := env.NewUserClient("boss", "admin")
	c.Do("PUT", "/api/v1/admin/foryou/ai", map[string]any{"facts_ai": false}).Expect(403)
	s := admin.Do("PUT", "/api/v1/admin/foryou/ai", map[string]any{"facts_ai": false}).Expect(200).JSON()
	if s["facts_ai"] != false {
		t.Fatalf("settings %v", s)
	}
	if g := c.Do("GET", "/api/v1/media/"+other+"/facts?lang=ru", nil).Expect(200).JSON(); g["source"] != nil || len(g["items"].([]any)) != 0 {
		t.Fatalf("ai facts while off %v", g)
	}
	c.Do("GET", "/api/v1/media/"+other+"/facts?lang=en", nil).Expect(200)
	if ai.calls() != 1 {
		t.Fatalf("AI called while off (%d)", ai.calls())
	}
	// Kinopoisk facts are unaffected; switching back on shows the stored ones.
	if f := c.Do("GET", "/api/v1/media/"+id+"/facts?lang=ru", nil).Expect(200).JSON(); f["source"] != "kinopoisk" {
		t.Fatalf("kinopoisk facts while ai off %v", f)
	}
	admin.Do("PUT", "/api/v1/admin/foryou/ai", map[string]any{"facts_ai": true}).Expect(200)
	if g := c.Do("GET", "/api/v1/media/"+other+"/facts?lang=ru", nil).Expect(200).JSON(); g["source"] != "ai" {
		t.Fatalf("ai facts back on %v", g)
	}
}
