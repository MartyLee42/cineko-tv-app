package foryou

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/appsettings"
	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/catalog"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
)

// Routes mounts the profile-scoped endpoints. Every call checks that the
// caller may use the profile (TVs: the profiles selectable on them); diary
// and taste are owner-only.
func (s *Service) Routes(r fiber.Router) {
	caller := profiles.RequireProfileCaller()
	r.Get("/foryou/rows", caller, s.hRows)
	r.Post("/foryou/feedback", caller, s.hFeedback)
	r.Get("/foryou/surprise/options", caller, s.hSurpriseOptions)
	r.Post("/foryou/surprise", caller, s.hSurprise)
	r.Get("/foryou/explore", caller, s.hExplore)
	r.Get("/foryou/browse", caller, s.hBrowse)
	r.Get("/foryou/collections", caller, s.hCollections)
	r.Get("/foryou/collections/:id", caller, s.hCollection)
	r.Post("/foryou/ask", caller, s.hAsk)
	r.Get("/foryou/ai-settings", caller, s.hAISettings)
	r.Get("/foryou/asks", caller, s.hAsks)
	r.Get("/foryou/regenerate", caller, s.hRegenStatus)
	r.Post("/foryou/regenerate", caller, s.hRegenerate)
	r.Get("/profiles/:id/notes", caller, s.hNotes)
	r.Put("/profiles/:id/notes/:mediaId", caller, s.hPutNote)
	r.Get("/profiles/:id/diary", auth.RequireUser(), s.hDiary)
	r.Get("/profiles/:id/taste", auth.RequireUser(), s.hTaste)
	// «Давайте определим ваш вкус» (quiz.go).
	r.Get("/profiles/:id/taste-quiz", caller, s.hQuiz)
	r.Get("/profiles/:id/taste-quiz/titles", caller, s.hQuizTitles)
	r.Post("/profiles/:id/taste-quiz/answers", caller, s.hQuizAnswers)
	r.Post("/profiles/:id/taste-quiz/finish", caller, s.hQuizFinish)
	r.Post("/profiles/:id/taste-quiz/dismiss", caller, s.hQuizDismiss)
	r.Post("/profiles/:id/taste-quiz/generate", caller, s.hQuizGenerate)
}

// AdminRoutes mounts /admin/foryou/* on the admin group.
func (s *Service) AdminRoutes(admin fiber.Router) {
	admin.Post("/foryou/rerun", s.hRerun)
	admin.Get("/foryou/runs", s.hRuns)
	admin.Put("/foryou/ai", s.hPutAI)
}

// ---- params ----

func langOf(c fiber.Ctx) (string, error) {
	switch c.Query("lang") {
	case "", "en":
		return "en", nil
	case "ru":
		return "ru", nil
	}
	return "", httpx.Validation(map[string]string{"lang": "must be one of en, ru"})
}

func isUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil && len(s) == 36
}

// usable validates a profile id and the caller's access (404 otherwise).
func (s *Service) usable(c fiber.Ctx, pid string) (string, error) {
	if pid == "" {
		return "", httpx.Validation(map[string]string{"profile_id": "is required"})
	}
	if !isUUID(pid) {
		return "", httpx.Validation(map[string]string{"profile_id": "must be a UUID"})
	}
	pid = strings.Clone(pid)
	ok, err := s.profiles.CanUse(c.Context(), auth.PrincipalFrom(c), pid)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", httpx.NotFound()
	}
	return pid, nil
}

func (s *Service) queryProfile(c fiber.Ctx) (string, string, error) {
	lang, err := langOf(c)
	if err != nil {
		return "", "", err
	}
	pid, err := s.usable(c, c.Query("profile_id"))
	return pid, lang, err
}

// owned: diary/taste are only for the profile's own account.
func (s *Service) owned(c fiber.Ctx) (string, error) {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return "", err
	}
	p := auth.PrincipalFrom(c)
	if _, err := s.profiles.GetOwned(c.Context(), p.UserID, id); err != nil {
		if errors.Is(err, profiles.ErrNotFound) {
			return "", httpx.NotFound()
		}
		return "", err
	}
	return id, nil
}

