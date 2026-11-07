package devices

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/db"
	"martytv/api/internal/httpx"
)

// AdminDevice is one household TV as a super_admin sees it in Admin →
// «Устройства»: metadata only, never credentials or tokens.
type AdminDevice struct {
	ID                 string       `json:"id"`
	OwnerUserID        string       `json:"owner_user_id"`
	OwnerUsername      string       `json:"owner_username"`
	OwnerDisplayName   string       `json:"owner_display_name"`
	Name               string       `json:"name"`
	Platform           string       `json:"platform"`
	Model              string       `json:"model"`
	AppVersion         *string      `json:"app_version"`
	DefaultProfileID   *string      `json:"default_profile_id"`
	DefaultProfileName *string      `json:"default_profile_name"`
	CreatedAt          time.Time    `json:"created_at"`
	LastSeenAt         *time.Time   `json:"last_seen_at"`
	CredentialActive   bool         `json:"credential_active"`
	Online             bool         `json:"online"`
	Shares             []AdminShare `json:"shares"`
}

// AdminShare is another user's access to a device.
type AdminShare struct {
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Permission  string `json:"permission"`
}

// ListAll returns every active (not unpaired) device with its owner.
// Model and app version come from the TV's latest client report when there
// is one (client_error_samples), else the model falls back to the
// User-Agent seen at pairing.
func (s *Store) ListAll(ctx context.Context) ([]AdminDevice, error) {
	rows, err := s.q.Query(ctx, `
		SELECT d.id, d.owner_user_id, u.username, u.display_name, d.name, d.platform,
		       coalesce(nullif(cs.device_model, ''), d.user_agent), nullif(cs.release, ''),
		       d.default_profile_id, p.name, d.created_at, d.last_seen_at,
		       EXISTS (SELECT 1 FROM device_credentials dc WHERE dc.device_id = d.id AND dc.revoked_at IS NULL),
		       coalesce((SELECT json_agg(json_build_object('user_id', su.id, 'username', su.username,
		                 'display_name', su.display_name, 'permission', dp.permission) ORDER BY lower(su.username))
		                 FROM device_permissions dp JOIN users su ON su.id = dp.user_id
		                 WHERE dp.device_id = d.id), '[]'::json)
		FROM devices d
		JOIN users u ON u.id = d.owner_user_id
		LEFT JOIN profiles p ON p.id = d.default_profile_id
		LEFT JOIN LATERAL (
			SELECT s.device_model, s.release FROM client_error_samples s
			WHERE s.device_id = d.id ORDER BY s.id DESC LIMIT 1
		) cs ON true
		WHERE d.revoked_at IS NULL AND NOT d.demo
		ORDER BY lower(u.username), d.created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminDevice{}
	for rows.Next() {
		var d AdminDevice
		var shares []byte
		if err := rows.Scan(&d.ID, &d.OwnerUserID, &d.OwnerUsername, &d.OwnerDisplayName, &d.Name, &d.Platform,
			&d.Model, &d.AppVersion, &d.DefaultProfileID, &d.DefaultProfileName, &d.CreatedAt, &d.LastSeenAt,
			&d.CredentialActive, &shares); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(shares, &d.Shares); err != nil {
			return nil, err
		}
		if d.Shares == nil {
			d.Shares = []AdminShare{}
		}
		d.Model = truncate(d.Model, 160)
		out = append(out, d)
	}
	return out, rows.Err()
}

// AdminRename renames any active device.
func (s *Store) AdminRename(ctx context.Context, deviceID, name string) error {
	return s.exec(ctx, `UPDATE devices SET name = $2 WHERE id = $1 AND revoked_at IS NULL`, deviceID, name)
}

// RevokeCredentials invalidates every credential of an active device; the
// device stays listed (the TV has to pair again).
func (s *Store) RevokeCredentials(ctx context.Context, deviceID string) error {
	var ok bool
	if err := s.q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM devices WHERE id = $1 AND revoked_at IS NULL)`, deviceID).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	_, err := s.q.Exec(ctx, `UPDATE device_credentials SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`, deviceID)
	return err
}

