package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"martytv/api/internal/testutil"
)

func sessionUserID(t *testing.T, c *testutil.Client) string {
	t.Helper()
	return c.Do("GET", "/api/v1/auth/session", nil).Expect(200).JSON()["user"].(map[string]any)["id"].(string)
}

func TestRecommendations(t *testing.T) {
	w := newWatchEnv(t)
	alice := w.alice
	bob, _ := w.env.NewUserClient("bob", "user")
	carol, _ := w.env.NewUserClient("carol", "user")
	dave, daveU := w.env.NewUserClient("dave", "user")
	aliceID, bobID, carolID := sessionUserID(t, alice), sessionUserID(t, bob), sessionUserID(t, carol)
	bobPid := newProfile(t, bob, "Bob")
	movie := insertMovie(t, w.env, "Heat")
	other := insertMovie(t, w.env, "Ronin")
	ctx := context.Background()

	// Bob has watched-state on the title; nobody but his profile may see it.
	bob.Do("PUT", "/api/v1/profiles/"+bobPid+"/lists/watchlist/"+movie, nil).Expect(204)

	_, cred := w.env.Pair(bob, "Bob TV")
	bobPhone := dialUser(t, w.env, bob)
	bobTV := dialDevice(t, w.env, cred)
	carolPhone := dialUser(t, w.env, carol)
	alicePhone := dialUser(t, w.env, alice)

	// ---- validation ----
	post := func(c *testutil.Client, body map[string]any) *testutil.Response {
		return c.Do("POST", "/api/v1/recommendations?lang=en", body)
	}
	post(alice, map[string]any{"media_id": movie, "to_user_ids": []string{}}).Expect(422)
	post(alice, map[string]any{"media_id": "nope", "to_user_ids": []string{bobID}}).Expect(422)
	post(alice, map[string]any{"media_id": movie, "to_user_ids": []string{"x"}}).Expect(422)
	post(alice, map[string]any{"media_id": movie, "to_user_ids": []string{bobID}, "note": strings.Repeat("я", 501)}).Expect(422)
	many := make([]string, 21)
	for i := range many {
		many[i] = "00000000-0000-0000-0000-0000000000" + string(rune('1'+i/10)) + string(rune('0'+i%10))
	}
	post(alice, map[string]any{"media_id": movie, "to_user_ids": many}).Expect(422)
	unknown := post(alice, map[string]any{"media_id": movie, "to_user_ids": []string{"00000000-0000-0000-0000-000000000000"}}).Expect(422)
	self := post(alice, map[string]any{"media_id": movie, "to_user_ids": []string{aliceID}}).Expect(422)
	if _, err := w.env.Pool.Exec(ctx, `UPDATE users SET disabled_at = now() WHERE id = $1`, daveU.ID); err != nil {
		t.Fatal(err)
	}
	disabled := post(alice, map[string]any{"media_id": movie, "to_user_ids": []string{daveU.ID}}).Expect(422)
	fieldsOf := func(r *testutil.Response) string {
		b, _ := json.Marshal(r.JSON()["error"].(map[string]any)["fields"])
		return string(b)
	}
	if fieldsOf(unknown) != fieldsOf(self) || fieldsOf(self) != fieldsOf(disabled) {
		t.Fatalf("recipient errors differ: %s / %s / %s", unknown.Body, self.Body, disabled.Body)
	}
	_ = dave
	post(alice, map[string]any{"media_id": movie, "to_user_ids": []string{bobID}, "from_profile_id": bobPid}).Expect(422)
	post(alice, map[string]any{"media_id": "00000000-0000-0000-0000-000000000000", "to_user_ids": []string{bobID}}).Expect(404)
	tvc := deviceClient(w.env, cred)
	tvc.Do("POST", "/api/v1/recommendations", map[string]any{"media_id": movie, "to_user_ids": []string{aliceID}}).Expect(403)

	// ---- send to two users ----
	res := post(alice, map[string]any{"media_id": movie, "to_user_ids": []string{bobID, carolID, bobID},
		"note": "  Must see!  ", "from_profile_id": w.pid}).Expect(201).Items()
	if len(res) != 2 {
		t.Fatalf("created %v", res)
	}
	var toBob map[string]any
	for _, r := range res {
		from := r["from"].(map[string]any)
		if r["note"] != "Must see!" || from["user_id"] != aliceID || from["name"] != "Alice" || from["color"] == "" ||
			r["seen_at"] != nil || r["reaction"] != nil || r["media"].(map[string]any)["title"] != "Heat" {
			t.Fatalf("created item %v", r)
		}
		if _, ok := r["media"].(map[string]any)["me"]; ok {
			t.Fatalf("sender sees recipient state: %v", r)
		}
		if r["to"].(map[string]any)["user_id"] == bobID {
			toBob = r
		}
	}
	if toBob == nil || toBob["to"].(map[string]any)["name"] != "bob" {
		t.Fatalf("no item for bob: %v", res)
	}
	recoID := toBob["id"].(string)

	// Realtime: bob's phone and TV, carol's phone; not alice.
	for _, conn := range []*wsConn{bobPhone, bobTV} {
		m := conn.expect("recommendation")
		var p map[string]any
		_ = json.Unmarshal(m.Payload, &p)
		if p["id"] != recoID || p["note"] != "Must see!" || p["from"].(map[string]any)["name"] != "Alice" {
			t.Fatalf("delivered %v", p)
		}
	}
	carolPhone.expect("recommendation")
	alicePhone.expectNone("recommendation", 200*time.Millisecond)

	// ---- inbox ----
	inbox := bob.Do("GET", "/api/v1/recommendations/inbox?lang=en&profile_id="+bobPid, nil).Expect(200).JSON()
	items := inbox["items"].([]any)
	if len(items) != 1 || num(inbox["unseen"]) != 1 {
		t.Fatalf("bob inbox %v", inbox)
	}
	me := items[0].(map[string]any)["media"].(map[string]any)["me"].(map[string]any)
	if me["in_watchlist"] != true {
		t.Fatalf("bob's own state missing: %v", me)
	}
	bob.Do("GET", "/api/v1/recommendations/inbox?profile_id="+w.pid, nil).Expect(404) // not his profile
	bob.Do("GET", "/api/v1/recommendations/inbox?lang=de", nil).Expect(422)
	if in := alice.Do("GET", "/api/v1/recommendations/inbox", nil).Expect(200).JSON(); len(in["items"].([]any)) != 0 || num(in["unseen"]) != 0 {
		t.Fatalf("alice inbox %v", in)
	}
	// TV credential reads its owner's inbox.
	tvIn := tvc.Do("GET", "/api/v1/recommendations/inbox", nil).Expect(200).JSON()
	if len(tvIn["items"].([]any)) != 1 || num(tvIn["unseen"]) != 1 {
		t.Fatalf("tv inbox %v", tvIn)
	}
	tvc.Do("GET", "/api/v1/recommendations/sent", nil).Expect(403)
	tvc.Do("PATCH", "/api/v1/recommendations/"+recoID, map[string]any{"seen": true}).Expect(403)

	// ---- privacy: a third user sees nothing ----
	if in := carol.Do("GET", "/api/v1/recommendations/inbox", nil).Expect(200).JSON(); len(in["items"].([]any)) != 1 ||
		in["items"].([]any)[0].(map[string]any)["id"] == recoID {
		t.Fatalf("carol inbox %v", in)
	}
	carol.Do("PATCH", "/api/v1/recommendations/"+recoID, map[string]any{"seen": true}).Expect(404)
	carol.Do("DELETE", "/api/v1/recommendations/"+recoID, nil).Expect(404)
	if s := carol.Do("GET", "/api/v1/recommendations/sent", nil).Expect(200).Items(); len(s) != 0 {
		t.Fatalf("carol sent %v", s)
	}

	// ---- PATCH: recipient only ----
	alice.Do("PATCH", "/api/v1/recommendations/"+recoID, map[string]any{"seen": true}).Expect(404)
	bob.Do("PATCH", "/api/v1/recommendations/"+recoID, map[string]any{"reaction": "love"}).Expect(422)
	bob.Do("PATCH", "/api/v1/recommendations/"+recoID, map[string]any{"reply": strings.Repeat("x", 301)}).Expect(422)
	seen := bob.Do("PATCH", "/api/v1/recommendations/"+recoID, map[string]any{"seen": true}).Expect(200).JSON()
	if seen["seen_at"] == nil || seen["reaction"] != nil {
		t.Fatalf("seen %v", seen)
	}
	alicePhone.expectNone("recommendation.reaction", 150*time.Millisecond)
	if n := num(bob.Do("GET", "/api/v1/recommendations/inbox", nil).JSON()["unseen"]); n != 0 {
		t.Fatalf("unseen after seen %v", n)
	}
	reacted := bob.Do("PATCH", "/api/v1/recommendations/"+recoID+"?lang=en", map[string]any{"reaction": "like", "reply": "Thanks!"}).Expect(200).JSON()
	if reacted["reaction"] != "like" || reacted["reply"] != "Thanks!" {
		t.Fatalf("reacted %v", reacted)
	}
	ev := alicePhone.expect("recommendation.reaction")
	var evp map[string]any
	_ = json.Unmarshal(ev.Payload, &evp)
	if evp["id"] != recoID || evp["reaction"] != "like" {
		t.Fatalf("reaction event %v", evp)
	}

	// Sender sees the reaction in /sent.
	sent := alice.Do("GET", "/api/v1/recommendations/sent?lang=en", nil).Expect(200).Items()
	if len(sent) != 2 || sent[0]["id"] != recoID || sent[0]["reaction"] != "like" || sent[0]["reply"] != "Thanks!" {
		t.Fatalf("alice sent %v", sent)
	}

	// ---- de-dupe within 7 days: the note is updated ----
	again := post(alice, map[string]any{"media_id": movie, "to_user_ids": []string{bobID}, "note": "Really!"}).Expect(201).Items()
	if len(again) != 1 || again[0]["id"] != recoID || again[0]["note"] != "Really!" || again[0]["seen_at"] != nil ||
		again[0]["from"].(map[string]any)["name"] != "alice" {
		t.Fatalf("dedupe %v", again)
	}
	bobPhone.expect("recommendation")
	var count int
	if err := w.env.Pool.QueryRow(ctx, `SELECT count(*) FROM recommendations WHERE to_user_id = $1`, bobID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("rows %d %v", count, err)
	}
	// Older than 7 days → a new recommendation.
	if _, err := w.env.Pool.Exec(ctx, `UPDATE recommendations SET created_at = now() - interval '8 days' WHERE id = $1`, recoID); err != nil {
		t.Fatal(err)
	}
	fresh := post(alice, map[string]any{"media_id": movie, "to_user_ids": []string{bobID}}).Expect(201).Items()
	if fresh[0]["id"] == recoID {
		t.Fatal("expected a new recommendation after 7 days")
	}
	freshID := fresh[0]["id"].(string)
	post(alice, map[string]any{"media_id": other, "to_user_ids": []string{bobID}}).Expect(201)
	if in := bob.Do("GET", "/api/v1/recommendations/inbox", nil).JSON(); len(in["items"].([]any)) != 3 || num(in["unseen"]) != 3 {
		t.Fatalf("bob inbox after more %v", in)
	}

	// ---- DELETE: recipient dismisses, sender withdraws ----
	bob.Do("DELETE", "/api/v1/recommendations/"+recoID, nil).Expect(204)
	if in := bob.Do("GET", "/api/v1/recommendations/inbox", nil).JSON(); len(in["items"].([]any)) != 2 {
		t.Fatalf("after dismiss %v", in)
	}
	bob.Do("PATCH", "/api/v1/recommendations/"+recoID, map[string]any{"seen": true}).Expect(404)
	if s := alice.Do("GET", "/api/v1/recommendations/sent", nil).Items(); len(s) != 4 {
		t.Fatalf("sender still sees dismissed: %v", s)
	}
	alice.Do("DELETE", "/api/v1/recommendations/"+freshID, nil).Expect(204)
	alice.Do("DELETE", "/api/v1/recommendations/"+freshID, nil).Expect(404)
	if in := bob.Do("GET", "/api/v1/recommendations/inbox", nil).JSON(); len(in["items"].([]any)) != 1 {
		t.Fatalf("after withdraw %v", in)
	}

	// Audit.
	var audits int
	if err := w.env.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = 'reco.sent'`).Scan(&audits); err != nil || audits != 4 {
		t.Fatalf("audit %d %v", audits, err)
	}
}

func TestRecommendationsRateLimit(t *testing.T) {
	w := newWatchEnv(t)
	bob, _ := w.env.NewUserClient("bob", "user")
	bobID := sessionUserID(t, bob)
	movie := insertMovie(t, w.env, "Heat")
	code := 0
	for range 61 {
		code = w.alice.Do("POST", "/api/v1/recommendations", map[string]any{"media_id": movie, "to_user_ids": []string{bobID}}).Status
	}
	if code != 429 {
		t.Fatalf("rate limit status %d", code)
	}
}
