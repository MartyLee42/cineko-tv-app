package httpx

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
)

type ctxKey int

const (
	requestIDKey ctxKey = iota
	logUserKey
)

const HeaderRequestID = "X-Request-ID"

var validRequestID = regexp.MustCompile(`^[a-zA-Z0-9-]{8,64}$`)

// RequestIDMiddleware accepts a well-formed incoming X-Request-ID (from the
// reverse proxy) or generates one, and echoes it in the response.
func RequestIDMiddleware() fiber.Handler {
	return func(c fiber.Ctx) error {
		id := c.Get(HeaderRequestID)
		if !validRequestID.MatchString(id) {
			var b [12]byte
			_, _ = rand.Read(b[:])
			id = hex.EncodeToString(b[:])
		}
		c.Locals(requestIDKey, id)
		c.Set(HeaderRequestID, id)
		return c.Next()
	}
}

func RequestID(c fiber.Ctx) string {
	id, _ := c.Locals(requestIDKey).(string)
	return id
}

// SetLogUser attaches the authenticated user ID to the request log line.
func SetLogUser(c fiber.Ctx, userID string) { c.Locals(logUserKey, userID) }

// LoggerMiddleware writes one structured line per request. It logs the path
// only (never the query string, headers or body) so secrets cannot leak.
func LoggerMiddleware(log *slog.Logger) fiber.Handler {
	return func(c fiber.Ctx) error {
		start := time.Now()
		err := c.Next()
		status := c.Response().StatusCode()
		if err != nil {
			// The error handler has not run yet; estimate the final status.
			if e, ok := err.(*Error); ok {
				status = e.Status
			} else if fe, ok := err.(*fiber.Error); ok {
				status = fe.Code
			} else {
				status = fiber.StatusInternalServerError
			}
		}
		path := c.Path()
		if strings.HasPrefix(path, "/healthz") || strings.HasPrefix(path, "/readyz") {
			return err
		}
		level := slog.LevelInfo
		if status >= 500 {
			level = slog.LevelError
		}
		attrs := []any{
			"method", c.Method(), "path", path, "status", status,
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", RequestID(c), "ip", c.IP(),
		}
		if uid, ok := c.Locals(logUserKey).(string); ok && uid != "" {
			attrs = append(attrs, "user_id", uid)
		}
		log.Log(c.Context(), level, "request", attrs...)
		return err
	}
}

// SecurityHeaders sets conservative response headers for API responses.
func SecurityHeaders() fiber.Handler {
	return func(c fiber.Ctx) error {
		c.Set("X-Content-Type-Options", "nosniff")
		c.Set("Referrer-Policy", "no-referrer")
		c.Set("Cache-Control", "no-store")
		return c.Next()
	}
}

// OriginAllowed reports whether the request's Origin (or, failing that,
// Referer) matches one of the allowed origins. Requests with neither header
// are treated as non-browser clients and allowed; callers that rely on
// cookies must additionally check CSRF tokens.
func OriginAllowed(c fiber.Ctx, allowed []string) bool {
	origin := c.Get(fiber.HeaderOrigin)
	if origin == "" {
		ref := c.Get(fiber.HeaderReferer)
		if ref == "" {
			return true
		}
		origin = originOf(ref)
	}
	return MatchOrigin(origin, allowed)
}

// MatchOrigin checks an origin string against the allow list.
func MatchOrigin(origin string, allowed []string) bool {
	origin = strings.TrimRight(strings.ToLower(origin), "/")
	for _, a := range allowed {
		if strings.EqualFold(origin, a) {
			return true
		}
	}
	return false
}

func originOf(u string) string {
	i := strings.Index(u, "://")
	if i < 0 {
		return ""
	}
	rest := u[i+3:]
	if j := strings.IndexAny(rest, "/?#"); j >= 0 {
		rest = rest[:j]
	}
	return u[:i+3] + rest
}
