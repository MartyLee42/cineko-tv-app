// Package devicesettings serves a TV's settings (GET/PATCH
// /devices/{id}/settings): its own options for every profile (screensaver,
// UI sounds, intro, calm motion, language, player hints) and, per profile,
// the TV's layer of the profile settings (design, theme, autoplay…; see
// profiles.LayeredKeys). The TV itself reads and seeds them; a phone or
// computer of the household edits any TV it may use, and the TV applies the
// change live (realtime "settings.changed").
package devicesettings

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"

	"martytv/api/internal/auth"
	"martytv/api/internal/db"
	"martytv/api/internal/devices"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
	"martytv/api/internal/realtime"
)

// TypeSettingsChanged tells a TV (payload {profile_id?}) that its settings
// were changed elsewhere: it re-reads /devices/me/settings and, with a
// profile_id, that profile's settings. Also sent to the TVs of a profile's
// owner when the profile base changes.
const TypeSettingsChanged = "settings.changed"

// Settings is contract TvDeviceSettings: a TV's own options (nil = not set
// yet; the TV seeds its local values once, clients fill defaults).
type Settings struct {
	Screensaver   *string `json:"screensaver,omitempty"`
	UISounds      *bool   `json:"ui_sounds,omitempty"`
	StartupIntro  *bool   `json:"startup_intro,omitempty"`
	CalmMotion    *bool   `json:"calm_motion,omitempty"`
	Language      *string `json:"language,omitempty"`
	HealthReport  *bool   `json:"health_report,omitempty"`
	SlowHint      *bool   `json:"slow_hint,omitempty"`
	ShowPrebuffer *bool   `json:"show_prebuffer,omitempty"`
	Speedtest     *bool   `json:"speedtest,omitempty"`
}

// Allowed values (mirrors packages/ui deviceSettings.ts).
var (
	Screensavers = []string{"sleep", "dvd", "off"}
	Languages    = []string{"ru", "en", "kk"}
	// Keys are the JSON names of Settings (reset_device).
	Keys = []string{"screensaver", "ui_sounds", "startup_intro", "calm_motion", "language", "health_report", "slow_hint", "show_prebuffer", "speedtest"}
)

// Validate returns field errors keyed "device.<field>".
func (s Settings) Validate() map[string]string {
	f := map[string]string{}
	if s.Screensaver != nil && !slices.Contains(Screensavers, *s.Screensaver) {
		f["device.screensaver"] = "must be one of " + strings.Join(Screensavers, ", ")
	}
	if s.Language != nil && !slices.Contains(Languages, *s.Language) {
		f["device.language"] = "must be one of " + strings.Join(Languages, ", ")
	}
	return f
}

// sanitize drops stored values that are no longer valid.
func (s Settings) sanitize() Settings {
	if s.Screensaver != nil && !slices.Contains(Screensavers, *s.Screensaver) {
		s.Screensaver = nil
	}
	if s.Language != nil && !slices.Contains(Languages, *s.Language) {
		s.Language = nil
	}
	return s
}

// ProfileRef is a profile the caller may edit on the TV.
type ProfileRef struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Avatar string `json:"avatar"`
	Color  string `json:"color"`
	Own    bool   `json:"own"`
}

// View is contract TvSettings.
type View struct {
	DeviceID        string             `json:"device_id"`
	Device          Settings           `json:"device"`
	UpdatedAt       *time.Time         `json:"updated_at"`
	Profiles        []ProfileRef       `json:"profiles"`
	ActiveProfileID *string            `json:"active_profile_id"`
	ProfileID       *string            `json:"profile_id"`
	Effective       *profiles.Settings `json:"effective"`
	Overrides       *profiles.Settings `json:"overrides"`
	LayeredKeys     []string           `json:"layered_keys"`
}

// Notifier is the realtime hub (only what this package needs).
type Notifier interface {
	NotifyDevice(deviceID string, env realtime.Envelope) bool
	NotifyDevicesOwnedBy(userIDs []string, env realtime.Envelope)
	LastState(deviceID string) json.RawMessage
}

type Handlers struct {
	q        db.Querier
	devices  *devices.Store
	profiles *profiles.Store
	hub      Notifier
}

func New(q db.Querier, d *devices.Store, p *profiles.Store, hub Notifier) *Handlers {
	return &Handlers{q: q, devices: d, profiles: p, hub: hub}
}

// MaxBody bounds a PATCH body.
const MaxBody = 16 << 10

func (h *Handlers) Routes(api fiber.Router) {
	api.Get("/devices/:id/settings", requireUserOrDevice(), h.get)
	api.Patch("/devices/:id/settings", requireUserOrDevice(), h.patch)
}

// requireUserOrDevice: paired TVs, browser sessions, API tokens (read for
// GET, write otherwise) — like the playback-prefs endpoints.
func requireUserOrDevice() fiber.Handler {
	user := auth.RequireUser()
	return func(c fiber.Ctx) error {
		if p := auth.PrincipalFrom(c); p != nil && p.Kind == auth.KindDevice {
			return c.Next()
		}
		return user(c)
	}
}

