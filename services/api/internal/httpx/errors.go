// Package httpx holds HTTP plumbing shared by all API modules: the error
// envelope, request IDs, structured request logs, origin checks and rate limits.
package httpx

import (
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
)

// Error is the single error type handlers return. It is rendered as
//
//	{"error": {"code": "...", "message": "...", "request_id": "...", "fields": {...}}}
type Error struct {
	Status     int               `json:"-"`
	Code       string            `json:"code"`
	Message    string            `json:"message"`
	Fields     map[string]string `json:"fields,omitempty"`
	RequestID  string            `json:"request_id,omitempty"`
	RetryAfter time.Duration     `json:"-"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func NewError(status int, code, msg string) *Error {
	return &Error{Status: status, Code: code, Message: msg}
}

func BadRequest(msg string) *Error { return NewError(fiber.StatusBadRequest, "bad_request", msg) }
func Unauthorized() *Error {
	return NewError(fiber.StatusUnauthorized, "unauthorized", "Authentication required.")
}
func Forbidden() *Error {
	return NewError(fiber.StatusForbidden, "forbidden", "You do not have access to this resource.")
}
func NotFound() *Error { return NewError(fiber.StatusNotFound, "not_found", "Not found.") }
func Conflict(code, msg string) *Error {
	return NewError(fiber.StatusConflict, code, msg)
}
func Gone(code, msg string) *Error { return NewError(fiber.StatusGone, code, msg) }
func TooManyRequests(retryAfter time.Duration) *Error {
	e := NewError(fiber.StatusTooManyRequests, "rate_limited", "Too many attempts. Try again later.")
	e.RetryAfter = retryAfter
	return e
}

// Validation returns a 422 with per-field messages.
func Validation(fields map[string]string) *Error {
	return &Error{Status: fiber.StatusUnprocessableEntity, Code: "validation_failed",
		Message: "Some fields are invalid.", Fields: fields}
}

// ErrorHandler renders every error as the standard envelope. Unknown errors
// become a generic 500 so internal details never reach clients.
func ErrorHandler(log *slog.Logger) fiber.ErrorHandler {
	return func(c fiber.Ctx, err error) error {
		var apiErr *Error
		var fErr *fiber.Error
		switch {
		case errors.As(err, &apiErr):
			cp := *apiErr
			apiErr = &cp
		case errors.As(err, &fErr):
			apiErr = NewError(fErr.Code, codeForStatus(fErr.Code), fErr.Message)
		default:
			log.ErrorContext(c.Context(), "unhandled error",
				"err", err, "request_id", RequestID(c), "path", c.Path())
			apiErr = NewError(fiber.StatusInternalServerError, "internal", "Something went wrong.")
		}
		apiErr.RequestID = RequestID(c)
		if apiErr.RetryAfter > 0 {
			c.Set(fiber.HeaderRetryAfter, strconv.Itoa(int(apiErr.RetryAfter.Seconds()+0.999)))
		}
		return c.Status(apiErr.Status).JSON(fiber.Map{"error": apiErr})
	}
}

func codeForStatus(status int) string {
	switch status {
	case fiber.StatusNotFound:
		return "not_found"
	case fiber.StatusMethodNotAllowed:
		return "method_not_allowed"
	case fiber.StatusRequestEntityTooLarge:
		return "payload_too_large"
	case fiber.StatusBadRequest, fiber.StatusUnprocessableEntity:
		return "bad_request"
	case fiber.StatusUnauthorized:
		return "unauthorized"
	case fiber.StatusForbidden:
		return "forbidden"
	default:
		if status >= 500 {
			return "internal"
		}
		return "error"
	}
}

// BindJSON decodes a JSON body, returning a 400 envelope on malformed input.
func BindJSON(c fiber.Ctx, out any) error {
	if len(c.Body()) == 0 {
		return BadRequest("Request body is required.")
	}
	if err := c.Bind().WithoutAutoHandling().JSON(out); err != nil {
		return BadRequest("Malformed JSON body.")
	}
	return nil
}

// List wraps a slice in the standard collection envelope.
func List[T any](items []T) fiber.Map {
	if items == nil {
		items = []T{}
	}
	return fiber.Map{"items": items}
}

// ParamUUID returns the named route param if it is a UUID, else a 404 error.
func ParamUUID(c fiber.Ctx, name string) (string, error) {
	v := c.Params(name)
	if _, err := uuid.Parse(v); err != nil || len(v) != 36 {
		return "", NotFound()
	}
	// Copy: Fiber params alias the request buffer, and ids may outlive the
	// handler (background work).
	return strings.Clone(v), nil
}
