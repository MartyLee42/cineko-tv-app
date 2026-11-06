package imports

import (
	"errors"
	"io"
	"strings"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
)

// MaxFileBytes caps the uploaded CSV (the owner's ~2 200 ratings are ~300 KB).
const MaxFileBytes = 5 << 20

// MaxBodyBytes is the app-wide body limit needed for the upload (the file
// plus multipart overhead); LimitOtherBodies keeps every other route at
// the usual 1 MiB.
const MaxBodyBytes = MaxFileBytes + 256<<10

// DefaultBodyBytes is the limit for every route but the import upload.
const DefaultBodyBytes = 1 << 20

const uploadSuffix = "/imports/kinopoisk"

// LimitOtherBodies rejects bodies over DefaultBodyBytes except on the
// import upload. Use with fiber.Config.BodyLimit = MaxBodyBytes.
func LimitOtherBodies() fiber.Handler {
	return func(c fiber.Ctx) error {
		if len(c.Body()) > DefaultBodyBytes &&
			!(c.Method() == fiber.MethodPost && strings.HasSuffix(c.Path(), uploadSuffix)) &&
			!(c.Method() == fiber.MethodPut && strings.HasPrefix(c.Path(), "/api/v1/admin/iptv/playlists/") && strings.HasSuffix(c.Path(), "/content")) {
			return httpx.NewError(fiber.StatusRequestEntityTooLarge, "payload_too_large", "Request body is too large.")
		}
		return c.Next()
	}
}

type Handlers struct {
	svc      *Service
	profiles *profiles.Store
}

func NewHandlers(s *Service, p *profiles.Store) *Handlers { return &Handlers{svc: s, profiles: p} }

// Routes: per-route middleware (a Group on /profiles would wrap every
// existing /profiles/:id/* route).
func (h *Handlers) Routes(r fiber.Router) {
	r.Post("/profiles/:id/imports/kinopoisk", auth.RequireUser(), h.create)
	r.Get("/profiles/:id/imports/kinopoisk", auth.RequireUser(), h.latest)
	r.Get("/imports/:jobId", auth.RequireUser(), h.get)
}

// ownedProfile: only the profile's owner may import into it (404 otherwise).
func (h *Handlers) ownedProfile(c fiber.Ctx) (string, string, error) {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return "", "", err
	}
	p := auth.PrincipalFrom(c)
	if _, err := h.profiles.GetOwned(c.Context(), p.UserID, id); errors.Is(err, profiles.ErrNotFound) {
		return "", "", httpx.NotFound()
	} else if err != nil {
		return "", "", err
	}
	return p.UserID, id, nil
}

// boolOpt reads a switch from the multipart form or the query.
func boolOpt(c fiber.Ctx, name string, def bool, fields map[string]string) bool {
	v := c.FormValue(name)
	if v == "" {
		v = c.Query(name)
	}
	switch strings.ToLower(v) {
	case "":
		return def
	case "true", "1", "on", "yes":
		return true
	case "false", "0", "off", "no":
		return false
	}
	fields[name] = "must be true or false"
	return def
}

func (h *Handlers) create(c fiber.Ctx) error {
	userID, profileID, err := h.ownedProfile(c)
	if err != nil {
		return err
	}
	fields := map[string]string{}
	o := Options{
		Overwrite:   boolOpt(c, "overwrite", false, fields),
		MarkWatched: boolOpt(c, "mark_watched", true, fields),
		DryRun:      boolOpt(c, "dry_run", false, fields),
	}
	fh, err := c.FormFile("file")
	switch {
	case err != nil:
		fields["file"] = "required (multipart field \"file\")"
	case fh.Size > MaxFileBytes:
		fields["file"] = "must be at most 5 MB"
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	f, err := fh.Open()
	if err != nil {
		return err
	}
	defer f.Close()
	rows, err := ParseCSV(io.LimitReader(f, MaxFileBytes+1))
	switch {
	case errors.Is(err, ErrBadHeader):
		return httpx.Validation(map[string]string{"file": "not a Kinopoisk ratings export"})
	case err != nil:
		return httpx.Validation(map[string]string{"file": "unreadable CSV"})
	case len(rows) == 0:
		return httpx.Validation(map[string]string{"file": "no ratings in the file"})
	}
	id, err := h.svc.Create(c.Context(), userID, profileID, rows, o)
	if errors.Is(err, ErrActive) {
		return httpx.Conflict("import_in_progress", "An import is already running for this profile.")
	}
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{"job_id": id})
}

func (h *Handlers) latest(c fiber.Ctx) error {
	_, profileID, err := h.ownedProfile(c)
	if err != nil {
		return err
	}
	j, err := h.svc.Latest(c.Context(), profileID)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	return c.JSON(j)
}

func (h *Handlers) get(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "jobId")
	if err != nil {
		return err
	}
	j, err := h.svc.Get(c.Context(), auth.PrincipalFrom(c).UserID, id)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	return c.JSON(j)
}