// AdminDelete unpairs any device (as the owner's «Отвязать» does).
func (s *Store) AdminDelete(ctx context.Context, deviceID string) error {
	if err := s.exec(ctx, `UPDATE devices SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, deviceID); err != nil {
		return err
	}
	_, err := s.q.Exec(ctx, `UPDATE device_credentials SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`, deviceID)
	return err
}

func (s *Store) ownerOf(ctx context.Context, deviceID string) (string, error) {
	var owner string
	err := s.q.QueryRow(ctx, `SELECT owner_user_id FROM devices WHERE id = $1 AND revoked_at IS NULL`, deviceID).Scan(&owner)
	if db.IsNoRows(err) {
		return "", ErrNotFound
	}
	return owner, err
}

// AdminRoutes mounts the super_admin device views under the admin group:
// GET /admin/devices, PATCH/DELETE /admin/devices/{id},
// POST /admin/devices/{id}/revoke-credential. Every change is audited.
func (h *Handlers) AdminRoutes(admin fiber.Router) {
	g := admin.Group("/devices", auth.RequireSuperAdmin())
	g.Get("/", h.adminList)
	g.Patch("/:id", h.adminRename)
	g.Post("/:id/revoke-credential", h.adminRevokeCredential)
	g.Delete("/:id", h.adminDelete)
}

func (h *Handlers) adminList(c fiber.Ctx) error {
	list, err := h.store.ListAll(c.Context())
	if err != nil {
		return err
	}
	for i := range list {
		list[i].Online = h.presence.IsOnline(list[i].ID)
	}
	return c.JSON(httpx.List(list))
}

func (h *Handlers) adminTarget(c fiber.Ctx) (string, string, error) {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return "", "", err
	}
	owner, err := h.store.ownerOf(c.Context(), id)
	if errors.Is(err, ErrNotFound) {
		return "", "", httpx.NotFound()
	}
	return id, owner, err
}

func (h *Handlers) adminAudit(c fiber.Ctx, action, deviceID, ownerID string, meta map[string]any) {
	if meta == nil {
		meta = map[string]any{}
	}
	meta["owner_user_id"] = ownerID
	h.audit.Record(c.Context(), audit.Event{UserID: auth.PrincipalFrom(c).UserID, DeviceID: deviceID, Action: action,
		TargetType: "device", TargetID: deviceID, IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: meta})
}

func (h *Handlers) adminRename(c fiber.Ctx) error {
	id, owner, err := h.adminTarget(c)
	if err != nil {
		return err
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > 64 {
		return httpx.Validation(map[string]string{"name": "must be 1-64 characters"})
	}
	if err := h.store.AdminRename(c.Context(), id, name); errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	h.presence.DeviceChanged(c.Context(), id)
	h.adminAudit(c, "admin.device_renamed", id, owner, map[string]any{"name": name})
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) adminRevokeCredential(c fiber.Ctx) error {
	id, owner, err := h.adminTarget(c)
	if err != nil {
		return err
	}
	if err := h.store.RevokeCredentials(c.Context(), id); errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	h.presence.DisconnectDevice(id)
	h.presence.DeviceChanged(c.Context(), id)
	h.adminAudit(c, "admin.device_credential_revoked", id, owner, nil)
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) adminDelete(c fiber.Ctx) error {
	id, owner, err := h.adminTarget(c)
	if err != nil {
		return err
	}
	users, _ := h.store.AuthorizedUserIDs(c.Context(), id)
	if err := h.store.AdminDelete(c.Context(), id); errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	h.presence.DisconnectDevice(id)
	h.presence.DeviceChanged(c.Context(), id, users...)
	h.adminAudit(c, "admin.device_deleted", id, owner, nil)
	return c.SendStatus(fiber.StatusNoContent)
}
