package server_test

import (
	"context"
	"slices"
	"testing"
)

// «✨ Заполнить по моим фильмам»: the questionnaire derived from the
// profile's ratings, saved over the previous generation (audio / company
// kept), refreshed on demand; too little history → 409; TVs may, strangers
// may not.
func TestTasteQuizGenerate(t *testing.T) {
	f := newFyEnv(t)
	ctx := context.Background()
	pid := newProfile(t, f.alice, "Gen")
	base := "/api/v1/profiles/" + pid + "/taste-quiz"
	strs := func(v any) []string {
		var out []string
		if l, ok := v.([]any); ok {
			for _, x := range l {
				out = append(out, x.(string))
			}
		}
		return out
	}

	// Two ratings are not enough.
	f.rate(t, f.alice, pid, 1, 9)
	f.rate(t, f.alice, pid, 2, 9)
	res := f.alice.Do("POST", base+"/generate?lang=ru", nil).Expect(409).JSON()
	if res["error"].(map[string]any)["code"] != "not_enough_history" {
		t.Fatalf("too little %v", res)
	}

	// Sci-fi (action / thriller) loved, rom-coms hated.
	for _, id := range []int{3, 4, 5} {
		f.rate(t, f.alice, pid, id, 9)
	}
	for _, id := range []int{22, 23, 25} {
		f.rate(t, f.alice, pid, id, 2)
	}
	// The viewer's own answers: a stale genre and an audio preference.
	f.alice.Do("POST", base+"/answers", map[string]any{"questions": map[string]any{"genres_like": []string{"16"}, "audio": []string{"subtitles"}}}).Expect(200)

	f.ai.set(aiJSON([]string{"Sci-fi", "Solaris|1972", "Stalker|1979", "Moon|2009", "Primer|2004", "Gattaca|1997", "Arrival|2016"}))
	res = f.alice.Do("POST", base+"/generate?lang=ru", nil).Expect(200).JSON()
	basis := res["basis"].(map[string]any)
	if num(basis["titles"]) != 8 || num(basis["rated"]) != 8 || num(basis["liked"]) != 5 || num(basis["disliked"]) != 3 {
		t.Fatalf("basis %v", basis)
	}
	if res["ai_regeneration"] != true {
		t.Fatalf("ai %v", res["ai_regeneration"])
	}
	st := res["state"].(map[string]any)
	ans := st["answers"].(map[string]any)
	like, dislike := strs(ans["genres_like"]), strs(ans["genres_dislike"])
	if !slices.Contains(like, "878") || slices.Contains(like, "16") || slices.Contains(like, "35") {
		t.Fatalf("likes %v", like)
	}
	if !slices.Equal(dislike, []string{"10749", "35"}) {
		t.Fatalf("dislikes %v", dislike)
	}
	if !slices.Equal(strs(ans["audio"]), []string{"subtitles"}) || !slices.Equal(strs(ans["format"]), []string{"movies"}) {
		t.Fatalf("answers %v", ans)
	}
	if st["completed_at"] != nil {
		t.Fatal("generating must not complete the quiz")
	}
	f.env.Server.ForYou.Wait()
	var expired bool
	if err := f.env.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM profile_taste WHERE profile_id = $1)`, pid).Scan(&expired); err != nil || !expired {
		t.Fatalf("taste not recomputed: %v", err)
	}
	// The GET reflects it.
	got := f.alice.Do("GET", base, nil).Expect(200).JSON()["answers"].(map[string]any)
	if !slices.Equal(strs(got["genres_dislike"]), dislike) {
		t.Fatalf("GET answers %v", got)
	}

	// Changed mind about rom-coms: regenerating overwrites (dislike cleared).
	for _, id := range []int{22, 23, 25} {
		f.rate(t, f.alice, pid, id, 9)
	}
	ans = f.alice.Do("POST", base+"/generate?lang=en", nil).Expect(200).JSON()["state"].(map[string]any)["answers"].(map[string]any)
	if ans["genres_dislike"] != nil || !slices.Contains(strs(ans["genres_like"]), "35") || !slices.Equal(strs(ans["audio"]), []string{"subtitles"}) {
		t.Fatalf("regenerated %v", ans)
	}
	f.alice.Do("POST", base+"/generate?lang=xx", nil).Expect(422)

	// The profile's TV may; another account may not.
	_, cred := f.env.Pair(f.alice, "TV")
	deviceClient(f.env, cred).Do("POST", base+"/generate?lang=ru", nil).Expect(200)
	bob, _ := f.env.NewUserClient("bob", "user")
	bob.Do("POST", base+"/generate?lang=ru", nil).Expect(404)
	f.env.Server.ForYou.Wait()
}
