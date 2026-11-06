// Package clientlog stores errors reported by the web and TV clients (and
// the API's own 5xx responses) for the admin Errors tab. Identical errors
// share a group keyed by a fingerprint and count up; each group keeps its
// last few samples. Everything is scrubbed of secrets before it is stored.
package clientlog

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/httpx"
	"martytv/api/internal/realtime"
)

// Limits (bytes) for stored fields and the ingestion batch.
const (
	MaxBatchEvents  = 20
	MaxBatchBytes   = 64 << 10
	maxMessage      = 1 << 10
	maxStack        = 8 << 10
	maxExtra        = 2 << 10
	maxURL          = 512
	maxComponent    = 512
	maxRelease      = 64
	maxUserAgent    = 512
	maxDeviceModel  = 128
	maxCount        = 1000
	samplesPerGroup = 20
)

var (
	Apps  = []string{"web", "tv", "api"}
	Kinds = []string{"error", "unhandledrejection", "react", "api", "player", "console"}
)

// Event is one error occurrence after validation.
type Event struct {
	App         string
	Kind        string
	Message     string
	Stack       string
	URL         string
	Component   string
	Release     string
	UserAgent   string
	DeviceModel string
	Extra       json.RawMessage
	OccurredAt  time.Time
	Count       int
	RequestID   string
	ProfileID   string
}

// Who identifies the reporter (empty = unknown).
type Who struct {
	UserID   string
	DeviceID string
}

// Notifier pushes realtime events to browser sockets (the hub).
type Notifier interface {
	NotifyUsers(userIDs []string, env realtime.Envelope)
}

type Service struct {
	pool    *pgxpool.Pool
	log     *slog.Logger
	version string
	hub     Notifier
	// Per reporter (user or device) and global event budgets.
	perWho *httpx.RateLimiter
	global *httpx.RateLimiter
	// Bounds concurrent background records from the 5xx hook.
	inflight chan struct{}
	now      func() time.Time
}

func NewService(pool *pgxpool.Pool, version string, log *slog.Logger) *Service {
	return &Service{
		pool: pool, log: log, version: version,
		perWho:   httpx.NewRateLimiter(120, 10*time.Minute),
		global:   httpx.NewRateLimiter(2000, 10*time.Minute),
		inflight: make(chan struct{}, 4),
		now:      time.Now,
	}
}

// SetNotifier attaches the realtime hub (created after the service).
func (s *Service) SetNotifier(n Notifier) { s.hub = n }

// SetLimits replaces the rate limits (tests).
func (s *Service) SetLimits(perWho, global int, window time.Duration) {
	s.perWho = httpx.NewRateLimiter(perWho, window)
	s.global = httpx.NewRateLimiter(global, window)
}

// allow spends one event from the reporter's and the global budget.
func (s *Service) allow(key string) bool {
	if ok, _ := s.perWho.Allow(key); !ok {
		return false
	}
	ok, _ := s.global.Allow("all")
	return ok
}

// sanitize scrubs and truncates every field in place.
func (e *Event) sanitize(now time.Time) {
	e.Message = truncate(Scrub(strings.TrimSpace(e.Message)), maxMessage)
	if e.Message == "" {
		e.Message = "(no message)"
	}
	e.Stack = truncate(Scrub(e.Stack), maxStack)
	e.URL = truncate(ScrubURL(e.URL), maxURL)
	e.Component = truncate(Scrub(e.Component), maxComponent)
	e.Release = truncate(Scrub(e.Release), maxRelease)
	e.UserAgent = truncate(e.UserAgent, maxUserAgent)
	e.DeviceModel = truncate(e.DeviceModel, maxDeviceModel)
	e.RequestID = truncate(e.RequestID, 64)
	if len(e.Extra) > 0 {
		x := json.RawMessage(Scrub(string(e.Extra)))
		var obj map[string]any
		if len(e.Extra) > maxExtra || len(x) > maxExtra || json.Unmarshal(x, &obj) != nil || obj == nil {
			x = nil
		}
		e.Extra = x
	}
	if e.Count < 1 {
		e.Count = 1
	}
	if e.Count > maxCount {
		e.Count = maxCount
	}
	// Client clocks are unreliable: keep the reported time only if plausible.
	if e.OccurredAt.IsZero() || e.OccurredAt.After(now.Add(time.Minute)) || e.OccurredAt.Before(now.Add(-24*time.Hour)) {
		e.OccurredAt = now
	}
}

