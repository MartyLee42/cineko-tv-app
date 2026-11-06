package sysmon

import (
	"strconv"

	"github.com/gofiber/fiber/v3"
)

// AdminRoutes registers GET /admin/system and /admin/system/history on an
// admin-only group.
func (s *Service) AdminRoutes(admin fiber.Router) {
	admin.Get("/system", func(c fiber.Ctx) error {
		c.Set(fiber.HeaderCacheControl, "no-store")
		return c.JSON(s.Status(c.Context()))
	})
	admin.Get("/system/history", func(c fiber.Ctx) error {
		m, _ := strconv.Atoi(c.Query("minutes"))
		c.Set(fiber.HeaderCacheControl, "no-store")
		return c.JSON(s.History(c.Context(), m))
	})
}
