package server_test

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// «Давайте определим ваш вкус»: titles skip what the profile knows, answers
// have their usual effects, the questionnaire nudges the taste and reaches
// the AI, finishing regenerates; TVs may take the quiz, strangers may not.
func TestTasteQuiz(t *testing.T) {
	f := newFyEnv(t)
	ctx := context.Background()
	pid := newProfile(t, f.alice, "Quiz")
	base := "/api/v1/profiles/" + pid + "/taste-quiz"

	st := f.alice.Do("GET", base, nil).Expect(200).JSON()
	if st["started_at"] != nil || num(st["rated"]) != 0 || num(st["goal"]) != 20 || len(st["questions"].([]any)) != 9 {
		t.Fatalf("fresh state %v", st)
	}

	// A known title is never asked.
	f.rate(t, f.alice, pid, 1, 9)
	titles := func() []string {
		res := f.alice.Do("GET", base+"/titles?lang=en&limit=12", nil).Expect(200).JSON()
		var out []string
		for _, it := range res["items"].([]any) {
			out = append(out, it.(map[string]any)["id"].(string))
		}
		return out
	}
	first := titles()
	if len(first) < 6 || slices.Contains(first, f.ids[1]) {
		t.Fatalf("titles %v", first)
	}
	if len(first) != len(slices.Compact(slices.Sorted(slices.Values(first)))) {
		t.Fatalf("duplicates %v", first)
	}

	// Answers: rated / want / not_interested / unseen, plus questions.
	a, b, c, d := first[0], first[1], first[2], first[3]
	res := f.alice.Do("POST", base+"/answers", map[string]any{
		"questions": map[string]any{"genres_like": []string{"878", "53"}, "genres_dislike": []string{"10749"}, "intensity": []string{"avoid"}, "origins": []string{"soviet"}},
		"titles": []map[string]any{
			{"media_id": a, "answer": "rated", "rating": 8},
			{"media_id": b, "answer": "want"},
			{"media_id": c, "answer": "not_interested"},
			{"media_id": d, "answer": "unseen"},
		},
	}).Expect(200).JSON()
	if num(res["rated"]) != 1 || num(res["answered"]) != 4 || res["started_at"] == nil {
		t.Fatalf("after answers %v", res)
	}
	var rating int
	_ = f.env.Pool.QueryRow(ctx, `SELECT rating FROM ratings WHERE profile_id = $1 AND media_id = $2`, pid, a).Scan(&rating)
	var listed, dismissed bool
	_ = f.env.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM watchlist_items WHERE profile_id = $1 AND media_id = $2)`, pid, b).Scan(&listed)
	_ = f.env.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM foryou_dismissals WHERE profile_id = $1 AND media_id = $2)`, pid, c).Scan(&dismissed)
	if rating != 8 || !listed || !dismissed {
		t.Fatalf("side effects rating=%d listed=%v dismissed=%v", rating, listed, dismissed)
	}
	// Answered titles never come back.
	for _, id := range titles() {
		if id == a || id == b || id == c || id == d {
			t.Fatalf("answered title %s asked again", id)
		}
	}

	// Validation.
	f.alice.Do("POST", base+"/answers", map[string]any{"questions": map[string]any{"nope": []string{"x"}}}).Expect(422)
	f.alice.Do("POST", base+"/answers", map[string]any{"questions": map[string]any{"format": []string{"movies", "series"}}}).Expect(422)
	f.alice.Do("POST", base+"/answers", map[string]any{"titles": []map[string]any{{"media_id": a, "answer": "rated"}}}).Expect(422)
	f.alice.Do("POST", base+"/answers", map[string]any{"titles": []map[string]any{{"media_id": "00000000-0000-0000-0000-000000000000", "answer": "unseen"}}}).Expect(422)

	// A question can be changed; an empty list clears it.
	st = f.alice.Do("POST", base+"/answers", map[string]any{"questions": map[string]any{"origins": []string{}, "format": []string{"series"}}}).Expect(200).JSON()
	ans := st["answers"].(map[string]any)
	if ans["origins"] != nil || ans["format"].([]any)[0] != "series" || len(ans["genres_like"].([]any)) != 2 {
		t.Fatalf("answers %v", ans)
	}

	// Finish: taste nudged (likes sci-fi/thriller, dislikes romance and horror), AI regenerated with the questionnaire.
	f.ai.set(aiJSON([]string{"Cerebral sci-fi", "Solaris|1972", "Stalker|1979", "Moon|2009", "Primer|2004", "Gattaca|1997", "Arrival|2016"}))
	fin := f.alice.Do("POST", base+"/finish?lang=en", nil).Expect(200).JSON()
	if fin["ai_regeneration"] != true || fin["state"].(map[string]any)["completed_at"] == nil {
		t.Fatalf("finish %v", fin)
	}
	f.env.Server.ForYou.Wait()
	var raw []byte
	if err := f.env.Pool.QueryRow(ctx, `SELECT data FROM profile_taste WHERE profile_id = $1`, pid).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var taste struct {
		Genres []struct {
			K string  `json:"k"`
			S float64 `json:"s"`
		} `json:"genres"`
	}
	_ = json.Unmarshal(raw, &taste)
	score := map[string]float64{}
	for _, g := range taste.Genres {
		score[g.K] = g.S
	}
	if score["878"] <= 0 || score["53"] <= 0 || score["10749"] >= 0 || score["27"] >= 0 {
		t.Fatalf("taste genres %v", score)
	}
	if n := f.ai.calls.Load(); n < 1 {
		t.Fatalf("ai calls %d", n)
	}
	f.ai.mu.Lock()
	prompt := f.ai.prompts[len(f.ai.prompts)-1]
	f.ai.mu.Unlock()
	if !strings.Contains(prompt, "questionnaire") || !strings.Contains(prompt, "Science Fiction") {
		t.Fatalf("prompt lacks the questionnaire: %s", prompt)
	}

	// Dismiss hides the invitation; finishing again clears it.
	if f.alice.Do("POST", base+"/dismiss", nil).Expect(200).JSON()["dismissed_at"] == nil {
		t.Fatal("dismiss")
	}

	// The profile's TV may take the quiz; another account may not.
	_, cred := f.env.Pair(f.alice, "TV")
	tv := deviceClient(f.env, cred)
	tv.Do("GET", base, nil).Expect(200)
	tv.Do("POST", base+"/answers", map[string]any{"titles": []map[string]any{{"media_id": first[4], "answer": "rated", "rating": 6}}}).Expect(200)
	bob, _ := f.env.NewUserClient("bob", "user")
	bob.Do("GET", base, nil).Expect(404)
	bob.Do("POST", base+"/answers", map[string]any{"questions": map[string]any{"format": []string{"movies"}}}).Expect(404)
}
