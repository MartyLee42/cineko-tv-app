package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"martytv/api/internal/testutil"
)

func clientEvent(app, kind, msg string, extra ...map[string]any) map[string]any {
	ev := map[string]any{
		"app": app, "kind": kind, "message": msg, "release": "test-1",
		"stack":      "Error: " + msg + "\n    at boom (https://h/assets/index-Bx7k_2aQ.js:1:2)",
		"url":        "/media/1?token=secret#x",
		"user_agent": "TestAgent/1.0",
	}
	for _, x := range extra {
		for k, v := range x {
			ev[k] = v
		}
	}
	return ev
}

func batch(events ...map[string]any) map[string]any { return map[string]any{"events": events} }

func listErrors(t *testing.T, c *testutil.Client, query string) []map[string]any {
	t.Helper()
	return c.Do("GET", "/api/v1/admin/client-errors"+query, nil).Expect(200).Items()
}

func TestClientErrorsIngestAndAuth(t *testing.T) {
	env := testutil.New(t)
	admin, _ := env.NewUserClient("root", "admin")
	alice, aliceUser := env.NewUserClient("alice", "user")

	// Anonymous: 401.
	env.Client().Do("POST", "/api/v1/client-errors", batch(clientEvent("web", "error", "x"))).Expect(401)

	// A signed-in user reports twice the same error (different ids) → one group, count 3.
	profiles := alice.Do("GET", "/api/v1/profiles", nil).Expect(200).Items()
	pid := profiles[0]["id"].(string)
	r := alice.Do("POST", "/api/v1/client-errors", batch(
		clientEvent("web", "error", "Media 11 failed for alice@example.com", map[string]any{"profile_id": pid, "extra": map[string]any{"password": "hunter2", "n": 1}}),
		clientEvent("web", "error", "Media 42 failed for alice@example.com", map[string]any{"count": 2}),
	)).Expect(202).JSON()
	if r["accepted"] != float64(2) {
		t.Fatalf("accepted %v", r)
	}
	items := listErrors(t, admin, "")
	if len(items) != 1 || items[0]["count"] != float64(3) || items[0]["users_affected"] != float64(1) || items[0]["app"] != "web" {
		t.Fatalf("groups %v", items)
	}
	g := items[0]
	if strings.Contains(g["message"].(string), "alice@") || g["last_url"] != "/media/1#x" || g["last_release"] != "test-1" || g["status"] != "unresolved" {
		t.Fatalf("group not scrubbed: %v", g)
	}
	detail := admin.Do("GET", "/api/v1/admin/client-errors/"+g["id"].(string), nil).Expect(200).JSON()
	samples := detail["samples"].([]any)
	if len(samples) != 2 {
		t.Fatalf("samples %v", samples)
	}
	oldest := samples[1].(map[string]any)
	if u := oldest["user"].(map[string]any); u["id"] != aliceUser.ID || oldest["profile_name"] == nil || oldest["user_agent"] != "TestAgent/1.0" {
		t.Fatalf("sample %v", oldest)
	}
	if ex := oldest["extra"].(map[string]any); ex["password"] != "[redacted]" || ex["n"] != float64(1) {
		t.Fatalf("extra %v", ex)
	}
	body, _ := json.Marshal(detail)
	for _, secret := range []string{"secret", "hunter2", "alice@example.com"} {
		if strings.Contains(string(body), secret) {
			t.Fatalf("%q leaked: %s", secret, body)
		}
	}

	// A paired TV may report; its device is recorded.
	devID, cred := env.Pair(alice, "Lounge TV")
	tv := env.Client()
	tv.Bearer = cred
	tv.Do("POST", "/api/v1/client-errors", batch(clientEvent("tv", "player", "MEDIA_ERR_DECODE", map[string]any{"device_model": "Samsung Tizen 4.0"}))).Expect(202)
	tvItems := listErrors(t, admin, "?app=tv")
	if len(tvItems) != 1 || tvItems[0]["devices_affected"] != float64(1) || tvItems[0]["kind"] != "player" {
		t.Fatalf("tv groups %v", tvItems)
	}
	tvDetail := admin.Do("GET", "/api/v1/admin/client-errors/"+tvItems[0]["id"].(string), nil).Expect(200).JSON()
	s0 := tvDetail["samples"].([]any)[0].(map[string]any)
	if d := s0["device"].(map[string]any); d["id"] != devID || d["name"] != "Lounge TV" || s0["device_model"] != "Samsung Tizen 4.0" {
		t.Fatalf("tv sample %v", s0)
	}
	if n := len(listErrors(t, admin, "?device_id="+devID)); n != 1 {
		t.Fatalf("device filter %d", n)
	}
	if n := len(listErrors(t, admin, "?user_id="+aliceUser.ID)); n != 2 {
		t.Fatalf("user filter %d", n)
	}

	// API tokens with read may report.
	tok := alice.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "t", "scopes": []string{"read"}}).Expect(201).JSON()["secret"].(string)
	bot := env.Client()
	bot.Bearer = tok
	bot.Do("POST", "/api/v1/client-errors", batch(clientEvent("web", "console", "from a token"))).Expect(202)

	// sendBeacon: text/plain body, cookie session without X-CSRF-Token (Origin still checked).
	raw, _ := json.Marshal(batch(clientEvent("web", "error", "beacon flush")))
	alice.CSRF, alice.Origin = "", env.Origin
	alice.Do("POST", "/api/v1/client-errors", json.RawMessage(raw), "Content-Type", "text/plain;charset=UTF-8").Expect(202)
	alice.Origin = "https://evil.example"
	alice.Do("POST", "/api/v1/client-errors", json.RawMessage(raw)).Expect(403)
	if n := len(listErrors(t, admin, "?q=beacon")); n != 1 {
		t.Fatalf("beacon group %d", n)
	}

	// Non-admins and TVs can't read the admin views.
	alice.Origin = env.Origin
	alice.Do("GET", "/api/v1/admin/client-errors", nil).Expect(403)
	alice.Do("GET", "/api/v1/admin/client-errors/"+g["id"].(string), nil).Expect(403)
	tv.Do("GET", "/api/v1/admin/client-errors", nil).Expect(403)
	env.Client().Do("GET", "/api/v1/admin/client-errors", nil).Expect(401)
}

