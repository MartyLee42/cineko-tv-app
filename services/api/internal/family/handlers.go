package family

import (
	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
)

// Routes mounts the profile-scoped family endpoints (the profile's account
// and the TVs it can be used on; other callers get 404).
func (s *Service) Routes(r fiber.Router) {
	caller := profiles.RequireProfileCaller()
	r.Get("/profiles/:id/family", caller, s.hBlock)
	r.Get("/profiles/:id/family/media/:mediaId", caller, s.hMedia)
}

func (s *Service) usable(c fiber.Ctx) (string, error) {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return "", err
	}
	ok, err := s.profiles.CanUse(c.Context(), auth.PrincipalFrom(c), id)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", httpx.NotFound()
	}
	return id, nil
}

func langOf(c fiber.Ctx) (string, error) {
	switch c.Query("lang") {
	case "", "en":
		return "en", nil
	case "ru":
		return "ru", nil
	}
	return "", httpx.Validation(map[string]string{"lang": "must be one of en, ru"})
}

func (s *Service) hBlock(c fiber.Ctx) error {
	id, err := s.usable(c)
	if err != nil {
		return err
	}
	lang, err := langOf(c)
	if err != nil {
		return err
	}
	limit := DefaultLimit
	if v := fiber.Query[int](c, "limit"); v > 0 {
		limit = min(v, 50)
	}
	b, err := s.Block(c.Context(), id, lang, limit)
	if err != nil {
		return err
	}
	return c.JSON(b)
}

func (s *Service) hMedia(c fiber.Ctx) error {
	id, err := s.usable(c)
	if err != nil {
		return err
	}
	mid, err := httpx.ParamUUID(c, "mediaId")
	if err != nil {
		return err
	}
	out, err := s.ForMedia(c.Context(), id, mid)
	if err != nil {
		return err
	}
	return c.JSON(out)
}
