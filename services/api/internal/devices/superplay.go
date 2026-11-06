package devices

import (
	"context"
	"errors"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/db"
	"martytv/api/internal/httpx"
)

// ViaAdmin is Device.via for a device a super_admin reaches only through the
// role (not owned by them, not shared with them).
const ViaAdmin = "admin"

// DeviceOwner is Device.owner in GET /devices?scope=all.
type DeviceOwner struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
}

// CanControlAny reports whether p may control every device: a super_admin
// browser session, or an API token of one carrying the admin scope. TVs never.
func CanControlAny(p *auth.Principal) bool {
	return p != nil && p.Kind != auth.KindDevice && p.IsSuperAdmin() && p.HasScope(auth.ScopeAdmin)
}

// selectAny lists every active device for a super_admin ($1): own and shared
// keep their real access; everyone else's are `control` via the role.
const selectAny = `
	SELECT d.id, d.owner_user_id, u.username, d.name, d.platform, d.default_profile_id,
	       d.created_at, d.last_seen_at,
	       CASE WHEN d.owner_user_id = $1 THEN 'owner' ELSE coalesce(dp.permission, 'control') END,
	       u.display_name,
	       (d.owner_user_id <> $1 AND dp.user_id IS NULL)
	FROM devices d
	JOIN users u ON u.id = d.owner_user_id
	LEFT JOIN device_permissions dp ON dp.device_id = d.id AND dp.user_id = $1
	WHERE d.revoked_at IS NULL`

func scanAny(row interface{ Scan(...any) error }) (*Device, error) {
	var d Device
	var display string
	var viaAdmin bool
	err := row.Scan(&d.ID, &d.OwnerUserID, &d.OwnerUsername, &d.Name, &d.Platform, &d.DefaultProfileID,
		&d.CreatedAt, &d.LastSeenAt, &d.Access, &display, &viaAdmin)
	if db.IsNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	d.Owner = &DeviceOwner{ID: d.OwnerUserID, Username: d.OwnerUsername, DisplayName: display}
	if viaAdmin {
		d.Via = ViaAdmin
	}
	return &d, nil
}

// AccessFor is the one access check for TV commands (realtime and HTTP) and
// GET /devices/{id}/state: the caller's own access (owner / use / control),
// or — for a super_admin (CanControlAny) on anyone else's device — `control`
// with Via = ViaAdmin. Never grants `use` (the owner's profiles stay theirs).
// ErrNotFound when the caller may not reach the device.
func (s *Store) AccessFor(ctx context.Context, p *auth.Principal, deviceID string) (*Device, error) {
	d, err := s.GetForUser(ctx, p.UserID, deviceID)
	if !errors.Is(err, ErrNotFound) || !CanControlAny(p) {
		return d, err
	}
	return scanAny(s.q.QueryRow(ctx, selectAny+` AND d.id = $2`, p.UserID, deviceID))
}

// ListAllFor is GET /devices?scope=all for a super_admin: own devices first,
// then shared ones, then everyone else's (Via = ViaAdmin) grouped by owner.
func (s *Store) ListAllFor(ctx context.Context, userID string) ([]Device, error) {
	rows, err := s.q.Query(ctx, selectAny+`
		ORDER BY (d.owner_user_id = $1) DESC, (dp.user_id IS NOT NULL) DESC,
		         lower(u.username), d.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		d, err := scanAny(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// listScoped serves GET /devices: ?scope=all (super_admin only) lists every
// device; no scope lists the caller's own and shared ones.
func (h *Handlers) listScoped(c fiber.Ctx) ([]Device, error) {
	p := auth.PrincipalFrom(c)
	switch c.Query("scope") {
	case "":
		return h.store.ListForUser(c.Context(), p.UserID)
	case "all":
		if !CanControlAny(p) {
			return nil, httpx.NewError(fiber.StatusForbidden, "super_admin_required", "Only a super admin can do this.")
		}
		return h.store.ListAllFor(c.Context(), p.UserID)
	default:
		return nil, httpx.Validation(map[string]string{"scope": "must be all"})
	}
}
