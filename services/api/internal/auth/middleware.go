package auth

import (
	"crypto/subtle"
	"errors"
	"strings"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/httpx"
)

const (
	SessionCookie = "mt_session"
	HeaderCSRF    = "X-CSRF-Token"
)

// Middleware resolves and enforces authentication.
type Middleware struct {
	svc     *Service
	origins []string
	secure  bool
}

func NewMiddleware(svc *Service, allowedOrigins []string, cookieSecure bool) *Middleware {
	return &Middleware{svc: svc, origins: allowedOrigins, secure: cookieSecure}
}

// Authenticate attaches a Principal when the request carries valid
// credentials. A bad bearer token is rejected outright; a stale cookie is
// cleared and the request continues anonymously.
func (m *Middleware) Authenticate() fiber.Handler {
	return func(c fiber.Ctx) error {
		if h := c.Get(fiber.HeaderAuthorization); h != "" {
			token := ParseBearer(h)
			if token == "" {
				// Other schemes (e.g. "Pairing") are handled by their routes.
				return c.Next()
			}
			p, err := m.svc.ResolveBearer(c.Context(), token)
			if errors.Is(err, ErrNotFound) {
				return httpx.NewError(fiber.StatusUnauthorized, "invalid_token", "The token is invalid, expired or revoked.")
			}
			if err != nil {
				return err
			}
			m.attach(c, p)
			return c.Next()
		}
		if cookie := c.Cookies(SessionCookie); cookie != "" {
			p, err := m.svc.ResolveSession(c.Context(), cookie)
			switch {
			case errors.Is(err, ErrNotFound):
				m.ClearCookie(c)
			case err != nil:
				return err
			default:
				m.attach(c, p)
			}
		}
		return c.Next()
	}
}

func (m *Middleware) attach(c fiber.Ctx, p *Principal) {
	setPrincipal(c, p)
	httpx.SetLogUser(c, p.UserID)
}

// CSRF protects state-changing requests made with cookies: the Origin must be
// allowed and, for logged-in sessions, X-CSRF-Token must match the session's
// token. Bearer-token requests are not exposed to CSRF and skip the token check.
func (m *Middleware) CSRF() fiber.Handler {
	return func(c fiber.Ctx) error {
		switch c.Method() {
		case fiber.MethodGet, fiber.MethodHead, fiber.MethodOptions:
			return c.Next()
		}
		p := PrincipalFrom(c)
		if p != nil && p.Kind != KindSession {
			return c.Next()
		}
		if capabilityAuthenticated(c) {
			return c.Next()
		}
		if !httpx.OriginAllowed(c, m.origins) {
			return httpx.NewError(fiber.StatusForbidden, "bad_origin", "Request origin is not allowed.")
		}
		if p != nil && !sessionIndependent(c) && !originOnly(c) {
			got := c.Get(HeaderCSRF)
			if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(p.CSRFToken)) != 1 {
				return httpx.NewError(fiber.StatusForbidden, "csrf_failed", "Missing or invalid CSRF token.")
			}
		}
		return c.Next()
	}
}

// sessionIndependent lists endpoints that never act on behalf of the cookie's
// user: the TV side of pairing. A TV app opened in a browser that is also
// signed in to the PWA still sends the cookie, but these handlers ignore it,
// so there is nothing for CSRF to protect.
func sessionIndependent(c fiber.Ctx) bool {
	if c.Method() != fiber.MethodPost {
		return false
	}
	path := c.Path()
	return path == "/api/v1/pairing" || path == "/api/v1/pairing/" ||
		(strings.HasPrefix(path, "/api/v1/pairing/") && strings.HasSuffix(path, "/exchange"))
}

// originOnly lists cookie-session endpoints that check the Origin but not
// X-CSRF-Token: client error reports flushed with navigator.sendBeacon on
// page hide (sendBeacon cannot set headers). A forged report needs an
// allowed Origin anyway and can only add an error sample.
func originOnly(c fiber.Ctx) bool {
	return c.Method() == fiber.MethodPost && c.Path() == "/api/v1/client-errors"
}

// capabilityAuthenticated lists requests authenticated only by an unguessable
// capability in the URL, never by the cookie: progress reports sent with
// navigator.sendBeacon carry ?token=<report token> (sendBeacon cannot set
// headers). The handler then ignores the cookie's principal entirely, so
// neither Origin nor CSRF checks protect anything there.
func capabilityAuthenticated(c fiber.Ctx) bool {
	if c.Method() != fiber.MethodPost || c.Query("token") == "" {
		return false
	}
	path := c.Path()
	return strings.HasPrefix(path, "/api/v1/playback/sessions/") && strings.HasSuffix(path, "/progress") &&
		strings.Count(path, "/") == 6
}

