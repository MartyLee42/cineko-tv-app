package sourcesapi

import (
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
	"martytv/api/internal/releases"
	"martytv/api/internal/sources"
)

type Handlers struct {
	svc      *Service
	reg      *sources.Registry
	profiles *profiles.Store
	audit    *audit.Logger
	refresh  *httpx.RateLimiter
}

func NewHandlers(svc *Service, profileStore *profiles.Store, auditLog *audit.Logger) *Handlers {
	return &Handlers{svc: svc, reg: svc.reg, profiles: profileStore, audit: auditLog,
		refresh: httpx.NewRateLimiter(6, 10*time.Minute)}
}

// Routes registers GET /sources and GET /media/:id/online.
func (h *Handlers) Routes(api fiber.Router) {
	api.Get("/sources", auth.RequireReader(), h.catalog)
	api.Get("/media/:id/online", auth.RequireReader(), h.online)
}

// AdminRoutes registers /admin/sources* on the admin group.
func (h *Handlers) AdminRoutes(admin fiber.Router) {
	admin.Get("/sources", h.adminList)
	admin.Get("/sources/:id", h.adminGet)
	admin.Patch("/sources/:id", h.adminPatch)
	admin.Post("/sources/:id/probe", h.adminProbe)
}

// SourceItem is GET /sources item: Info plus the profile's choice.
type SourceItem struct {
	sources.Info
	// Enabled: the profile (or the default "all") includes this source.
	Enabled bool `json:"enabled"`
	// Available: enabled by the admin and configured, so it is searched
	// when Enabled.
	Available bool `json:"available"`
}

func (h *Handlers) profileID(c fiber.Ctx) (string, error) {
	id := strings.Clone(c.Query("profile_id"))
	if id == "" {
		return "", nil
	}
	if _, err := uuid.Parse(id); err != nil || len(id) != 36 {
		return "", httpx.Validation(map[string]string{"profile_id": "must be a UUID"})
	}
	ok, err := h.profiles.CanUse(c.Context(), auth.PrincipalFrom(c), id)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", httpx.NotFound()
	}
	return id, nil
}

func (h *Handlers) selection(c fiber.Ctx, profileID string) (sources.Selection, error) {
	if profileID == "" {
		return sources.AllSources, nil
	}
	st, err := h.profiles.GetSettings(c.Context(), profileID)
	if err != nil {
		return sources.Selection{}, err
	}
	return *releases.SelectionOf(st.Sources), nil
}

func (h *Handlers) catalog(c fiber.Ctx) error {
	pid, err := h.profileID(c)
	if err != nil {
		return err
	}
	sel, err := h.selection(c, pid)
	if err != nil {
		return err
	}
	var out []SourceItem
	for _, in := range h.reg.List(c.Context()) {
		out = append(out, SourceItem{Info: in, Enabled: sel.Allows(in.ID), Available: in.EnabledByAdmin && in.Configured})
	}
	enabled := any("all")
	if !sel.All {
		enabled = append([]string{}, sel.IDs...)
	}
	if out == nil {
		out = []SourceItem{}
	}
	return c.JSON(fiber.Map{"items": out, "enabled": enabled})
}

