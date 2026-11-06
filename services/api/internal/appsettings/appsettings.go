// Package appsettings holds server-wide switches set by admins (table
// app_settings, one JSON value per key). Today it has one: the global
// switch of the seasonal/holiday animations (readers see it in GET /status
// `seasonal_effects`; admins change it at /admin/appearance) and the
// DeepSeek temperatures (internal/foryou: /admin/foryou/ai).
//
// The value is cached in memory (one API instance, see the architecture
// doc's assumptions), so /status never reads the database for it.
package appsettings

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"sync"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/db"
	"martytv/api/internal/httpx"
)

const (
	keySeasonal      = "seasonal_effects"
	keyAITemperature = "ai_temperature"
	keyFactsAI       = "ai_facts"
)

// AI temperature range and default (DeepSeek accepts 0–2; above 1.5 the
// titles turn into inventions).
const (
	TemperatureMin     = 0.0
	TemperatureMax     = 1.5
	TemperatureDefault = 1.0
)

// AITemperature is the admin's DeepSeek temperature per feature: AI
// collections, «Спросить ИИ», Cineko Music playlists and the AI «Факты».
type AITemperature struct {
	Collections float64 `json:"collections"`
	Ask         float64 `json:"ask"`
	Music       float64 `json:"music"`
	Facts       float64 `json:"facts"`
}

// FactsTemperatureDefault: facts should be accurate rather than varied.
const FactsTemperatureDefault = 0.7

// DefaultAITemperature is used until an admin changes it.
func DefaultAITemperature() AITemperature {
	return AITemperature{Collections: TemperatureDefault, Ask: TemperatureDefault, Music: TemperatureDefault, Facts: FactsTemperatureDefault}
}

// ClampTemperature keeps t within [TemperatureMin, TemperatureMax], rounded to 0.05.
func ClampTemperature(t float64) float64 {
	t = math.Round(t*20) / 20
	return math.Max(TemperatureMin, math.Min(TemperatureMax, t))
}

// ValidTemperature reports whether t is a number in range.
func ValidTemperature(t float64) bool {
	return !math.IsNaN(t) && t >= TemperatureMin && t <= TemperatureMax
}

// Store reads and writes app_settings.
type Store struct {
	q     db.Querier
	audit *audit.Logger
	log   *slog.Logger

	mu       sync.Mutex
	loaded   bool
	seasonal bool

	tempLoaded bool
	temp       AITemperature

	factsAILoaded bool
	factsAI       bool
}

func NewStore(q db.Querier, auditLog *audit.Logger, log *slog.Logger) *Store {
	return &Store{q: q, audit: auditLog, log: log}
}

type seasonalValue struct {
	Enabled bool `json:"enabled"`
}

// SeasonalEnabled reports whether holiday animations are allowed for
// everyone (default true; a database error also answers true and is
// retried on the next call).
func (s *Store) SeasonalEnabled(ctx context.Context) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.loaded {
		return s.seasonal
	}
	var raw []byte
	err := s.q.QueryRow(ctx, `SELECT value FROM app_settings WHERE key = $1`, keySeasonal).Scan(&raw)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		s.seasonal, s.loaded = true, true
	case err != nil:
		if s.log != nil {
			s.log.Warn("app settings: read failed", "err", err)
		}
		return true
	default:
		v := seasonalValue{Enabled: true}
		_ = json.Unmarshal(raw, &v)
		s.seasonal, s.loaded = v.Enabled, true
	}
	return s.seasonal
}

// SetSeasonalEnabled stores the global switch.
func (s *Store) SetSeasonalEnabled(ctx context.Context, enabled bool, by string) error {
	if err := s.put(ctx, keySeasonal, seasonalValue{Enabled: enabled}, by); err != nil {
		return err
	}
	s.mu.Lock()
	s.seasonal, s.loaded = enabled, true
	s.mu.Unlock()
	return nil
}

// AITemperature returns the admin's temperatures (defaults when unset;
// a database error also answers the defaults and is retried next call).
// Missing or out-of-range fields fall back to the default.
func (s *Store) AITemperature(ctx context.Context) AITemperature {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tempLoaded {
		return s.temp
	}
	var raw []byte
	err := s.q.QueryRow(ctx, `SELECT value FROM app_settings WHERE key = $1`, keyAITemperature).Scan(&raw)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		s.temp, s.tempLoaded = DefaultAITemperature(), true
	case err != nil:
		if s.log != nil {
			s.log.Warn("app settings: read failed", "err", err)
		}
		return DefaultAITemperature()
	default:
		var v map[string]float64
		_ = json.Unmarshal(raw, &v)
		pick := func(k string, def float64) float64 {
			if t, ok := v[k]; ok && ValidTemperature(t) {
				return t
			}
			return def
		}
		s.temp = AITemperature{Collections: pick("collections", TemperatureDefault), Ask: pick("ask", TemperatureDefault),
			Music: pick("music", TemperatureDefault), Facts: pick("facts", FactsTemperatureDefault)}
		s.tempLoaded = true
	}
	return s.temp
}

