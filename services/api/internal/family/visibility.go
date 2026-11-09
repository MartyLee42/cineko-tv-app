package family

import (
	"context"
	"fmt"
	"strings"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

// «Кто видит чьи лайки»: the admin's per-pair overrides (family_visibility).
// A pair (viewer, sharer) is visible when its override says so; without an
// override, when the sharer shares (share_with_family). The viewer's own
// show_family still hides the whole feature for that viewer.

// maxVisibilityChanges caps one PUT (a household has a handful of profiles).
const maxVisibilityChanges = 2500

// VisProfile is a profile of an enabled account in the admin matrix.
type VisProfile struct {
	Person
	UserID string `json:"user_id"`
	// ShareWithFamily is the column default; ShowFamily false means the
	// viewer hid the family row itself (cells have no effect for it).
	ShareWithFamily bool `json:"share_with_family"`
	ShowFamily      bool `json:"show_family"`
}

// Override is one admin cell: Allowed = true/false.
type Override struct {
	Viewer  string `json:"viewer_profile_id"`
	Sharer  string `json:"sharer_profile_id"`
	Allowed bool   `json:"allowed"`
}

// Visibility is GET /admin/family-visibility.
type Visibility struct {
	Profiles  []VisProfile `json:"profiles"`
	Overrides []Override   `json:"overrides"`
}

// VisChange sets (Allowed true/false) or clears (null) one cell.
type VisChange struct {
	Viewer  string `json:"viewer_profile_id"`
	Sharer  string `json:"sharer_profile_id"`
	Allowed *bool  `json:"allowed"`
}

// Visibility loads the matrix: profiles of enabled accounts (grouped by
// account, oldest first) and the overrides between them.
func (s *Service) Visibility(ctx context.Context) (*Visibility, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.name, p.avatar, p.color, u.id, COALESCE(NULLIF(u.display_name, ''), u.username),
		       COALESCE(ps.settings -> 'share_with_family' = 'true'::jsonb, false),
		       COALESCE(ps.settings -> 'show_family' <> 'false'::jsonb, true)
		FROM profiles p
		JOIN users u ON u.id = p.user_id
		LEFT JOIN profile_settings ps ON ps.profile_id = p.id
		WHERE u.disabled_at IS NULL
		ORDER BY u.created_at, u.id, p.created_at, p.id`)
	if err != nil {
		return nil, err
	}
	out := &Visibility{Profiles: []VisProfile{}, Overrides: []Override{}}
	for rows.Next() {
		var p VisProfile
		if err := rows.Scan(&p.ProfileID, &p.Name, &p.Avatar, &p.Color, &p.UserID, &p.UserName, &p.ShareWithFamily, &p.ShowFamily); err != nil {
			rows.Close()
			return nil, err
		}
		out.Profiles = append(out.Profiles, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = s.pool.Query(ctx, `
		SELECT v.viewer_profile_id, v.sharer_profile_id, v.allowed
		FROM family_visibility v
		JOIN profiles a ON a.id = v.viewer_profile_id JOIN users ua ON ua.id = a.user_id AND ua.disabled_at IS NULL
		JOIN profiles b ON b.id = v.sharer_profile_id JOIN users ub ON ub.id = b.user_id AND ub.disabled_at IS NULL
		ORDER BY 1, 2`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var o Override
		if err := rows.Scan(&o.Viewer, &o.Sharer, &o.Allowed); err != nil {
			return nil, err
		}
		out.Overrides = append(out.Overrides, o)
	}
	return out, rows.Err()
}

// SetVisibility applies changes atomically (null Allowed clears the cell).
func (s *Service) SetVisibility(ctx context.Context, by string, changes []VisChange) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var b pgx.Batch
	for _, c := range changes {
		if c.Allowed == nil {
			b.Queue(`DELETE FROM family_visibility WHERE viewer_profile_id = $1 AND sharer_profile_id = $2`, c.Viewer, c.Sharer)
			continue
		}
		b.Queue(`
			INSERT INTO family_visibility (viewer_profile_id, sharer_profile_id, allowed, updated_by, updated_at)
			VALUES ($1, $2, $3, $4, now())
			ON CONFLICT (viewer_profile_id, sharer_profile_id) DO UPDATE
			SET allowed = EXCLUDED.allowed, updated_by = EXCLUDED.updated_by, updated_at = now()`,
			c.Viewer, c.Sharer, *c.Allowed, nullUUID(by))
	}
	if err := tx.SendBatch(ctx, &b).Close(); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func nullUUID(id string) any {
	if id == "" {
		return nil
	}
	return id
}

// validateChanges checks shape and that every profile exists.
func (s *Service) validateChanges(ctx context.Context, changes []VisChange) error {
	if len(changes) == 0 {
		return httpx.Validation(map[string]string{"changes": "required (1…2500 cells)"})
	}
	if len(changes) > maxVisibilityChanges {
		return httpx.Validation(map[string]string{"changes": fmt.Sprintf("at most %d cells", maxVisibilityChanges)})
	}
	ids := map[string]bool{}
	for i, c := range changes {
		for _, id := range []string{c.Viewer, c.Sharer} {
			if _, err := uuid.Parse(id); err != nil || len(id) != 36 {
				return httpx.Validation(map[string]string{fmt.Sprintf("changes[%d]", i): "profile ids must be UUIDs"})
			}
		}
		if strings.EqualFold(c.Viewer, c.Sharer) {
			return httpx.Validation(map[string]string{fmt.Sprintf("changes[%d]", i): "viewer and sharer must differ"})
		}
		ids[strings.ToLower(c.Viewer)], ids[strings.ToLower(c.Sharer)] = true, true
	}
	list := make([]string, 0, len(ids))
	for id := range ids {
		list = append(list, id)
	}
	var n int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM profiles WHERE id = ANY($1::uuid[])`, list).Scan(&n); err != nil {
		return err
	}
	if n != len(list) {
		return httpx.Validation(map[string]string{"changes": "unknown profile"})
	}
	return nil
}

// AdminRoutes mounts /admin/family-visibility on the admin group.
func (s *Service) AdminRoutes(admin fiber.Router) {
	admin.Get("/family-visibility", func(c fiber.Ctx) error {
		v, err := s.Visibility(c.Context())
		if err != nil {
			return err
		}
		return c.JSON(v)
	})
	admin.Put("/family-visibility", func(c fiber.Ctx) error {
		var in struct {
			Changes []VisChange `json:"changes"`
		}
		if err := httpx.BindJSON(c, &in); err != nil {
			return err
		}
		if err := s.validateChanges(c.Context(), in.Changes); err != nil {
			return err
		}
		p := auth.PrincipalFrom(c)
		if err := s.SetVisibility(c.Context(), p.UserID, in.Changes); err != nil {
			return err
		}
		if s.audit != nil {
			set, cleared := 0, 0
			for _, ch := range in.Changes {
				if ch.Allowed == nil {
					cleared++
				} else {
					set++
				}
			}
			s.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "family_visibility.updated", TargetType: "family_visibility",
				IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: map[string]any{"set": set, "cleared": cleared}})
		}
		v, err := s.Visibility(c.Context())
		if err != nil {
			return err
		}
		return c.JSON(v)
	})
}