// RequireUser allows signed-in people (cookie or API token) but not TV devices.
// API tokens need "read" for safe methods and "write" otherwise.
func RequireUser() fiber.Handler {
	return func(c fiber.Ctx) error {
		p := PrincipalFrom(c)
		if p == nil {
			return httpx.Unauthorized()
		}
		if p.Kind == KindDevice {
			return httpx.Forbidden()
		}
		if p.Kind == KindToken {
			need := ScopeWrite
			if m := c.Method(); m == fiber.MethodGet || m == fiber.MethodHead {
				need = ScopeRead
			}
			if !p.HasScope(need) {
				return httpx.NewError(fiber.StatusForbidden, "insufficient_scope", "Token lacks the "+need+" scope.")
			}
		}
		return c.Next()
	}
}

// RequireSession allows only interactive browser sessions (for sensitive
// account actions such as minting API tokens or changing passwords).
func RequireSession() fiber.Handler {
	return func(c fiber.Ctx) error {
		p := PrincipalFrom(c)
		if p == nil {
			return httpx.Unauthorized()
		}
		if p.Kind != KindSession {
			return httpx.NewError(fiber.StatusForbidden, "session_required", "This action requires signing in with a password.")
		}
		return c.Next()
	}
}

// RequireAdmin allows administrators (admin or super_admin; session, or token
// with admin scope).
func RequireAdmin() fiber.Handler {
	return func(c fiber.Ctx) error {
		p := PrincipalFrom(c)
		if p == nil {
			return httpx.Unauthorized()
		}
		if p.Kind == KindDevice || !p.HasScope(ScopeAdmin) {
			return httpx.Forbidden()
		}
		return c.Next()
	}
}

// RequireSuperAdmin allows only super_admins (session, or token with admin
// scope). Use it after RequireAdmin or on its own.
func RequireSuperAdmin() fiber.Handler {
	return func(c fiber.Ctx) error {
		p := PrincipalFrom(c)
		if p == nil {
			return httpx.Unauthorized()
		}
		if p.Kind == KindDevice || !p.HasScope(ScopeAdmin) || !p.IsSuperAdmin() {
			return httpx.NewError(fiber.StatusForbidden, "super_admin_required", "Only a super admin can do this.")
		}
		return c.Next()
	}
}

// RequireDevice allows only paired TV devices.
func RequireDevice() fiber.Handler {
	return func(c fiber.Ctx) error {
		p := PrincipalFrom(c)
		if p == nil {
			return httpx.Unauthorized()
		}
		if p.Kind != KindDevice {
			return httpx.Forbidden()
		}
		return c.Next()
	}
}

// RequireAny allows any authenticated principal.
func RequireAny() fiber.Handler {
	return func(c fiber.Ctx) error {
		if PrincipalFrom(c) == nil {
			return httpx.Unauthorized()
		}
		return c.Next()
	}
}

// RequireReader allows anyone who may browse shared, non-account data (the
// media catalog): browser sessions, paired TVs, and API tokens with "read".
func RequireReader() fiber.Handler {
	return func(c fiber.Ctx) error {
		p := PrincipalFrom(c)
		if p == nil {
			return httpx.Unauthorized()
		}
		if p.Kind == KindToken && !p.HasScope(ScopeRead) {
			return httpx.NewError(fiber.StatusForbidden, "insufficient_scope", "Token lacks the read scope.")
		}
		return c.Next()
	}
}

func (m *Middleware) SetCookie(c fiber.Ctx, s *NewSession) {
	c.Cookie(&fiber.Cookie{
		Name: SessionCookie, Value: s.Token, Path: "/", Expires: s.ExpiresAt,
		HTTPOnly: true, Secure: m.secure, SameSite: fiber.CookieSameSiteLaxMode,
	})
}

func (m *Middleware) ClearCookie(c fiber.Ctx) {
	c.Cookie(&fiber.Cookie{
		Name: SessionCookie, Value: "", Path: "/", MaxAge: -1,
		HTTPOnly: true, Secure: m.secure, SameSite: fiber.CookieSameSiteLaxMode,
	})
}

// Origins returns the allowed browser origins.
func (m *Middleware) Origins() []string { return m.origins }
