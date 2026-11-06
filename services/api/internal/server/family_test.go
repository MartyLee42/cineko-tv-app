package server_test

import (
	"context"
	"strings"
	"testing"

	"martytv/api/internal/testutil"
)

// «Семья советует» (internal/family): opt-in sharing between profiles.

func familyOf(t *testing.T, c *testutil.Client, pid string) map[string]any {
	t.Helper()
	return c.Do("GET", "/api/v1/profiles/"+pid+"/family?lang=ru", nil).Expect(200).JSON()
}

func familyItems(b map[string]any) []map[string]any {
	var out []map[string]any
	for _, it := range b["items"].([]any) {
		out = append(out, it.(map[string]any))
	}
	return out
}

func mediaIDs(items []map[string]any) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it["media"].(map[string]any)["id"].(string)
	}
	return out
}

func indexOf(ids []string, id string) int {
	for i, x := range ids {
		if x == id {
			return i
		}
	}
	return -1
}

func share(t *testing.T, c *testutil.Client, pid string, on bool) {
	t.Helper()
	c.Do("PUT", "/api/v1/profiles/"+pid+"/settings", map[string]any{"share_with_family": on}).Expect(200)
}

func rateAs(t *testing.T, c *testutil.Client, pid, mid string, r int) {
	t.Helper()
	c.Do("PUT", "/api/v1/profiles/"+pid+"/ratings/"+mid, map[string]any{"rating": r}).Expect(204)
}

