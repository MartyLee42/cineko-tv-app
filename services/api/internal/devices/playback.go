package devices

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/db"
	"martytv/api/internal/httpx"
)

// ---------------------------------------------------------------- store

// DevicePlayback is a TV's playback profile plus what a ranking summary needs.
type DevicePlayback struct {
	ID    string
	Name  string
	Prefs PlaybackPrefs
}

// ClientPlayback is contract ClientPlaybackPrefs (a browser/phone).
type ClientPlayback struct {
	PlaybackPrefs
	ClientID string `json:"client_id"`
	Name     string `json:"name"`
	Platform string `json:"platform"`
}

// MaxClientsPerUser caps browser records per user (the oldest is dropped).
const MaxClientsPerUser = 20

var clientIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// ValidClientID reports whether s is a well-formed browser client id.
func ValidClientID(s string) bool { return clientIDRe.MatchString(s) }

func decodePrefs(rawAuto, rawManual []byte, updatedAt *time.Time) PlaybackPrefs {
	var a PlaybackAuto
	var m PlaybackManual
	_ = json.Unmarshal(rawAuto, &a)
	_ = json.Unmarshal(rawManual, &m)
	return NewPlaybackPrefs(a, m, updatedAt)
}

// canUsePlayback is the access rule for a TV's playback profile: the TV
// itself (its own id only); the owner or a `use` share; any super_admin.
// `control`-only and strangers are treated as not found.
func canUsePlayback(p *auth.Principal, deviceID, ownerID string, perm *string) bool {
	if p.Kind == auth.KindDevice {
		return p.DeviceID == deviceID
	}
	if p.HasScope(auth.ScopeAdmin) && p.IsSuperAdmin() {
		return true
	}
	return ownerID == p.UserID || perm != nil && *perm == AccessUse
}

// PlaybackFor returns a TV's playback profile if the caller may use it
// (ErrNotFound otherwise).
func (s *Store) PlaybackFor(ctx context.Context, p *auth.Principal, deviceID string) (*DevicePlayback, error) {
	var ownerID, name string
	var perm *string
	var rawA, rawM []byte
	var at *time.Time
	err := s.q.QueryRow(ctx, `
		SELECT d.owner_user_id, d.name, dp.permission, d.playback_auto, d.playback_manual, d.playback_updated_at
		FROM devices d
		LEFT JOIN device_permissions dp ON dp.device_id = d.id AND dp.user_id = $2
		WHERE d.id = $1 AND d.revoked_at IS NULL`, deviceID, p.UserID).
		Scan(&ownerID, &name, &perm, &rawA, &rawM, &at)
	if db.IsNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if !canUsePlayback(p, deviceID, ownerID, perm) {
		return nil, ErrNotFound
	}
	return &DevicePlayback{ID: deviceID, Name: name, Prefs: decodePrefs(rawA, rawM, at)}, nil
}

