package releases

import (
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/auth"
	"martytv/api/internal/devices"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
	"martytv/api/internal/sources"
	"martytv/api/internal/uilang"
)

// SelectionOf converts a profile's sources setting (nil = default all).
func SelectionOf(s *profiles.SourcesSetting) *sources.Selection {
	if s == nil || s.All {
		return &sources.Selection{All: true}
	}
	return &sources.Selection{IDs: s.IDs}
}

type Handlers struct {
	svc      *Service
	profiles *profiles.Store
	devices  *devices.Store
	// refresh limits refresh=true (a live Prowlarr search) per user/device.
	refresh *httpx.RateLimiter
}

func NewHandlers(s *Service) *Handlers {
	return &Handlers{svc: s, profiles: profiles.NewStore(s.pool), devices: devices.NewStore(s.pool, nil), refresh: httpx.NewRateLimiter(6, 10*time.Minute)}
}

func (h *Handlers) Routes(api fiber.Router) {
	api.Get("/media/:id/releases", auth.RequireReader(), h.list)
}

func (h *Handlers) list(c fiber.Ctx) error {
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
	switch v := strings.ToLower(c.Query("refresh")); v {
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
	profileID := strings.Clone(c.Query("profile_id"))
	if profileID != "" {
		if _, err := uuid.Parse(profileID); err != nil || len(profileID) != 36 {
			fields["profile_id"] = "must be a UUID"
		}
	}
	query := strings.Join(strings.Fields(c.Query("q")), " ")
	if query != "" && (len([]rune(query)) < 2 || len([]rune(query)) > 100) {
		fields["q"] = "must be 2-100 characters"
	}
	loose := false
	switch v := strings.ToLower(c.Query("loose")); v {
	case "", "false", "0":
	case "true", "1":
		loose = true
	default:
		fields["loose"] = "must be true or false"
	}
	deviceID := strings.Clone(c.Query("device_id"))
	if deviceID != "" {
		if _, err := uuid.Parse(deviceID); err != nil || len(deviceID) != 36 {
			fields["device_id"] = "must be a UUID"
		}
	}
	clientID := strings.Clone(c.Query("client_id"))
	if clientID != "" && !devices.ValidClientID(clientID) {
		fields["client_id"] = "must be 8-64 characters of A-Z, a-z, 0-9, _ or -"
	}
	devicePrefs := true
	switch v := strings.ToLower(c.Query("device_prefs")); v {
	case "", "on", "true", "1":
	case "off", "false", "0":
		devicePrefs = false
	default:
		fields["device_prefs"] = "must be on or off"
	}
	if episode != nil && season == nil && fields["season"] == "" {
		fields["episode"] = "requires season"
	}
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	if !h.svc.Available() {
		return httpx.NewError(fiber.StatusServiceUnavailable, "releases_unavailable", "Release search is not configured (no torrent source is configured and enabled).")
	}

	p := auth.PrincipalFrom(c)
	prefs, err := h.prefs(c, p, profileID, lang)
	if err != nil {
		return err
	}
	var fit *DeviceFit
	if devicePrefs {
		if fit, err = h.deviceFit(c, p, deviceID, clientID); err != nil {
			return err
		}
		if fit != nil {
			prefs.Device = &fit.Prefs
		}
	}
	var sel *sources.Selection
	if profileID != "" {
		st, err := h.profiles.GetSettings(c.Context(), profileID)
		if err != nil {
			return err
		}
		sel = SelectionOf(st.Sources)
	}
	if refresh || query != "" {
		key := "u:" + p.UserID
		if p.Kind == auth.KindDevice {
			key = "d:" + p.DeviceID
		}
		if ok, wait := h.refresh.Allow(key); !ok {
			return httpx.TooManyRequests(wait)
		}
	}

	list, err := h.svc.List(c.Context(), ListParams{MediaID: id, Season: season, Episode: episode, Refresh: refresh, Prefs: prefs, Query: query, Loose: loose, Sources: sel})
	var fe *FieldError
	switch {
	case err == nil:
		list.Device = fit
		return c.JSON(list)
	case errors.As(err, &fe):
		return httpx.Validation(map[string]string{fe.Field: fe.Message})
	case errors.Is(err, ErrNotFound):
		return httpx.NotFound()
	case errors.Is(err, ErrUnavailable):
		return httpx.NewError(fiber.StatusServiceUnavailable, "releases_unavailable", "Release search is not configured (no torrent source is configured and enabled).")
	case errors.Is(err, ErrUpstream):
		return httpx.NewError(fiber.StatusBadGateway, "releases_upstream_error", "Torrent search is unreachable right now. Try again later.")
	case errors.Is(err, ErrCatalog):
		h.svc.log.WarnContext(c.Context(), "release target lookup failed", "err", err)
		return httpx.NewError(fiber.StatusBadGateway, "catalog_upstream_error", "TMDB is unreachable right now. Try again later.")
	}
	return err
}

// prefs loads ranking preferences from an accessible profile (owned by the
// user, or usable on the calling TV), or defaults from lang.
func (h *Handlers) prefs(c fiber.Ctx, p *auth.Principal, profileID, lang string) (Prefs, error) {
	if profileID == "" {
		if lang == "" {
			lang = "en"
		}
		return Prefs{Languages: uniq(lang, "en")}, nil
	}
	if p.Kind == auth.KindDevice {
		ok, err := h.profiles.AccessibleByDevice(c.Context(), p.DeviceID, profileID)
		if err != nil {
			return Prefs{}, err
		}
		if !ok {
			return Prefs{}, httpx.NotFound()
		}
	} else if _, err := h.profiles.GetOwned(c.Context(), p.UserID, profileID); errors.Is(err, profiles.ErrNotFound) {
		return Prefs{}, httpx.NotFound()
	} else if err != nil {
		return Prefs{}, err
	}
	pp, err := h.profiles.GetPreferences(c.Context(), profileID)
	if err != nil {
		return Prefs{}, err
	}
	return PrefsOf(pp), nil
}

// deviceFit resolves the playback profile the list is ranked for: device_id
// (owner/use/super_admin, else 404), else the caller's own browser record
// client_id (unknown → none; ignored for TVs), else the calling TV's own profile. Nil when
// none applies or it has nothing to judge.
func (h *Handlers) deviceFit(c fiber.Ctx, p *auth.Principal, deviceID, clientID string) (*DeviceFit, error) {
	ctx := c.Context()
	var fit *DeviceFit
	switch {
	case deviceID != "" || p.Kind == auth.KindDevice:
		if deviceID == "" {
			deviceID = p.DeviceID
		}
		d, err := h.devices.PlaybackFor(ctx, p, deviceID)
		if errors.Is(err, devices.ErrNotFound) {
			if p.Kind == auth.KindDevice && deviceID == p.DeviceID {
				return nil, nil
			}
			return nil, httpx.NotFound()
		}
		if err != nil {
			return nil, err
		}
		fit = &DeviceFit{Kind: "device", ID: d.ID, Name: d.Name, Prefs: d.Prefs.Effective, Constraints: d.Prefs.Constraints}
		if devices.UnmeasuredCap(d.Prefs.Auto, d.Prefs.Manual) {
			h.svc.log.InfoContext(ctx, "device fit: unmeasured TV, default bitrate cap", "device_id", d.ID,
				"max_bitrate_mbps", devices.UnmeasuredTVBitrateMbps, "platform", deref(d.Prefs.Auto.Platform))
		}
	case clientID != "":
		cl, err := h.devices.GetClient(ctx, p.UserID, clientID)
		if errors.Is(err, devices.ErrNotFound) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		name := cl.Name
		if name == "" {
			name = cl.Platform
		}
		fit = &DeviceFit{Kind: "client", ID: cl.ClientID, Name: name, Prefs: cl.Effective, Constraints: cl.Constraints}
	default:
		return nil, nil
	}
	if !HasDeviceLimits(fit.Prefs) {
		return nil, nil
	}
	return fit, nil
}

// PrefsOf converts a profile's stored preferences to ranking preferences.
func PrefsOf(pp *profiles.Preferences) Prefs {
	langs := pp.PreferredAudioLanguages
	if len(langs) == 0 {
		langs = uniq(pp.UILanguage, uilang.Catalog(pp.UILanguage), "en") // Kazakh: kk, then Russian dubs
	}
	out := Prefs{Languages: langs, Resolution: pp.PreferredResolution, MaxSizeGB: pp.MaxSizeGB}
	out.Voiceovers = pp.PreferredVoiceovers
	for _, c := range pp.PreferredCodecs {
		out.Codecs = append(out.Codecs, codecAlias(c))
	}
	return out
}

func uniq(vals ...string) []string {
	var out []string
	for _, v := range vals {
		if v != "" && !containsFold(out, v) {
			out = append(out, v)
		}
	}
	return out
}

// codecAlias maps common spellings to the contract's codec names.
func codecAlias(c string) string {
	switch strings.ToLower(strings.ReplaceAll(c, ".", "")) {
	case "x264", "h264", "avc":
		return "h264"
	case "x265", "h265", "hevc":
		return "hevc"
	case "ac-3", "ac3", "dd":
		return "ac3"
	case "e-ac3", "eac3", "ddp", "dd+":
		return "eac3"
	}
	return strings.ToLower(c)
}
