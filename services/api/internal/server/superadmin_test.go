package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"martytv/api/internal/realtime"
	"martytv/api/internal/testutil"
	"martytv/api/internal/users"
)

// Role matrix: user < admin < super_admin over the admin endpoints.
func TestRoleMatrix(t *testing.T) {
	env := testutil.New(t)
	user, _ := env.NewUserClient("alice", "user")
	admin, _ := env.NewUserClient("root", "admin")
	super, _ := env.NewUserClient("marty", "super_admin")

	// Every admin can use these; regular users can't.
	adminGets := []string{
		"/api/v1/admin/users", "/api/v1/admin/integrations", "/api/v1/admin/appearance",
		"/api/v1/admin/activity/now", "/api/v1/admin/client-errors", "/api/v1/admin/sources",
		"/api/v1/admin/foryou/runs", "/api/v1/admin/iptv/playlists", "/api/v1/admin/system",
	}
	for _, path := range adminGets {
		user.Do("GET", path, nil).Expect(403)
		for name, c := range map[string]*testutil.Client{"admin": admin, "super_admin": super} {
			if r := c.Do("GET", path, nil); r.Status == 401 || r.Status == 403 {
				t.Fatalf("%s GET %s: %d %s", name, path, r.Status, r.Body)
			}
		}
	}
	// Only super_admins see other people's devices and pairing requests.
	for _, path := range []string{"/api/v1/admin/devices", "/api/v1/admin/pairing", "/api/v1/admin/pairing/assignees"} {
		user.Do("GET", path, nil).Expect(403)
		if r := admin.Do("GET", path, nil).Expect(403); r.ErrorCode() != "super_admin_required" {
			t.Fatalf("admin %s: %s", path, r.ErrorCode())
		}
		super.Do("GET", path, nil).Expect(200)
	}
	someID := "00000000-0000-0000-0000-000000000001"
	admin.Do("POST", "/api/v1/admin/pairing/"+someID+"/reject", nil).Expect(403)
	admin.Do("POST", "/api/v1/admin/devices/"+someID+"/revoke-credential", nil).Expect(403)
	admin.Do("DELETE", "/api/v1/admin/devices/"+someID, nil).Expect(403)
	admin.Do("PATCH", "/api/v1/admin/devices/"+someID, map[string]string{"name": "x"}).Expect(403)
	super.Do("DELETE", "/api/v1/admin/devices/"+someID, nil).Expect(404)

	// The session reports the role; super_admins may mint admin tokens, and
	// an admin-scoped token keeps the role's limits.
	if r := super.Do("GET", "/api/v1/auth/session", nil).Expect(200).JSON(); r["user"].(map[string]any)["role"] != "super_admin" {
		t.Fatalf("session %v", r)
	}
	tok := func(c *testutil.Client) *testutil.Client {
		res := c.Do("POST", "/api/v1/auth/tokens", map[string]any{"name": "ops", "scopes": []string{"read", "admin"}}).Expect(201).JSON()
		bot := env.Client()
		bot.Bearer = res["secret"].(string)
		return bot
	}
	tok(super).Do("GET", "/api/v1/admin/devices", nil).Expect(200)
	adminBot := tok(admin)
	adminBot.Do("GET", "/api/v1/admin/users", nil).Expect(200)
	adminBot.Do("GET", "/api/v1/admin/devices", nil).Expect(403)
}

