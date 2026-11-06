package pairing

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

// Notifier is told when a new device has been paired (realtime hub).
type Notifier interface {
	DeviceChanged(ctx context.Context, deviceID string, extraUserIDs ...string)
	// AdminDevicesChanged refreshes the super_admin devices/pairing view.
	AdminDevicesChanged(reason string)
	// UserDevicesChanged refreshes one user's Devices list.
	UserDevicesChanged(userID string)
}

type Handlers struct {
	svc          *Service
	audit        *audit.Logger
	notify       Notifier
	publicBase   string
	createLimit  *httpx.RateLimiter
	lookupIP     *httpx.RateLimiter
	lookupUser   *httpx.RateLimiter
	pollLimit    *httpx.RateLimiter
	exchangeFail *httpx.Lockout
}

func NewHandlers(svc *Service, a *audit.Logger, n Notifier, publicBaseURL string) *Handlers {
	return &Handlers{
		svc: svc, audit: a, notify: n, publicBase: strings.TrimRight(publicBaseURL, "/"),
		createLimit:  httpx.NewRateLimiter(10, time.Minute),
		lookupIP:     httpx.NewRateLimiter(30, 5*time.Minute),
		lookupUser:   httpx.NewRateLimiter(20, 5*time.Minute),
		pollLimit:    httpx.NewRateLimiter(120, time.Minute),
		exchangeFail: httpx.NewLockout(5, time.Minute, 15*time.Minute),
	}
}

func (h *Handlers) Routes(r fiber.Router) {
	g := r.Group("/pairing")
	// TV side (unauthenticated; bound by the poll secret).
	g.Post("/", h.create)
	g.Get("/lookup", auth.RequireSession(), h.lookup)
	g.Get("/:id", h.status)
	g.Post("/:id/exchange", h.exchange)
	// Approver side (signed-in browser session).
	g.Post("/:id/approve", auth.RequireSession(), h.approve)
	g.Post("/:id/deny", auth.RequireSession(), h.deny)
}

