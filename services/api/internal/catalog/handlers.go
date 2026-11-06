package catalog

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

type Handlers struct {
	svc      *Service
	images   *ImageProxy
	personal Personalizer
	ratings  RatingsSource
	awards   AwardsSource
}

func NewHandlers(svc *Service, images *ImageProxy) *Handlers {
	return &Handlers{svc: svc, images: images}
}

// Routes registers the catalog. Everything except images needs a principal
// that may read (session, TV credential or token with "read"); everything
// except config and images needs TMDB to be configured.
func (h *Handlers) Routes(r fiber.Router) {
	r.Get("/images/:size/:file", h.images.Handle)

	reader, avail := auth.RequireReader(), h.requireAvailable()
	r.Get("/catalog/config", reader, h.config)
	cat := r.Group("/catalog", reader, avail)
	cat.Get("/home", h.home)
	cat.Get("/lists/:list", h.list)
	cat.Get("/discover", h.discover)
	cat.Get("/search", h.search)
	cat.Get("/genres", h.genres)

	m := r.Group("/media", reader, avail)
	m.Get("/:id", h.detail)
	m.Get("/:id/similar", h.related("similar"))
	m.Get("/:id/recommendations", h.related("recommendations"))
	m.Get("/:id/seasons/:season", h.season)
	m.Get("/:id/providers", h.providers)

	r.Get("/people/:tmdb_id", reader, avail, h.person)
}

func (h *Handlers) requireAvailable() fiber.Handler {
	return func(c fiber.Ctx) error {
		if !h.svc.Available() {
			return httpx.NewError(fiber.StatusServiceUnavailable, "catalog_unavailable", "The catalog is not configured (TMDB credentials missing).")
		}
		return c.Next()
	}
}

// fail maps service errors: unknown ids → 404, TMDB failures → 502.
func (h *Handlers) fail(c fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, ErrNotFound):
		return httpx.NotFound()
	case errors.Is(err, ErrUpstream):
		h.svc.log.WarnContext(c.Context(), "tmdb request failed", "path", c.Path(), "err", err)
		return httpx.NewError(fiber.StatusBadGateway, "catalog_upstream_error", "TMDB is unreachable right now. Try again later.")
	}
	return err
}

func (h *Handlers) config(c fiber.Ctx) error { return c.JSON(h.svc.Config()) }

func (h *Handlers) home(c fiber.Ctx) error {
	v := newValidator(c)
	lang := v.lang()
	// Home has no hide_watched param; the profile's setting applies.
	vw, err := h.viewer(c, v, true)
	if err != nil {
		return err
	}
	if err := v.err(); err != nil {
		return err
	}
	rows, err := h.svc.Home(c.Context(), lang, false)
	if err != nil {
		return h.fail(c, err)
	}
	lists := make([]*[]MediaSummary, len(rows))
	for i := range rows {
		lists[i] = &rows[i].Items
	}
	h.annotateRatings(c.Context(), lists...)
	if err := h.personalize(c.Context(), vw, true, lists...); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"rows": rows})
}

func (h *Handlers) list(c fiber.Ctx) error {
	list := strings.Clone(c.Params("list"))
	kinds, ok := listKinds[list]
	if !ok {
		return httpx.NotFound()
	}
	v := newValidator(c)
	kind := v.enum("kind", true, "", "all", "movie", "series")
	page, lang := v.page(), v.lang()
	if kind != "" && !contains(kinds, kind) {
		v.fields["kind"] = "must be one of " + strings.Join(kinds, ", ") + " for this list"
	}
	vw, err := h.viewer(c, v, true)
	if err != nil {
		return err
	}
	if err := v.err(); err != nil {
		return err
	}
	res, err := h.svc.List(c.Context(), list, kind, lang, page, false)
	if err != nil {
		return h.fail(c, err)
	}
	return h.sendPage(c, vw, true, res)
}

var langCode = regexp.MustCompile(`^[a-z]{2}$`)