func TestRoleChangeRules(t *testing.T) {
	env := testutil.New(t)
	super, superUser := env.NewUserClient("marty", "super_admin")
	admin, adminUser := env.NewUserClient("root", "admin")
	_, bobUser := env.NewUserClient("bob", "user")
	_, otherAdmin := env.NewUserClient("ops", "admin")
	patch := func(c *testutil.Client, id string, body any) *testutil.Response {
		return c.Do("PATCH", "/api/v1/admin/users/"+id, body)
	}
	code := func(r *testutil.Response, status int, want string) {
		t.Helper()
		if r.Expect(status); r.ErrorCode() != want {
			t.Fatalf("want %s, got %s (%s)", want, r.ErrorCode(), r.Body)
		}
	}

	// A plain admin manages regular users: disable/enable, reset password…
	patch(admin, bobUser.ID, map[string]bool{"disabled": true}).Expect(200)
	patch(admin, bobUser.ID, map[string]bool{"disabled": false}).Expect(200)
	admin.Do("POST", "/api/v1/admin/users/"+bobUser.ID+"/password", map[string]string{"password": "new-password-123"}).Expect(204)
	admin.Do("POST", "/api/v1/admin/users", map[string]string{"username": "kid", "password": "kid-password-123"}).Expect(201)
	// …but never grants admin, nor touches administrators.
	code(patch(admin, bobUser.ID, map[string]string{"role": "admin"}), 403, "super_admin_required")
	code(patch(admin, bobUser.ID, map[string]string{"role": "super_admin"}), 403, "super_admin_required")
	code(admin.Do("POST", "/api/v1/admin/users", map[string]string{"username": "boss", "password": "boss-password-123", "role": "admin"}), 403, "super_admin_required")
	code(patch(admin, otherAdmin.ID, map[string]bool{"disabled": true}), 403, "super_admin_required")
	code(patch(admin, otherAdmin.ID, map[string]string{"role": "user"}), 403, "super_admin_required")
	code(patch(admin, superUser.ID, map[string]bool{"disabled": true}), 403, "super_admin_required")
	code(patch(admin, superUser.ID, map[string]string{"role": "user"}), 403, "super_admin_required")
	code(admin.Do("POST", "/api/v1/admin/users/"+superUser.ID+"/password", map[string]string{"password": "hijack-password-1"}), 403, "super_admin_required")
	code(admin.Do("POST", "/api/v1/admin/users/"+otherAdmin.ID+"/password", map[string]string{"password": "hijack-password-1"}), 403, "super_admin_required")
	// No self-promotion or self-demotion; a display name is fine.
	code(patch(admin, adminUser.ID, map[string]string{"role": "super_admin"}), 409, "self_lockout")
	patch(admin, adminUser.ID, map[string]string{"display_name": "Root"}).Expect(200)

	// A super_admin grants and revokes admin and super_admin.
	if r := patch(super, bobUser.ID, map[string]string{"role": "admin"}).Expect(200).JSON(); r["role"] != "admin" {
		t.Fatalf("role %v", r["role"])
	}
	patch(super, bobUser.ID, map[string]string{"role": "super_admin"}).Expect(200)
	patch(super, bobUser.ID, map[string]string{"role": "user"}).Expect(200)
	patch(super, otherAdmin.ID, map[string]bool{"disabled": true}).Expect(200)
	super.Do("POST", "/api/v1/admin/users", map[string]string{"username": "deputy", "password": "deputy-password-1", "role": "super_admin"}).Expect(201)
	patch(super, bobUser.ID, map[string]string{"role": "boss"}).Expect(422)

	// The audit log records the role change.
	var n int
	if err := env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events WHERE action = 'admin.user_role_changed' AND target_id = $1`, bobUser.ID).Scan(&n); err != nil || n != 3 {
		t.Fatalf("audit %d %v", n, err)
	}

	// No self-demotion for a super_admin either.
	code(patch(super, superUser.ID, map[string]string{"role": "admin"}), 409, "self_lockout")
	code(patch(super, superUser.ID, map[string]bool{"disabled": true}), 409, "self_lockout")
}

// Over HTTP the acting super_admin is always active, so the last one can only
// be removed by itself, which self_lockout refuses; the store guard (below
// and in the CLI test) covers the rest.
func TestLastSuperAdminProtected(t *testing.T) {
	env := testutil.New(t)
	a, aUser := env.NewUserClient("marty", "super_admin")
	b, bUser := env.NewUserClient("deputy", "super_admin")
	// Two super_admins: one may demote the other…
	a.Do("PATCH", "/api/v1/admin/users/"+bUser.ID, map[string]string{"role": "admin"}).Expect(200)
	// …and the remaining one can't be removed: not by the (now plain) admin…
	if r := b.Do("PATCH", "/api/v1/admin/users/"+aUser.ID, map[string]string{"role": "admin"}).Expect(403); r.ErrorCode() != "super_admin_required" {
		t.Fatalf("got %s", r.ErrorCode())
	}
	b.Do("PATCH", "/api/v1/admin/users/"+aUser.ID, map[string]bool{"disabled": true}).Expect(403)
	// …nor by itself.
	if r := a.Do("PATCH", "/api/v1/admin/users/"+aUser.ID, map[string]string{"role": "user"}).Expect(409); r.ErrorCode() != "self_lockout" {
		t.Fatalf("got %s", r.ErrorCode())
	}
}

// The guard itself, without the HTTP layer's self/role checks in the way.
func TestGuardLockout(t *testing.T) {
	env := testutil.New(t)
	ctx := context.Background()
	store := users.NewStore(env.Pool)
	sa := env.CreateUser("marty", "password-marty-1", "super_admin")
	ad := env.CreateUser("root", "password-root-12", "admin")
	if err := store.GuardLockout(ctx, sa, "admin", false); err == nil || err.Error() != "at least one active super admin is required" {
		t.Fatalf("demote last super_admin: %v", err)
	}
	if err := store.GuardLockout(ctx, sa, "", true); err == nil {
		t.Fatal("disable last super_admin allowed")
	}
	if err := store.GuardLockout(ctx, ad, "user", false); err != nil {
		t.Fatalf("demote admin with a super_admin around: %v", err)
	}
	env.CreateUser("deputy", "password-deputy1", "super_admin")
	if err := store.GuardLockout(ctx, sa, "admin", false); err != nil {
		t.Fatalf("demote one of two: %v", err)
	}
}

func TestSuperAdminDevicesAndPairing(t *testing.T) {
	env := testutil.New(t)
	super, _ := env.NewUserClient("marty", "super_admin")
	alice, aliceUser := env.NewUserClient("alice", "user")
	env.NewUserClient("bob", "user")
	devID, cred := env.Pair(alice, "Alice TV")
	alice.Do("PUT", "/api/v1/devices/"+devID+"/permissions", map[string]string{"username": "bob", "permission": "control"}).Expect(200)

	// Live updates for the super_admin page.
	sock := dialUser(t, env, super)
	tvSock := dialDevice(t, env, cred)
	sock.expect("admin.devices.updated")

	list := super.Do("GET", "/api/v1/admin/devices", nil).Expect(200).Items()
	if len(list) != 1 {
		t.Fatalf("devices %v", list)
	}
	d := list[0]
	if d["id"] != devID || d["owner_username"] != "alice" || d["name"] != "Alice TV" || d["online"] != true || d["credential_active"] != true {
		t.Fatalf("device %v", d)
	}
	if shares := d["shares"].([]any); len(shares) != 1 || shares[0].(map[string]any)["username"] != "bob" {
		t.Fatalf("shares %v", d["shares"])
	}
	// Metadata only: no credentials or tokens anywhere.
	raw := string(super.Do("GET", "/api/v1/admin/devices", nil).Body)
	for _, bad := range []string{cred, "token_hash", "credential\""} {
		if bad != "" && contains(raw, bad) {
			t.Fatalf("leaked %q in %s", bad, raw)
		}
	}

	// Pending pairing requests from other people's TVs.
	tv2 := env.Client()
	start := tv2.Do("POST", "/api/v1/pairing", map[string]string{"device_name": "Kitchen", "platform": "tizen"}).Expect(201).JSON()
	pid := start["pairing_id"].(string)
	sock.expect("admin.devices.updated")
	reqs := super.Do("GET", "/api/v1/admin/pairing", nil).Expect(200).Items()
	var found map[string]any
	for _, r := range reqs {
		if r["id"] == pid {
			found = r
		}
	}
	if found == nil || found["status"] != "pending" || found["device_name"] != "Kitchen" || found["platform"] != "tizen" ||
		found["ip"] == "" || found["user_code"] != start["user_code"] {
		t.Fatalf("pairing %v", reqs)
	}
	if contains(string(super.Do("GET", "/api/v1/admin/pairing", nil).Body), start["poll_secret"].(string)) {
		t.Fatal("poll secret leaked")
	}
	// Reject: the TV sees denied; a second reject is gone.
	super.Do("POST", "/api/v1/admin/pairing/"+pid+"/reject", nil).Expect(204)
	if st := tv2.Do("GET", "/api/v1/pairing/"+pid, nil, "Authorization", "Pairing "+start["poll_secret"].(string)).JSON()["status"]; st != "denied" {
		t.Fatalf("status %v", st)
	}
	super.Do("POST", "/api/v1/admin/pairing/"+pid+"/reject", nil).Expect(410)
	for _, r := range super.Do("GET", "/api/v1/admin/pairing", nil).Expect(200).Items() {
		if r["id"] == pid && r["status"] != "denied" {
			t.Fatalf("after reject %v", r)
		}
	}
	// Cancel an approved request the TV hasn't exchanged yet.
	start3 := tv2.Do("POST", "/api/v1/pairing", map[string]string{"device_name": "Den"}).Expect(201).JSON()
	pid3 := start3["pairing_id"].(string)
	alice.Do("POST", "/api/v1/pairing/"+pid3+"/approve", map[string]any{}).Expect(204)
	super.Do("POST", "/api/v1/admin/pairing/"+pid3+"/reject", nil).Expect(204)
	tv2.Do("POST", "/api/v1/pairing/"+pid3+"/exchange", nil, "Authorization", "Pairing "+start3["poll_secret"].(string)).Expect(409)

	// Rename (owner sees it), then revoke the credential: the TV is disconnected.
	super.Do("PATCH", "/api/v1/admin/devices/"+devID, map[string]string{"name": "Гостиная"}).Expect(204)
	if got := alice.Do("GET", "/api/v1/devices/"+devID, nil).Expect(200).JSON()["name"]; got != "Гостиная" {
		t.Fatalf("name %v", got)
	}
	super.Do("PATCH", "/api/v1/admin/devices/"+devID, map[string]string{"name": " "}).Expect(422)
	super.Do("POST", "/api/v1/admin/devices/"+devID+"/revoke-credential", nil).Expect(204)
	tvSock.expectClosed()
	tv := env.Client()
	tv.Bearer = cred
	tv.Do("GET", "/api/v1/devices/me", nil).Expect(401)
	deadline := time.Now().Add(3 * time.Second)
	for {
		list = super.Do("GET", "/api/v1/admin/devices", nil).Expect(200).Items()
		if len(list) == 1 && list[0]["credential_active"] == false && list[0]["online"] == false {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("after revoke %v", list)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Delete: gone for the owner too.
	super.Do("DELETE", "/api/v1/admin/devices/"+devID, nil).Expect(204)
	alice.Do("GET", "/api/v1/devices/"+devID, nil).Expect(404)
	if l := super.Do("GET", "/api/v1/admin/devices", nil).Expect(200).Items(); len(l) != 0 {
		t.Fatalf("after delete %v", l)
	}

	// Every action is audited with the super_admin as actor.
	var n int
	if err := env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events
		WHERE action IN ('admin.device_renamed', 'admin.device_credential_revoked', 'admin.device_deleted', 'admin.pairing_rejected')
		  AND user_id <> $1`, aliceUser.ID).Scan(&n); err != nil || n != 5 {
		t.Fatalf("audit %d %v", n, err)
	}
}