func TestClientErrorsLimits(t *testing.T) {
	env := testutil.New(t)
	c, _ := env.NewUserClient("alice", "user")
	admin, _ := env.NewUserClient("root", "admin")
	post := func(body any) *testutil.Response { return c.Do("POST", "/api/v1/client-errors", body) }

	post(batch()).Expect(422)
	many := make([]map[string]any, 21)
	for i := range many {
		many[i] = clientEvent("web", "error", "e")
	}
	post(batch(many...)).Expect(422)
	post(batch(clientEvent("api", "error", "spoofed"))).Expect(422)
	post(batch(clientEvent("web", "nope", "x"))).Expect(422)
	post(batch(clientEvent("web", "error", "x", map[string]any{"profile_id": "not-a-uuid"}))).Expect(422)
	post(json.RawMessage(`{"events": [`)).Expect(400)
	post(batch(clientEvent("web", "error", strings.Repeat("x", 70<<10)))).Expect(413)

	// Oversized fields are truncated, not rejected; big extra is dropped.
	post(batch(clientEvent("web", "error", strings.Repeat("m", 5000), map[string]any{
		"stack": strings.Repeat("s", 20000), "extra": map[string]any{"blob": strings.Repeat("b", 3000)},
	}))).Expect(202)
	g := listErrors(t, admin, "")[0]
	if n := len(g["message"].(string)); n > 1100 {
		t.Fatalf("message %d bytes", n)
	}
	d := admin.Do("GET", "/api/v1/admin/client-errors/"+g["id"].(string), nil).Expect(200).JSON()
	s := d["samples"].([]any)[0].(map[string]any)
	if len(s["stack"].(string)) > 8300 || s["extra"] != nil {
		t.Fatalf("stack %d extra %v", len(s["stack"].(string)), s["extra"])
	}

	// Only the last 20 samples per group are kept; the count keeps going.
	for i := 0; i < 3; i++ {
		evs := make([]map[string]any, 10)
		for j := range evs {
			evs[j] = clientEvent("web", "error", "repeat")
		}
		post(batch(evs...)).Expect(202)
	}
	g = listErrors(t, admin, "?q=repeat")[0]
	d = admin.Do("GET", "/api/v1/admin/client-errors/"+g["id"].(string), nil).Expect(200).JSON()
	if g["count"] != float64(30) || len(d["samples"].([]any)) != 20 {
		t.Fatalf("count %v samples %d", g["count"], len(d["samples"].([]any)))
	}
	var stored int
	if err := env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM client_error_samples WHERE group_id = $1`, g["id"]).Scan(&stored); err != nil || stored != 20 {
		t.Fatalf("stored samples %d %v", stored, err)
	}
}

func TestClientErrorsRateLimitDrops(t *testing.T) {
	env := testutil.New(t)
	env.Server.ClientLog.SetLimits(5, 8, time.Minute)
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	admin, _ := env.NewUserClient("root", "admin")
	evs := make([]map[string]any, 4)
	for i := range evs {
		evs[i] = clientEvent("web", "error", "flood")
	}
	if r := alice.Do("POST", "/api/v1/client-errors", batch(evs...)).Expect(202).JSON(); r["accepted"] != float64(4) {
		t.Fatalf("first %v", r)
	}
	// Per-user budget (5): one more accepted, the rest dropped silently with 202.
	if r := alice.Do("POST", "/api/v1/client-errors", batch(evs...)).Expect(202).JSON(); r["accepted"] != float64(1) {
		t.Fatalf("second %v", r)
	}
	if r := alice.Do("POST", "/api/v1/client-errors", batch(evs...)).Expect(202).JSON(); r["accepted"] != float64(0) {
		t.Fatalf("third %v", r)
	}
	// Global budget (8): bob gets the remaining 3.
	if r := bob.Do("POST", "/api/v1/client-errors", batch(evs...)).Expect(202).JSON(); r["accepted"] != float64(3) {
		t.Fatalf("bob %v", r)
	}
	if g := listErrors(t, admin, ""); len(g) != 1 || g[0]["count"] != float64(8) {
		t.Fatalf("groups %v", g)
	}
}

func TestClientErrorsResolveRegressionAndFilters(t *testing.T) {
	env := testutil.New(t)
	admin, _ := env.NewUserClient("root", "admin")
	alice, _ := env.NewUserClient("alice", "user")
	ws := dialUser(t, env, admin)

	alice.Do("POST", "/api/v1/client-errors", batch(
		clientEvent("web", "error", "alpha broke"),
		clientEvent("web", "unhandledrejection", "beta rejected"),
		clientEvent("web", "unhandledrejection", "beta rejected"),
		clientEvent("web", "unhandledrejection", "beta rejected"),
	)).Expect(202)
	var ev map[string]any
	for i := 0; i < 2; i++ { // one per new group
		_ = json.Unmarshal(ws.expect("client_error.new").Payload, &ev)
		if ev["app"] != "web" || ev["regressed"] != false {
			t.Fatalf("realtime %v", ev)
		}
	}

	if n := len(listErrors(t, admin, "?kind=unhandledrejection")); n != 1 {
		t.Fatalf("kind filter %d", n)
	}
	byCount := listErrors(t, admin, "?sort=count")
	if byCount[0]["message"] != "beta rejected" {
		t.Fatalf("sort by count %v", byCount)
	}
	page := admin.Do("GET", "/api/v1/admin/client-errors?limit=1&offset=1", nil).Expect(200).JSON()
	if page["total"] != float64(2) || len(page["items"].([]any)) != 1 {
		t.Fatalf("page %v", page)
	}
	future := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	if n := len(listErrors(t, admin, "?since="+future)); n != 0 {
		t.Fatalf("since filter %d", n)
	}
	if n := len(listErrors(t, admin, "?q=ALPHA")); n != 1 {
		t.Fatalf("q filter %d", n)
	}
	if n := len(listErrors(t, admin, "?q=%25")); n != 0 {
		t.Fatalf("q must escape LIKE wildcards: %d", n)
	}
	admin.Do("GET", "/api/v1/admin/client-errors?app=desktop", nil).Expect(422)
	admin.Do("GET", "/api/v1/admin/client-errors?sort=random", nil).Expect(422)

	alpha := listErrors(t, admin, "?q=alpha")[0]
	id := alpha["id"].(string)
	res := admin.Do("PATCH", "/api/v1/admin/client-errors/"+id, map[string]bool{"resolved": true}).Expect(200).JSON()
	if res["status"] != "resolved" || res["resolved_at"] == nil || res["regressed"] != false {
		t.Fatalf("resolve %v", res)
	}
	if n := len(listErrors(t, admin, "")); n != 1 {
		t.Fatalf("unresolved %d", n)
	}
	if n := len(listErrors(t, admin, "?status=resolved")); n != 1 {
		t.Fatalf("resolved %d", n)
	}
	if n := len(listErrors(t, admin, "?status=all")); n != 2 {
		t.Fatalf("all %d", n)
	}

	// It happens again: reopened and regressed, admins are told.
	alice.Do("POST", "/api/v1/client-errors", batch(clientEvent("web", "error", "alpha broke"))).Expect(202)
	_ = json.Unmarshal(ws.expect("client_error.new").Payload, &ev)
	if ev["id"] != id || ev["regressed"] != true {
		t.Fatalf("regression event %v", ev)
	}
	again := admin.Do("GET", "/api/v1/admin/client-errors/"+id, nil).Expect(200).JSON()["group"].(map[string]any)
	if again["status"] != "unresolved" || again["regressed"] != true || again["count"] != float64(2) {
		t.Fatalf("regressed %v", again)
	}
	// Resolving again clears the flag; reopening by hand does not set it.
	admin.Do("PATCH", "/api/v1/admin/client-errors/"+id, map[string]bool{"resolved": true}).Expect(200)
	if r := admin.Do("PATCH", "/api/v1/admin/client-errors/"+id, map[string]bool{"resolved": false}).Expect(200).JSON(); r["status"] != "unresolved" || r["regressed"] != false {
		t.Fatalf("reopen %v", r)
	}
	admin.Do("PATCH", "/api/v1/admin/client-errors/"+id, map[string]any{}).Expect(422)

	admin.Do("DELETE", "/api/v1/admin/client-errors/"+id, nil).Expect(204)
	admin.Do("GET", "/api/v1/admin/client-errors/"+id, nil).Expect(404)
	admin.Do("DELETE", "/api/v1/admin/client-errors/"+id, nil).Expect(404)
	admin.Do("PATCH", "/api/v1/admin/client-errors/"+id, map[string]bool{"resolved": true}).Expect(404)
	alice.Do("PATCH", "/api/v1/admin/client-errors/"+id, map[string]bool{"resolved": true}).Expect(403)
	alice.Do("DELETE", "/api/v1/admin/client-errors/"+id, nil).Expect(403)
}

func TestClientErrorsRetention(t *testing.T) {
	env := testutil.New(t)
	admin, _ := env.NewUserClient("root", "admin")
	alice, _ := env.NewUserClient("alice", "user")
	alice.Do("POST", "/api/v1/client-errors", batch(clientEvent("web", "error", "old"), clientEvent("web", "error", "ancient"), clientEvent("web", "error", "fresh"))).Expect(202)
	ctx := context.Background()
	exec := func(q string) {
		t.Helper()
		if _, err := env.Pool.Exec(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	// "old": samples 31 days old, group seen recently. "ancient": unseen for 61 days.
	exec(`UPDATE client_error_samples s SET received_at = now() - interval '31 days' FROM client_error_groups g WHERE g.id = s.group_id AND g.message IN ('old', 'ancient')`)
	exec(`UPDATE client_error_groups SET last_seen = now() - interval '61 days' WHERE message = 'ancient'`)
	exec(`UPDATE client_error_affected a SET last_seen = now() - interval '61 days' FROM client_error_groups g WHERE g.id = a.group_id AND g.message = 'ancient'`)
	if err := env.Server.ClientLog.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	items := listErrors(t, admin, "?status=all")
	msgs := map[string]map[string]any{}
	for _, it := range items {
		msgs[it["message"].(string)] = it
	}
	if len(items) != 2 || msgs["old"] == nil || msgs["fresh"] == nil {
		t.Fatalf("groups after cleanup %v", items)
	}
	d := admin.Do("GET", "/api/v1/admin/client-errors/"+msgs["old"]["id"].(string), nil).Expect(200).JSON()
	if n := len(d["samples"].([]any)); n != 0 {
		t.Fatalf("old samples %d", n)
	}
	d = admin.Do("GET", "/api/v1/admin/client-errors/"+msgs["fresh"]["id"].(string), nil).Expect(200).JSON()
	if n := len(d["samples"].([]any)); n != 1 {
		t.Fatalf("fresh samples %d", n)
	}
}

// The API's own 5xx responses land in the same store as app "api".
func TestClientErrorsAPIHook(t *testing.T) {
	env := testutil.New(t)
	admin, _ := env.NewUserClient("root", "admin")
	alice, aliceUser := env.NewUserClient("alice", "user")
	// Break one table so the inbox handler fails with an unhandled error.
	if _, err := env.Pool.Exec(context.Background(), `DROP TABLE message_recipients CASCADE`); err != nil {
		t.Fatal(err)
	}
	r := alice.Do("GET", "/api/v1/messages", nil).Expect(500)
	reqID := r.JSON()["error"].(map[string]any)["request_id"].(string)
	// 4xx are not recorded.
	alice.Do("GET", "/api/v1/admin/users", nil).Expect(403)

	var items []map[string]any
	for i := 0; i < 50; i++ {
		items = listErrors(t, admin, "?app=api")
		if len(items) > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if len(items) != 1 {
		t.Fatalf("api groups %v", items)
	}
	g := items[0]
	if g["kind"] != "api" || g["component"] != "GET /api/v1/messages" || !strings.HasPrefix(g["message"].(string), "500 internal: ") || g["last_release"] != "dev" {
		t.Fatalf("api group %v", g)
	}
	d := admin.Do("GET", "/api/v1/admin/client-errors/"+g["id"].(string), nil).Expect(200).JSON()
	s := d["samples"].([]any)[0].(map[string]any)
	if s["request_id"] != reqID || s["url"] != "/api/v1/messages" || s["user"].(map[string]any)["id"] != aliceUser.ID {
		t.Fatalf("api sample %v", s)
	}
}

// Filter by user: the groups a user hit, with their own counts and times;
// a TV's errors count for its owner.
func TestClientErrorsUserFilter(t *testing.T) {
	env := testutil.New(t)
	admin, _ := env.NewUserClient("root", "admin")
	alice, aliceUser := env.NewUserClient("alice", "user")
	bob, bobUser := env.NewUserClient("bob", "user")

	alice.Do("POST", "/api/v1/client-errors", batch(
		clientEvent("web", "error", "shared boom", map[string]any{"count": 3}),
		clientEvent("web", "error", "alice only"),
	)).Expect(202)
	bob.Do("POST", "/api/v1/client-errors", batch(clientEvent("web", "error", "shared boom"), clientEvent("web", "error", "shared boom"))).Expect(202)
	devID, cred := env.Pair(bob, "Bob TV")
	tv := env.Client()
	tv.Bearer = cred
	tv.Do("POST", "/api/v1/client-errors", batch(clientEvent("tv", "player", "tv boom", map[string]any{"count": 4}))).Expect(202)

	all := listErrors(t, admin, "?q=shared")
	if len(all) != 1 || all[0]["count"] != float64(5) || all[0]["users_affected"] != float64(2) {
		t.Fatalf("unfiltered %v", all)
	}
	gid := all[0]["id"].(string)

	bobs := listErrors(t, admin, "?user_id="+bobUser.ID+"&sort=count")
	if len(bobs) != 2 || bobs[0]["message"] != "tv boom" || bobs[0]["count"] != float64(4) || bobs[0]["devices_affected"] != float64(1) ||
		bobs[1]["count"] != float64(2) || bobs[1]["users_affected"] != float64(1) || bobs[1]["devices_affected"] != float64(0) {
		t.Fatalf("bob groups %v", bobs)
	}
	alices := listErrors(t, admin, "?user_id="+aliceUser.ID+"&sort=count")
	if len(alices) != 2 || alices[0]["message"] != "shared boom" || alices[0]["count"] != float64(3) {
		t.Fatalf("alice groups %v", alices)
	}
	page := admin.Do("GET", "/api/v1/admin/client-errors?user_id="+aliceUser.ID+"&limit=1", nil).Expect(200).JSON()
	if page["total"] != float64(2) || len(page["items"].([]any)) != 1 {
		t.Fatalf("page %v", page)
	}
	if n := len(listErrors(t, admin, "?user_id="+bobUser.ID+"&device_id="+devID)); n != 1 {
		t.Fatalf("user+device %d", n)
	}
	// Last seen is the user's own: move Bob's back and filter by since.
	if _, err := env.Pool.Exec(context.Background(),
		`UPDATE client_error_affected SET last_seen = now() - interval '3 days' WHERE kind = 'u' AND subject_id = $1`, bobUser.ID); err != nil {
		t.Fatal(err)
	}
	since := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	if n := len(listErrors(t, admin, "?user_id="+bobUser.ID+"&since="+since)); n != 0 {
		t.Fatalf("bob since %d", n)
	}
	if n := len(listErrors(t, admin, "?q=shared&since="+since)); n != 1 {
		t.Fatalf("group since %d", n)
	}

	// The detail: that user's view and samples only.
	d := admin.Do("GET", "/api/v1/admin/client-errors/"+gid+"?user_id="+bobUser.ID, nil).Expect(200).JSON()
	samples := d["samples"].([]any)
	if g := d["group"].(map[string]any); g["count"] != float64(2) || len(samples) != 2 {
		t.Fatalf("bob detail %v", d)
	}
	for _, s := range samples {
		if s.(map[string]any)["user"].(map[string]any)["id"] != bobUser.ID {
			t.Fatalf("foreign sample %v", s)
		}
	}
	if n := len(admin.Do("GET", "/api/v1/admin/client-errors/"+gid, nil).Expect(200).JSON()["samples"].([]any)); n != 3 {
		t.Fatalf("all samples %d", n)
	}
	aliceOnly := listErrors(t, admin, "?q=alice")[0]["id"].(string)
	admin.Do("GET", "/api/v1/admin/client-errors/"+aliceOnly+"?user_id="+bobUser.ID, nil).Expect(404)
	admin.Do("GET", "/api/v1/admin/client-errors/"+gid+"?user_id=nope", nil).Expect(422)
	admin.Do("GET", "/api/v1/admin/client-errors?user_id=nope", nil).Expect(422)

	// Users who have errors, for the filter.
	users := admin.Do("GET", "/api/v1/admin/client-errors/users", nil).Expect(200).Items()
	if len(users) != 2 || users[0]["id"] != aliceUser.ID || users[0]["groups"] != float64(2) ||
		users[1]["id"] != bobUser.ID || users[1]["groups"] != float64(2) || users[1]["username"] != "bob" {
		t.Fatalf("users %v", users)
	}
	alice.Do("GET", "/api/v1/admin/client-errors/users", nil).Expect(403)
	tv.Do("GET", "/api/v1/admin/client-errors/users", nil).Expect(403)
	env.Client().Do("GET", "/api/v1/admin/client-errors/users", nil).Expect(401)
}
