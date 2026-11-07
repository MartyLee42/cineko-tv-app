package profiles

import (
	"context"
	"encoding/json"
	"slices"
	"strings"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

// Device settings layers: a profile's look and playback behaviour can differ
// per device class («Компьютер», «Телефон») and per TV. profile_settings is
// the base; a layer holds only the LayeredKeys a client set there. The
// effective settings of a device are base → its layer (the layer wins per
// key). Taste, content and AI settings (min_votes, taste_note, sources,
// hide_*, family, video_quality…) are not layered: they stay per profile.
// Mirrors LAYERED_KEYS in packages/ui/src/deviceSettings.ts.

// Device classes a browser may name (?device_class=). TVs are layered per
// device (their own id), never by class.
const (
	ClassDesktop = "desktop"
	ClassMobile  = "mobile"
)

// DeviceClasses are the allowed ?device_class= values.
var DeviceClasses = []string{ClassDesktop, ClassMobile}

// LayeredKeys are the settings that live per device class / per TV.
var LayeredKeys = []string{
	"theme", "design", "design_surprise", "design_favorites", "loading_style",
	"seasonal_effects", "cozy_mode", "cozy_ambience", "cozy_sound", "poster_wobble", "hidden_tabs",
	"autoplay_next_episode", "autoplay_countdown", "skip_segments", "video_autoplay",
}

// IsLayered reports whether a settings key lives per device.
func IsLayered(key string) bool { return slices.Contains(LayeredKeys, key) }

// Layer names where a write goes / what a read merges: the zero value is
// the base (legacy clients, API tokens), Class a browser class, DeviceID a TV.
type Layer struct {
	Class    string
	DeviceID string
}

// IsBase reports whether l is the profile base.
func (l Layer) IsBase() bool { return l.Class == "" && l.DeviceID == "" }

// rawMap decodes a settings object into its keys (garbled = empty).
func rawMap(b []byte) map[string]json.RawMessage {
	m := map[string]json.RawMessage{}
	if len(b) > 0 {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

// MergeLayers resolves effective settings: the base keys, then each layer's
// layered keys over them (later layers win), defaults filled in. Invalid
// values fall back exactly like a lone base (withDefaults).
func MergeLayers(base []byte, layers ...[]byte) Settings {
	m := rawMap(base)
	for _, l := range layers {
		for k, v := range rawMap(l) {
			if IsLayered(k) && string(v) != "null" {
				m[k] = v
			}
		}
	}
	b, _ := json.Marshal(m)
	var st Settings
	_ = json.Unmarshal(b, &st)
	return st.withDefaults()
}

// LayerOnly returns the layered keys a raw layer sets (as a sparse Settings,
// garbled values dropped).
func LayerOnly(raw []byte) Settings {
	m := map[string]json.RawMessage{}
	for k, v := range rawMap(raw) {
		if IsLayered(k) && string(v) != "null" {
			m[k] = v
		}
	}
	b, _ := json.Marshal(m)
	var st Settings
	_ = json.Unmarshal(b, &st)
	return st
}

// SplitPatch splits a settings patch into the base part and the layered
// part (both as JSON objects; nil = nothing).
func SplitPatch(patch Settings) (base, layer []byte, err error) {
	b, err := json.Marshal(patch)
	if err != nil {
		return nil, nil, err
	}
	bm, lm := map[string]json.RawMessage{}, map[string]json.RawMessage{}
	for k, v := range rawMap(b) {
		if IsLayered(k) {
			lm[k] = v
		} else {
			bm[k] = v
		}
	}
	enc := func(m map[string]json.RawMessage) []byte {
		if len(m) == 0 {
			return nil
		}
		out, _ := json.Marshal(m)
		return out
	}
	return enc(bm), enc(lm), nil
}

// ParseClass validates ?device_class= ("" = none).
func ParseClass(v string) (string, bool) {
	v = strings.TrimSpace(v)
	return v, v == "" || slices.Contains(DeviceClasses, v)
}

// ---------------------------------------------------------------- store

// rawBase returns the profile's base settings as stored.
func (s *Store) rawBase(ctx context.Context, profileID string) ([]byte, error) {
	var raw []byte
	err := s.q.QueryRow(ctx, `SELECT settings FROM profile_settings WHERE profile_id = $1`, profileID).Scan(&raw)
	if err != nil && !isNoRows(err) {
		return nil, err
	}
	return raw, nil
}

// RawLayer returns a layer's stored keys (nil for the base or nothing set).
func (s *Store) RawLayer(ctx context.Context, profileID string, l Layer) ([]byte, error) {
	var raw []byte
	var err error
	switch {
	case l.DeviceID != "":
		err = s.q.QueryRow(ctx, `SELECT settings FROM profile_device_settings WHERE profile_id = $1 AND device_id = $2`,
			profileID, l.DeviceID).Scan(&raw)
	case l.Class != "":
		err = s.q.QueryRow(ctx, `SELECT settings FROM profile_class_settings WHERE profile_id = $1 AND device_class = $2`,
			profileID, l.Class).Scan(&raw)
	default:
		return nil, nil
	}
	if err != nil && !isNoRows(err) {
		return nil, err
	}
	return raw, nil
}

// GetEffective returns the settings a device sees: base → layer.
func (s *Store) GetEffective(ctx context.Context, profileID string, l Layer) (Settings, error) {
	base, err := s.rawBase(ctx, profileID)
	if err != nil {
		return Settings{}, err
	}
	layer, err := s.RawLayer(ctx, profileID, l)
	if err != nil {
		return Settings{}, err
	}
	return MergeLayers(base, layer), nil
}

// MergeLayer stores layered keys (a JSON object) over a layer's existing ones.
func (s *Store) MergeLayer(ctx context.Context, profileID string, l Layer, patch []byte) error {
	if len(patch) == 0 || l.IsBase() {
		return nil
	}
	var err error
	if l.DeviceID != "" {
		_, err = s.q.Exec(ctx, `
			INSERT INTO profile_device_settings (profile_id, device_id, settings, updated_at) VALUES ($1, $2, $3::jsonb, now())
			ON CONFLICT (profile_id, device_id) DO UPDATE SET settings = profile_device_settings.settings || EXCLUDED.settings, updated_at = now()`,
			profileID, l.DeviceID, string(patch))
	} else {
		_, err = s.q.Exec(ctx, `
			INSERT INTO profile_class_settings (profile_id, device_class, settings, updated_at) VALUES ($1, $2, $3::jsonb, now())
			ON CONFLICT (profile_id, device_class) DO UPDATE SET settings = profile_class_settings.settings || EXCLUDED.settings, updated_at = now()`,
			profileID, l.Class, string(patch))
	}
	return err
}

// ResetLayer removes keys from a layer (they follow the base again).
func (s *Store) ResetLayer(ctx context.Context, profileID string, l Layer, keys []string) error {
	if len(keys) == 0 || l.IsBase() {
		return nil
	}
	var err error
	if l.DeviceID != "" {
		_, err = s.q.Exec(ctx, `UPDATE profile_device_settings SET settings = settings - $3::text[], updated_at = now()
			WHERE profile_id = $1 AND device_id = $2`, profileID, l.DeviceID, keys)
	} else {
		_, err = s.q.Exec(ctx, `UPDATE profile_class_settings SET settings = settings - $3::text[], updated_at = now()
			WHERE profile_id = $1 AND device_class = $2`, profileID, l.Class, keys)
	}
	return err
}

// ApplyPatch saves a validated settings patch for a device: the layered keys
// go to its layer, the rest to the base (everything to the base when l is
// the base). It reports whether the base changed.
func (s *Store) ApplyPatch(ctx context.Context, profileID string, l Layer, patch Settings) (baseChanged bool, err error) {
	if l.IsBase() {
		return true, s.MergeSettings(ctx, profileID, patch)
	}
	base, layer, err := SplitPatch(patch)
	if err != nil {
		return false, err
	}
	if err := s.MergeLayer(ctx, profileID, l, layer); err != nil {
		return false, err
	}
	if len(base) == 0 {
		return false, nil
	}
	_, err = s.q.Exec(ctx, `
		INSERT INTO profile_settings (profile_id, settings, updated_at) VALUES ($1, $2::jsonb, now())
		ON CONFLICT (profile_id) DO UPDATE SET settings = profile_settings.settings || EXCLUDED.settings, updated_at = now()`,
		profileID, string(base))
	return true, err
}

// OwnerOf returns the account a profile belongs to ("" if none).
func (s *Store) OwnerOf(ctx context.Context, profileID string) (string, error) {
	var id string
	err := s.q.QueryRow(ctx, `SELECT user_id FROM profiles WHERE id = $1`, profileID).Scan(&id)
	if isNoRows(err) {
		return "", nil
	}
	return id, err
}

// layerOf picks the caller's layer: a TV its own, a browser the
// ?device_class= it names, anything else the base.
func layerOf(c fiber.Ctx) (Layer, error) {
	p := auth.PrincipalFrom(c)
	if p != nil && p.Kind == auth.KindDevice {
		return Layer{DeviceID: p.DeviceID}, nil
	}
	class, ok := ParseClass(c.Query("device_class"))
	if !ok {
		return Layer{}, httpx.Validation(map[string]string{"device_class": "must be one of " + strings.Join(DeviceClasses, ", ")})
	}
	return Layer{Class: class}, nil
}

// Validate checks a settings patch (field → message; empty = valid).
func (s Settings) Validate() map[string]string { return s.validate() }
