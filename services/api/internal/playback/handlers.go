package playback

import (
	"errors"
	"log/slog"
	"strings"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

type Handlers struct{ svc *Service }

func NewHandlers(s *Service) *Handlers { return &Handlers{svc: s} }

// Routes mounts /api/v1/playback/* on api and the public, token-gated
// /api/v1/stream/:token on app (outside the authenticated group, so a plain
// <video src> works on TVs).
func (h *Handlers) Routes(app *fiber.App, api fiber.Router) {
	g := api.Group("/playback", requirePlayer())
	g.Post("/sources", h.create)
	g.Get("/sources/:id", h.get)
	g.Patch("/sources/:id", h.patch)
	g.Delete("/sources/:id", h.cancel)
	g.Get("/sources/:id/files", h.files)
	// Instant play (warm.go): title pages warm the release Play would start.
	g.Post("/warm", h.warm)
	g.Delete("/warm", h.cancelWarm)
	// HEAD is registered explicitly: Fiber's auto-registered HEAD routes are
	// appended after the /api/v1 catch-all and would never match.
	// The /:filename variant is the same stream; the trailing name is ignored
	// server-side and lets external players (MSX, VLC) detect the container.
	for _, p := range []string{"/api/v1/stream/:token", "/api/v1/stream/:token/:filename"} {
		app.Add([]string{fiber.MethodGet, fiber.MethodHead}, p, h.stream)
	}
	// Live IPTV channels (live.go).
	app.Add([]string{fiber.MethodGet, fiber.MethodHead}, "/api/v1/live/:token/:name", h.liveStream)
	// YouTube videos (video.go): generated HLS, byte ranges, progressive MP4, captions.
	app.Add([]string{fiber.MethodGet, fiber.MethodHead}, "/api/v1/vstream/:token/:name", h.videoStream)
	// Compat stream subtitles (compat.go); compat.mp4 itself is a :filename.
	app.Add([]string{fiber.MethodGet, fiber.MethodHead}, "/api/v1/stream/:token/subs/:file", h.streamSubs)
	// HLS compat sessions (compat_hls.go); compat.m3u8 itself is a :filename.
	app.Add([]string{fiber.MethodGet, fiber.MethodHead}, "/api/v1/stream/:token/compat/:session/:file", h.streamCompatHLSFile)
}

// requirePlayer allows browser sessions, paired TVs and API tokens (read for
// safe methods, write otherwise).
func requirePlayer() fiber.Handler {
	return func(c fiber.Ctx) error {
		p := auth.PrincipalFrom(c)
		if p == nil {
			return httpx.Unauthorized()
		}
		if p.Kind == auth.KindToken {
			need := auth.ScopeWrite
			if m := c.Method(); m == fiber.MethodGet || m == fiber.MethodHead {
				need = auth.ScopeRead
			}
			if !p.HasScope(need) {
				return httpx.NewError(fiber.StatusForbidden, "insufficient_scope", "Token lacks the "+need+" scope.")
			}
		}
		return c.Next()
	}
}

func callerFrom(c fiber.Ctx) caller {
	p := auth.PrincipalFrom(c)
	who := caller{UserID: p.UserID}
	if p.Kind == auth.KindDevice {
		who.DeviceID = p.DeviceID
	}
	return who
}

func (h *Handlers) logger(c fiber.Ctx) *slog.Logger {
	p := auth.PrincipalFrom(c)
	l := h.svc.log.With("request_id", httpx.RequestID(c))
	if p != nil {
		l = l.With("user_id", p.UserID)
		if p.DeviceID != "" {
			l = l.With("device_id", p.DeviceID)
		}
	}
	return l
}

// toHTTP maps service errors to the API envelope.
func toHTTP(err error) error {
	var ae *apiError
	if errors.As(err, &ae) {
		e := httpx.NewError(ae.Status, ae.Code, ae.Msg)
		e.Fields = ae.Fields
		return e
	}
	return err
}

func validUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil && len(s) == 36
}