func (h *Handlers) online(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	fields := map[string]string{}
	intParam := func(name string, lo, hi int) *int {
		v := strings.TrimSpace(c.Query(name))
		if v == "" {
			return nil
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < lo || n > hi {
			fields[name] = "must be an integer between " + strconv.Itoa(lo) + " and " + strconv.Itoa(hi)
			return nil
		}
		return &n
	}
	season := intParam("season", 0, 1000)
	episode := intParam("episode", 1, 10000)
	refresh := false
	switch strings.ToLower(c.Query("refresh")) {
	case "", "false", "0":
	case "true", "1":
		refresh = true
	default:
		fields["refresh"] = "must be true or false"
	}
	lang := strings.Clone(c.Query("lang"))
	switch lang {
	case "", "en", "ru":
	default:
		fields["lang"] = "must be one of: en, ru"
	}
	if episode != nil && season == nil && fields["season"] == "" {
		fields["episode"] = "requires season"
	}
	if pid := c.Query("profile_id"); pid != "" {
		if _, err := uuid.Parse(pid); err != nil || len(pid) != 36 {
			fields["profile_id"] = "must be a UUID"
		}
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	pid, err := h.profileID(c)
	if err != nil {
		return err
	}
	sel, err := h.selection(c, pid)
	if err != nil {
		return err
	}
	prefs := releases.Prefs{Languages: []string{"ru", "en"}}
	if lang == "en" {
		prefs.Languages = []string{"en", "ru"}
	}
	if pid != "" {
		pp, err := h.profiles.GetPreferences(c.Context(), pid)
		if err != nil {
			return err
		}
		prefs = releases.PrefsOf(pp)
	}
	if refresh {
		p := auth.PrincipalFrom(c)
		key := "u:" + p.UserID
		if p.Kind == auth.KindDevice {
			key = "d:" + p.DeviceID
		}
		if ok, wait := h.refresh.Allow(key); !ok {
			return httpx.TooManyRequests(wait)
		}
	}
	list, err := h.svc.Search(c.Context(), SearchParams{MediaID: id, Season: season, Episode: episode,
		Refresh: refresh, Prefs: prefs, Sources: sel})
	var fe *FieldError
	switch {
	case err == nil:
		return c.JSON(list)
	case errors.As(err, &fe):
		return httpx.Validation(map[string]string{fe.Field: fe.Message})
	case errors.Is(err, ErrNotFound):
		return httpx.NotFound()
	case errors.Is(err, ErrCatalog):
		h.svc.log.WarnContext(c.Context(), "online target lookup failed", "err", err)
		return httpx.NewError(fiber.StatusBadGateway, "catalog_upstream_error", "TMDB is unreachable right now. Try again later.")
	}
	return err
}

// ---------------------------------------------------------------- admin

func (h *Handlers) adminList(c fiber.Ctx) error {
	return c.JSON(httpx.List(h.reg.AdminList(c.Context())))
}

func (h *Handlers) adminGet(c fiber.Ctx) error {
	v, err := h.reg.Admin(c.Context(), c.Params("id"))
	if errors.Is(err, sources.ErrNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	return c.JSON(v)
}

var credKeyRe = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

func (h *Handlers) adminPatch(c fiber.Ctx) error {
	id := strings.Clone(c.Params("id"))
	if _, ok := h.reg.Provider(id); !ok {
		return httpx.NotFound()
	}
	var in sources.Patch
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	fields := map[string]string{}
	if in.BaseURL != nil {
		// One URL, or "primary, mirror…" (≤ 5, comma/space separated) for
		// providers with fallback hosts (Collaps).
		v := strings.TrimSpace(*in.BaseURL)
		parts := strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' || r == ';' || r == '\n' })
		if len(v) > 512 || len(parts) > 5 {
			fields["base_url"] = "must be an http(s) URL without credentials (or empty for the default)"
		}
		for i, part := range parts {
			u, err := url.Parse(part)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
				fields["base_url"] = "must be an http(s) URL without credentials (or empty for the default)"
			}
			parts[i] = strings.TrimRight(part, "/")
		}
		v = strings.Join(parts, ", ")
		in.BaseURL = &v
	}
	if in.Credentials != nil {
		if len(in.Credentials) > 10 {
			fields["credentials"] = "at most 10 keys"
		}
		for k, v := range in.Credentials {
			if !credKeyRe.MatchString(k) || len(v) > 4096 {
				fields["credentials"] = "keys must match ^[a-z0-9_]{1,32}$, values ≤ 4096 chars"
				break
			}
		}
	}
	if in.Enabled == nil && in.BaseURL == nil && in.Credentials == nil {
		fields["body"] = "nothing to change"
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	p := auth.PrincipalFrom(c)
	if err := h.reg.Update(c.Context(), id, in, p.UserID); err != nil {
		return err
	}
	meta := map[string]any{}
	if in.Enabled != nil {
		meta["enabled"] = *in.Enabled
	}
	if in.BaseURL != nil {
		meta["base_url_set"] = *in.BaseURL != ""
	}
	if in.Credentials != nil {
		meta["credentials_set"] = len(in.Credentials) > 0 // never the values
	}
	h.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "sources.updated", TargetType: "source",
		TargetID: id, IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: meta})
	return h.adminGet(c)
}

func (h *Handlers) adminProbe(c fiber.Ctx) error {
	id := strings.Clone(c.Params("id"))
	if _, err := h.reg.Probe(c.Context(), id); errors.Is(err, sources.ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	return h.adminGet(c)
}
