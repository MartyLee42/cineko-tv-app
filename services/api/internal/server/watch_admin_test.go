package server_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestAdminActivityAndHistory(t *testing.T) {
	w := newWatchEnv(t)
	admin, _ := w.env.NewUserClient("root", "admin")
	aliceUser := w.alice.Do("GET", "/api/v1/auth/session", nil).Expect(200).JSON()["user"].(map[string]any)
	kid := newProfile(t, w.alice, "Kid")
	m1, m2 := insertMovie(t, w.env, "On TV"), insertMovie(t, w.env, "In Browser")
	series, eps := insertSeries(t, w.env, "Show")

	// Browser session playing m2.
	sid := startSession(t, w.alice, map[string]any{"profile_id": w.pid, "media_id": m2})["id"].(string)
	report(t, w.alice, sid, 0, 120, 6000, "playing")
	// TV playing m1 (session + live state), and an episode for history.
	devID, cred := w.env.Pair(w.alice, "Living room")
	tvc := deviceClient(w.env, cred)
	tsid := startSession(t, tvc, map[string]any{"profile_id": kid, "media_id": m1})["id"].(string)
	report(t, tvc, tsid, 0, 40, 100, "playing")
	esid := startSession(t, tvc, map[string]any{"profile_id": kid, "media_id": series, "episode_id": eps["S1E1"]})["id"].(string)
	report(t, tvc, esid, 0, 300, 2400, "stopped")

	phone := dialUser(t, w.env, w.alice)
	tv := dialDevice(t, w.env, cred)
	tv.send(msg{Type: "device.state", Payload: json.RawMessage(fmt.Sprintf(
		`{"screen":"player","profile_id":%q,"media_id":%q,"playback":{"media_id":%q,"title":"On TV","position_seconds":42,"duration_seconds":100,"paused":true,"buffering":false}}`,
		kid, m1, m1))})
	phone.expect("device.state")

	w.alice.Do("GET", "/api/v1/admin/activity/now", nil).Expect(403)
	items := admin.Do("GET", "/api/v1/admin/activity/now", nil).Expect(200).Items()
	if len(items) != 2 {
		t.Fatalf("activity %v", items)
	}
	byMedia := map[string]map[string]any{}
	for _, it := range items {
		byMedia[it["media"].(map[string]any)["id"].(string)] = it
	}
	tvItem, web := byMedia[m1], byMedia[m2]
	if tvItem["state"] != "paused" || num(tvItem["position_seconds"]) != 42 || tvItem["player"] != "builtin" ||
		tvItem["device"].(map[string]any)["id"] != devID || tvItem["device"].(map[string]any)["online"] != true ||
		tvItem["profile"].(map[string]any)["name"] != "Kid" || tvItem["user"].(map[string]any)["username"] != "alice" {
		t.Fatalf("tv activity %v", tvItem)
	}
	if web["state"] != "playing" || web["device"] != nil || num(web["position_seconds"]) != 120 ||
		web["profile"].(map[string]any)["id"] != w.pid {
		t.Fatalf("browser activity %v", web)
	}
	// Ended sessions drop out.
	report(t, w.alice, sid, 1, 130, 6000, "stopped")
	if items := admin.Do("GET", "/api/v1/admin/activity/now", nil).Expect(200).Items(); len(items) != 1 {
		t.Fatalf("after stop %v", items)
	}

	// History across all profiles of the user.
	w.alice.Do("GET", "/api/v1/admin/users/"+aliceUser["id"].(string)+"/history", nil).Expect(403)
	h := admin.Do("GET", "/api/v1/admin/users/"+aliceUser["id"].(string)+"/history?limit=2", nil).Expect(200).JSON()
	hi := h["items"].([]any)
	if len(hi) != 2 || h["next_cursor"] == nil {
		t.Fatalf("admin history %v", h)
	}
	first := hi[0].(map[string]any)
	if first["profile"].(map[string]any)["name"] != "Alice" || first["device_name"] != nil {
		t.Fatalf("newest history %v", first)
	}
	second := hi[1].(map[string]any)
	if second["profile"].(map[string]any)["name"] != "Kid" || second["device_name"] != "Living room" ||
		num(second["progress"].(map[string]any)["episode_number"]) != 1 {
		t.Fatalf("tv history %v", second)
	}
	h2 := admin.Do("GET", "/api/v1/admin/users/"+aliceUser["id"].(string)+"/history?cursor="+h["next_cursor"].(string), nil).Expect(200).JSON()
	if len(h2["items"].([]any)) != 1 || h2["next_cursor"] != nil {
		t.Fatalf("history page 2 %v", h2)
	}
	admin.Do("GET", "/api/v1/admin/users/00000000-0000-0000-0000-000000000000/history", nil).Expect(404)
}