func TestFamilySharingPrivacyAndAccess(t *testing.T) {
	w := newWatchEnv(t)
	alice, apid := w.alice, w.pid
	bob, _ := w.env.NewUserClient("bob", "user")
	carol, _ := w.env.NewUserClient("carol", "user")
	bpid := newProfile(t, bob, "Bob")
	ctx := context.Background()

	heat := insertMovie(t, w.env, "Heat")
	ronin := insertMovie(t, w.env, "Ronin")
	collateral := insertMovie(t, w.env, "Collateral")
	inProgress := insertMovie(t, w.env, "Thief")
	listed := insertMovie(t, w.env, "Manhunter")
	meh := insertMovie(t, w.env, "Miami Vice")
	bobSeen := insertMovie(t, w.env, "Ali")
	favOnly := insertMovie(t, w.env, "Public Enemies")

	// ---- settings: defaults and validation ----
	st := alice.Do("GET", "/api/v1/profiles/"+apid+"/settings", nil).Expect(200).JSON()
	if st["share_with_family"] != false || st["show_family"] != true {
		t.Fatalf("defaults %v %v", st["share_with_family"], st["show_family"])
	}
	alice.Do("PUT", "/api/v1/profiles/"+apid+"/settings", map[string]any{"share_with_family": "yes"}).Expect(400)
	alice.Do("PUT", "/api/v1/profiles/"+apid+"/settings", map[string]any{"show_family": 1}).Expect(400)

	// Alice's activity.
	rateAs(t, alice, apid, heat, 9)
	rateAs(t, alice, apid, meh, 6)
	rateAs(t, alice, apid, bobSeen, 10)
	alice.Do("PUT", "/api/v1/media/"+ronin+"/watched", map[string]any{"profile_id": apid, "watched": true}).Expect(200)
	alice.Do("PUT", "/api/v1/profiles/"+apid+"/lists/watchlist/"+listed, nil).Expect(204)
	alice.Do("PUT", "/api/v1/profiles/"+apid+"/lists/favorites/"+favOnly, nil).Expect(204)
	if _, err := w.env.Pool.Exec(ctx, `
		INSERT INTO watch_progress (profile_id, media_id, position_seconds, duration_seconds, percent, resumable)
		VALUES ($1, $2, 1200, 6000, 0.2, true)`, apid, inProgress); err != nil {
		t.Fatal(err)
	}
	// Bob already watched one of them, and dismisses another later.
	rateAs(t, bob, bpid, bobSeen, 7)

	// ---- sharing off: nothing visible ----
	b := familyOf(t, bob, bpid)
	if b["enabled"] != true || b["sharing"] != false || len(b["members"].([]any)) != 0 || len(familyItems(b)) != 0 {
		t.Fatalf("sharing off %v", b)
	}
	if m := bob.Do("GET", "/api/v1/profiles/"+bpid+"/family/media/"+heat, nil).Expect(200).JSON(); len(m["people"].([]any)) != 0 {
		t.Fatalf("detail with sharing off %v", m)
	}

	// ---- sharing on: visible to another account's profile ----
	share(t, alice, apid, true)
	b = familyOf(t, bob, bpid)
	items := familyItems(b)
	ids := mediaIDs(items)
	members := b["members"].([]any)
	if len(members) != 1 || members[0].(map[string]any)["name"] != "Alice" || members[0].(map[string]any)["user_name"] != "alice" {
		t.Fatalf("members %v", members)
	}
	for _, want := range []string{heat, ronin, favOnly} {
		if indexOf(ids, want) < 0 {
			t.Fatalf("missing %s in %v", want, ids)
		}
	}
	for _, no := range []string{inProgress, listed, meh, bobSeen} {
		if indexOf(ids, no) >= 0 {
			t.Fatalf("%s must not be shared/suggested: %v", no, ids)
		}
	}
	top := items[0]
	why := top["why"].(map[string]any)
	if top["media"].(map[string]any)["id"] != heat || num(why["liked_by"]) != 1 || why["text"] != "Alice ★9" {
		t.Fatalf("top %v", top)
	}
	p := why["people"].([]any)[0].(map[string]any)
	if p["profile_id"] != apid || num(p["rating"]) != 9 || p["liked"] != true || p["color"] == "" {
		t.Fatalf("why person %v", p)
	}
	if me := top["media"].(map[string]any)["me"].(map[string]any); me["rating"] != nil {
		t.Fatalf("me is the viewer's state %v", me)
	}
	// In-progress positions never leak, not even in the raw response.
	for _, it := range items {
		for _, pp := range it["why"].(map[string]any)["people"].([]any) {
			if _, ok := pp.(map[string]any)["percent"]; ok {
				t.Fatal("progress exposed")
			}
		}
	}

	// ---- detail annotation ----
	d := bob.Do("GET", "/api/v1/profiles/"+bpid+"/family/media/"+ronin, nil).Expect(200).JSON()
	dp := d["people"].([]any)
	if d["enabled"] != true || len(dp) != 1 || dp[0].(map[string]any)["completed"] != true || dp[0].(map[string]any)["rating"] != nil {
		t.Fatalf("detail %v", d)
	}
	if d := bob.Do("GET", "/api/v1/profiles/"+bpid+"/family/media/"+inProgress, nil).Expect(200).JSON(); len(d["people"].([]any)) != 0 {
		t.Fatalf("in-progress title annotated %v", d)
	}
	if d := bob.Do("GET", "/api/v1/profiles/"+bpid+"/family/media/"+listed, nil).Expect(200).JSON(); len(d["people"].([]any)) != 0 {
		t.Fatalf("watchlist exposed %v", d)
	}

	// ---- exclusions: the viewer's watched / started / dismissed titles ----
	rateAs(t, bob, bpid, heat, 8)
	bob.Do("POST", "/api/v1/foryou/feedback", map[string]any{"profile_id": bpid, "media_id": favOnly, "action": "dismiss", "row_id": "family"}).Expect(202)
	if _, err := w.env.Pool.Exec(ctx, `INSERT INTO watch_progress (profile_id, media_id, percent) VALUES ($1, $2, 0.1)`, bpid, ronin); err != nil {
		t.Fatal(err)
	}
	ids = mediaIDs(familyItems(familyOf(t, bob, bpid)))
	if indexOf(ids, heat) >= 0 || indexOf(ids, favOnly) >= 0 || indexOf(ids, ronin) >= 0 {
		t.Fatalf("watched/dismissed/started still suggested: %v", ids)
	}

	// ---- the same account's other profile sees it too (sharing is per profile) ----
	kid := newProfile(t, alice, "Kid")
	if ids := mediaIDs(familyItems(familyOf(t, alice, kid))); indexOf(ids, heat) < 0 {
		t.Fatalf("own account's profile %v", ids)
	}
	// The sharer never sees its own titles.
	if b := familyOf(t, alice, apid); len(b["members"].([]any)) != 0 || b["sharing"] != true {
		t.Fatalf("self %v", b)
	}

	// ---- show_family off: nothing, and no detail annotation ----
	bob.Do("PUT", "/api/v1/profiles/"+bpid+"/settings", map[string]any{"show_family": false}).Expect(200)
	if b := familyOf(t, bob, bpid); b["enabled"] != false || len(familyItems(b)) != 0 {
		t.Fatalf("show off %v", b)
	}
	if d := bob.Do("GET", "/api/v1/profiles/"+bpid+"/family/media/"+collateral, nil).Expect(200).JSON(); d["enabled"] != false {
		t.Fatalf("detail show off %v", d)
	}
	bob.Do("PUT", "/api/v1/profiles/"+bpid+"/settings", map[string]any{"show_family": true}).Expect(200)

	// ---- sharing off again: gone at once ----
	share(t, alice, apid, false)
	if b := familyOf(t, bob, bpid); len(familyItems(b)) != 0 || len(b["members"].([]any)) != 0 {
		t.Fatalf("after opting out %v", b)
	}

	// ---- disabled accounts don't share ----
	share(t, alice, apid, true)
	if _, err := w.env.Pool.Exec(ctx, `UPDATE users SET disabled_at = now() WHERE username = 'alice'`); err != nil {
		t.Fatal(err)
	}
	if b := familyOf(t, bob, bpid); len(b["members"].([]any)) != 0 {
		t.Fatalf("disabled user shares %v", b)
	}

	// ---- access control ----
	carol.Do("GET", "/api/v1/profiles/"+bpid+"/family", nil).Expect(404)
	carol.Do("GET", "/api/v1/profiles/"+bpid+"/family/media/"+heat, nil).Expect(404)
	bob.Do("GET", "/api/v1/profiles/not-a-uuid/family", nil).Expect(404)
	bob.Do("GET", "/api/v1/profiles/"+bpid+"/family?lang=de", nil).Expect(422)
	w.env.Client().Do("GET", "/api/v1/profiles/"+bpid+"/family", nil).Expect(401)
	// A paired TV reads the family of profiles it can use.
	_, cred := w.env.Pair(bob, "Bob TV")
	deviceClient(w.env, cred).Do("GET", "/api/v1/profiles/"+bpid+"/family", nil).Expect(200)
	deviceClient(w.env, cred).Do("GET", "/api/v1/profiles/"+kid+"/family", nil).Expect(404)
}

