package auth

import (
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/audit"
	"martytv/api/internal/httpx"
	"martytv/api/internal/users"
)

type Handlers struct {
	svc      *Service
	mw       *Middleware
	users    *users.Store
	audit    *audit.Logger
	ipLimit  *httpx.RateLimiter
	userLock *httpx.Lockout
}

// loginsPerIP is how many logins one IP may try per 5 minutes (≤ 0 → 20).
func NewHandlers(svc *Service, mw *Middleware, u *users.Store, a *audit.Logger, loginsPerIP int) *Handlers {
	if loginsPerIP <= 0 {
		loginsPerIP = 20
	}
	return &Handlers{
		svc: svc, mw: mw, users: u, audit: a,
		ipLimit:  httpx.NewRateLimiter(loginsPerIP, 5*time.Minute),
		userLock: httpx.NewLockout(5, 30*time.Second, 15*time.Minute),
	}
}

// Routes mounts /auth. Expects Authenticate and CSRF middleware upstream.
func (h *Handlers) Routes(r fiber.Router) {
	g := r.Group("/auth")
	g.Post("/login", h.login)
	g.Post("/logout", h.logout)
	g.Get("/session", RequireAny(), h.session)
	g.Post("/logout-all", RequireSession(), h.logoutAll)
	g.Get("/sessions", RequireSession(), h.listSessions)
	g.Delete("/sessions/:id", RequireSession(), h.revokeSession)
	g.Post("/password", RequireSession(), h.changePassword)
	g.Get("/tokens", RequireUser(), h.listTokens)
	g.Post("/tokens", RequireSession(), h.createToken)
	g.Delete("/tokens/:id", RequireSession(), h.revokeToken)
}

// PublicUser is the safe account shape returned to clients.
type PublicUser struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
}

func toPublic(u *users.User) PublicUser {
	return PublicUser{ID: u.ID, Username: u.Username, DisplayName: u.DisplayName, Role: u.Role}
}

func (h *Handlers) login(c fiber.Ctx) error {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || req.Password == "" {
		return httpx.Validation(map[string]string{"username": "required", "password": "required"})
	}
	if ok, wait := h.ipLimit.Allow(c.IP()); !ok {
		return httpx.TooManyRequests(wait)
	}
	lockKey := strings.ToLower(req.Username)
	if wait := h.userLock.Check(lockKey); wait > 0 {
		return httpx.TooManyRequests(wait)
	}
	u, err := h.svc.Authenticate(c.Context(), req.Username, req.Password)
	if errors.Is(err, ErrInvalidCredentials) {
		h.userLock.Fail(lockKey)
		h.audit.Record(c.Context(), audit.Event{Action: "auth.login_failed", IP: c.IP(),
			RequestID: httpx.RequestID(c), Metadata: map[string]any{"username": truncate(lockKey, 32)}})
		return httpx.NewError(fiber.StatusUnauthorized, "invalid_credentials", "Incorrect username or password.")
	}
	if err != nil {
		return err
	}
	h.userLock.Succeed(lockKey)
	s, err := h.svc.CreateSession(c.Context(), u.ID, c.Get(fiber.HeaderUserAgent), c.IP())
	if err != nil {
		return err
	}
	h.mw.SetCookie(c, s)
	h.audit.Record(c.Context(), audit.Event{UserID: u.ID, Action: "auth.login", TargetType: "session",
		TargetID: s.ID, IP: c.IP(), RequestID: httpx.RequestID(c)})
	return c.JSON(fiber.Map{"user": toPublic(u), "csrf_token": s.CSRFToken})
}

func (h *Handlers) logout(c fiber.Ctx) error {
	if p := PrincipalFrom(c); p != nil && p.Kind == KindSession {
		if err := h.svc.RevokeSession(c.Context(), p.UserID, p.SessionID); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "auth.logout", IP: c.IP(), RequestID: httpx.RequestID(c)})
	}
	h.mw.ClearCookie(c)
	return c.SendStatus(fiber.StatusNoContent)
}

// session returns the current principal. Browsers use it on startup to learn
// whether they are signed in and to fetch the CSRF token.
func (h *Handlers) session(c fiber.Ctx) error {
	p := PrincipalFrom(c)
	u, err := h.users.ByID(c.Context(), p.UserID)
	if err != nil {
		return err
	}
	out := fiber.Map{"kind": p.Kind, "user": toPublic(u)}
	if p.Kind == KindSession {
		out["csrf_token"] = p.CSRFToken
	}
	if p.Kind == KindToken {
		out["scopes"] = p.Scopes
	}
	if p.Kind == KindDevice {
		out["device_id"] = p.DeviceID
	}
	return c.JSON(out)
}

