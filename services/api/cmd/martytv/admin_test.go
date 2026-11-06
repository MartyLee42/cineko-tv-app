package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"martytv/api/internal/testutil"
	"martytv/api/internal/users"
)

func TestAdminSetRole(t *testing.T) {
	env := testutil.New(t)
	ctx := context.Background()
	store := users.NewStore(env.Pool)
	env.CreateUser("marty", "password-marty-1", "admin")
	run := func(args ...string) (string, error) {
		var out bytes.Buffer
		err := setRole(ctx, env.Pool, args, &out)
		return out.String(), err
	}

	// Promote the owner (what the lead runs after deploy).
	out, err := run("--username", "marty", "--role", "super_admin")
	if err != nil || !strings.Contains(out, "admin → super_admin") {
		t.Fatalf("%q %v", out, err)
	}
	if u, _ := store.ByUsername(ctx, "marty"); u.Role != "super_admin" {
		t.Fatalf("role %s", u.Role)
	}
	// Idempotent.
	if out, err := run("--username", "MARTY", "--role", "super_admin"); err != nil || !strings.Contains(out, "already") {
		t.Fatalf("%q %v", out, err)
	}
	// The last super_admin can't be demoted.
	if _, err := run("--username", "marty", "--role", "user"); err == nil || !strings.Contains(err.Error(), "super admin") {
		t.Fatalf("demoted the last super_admin: %v", err)
	}
	// Bad input.
	if _, err := run("--username", "marty", "--role", "owner"); err == nil {
		t.Fatal("accepted an unknown role")
	}
	if _, err := run("--username", "nobody", "--role", "admin"); err == nil {
		t.Fatal("accepted an unknown user")
	}
	// With a second super_admin, demotion works and is audited.
	env.CreateUser("deputy", "password-deputy1", "super_admin")
	if _, err := run("--username", "marty", "--role", "admin"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := env.Pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = 'admin.user_role_changed' AND metadata->>'via' = 'cli'`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("audit %d %v", n, err)
	}
}
