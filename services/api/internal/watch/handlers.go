package watch

import (
	"errors"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/catalog"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
)

type Handlers struct{ svc *Service }

func NewHandlers(s *Service) *Handlers { return &Handlers{svc: s} }

// Routes mounts the Phase 5 user endpoints. They must be registered before
// the catalog (/media group: needs TMDB) and playback (/playback group:
// needs a principal) routes, whose group middleware would otherwise run
// first. Every profile-scoped call checks
// profiles.CanUse (404 otherwise).
func (h *Handlers) Routes(r fiber.Router) {
	caller := profiles.RequireProfileCaller()
	r.Post("/playback/sessions", caller, h.start)
	// No principal middleware: a sendBeacon report authenticates with ?token=.
	r.Post("/playback/sessions/:id/progress", h.report)

	// Per-route middleware (no Group middleware: that would also wrap the
	// existing /profiles/:id/* routes).
	r.Get("/profiles/:id/continue-watching", caller, h.continueWatching)
	r.Get("/profiles/:id/history", caller, h.history)
	r.Get("/profiles/:id/lists/:list", caller, h.list)
	r.Put("/profiles/:id/lists/:list/:mediaId", caller, h.addToList)
	r.Delete("/profiles/:id/lists/:list/:mediaId", caller, h.removeFromList)
	r.Put("/profiles/:id/ratings/:mediaId", caller, h.rate)
	r.Delete("/profiles/:id/ratings/:mediaId", caller, h.unrate)

	r.Get("/profiles/:id/new-episodes", caller, h.newEpisodes)
	r.Post("/profiles/:id/new-episodes/seen", caller, h.newEpisodesSeen)
	r.Get("/profiles/:id/new-episodes/muted", caller, h.mutedSeries)
	r.Put("/profiles/:id/new-episodes/muted/:mediaId", caller, h.muteSeries)
	r.Delete("/profiles/:id/new-episodes/muted/:mediaId", caller, h.unmuteSeries)

	r.Get("/media/:id/progress", caller, h.mediaProgress)
	r.Put("/media/:id/watched", caller, h.setWatched)
}

// fail maps service errors to the API envelope.
func fail(err error) error {
	var ve validationError
	switch {
	case errors.As(err, &ve):
		return httpx.Validation(ve)
	case errors.Is(err, ErrNotFound), errors.Is(err, catalog.ErrNotFound):
		return httpx.NotFound()
	case errors.Is(err, ErrNotSeries):
		return httpx.Validation(map[string]string{"mediaId": "must be a series"})
	case errors.Is(err, errBadToken):
		return httpx.NewError(fiber.StatusUnauthorized, "invalid_token", "The report token is invalid or expired.")
	case errors.Is(err, catalog.ErrUpstream):
		return httpx.NewError(fiber.StatusBadGateway, "catalog_upstream_error", "TMDB is unreachable right now. Try again later.")
	}
	return err
}

// profileParam validates the :id profile against the caller.
func (h *Handlers) profileParam(c fiber.Ctx) (string, error) {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return "", err
	}
	return id, h.canUse(c, id)
}

func (h *Handlers) canUse(c fiber.Ctx, profileID string) error {
	ok, err := h.svc.profiles.CanUse(c.Context(), auth.PrincipalFrom(c), profileID)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.NotFound()
	}
	return nil
}

func langParam(c fiber.Ctx) (string, error) {
	switch l := c.Query("lang"); l {
	case "", "en":
		return "en", nil
	case "ru":
		return "ru", nil
	}
	return "", httpx.Validation(map[string]string{"lang": "must be one of en, ru"})
}

func (h *Handlers) start(c fiber.Ctx) error {
	var in StartInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	res, err := h.svc.StartSession(c.Context(), auth.PrincipalFrom(c), in)
	if err != nil {
		return fail(err)
	}
	return c.Status(fiber.StatusCreated).JSON(res)
}