func TestAdminMessages(t *testing.T) {
	w := newWatchEnv(t)
	admin, _ := w.env.NewUserClient("root", "admin")
	bob, _ := w.env.NewUserClient("bob", "user")
	aliceID := w.alice.Do("GET", "/api/v1/auth/session", nil).Expect(200).JSON()["user"].(map[string]any)["id"].(string)
	_, cred := w.env.Pair(w.alice, "TV")
	phone := dialUser(t, w.env, w.alice)
	tv := dialDevice(t, w.env, cred)
	bobPhone := dialUser(t, w.env, bob)

	w.alice.Do("POST", "/api/v1/admin/messages", map[string]any{"title": "x", "body": "y"}).Expect(403)
	admin.Do("POST", "/api/v1/admin/messages", map[string]any{"title": "", "body": "y"}).Expect(422)
	admin.Do("POST", "/api/v1/admin/messages", map[string]any{"title": "t", "body": string(make([]byte, 1001))}).Expect(422)
	admin.Do("POST", "/api/v1/admin/messages", map[string]any{"title": "t", "body": "b", "user_ids": []string{"00000000-0000-0000-0000-000000000000"}}).Expect(422)

	sent := admin.Do("POST", "/api/v1/admin/messages", map[string]any{"title": "Maintenance", "body": "Tonight at 23:00",
		"user_ids": []string{aliceID}, "show_on_tv": true}).Expect(201).JSON()
	if num(sent["recipients"]) != 1 || sent["show_on_tv"] != true {
		t.Fatalf("sent %v", sent)
	}
	for _, conn := range []*wsConn{phone, tv} {
		m := conn.expect("message")
		var p map[string]any
		_ = json.Unmarshal(m.Payload, &p)
		if p["id"] != sent["id"] || p["title"] != "Maintenance" || p["from_name"] != "root" || p["read_at"] != nil {
			t.Fatalf("delivered %v", p)
		}
	}
	bobPhone.expectNone("message", 200*time.Millisecond)

	// Broadcast without TV display: everyone but the sender, not on TVs.
	all := admin.Do("POST", "/api/v1/admin/messages", map[string]any{"title": "Hello", "body": "All", "show_on_tv": false}).Expect(201).JSON()
	if num(all["recipients"]) != 2 {
		t.Fatalf("broadcast %v", all)
	}
	phone.expect("message")
	bobPhone.expect("message")
	tv.expectNone("message", 200*time.Millisecond)

	inbox := w.alice.Do("GET", "/api/v1/messages", nil).Expect(200).JSON()
	if len(inbox["items"].([]any)) != 2 || num(inbox["unread"]) != 2 {
		t.Fatalf("inbox %v", inbox)
	}
	tvc := deviceClient(w.env, cred)
	tvInbox := tvc.Do("GET", "/api/v1/messages", nil).Expect(200).JSON()
	if len(tvInbox["items"].([]any)) != 1 || num(tvInbox["unread"]) != 1 {
		t.Fatalf("tv inbox %v", tvInbox)
	}
	tvc.Do("POST", "/api/v1/messages/"+all["id"].(string)+"/read", nil).Expect(404) // not shown on TV
	tvc.Do("POST", "/api/v1/messages/"+sent["id"].(string)+"/read", nil).Expect(204)
	bob.Do("POST", "/api/v1/messages/"+sent["id"].(string)+"/read", nil).Expect(404)
	w.alice.Do("POST", "/api/v1/messages/"+all["id"].(string)+"/read", nil).Expect(204)
	w.alice.Do("POST", "/api/v1/messages/"+all["id"].(string)+"/read", nil).Expect(204) // idempotent
	if n := num(w.alice.Do("GET", "/api/v1/messages", nil).JSON()["unread"]); n != 0 {
		t.Fatalf("unread %v", n)
	}

	list := admin.Do("GET", "/api/v1/admin/messages", nil).Expect(200).Items()
	if len(list) != 2 || list[0]["id"] != all["id"] || num(list[0]["read_count"]) != 1 || num(list[0]["recipients"]) != 2 ||
		num(list[1]["read_count"]) != 1 {
		t.Fatalf("admin list %v", list)
	}
	w.alice.Do("GET", "/api/v1/admin/messages", nil).Expect(403)

	// Rate limit: 20 per hour per admin (2 sent so far).
	code := 0
	for range 19 {
		code = admin.Do("POST", "/api/v1/admin/messages", map[string]any{"title": "spam", "body": "x", "user_ids": []string{aliceID}, "show_on_tv": false}).Status
	}
	if code != 429 {
		t.Fatalf("rate limit status %d", code)
	}
}