// UseAccess applies the playback-profile rule (canUsePlayback) to other
// per-TV data (settings): the TV's owner id, or ErrNotFound.
func (s *Store) UseAccess(ctx context.Context, p *auth.Principal, deviceID string) (ownerID string, err error) {
	var perm *string
	err = s.q.QueryRow(ctx, `
		SELECT d.owner_user_id, dp.permission FROM devices d
		LEFT JOIN device_permissions dp ON dp.device_id = d.id AND dp.user_id = $2
		WHERE d.id = $1 AND d.revoked_at IS NULL`, deviceID, p.UserID).Scan(&ownerID, &perm)
	if db.IsNoRows(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if !canUsePlayback(p, deviceID, ownerID, perm) {
		return "", ErrNotFound
	}
	return ownerID, nil
}

func nullJSON(v any, ok bool) ([]byte, error) {
	if !ok {
		return nil, nil
	}
	return json.Marshal(v)
}

// SetPlayback replaces the given parts (nil = keep).
func (s *Store) SetPlayback(ctx context.Context, deviceID string, a *PlaybackAuto, m *PlaybackManual) error {
	rawA, err := nullJSON(a, a != nil)
	if err != nil {
		return err
	}
	rawM, err := nullJSON(m, m != nil)
	if err != nil {
		return err
	}
	return s.exec(ctx, `
		UPDATE devices SET playback_auto = coalesce($2::jsonb, playback_auto),
			playback_manual = coalesce($3::jsonb, playback_manual), playback_updated_at = now()
		WHERE id = $1 AND revoked_at IS NULL`, deviceID, rawA, rawM)
}

const selectClient = `SELECT client_id, name, platform, auto, manual, updated_at FROM client_playback_prefs`

func scanClient(row interface{ Scan(...any) error }) (*ClientPlayback, error) {
	var c ClientPlayback
	var rawA, rawM []byte
	var at time.Time
	if err := row.Scan(&c.ClientID, &c.Name, &c.Platform, &rawA, &rawM, &at); err != nil {
		if db.IsNoRows(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	c.PlaybackPrefs = decodePrefs(rawA, rawM, &at)
	return &c, nil
}

// ListClients returns a user's browser records, newest first.
func (s *Store) ListClients(ctx context.Context, userID string) ([]ClientPlayback, error) {
	rows, err := s.q.Query(ctx, selectClient+` WHERE user_id = $1 ORDER BY updated_at DESC, client_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ClientPlayback{}
	for rows.Next() {
		c, err := scanClient(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// GetClient returns one of the user's browser records (ErrNotFound).
func (s *Store) GetClient(ctx context.Context, userID, clientID string) (*ClientPlayback, error) {
	return scanClient(s.q.QueryRow(ctx, selectClient+` WHERE user_id = $1 AND client_id = $2`, userID, clientID))
}

// ClientUpdate is an upsert of a browser record (nil fields keep their value).
type ClientUpdate struct {
	Name, Platform *string
	Auto           *PlaybackAuto
	Manual         *PlaybackManual
}

// UpsertClient creates or updates a browser record and drops the user's
// oldest records beyond MaxClientsPerUser.
func (s *Store) UpsertClient(ctx context.Context, userID, clientID string, u ClientUpdate) (*ClientPlayback, error) {
	rawA, err := nullJSON(u.Auto, u.Auto != nil)
	if err != nil {
		return nil, err
	}
	rawM, err := nullJSON(u.Manual, u.Manual != nil)
	if err != nil {
		return nil, err
	}
	// One statement: upsert, then drop the oldest beyond the cap (the
	// DELETE sees the pre-insert snapshot, so the current client is excluded
	// explicitly and MaxClientsPerUser-1 others are kept).
	if _, err := s.q.Exec(ctx, `
		WITH up AS (
			INSERT INTO client_playback_prefs (user_id, client_id, name, platform, auto, manual, updated_at)
			VALUES ($1, $2, coalesce($3, ''), coalesce($4, ''), coalesce($5::jsonb, '{}'), coalesce($6::jsonb, '{}'), now())
			ON CONFLICT (user_id, client_id) DO UPDATE SET
				name = coalesce($3, client_playback_prefs.name),
				platform = coalesce($4, client_playback_prefs.platform),
				auto = coalesce($5::jsonb, client_playback_prefs.auto),
				manual = coalesce($6::jsonb, client_playback_prefs.manual),
				updated_at = now()
			RETURNING 1)
		DELETE FROM client_playback_prefs WHERE user_id = $1 AND client_id <> $2 AND EXISTS (SELECT 1 FROM up)
			AND client_id NOT IN (
				SELECT client_id FROM client_playback_prefs WHERE user_id = $1 AND client_id <> $2
				ORDER BY updated_at DESC, client_id LIMIT $7)`,
		userID, clientID, u.Name, u.Platform, rawA, rawM, MaxClientsPerUser-1); err != nil {
		return nil, err
	}
	return s.GetClient(ctx, userID, clientID)
}

// DeleteClient removes a browser record (ErrNotFound).
func (s *Store) DeleteClient(ctx context.Context, userID, clientID string) error {
	return s.exec(ctx, `DELETE FROM client_playback_prefs WHERE user_id = $1 AND client_id = $2`, userID, clientID)
}

// ---------------------------------------------------------------- handlers

// PlaybackRoutes registers the playback-profile endpoints (called from Routes).
func (h *Handlers) PlaybackRoutes(api fiber.Router) {
	api.Get("/devices/:id/playback-prefs", requireUserOrDevice(), h.getPlayback)
	api.Patch("/devices/:id/playback-prefs", requireUserOrDevice(), h.patchPlayback)
	c := api.Group("/me/playback-clients", auth.RequireUser())
	c.Get("/", h.listClients)
	c.Get("/:client_id", h.getClient)
	c.Patch("/:client_id", h.patchClient)
	c.Delete("/:client_id", h.deleteClient)
}

// requireUserOrDevice allows paired TVs and users (API tokens need read for
// GET and write otherwise, like RequireUser).
func requireUserOrDevice() fiber.Handler {
	user := auth.RequireUser()
	return func(c fiber.Ctx) error {
		if p := auth.PrincipalFrom(c); p != nil && p.Kind == auth.KindDevice {
			return c.Next()
		}
		return user(c)
	}
}

// playbackTarget resolves :id ("me" = the calling TV) and checks access.
func (h *Handlers) playbackTarget(c fiber.Ctx) (*DevicePlayback, error) {
	p := auth.PrincipalFrom(c)
	var id string
	if c.Params("id") == "me" {
		if p.Kind != auth.KindDevice {
			return nil, httpx.NotFound()
		}
		id = p.DeviceID
	} else {
		var err error
		if id, err = httpx.ParamUUID(c, "id"); err != nil {
			return nil, err
		}
	}
	d, err := h.store.PlaybackFor(c.Context(), p, id)
	if errors.Is(err, ErrNotFound) {
		return nil, httpx.NotFound()
	}
	return d, err
}

func (h *Handlers) getPlayback(c fiber.Ctx) error {
	d, err := h.playbackTarget(c)
	if err != nil {
		return err
	}
	return c.JSON(d.Prefs)
}

type prefsPatch struct {
	Auto     *PlaybackAuto   `json:"auto"`
	Manual   *PlaybackManual `json:"manual"`
	Name     *string         `json:"name"`
	Platform *string         `json:"platform"`
}

// bindPrefsPatch decodes and validates a PATCH body (≤ 8 KB; unknown fields
// are dropped; each given part is normalized).
func bindPrefsPatch(c fiber.Ctx) (*prefsPatch, error) {
	if len(c.Body()) > MaxPrefsBody {
		return nil, httpx.NewError(fiber.StatusRequestEntityTooLarge, "payload_too_large", "Body is larger than 8 KB.")
	}
	var req prefsPatch
	if err := httpx.BindJSON(c, &req); err != nil {
		return nil, err
	}
	fields := map[string]string{}
	if req.Auto != nil {
		req.Auto.Normalize(fields)
	}
	if req.Manual != nil {
		req.Manual.Normalize(fields)
	}
	if req.Name != nil {
		req.Name = clipStr(req.Name, 1000)
		if len([]rune(*req.Name)) > 64 {
			fields["name"] = "at most 64 characters"
		}
	}
	if req.Platform != nil {
		req.Platform = clipStr(req.Platform, 64)
	}
	if len(fields) > 0 {
		return nil, httpx.Validation(fields)
	}
	return &req, nil
}

func (h *Handlers) patchPlayback(c fiber.Ctx) error {
	d, err := h.playbackTarget(c)
	if err != nil {
		return err
	}
	req, err := bindPrefsPatch(c)
	if err != nil {
		return err
	}
	ctx := c.Context()
	if err := h.store.SetPlayback(ctx, d.ID, req.Auto, req.Manual); errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	h.presence.DeviceChanged(ctx, d.ID)
	if d, err = h.store.PlaybackFor(ctx, auth.PrincipalFrom(c), d.ID); err != nil {
		return err
	}
	return c.JSON(d.Prefs)
}

func clientParam(c fiber.Ctx) (string, error) {
	id := strings.Clone(c.Params("client_id"))
	if !ValidClientID(id) {
		return "", httpx.NotFound()
	}
	return id, nil
}

func (h *Handlers) listClients(c fiber.Ctx) error {
	list, err := h.store.ListClients(c.Context(), auth.PrincipalFrom(c).UserID)
	if err != nil {
		return err
	}
	return c.JSON(httpx.List(list))
}

func (h *Handlers) getClient(c fiber.Ctx) error {
	id, err := clientParam(c)
	if err != nil {
		return err
	}
	cl, err := h.store.GetClient(c.Context(), auth.PrincipalFrom(c).UserID, id)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	return c.JSON(cl)
}

func (h *Handlers) patchClient(c fiber.Ctx) error {
	id, err := clientParam(c)
	if err != nil {
		return err
	}
	req, err := bindPrefsPatch(c)
	if err != nil {
		return err
	}
	cl, err := h.store.UpsertClient(c.Context(), auth.PrincipalFrom(c).UserID, id,
		ClientUpdate{Name: req.Name, Platform: req.Platform, Auto: req.Auto, Manual: req.Manual})
	if err != nil {
		return err
	}
	return c.JSON(cl)
}

func (h *Handlers) deleteClient(c fiber.Ctx) error {
	id, err := clientParam(c)
	if err != nil {
		return err
	}
	if err := h.store.DeleteClient(c.Context(), auth.PrincipalFrom(c).UserID, id); errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}
