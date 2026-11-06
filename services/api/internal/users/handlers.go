package users

import (
	"context"
	"errors"
	"strings"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/audit"
	"martytv/api/internal/httpx"
)

// Auth is the subset of the auth service the admin API needs.
type Auth interface {
	HashPassword(ctx context.Context, pw string) (string, error)
	ValidatePassword(pw string) error
	SetPassword(ctx context.Context, userID, password, keepSessionID string) error
	RevokeAllForUser(ctx context.Context, userID string, includeDevices bool) error
	CallerID(c fiber.Ctx) string
	// CallerRole is the signed-in caller's role (user, admin, super_admin).
	CallerRole(c fiber.Ctx) string
}

// errSuperAdminRequired is returned when a plain admin touches an
// administrator or tries to grant admin rights.
func errSuperAdminRequired() error {
	return httpx.NewError(fiber.StatusForbidden, "super_admin_required", "Only a super admin can manage administrators.")
}

func lockoutError(err error) error {
	switch {
	case errors.Is(err, ErrLastSuperAdmin):
		return httpx.Conflict("last_super_admin", "At least one active super admin is required.")
	case errors.Is(err, ErrLastAdmin):
		return httpx.Conflict("last_admin", "At least one active administrator is required.")
	}
	return err
}

type Handlers struct {
	store *Store
	auth  Auth
	audit *audit.Logger
}

func NewHandlers(s *Store, a Auth, al *audit.Logger) *Handlers {
	return &Handlers{store: s, auth: a, audit: al}
}

// DirectoryRoutes mounts GET /users/directory for any signed-in person
// (choosing whom to share a TV with). Only id, username and display name.
func (h *Handlers) DirectoryRoutes(api fiber.Router, requireUser fiber.Handler) {
	api.Get("/users/directory", requireUser, h.directory)
}

func (h *Handlers) directory(c fiber.Ctx) error {
	list, err := h.store.List(c.Context())
	if err != nil {
		return err
	}
	type entry struct {
		ID          string `json:"id"`
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
	}
	me := h.auth.CallerID(c)
	out := []entry{}
	for _, u := range list {
		if u.Disabled() || u.ID == me {
			continue
		}
		out = append(out, entry{u.ID, u.Username, u.DisplayName})
	}
	return c.JSON(httpx.List(out))
}

// AdminRoutes mounts /users under the admin group (which enforces RequireAdmin).
func (h *Handlers) AdminRoutes(admin fiber.Router) {
	g := admin.Group("/users")
	g.Get("/", h.list)
	g.Post("/", h.create)
	g.Patch("/:id", h.update)
	g.Post("/:id/password", h.resetPassword)
}

func (h *Handlers) list(c fiber.Ctx) error {
	list, err := h.store.List(c.Context())
	if err != nil {
		return err
	}
	return c.JSON(httpx.List(list))
}