func TestFamilyRankingBySimilarity(t *testing.T) {
	w := newWatchEnv(t)
	viewer, vpid := w.alice, w.pid
	twinU, _ := w.env.NewUserClient("twin", "user")
	otherU, _ := w.env.NewUserClient("other", "user")
	twin := newProfile(t, twinU, "Twin")
	other := newProfile(t, otherU, "Other")
	share(t, twinU, twin, true)
	share(t, otherU, other, true)

	// Five co-rated titles: Twin agrees with the viewer, Other disagrees.
	mine := []int{9, 8, 3, 10, 2}
	twins := []int{10, 8, 2, 9, 3}
	others := []int{2, 3, 9, 1, 10}
	for i := range mine {
		m := insertMovie(t, w.env, "Co "+string(rune('A'+i)))
		rateAs(t, viewer, vpid, m, mine[i])
		rateAs(t, twinU, twin, m, twins[i])
		rateAs(t, otherU, other, m, others[i])
	}
	twinPick := insertMovie(t, w.env, "Twin pick")
	otherPick := insertMovie(t, w.env, "Other pick")
	both := insertMovie(t, w.env, "Both liked")
	rateAs(t, twinU, twin, twinPick, 9)
	rateAs(t, otherU, other, otherPick, 9)
	rateAs(t, twinU, twin, both, 8)
	rateAs(t, otherU, other, both, 8)

	b := familyOf(t, viewer, vpid)
	members := b["members"].([]any)
	m0, m1 := members[0].(map[string]any), members[1].(map[string]any)
	if m0["name"] != "Twin" || m1["name"] != "Other" || num(m0["match"]) < 75 || num(m1["match"]) > 25 || num(m0["co_rated"]) != 5 {
		t.Fatalf("members %v", members)
	}
	items := familyItems(b)
	ids := mediaIDs(items)
	if len(ids) != 3 || ids[0] != both || indexOf(ids, twinPick) > indexOf(ids, otherPick) {
		t.Fatalf("ranking %v (both %s twin %s other %s)", ids, both, twinPick, otherPick)
	}
	if why := items[0]["why"].(map[string]any); num(why["liked_by"]) != 2 || len(why["people"].([]any)) != 2 {
		t.Fatalf("both why %v", why)
	}
}

