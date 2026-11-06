package pairing

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/db"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
)

// AdminRecentWindow is how long ended (expired or rejected) requests stay in
// the super_admin list.
const AdminRecentWindow = time.Hour

// AdminRequest is a pairing request as a super_admin sees it (Admin →
// «Устройства»). Never the poll secret.
type AdminRequest struct {
	ID         string     `json:"id"`
	UserCode   string     `json:"user_code"`
	DeviceName string     `json:"device_name"`
	Platform   string     `json:"platform"`
	UserAgent  string     `json:"user_agent"`
	IP         string     `json:"ip"`
	Status     string     `json:"status"` // pending | approved | expired | denied
	ApprovedBy *string    `json:"approved_by_username"`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  time.Time  `json:"expires_at"`
	DecidedAt  *time.Time `json:"decided_at"`
}

// AdminList returns pending requests, approved ones the TV hasn't exchanged
// yet, and requests that expired or were rejected within AdminRecentWindow,
// newest first. Consumed (paired) requests are omitted: they are devices now.
func (s *Service) AdminList(ctx context.Context) ([]AdminRequest, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT ps.id, ps.user_code, ps.device_name, ps.platform, ps.user_agent, ps.ip, ps.status,
		       u.username, ps.created_at, ps.expires_at, ps.decided_at
		FROM pairing_sessions ps
		LEFT JOIN users u ON u.id = ps.approved_by_user_id AND ps.status = 'approved'
		WHERE (ps.status IN ('pending', 'approved') AND ps.expires_at > $1)
		   OR (ps.status = 'denied' AND ps.decided_at > $1)
		ORDER BY ps.created_at DESC
		LIMIT 200`, s.now().UTC().Add(-AdminRecentWindow))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminRequest{}
	for rows.Next() {
		var r AdminRequest
		if err := rows.Scan(&r.ID, &r.UserCode, &r.DeviceName, &r.Platform, &r.UserAgent, &r.IP, &r.Status,
			&r.ApprovedBy, &r.CreatedAt, &r.ExpiresAt, &r.DecidedAt); err != nil {
			return nil, err
		}
		r.UserCode = FormatCode(r.UserCode)
		if (r.Status == StatusPending || r.Status == StatusApproved) && !s.now().Before(r.ExpiresAt) {
			r.Status = StatusExpired
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AdminReject rejects a pending request or cancels an approved one the TV
// hasn't exchanged yet; the TV's next poll sees "denied". It returns the
// status the request had.
func (s *Service) AdminReject(ctx context.Context, id string) (string, error) {
	var prev string
	err := s.pool.QueryRow(ctx, `
		UPDATE pairing_sessions ps SET status = 'denied', decided_at = now()
		FROM (SELECT id, status FROM pairing_sessions WHERE id = $1 FOR UPDATE) old
		WHERE ps.id = old.id AND ps.status IN ('pending', 'approved') AND ps.expires_at > now()
		RETURNING old.status`, id).Scan(&prev)
	if db.IsNoRows(err) {
		return "", ErrNotPending
	}
	return prev, err
}

// ErrUserUnavailable: the account to assign a TV to is unknown or disabled.
var ErrUserUnavailable = errors.New("user unknown or disabled")

// AdminApprove approves a pending request on behalf of userID (a super_admin
// assigning the TV to someone): exactly the owner's Approve, so the TV's
// exchange creates a device owned by userID. Without defaultProfileID the
// user's first profile is used (one is created if they have none). It returns
// the profile used.
func (s *Service) AdminApprove(ctx context.Context, id, userID, name string, defaultProfileID *string) (string, error) {
	var ok bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND disabled_at IS NULL)`, userID).Scan(&ok); err != nil {
		return "", err
	}
	if !ok {
		return "", ErrUserUnavailable
	}
	if defaultProfileID == nil {
		if err := profiles.NewStore(s.pool).EnsureDefault(ctx, userID); err != nil {
			return "", err
		}
		var pid string
		if err := s.pool.QueryRow(ctx, `SELECT id FROM profiles WHERE user_id = $1 ORDER BY created_at, id LIMIT 1`, userID).Scan(&pid); err != nil {
			return "", err
		}
		defaultProfileID = &pid
	}
	if err := s.Approve(ctx, id, userID, name, defaultProfileID); err != nil {
		return "", err
	}
	return *defaultProfileID, nil
}

