package watch

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"log/slog"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/catalog"
	"martytv/api/internal/db"
	"martytv/api/internal/profiles"
)

var (
	ErrNotFound = errors.New("watch: not found")
	errBadToken = errors.New("watch: invalid report token")
)

// validationError carries 422 field messages out of the service.
type validationError map[string]string

func (v validationError) Error() string { return "validation failed" }

type Service struct {
	pool     *pgxpool.Pool
	profiles *profiles.Store
	catalog  *catalog.Service
	log      *slog.Logger
	tokenKey []byte
	now      func() time.Time
	ne       newEpisodesState // «Новые серии» (newepisodes.go)
}

func NewService(pool *pgxpool.Pool, prof *profiles.Store, cat *catalog.Service, secret []byte, log *slog.Logger) *Service {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte("martytv/watch/report-token/v1"))
	return &Service{pool: pool, profiles: prof, catalog: cat, log: log, tokenKey: m.Sum(nil), now: time.Now}
}

// ---- report tokens ----
//
// A report token lets navigator.sendBeacon (which cannot set headers) report
// progress for exactly one session:
//
//	base64url( expiry unix seconds (8, big endian) | HMAC-SHA256(key, session uuid | expiry)[:16] )

func (s *Service) reportToken(sessionID string, exp time.Time) string {
	buf := binary.BigEndian.AppendUint64(nil, uint64(exp.Unix()))
	return base64.RawURLEncoding.EncodeToString(append(buf, s.tokenMAC(sessionID, buf)...))
}

func (s *Service) tokenMAC(sessionID string, exp []byte) []byte {
	m := hmac.New(sha256.New, s.tokenKey)
	m.Write([]byte(sessionID))
	m.Write(exp)
	return m.Sum(nil)[:16]
}

func (s *Service) verifyToken(sessionID, token string) error {
	if len(token) > 64 {
		return errBadToken
	}
	b, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(b) != 24 {
		return errBadToken
	}
	if !hmac.Equal(b[8:], s.tokenMAC(sessionID, b[:8])) {
		return errBadToken
	}
	if s.now().Unix() > int64(binary.BigEndian.Uint64(b[:8])) {
		return errBadToken
	}
	return nil
}

// ---- progress rows ----

const progressCols = `wp.id, wp.profile_id, wp.media_id, wp.episode_id, e.season_number, e.episode_number,
	wp.position_seconds, wp.duration_seconds, wp.percent, wp.completed, wp.completed_at, wp.updated_at,
	wp.device_id, wp.resumable, wp.manual, wp.last_session_id, wp.last_session_started_at,
	(SELECT ps.source_id FROM playback_sessions ps WHERE ps.id = wp.last_session_id)`

const progressFrom = ` FROM watch_progress wp LEFT JOIN episodes e ON e.id = wp.episode_id `

func scanProgress(row pgx.Row) (*WatchProgress, error) {
	var p WatchProgress
	err := row.Scan(&p.id, &p.profileID, &p.MediaID, &p.EpisodeID, &p.SeasonNumber, &p.EpisodeNumber,
		&p.PositionSeconds, &p.DurationSeconds, &p.Percent, &p.Completed, &p.CompletedAt, &p.UpdatedAt,
		&p.DeviceID, &p.resumable, &p.manual, &p.lastSessionID, &p.lastSessionStartedAt, &p.SourceID)
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func queryProgress(ctx context.Context, q db.Querier, sql string, args ...any) ([]WatchProgress, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WatchProgress
	for rows.Next() {
		p, err := scanProgress(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

func getProgress(ctx context.Context, q db.Querier, profileID, mediaID string, episodeID *string, lock bool) (*WatchProgress, error) {
	sql := `SELECT ` + progressCols + progressFrom +
		`WHERE wp.profile_id = $1 AND wp.media_id = $2 AND wp.episode_id IS NOT DISTINCT FROM $3::uuid`
	if lock {
		sql += ` FOR UPDATE OF wp`
	}
	return scanProgress(q.QueryRow(ctx, sql, profileID, mediaID, episodeID))
}

// ---- completion rules ----

// atEnd reports whether a position counts as "finished" for an item.
func atEnd(position float64, duration *float64, isEpisode bool) bool {
	if duration == nil || *duration <= 0 {
		return false
	}
	d := *duration
	if position/d >= CompletePercent {
		return true
	}
	tail := movieTailSeconds
	if isEpisode {
		tail = episodeTailSeconds
	}
	return d >= minDurationForTail && d-position <= tail
}

func percentOf(position float64, duration *float64) float64 {
	if duration == nil || *duration <= 0 {
		return 0
	}
	return math.Min(math.Max(position / *duration, 0), 1)
}

// ---- cleanup ----

// Cleanup prunes old watch events and finished/idle sessions. Progress rows
// keep the session start time, so the stale-session rule survives pruning.
func (s *Service) Cleanup(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM watch_events WHERE created_at < now() - $1::interval`, eventRetention); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM playback_sessions WHERE updated_at < now() - $1::interval`, sessionRetention)
	return err
}