func (h *Handlers) create(c fiber.Ctx) error {
	var req struct {
		Username    string `json:"username"`
		DisplayName string `json:"display_name"`
		Password    string `json:"password"`
		Role        string `json:"role"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	req.Username = strings.TrimSpace(req.Username)
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.Role == "" {
		req.Role = RoleUser
	}
	fields := map[string]string{}
	if !UsernamePattern.MatchString(req.Username) {
		fields["username"] = "3-32 characters: letters, digits, . _ -"
	}
	if len(req.DisplayName) > 64 {
		fields["display_name"] = "at most 64 characters"
	}
	if err := h.auth.ValidatePassword(req.Password); err != nil {
		fields["password"] = err.Error()
	}
	if !ValidRole(req.Role) {
		fields["role"] = "must be user, admin or super_admin"
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	if !CanGrant(h.auth.CallerRole(c), req.Role) {
		return errSuperAdminRequired()
	}
	hash, err := h.auth.HashPassword(c.Context(), req.Password)
	if err != nil {
		return err
	}
	u, err := h.store.Create(c.Context(), req.Username, req.DisplayName, req.Role, hash)
	if errors.Is(err, ErrUsernameTaken) {
		return httpx.Validation(map[string]string{"username": "already taken"})
	}
	if err != nil {
		return err
	}
	if err := h.store.CreateDefaultProfile(c.Context(), u); err != nil {
		return err
	}
	h.audit.Record(c.Context(), audit.Event{UserID: h.auth.CallerID(c), Action: "admin.user_created",
		TargetType: "user", TargetID: u.ID, IP: c.IP(), RequestID: httpx.RequestID(c),
		Metadata: map[string]any{"role": u.Role}})
	return c.Status(fiber.StatusCreated).JSON(u)
}

func (h *Handlers) update(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	var req struct {
		Disabled    *bool   `json:"disabled"`
		Role        *string `json:"role"`
		DisplayName *string `json:"display_name"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	caller := h.auth.CallerID(c)
	target, err := h.store.ByID(c.Context(), id)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	ctx := c.Context()
	callerRole := h.auth.CallerRole(c)
	self := id == caller

	// A plain admin manages regular users only; administrators and
	// super_admins are a super_admin's business (yourself excepted, e.g. a
	// display name — your own role and disabling are refused below).
	if !self && !CanManage(callerRole, target.Role) {
		return errSuperAdminRequired()
	}
	roleChange := req.Role != nil && *req.Role != target.Role
	if req.Role != nil && !ValidRole(*req.Role) {
		return httpx.Validation(map[string]string{"role": "must be user, admin or super_admin"})
	}
	disabling := req.Disabled != nil && *req.Disabled && !target.Disabled()
	if self && (roleChange || disabling) {
		return httpx.Conflict("self_lockout", "You cannot disable your own account or change your own role.")
	}
	if roleChange && !CanGrant(callerRole, *req.Role) {
		return errSuperAdminRequired()
	}
	// Never let the last active administrator / super_admin lock everyone out.
	newRole := ""
	if roleChange {
		newRole = *req.Role
	}
	if err := h.store.GuardLockout(ctx, target, newRole, disabling); err != nil {
		return lockoutError(err)
	}
	if roleChange {
		// Takes effect on the next request: every principal reads the role
		// from the database (admin-scoped tokens stop working on demotion).
		if err := h.store.SetRole(ctx, id, *req.Role); err != nil {
			return err
		}
		h.audit.Record(ctx, audit.Event{UserID: caller, Action: "admin.user_role_changed", TargetType: "user",
			TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c),
			Metadata: map[string]any{"from": target.Role, "to": *req.Role}})
	}
	if req.DisplayName != nil {
		name := strings.TrimSpace(*req.DisplayName)
		if len(name) > 64 {
			return httpx.Validation(map[string]string{"display_name": "at most 64 characters"})
		}
		if err := h.store.SetDisplayName(ctx, id, name); err != nil {
			return err
		}
	}
	if req.Disabled != nil {
		if err := h.store.SetDisabled(ctx, id, *req.Disabled); err != nil {
			return err
		}
		if *req.Disabled {
			// Disabled users lose every session, token and device immediately.
			if err := h.auth.RevokeAllForUser(ctx, id, true); err != nil {
				return err
			}
		}
	}
	h.audit.Record(ctx, audit.Event{UserID: caller, Action: "admin.user_updated", TargetType: "user",
		TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c),
		Metadata: map[string]any{"disabled": req.Disabled, "role": req.Role, "previous_role": target.Role}})
	u, err := h.store.ByID(ctx, id)
	if err != nil {
		return err
	}
	return c.JSON(u)
}

func (h *Handlers) resetPassword(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	if err := h.auth.ValidatePassword(req.Password); err != nil {
		return httpx.Validation(map[string]string{"password": err.Error()})
	}
	target, err := h.store.ByID(c.Context(), id)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	if id != h.auth.CallerID(c) && !CanManage(h.auth.CallerRole(c), target.Role) {
		return errSuperAdminRequired()
	}
	err = h.auth.SetPassword(c.Context(), id, req.Password, "")
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	h.audit.Record(c.Context(), audit.Event{UserID: h.auth.CallerID(c), Action: "admin.password_reset",
		TargetType: "user", TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c)})
	return c.SendStatus(fiber.StatusNoContent)
}
