package devices

import (
	"context"
	"errors"
	"strings"

	"encoding/json"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
	"martytv/api/internal/realtime"
)

// Presence is implemented by the realtime hub.
type Presence interface {
	IsOnline(deviceID string) bool
	DisconnectDevice(deviceID string)
	// DeviceChanged tells connected clients that device metadata or access changed.
	DeviceChanged(ctx context.Context, deviceID string, extraUserIDs ...string)
	// LastState is the TV's last reported state (nil when offline/unknown).
	LastState(deviceID string) json.RawMessage
	// Command sends a command to a TV and waits for its ack.
	Command(ctx context.Context, p *auth.Principal, deviceID, id, typ string, payload json.RawMessage) (ackID string, ack json.RawMessage)
}

type Handlers struct {
	store    *Store
	hasher   *auth.Hasher
	presence Presence
	audit    *audit.Logger
	// healthLimit: one health sample per device per HealthMinInterval.
	healthLimit *httpx.RateLimiter
}

func NewHandlers(s *Store, h *auth.Hasher, p Presence, a *audit.Logger) *Handlers {
	return &Handlers{store: s, hasher: h, presence: p, audit: a, healthLimit: httpx.NewRateLimiter(1, HealthMinInterval)}
}

func (h *Handlers) Routes(r fiber.Router) {
	g := r.Group("/devices")
	g.Get("/", auth.RequireUser(), h.list)
	g.Get("/me", auth.RequireDevice(), h.me)
	g.Post("/register", h.register)
	g.Post("/demo", auth.RequireSession(), h.demo)
	g.Get("/:id", auth.RequireUser(), h.get)
	g.Patch("/:id", auth.RequireUser(), h.update)
	g.Delete("/:id", auth.RequireUser(), h.revoke)
	g.Get("/:id/permissions", auth.RequireUser(), h.listPermissions)
	g.Put("/:id/permissions", auth.RequireUser(), h.share)
	g.Delete("/:id/permissions/:userId", auth.RequireUser(), h.unshare)
	g.Get("/:id/state", auth.RequireUser(), h.state)
	g.Post("/:id/commands", auth.RequireUser(), h.command)
	h.PlaybackRoutes(r)
	h.HealthRoutes(r)
}

func (h *Handlers) withPresence(d *Device) *Device {
	d.Online = h.presence.IsOnline(d.ID)
	return d
}

func (h *Handlers) list(c fiber.Ctx) error {
	list, err := h.listScoped(c)
	if err != nil {
		return err
	}
	for i := range list {
		h.withPresence(&list[i])
	}
	return c.JSON(httpx.List(list))
}

func (h *Handlers) me(c fiber.Ctx) error {
	d, err := h.store.GetForDevice(c.Context(), auth.PrincipalFrom(c).DeviceID)
	if errors.Is(err, ErrNotFound) {
		return httpx.Unauthorized()
	}
	if err != nil {
		return err
	}
	return c.JSON(h.withPresence(d))
}

func (h *Handlers) get(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	d, err := h.store.GetForUser(c.Context(), auth.PrincipalFrom(c).UserID, id)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	return c.JSON(h.withPresence(d))
}

// ownerOnly resolves the :id param and verifies the caller owns the device.
// Non-owners get 404 if they cannot see it and 403 if it is merely shared.
func (h *Handlers) ownerOnly(c fiber.Ctx) (string, *auth.Principal, error) {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return "", nil, err
	}
	p := auth.PrincipalFrom(c)
	d, err := h.store.GetForUser(c.Context(), p.UserID, id)
	if errors.Is(err, ErrNotFound) {
		return "", nil, httpx.NotFound()
	}
	if err != nil {
		return "", nil, err
	}
	if d.Access != AccessOwner {
		return "", nil, httpx.Forbidden()
	}
	return id, p, nil
}

func (h *Handlers) update(c fiber.Ctx) error {
	id, p, err := h.ownerOnly(c)
	if err != nil {
		return err
	}
	var req struct {
		Name             *string `json:"name"`
		DefaultProfileID *string `json:"default_profile_id"`
		ClearDefault     bool    `json:"clear_default_profile"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	ctx := c.Context()
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" || len([]rune(name)) > 64 {
			return httpx.Validation(map[string]string{"name": "must be 1-64 characters"})
		}
		if err := h.store.Rename(ctx, p.UserID, id, name); err != nil {
			return err
		}
	}
	if req.DefaultProfileID != nil || req.ClearDefault {
		if req.DefaultProfileID != nil {
			if _, err := uuid.Parse(*req.DefaultProfileID); err != nil {
				return httpx.Validation(map[string]string{"default_profile_id": "must be one of your profiles"})
			}
		}
		err := h.store.SetDefaultProfile(ctx, p.UserID, id, req.DefaultProfileID)
		if errors.Is(err, ErrBadProfile) {
			return httpx.Validation(map[string]string{"default_profile_id": "must be one of your profiles"})
		}
		if err != nil {
			return err
		}
	}
	h.presence.DeviceChanged(ctx, id)
	d, err := h.store.GetForUser(ctx, p.UserID, id)
	if err != nil {
		return err
	}
	return c.JSON(h.withPresence(d))
}

func (h *Handlers) revoke(c fiber.Ctx) error {
	id, p, err := h.ownerOnly(c)
	if err != nil {
		return err
	}
	users, _ := h.store.AuthorizedUserIDs(c.Context(), id)
	if err := h.store.Revoke(c.Context(), p.UserID, id); err != nil {
		return err
	}
	h.presence.DisconnectDevice(id)
	h.presence.DeviceChanged(c.Context(), id, users...)
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, DeviceID: id, Action: "device.revoked",
		TargetType: "device", TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c)})
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) listPermissions(c fiber.Ctx) error {
	id, _, err := h.ownerOnly(c)
	if err != nil {
		return err
	}
	list, err := h.store.ListPermissions(c.Context(), id)
	if err != nil {
		return err
	}
	return c.JSON(httpx.List(list))
}

func (h *Handlers) share(c fiber.Ctx) error {
	id, p, err := h.ownerOnly(c)
	if err != nil {
		return err
	}
	var req struct {
		Username   string `json:"username"`
		Permission string `json:"permission"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	if req.Permission != AccessControl && req.Permission != AccessUse {
		return httpx.Validation(map[string]string{"permission": "must be control or use"})
	}
	perm, err := h.store.Share(c.Context(), p.UserID, id, strings.TrimSpace(req.Username), req.Permission)
	if errors.Is(err, ErrUnknownUser) {
		// Same message whether the user is unknown, disabled or the owner.
		return httpx.Validation(map[string]string{"username": "cannot share with this user"})
	}
	if err != nil {
		return err
	}
	h.presence.DeviceChanged(c.Context(), id)
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, DeviceID: id, Action: "device.shared",
		TargetType: "user", TargetID: perm.UserID, IP: c.IP(), RequestID: httpx.RequestID(c),
		Metadata: map[string]any{"permission": perm.Permission}})
	return c.JSON(perm)
}