func (h *Handlers) create(c fiber.Ctx) error {
	if ok, wait := h.createLimit.Allow(c.IP()); !ok {
		return httpx.TooManyRequests(wait)
	}
	var req struct {
		DeviceName string `json:"device_name"`
		Platform   string `json:"platform"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	req.DeviceName = strings.TrimSpace(req.DeviceName)
	if req.DeviceName == "" {
		req.DeviceName = "TV"
	}
	if len([]rune(req.DeviceName)) > 64 {
		return httpx.Validation(map[string]string{"device_name": "at most 64 characters"})
	}
	r, err := h.svc.Create(c.Context(), req.DeviceName, truncate(req.Platform, 64),
		truncate(c.Get(fiber.HeaderUserAgent), 256), c.IP())
	if err != nil {
		return err
	}
	h.notify.AdminDevicesChanged("pairing.created")
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"pairing_id":       r.ID,
		"user_code":        FormatCode(r.UserCode),
		"poll_secret":      r.PollSecret,
		"expires_at":       r.ExpiresAt,
		"verification_url": h.publicBase + "/pair",
		// The QR code carries only the public user code, never the poll secret.
		"verification_url_complete": h.publicBase + "/pair?code=" + FormatCode(r.UserCode),
		"poll_interval_seconds":     2,
	})
}

// pollSecret reads "Authorization: Pairing <secret>".
func pollSecret(c fiber.Ctx) string {
	const p = "Pairing "
	h := c.Get(fiber.HeaderAuthorization)
	if len(h) > len(p) && strings.EqualFold(h[:len(p)], p) {
		return strings.TrimSpace(h[len(p):])
	}
	return ""
}

func validID(c fiber.Ctx) (string, error) {
	id := c.Params("id")
	if _, err := uuid.Parse(id); err != nil || len(id) != 36 {
		return "", httpx.NotFound()
	}
	return id, nil
}

func (h *Handlers) status(c fiber.Ctx) error {
	id, err := validID(c)
	if err != nil {
		return err
	}
	if ok, wait := h.pollLimit.Allow(c.IP()); !ok {
		return httpx.TooManyRequests(wait)
	}
	st, exp, err := h.svc.Status(c.Context(), id, pollSecret(c))
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrBadSecret) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"status": st, "expires_at": exp})
}

func (h *Handlers) exchange(c fiber.Ctx) error {
	id, err := validID(c)
	if err != nil {
		return err
	}
	if wait := h.exchangeFail.Check(c.IP()); wait > 0 {
		return httpx.TooManyRequests(wait)
	}
	nd, ownerID, err := h.svc.Exchange(c.Context(), id, pollSecret(c), truncate(c.Get(fiber.HeaderUserAgent), 256))
	switch {
	case errors.Is(err, ErrNotFound), errors.Is(err, ErrBadSecret):
		h.exchangeFail.Fail(c.IP())
		return httpx.NotFound()
	case errors.Is(err, ErrConsumed):
		h.audit.Record(c.Context(), audit.Event{Action: "pairing.replay_rejected", TargetType: "pairing",
			TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c)})
		return httpx.Gone("pairing_consumed", "This pairing request has already been used.")
	case errors.Is(err, ErrExpired):
		return httpx.Gone("pairing_expired", "This pairing request has expired.")
	case errors.Is(err, ErrNotApproved):
		return httpx.Conflict("pairing_not_approved", "This pairing request has not been approved.")
	case err != nil:
		return err
	}
	h.audit.Record(c.Context(), audit.Event{UserID: ownerID, DeviceID: nd.Device.ID, Action: "pairing.completed",
		TargetType: "pairing", TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c)})
	h.notify.DeviceChanged(c.Context(), nd.Device.ID)
	return c.JSON(fiber.Map{"device": nd.Device, "credential": nd.Credential})
}

func (h *Handlers) lookup(c fiber.Ctx) error {
	p := auth.PrincipalFrom(c)
	if ok, wait := h.lookupIP.Allow(c.IP()); !ok {
		return httpx.TooManyRequests(wait)
	}
	if ok, wait := h.lookupUser.Allow(p.UserID); !ok {
		return httpx.TooManyRequests(wait)
	}
	pend, err := h.svc.Lookup(c.Context(), c.Query("code"))
	if errors.Is(err, ErrNotFound) {
		return httpx.NewError(fiber.StatusNotFound, "pairing_not_found", "No TV is waiting with that code. Check the code or restart pairing on the TV.")
	}
	if err != nil {
		return err
	}
	return c.JSON(pend)
}

func (h *Handlers) approve(c fiber.Ctx) error {
	id, err := validID(c)
	if err != nil {
		return err
	}
	var req struct {
		Name             string  `json:"name"`
		DefaultProfileID *string `json:"default_profile_id"`
	}
	if len(c.Body()) > 0 {
		if err := httpx.BindJSON(c, &req); err != nil {
			return err
		}
	}
	req.Name = strings.TrimSpace(req.Name)
	if len([]rune(req.Name)) > 64 {
		return httpx.Validation(map[string]string{"name": "at most 64 characters"})
	}
	if req.DefaultProfileID != nil {
		if _, err := uuid.Parse(*req.DefaultProfileID); err != nil {
			return httpx.Validation(map[string]string{"default_profile_id": "must be one of your profiles"})
		}
	}
	p := auth.PrincipalFrom(c)
	err = h.svc.Approve(c.Context(), id, p.UserID, req.Name, req.DefaultProfileID)
	switch {
	case errors.Is(err, ErrBadProfile):
		return httpx.Validation(map[string]string{"default_profile_id": "must be one of your profiles"})
	case errors.Is(err, ErrNotPending):
		return httpx.Gone("pairing_unavailable", "This pairing request has expired or was already handled.")
	case err != nil:
		return err
	}
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "pairing.approved", TargetType: "pairing",
		TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c)})
	h.notify.AdminDevicesChanged("pairing.approved")
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) deny(c fiber.Ctx) error {
	id, err := validID(c)
	if err != nil {
		return err
	}
	p := auth.PrincipalFrom(c)
	if err := h.svc.Deny(c.Context(), id, p.UserID); errors.Is(err, ErrNotPending) {
		return httpx.Gone("pairing_unavailable", "This pairing request has expired or was already handled.")
	} else if err != nil {
		return err
	}
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "pairing.denied", TargetType: "pairing",
		TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c)})
	h.notify.AdminDevicesChanged("pairing.denied")
	return c.SendStatus(fiber.StatusNoContent)
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