// Plain admins' and users' sockets never get admin.devices.updated.
func TestAdminDevicesEventOnlyForSuperAdmins(t *testing.T) {
	env := testutil.New(t)
	old := realtime.AdminDevicesThrottle
	realtime.AdminDevicesThrottle = 50 * time.Millisecond
	t.Cleanup(func() { realtime.AdminDevicesThrottle = old })
	super, _ := env.NewUserClient("marty", "super_admin")
	admin, _ := env.NewUserClient("root", "admin")
	superSock := dialUser(t, env, super)
	adminSock := dialUser(t, env, admin)
	env.Client().Do("POST", "/api/v1/pairing", map[string]string{"device_name": "TV"}).Expect(201)
	m := superSock.expect("admin.devices.updated")
	var p map[string]string
	_ = json.Unmarshal(m.Payload, &p)
	if p["reason"] != "pairing.created" {
		t.Fatalf("payload %s", m.Payload)
	}
	adminSock.expectNone("admin.devices.updated", 300*time.Millisecond)

	// A burst is throttled into the first event plus one trailing event.
	for range 5 {
		env.Server.Hub.AdminDevicesChanged("burst")
	}
	superSock.expect("admin.devices.updated")
	superSock.expect("admin.devices.updated")
	superSock.expectNone("admin.devices.updated", 200*time.Millisecond)
}

