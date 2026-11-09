package server_test

import (
	"testing"

	"martytv/api/internal/testutil"
)

// «Кто видит чьи лайки»: the admin's per-pair overrides of share_with_family
// (internal/family/visibility.go) filter the family row, its members (taste
// match) and the title page's «Оценки семьи».
func TestFamilyVisibilityMatrix(t *testing.T) {
	w := newWatchEnv(t)
	alice, apid := w.alice, w.pid
	bob, _ := w.env.NewUserClient("bob", "user")
	dan, _ := w.env.NewUserClient("dan", "user")
	admin, _ := w.env.NewUserClient("boss", "admin")
	bpid := newProfile(t, bob, "Bob")
	dpid := newProfile(t, dan, "Dan")
	heat := insertMovie(t, w.env, "Heat")
	rateAs(t, alice, apid, heat, 9)

	sees := func(c *testutil.Client, viewer string) bool {
		t.Helper()
		b := familyOf(t, c, viewer)
		inRow := indexOf(mediaIDs(familyItems(b)), heat) >= 0
		members := len(b["members"].([]any)) > 0
		d := c.Do("GET", "/api/v1/profiles/"+viewer+"/family/media/"+heat, nil).Expect(200).JSON()
		detail := len(d["people"].([]any)) > 0
		if inRow != members || inRow != detail {
			t.Fatalf("row %v / members %v / detail %v disagree for %s", inRow, members, detail, viewer)
		}
		return inRow
	}
	cell := func(viewer, sharer string, allowed any) map[string]any {
		return map[string]any{"viewer_profile_id": viewer, "sharer_profile_id": sharer, "allowed": allowed}
	}
	put := func(changes ...map[string]any) map[string]any {
		t.Helper()
		return admin.Do("PUT", "/api/v1/admin/family-visibility", map[string]any{"changes": changes}).Expect(200).JSON()
	}

	// ---- admin only ----
	bob.Do("GET", "/api/v1/admin/family-visibility", nil).Expect(403)
	bob.Do("PUT", "/api/v1/admin/family-visibility", map[string]any{"changes": []any{cell(bpid, apid, true)}}).Expect(403)
	w.env.Client().Do("GET", "/api/v1/admin/family-visibility", nil).Expect(401)
	if sees(bob, bpid) {
		t.Fatal("a non-admin's PUT took effect")
	}

	// ---- defaults: the matrix mirrors share_with_family, no overrides ----
	m := admin.Do("GET", "/api/v1/admin/family-visibility", nil).Expect(200).JSON()
	byID := map[string]map[string]any{}
	for _, p := range m["profiles"].([]any) {
		byID[p.(map[string]any)["profile_id"].(string)] = p.(map[string]any)
	}
	if a := byID[apid]; a == nil || a["share_with_family"] != false || a["show_family"] != true || a["name"] != "Alice" || a["user_name"] != "alice" {
		t.Fatalf("alice in matrix %v", a)
	}
	if byID[bpid] == nil || byID[dpid] == nil || len(m["overrides"].([]any)) != 0 {
		t.Fatalf("matrix %v", m)
	}

	// ---- allow overrides sharing off, for that pair only ----
	m = put(cell(bpid, apid, true))
	if o := m["overrides"].([]any); len(o) != 1 || o[0].(map[string]any)["allowed"] != true {
		t.Fatalf("overrides %v", o)
	}
	if !sees(bob, bpid) || sees(dan, dpid) {
		t.Fatal("allow: bob must see Alice, dan must not")
	}

	// ---- deny overrides sharing on ----
	share(t, alice, apid, true)
	if !sees(dan, dpid) {
		t.Fatal("default on: dan sees Alice")
	}
	put(cell(dpid, apid, false))
	if sees(dan, dpid) || !sees(bob, bpid) {
		t.Fatal("deny: dan must not see Alice, bob still does")
	}

	// ---- sharing off again: bob's allow survives ----
	share(t, alice, apid, false)
	if !sees(bob, bpid) {
		t.Fatal("allow must not depend on share_with_family")
	}

	// ---- reset to default (null) ----
	m = put(cell(dpid, apid, nil), cell(bpid, apid, nil))
	if len(m["overrides"].([]any)) != 0 {
		t.Fatalf("reset %v", m["overrides"])
	}
	if sees(bob, bpid) || sees(dan, dpid) {
		t.Fatal("after reset: back to Alice's sharing off")
	}

	// ---- validation ----
	bad := func(changes ...any) {
		t.Helper()
		admin.Do("PUT", "/api/v1/admin/family-visibility", map[string]any{"changes": changes}).Expect(422)
	}
	bad()
	bad(cell(apid, apid, true))
	bad(cell("nope", apid, true))
	bad(cell(bpid, "00000000-0000-0000-0000-000000000001", true))
}