// SetAITemperature stores the temperatures (callers validate the range).
func (s *Store) SetAITemperature(ctx context.Context, t AITemperature, by string) error {
	if err := s.put(ctx, keyAITemperature, t, by); err != nil {
		return err
	}
	s.mu.Lock()
	s.temp, s.tempLoaded = t, true
	s.mu.Unlock()
	return nil
}

// FactsAIEnabled reports whether DeepSeek may write «Факты» for titles
// Kinopoisk has none for (default true; a database error also answers
// true and is retried on the next call).
func (s *Store) FactsAIEnabled(ctx context.Context) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.factsAILoaded {
		return s.factsAI
	}
	var raw []byte
	err := s.q.QueryRow(ctx, `SELECT value FROM app_settings WHERE key = $1`, keyFactsAI).Scan(&raw)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		s.factsAI, s.factsAILoaded = true, true
	case err != nil:
		if s.log != nil {
			s.log.Warn("app settings: read failed", "err", err)
		}
		return true
	default:
		v := seasonalValue{Enabled: true}
		_ = json.Unmarshal(raw, &v)
		s.factsAI, s.factsAILoaded = v.Enabled, true
	}
	return s.factsAI
}

// SetFactsAIEnabled stores the AI «Факты» switch.
func (s *Store) SetFactsAIEnabled(ctx context.Context, enabled bool, by string) error {
	if err := s.put(ctx, keyFactsAI, seasonalValue{Enabled: enabled}, by); err != nil {
		return err
	}
	s.mu.Lock()
	s.factsAI, s.factsAILoaded = enabled, true
	s.mu.Unlock()
	return nil
}

func (s *Store) put(ctx context.Context, key string, value any, by string) error {
	b, _ := json.Marshal(value)
	var who any
	if by != "" {
		who = by
	}
	_, err := s.q.Exec(ctx, `
		INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
		key, string(b), who)
	return err
}

// Appearance is the admin view: GET/PUT /admin/appearance.
type Appearance struct {
	SeasonalEffects *bool `json:"seasonal_effects"`
}

// AdminRoutes registers /admin/appearance on the admin group.
func (s *Store) AdminRoutes(admin fiber.Router) {
	admin.Get("/appearance", func(c fiber.Ctx) error {
		on := s.SeasonalEnabled(c.Context())
		return c.JSON(Appearance{SeasonalEffects: &on})
	})
	admin.Put("/appearance", func(c fiber.Ctx) error {
		var in Appearance
		if err := httpx.BindJSON(c, &in); err != nil {
			return err
		}
		if in.SeasonalEffects == nil {
			return httpx.Validation(map[string]string{"seasonal_effects": "required (true or false)"})
		}
		p := auth.PrincipalFrom(c)
		if err := s.SetSeasonalEnabled(c.Context(), *in.SeasonalEffects, p.UserID); err != nil {
			return err
		}
		if s.audit != nil {
			s.audit.Record(c.Context(), audit.Event{UserID: p.UserID, Action: "appearance.updated", TargetType: "app_settings", TargetID: keySeasonal,
				IP: c.IP(), RequestID: httpx.RequestID(c), Metadata: map[string]any{"seasonal_effects": *in.SeasonalEffects}})
		}
		on := *in.SeasonalEffects
		return c.JSON(Appearance{SeasonalEffects: &on})
	})
}

// Creativity is the viewer's nudge on the admin's temperature
// («Точнее / Обычно / Смелее»).
var Creativity = map[string]float64{"precise": -0.4, "normal": 0, "bold": 0.4}

// WithCreativity applies a viewer's creativity ("" = normal) to an admin
// temperature; ok is false for an unknown value.
func WithCreativity(base float64, creativity string) (float64, bool) {
	if creativity == "" {
		creativity = "normal"
	}
	off, ok := Creativity[creativity]
	if !ok {
		return base, false
	}
	return ClampTemperature(base + off), true
}