func (h *Handlers) discover(c fiber.Ctx) error {
	v := newValidator(c)
	p := DiscoverParams{
		Kind:       v.enum("kind", true, "", "movie", "series"),
		YearFrom:   v.intRange("year_from", 1870, 2100),
		YearTo:     v.intRange("year_to", 1870, 2100),
		RuntimeMin: v.intRange("runtime_min", 0, 1000),
		RuntimeMax: v.intRange("runtime_max", 0, 1000),
		Sort:       v.enum("sort", false, "popularity", "popularity", "rating", "release_date", "title"),
		Page:       v.page(),
		Lang:       v.lang(),
	}
	if g := strings.TrimSpace(c.Query("genres")); g != "" {
		for _, part := range strings.Split(g, ",") {
			id, err := strconv.Atoi(strings.TrimSpace(part))
			if err != nil || id <= 0 || len(p.Genres) >= 10 {
				v.fields["genres"] = "must be up to 10 comma-separated genre ids"
				break
			}
			p.Genres = append(p.Genres, id)
		}
	}
	if ol := strings.Clone(strings.ToLower(strings.TrimSpace(c.Query("original_language")))); ol != "" {
		if !langCode.MatchString(ol) {
			v.fields["original_language"] = "must be an ISO 639-1 code"
		}
		p.OriginalLanguage = ol
	}
	if s := c.Query("rating_min"); s != "" {
		f, err := strconv.ParseFloat(s, 64)
		if err != nil || f < 0 || f > 10 {
			v.fields["rating_min"] = "must be a number from 0 to 10"
		} else {
			p.RatingMin = &f
		}
	}
	if p.YearFrom != nil && p.YearTo != nil && *p.YearFrom > *p.YearTo {
		v.fields["year_to"] = "must not be before year_from"
	}
	if p.RuntimeMin != nil && p.RuntimeMax != nil && *p.RuntimeMin > *p.RuntimeMax {
		v.fields["runtime_max"] = "must not be below runtime_min"
	}
	vw, err := h.viewer(c, v, true)
	if err != nil {
		return err
	}
	if err := v.err(); err != nil {
		return err
	}
	res, err := h.svc.Discover(c.Context(), p)
	if err != nil {
		return h.fail(c, err)
	}
	return h.sendPage(c, vw, true, res)
}

func (h *Handlers) search(c fiber.Ctx) error {
	v := newValidator(c)
	q := strings.Clone(strings.TrimSpace(c.Query("q")))
	if n := utf8.RuneCountInString(q); n < 1 || n > 100 {
		v.fields["q"] = "must be 1-100 characters"
	}
	kind := v.enum("kind", false, "all", "all", "movie", "series")
	page, lang := v.page(), v.lang()
	// Search applies hide_anime but never hides watched titles.
	vw, err := h.viewer(c, v, false)
	if err != nil {
		return err
	}
	if err := v.err(); err != nil {
		return err
	}
	res, err := h.svc.Search(c.Context(), q, kind, lang, page)
	if err != nil {
		return h.fail(c, err)
	}
	return h.sendPage(c, vw, true, res)
}

func (h *Handlers) genres(c fiber.Ctx) error {
	v := newValidator(c)
	kind := v.enum("kind", true, "", "movie", "series")
	lang := v.lang()
	if err := v.err(); err != nil {
		return err
	}
	items, err := h.svc.Genres(c.Context(), kind, lang)
	if err != nil {
		return h.fail(c, err)
	}
	return c.JSON(httpx.List(items))
}

func (h *Handlers) detail(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	v := newValidator(c)
	lang := v.lang()
	vw, err := h.viewer(c, v, false)
	if err != nil {
		return err
	}
	if err := v.err(); err != nil {
		return err
	}
	d, err := h.svc.Detail(c.Context(), id, lang)
	if err != nil {
		return h.fail(c, err)
	}
	h.detailRatings(c.Context(), d)
	h.detailAwards(c.Context(), d, lang)
	if vw != nil { // annotate only: a detail page is never filtered away
		one := []MediaSummary{d.MediaSummary}
		if err := h.personalize(c.Context(), vw, false, &one); err != nil {
			return err
		}
		d.Me = one[0].Me
	}
	return c.JSON(d)
}