func fail(err error) error {
	var bad errBadTile
	switch {
	case errors.Is(err, errNotFound), errors.Is(err, catalog.ErrNotFound):
		return httpx.NotFound()
	case errors.As(err, &bad):
		return httpx.Validation(map[string]string{"tile": "unknown tile"})
	case errors.Is(err, catalog.ErrUpstream):
		return httpx.NewError(fiber.StatusBadGateway, "catalog_upstream_error", "TMDB is unreachable right now. Try again later.")
	}
	return err
}

// ---- handlers ----

func (s *Service) hRows(c fiber.Ctx) error {
	pid, lang, err := s.queryProfile(c)
	if err != nil {
		return err
	}
	res, err := s.Rows(c.Context(), pid, lang)
	if err != nil {
		return fail(err)
	}
	return c.JSON(res)
}

var feedbackActions = map[string]bool{"impression": true, "open": true, "dismiss": true, "undismiss": true, "play": true, "complete": true}

type feedbackEvent struct {
	MediaID string `json:"media_id"`
	Action  string `json:"action"`
	RowID   string `json:"row_id"`
}

func (s *Service) hFeedback(c fiber.Ctx) error {
	var in struct {
		ProfileID string `json:"profile_id"`
		feedbackEvent
		Events []feedbackEvent `json:"events"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	pid, err := s.usable(c, in.ProfileID)
	if err != nil {
		return err
	}
	events := in.Events
	if in.MediaID != "" || in.Action != "" {
		events = append(events, in.feedbackEvent)
	}
	switch {
	case len(events) == 0:
		return httpx.Validation(map[string]string{"events": "send media_id + action or events"})
	case len(events) > 100:
		return httpx.Validation(map[string]string{"events": "at most 100 events"})
	}
	for _, e := range events {
		if !isUUID(e.MediaID) {
			return httpx.Validation(map[string]string{"media_id": "must be a UUID"})
		}
		if !feedbackActions[e.Action] {
			return httpx.Validation(map[string]string{"action": "must be one of impression, open, dismiss, undismiss, play, complete"})
		}
		if len(e.RowID) > 80 {
			return httpx.Validation(map[string]string{"row_id": "at most 80 characters"})
		}
	}
	if ok, wait := s.feedbackLimit.Allow(pid); !ok {
		return httpx.TooManyRequests(wait)
	}
	n, err := s.Feedback(c.Context(), pid, events)
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{"accepted": n})
}

// Feedback records events; dismiss/undismiss update foryou_dismissals
// (rows filter dismissed titles at read time and rebuild in the background).
func (s *Service) Feedback(ctx context.Context, profileID string, events []feedbackEvent) (int, error) {
	ids, actions, rows := make([]string, len(events)), make([]string, len(events)), make([]string, len(events))
	for i, e := range events {
		ids[i], actions[i], rows[i] = e.MediaID, e.Action, e.RowID
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO foryou_feedback (profile_id, media_id, action, row_id)
		SELECT $1, t.m::uuid, t.a, t.r FROM unnest($2::text[], $3::text[], $4::text[]) AS t(m, a, r)
		WHERE EXISTS (SELECT 1 FROM media WHERE id = t.m::uuid)`, profileID, ids, actions, rows)
	if err != nil {
		return 0, err
	}
	changed := false
	for _, e := range events {
		switch e.Action {
		case "dismiss":
			if _, err := s.pool.Exec(ctx, `INSERT INTO foryou_dismissals (profile_id, media_id)
				SELECT $1, id FROM media WHERE id = $2 ON CONFLICT DO NOTHING`, profileID, e.MediaID); err != nil {
				return 0, err
			}
			changed = true
		case "undismiss":
			if _, err := s.pool.Exec(ctx, `DELETE FROM foryou_dismissals WHERE profile_id = $1 AND media_id = $2`, profileID, e.MediaID); err != nil {
				return 0, err
			}
			changed = true
		}
	}
	if changed {
		// Keep the cache honest: the next read notices the newer signal and
		// rebuilds in the background.
		s.rebuildAsync(profileID, s.profileLang(ctx, profileID))
	}
	return int(tag.RowsAffected()), nil
}