// target resolves :id ("me" = the calling TV) and checks access: the TV
// itself, its owner, a `use` share, any super_admin (devices.UseAccess).
func (h *Handlers) target(c fiber.Ctx) (deviceID, ownerID string, err error) {
	p := auth.PrincipalFrom(c)
	if c.Params("id") == "me" {
		if p.Kind != auth.KindDevice {
			return "", "", httpx.NotFound()
		}
		deviceID = p.DeviceID
	} else if deviceID, err = httpx.ParamUUID(c, "id"); err != nil {
		return "", "", err
	}
	ownerID, err = h.devices.UseAccess(c.Context(), p, deviceID)
	if errors.Is(err, devices.ErrNotFound) {
		return "", "", httpx.NotFound()
	}
	return deviceID, ownerID, err
}

// editableProfiles are the TV's profiles the caller may change there: all of
// them for the TV itself, its owner and a super_admin; a `use` share only
// its own.
func (h *Handlers) editableProfiles(ctx context.Context, p *auth.Principal, deviceID, ownerID string) ([]ProfileRef, error) {
	list, err := h.profiles.ListForDevice(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	all := p.Kind == auth.KindDevice || p.UserID == ownerID || devices.CanControlAny(p)
	out := []ProfileRef{}
	for _, pr := range list {
		own := p.Kind != auth.KindDevice && pr.UserID == p.UserID
		if all || own {
			out = append(out, ProfileRef{ID: pr.ID, Name: pr.Name, Avatar: pr.Avatar, Color: pr.Color, Own: own})
		}
	}
	return out, nil
}

func (h *Handlers) readDevice(ctx context.Context, deviceID string) (Settings, *time.Time, error) {
	var raw []byte
	var at *time.Time
	if err := h.q.QueryRow(ctx, `SELECT settings, settings_updated_at FROM devices WHERE id = $1`, deviceID).Scan(&raw, &at); err != nil {
		return Settings{}, nil, err
	}
	var s Settings
	_ = json.Unmarshal(raw, &s)
	return s.sanitize(), at, nil
}

// activeProfile is the profile the TV reports showing now (live state).
func (h *Handlers) activeProfile(deviceID string) *string {
	var st struct {
		ProfileID *string `json:"profile_id"`
	}
	if raw := h.hub.LastState(deviceID); len(raw) > 0 && json.Unmarshal(raw, &st) == nil && st.ProfileID != nil {
		if _, err := uuid.Parse(*st.ProfileID); err == nil {
			return st.ProfileID
		}
	}
	return nil
}

// view builds the answer for profileID ("" = the TV's active profile, else
// its default, else the first editable one).
func (h *Handlers) view(ctx context.Context, p *auth.Principal, deviceID, ownerID, profileID string) (*View, error) {
	ds, at, err := h.readDevice(ctx, deviceID)
	if err != nil {
		return nil, err
	}
	list, err := h.editableProfiles(ctx, p, deviceID, ownerID)
	if err != nil {
		return nil, err
	}
	v := &View{DeviceID: deviceID, Device: ds, UpdatedAt: at, Profiles: list, ActiveProfileID: h.activeProfile(deviceID), LayeredKeys: profiles.LayeredKeys}
	has := func(id string) bool {
		return slices.ContainsFunc(list, func(r ProfileRef) bool { return r.ID == id })
	}
	if profileID == "" {
		var def *string
		_ = h.q.QueryRow(ctx, `SELECT default_profile_id FROM devices WHERE id = $1`, deviceID).Scan(&def)
		switch {
		case v.ActiveProfileID != nil && has(*v.ActiveProfileID):
			profileID = *v.ActiveProfileID
		case def != nil && has(*def):
			profileID = *def
		case len(list) > 0:
			profileID = list[0].ID
		}
	} else if !has(profileID) {
		return nil, httpx.NotFound()
	}
	if profileID == "" {
		return v, nil
	}
	l := profiles.Layer{DeviceID: deviceID}
	eff, err := h.profiles.GetEffective(ctx, profileID, l)
	if err != nil {
		return nil, err
	}
	raw, err := h.profiles.RawLayer(ctx, profileID, l)
	if err != nil {
		return nil, err
	}
	over := profiles.LayerOnly(raw)
	v.ProfileID, v.Effective, v.Overrides = &profileID, &eff, &over
	return v, nil
}

func (h *Handlers) get(c fiber.Ctx) error {
	deviceID, ownerID, err := h.target(c)
	if err != nil {
		return err
	}
	profileID := c.Query("profile_id")
	if profileID != "" {
		if _, err := uuid.Parse(profileID); err != nil {
			return httpx.NotFound()
		}
	}
	v, err := h.view(c.Context(), auth.PrincipalFrom(c), deviceID, ownerID, profileID)
	if err != nil {
		return err
	}
	return c.JSON(v)
}

// Patch is contract TvSettingsPatch.
type Patch struct {
	Device      *Settings          `json:"device"`
	ResetDevice []string           `json:"reset_device"`
	ProfileID   *string            `json:"profile_id"`
	Profile     *profiles.Settings `json:"profile"`
	Reset       []string           `json:"reset"`
}

// validate checks the patch shape (field errors).
func (in Patch) validate() map[string]string {
	f := map[string]string{}
	if in.Device != nil {
		for k, v := range in.Device.Validate() {
			f[k] = v
		}
	}
	for _, k := range in.ResetDevice {
		if !slices.Contains(Keys, k) {
			f["reset_device"] = "unknown key; allowed: " + strings.Join(Keys, ", ")
			break
		}
	}
	for _, k := range in.Reset {
		if !profiles.IsLayered(k) {
			f["reset"] = "not a per-device setting; allowed: " + strings.Join(profiles.LayeredKeys, ", ")
			break
		}
	}
	if in.Profile != nil {
		for k, v := range in.Profile.Validate() {
			f["profile."+k] = v
		}
		if base, _, err := profiles.SplitPatch(*in.Profile); err == nil && len(base) > 0 {
			f["profile"] = "only per-device settings: " + strings.Join(profiles.LayeredKeys, ", ")
		}
	}
	if (in.Profile != nil || len(in.Reset) > 0) && in.ProfileID == nil {
		f["profile_id"] = "required with profile / reset"
	}
	if in.ProfileID != nil {
		if _, err := uuid.Parse(*in.ProfileID); err != nil {
			f["profile_id"] = "must be a profile id"
		}
	}
	return f
}

func (h *Handlers) patch(c fiber.Ctx) error {
	if len(c.Body()) > MaxBody {
		return httpx.NewError(fiber.StatusRequestEntityTooLarge, "payload_too_large", "Body is larger than 16 KB.")
	}
	deviceID, ownerID, err := h.target(c)
	if err != nil {
		return err
	}
	var in Patch
	if err := httpx.BindJSON(c, &in); err != nil {
		return err
	}
	if f := in.validate(); len(f) > 0 {
		return httpx.Validation(f)
	}
	ctx := c.Context()
	p := auth.PrincipalFrom(c)
	profileID := ""
	if in.ProfileID != nil {
		profileID = strings.ToLower(*in.ProfileID)
		list, err := h.editableProfiles(ctx, p, deviceID, ownerID)
		if err != nil {
			return err
		}
		if !slices.ContainsFunc(list, func(r ProfileRef) bool { return r.ID == profileID }) {
			return httpx.NotFound()
		}
	}
	if in.Device != nil || len(in.ResetDevice) > 0 {
		dev, _ := json.Marshal(in.Device)
		if in.Device == nil {
			dev = []byte("{}")
		}
		reset := in.ResetDevice
		if reset == nil {
			reset = []string{}
		}
		if _, err := h.q.Exec(ctx, `UPDATE devices SET settings = (settings - $3::text[]) || $2::jsonb, settings_updated_at = now()
			WHERE id = $1 AND revoked_at IS NULL`, deviceID, string(dev), reset); err != nil {
			return err
		}
	}
	if profileID != "" {
		l := profiles.Layer{DeviceID: deviceID}
		if err := h.profiles.ResetLayer(ctx, profileID, l, in.Reset); err != nil {
			return err
		}
		if in.Profile != nil {
			if _, layer, err := profiles.SplitPatch(*in.Profile); err != nil {
				return err
			} else if err := h.profiles.MergeLayer(ctx, profileID, l, layer); err != nil {
				return err
			}
		}
	}
	// Edited from a phone / computer: the TV applies it now.
	if p.Kind != auth.KindDevice {
		h.hub.NotifyDevice(deviceID, Event(profileID))
	}
	v, err := h.view(ctx, p, deviceID, ownerID, profileID)
	if err != nil {
		return err
	}
	return c.JSON(v)
}

// Event is the settings.changed envelope (profileID "" = only the TV's own options).
func Event(profileID string) realtime.Envelope {
	payload := map[string]any{}
	if profileID != "" {
		payload["profile_id"] = profileID
	}
	b, _ := json.Marshal(payload)
	return realtime.Envelope{Type: TypeSettingsChanged, Payload: b}
}

// ProfileBaseChanged is a profiles.OnSettingsChanged hook: when a profile's
// base changed (taste, content or legacy writes), the TVs of its owner
// refresh it instead of waiting for their cache to expire.
func (h *Handlers) ProfileBaseChanged(ctx context.Context, profileID string, before, after profiles.Settings) {
	b1, _ := json.Marshal(before)
	b2, _ := json.Marshal(after)
	if string(b1) == string(b2) {
		return
	}
	owner, err := h.profiles.OwnerOf(ctx, profileID)
	if err != nil || owner == "" {
		return
	}
	h.hub.NotifyDevicesOwnedBy([]string{owner}, Event(profileID))
}