func (h *Handlers) unshare(c fiber.Ctx) error {
	id, p, err := h.ownerOnly(c)
	if err != nil {
		return err
	}
	userID, err := httpx.ParamUUID(c, "userId")
	if err != nil {
		return err
	}
	if err := h.store.Unshare(c.Context(), p.UserID, id, userID); errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	h.presence.DeviceChanged(c.Context(), id, userID)
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, DeviceID: id, Action: "device.unshared",
		TargetType: "user", TargetID: userID, IP: c.IP(), RequestID: httpx.RequestID(c)})
	return c.SendStatus(fiber.StatusNoContent)
}

// register is the "manual token" TV setup path: the TV presents a personal
// API token with the device:register scope and receives its own device
// credential. The API token itself is never stored on the TV.
func (h *Handlers) register(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	if p == nil {
		return httpx.Unauthorized()
	}
	if p.Kind != auth.KindToken || !p.HasScope(auth.ScopeDeviceRegister) {
		return httpx.NewError(fiber.StatusForbidden, "insufficient_scope", "A token with the device:register scope is required.")
	}
	var req struct {
		Name     string `json:"name"`
		Platform string `json:"platform"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len([]rune(req.Name)) > 64 {
		return httpx.Validation(map[string]string{"name": "must be 1-64 characters"})
	}
	nd, err := Register(c.Context(), h.store.q, h.hasher, p.UserID, req.Name, truncate(req.Platform, 64),
		truncate(c.Get(fiber.HeaderUserAgent), 256), nil)
	if err != nil {
		return err
	}
	h.presence.DeviceChanged(c.Context(), nd.Device.ID)
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, DeviceID: nd.Device.ID, Action: "device.registered_with_token",
		TargetType: "api_token", TargetID: p.TokenID, IP: c.IP(), RequestID: httpx.RequestID(c)})
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"device": nd.Device, "credential": nd.Credential})
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// state returns the TV's last reported state to anyone who can see it.
func (h *Handlers) state(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	if _, err := h.store.AccessFor(c.Context(), auth.PrincipalFrom(c), id); errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	online := h.presence.IsOnline(id)
	var st json.RawMessage
	if online {
		st = h.presence.LastState(id)
	}
	if len(st) == 0 {
		st = json.RawMessage("null")
	}
	return c.JSON(fiber.Map{"online": online, "state": st})
}

var commandTypes = map[string]bool{
	"media.open": true, "media.play": true, "media.pause": true, "media.resume": true, "media.stop": true,
	"media.seek": true, "media.next_episode": true, "media.select_source": true,
	"playback.set_audio": true, "playback.set_subtitles": true, "playback.set_volume": true,
	"device.show_message": true, "device.request_state": true,
	"iptv.play":  true,
	"video.play": true,
}

// command is the HTTP path for sending a TV command (API tokens, clients
// without a socket). It waits for the TV's ack.
func (h *Handlers) command(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	p := auth.PrincipalFrom(c)
	if _, err := h.store.AccessFor(c.Context(), p, id); errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	var req struct {
		ID      string          `json:"id"`
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	if !commandTypes[req.Type] {
		return httpx.Validation(map[string]string{"type": "unknown command"})
	}
	if len(req.ID) > 64 {
		return httpx.Validation(map[string]string{"id": "at most 64 characters"})
	}
	// A malformed payload is the caller's mistake: 422 (over the socket the hub acks bad_payload).
	if _, _, err := realtime.ValidatePayload(req.Type, req.Payload); err != nil {
		return httpx.Validation(map[string]string{"payload": strings.TrimPrefix(err.Error(), realtime.ErrInvalidPayload.Error()+": ")})
	}
	ackID, ack := h.presence.Command(c.Context(), p, id, req.ID, req.Type, req.Payload)
	var out map[string]any
	_ = json.Unmarshal(ack, &out)
	if out == nil {
		out = map[string]any{"ok": false, "error": "failed"}
	}
	out["id"] = ackID
	return c.JSON(out)
}