func (s *Service) hSurpriseOptions(c fiber.Ctx) error {
	lang, err := langOf(c)
	if err != nil {
		return err
	}
	type opt struct {
		Key      string `json:"key"`
		Title    string `json:"title"`
		Emoji    string `json:"emoji"`
		GenreIDs []int  `json:"genre_ids"`
	}
	moods := make([]opt, 0, len(Moods))
	for _, m := range Moods {
		moods = append(moods, opt{m.Key, tr(lang, m.RU, m.EN), m.Emoji, m.Genres})
	}
	var decades []int
	for d := 1950; d <= s.now().Year()/10*10; d += 10 {
		decades = append(decades, d)
	}
	return c.JSON(fiber.Map{"moods": moods, "decades": decades})
}

func (s *Service) hSurprise(c fiber.Ctx) error {
	lang, err := langOf(c)
	if err != nil {
		return err
	}
	var req SurpriseRequest
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	f := map[string]string{}
	if req.Mood != "" && moodByKey(req.Mood) == nil {
		f["mood"] = "unknown mood"
	}
	switch req.Kind {
	case "", "movie", "series", "any":
	default:
		f["kind"] = "must be movie, series or any"
	}
	if len(req.Genres) > 10 {
		f["genres"] = "at most 10"
	}
	for _, g := range req.Genres {
		if g <= 0 {
			f["genres"] = "must be TMDB genre ids"
		}
	}
	inRange := func(name string, v *int, lo, hi int) {
		if v != nil && (*v < lo || *v > hi) {
			f[name] = "out of range"
		}
	}
	inRange("runtime_min", req.RuntimeMin, 0, 1000)
	inRange("runtime_max", req.RuntimeMax, 0, 1000)
	if req.RuntimeMin != nil && req.RuntimeMax != nil && *req.RuntimeMin > *req.RuntimeMax {
		f["runtime_max"] = "must not be below runtime_min"
	}
	if req.Decade != nil && (*req.Decade < 1900 || *req.Decade > 2090 || *req.Decade%10 != 0) {
		f["decade"] = "must be a decade like 1990"
	}
	if req.MinRating != nil && (*req.MinRating < 0 || *req.MinRating > 10) {
		f["min_rating"] = "must be 0–10"
	}
	if len(req.ExcludeIDs) > 200 {
		f["exclude_ids"] = "at most 200"
	}
	for _, id := range req.ExcludeIDs {
		if !isUUID(id) {
			f["exclude_ids"] = "must be UUIDs"
		}
	}
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	pid, err := s.usable(c, req.ProfileID)
	if err != nil {
		return err
	}
	req.ProfileID = pid
	res, err := s.Surprise(c.Context(), req, lang)
	if err != nil {
		return fail(err)
	}
	return c.JSON(res)
}

func (s *Service) hExplore(c fiber.Ctx) error {
	pid, lang, err := s.queryProfile(c)
	if err != nil {
		return err
	}
	sec, err := s.Explore(c.Context(), pid, lang)
	if err != nil {
		return fail(err)
	}
	return c.JSON(fiber.Map{"sections": sec})
}

func (s *Service) hBrowse(c fiber.Ctx) error {
	pid, lang, err := s.queryProfile(c)
	if err != nil {
		return err
	}
	tile := strings.Clone(c.Query("tile"))
	kind := strings.Clone(c.Query("kind"))
	if kind != "" && kind != "movie" && kind != "series" {
		return httpx.Validation(map[string]string{"kind": "must be movie or series"})
	}
	page := fiber.Query[int](c, "page", 1)
	if page < 1 || page > 500 {
		return httpx.Validation(map[string]string{"page": "must be 1–500"})
	}
	if !strings.HasPrefix(tile, "collection:") && !s.cat.Available() {
		return httpx.NewError(fiber.StatusServiceUnavailable, "catalog_unavailable", "The catalog is not configured.")
	}
	res, err := s.Browse(c.Context(), pid, tile, kind, lang, page)
	if err != nil {
		return fail(err)
	}
	return c.JSON(res)
}