func (h *Handlers) logoutAll(c fiber.Ctx) error {
	var req struct {
		IncludeDevices bool `json:"include_devices"`
	}
	if len(c.Body()) > 0 {
		if err := httpx.BindJSON(c, &req); err != nil {
			return err
		}
	}
	p := PrincipalFrom(c)
	if err := h.svc.RevokeAllForUser(c.Context(), p.UserID, req.IncludeDevices); err != nil {
		return err
	}
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "auth.logout_all", IP: c.IP(),
		RequestID: httpx.RequestID(c), Metadata: map[string]any{"include_devices": req.IncludeDevices}})
	h.mw.ClearCookie(c)
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) listSessions(c fiber.Ctx) error {
	p := PrincipalFrom(c)
	list, err := h.svc.ListSessions(c.Context(), p.UserID, p.SessionID)
	if err != nil {
		return err
	}
	return c.JSON(httpx.List(list))
}

func (h *Handlers) revokeSession(c fiber.Ctx) error {
	p := PrincipalFrom(c)
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	err = h.svc.RevokeSession(c.Context(), p.UserID, id)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if id == p.SessionID {
		h.mw.ClearCookie(c)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) changePassword(c fiber.Ctx) error {
	var req struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	if err := ValidatePassword(req.New); err != nil {
		return httpx.Validation(map[string]string{"new_password": err.Error()})
	}
	p := PrincipalFrom(c)
	if wait := h.userLock.Check("pw:" + p.UserID); wait > 0 {
		return httpx.TooManyRequests(wait)
	}
	err := h.svc.ChangePassword(c.Context(), p.UserID, p.SessionID, req.Current, req.New)
	if errors.Is(err, ErrInvalidCredentials) {
		h.userLock.Fail("pw:" + p.UserID)
		return httpx.Validation(map[string]string{"current_password": "incorrect"})
	}
	if err != nil {
		return err
	}
	h.userLock.Succeed("pw:" + p.UserID)
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "auth.password_changed", IP: c.IP(), RequestID: httpx.RequestID(c)})
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) listTokens(c fiber.Ctx) error {
	list, err := h.svc.ListAPITokens(c.Context(), PrincipalFrom(c).UserID)
	if err != nil {
		return err
	}
	return c.JSON(httpx.List(list))
}

func (h *Handlers) createToken(c fiber.Ctx) error {
	var req struct {
		Name          string   `json:"name"`
		Scopes        []string `json:"scopes"`
		ExpiresInDays *int     `json:"expires_in_days"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	req.Name = strings.TrimSpace(req.Name)
	fields := map[string]string{}
	if req.Name == "" || len(req.Name) > 64 {
		fields["name"] = "must be 1-64 characters"
	}
	if len(req.Scopes) == 0 {
		fields["scopes"] = "at least one scope is required"
	}
	var exp *time.Time
	if req.ExpiresInDays != nil {
		if *req.ExpiresInDays < 1 || *req.ExpiresInDays > 3650 {
			fields["expires_in_days"] = "must be between 1 and 3650"
		} else {
			t := time.Now().UTC().Add(time.Duration(*req.ExpiresInDays) * 24 * time.Hour)
			exp = &t
		}
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	p := PrincipalFrom(c)
	t, secret, err := h.svc.CreateAPIToken(c.Context(), p.UserID, p.Role, req.Name, req.Scopes, exp)
	if err != nil {
		if strings.Contains(err.Error(), "scope") {
			return httpx.Validation(map[string]string{"scopes": err.Error()})
		}
		return err
	}
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "api_token.created", TargetType: "api_token",
		TargetID: t.ID, IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: map[string]any{"scopes": req.Scopes}})
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"token": t, "secret": secret})
}

func (h *Handlers) revokeToken(c fiber.Ctx) error {
	p := PrincipalFrom(c)
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	err = h.svc.RevokeAPIToken(c.Context(), p.UserID, id)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "api_token.revoked", TargetType: "api_token",
		TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c)})
	return c.SendStatus(fiber.StatusNoContent)
}
