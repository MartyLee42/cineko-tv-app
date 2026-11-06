package auth

import (
	"slices"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/users"
)

// Kind is how a request authenticated.
type Kind string

const (
	KindSession Kind = "session" // browser cookie
	KindToken   Kind = "token"   // personal API token
	KindDevice  Kind = "device"  // paired TV credential
)

// API token scopes.
const (
	ScopeRead           = "read"
	ScopeWrite          = "write"
	ScopeAdmin          = "admin"
	ScopeDeviceRegister = "device:register"
)

var AllScopes = []string{ScopeRead, ScopeWrite, ScopeAdmin, ScopeDeviceRegister}

// Roles, from least to most privileged: user < admin < super_admin. A
// super_admin can do everything an admin can, and is the only one who may
// grant or revoke admin/super_admin or see other people's devices and
// pairing requests.
// (Defined in package users, which owns accounts; re-exported here.)
const (
	RoleUser       = users.RoleUser
	RoleAdmin      = users.RoleAdmin
	RoleSuperAdmin = users.RoleSuperAdmin
)

// IsAdminRole reports whether role has administrator rights (admin or super_admin).
func IsAdminRole(role string) bool { return users.IsAdminRole(role) }

// Principal is the authenticated caller of a request.
type Principal struct {
	Kind      Kind
	UserID    string // account; for devices, the device owner
	Username  string
	Role      string
	SessionID string // KindSession
	CSRFToken string // KindSession
	TokenID   string // KindToken
	Scopes    []string
	DeviceID  string // KindDevice
}

// IsAdmin reports administrator rights (admin or super_admin).
func (p *Principal) IsAdmin() bool { return IsAdminRole(p.Role) }

// IsSuperAdmin reports the super_admin role.
func (p *Principal) IsSuperAdmin() bool { return p.Role == RoleSuperAdmin }

// HasScope reports whether the principal may act with scope. Browser sessions
// carry every scope their role allows.
func (p *Principal) HasScope(scope string) bool {
	switch p.Kind {
	case KindSession:
		return scope != ScopeAdmin || p.IsAdmin()
	case KindToken:
		if scope == ScopeAdmin && !p.IsAdmin() {
			return false
		}
		return slices.Contains(p.Scopes, scope)
	default:
		return false
	}
}

type principalKey struct{}

func setPrincipal(c fiber.Ctx, p *Principal) { c.Locals(principalKey{}, p) }

// PrincipalFrom returns the request's principal or nil.
func PrincipalFrom(c fiber.Ctx) *Principal {
	p, _ := c.Locals(principalKey{}).(*Principal)
	return p
}