func (s *Service) hCollections(c fiber.Ctx) error {
	pid, lang, err := s.queryProfile(c)
	if err != nil {
		return err
	}
	cols, err := s.Collections(c.Context(), pid, lang)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"items": cols, "ai_enabled": s.ai != nil})
}

func (s *Service) hCollection(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	pid, lang, err := s.queryProfile(c)
	if err != nil {
		return err
	}
	col, err := s.CollectionByID(c.Context(), id, pid, lang)
	if err != nil {
		return fail(err)
	}
	return c.JSON(col)
}

func (s *Service) hDiary(c fiber.Ctx) error {
	pid, err := s.owned(c)
	if err != nil {
		return err
	}
	lang, err := langOf(c)
	if err != nil {
		return err
	}
	month := s.now().In(msk)
	if m := c.Query("month"); m != "" {
		t, err := time.Parse("2006-01", m)
		if err != nil || t.Year() < 1900 || t.Year() > 2100 {
			return httpx.Validation(map[string]string{"month": "must be YYYY-MM"})
		}
		month = t
	}
	d, err := s.Diary(c.Context(), pid, month, lang)
	if err != nil {
		return err
	}
	return c.JSON(d)
}

func (s *Service) hTaste(c fiber.Ctx) error {
	pid, err := s.owned(c)
	if err != nil {
		return err
	}
	lang, err := langOf(c)
	if err != nil {
		return err
	}
	t, err := s.TasteDNA(c.Context(), pid, lang)
	if err != nil {
		return err
	}
	return c.JSON(t)
}

// ---- admin ----

