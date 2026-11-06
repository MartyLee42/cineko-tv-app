package server_test

import (
	"context"
	"testing"
	"time"
)

// The daily run skips profiles idle for over a day; their next visit
// rebuilds the AI collections (a run with trigger "return").
func TestForYouIdleProfiles(t *testing.T) {
	f := newFyEnv(t)
	ctx := context.Background()
	active := f.sciFiProfile(t, f.alice, "Active")
	idle := f.sciFiProfile(t, f.alice, "Idle")
	rowsOf(t, f.alice, active)
	if _, err := f.env.Pool.Exec(ctx, `UPDATE profiles SET created_at = now() - interval '5 days' WHERE id = $1`, idle); err != nil {
		t.Fatal(err)
	}
	if _, err := f.env.Pool.Exec(ctx, `DELETE FROM foryou_seen WHERE profile_id = $1`, idle); err != nil {
		t.Fatal(err)
	}
	f.ai.set(aiJSON([]string{"Cerebral sci-fi", "Solaris|1972", "Stalker|1979", "Moon|2009", "Primer|2005", "Gattaca|1997", "Arrival|2016"}))

	collections := func(pid string) (n int) {
		_ = f.env.Pool.QueryRow(ctx, `SELECT count(*) FROM foryou_collections WHERE profile_id = $1`, pid).Scan(&n)
		return n
	}
	id, err := f.env.Server.ForYou.StartRun(ctx, "all", "", true, "schedule", "")
	if err != nil {
		t.Fatal(err)
	}
	waitRun(t, f.admin, id)
	if collections(active) == 0 || collections(idle) != 0 {
		t.Fatalf("daily run: active %d, idle %d collections", collections(active), collections(idle))
	}

	// The idle profile comes back: its AI collections are rebuilt.
	rowsOf(t, f.alice, idle)
	var runID string
	deadline := time.Now().Add(10 * time.Second)
	for runID == "" && time.Now().Before(deadline) {
		_ = f.env.Pool.QueryRow(ctx, `SELECT id FROM foryou_runs WHERE trigger = 'return' AND target_id = $1`, idle).Scan(&runID)
		time.Sleep(20 * time.Millisecond)
	}
	if runID == "" {
		t.Fatal("no catch-up run after the idle profile returned")
	}
	if r := waitRun(t, f.admin, runID); r["status"] != "completed" || collections(idle) == 0 {
		t.Fatalf("catch-up %v (%d collections)", r, collections(idle))
	}

	// Later visits (and an active profile's visits) start nothing.
	if _, err := f.env.Pool.Exec(ctx, `UPDATE foryou_seen SET seen_at = now() - interval '10 minutes'`); err != nil {
		t.Fatal(err)
	}
	rowsOf(t, f.alice, idle)
	rowsOf(t, f.alice, active)
	var n int
	_ = f.env.Pool.QueryRow(ctx, `SELECT count(*) FROM foryou_runs WHERE trigger = 'return'`).Scan(&n)
	if n != 1 {
		t.Fatalf("return runs %d", n)
	}
}
