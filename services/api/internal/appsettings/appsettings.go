// Package appsettings holds server-wide switches set by admins (table
// app_settings, one JSON value per key). Today it has one: the global
// switch of the seasonal/holiday animations. Readers see it in GET /status
// (`seasonal_effects`); admins change it at /admin/appearance.
//
// The value is cached in memory (one API instance, see the architecture
// doc's assumptions), so /status never reads the database for it.
package appsettings

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"

	"martytv/api/internal/audit"
	"martytv/api/internal/auth"
	"martytv/api/internal/db"
	"martytv/api/internal/httpx"
)

const keySeasonal = "seasonal_effects"

// Store reads and writes app_settings.
type Store struct {
	q     db.Querier
	audit *audit.Logger
	log   *slog.Logger

	mu       sync.Mutex
	loaded   bool
	seasonal bool
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
	b, _ := json.Marshal(seasonalValue{Enabled: enabled})
	var who any
	if by != "" {
		who = by
	}
	_, err := s.q.Exec(ctx, `
		INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
		keySeasonal, string(b), who)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.seasonal, s.loaded = enabled, true
	s.mu.Unlock()
	return nil
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
