package server_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// Taste by themes + the AI themes/picks calls, end to end: keywords come
// with the details (and the backfill), the stoplist keeps production
// trivia out of Taste DNA, the AI re-ranking leads «Подобрано для вас» with
// its own reasons, theme rubrics become rows and liked keywords get
// Russian names.
func TestForYouThemesAndPicks(t *testing.T) {
	f := newFyEnv(t)
	f.pinDay(time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC))
	a := f.sciFiProfile(t, f.alice, "Sci")
	rowsOf(t, f.alice, a) // remember the language (en) and build the first cache

	var firstPick string
	f.ai.mu.Lock()
	f.ai.extraFn = func(system, user string) string {
		var msg struct {
			Candidates []struct {
				ID    int    `json:"id"`
				Title string `json:"title"`
			} `json:"candidates"`
			LikedThemes []string `json:"liked_themes"`
		}
		_ = json.Unmarshal([]byte(user[:strings.LastIndex(user, "}")+1]), &msg)
		n := len(msg.Candidates)
		if strings.Contains(system, "Pick the 15") {
			if n < 6 {
				return `{"picks":[]}`
			}
			firstPick = msg.Candidates[n-1].Title
			// The last candidate first; an unknown id, a duplicate, a Russian
			// line for an English profile and an empty one are dropped.
			picks := fmt.Sprintf(`{"picks":[{"id":%d,"why":"Slow and moody, like the space sagas you rate highest"},{"id":999,"why":"Nope"},`+
				`{"id":%d,"why":"Again"},{"id":1,"why":"Медленный, как вы любите"},{"id":2,"why":""}`, n, n)
			for i := 3; i <= 8; i++ {
				picks += fmt.Sprintf(`,{"id":%d,"why":"Reason number %d for you"}`, i, i)
			}
			return picks + "]}"
		}
		names := `{}`
		for _, k := range msg.LikedThemes {
			if k == "slow burn" {
				names = `{"slow burn":"неторопливое повествование","nonexistent":"что-то"}`
			}
		}
		ids := []int{}
		for i := 1; i <= min(n, 6); i++ {
			ids = append(ids, i)
		}
		b, _ := json.Marshal(ids)
		return `{"rubrics":[{"title_ru":"Тихий космос","title_en":"Quiet space","description_ru":"Неспешная фантастика","description_en":"Unhurried sci-fi","ids":` +
			string(b) + `},{"title_ru":"Мало","title_en":"Too few","ids":[1,2]}],"theme_names_ru":` + names + `}`
	}
	f.ai.mu.Unlock()
	f.ai.set(aiJSON([]string{"Cerebral", "Solaris|1972", "Stalker|1979", "Moon|2009", "Primer|2004", "Gattaca|1997"}))

	run := f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "profile", "id": a, "ai": true}).Expect(202).JSON()
	done := waitRun(t, f.admin, run["run_id"].(string))
	if done["status"] != "completed" || len(done["errors"].([]any)) != 0 {
		t.Fatalf("run %v", done)
	}
	if f.tmdb.hit("/movie/1") == 0 {
		t.Fatal("details not fetched")
	}

	// Taste DNA: the liked theme (not the stoplisted one).
	taste := f.alice.Do("GET", "/api/v1/profiles/"+a+"/taste?lang=en", nil).Expect(200).JSON()
	themes := taste["themes"].([]any)
	if len(themes) == 0 || themes[0].(map[string]any)["name"] != "slow burn" || themes[0].(map[string]any)["localized"] != true {
		t.Fatalf("themes %v", themes)
	}
	for _, th := range themes {
		if th.(map[string]any)["name_en"] == "based on novel or book" {
			t.Fatalf("stoplisted keyword in themes: %v", themes)
		}
	}

	res := rowsOf(t, f.alice, a)
	_, rows := f.rowItems(res)
	top := rows[0]
	if top["kind"] != "top_picks" {
		t.Fatalf("first row %v", top["kind"])
	}
	items := top["items"].([]any)
	if f.ai.extraCalls.Load() >= 1 && firstPick != "" {
		first := items[0].(map[string]any)
		if first["media"].(map[string]any)["title"] != firstPick ||
			first["reason"].(map[string]any)["ai_text"] != "Slow and moody, like the space sagas you rate highest" {
			t.Fatalf("AI pick not first: %v (want %s)", first, firstPick)
		}
		withAI := 0
		for _, it := range items {
			r := it.(map[string]any)["reason"].(map[string]any)
			if txt, ok := r["ai_text"].(string); ok {
				withAI++
				if strings.ContainsAny(txt, "абвгдежзийклмнопрстуфхцчшщыэюя") || txt == "" {
					t.Fatalf("invalid AI reason kept: %q", txt)
				}
			}
		}
		if withAI != 7 {
			t.Fatalf("%d items with an AI reason, want 7", withAI)
		}
		// Another language: the typed reason only.
		ru := f.alice.Do("GET", "/api/v1/foryou/rows?lang=ru&profile_id="+a, nil).Expect(200).JSON()
		for _, it := range ru["rows"].([]any)[0].(map[string]any)["items"].([]any) {
			if _, ok := it.(map[string]any)["reason"].(map[string]any)["ai_text"]; ok {
				t.Fatal("English AI reason shown in Russian")
			}
		}
	} else {
		t.Fatalf("picks call not made (%d extra calls)", f.ai.extraCalls.Load())
	}

	// The themes call: a rubric row (when there were enough candidates) and
	// the Russian keyword name.
	f.ai.mu.Lock()
	themed := false
	for _, p := range f.ai.extraPrompts {
		if strings.Contains(p, `"liked_themes"`) {
			themed = true
		}
	}
	f.ai.mu.Unlock()
	if !themed {
		t.Fatal("themes call not made")
	}
	{
		found := false
		for _, r := range rows {
			if r["kind"] == "ai_collection" && r["title"] == "Quiet space" {
				found = true
			}
			if r["title"] == "Too few" {
				t.Fatal("a rubric with 2 titles became a row")
			}
		}
		if !found {
			t.Fatalf("no theme rubric row: %v", rows)
		}
		ruTaste := f.alice.Do("GET", "/api/v1/profiles/"+a+"/taste?lang=ru", nil).Expect(200).JSON()
		th := ruTaste["themes"].([]any)[0].(map[string]any)
		if th["name"] != "неторопливое повествование" || th["localized"] != true || th["name_en"] != "slow burn" {
			t.Fatalf("ru theme %v", th)
		}
	}

	// Admin switches: off → no extra calls.
	s := f.admin.Do("PUT", "/api/v1/admin/foryou/ai", map[string]any{"themes_ai": false, "picks_ai": false}).Expect(200).JSON()
	if s["themes_ai"] != false || s["picks_ai"] != false {
		t.Fatalf("switches %v", s)
	}
	before := f.ai.extraCalls.Load()
	run = f.admin.Do("POST", "/api/v1/admin/foryou/rerun", map[string]any{"scope": "profile", "id": a, "ai": true}).Expect(202).JSON()
	waitRun(t, f.admin, run["run_id"].(string))
	if f.ai.extraCalls.Load() != before {
		t.Fatal("extra AI calls with the switches off")
	}
	st := f.admin.Do("GET", "/api/v1/admin/foryou/runs", nil).Expect(200).JSON()["ai"].(map[string]any)
	if st["themes_ai"] != false || st["picks_ai"] != false {
		t.Fatalf("runs ai %v", st)
	}
	f.admin.Do("PUT", "/api/v1/admin/foryou/ai", map[string]any{"themes_ai": true, "picks_ai": true}).Expect(200)
	f.env.Server.ForYou.Wait()
}
