package profiles

import (
	"context"
	"encoding/json"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

// Settings are per-profile app options (Phase 5). Every field is a pointer so
// a PUT can carry any subset; GET always returns them all (defaults filled).
type Settings struct {
	Theme               *string `json:"theme,omitempty"`
	HideAnime           *bool   `json:"hide_anime,omitempty"`
	HideWatched         *bool   `json:"hide_watched,omitempty"`
	AutoplayNextEpisode *bool   `json:"autoplay_next_episode,omitempty"`
	// AutoplayCountdown («Отсчёт перед следующим»): the next episode / video
	// waits a few seconds on a card (default true); false starts it at once.
	AutoplayCountdown *bool `json:"autoplay_countdown,omitempty"`
	// SkipSegments («Заставки и титры»): "button" (default) offers to skip
	// intros / recaps and the next episode at the credits, "auto" skips by
	// itself, "off" never (playback markers, internal/segments).
	SkipSegments        *string `json:"skip_segments,omitempty"`
	SpoilerFreeEpisodes *bool   `json:"spoiler_free_episodes,omitempty"`
	LoadingStyle        *string `json:"loading_style,omitempty"`
	OnboardingCompleted *bool   `json:"onboarding_completed,omitempty"`
	Design              *string `json:"design,omitempty"`
	// DesignSurprise («Сюрприз»): "off" (default), "day" or "week" — the
	// apps then show a design picked from DesignFavorites per local
	// calendar day / ISO week (computed client-side, packages/ui surprise.ts).
	// Design stays the chosen («home») design.
	DesignSurprise *string `json:"design_surprise,omitempty"`
	// DesignFavorites are the designs the surprise picks from (deduped;
	// empty = all designs).
	DesignFavorites *[]string `json:"design_favorites,omitempty"`
	PosterRating    *string   `json:"poster_rating,omitempty"`
	// Sources picks the providers this profile searches (default all).
	Sources *SourcesSetting `json:"sources,omitempty"`
	// TasteNote is the viewer's own description of their tastes (≤ 600
	// characters, trimmed; "" clears it). It reaches the AI prompts only
	// as delimited data (internal/foryou).
	TasteNote *string `json:"taste_note,omitempty"`
	// MinVotes is the minimum TMDB vote count of titles in Explore tiles,
	// Surprise Me's discover fallback and «Для вас» candidates.
	MinVotes *int `json:"min_votes,omitempty"`
	// IPTVPlaylists picks the IPTV playlists this profile shows (iptv.go).
	IPTVPlaylists *IPTVPlaylistsSetting `json:"iptv_playlists,omitempty"`
	// VideoQuality caps YouTube playback (480/720/1080, default 720) and
	// VideoHideShorts hides Shorts from video lists (default true).
	VideoQuality    *int  `json:"video_quality,omitempty"`
	VideoHideShorts *bool `json:"video_hide_shorts,omitempty"`
	// VideoAutoplay: when a video ends, play the next part of its series
	// (else a random related video). Default true.
	VideoAutoplay *bool `json:"video_autoplay,omitempty"`
	// SeasonalEffects: holiday animations — "on", "calm" (still
	// decorations) or "off" (default; users turn them on in Settings). The
	// admin's global switch (appsettings) wins.
	SeasonalEffects *string `json:"seasonal_effects,omitempty"`
	// HiddenTabs are the navigation tabs this profile chose not to show
	// (ids from NavTabs; default none). Home and Settings can't be hidden.
	HiddenTabs *[]string `json:"hidden_tabs,omitempty"`
	// CozyMode: warm, dimmed colours plus an ambience on Home (default
	// off). CozyAmbience picks it ("rain", "fireplace" (default) or "off");
	// CozySound plays it softly (synthesised in the browser; default off).
	CozyMode     *bool   `json:"cozy_mode,omitempty"`
	CozyAmbience *string `json:"cozy_ambience,omitempty"`
	CozySound    *bool   `json:"cozy_sound,omitempty"`
	// PosterWobble: posters tilt toward the cursor (web) or bounce when
	// focused (TV). Default on; reduced motion turns it off anyway.
	PosterWobble *bool `json:"poster_wobble,omitempty"`
	// ShareWithFamily («Делиться с семьёй»): other profiles on this server
	// may see this profile's finished titles, ratings and favorites
	// (internal/family). Opt-in: default off. Never in-progress positions,
	// the watchlist or notes.
	ShareWithFamily *bool `json:"share_with_family,omitempty"`
	// ShowFamily («Показывать, что смотрят другие»): the «Семья советует»
	// row on Home and family ratings in Details. Default on.
	ShowFamily *bool `json:"show_family,omitempty"`
	// ShowCurated («Подборки» on Home): one curated list per day as a
	// «Для вас» row (internal/curated, foryou). Default on.
	ShowCurated *bool `json:"show_curated,omitempty"`
}

// SkipModes are the allowed skip_segments values.
var SkipModes = []string{"button", "auto", "off"}

// SurpriseModes are the allowed design_surprise values.
var SurpriseModes = []string{"off", "day", "week"}

// CozyAmbiences are the allowed cozy_ambience values.
var CozyAmbiences = []string{"rain", "fireplace", "off"}

// NavTabs are the tab ids hidden_tabs may name (web and TV menus).
var NavTabs = []string{"tv", "video", "explore", "new", "history", "ask", "search", "movies", "series", "surprise", "mine", "messages"}

// SeasonalModes are the allowed seasonal_effects values.
var SeasonalModes = []string{"on", "calm", "off"}

// VideoQualities are the allowed video_quality values.
var VideoQualities = []int{480, 720, 1080}

// TasteNoteMax is the taste note length limit (characters).
const TasteNoteMax = 600

// MinVotesChoices are the allowed min_votes values; DefaultMinVotes is
// the default (the floors the recommendations were tuned for).
var MinVotesChoices = []int{0, 50, 100, 300, 1000, 5000}

const DefaultMinVotes = 100

// NormalizeTasteNote trims the note and turns control characters (except
// newlines) into spaces.
func NormalizeTasteNote(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '\n' {
			return r
		}
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}

// SourcesSetting is {"enabled": "all" | ["prowlarr", "jacred", …]}.
// All = every provider enabled by the admin and configured.
type SourcesSetting struct {
	All bool
	IDs []string
	// bad is a shape error found while decoding (reported as 422).
	bad string
}

func (s SourcesSetting) MarshalJSON() ([]byte, error) {
	if s.All {
		return []byte(`{"enabled":"all"}`), nil
	}
	ids := s.IDs
	if ids == nil {
		ids = []string{}
	}
	return json.Marshal(struct {
		Enabled []string `json:"enabled"`
	}{ids})
}

func (s *SourcesSetting) UnmarshalJSON(b []byte) error {
	var raw struct {
		Enabled json.RawMessage `json:"enabled"`
	}
	const msg = `must be {"enabled": "all" | [source ids]}`
	if err := json.Unmarshal(b, &raw); err != nil {
		*s = SourcesSetting{bad: msg}
		return nil
	}
	var all string
	if json.Unmarshal(raw.Enabled, &all) == nil {
		if all != "all" {
			*s = SourcesSetting{bad: msg}
			return nil
		}
		*s = SourcesSetting{All: true}
		return nil
	}
	var ids []string
	if err := json.Unmarshal(raw.Enabled, &ids); err != nil || ids == nil {
		*s = SourcesSetting{bad: msg}
		return nil
	}
	*s = SourcesSetting{IDs: ids}
	return nil
}

var sourceIDRe = regexp.MustCompile(`^[a-z0-9:_-]{1,64}$`)

// knownSources returns the registered provider ids (set by the server);
// nil = don't check ids against a registry.
var knownSources func() []string

// SetKnownSources makes settings validation reject unknown source ids.
func SetKnownSources(f func() []string) { knownSources = f }

var (
	themes        = []string{"system", "dark", "light"}
	loadingStyles = []string{"popcorn", "fill_title", "poster_reveal", "film_reel", "minimal", "marty", "marty_popcorn", "matrix", "paws", "aquarium", "speed88", "odyssey", "balloons", "catch", "surprise"}
	designs       = []string{"kinozal", "terminal", "projector", "wireframe", "cyberpunk", "deco", "retro80", "retro90", "popart", "constructivism", "matrix", "stickerbook", "pocketpet"}
	posterRatings = []string{"kp", "tmdb", "imdb", "off"}
)

// DefaultSettings returns a fully populated default settings object.
func DefaultSettings() Settings {
	t, l, ds := "system", "popcorn", "kinozal"
	f, tr := false, true
	return Settings{Theme: &t, HideAnime: &f, HideWatched: ptr(f), AutoplayNextEpisode: &tr, AutoplayCountdown: &tr, SkipSegments: ptr("button"),
		SpoilerFreeEpisodes: ptr(f), LoadingStyle: &l, OnboardingCompleted: ptr(f), Design: &ds, DesignSurprise: ptr("off"), DesignFavorites: &[]string{}, PosterRating: ptr("kp"),
		Sources: &SourcesSetting{All: true}, TasteNote: ptr(""), MinVotes: ptr(DefaultMinVotes),
		IPTVPlaylists: &IPTVPlaylistsSetting{All: true}, VideoQuality: ptr(720), VideoHideShorts: ptr(true), VideoAutoplay: ptr(true),
		SeasonalEffects: ptr("off"), HiddenTabs: &[]string{},
		CozyMode: ptr(false), CozyAmbience: ptr("fireplace"), CozySound: ptr(false), PosterWobble: ptr(true),
		ShareWithFamily: ptr(false), ShowFamily: ptr(true), ShowCurated: ptr(true)}
}

func ptr[T any](v T) *T { return &v }

// withDefaults fills every unset field.
func (s Settings) withDefaults() Settings {
	d := DefaultSettings()
	if s.Theme != nil && slices.Contains(themes, *s.Theme) {
		d.Theme = s.Theme
	}
	if s.HideAnime != nil {
		d.HideAnime = s.HideAnime
	}
	if s.HideWatched != nil {
		d.HideWatched = s.HideWatched
	}
	if s.AutoplayNextEpisode != nil {
		d.AutoplayNextEpisode = s.AutoplayNextEpisode
	}
	if s.AutoplayCountdown != nil {
		d.AutoplayCountdown = s.AutoplayCountdown
	}
	if s.SkipSegments != nil && slices.Contains(SkipModes, *s.SkipSegments) {
		d.SkipSegments = s.SkipSegments
	}
	if s.SpoilerFreeEpisodes != nil {
		d.SpoilerFreeEpisodes = s.SpoilerFreeEpisodes
	}
	if s.Design != nil && slices.Contains(designs, *s.Design) {
		d.Design = s.Design
	}
	if s.DesignSurprise != nil && slices.Contains(SurpriseModes, *s.DesignSurprise) {
		d.DesignSurprise = s.DesignSurprise
	}
	if s.DesignFavorites != nil {
		favs := []string{}
		for _, id := range *s.DesignFavorites {
			if slices.Contains(designs, id) && !slices.Contains(favs, id) {
				favs = append(favs, id)
			}
		}
		d.DesignFavorites = &favs
	}
	if s.PosterRating != nil && slices.Contains(posterRatings, *s.PosterRating) {
		d.PosterRating = s.PosterRating
	}
	if s.OnboardingCompleted != nil {
		d.OnboardingCompleted = s.OnboardingCompleted
	}
	if s.LoadingStyle != nil && slices.Contains(loadingStyles, *s.LoadingStyle) {
		d.LoadingStyle = s.LoadingStyle
	}
	if s.Sources != nil && s.Sources.bad == "" {
		d.Sources = s.Sources
	}
	if s.TasteNote != nil {
		d.TasteNote = ptr(NormalizeTasteNote(*s.TasteNote))
	}
	if s.MinVotes != nil && slices.Contains(MinVotesChoices, *s.MinVotes) {
		d.MinVotes = s.MinVotes
	}
	if s.IPTVPlaylists != nil && s.IPTVPlaylists.bad == "" {
		d.IPTVPlaylists = s.IPTVPlaylists
	}
	if s.VideoQuality != nil && slices.Contains(VideoQualities, *s.VideoQuality) {
		d.VideoQuality = s.VideoQuality
	}
	if s.VideoHideShorts != nil {
		d.VideoHideShorts = s.VideoHideShorts
	}
	if s.VideoAutoplay != nil {
		d.VideoAutoplay = s.VideoAutoplay
	}
	if s.SeasonalEffects != nil && slices.Contains(SeasonalModes, *s.SeasonalEffects) {
		d.SeasonalEffects = s.SeasonalEffects
	}
	if s.HiddenTabs != nil {
		tabs := []string{}
		for _, id := range *s.HiddenTabs {
			if slices.Contains(NavTabs, id) && !slices.Contains(tabs, id) {
				tabs = append(tabs, id)
			}
		}
		d.HiddenTabs = &tabs
	}
	if s.CozyMode != nil {
		d.CozyMode = s.CozyMode
	}
	if s.CozyAmbience != nil && slices.Contains(CozyAmbiences, *s.CozyAmbience) {
		d.CozyAmbience = s.CozyAmbience
	}
	if s.CozySound != nil {
		d.CozySound = s.CozySound
	}
	if s.PosterWobble != nil {
		d.PosterWobble = s.PosterWobble
	}
	if s.ShareWithFamily != nil {
		d.ShareWithFamily = s.ShareWithFamily
	}
	if s.ShowFamily != nil {
		d.ShowFamily = s.ShowFamily
	}
	if s.ShowCurated != nil {
		d.ShowCurated = s.ShowCurated
	}
	return d
}

func (s Settings) validate() map[string]string {
	f := map[string]string{}
	if s.Theme != nil && !slices.Contains(themes, *s.Theme) {
		f["theme"] = "must be one of system, dark, light"
	}
	if s.SkipSegments != nil && !slices.Contains(SkipModes, *s.SkipSegments) {
		f["skip_segments"] = "must be one of " + strings.Join(SkipModes, ", ")
	}
	if s.LoadingStyle != nil && !slices.Contains(loadingStyles, *s.LoadingStyle) {
		f["loading_style"] = "must be one of " + strings.Join(loadingStyles, ", ")
	}
	if s.Design != nil && !slices.Contains(designs, *s.Design) {
		f["design"] = "must be one of " + strings.Join(designs, ", ")
	}
	if s.DesignSurprise != nil && !slices.Contains(SurpriseModes, *s.DesignSurprise) {
		f["design_surprise"] = "must be one of " + strings.Join(SurpriseModes, ", ")
	}
	if s.DesignFavorites != nil {
		for _, id := range *s.DesignFavorites {
			if !slices.Contains(designs, id) {
				f["design_favorites"] = "unknown design; allowed: " + strings.Join(designs, ", ")
				break
			}
		}
	}
	if s.PosterRating != nil && !slices.Contains(posterRatings, *s.PosterRating) {
		f["poster_rating"] = "must be one of kp, tmdb, imdb, off"
	}
	if s.TasteNote != nil && utf8.RuneCountInString(NormalizeTasteNote(*s.TasteNote)) > TasteNoteMax {
		f["taste_note"] = "at most " + strconv.Itoa(TasteNoteMax) + " characters"
	}
	if s.IPTVPlaylists != nil {
		if msg := s.IPTVPlaylists.validate(); msg != "" {
			f["iptv_playlists"] = msg
		}
	}
	if s.VideoQuality != nil && !slices.Contains(VideoQualities, *s.VideoQuality) {
		f["video_quality"] = "must be one of 480, 720, 1080"
	}
	if s.SeasonalEffects != nil && !slices.Contains(SeasonalModes, *s.SeasonalEffects) {
		f["seasonal_effects"] = "must be one of on, calm, off"
	}
	if s.CozyAmbience != nil && !slices.Contains(CozyAmbiences, *s.CozyAmbience) {
		f["cozy_ambience"] = "must be one of " + strings.Join(CozyAmbiences, ", ")
	}
	if s.HiddenTabs != nil {
		for _, id := range *s.HiddenTabs {
			if !slices.Contains(NavTabs, id) {
				f["hidden_tabs"] = "unknown tab; allowed: " + strings.Join(NavTabs, ", ")
				break
			}
		}
	}
	if s.MinVotes != nil && !slices.Contains(MinVotesChoices, *s.MinVotes) {
		f["min_votes"] = "must be one of 0, 50, 100, 300, 1000, 5000"
	}
	if s.Sources != nil && s.Sources.bad != "" {
		f["sources"] = s.Sources.bad
	} else if s.Sources != nil && !s.Sources.All {
		var known []string
		if knownSources != nil {
			known = knownSources()
		}
		switch {
		case len(s.Sources.IDs) > 50:
			f["sources"] = "at most 50 source ids"
		default:
			for _, id := range s.Sources.IDs {
				if !sourceIDRe.MatchString(id) {
					f["sources"] = "invalid source id"
					break
				}
				if knownSources != nil && !slices.Contains(known, id) {
					f["sources"] = "unknown source id: " + id
					break
				}
			}
		}
	}
	return f
}

// GetSettings returns a profile's settings with defaults filled in.
func (s *Store) GetSettings(ctx context.Context, profileID string) (Settings, error) {
	var raw []byte
	err := s.q.QueryRow(ctx, `SELECT settings FROM profile_settings WHERE profile_id = $1`, profileID).Scan(&raw)
	if err != nil && !isNoRows(err) {
		return Settings{}, err
	}
	var st Settings
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &st) // unknown/garbled keys fall back to defaults
	}
	return st.withDefaults(), nil
}

