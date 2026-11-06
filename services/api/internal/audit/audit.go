// Package audit records security-relevant events (logins, pairing, revocations).
package audit

import (
	"context"
	"encoding/json"
	"log/slog"

	"martytv/api/internal/db"
)

type Event struct {
	UserID     string
	DeviceID   string
	Action     string
	TargetType string
	TargetID   string
	IP         string
	RequestID  string
	Metadata   map[string]any
}

type Logger struct {
	q   db.Querier
	log *slog.Logger
}

func New(q db.Querier, log *slog.Logger) *Logger { return &Logger{q: q, log: log} }

// Record stores an audit event. Failures are logged but never fail the request.
func (l *Logger) Record(ctx context.Context, e Event) {
	meta := []byte("{}")
	if len(e.Metadata) > 0 {
		if b, err := json.Marshal(e.Metadata); err == nil {
			meta = b
		}
	}
	_, err := l.q.Exec(ctx, `
		INSERT INTO audit_events (user_id, device_id, action, target_type, target_id, ip, request_id, metadata)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		nullUUID(e.UserID), nullUUID(e.DeviceID), e.Action, e.TargetType, e.TargetID, e.IP, e.RequestID, meta)
	if err != nil {
		l.log.WarnContext(ctx, "audit write failed", "action", e.Action, "err", err)
	}
}

func nullUUID(s string) any {
	if s == "" {
		return nil
	}
	return s
}