func contains(s, sub string) bool { return sub != "" && strings.Contains(s, sub) }

// A super_admin accepts a pending TV and assigns it to someone else: the TV's
// exchange yields a device owned by that user.
func TestSuperAdminApprovesForUser(t *testing.T) {
	env := testutil.New(t)
	super, superUser := env.NewUserClient("marty", "super_admin")
	admin, _ := env.NewUserClient("root", "admin")
	alice, aliceUser := env.NewUserClient("alice", "user")
	_, bobUser := env.NewUserClient("bob", "user")
	_, carolUser := env.NewUserClient("carol", "user")
	aliceProf := alice.Do("POST", "/api/v1/profiles", map[string]string{"name": "Kids"}).Expect(201).JSON()["id"].(string)
	aliceSock := dialUser(t, env, alice)

	tv := env.Client()
	start := tv.Do("POST", "/api/v1/pairing", map[string]string{"device_name": "Bedroom", "platform": "webos"}).Expect(201).JSON()
	pid, secret := start["pairing_id"].(string), start["poll_secret"].(string)
	approve := func(c *testutil.Client, id string, body any) *testutil.Response {
		return c.Do("POST", "/api/v1/admin/pairing/"+id+"/approve", body)
	}

	// Plain admins can't; bad targets are refused.
	approve(admin, pid, map[string]any{"user_id": aliceUser.ID}).Expect(403)
	approve(super, pid, map[string]any{"user_id": "nope"}).Expect(422)
	approve(super, pid, map[string]any{"user_id": "00000000-0000-0000-0000-000000000009"}).Expect(422)
	super.Do("PATCH", "/api/v1/admin/users/"+carolUser.ID, map[string]bool{"disabled": true}).Expect(200)
	approve(super, pid, map[string]any{"user_id": carolUser.ID}).Expect(422)
	// A profile that isn't the target user's.
	foreignProf := ""
	if err := env.Pool.QueryRow(context.Background(), `SELECT id FROM profiles WHERE user_id = $1 LIMIT 1`, superUser.ID).Scan(&foreignProf); err != nil {
		foreignProf = "00000000-0000-0000-0000-00000000000a"
	}
	approve(super, pid, map[string]any{"user_id": aliceUser.ID, "default_profile_id": foreignProf}).Expect(422)
	approve(super, "00000000-0000-0000-0000-00000000000b", map[string]any{"user_id": aliceUser.ID}).Expect(410)

	// The picker lists enabled users with their profiles.
	var sawAlice bool
	for _, u := range super.Do("GET", "/api/v1/admin/pairing/assignees", nil).Expect(200).Items() {
		if u["username"] == "carol" {
			t.Fatal("disabled user offered")
		}
		if u["username"] == "alice" {
			for _, p := range u["profiles"].([]any) {
				sawAlice = sawAlice || p.(map[string]any)["id"] == aliceProf
			}
		}
	}
	if !sawAlice {
		t.Fatal("alice's profile missing from assignees")
	}
	// Approve for alice with her Kids profile and a new name.
	approve(super, pid, map[string]any{"user_id": aliceUser.ID, "device_name": "Детская", "default_profile_id": aliceProf}).Expect(204)
	aliceSock.expect("device.changed")
	for _, r := range super.Do("GET", "/api/v1/admin/pairing", nil).Expect(200).Items() {
		if r["id"] == pid && (r["status"] != "approved" || r["approved_by_username"] != "alice") {
			t.Fatalf("pairing %v", r)
		}
	}
	// Already approved → gone.
	approve(super, pid, map[string]any{"user_id": bobUser.ID}).Expect(410)
	res := tv.Do("POST", "/api/v1/pairing/"+pid+"/exchange", nil, "Authorization", "Pairing "+secret).Expect(200).JSON()
	dev := res["device"].(map[string]any)
	if dev["owner_user_id"] != aliceUser.ID || dev["name"] != "Детская" || dev["default_profile_id"] != aliceProf {
		t.Fatalf("device %v", dev)
	}
	if items := alice.Do("GET", "/api/v1/devices", nil).Expect(200).Items(); len(items) != 1 || items[0]["access"] != "owner" {
		t.Fatalf("alice devices %v", items)
	}
	// Consumed → gone.
	approve(super, pid, map[string]any{"user_id": bobUser.ID}).Expect(410)

	// Without a profile: the user's first one is used (created if none).
	if _, err := env.Pool.Exec(context.Background(), `DELETE FROM profiles WHERE user_id = $1`, bobUser.ID); err != nil {
		t.Fatal(err)
	}
	start2 := tv.Do("POST", "/api/v1/pairing", map[string]string{"device_name": "Garage"}).Expect(201).JSON()
	approve(super, start2["pairing_id"].(string), map[string]any{"user_id": bobUser.ID}).Expect(204)
	res2 := tv.Do("POST", "/api/v1/pairing/"+start2["pairing_id"].(string)+"/exchange", nil, "Authorization", "Pairing "+start2["poll_secret"].(string)).Expect(200).JSON()
	dev2 := res2["device"].(map[string]any)
	if dev2["owner_user_id"] != bobUser.ID || dev2["name"] != "Garage" || dev2["default_profile_id"] == nil {
		t.Fatalf("device %v", dev2)
	}

	// Expired requests can't be approved.
	start3 := tv.Do("POST", "/api/v1/pairing", map[string]string{"device_name": "Old"}).Expect(201).JSON()
	if _, err := env.Pool.Exec(context.Background(), `UPDATE pairing_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, start3["pairing_id"]); err != nil {
		t.Fatal(err)
	}
	approve(super, start3["pairing_id"].(string), map[string]any{"user_id": aliceUser.ID}).Expect(410)

	var n int
	if err := env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM audit_events WHERE action = 'pairing.admin_approved'
		AND user_id = $1 AND metadata->>'target_user_id' = $2 AND metadata->>'device_name' = 'Детская'`, superUser.ID, aliceUser.ID).Scan(&n); err != nil || n != 1 {
		t.Fatalf("audit %d %v", n, err)
	}
}