func (h *Handlers) related(which string) fiber.Handler {
	return func(c fiber.Ctx) error {
		id, err := httpx.ParamUUID(c, "id")
		if err != nil {
			return err
		}
		v := newValidator(c)
		page, lang := v.page(), v.lang()
		// Similar / «Вам может понравиться» on a title page: watched titles
		// stay (marked ✓) whatever hide_watched says — like search.
		vw, err := h.viewer(c, v, false)
		if err != nil {
			return err
		}
		if err := v.err(); err != nil {
			return err
		}
		res, err := h.svc.Related(c.Context(), id, which, lang, page)
		if err != nil {
			return h.fail(c, err)
		}
		return h.sendPage(c, vw, true, res)
	}
}

// sendPage personalizes (when vw != nil) and writes a MediaPage.
func (h *Handlers) sendPage(c fiber.Ctx, vw *Viewer, filter bool, res *MediaPage) error {
	h.annotateRatings(c.Context(), &res.Items)
	if err := h.personalize(c.Context(), vw, filter, &res.Items); err != nil {
		return err
	}
	return c.JSON(res)
}

func (h *Handlers) season(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	n, err := strconv.Atoi(c.Params("season"))
	if err != nil || n < 0 || n > 1000 {
		return httpx.NotFound()
	}
	v := newValidator(c)
	lang := v.lang()
	if err := v.err(); err != nil {
		return err
	}
	s, err := h.svc.Season(c.Context(), id, n, lang)
	if err != nil {
		return h.fail(c, err)
	}
	return c.JSON(s)
}

var regionCode = regexp.MustCompile(`^[A-Z]{2}$`)

func (h *Handlers) providers(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	region := strings.Clone(strings.ToUpper(strings.TrimSpace(c.Query("region"))))
	if region == "" {
		region = h.svc.cfg.Region
	}
	if !regionCode.MatchString(region) {
		return httpx.Validation(map[string]string{"region": "must be an ISO 3166-1 alpha-2 code"})
	}
	p, err := h.svc.Providers(c.Context(), id, region)
	if err != nil {
		return h.fail(c, err)
	}
	return c.JSON(p)
}

// ---- query validation ----

type validator struct {
	c      fiber.Ctx
	fields map[string]string
}

func newValidator(c fiber.Ctx) *validator { return &validator{c: c, fields: map[string]string{}} }

func (v *validator) err() error {
	if len(v.fields) > 0 {
		return httpx.Validation(v.fields)
	}
	return nil
}

func (v *validator) enum(name string, required bool, def string, allowed ...string) string {
	s := v.c.Query(name)
	if s == "" {
		if required {
			v.fields[name] = "is required (" + strings.Join(allowed, ", ") + ")"
		}
		return def
	}
	for _, a := range allowed {
		if a == s {
			return a // our constant, not a view into Fiber's request buffer
		}
	}
	v.fields[name] = "must be one of " + strings.Join(allowed, ", ")
	return def
}

func (v *validator) lang() string { return v.enum("lang", false, "en", "en", "ru") }

func (v *validator) page() int {
	p := v.intRange("page", 1, maxPage)
	if p == nil {
		return 1
	}
	return *p
}

func (v *validator) intRange(name string, lo, hi int) *int {
	s := v.c.Query(name)
	if s == "" {
		return nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < lo || n > hi {
		v.fields[name] = "must be an integer from " + strconv.Itoa(lo) + " to " + strconv.Itoa(hi)
		return nil
	}
	return &n
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// person is GET /people/{tmdb_id}: bio plus films and series, annotated
// with the profile's state (never filtered: it's the person's full list).
func (h *Handlers) person(c fiber.Ctx) error {
	id, err := strconv.Atoi(c.Params("tmdb_id"))
	if err != nil || id <= 0 {
		return httpx.NotFound()
	}
	v := newValidator(c)
	lang := v.lang()
	vw, err := h.viewer(c, v, false)
	if err != nil {
		return err
	}
	if err := v.err(); err != nil {
		return err
	}
	p, err := h.svc.Person(c.Context(), id, lang)
	if err != nil {
		return h.fail(c, err)
	}
	items := make([]MediaSummary, len(p.Credits))
	for i, cr := range p.Credits {
		items[i] = cr.Media
	}
	h.annotateRatings(c.Context(), &items)
	if err := h.personalize(c.Context(), vw, false, &items); err != nil {
		return err
	}
	for i := range p.Credits {
		p.Credits[i].Media = items[i]
	}
	return c.JSON(p)
}