// The family row is part of /foryou/rows (second row), with typed reasons
// and the members' match; its titles leave the other rows.
func TestFamilyRowInForYou(t *testing.T) {
	f := newFyEnv(t)
	bob, _ := f.env.NewUserClient("bob", "user")
	apid := f.sciFiProfile(t, f.alice, "Alice")
	bpid := f.romComProfile(t, bob, "Bob")
	kinds := func(res map[string]any) []string {
		var out []string
		for _, r := range res["rows"].([]any) {
			out = append(out, r.(map[string]any)["kind"].(string))
		}
		return out
	}
	if k := kinds(rowsOf(t, bob, bpid)); indexOf(k, "family") >= 0 {
		t.Fatalf("family row without sharing: %v", k)
	}
	share(t, f.alice, apid, true)
	res := rowsOf(t, bob, bpid)
	k := kinds(res)
	at := indexOf(k, "family")
	if at < 0 || at > 1 {
		t.Fatalf("family row at %d: %v", at, k)
	}
	row := res["rows"].([]any)[at].(map[string]any)
	if row["id"] != "family" || row["title"] != "Family picks" || row["reason"].(map[string]any)["type"] != "family" {
		t.Fatalf("row %v", row)
	}
	members := row["family"].(map[string]any)["members"].([]any)
	if len(members) != 1 || members[0].(map[string]any)["name"] != "Alice" {
		t.Fatalf("members %v", members)
	}
	famIDs := map[string]bool{}
	for _, it := range row["items"].([]any) {
		it := it.(map[string]any)
		r := it["reason"].(map[string]any)
		if r["type"] != "family" || r["family"] == nil || !strings.HasPrefix(r["text"].(string), "Alice") {
			t.Fatalf("item reason %v", r)
		}
		id := it["media"].(map[string]any)["id"].(string)
		if id == f.ids[1] {
			t.Fatal("bob rated tmdb 1: must not be suggested")
		}
		famIDs[id] = true
	}
	if len(famIDs) < 5 {
		t.Fatalf("family items %v", famIDs)
	}
	for i, r := range res["rows"].([]any) {
		if i == at {
			continue
		}
		for _, it := range r.(map[string]any)["items"].([]any) {
			if famIDs[it.(map[string]any)["media"].(map[string]any)["id"].(string)] {
				t.Fatalf("duplicate across rows in %v", r.(map[string]any)["id"])
			}
		}
	}
	bob.Do("PUT", "/api/v1/profiles/"+bpid+"/settings", map[string]any{"show_family": false}).Expect(200)
	if k := kinds(rowsOf(t, bob, bpid)); indexOf(k, "family") >= 0 {
		t.Fatalf("family row with show_family off: %v", k)
	}
}
