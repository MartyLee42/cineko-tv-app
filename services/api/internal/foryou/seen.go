package foryou

import (
	"context"
	"time"
)

// Idle profiles: the daily run skips profiles that haven't opened their
// recommendations for idleAfter (no AI tokens spent on nobody). Their first
// visit after that rebuilds the AI collections in the background (a run
// with trigger "return"); foryou.updated then refreshes the screen.

const (
	idleAfter = 24 * time.Hour
	// seenEvery throttles the seen_at write (Rows is called often).
	seenEvery = 5 * time.Minute
	// freshCollections: newer personal AI collections need no catch-up
	// (an admin or the viewer regenerated them meanwhile).
	freshCollections = 20 * time.Hour
)

// touchSeen records a visit. prev is the last visit (the profile's creation
// before the first one); ok is false when the write was throttled.
func (s *Service) touchSeen(ctx context.Context, profileID string) (prev time.Time, ok bool, err error) {
	now := s.now()
	err = s.pool.QueryRow(ctx, `
		WITH old AS (
			SELECT COALESCE((SELECT seen_at FROM foryou_seen WHERE profile_id = $1),
			                (SELECT created_at FROM profiles WHERE id = $1)) AS at),
		up AS (
			INSERT INTO foryou_seen (profile_id, seen_at) VALUES ($1, $2)
			ON CONFLICT (profile_id) DO UPDATE SET seen_at = EXCLUDED.seen_at
			WHERE foryou_seen.seen_at < $3
			RETURNING 1)
		SELECT COALESCE((SELECT at FROM old), $2), EXISTS (SELECT 1 FROM up)`,
		profileID, now, now.Add(-seenEvery)).Scan(&prev, &ok)
	return prev, ok, err
}

// noteVisit runs on GET /foryou/rows: after an idle period the profile's
// AI collections are rebuilt (they were skipped by the daily run).
func (s *Service) noteVisit(ctx context.Context, profileID string) {
	prev, ok, err := s.touchSeen(ctx, profileID)
	if err != nil {
		s.log.WarnContext(ctx, "foryou: could not record visit", "err", err)
		return
	}
	if !ok || s.ai == nil || s.now().Sub(prev) <= idleAfter {
		return
	}
	var fresh bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM foryou_collections WHERE profile_id = $1 AND generated_at > $2)`,
		profileID, s.now().Add(-freshCollections)).Scan(&fresh); err != nil || fresh {
		return
	}
	if _, err := s.startProfileRegen(ctx, profileID, "return", ""); err != nil {
		s.log.WarnContext(ctx, "foryou: catch-up after idle not started", "err", err)
	}
}

// activeProfiles keeps the profiles seen within idleAfter (never-seen ones
// count from their creation), in order.
func (s *Service) activeProfiles(ctx context.Context, ids []string) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id FROM profiles p LEFT JOIN foryou_seen fs ON fs.profile_id = p.id
		WHERE p.id = ANY($1) AND COALESCE(fs.seen_at, p.created_at) > $2
		ORDER BY p.created_at, p.id`, ids, s.now().Add(-idleAfter))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