// WatchExpiries calls notify (at most once per tick) when a pending or
// approved request has run out since the last tick, so the super_admin view
// can flip it to «истёк» without polling. It returns when ctx ends.
func (s *Service) WatchExpiries(ctx context.Context, every time.Duration, notify func()) {
	t := time.NewTicker(every)
	defer t.Stop()
	last := s.now().UTC()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		now := s.now().UTC()
		var expired bool
		err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pairing_sessions
			WHERE status IN ('pending', 'approved') AND expires_at > $1 AND expires_at <= $2)`, last, now).Scan(&expired)
		if err == nil {
			last = now
			if expired {
				notify()
			}
		}
	}
}

// AdminRoutes mounts the super_admin pairing views under the admin group:
// GET /admin/pairing, POST /admin/pairing/{id}/reject and
// POST /admin/pairing/{id}/approve (accept and assign to a user).
func (h *Handlers) AdminRoutes(admin fiber.Router) {
	g := admin.Group("/pairing", auth.RequireSuperAdmin())
	g.Get("/", h.adminList)
	g.Post("/:id/reject", h.adminReject)
	g.Post("/:id/approve", h.adminApprove)
	g.Get("/assignees", h.adminAssignees)
}

// Assignee is an enabled account a super_admin can give a TV to, with its
// viewing profiles (for the default-profile select).
type Assignee struct {
	ID          string            `json:"id"`
	Username    string            `json:"username"`
	DisplayName string            `json:"display_name"`
	Profiles    []AssigneeProfile `json:"profiles"`
}

type AssigneeProfile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Assignees lists enabled users and their profiles (oldest first, as
// AdminApprove picks the default).
func (s *Service) Assignees(ctx context.Context) ([]Assignee, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT u.id, u.username, u.display_name,
		       coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.created_at, p.id)
		                 FROM profiles p WHERE p.user_id = u.id), '[]'::json)
		FROM users u WHERE u.disabled_at IS NULL ORDER BY lower(u.username)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Assignee{}
	for rows.Next() {
		var a Assignee
		var raw []byte
		if err := rows.Scan(&a.ID, &a.Username, &a.DisplayName, &raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &a.Profiles); err != nil {
			return nil, err
		}
		if a.Profiles == nil {
			a.Profiles = []AssigneeProfile{}
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (h *Handlers) adminAssignees(c fiber.Ctx) error {
	list, err := h.svc.Assignees(c.Context())
	if err != nil {
		return err
	}
	return c.JSON(httpx.List(list))
}

// adminApprove: a super_admin accepts a pending TV and assigns it to a user
// (body {user_id, device_name?, default_profile_id?}).
func (h *Handlers) adminApprove(c fiber.Ctx) error {
	id, err := validID(c)
	if err != nil {
		return err
	}
	var req struct {
		UserID           string  `json:"user_id"`
		DeviceName       string  `json:"device_name"`
		DefaultProfileID *string `json:"default_profile_id"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	if _, err := uuid.Parse(req.UserID); err != nil {
		return httpx.Validation(map[string]string{"user_id": "must be an active user"})
	}
	req.DeviceName = strings.TrimSpace(req.DeviceName)
	if len([]rune(req.DeviceName)) > 64 {
		return httpx.Validation(map[string]string{"device_name": "at most 64 characters"})
	}
	if req.DefaultProfileID != nil {
		if _, err := uuid.Parse(*req.DefaultProfileID); err != nil {
			return httpx.Validation(map[string]string{"default_profile_id": "must be one of the user's profiles"})
		}
	}
	profileID, err := h.svc.AdminApprove(c.Context(), id, req.UserID, req.DeviceName, req.DefaultProfileID)
	switch {
	case errors.Is(err, ErrUserUnavailable):
		return httpx.Validation(map[string]string{"user_id": "must be an active user"})
	case errors.Is(err, ErrBadProfile):
		return httpx.Validation(map[string]string{"default_profile_id": "must be one of the user's profiles"})
	case errors.Is(err, ErrNotPending):
		return httpx.Gone("pairing_unavailable", "This pairing request has expired or was already handled.")
	case err != nil:
		return err
	}
	h.audit.Record(c.Context(), audit.Event{UserID: auth.PrincipalFrom(c).UserID, Action: "pairing.admin_approved",
		TargetType: "pairing", TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c),
		Metadata: map[string]any{"target_user_id": req.UserID, "device_name": req.DeviceName, "default_profile_id": profileID}})
	h.notify.UserDevicesChanged(req.UserID)
	h.notify.AdminDevicesChanged("pairing.approved")
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) adminList(c fiber.Ctx) error {
	list, err := h.svc.AdminList(c.Context())
	if err != nil {
		return err
	}
	return c.JSON(httpx.List(list))
}

func (h *Handlers) adminReject(c fiber.Ctx) error {
	id, err := validID(c)
	if err != nil {
		return err
	}
	prev, err := h.svc.AdminReject(c.Context(), id)
	if errors.Is(err, ErrNotPending) {
		return httpx.Gone("pairing_unavailable", "This pairing request has expired or was already handled.")
	}
	if err != nil {
		return err
	}
	h.audit.Record(c.Context(), audit.Event{UserID: auth.PrincipalFrom(c).UserID, Action: "admin.pairing_rejected",
		TargetType: "pairing", TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c),
		Metadata: map[string]any{"previous_status": prev}})
	h.notify.AdminDevicesChanged("pairing.rejected")
	return c.SendStatus(fiber.StatusNoContent)
}