func (h *Handlers) create(c fiber.Ctx) error {
	var in CreateInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if in.Kind == "iptv" {
		return h.createLive(c, in)
	}
	if in.Kind == "video" {
		return h.createVideo(c, in) // YouTube (video.go)
	}
	if in.Kind != "" && in.Kind != "release" {
		return httpx.Validation(map[string]string{"kind": "Must be release, iptv or video."})
	}
	in.MediaID = strings.TrimSpace(in.MediaID)
	fields := map[string]string{}
	if !validUUID(in.MediaID) {
		fields["media_id"] = "Must be a UUID."
	}
	if in.ReleaseID == "" || len(in.ReleaseID) > 128 {
		fields["release_id"] = "Required, at most 128 characters."
	}
	if in.EpisodeID != nil && !validUUID(*in.EpisodeID) {
		fields["episode_id"] = "Must be a UUID."
	}
	if in.ProfileID != nil && !validUUID(*in.ProfileID) {
		fields["profile_id"] = "Must be a UUID."
	}
	if in.Quality != nil && (*in.Quality < 0 || *in.Quality > 4320) {
		fields["quality"] = "A resolution height such as 720, or 0 for best."
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	in.ReleaseID = strings.Clone(in.ReleaseID)
	out, err := h.svc.Create(c.Context(), callerFrom(c), in, h.logger(c))
	if err != nil {
		return toHTTP(err)
	}
	return c.Status(fiber.StatusCreated).JSON(out)
}

func (h *Handlers) get(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	out, err := h.svc.Get(c.Context(), callerFrom(c), id)
	if err != nil {
		return toHTTP(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(out)
}

func (h *Handlers) patch(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	var in struct {
		FileIndex *int `json:"file_index"`
		Quality   *int `json:"quality"`
	}
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if in.Quality != nil && in.FileIndex == nil {
		if *in.Quality < 0 || *in.Quality > 4320 {
			return httpx.Validation(map[string]string{"quality": "A resolution height such as 720, or 0 for best."})
		}
		out, err := h.svc.SetQuality(c.Context(), callerFrom(c), id, *in.Quality)
		if err != nil {
			return toHTTP(err)
		}
		return c.JSON(out)
	}
	if in.FileIndex == nil || *in.FileIndex < 0 {
		return httpx.Validation(map[string]string{"file_index": "Required, a non-negative integer."})
	}
	out, err := h.svc.SelectFile(c.Context(), callerFrom(c), id, *in.FileIndex)
	if err != nil {
		return toHTTP(err)
	}
	h.logger(c).Info("playback file selected", "source_id", id, "file_index", *in.FileIndex)
	return c.JSON(out)
}

func (h *Handlers) files(c fiber.Ctx) error {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return err
	}
	out, err := h.svc.Files(c.Context(), callerFrom(c), id)
	if err != nil {
		return toHTTP(err)
	}
	return c.JSON(httpx.List(out))
}

// createLive handles POST /playback/sources {kind: "iptv"} (live.go).
func (h *Handlers) createLive(c fiber.Ctx, in CreateInput) error {
	fields := map[string]string{}
	if in.ChannelID == nil || !validUUID(*in.ChannelID) {
		fields["channel_id"] = "Required, a UUID."
	}
	if in.ProfileID != nil && !validUUID(*in.ProfileID) {
		fields["profile_id"] = "Must be a UUID."
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	out, err := h.svc.createLive(c.Context(), callerFrom(c), *in.ChannelID, in.ProfileID, h.logger(c))
	if err != nil {
		return toHTTP(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.Status(fiber.StatusCreated).JSON(out)
}

// cancel: the viewer gave up while the source was loading (cancel.go).
func (h *Handlers) cancel(c fiber.Ctx) error {
	id := c.Params("id")
	if !validUUID(id) {
		return httpx.NotFound()
	}
	if err := h.svc.Cancel(c.Context(), callerFrom(c), strings.Clone(id)); err != nil {
		return toHTTP(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// warm: instant play — prepare the release Play would start (warm.go).
func (h *Handlers) warm(c fiber.Ctx) error {
	var in WarmInput
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	in.MediaID = strings.TrimSpace(in.MediaID)
	fields := map[string]string{}
	if !validUUID(in.MediaID) {
		fields["media_id"] = "Must be a UUID."
	}
	if !validUUID(in.ProfileID) {
		fields["profile_id"] = "Required, a UUID."
	}
	if in.SourceID != nil {
		if !validUUID(*in.SourceID) {
			fields["source_id"] = "Must be a UUID."
		}
		id := strings.Clone(*in.SourceID)
		in.SourceID = &id
	} else if in.ReleaseID == "" || len(in.ReleaseID) > 128 {
		fields["release_id"] = "Required (or source_id), at most 128 characters."
	}
	if in.EpisodeID != nil && !validUUID(*in.EpisodeID) {
		fields["episode_id"] = "Must be a UUID."
	}
	if in.StartSeconds < 0 || in.StartSeconds > 1e6 {
		fields["start_seconds"] = "Between 0 and 1000000."
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	in.ReleaseID, in.ProfileID = strings.Clone(in.ReleaseID), strings.Clone(in.ProfileID)
	if in.EpisodeID != nil {
		ep := strings.Clone(*in.EpisodeID)
		in.EpisodeID = &ep
	}
	out, err := h.svc.Warm(c.Context(), callerFrom(c), in, h.logger(c))
	if err != nil {
		return toHTTP(err)
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.Status(fiber.StatusAccepted).JSON(out)
}

// cancelWarm: the viewer left the title page (DELETE /playback/warm?profile_id=).
func (h *Handlers) cancelWarm(c fiber.Ctx) error {
	profileID := c.Query("profile_id")
	if !validUUID(profileID) {
		return httpx.Validation(map[string]string{"profile_id": "Required, a UUID."})
	}
	h.svc.CancelWarm(callerFrom(c), strings.Clone(profileID))
	return c.SendStatus(fiber.StatusNoContent)
}
