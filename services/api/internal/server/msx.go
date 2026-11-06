package server

import (
	_ "embed"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/config"
)

//go:embed msxassets/bridge.html
var msxBridgeHTML []byte

// MSXApp is one launcher button.
type MSXApp struct {
	Label string `json:"label"`
	Icon  string `json:"icon,omitempty"`  // MSX material icon name, e.g. "movie"
	URL   string `json:"url"`             // opened with the MSX "link:" action
	Image string `json:"image,omitempty"` // optional background image URL
}

// DefaultMSXApps are shown next to Cineko when MSX_APPS is not set.
var DefaultMSXApps = []MSXApp{{Label: "Lampa", Icon: "movie", URL: "http://lampa.mx/"}} // lampa.mx answers only over plain HTTP

// msxApps returns the launcher entries: Cineko first, then MSX_APPS (a JSON
// array of {label, icon, url, image}) or the defaults.
func msxApps(cfg *config.Config) []MSXApp {
	apps := []MSXApp{{Label: "Cineko", Icon: "play-circle-outline", URL: cfg.PublicBaseURL.String() + "/tv/"}}
	extra := DefaultMSXApps
	if raw := strings.TrimSpace(cfg.MSXApps); raw != "" {
		var parsed []MSXApp
		if err := json.Unmarshal([]byte(raw), &parsed); err == nil {
			extra = parsed
		}
	}
	for _, a := range extra {
		if a.Label != "" && (strings.HasPrefix(a.URL, "https://") || strings.HasPrefix(a.URL, "http://")) {
			apps = append(apps, a)
		}
	}
	return apps
}

// msxLayout places app i of n on the MSX 12×6 page grid: up to three tiles
// per row (4 wide, 3 tall); one or two apps are centred like a home screen.
func msxLayout(i, n int) string {
	if n <= 2 {
		x := 2 + i*4
		if n == 1 {
			x = 4
		}
		return strconv.Itoa(x) + ",1,4,4"
	}
	return strconv.Itoa((i%3)*4) + "," + strconv.Itoa((i/3%2)*3) + ",4,3"
}

// registerMSX serves the Media Station X launcher.
//
// On the TV: MSX → Settings → Start Parameter → Setup → enter this server's
// host (e.g. "tv.example.com", lock icon on for HTTPS). MSX loads
// {host}/msx/start.json, which points at a page of launcher buttons (Cineko,
// Lampa, …) that open each app with the "link:" action.
func registerMSX(app *fiber.App, cfg *config.Config) {
	base := cfg.PublicBaseURL.String()

	allowMSX := func(c fiber.Ctx) error {
		// MSX fetches these JSON files cross-origin from its own web app.
		c.Set(fiber.HeaderAccessControlAllowOrigin, "*")
		c.Set(fiber.HeaderCacheControl, "no-cache")
		return c.Next()
	}

	app.Get("/msx/start.json", allowMSX, func(c fiber.Ctx) error {
		// With the bridge, MSX loads the menu through the Cineko interaction
		// plugin, which stays loaded and can start MSX's native player.
		param := "content:request:interaction:init@" + base + "/msx/bridge.html"
		if !cfg.MSXBridge {
			param = "content:" + base + "/msx/menu.json"
		}
		return c.JSON(fiber.Map{
			"name":      "Cineko Launcher",
			"version":   "1.2.0",
			"parameter": param,
			"welcome":   "none",
		})
	})

	app.Get("/msx/bridge.html", func(c fiber.Ctx) error {
		c.Set(fiber.HeaderContentType, "text/html; charset=utf-8")
		c.Set(fiber.HeaderCacheControl, "no-cache")
		return c.Send(msxBridgeHTML)
	})

	app.Get("/msx/menu.json", allowMSX, func(c fiber.Ctx) error {
		apps := msxApps(cfg)
		items := make([]fiber.Map, 0, len(apps))
		for i, a := range apps {
			item := fiber.Map{
				"type":   "button",
				"layout": msxLayout(i, len(apps)),
				"label":  a.Label,
				"action": "link:" + a.URL,
			}
			if a.Icon != "" {
				item["icon"] = a.Icon
			}
			if a.Image != "" {
				item["image"] = a.Image
			}
			items = append(items, item)
		}
		// Pages hold at most 6 rows; with >6 apps split into several pages.
		var pages []fiber.Map
		for len(items) > 0 {
			n := min(len(items), 6)
			pages = append(pages, fiber.Map{"items": items[:n]})
			items = items[n:]
		}
		return c.JSON(fiber.Map{"type": "pages", "headline": "Cineko", "pages": pages})
	})
}