// report accepts application/json and text/plain (navigator.sendBeacon)
// bodies. With ?token= the report token alone authenticates the request
// (cookies are ignored, so CSRF does not apply — see auth.CSRF); otherwise
// the caller must be the session's creator.
func (h *Handlers) report(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	who := Reporter{Token: strings.Clone(c.Query("token"))}
	if who.Token == "" {
		p := auth.PrincipalFrom(c)
		if p == nil {
			return httpx.Unauthorized()
		}
		if p.Kind == auth.KindToken && !p.HasScope(auth.ScopeWrite) {
			return httpx.NewError(fiber.StatusForbidden, "insufficient_scope", "Token lacks the write scope.")
		}
		who.Principal = p
	}
	var in ReportInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	res, err := h.svc.Report(c.Context(), id, who, in)
	if err != nil {
		return fail(err)
	}
	return c.JSON(res)
}

func (h *Handlers) continueWatching(c fiber.Ctx) error {
	id, err := h.profileParam(c)
	if err != nil {
		return err
	}
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	items, err := h.svc.ContinueWatching(c.Context(), id, lang)
	if err != nil {
		return fail(err)
	}
	return c.JSON(httpx.List(items))
}

func limitParam(c fiber.Ctx) (int, error) {
	s := c.Query("limit")
	if s == "" {
		return 30, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 || n > 100 {
		return 0, httpx.Validation(map[string]string{"limit": "must be an integer from 1 to 100"})
	}
	return n, nil
}

func (h *Handlers) history(c fiber.Ctx) error {
	id, err := h.profileParam(c)
	if err != nil {
		return err
	}
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	limit, err := limitParam(c)
	if err != nil {
		return err
	}
	items, next, err := h.svc.History(c.Context(), id, strings.Clone(c.Query("cursor")), limit, lang)
	if err != nil {
		return fail(err)
	}
	if items == nil {
		items = []HistoryItem{}
	}
	return c.JSON(fiber.Map{"items": items, "next_cursor": next})
}

func listParam(c fiber.Ctx) (string, error) {
	l := c.Params("list")
	if _, ok := listTables[l]; !ok {
		return "", httpx.NotFound()
	}
	return strings.Clone(l), nil
}

func (h *Handlers) list(c fiber.Ctx) error {
	id, err := h.profileParam(c)
	if err != nil {
		return err
	}
	list, err := listParam(c)
	if err != nil {
		return err
	}
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	page := 1
	if s := c.Query("page"); s != "" {
		if page, err = strconv.Atoi(s); err != nil || page < 1 || page > 500 {
			return httpx.Validation(map[string]string{"page": "must be an integer from 1 to 500"})
		}
	}
	res, err := h.svc.List(c.Context(), id, list, lang, page)
	if err != nil {
		return fail(err)
	}
	return c.JSON(res)
}

func (h *Handlers) listTarget(c fiber.Ctx) (profileID, list, mediaID string, err error) {
	if profileID, err = h.profileParam(c); err != nil {
		return
	}
	if list, err = listParam(c); err != nil {
		return
	}
	mediaID, err = httpx.ParamUUID(c, "mediaId")
	return
}

func (h *Handlers) addToList(c fiber.Ctx) error {
	pid, list, mid, err := h.listTarget(c)
	if err != nil {
		return err
	}
	if err := h.svc.AddToList(c.Context(), pid, list, mid); err != nil {
		return fail(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) removeFromList(c fiber.Ctx) error {
	pid, list, mid, err := h.listTarget(c)
	if err != nil {
		return err
	}
	if err := h.svc.RemoveFromList(c.Context(), pid, list, mid); err != nil {
		return fail(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) rate(c fiber.Ctx) error {
	pid, err := h.profileParam(c)
	if err != nil {
		return err
	}
	mid, err := httpx.ParamUUID(c, "mediaId")
	if err != nil {
		return err
	}
	var in struct {
		Rating *float64 `json:"rating"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if in.Rating == nil || *in.Rating != float64(int(*in.Rating)) || *in.Rating < 1 || *in.Rating > 10 {
		return httpx.Validation(map[string]string{"rating": "must be an integer from 1 to 10"})
	}
	if err := h.svc.Rate(c.Context(), pid, mid, int(*in.Rating)); err != nil {
		return fail(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) unrate(c fiber.Ctx) error {
	pid, err := h.profileParam(c)
	if err != nil {
		return err
	}
	mid, err := httpx.ParamUUID(c, "mediaId")
	if err != nil {
		return err
	}
	if err := h.svc.Unrate(c.Context(), pid, mid); err != nil {
		return fail(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) mediaProgress(c fiber.Ctx) error {
	mid, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	pid := strings.Clone(c.Query("profile_id"))
	if !isUUID(pid) {
		return httpx.Validation(map[string]string{"profile_id": "required (UUID)"})
	}
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	if err := h.canUse(c, pid); err != nil {
		return err
	}
	res, err := h.svc.MediaProgress(c.Context(), pid, mid, lang)
	if err != nil {
		return fail(err)
	}
	return c.JSON(res)
}

func (h *Handlers) setWatched(c fiber.Ctx) error {
	mid, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	var in WatchedInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if !isUUID(in.ProfileID) {
		return httpx.Validation(map[string]string{"profile_id": "required (UUID)"})
	}
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	if err := h.canUse(c, in.ProfileID); err != nil {
		return err
	}
	res, err := h.svc.SetWatched(c.Context(), mid, in, lang)
	if err != nil {
		return fail(err)
	}
	return c.JSON(res)
}

// ---- «Новые серии» (newepisodes.go) ----

func (h *Handlers) newEpisodes(c fiber.Ctx) error {
	id, err := h.profileParam(c)
	if err != nil {
		return err
	}
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	out, err := h.svc.NewEpisodes(c.Context(), id, lang)
	if err != nil {
		return fail(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(out)
}

func (h *Handlers) newEpisodesSeen(c fiber.Ctx) error {
	id, err := h.profileParam(c)
	if err != nil {
		return err
	}
	var in struct {
		EpisodeIDs []string `json:"episode_ids"`
		All        bool     `json:"all"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if !in.All && (len(in.EpisodeIDs) == 0 || len(in.EpisodeIDs) > 200) {
		return httpx.Validation(map[string]string{"episode_ids": "1 to 200 episode ids, or all: true"})
	}
	for _, e := range in.EpisodeIDs {
		if !isUUID(e) {
			return httpx.Validation(map[string]string{"episode_ids": "must be UUIDs"})
		}
	}
	if err := h.svc.MarkNewEpisodesSeen(c.Context(), id, in.EpisodeIDs, in.All); err != nil {
		return err
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) mutedSeries(c fiber.Ctx) error {
	id, err := h.profileParam(c)
	if err != nil {
		return err
	}
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	items, err := h.svc.MutedSeriesList(c.Context(), id, lang)
	if err != nil {
		return fail(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(fiber.Map{"items": items})
}

func (h *Handlers) muteTarget(c fiber.Ctx) (string, string, error) {
	pid, err := h.profileParam(c)
	if err != nil {
		return "", "", err
	}
	mid, err := httpx.ParamUUID(c, "mediaId")
	return pid, mid, err
}

func (h *Handlers) muteSeries(c fiber.Ctx) error {
	pid, mid, err := h.muteTarget(c)
	if err != nil {
		return err
	}
	if err := h.svc.MuteSeries(c.Context(), pid, mid); err != nil {
		return fail(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

func (h *Handlers) unmuteSeries(c fiber.Ctx) error {
	pid, mid, err := h.muteTarget(c)
	if err != nil {
		return err
	}
	if err := h.svc.UnmuteSeries(c.Context(), pid, mid); err != nil {
		return fail(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}