func (s *Service) hRerun(c fiber.Ctx) error {
	var in struct {
		Scope string `json:"scope"`
		ID    string `json:"id"`
		AI    *bool  `json:"ai"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	switch in.Scope {
	case "all":
		in.ID = ""
	case "user", "profile":
		if !isUUID(in.ID) {
			return httpx.Validation(map[string]string{"id": "must be a user or profile UUID"})
		}
	default:
		return httpx.Validation(map[string]string{"scope": "must be all, user or profile"})
	}
	ai := in.AI == nil || *in.AI
	p := auth.PrincipalFrom(c)
	id, err := s.StartRun(c.Context(), in.Scope, in.ID, ai, "admin", p.UserID)
	var running *ErrRunning
	switch {
	case errors.As(err, &running):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"error":  fiber.Map{"code": "run_in_progress", "message": "A recommendations run is already in progress.", "request_id": httpx.RequestID(c)},
			"run_id": running.RunID,
		})
	case errors.Is(err, errNotFound):
		return httpx.NotFound()
	case err != nil:
		return err
	}
	if s.audit != nil {
		s.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "foryou.rerun", TargetType: "foryou_run", TargetID: id,
			IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: map[string]any{"scope": in.Scope, "id": in.ID, "ai": ai}})
	}
	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{"run_id": id})
}

func (s *Service) hRuns(c fiber.Ctx) error {
	runs, err := s.listRuns(c.Context())
	if err != nil {
		return err
	}
	used, _, err := s.aiUsageToday(c.Context())
	if err != nil {
		return err
	}
	var next *time.Time
	if t := s.nextDaily(s.now()); t != nil {
		next = t
	}
	return c.JSON(fiber.Map{
		"items": runs,
		"ai": fiber.Map{"enabled": s.ai != nil, "model": s.cfg.DeepSeekModel, "tokens_today": used,
			"daily_budget": s.cfg.AIDailyTokens, "run_budget": s.cfg.AIRunTokens, "balance": s.aiBalance(c.Context()),
			"temperature": s.aiTemperature(c.Context()), "facts_ai": s.factsAI(c.Context())},
		"daily_at":    s.cfg.DailyAt(),
		"next_run_at": next,
	})
}

// ---- AI temperature ----

// aiSettingsView is GET /foryou/ai-settings (ForYouAISettings): what clients
// and Cineko Music need to apply a viewer's creativity.
func (s *Service) aiSettingsView(ctx context.Context) fiber.Map {
	return fiber.Map{"enabled": s.ai != nil, "temperature": s.aiTemperature(ctx), "facts_ai": s.factsAI(ctx), "creativity": appsettings.Creativity,
		"min": appsettings.TemperatureMin, "max": appsettings.TemperatureMax}
}

func (s *Service) hAISettings(c fiber.Ctx) error {
	return c.JSON(s.aiSettingsView(c.Context()))
}

// hPutAI is PUT /admin/foryou/ai {temperature?: {collections, ask, music, facts}, facts_ai?}.
func (s *Service) hPutAI(c fiber.Ctx) error {
	if s.settings == nil {
		return httpx.NewError(fiber.StatusServiceUnavailable, "unavailable", "Settings are not available.")
	}
	var in struct {
		Temperature *struct {
			Collections *float64 `json:"collections"`
			Ask         *float64 `json:"ask"`
			Music       *float64 `json:"music"`
			Facts       *float64 `json:"facts"`
		} `json:"temperature"`
		FactsAI *bool `json:"facts_ai"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if in.Temperature == nil && in.FactsAI == nil {
		return httpx.Validation(map[string]string{"temperature": "temperature or facts_ai is required"})
	}
	if in.Temperature == nil {
		in.Temperature = &struct {
			Collections *float64 `json:"collections"`
			Ask         *float64 `json:"ask"`
			Music       *float64 `json:"music"`
			Facts       *float64 `json:"facts"`
		}{}
	}
	t := s.aiTemperature(c.Context())
	f := map[string]string{}
	set := func(name string, v *float64, dst *float64) {
		if v == nil {
			return
		}
		if !appsettings.ValidTemperature(*v) {
			f["temperature."+name] = fmt.Sprintf("must be between %g and %g", appsettings.TemperatureMin, appsettings.TemperatureMax)
			return
		}
		*dst = appsettings.ClampTemperature(*v)
	}
	set("collections", in.Temperature.Collections, &t.Collections)
	set("ask", in.Temperature.Ask, &t.Ask)
	set("music", in.Temperature.Music, &t.Music)
	set("facts", in.Temperature.Facts, &t.Facts)
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	p := auth.PrincipalFrom(c)
	if err := s.settings.SetAITemperature(c.Context(), t, p.UserID); err != nil {
		return err
	}
	if in.FactsAI != nil {
		if err := s.settings.SetFactsAIEnabled(c.Context(), *in.FactsAI, p.UserID); err != nil {
			return err
		}
	}
	if s.audit != nil {
		s.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "foryou.ai_updated", TargetType: "app_settings", TargetID: "ai_temperature",
			IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: map[string]any{"collections": t.Collections, "ask": t.Ask, "music": t.Music, "facts": t.Facts,
				"facts_ai": s.factsAI(c.Context())}})
	}
	return c.JSON(s.aiSettingsView(c.Context()))
}

// ---- ask AI ----