// record stores one sanitized event: upserts the group, adds a sample,
// prunes old samples, and notifies admins about new or regressed groups.
func (s *Service) record(ctx context.Context, e Event, who Who) error {
	frame := topFrame(e.Stack)
	key := frame
	if e.App == "api" {
		key = e.Component // the route identifies a server error
	}
	fp := Fingerprint(e.App, e.Kind, e.Message, key)

	var (
		groupID       string
		inserted, reg bool
	)
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `
			INSERT INTO client_error_groups AS g
			    (fingerprint, app, kind, message, top_frame, component, count, last_release, last_url)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (fingerprint) DO UPDATE SET
			    count        = g.count + EXCLUDED.count,
			    last_seen    = greatest(g.last_seen, now()),
			    last_release = CASE WHEN EXCLUDED.last_release <> '' THEN EXCLUDED.last_release ELSE g.last_release END,
			    last_url     = CASE WHEN EXCLUDED.last_url <> '' THEN EXCLUDED.last_url ELSE g.last_url END,
			    regressed_at = CASE WHEN g.resolved_at IS NOT NULL THEN now() ELSE g.regressed_at END,
			    resolved_at  = NULL,
			    resolved_by  = NULL
			RETURNING id, (xmax = 0), coalesce(regressed_at = now(), false)`,
			fp, e.App, e.Kind, e.Message, frame, e.Component, e.Count, e.Release, e.URL,
		).Scan(&groupID, &inserted, &reg)
		if err != nil {
			return err
		}
		var profile *string
		if e.ProfileID != "" && who.UserID != "" {
			profile = &e.ProfileID
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO client_error_samples
			    (group_id, occurred_at, count, user_id, device_id, profile_id, message, stack, url,
			     component, release, user_agent, device_model, extra, request_id)
			VALUES ($1, $2, $3, $4, $5,
			        (SELECT id FROM profiles WHERE id = $6::uuid AND user_id = $4::uuid),
			        $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
			groupID, e.OccurredAt, e.Count, nullable(who.UserID), nullable(who.DeviceID), profile,
			e.Message, e.Stack, e.URL, e.Component, e.Release, e.UserAgent, e.DeviceModel, nullJSON(e.Extra), e.RequestID)
		if err != nil {
			return err
		}
		for _, sub := range []struct{ kind, id string }{{"u", who.UserID}, {"d", who.DeviceID}} {
			if sub.id == "" {
				continue
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO client_error_affected (group_id, kind, subject_id) VALUES ($1, $2, $3)
				ON CONFLICT (group_id, kind, subject_id) DO UPDATE SET last_seen = now()`,
				groupID, sub.kind, sub.id); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `
			DELETE FROM client_error_samples
			WHERE group_id = $1 AND id < (
			    SELECT id FROM client_error_samples WHERE group_id = $1
			    ORDER BY id DESC OFFSET $2 LIMIT 1)`, groupID, samplesPerGroup-1)
		return err
	})
	if err != nil {
		return err
	}
	if inserted || reg {
		s.notifyAdmins(ctx, NewEvent{ID: groupID, App: e.App, Kind: e.Kind, Message: truncate(e.Message, 200), Regressed: reg})
	}
	return nil
}

// NewEvent is the realtime `client_error.new` payload.
type NewEvent struct {
	ID        string `json:"id"`
	App       string `json:"app"`
	Kind      string `json:"kind"`
	Message   string `json:"message"`
	Regressed bool   `json:"regressed"`
}

func (s *Service) notifyAdmins(ctx context.Context, ev NewEvent) {
	if s.hub == nil {
		return
	}
	rows, err := s.pool.Query(ctx, `SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND disabled_at IS NULL`)
	if err != nil {
		return
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil || len(ids) == 0 {
		return
	}
	payload, _ := json.Marshal(ev)
	s.hub.NotifyUsers(ids, realtime.Envelope{Type: "client_error.new", Payload: payload})
}

// Cleanup applies retention: samples after 30 days, groups unseen for 60.
func (s *Service) Cleanup(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM client_error_samples WHERE received_at < now() - interval '30 days'`); err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM client_error_affected WHERE last_seen < now() - interval '60 days'`); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM client_error_groups WHERE last_seen < now() - interval '60 days'`)
	return err
}

var errNotFound = errors.New("not found")

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func nullJSON(b json.RawMessage) any {
	if len(b) == 0 {
		return nil
	}
	return string(b)
}