// MergeSettings stores the provided keys over the existing ones.
func (s *Store) MergeSettings(ctx context.Context, profileID string, patch Settings) error {
	b, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	_, err = s.q.Exec(ctx, `
		INSERT INTO profile_settings (profile_id, settings, updated_at) VALUES ($1, $2::jsonb, now())
		ON CONFLICT (profile_id) DO UPDATE SET settings = profile_settings.settings || EXCLUDED.settings, updated_at = now()`,
		profileID, string(b))
	return err
}

// CanUse reports whether the principal may act on a profile: an account's
// own profiles (browser session / API token), or a profile selectable on the
// calling TV. This is the single check every profile-scoped Phase 5 endpoint
// goes through; callers answer 404 when it is false.
func (s *Store) CanUse(ctx context.Context, p *auth.Principal, profileID string) (bool, error) {
	if p == nil {
		return false, nil
	}
	if p.Kind == auth.KindDevice {
		return s.AccessibleByDevice(ctx, p.DeviceID, profileID)
	}
	var ok bool
	err := s.q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2)`,
		profileID, p.UserID).Scan(&ok)
	return ok, err
}

// RequireProfileCaller allows browser sessions, paired TVs, and API tokens
// with "read" (safe methods) or "write" (everything else). Profile access is
// checked separately with CanUse.
func RequireProfileCaller() fiber.Handler {
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

func (h *Handlers) usable(c fiber.Ctx) (string, error) {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return "", err
	}
	ok, err := h.store.CanUse(c.Context(), auth.PrincipalFrom(c), id)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", httpx.NotFound()
	}
	return id, nil
}

func (h *Handlers) getSettings(c fiber.Ctx) error {
	id, err := h.usable(c)
	if err != nil {
		return err
	}
	st, err := h.store.GetSettings(c.Context(), id)
	if err != nil {
		return err
	}
	return c.JSON(st)
}

func (h *Handlers) putSettings(c fiber.Ctx) error {
	id, err := h.usable(c)
	if err != nil {
		return err
	}
	var in Settings
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if f := in.validate(); len(f) > 0 {
		return httpx.Validation(f)
	}
	if in.TasteNote != nil {
		in.TasteNote = ptr(NormalizeTasteNote(*in.TasteNote))
	}
	before, err := h.store.GetSettings(c.Context(), id)
	if err != nil {
		return err
	}
	if err := h.store.MergeSettings(c.Context(), id, in); err != nil {
		return err
	}
	after, err := h.store.GetSettings(c.Context(), id)
	if err != nil {
		return err
	}
	for _, f := range h.onSettings {
		f(c.Context(), id, before, after)
	}
	return c.JSON(after)
}

// OnSettingsChanged registers a callback run after every successful
// settings PUT with the settings before and after (defaults filled). It
// must return quickly (start background work itself).
func (h *Handlers) OnSettingsChanged(f func(ctx context.Context, profileID string, before, after Settings)) {
	h.onSettings = append(h.onSettings, f)
}