func (s *Service) hAsk(c fiber.Ctx) error {
	var req AskRequest
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	if req.Lang == "" {
		req.Lang = c.Query("lang")
	}
	f := map[string]string{}
	switch req.Lang {
	case "":
		req.Lang = "en"
	case "en", "ru":
	default:
		f["lang"] = "must be one of en, ru"
	}
	req.Prompt = cleanText(req.Prompt)
	if n := utf8.RuneCountInString(req.Prompt); n < askMinPrompt || n > askMaxPrompt {
		f["prompt"] = fmt.Sprintf("must be %d–%d characters", askMinPrompt, askMaxPrompt)
	}
	switch req.Kind {
	case "":
		req.Kind = "any"
	case "movie", "series", "any":
	default:
		f["kind"] = "must be movie, series or any"
	}
	if _, ok := appsettings.WithCreativity(0, req.Creativity); !ok {
		f["creativity"] = "must be one of precise, normal, bold"
	}
	p := auth.PrincipalFrom(c)
	if req.DeviceID != "" {
		switch {
		case !isUUID(req.DeviceID):
			f["device_id"] = "must be a UUID"
		case p.Kind == auth.KindDevice:
			f["device_id"] = "TVs cannot send answers to another device"
		}
	}
	if len(f) > 0 {
		return httpx.Validation(f)
	}
	pid, err := s.usable(c, req.ProfileID)
	if err != nil {
		return err
	}
	req.ProfileID = pid
	if req.DeviceID != "" {
		ok, err := s.ownsDevice(c.Context(), p.UserID, req.DeviceID)
		if err != nil {
			return err
		}
		if !ok {
			return httpx.NotFound()
		}
	}
	res, err := s.Ask(c.Context(), p.UserID, req)
	if err != nil {
		return s.askFail(err)
	}
	if req.DeviceID != "" {
		sent := s.sendToDevice(req.DeviceID, res)
		res.SentToDevice = &sent
	}
	return c.JSON(res)
}

func (s *Service) askFail(err error) error {
	var ae *aiError
	switch {
	case errors.Is(err, errAIDisabled):
		return httpx.NewError(fiber.StatusServiceUnavailable, "ai_disabled", "AI recommendations are not configured.")
	case errors.Is(err, errAskLimit):
		e := httpx.NewError(fiber.StatusTooManyRequests, "ask_limit",
			fmt.Sprintf("You have used all %d AI questions for today. Try again tomorrow.", s.cfg.AskDailyPerUser))
		e.RetryAfter = s.untilMidnightMSK()
		return e
	case errors.Is(err, errBudget):
		e := httpx.NewError(fiber.StatusTooManyRequests, "ai_budget", "The AI has used up today's budget. Try again tomorrow.")
		e.RetryAfter = s.untilMidnightMSK()
		return e
	case errors.Is(err, errInvalidAI), errors.As(err, &ae), errors.Is(err, context.DeadlineExceeded):
		return httpx.NewError(fiber.StatusBadGateway, "ai_failed", "The AI could not answer right now. Try again.")
	}
	return fail(err)
}

func (s *Service) untilMidnightMSK() time.Duration {
	now := s.now().In(msk)
	y, m, d := now.Date()
	return time.Date(y, m, d+1, 0, 0, 0, 0, msk).Sub(now)
}

func (s *Service) hAsks(c fiber.Ctx) error {
	pid, lang, err := s.queryProfile(c)
	if err != nil {
		return err
	}
	items, err := s.Asks(c.Context(), pid, lang)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"items": items, "ai_enabled": s.ai != nil, "daily_limit": s.cfg.AskDailyPerUser})
}

// ---- manual AI regeneration (regen.go) ----

func (s *Service) hRegenStatus(c fiber.Ctx) error {
	pid, err := s.usable(c, c.Query("profile_id"))
	if err != nil {
		return err
	}
	st, err := s.RegenStatus(c.Context(), pid, auth.PrincipalFrom(c).IsAdmin())
	if err != nil {
		return err
	}
	return c.JSON(st)
}

func (s *Service) hRegenerate(c fiber.Ctx) error {
	var req struct {
		ProfileID string `json:"profile_id"`
	}
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	pid, err := s.usable(c, req.ProfileID)
	if err != nil {
		return err
	}
	p := auth.PrincipalFrom(c)
	admin := p.IsAdmin()
	if _, err := s.Regenerate(c.Context(), pid, p.UserID, admin); err != nil {
		if errors.Is(err, errRegenLimit) {
			e := httpx.NewError(fiber.StatusTooManyRequests, "regen_limit", "AI collections can be refreshed once a day. Try again tomorrow.")
			e.Fields = map[string]string{"next_available_at": s.nextMidnightMSK().Format(time.RFC3339)}
			e.RetryAfter = s.untilMidnightMSK()
			return e
		}
		return s.askFail(err)
	}
	st, err := s.RegenStatus(c.Context(), pid, admin)
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusAccepted).JSON(st)
}
