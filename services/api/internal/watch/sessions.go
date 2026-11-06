package watch

import (
	"context"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"martytv/api/internal/auth"
	"martytv/api/internal/db"
)

type StartInput struct {
	ProfileID string  `json:"profile_id"`
	MediaID   string  `json:"media_id"`
	EpisodeID *string `json:"episode_id"`
	SourceID  *string `json:"source_id"`
}

type StartResult struct {
	ID                    string         `json:"id"`
	ResumePositionSeconds *float64       `json:"resume_position_seconds"`
	Progress              *WatchProgress `json:"progress"`
	// ReportToken authenticates progress reports sent with
	// navigator.sendBeacon: POST .../progress?token=<report_token>.
	ReportToken string `json:"report_token"`
}

func isUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil && len(s) == 36
}

// StartSession opens a playback session. Nothing is written to progress yet.
func (s *Service) StartSession(ctx context.Context, p *auth.Principal, in StartInput) (*StartResult, error) {
	f := validationError{}
	if !isUUID(in.ProfileID) {
		f["profile_id"] = "required (UUID)"
	}
	if !isUUID(in.MediaID) {
		f["media_id"] = "required (UUID)"
	}
	if in.EpisodeID != nil && !isUUID(*in.EpisodeID) {
		f["episode_id"] = "must be a UUID"
	}
	if in.SourceID != nil && !isUUID(*in.SourceID) {
		f["source_id"] = "must be a UUID"
	}
	if len(f) > 0 {
		return nil, f
	}
	if ok, err := s.profiles.CanUse(ctx, p, in.ProfileID); err != nil {
		return nil, err
	} else if !ok {
		return nil, ErrNotFound
	}
	kind, err := s.mediaKind(ctx, in.MediaID)
	if err != nil {
		return nil, err
	}
	if err := s.checkEpisode(ctx, kind, in.MediaID, in.EpisodeID); err != nil {
		return nil, err
	}
	if in.SourceID != nil {
		var ok bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM playback_sources WHERE id = $1 AND media_id = $2)`,
			*in.SourceID, in.MediaID).Scan(&ok); err != nil {
			return nil, err
		}
		if !ok {
			return nil, validationError{"source_id": "unknown source for this title"}
		}
	}
	var deviceID *string
	if p.Kind == auth.KindDevice {
		deviceID = &p.DeviceID
	}
	var id string
	var started time.Time
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO playback_sessions (profile_id, user_id, device_id, media_id, episode_id, source_id)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, started_at`,
		in.ProfileID, p.UserID, deviceID, in.MediaID, in.EpisodeID, in.SourceID).Scan(&id, &started); err != nil {
		return nil, err
	}
	prog, err := getProgress(ctx, s.pool, in.ProfileID, in.MediaID, in.EpisodeID, false)
	if err != nil {
		return nil, err
	}
	res := &StartResult{ID: id, Progress: prog, ReportToken: s.reportToken(id, started.Add(reportTokenTTL))}
	if prog != nil && prog.resumable {
		pos := prog.PositionSeconds
		res.ResumePositionSeconds = &pos
	}
	return res, nil
}

func (s *Service) mediaKind(ctx context.Context, mediaID string) (string, error) {
	var kind string
	err := s.pool.QueryRow(ctx, `SELECT kind FROM media WHERE id = $1`, mediaID).Scan(&kind)
	if db.IsNoRows(err) {
		return "", ErrNotFound
	}
	return kind, err
}

// checkEpisode: series need an episode of that series; movies must not have one.
func (s *Service) checkEpisode(ctx context.Context, kind, mediaID string, episodeID *string) error {
	if kind == "movie" {
		if episodeID != nil {
			return validationError{"episode_id": "movies have no episodes"}
		}
		return nil
	}
	if episodeID == nil {
		return validationError{"episode_id": "required for series"}
	}
	var ok bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM episodes WHERE id = $1 AND media_id = $2)`,
		*episodeID, mediaID).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return validationError{"episode_id": "unknown episode for this series"}
	}
	return nil
}

// ---- reports ----

type ReportInput struct {
	Seq             *int64   `json:"seq"`
	PositionSeconds *float64 `json:"position_seconds"`
	DurationSeconds *float64 `json:"duration_seconds"`
	State           string   `json:"state"`
}

type ReportResult struct {
	Accepted bool           `json:"accepted"`
	Reason   string         `json:"reason,omitempty"`
	Progress *WatchProgress `json:"progress"`
}

const (
	ReasonStaleSequence = "stale_sequence"
	ReasonStaleSession  = "stale_session"
	ReasonTooEarly      = "too_early"
)

// Reporter identifies who sends a report: a verified report token, or a principal.
type Reporter struct {
	Principal *auth.Principal
	Token     string
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

func (in *ReportInput) validate() validationError {
	f := validationError{}
	if in.Seq == nil || *in.Seq < 0 {
		f["seq"] = "required, >= 0"
	}
	if in.PositionSeconds == nil || *in.PositionSeconds < 0 || !finite(*in.PositionSeconds) || *in.PositionSeconds > 1e6 {
		f["position_seconds"] = "required, >= 0"
	}
	if d := in.DurationSeconds; d != nil && (*d < 0 || !finite(*d) || *d > 1e6) {
		f["duration_seconds"] = "must be >= 0"
	}
	switch in.State {
	case "playing", "paused", "seeking", "ended", "stopped":
	default:
		f["state"] = "must be playing, paused, seeking, ended or stopped"
	}
	return f
}

type sessionRow struct {
	id, profileID, userID, mediaID, kind string
	deviceID, episodeID                  *string
	startedAt                            time.Time
	lastSeq                              int64
	lastPosition                         float64
	lastEventAt                          *time.Time
}

// Report applies one progress report. All rules run in one transaction with
// the session row locked, so concurrent reports of a session serialize.
func (s *Service) Report(ctx context.Context, sessionID string, who Reporter, in ReportInput) (*ReportResult, error) {
	if f := in.validate(); len(f) > 0 {
		return nil, f
	}
	if who.Token != "" {
		if err := s.verifyToken(sessionID, who.Token); err != nil {
			return nil, err
		}
	}
	var out *ReportResult
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		var r *ReportResult
		var err error
		r, err = s.report(ctx, tx, sessionID, who, in)
		out = r
		return err
	})
	return out, err
}

func (s *Service) report(ctx context.Context, tx pgx.Tx, sessionID string, who Reporter, in ReportInput) (*ReportResult, error) {
	var ss sessionRow
	err := tx.QueryRow(ctx, `
		SELECT s.id, s.profile_id, s.user_id, s.media_id, m.kind, s.device_id, s.episode_id, s.started_at, s.last_seq, s.last_position, s.last_event_at
		FROM playback_sessions s JOIN media m ON m.id = s.media_id
		WHERE s.id = $1 FOR UPDATE OF s`, sessionID).Scan(
		&ss.id, &ss.profileID, &ss.userID, &ss.mediaID, &ss.kind, &ss.deviceID, &ss.episodeID, &ss.startedAt, &ss.lastSeq, &ss.lastPosition, &ss.lastEventAt)
	if db.IsNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	// Only the session's creator may report: the same TV, or the same
	// account from a non-TV client. A valid report token stands in for both.
	if who.Token == "" {
		p := who.Principal
		switch {
		case p == nil:
			return nil, ErrNotFound
		case ss.deviceID != nil:
			if p.Kind != auth.KindDevice || p.DeviceID != *ss.deviceID {
				return nil, ErrNotFound
			}
		default:
			if p.Kind == auth.KindDevice || p.UserID != ss.userID {
				return nil, ErrNotFound
			}
		}
	}

	seq, pos, state := *in.Seq, *in.PositionSeconds, in.State
	cur, err := getProgress(ctx, tx, ss.profileID, ss.mediaID, ss.episodeID, true)
	if err != nil {
		return nil, err
	}
	if seq <= ss.lastSeq {
		return &ReportResult{Reason: ReasonStaleSequence, Progress: cur}, nil
	}
	dur := in.DurationSeconds
	if dur != nil && *dur <= 0 {
		dur = nil
	}
	if dur != nil && pos > *dur {
		pos = *dur
	}
	if _, err := tx.Exec(ctx, `
		UPDATE playback_sessions SET last_seq = $2, last_position = $3, last_duration = $4, last_state = $5,
			updated_at = now(), ended_at = CASE WHEN $5 IN ('ended', 'stopped') THEN now() ELSE NULL END
		WHERE id = $1`, ss.id, seq, pos, dur, state); err != nil {
		return nil, err
	}

	// Stale session: the newest session for the item wins. This one is stale
	// if the progress row was last written by a session that started later,
	// or a later session for the same item has already reported (it is
	// actually playing; a session that was merely opened does not count).
	if cur != nil && cur.lastSessionID != nil && *cur.lastSessionID != ss.id &&
		cur.lastSessionStartedAt != nil && cur.lastSessionStartedAt.After(ss.startedAt) {
		return &ReportResult{Reason: ReasonStaleSession, Progress: cur}, nil
	}
	var newer bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM playback_sessions
			WHERE profile_id = $1 AND media_id = $2 AND episode_id IS NOT DISTINCT FROM $3::uuid
			  AND id <> $4 AND started_at > $5 AND last_seq >= 0)`,
		ss.profileID, ss.mediaID, ss.episodeID, ss.id, ss.startedAt).Scan(&newer); err != nil {
		return nil, err
	}
	if newer {
		return &ReportResult{Reason: ReasonStaleSession, Progress: cur}, nil
	}

	// Opening is not watching: no progress row until a meaningful position.
	if cur == nil && pos < MinWatchSeconds {
		return &ReportResult{Reason: ReasonTooEarly}, nil
	}
	// A session that never got past the opening seconds (a source that
	// failed before seeking to the resume point, a quick peek) must not wipe
	// a saved resume position.
	if cur != nil && cur.resumable && pos < MinWatchSeconds && ss.lastPosition < MinWatchSeconds && state != "ended" {
		return &ReportResult{Reason: ReasonTooEarly, Progress: cur}, nil
	}
	if dur == nil && cur != nil {
		dur = cur.DurationSeconds
	}
	isEpisode := ss.episodeID != nil
	posAtEnd := atEnd(pos, dur, isEpisode)
	// Seeking never completes (scrubbing past the end isn't watching it).
	completes := state == "ended" || (state != "seeking" && posAtEnd)
	resumable := pos >= MinWatchSeconds && !posAtEnd && state != "ended"
	completed, manual := completes, false
	var completedAt *time.Time
	if cur != nil {
		completed = cur.Completed || completes
		completedAt = cur.CompletedAt
		manual = cur.manual && !(completes && !cur.Completed)
	}
	now := s.now().UTC()
	if completed && completedAt == nil {
		completedAt = &now
	}
	prog, err := scanProgress(tx.QueryRow(ctx, `
		WITH up AS (
			INSERT INTO watch_progress AS wp (profile_id, media_id, episode_id, position_seconds, duration_seconds, percent,
				completed, completed_at, manual, resumable, last_session_id, last_session_started_at, device_id, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
			ON CONFLICT ON CONSTRAINT watch_progress_item_key DO UPDATE SET
				position_seconds = EXCLUDED.position_seconds, duration_seconds = EXCLUDED.duration_seconds,
				percent = EXCLUDED.percent, completed = EXCLUDED.completed, completed_at = EXCLUDED.completed_at,
				manual = EXCLUDED.manual, resumable = EXCLUDED.resumable, last_session_id = EXCLUDED.last_session_id,
				last_session_started_at = EXCLUDED.last_session_started_at, device_id = EXCLUDED.device_id,
				updated_at = now()
			RETURNING *
		)
		SELECT `+progressCols+` FROM up wp LEFT JOIN episodes e ON e.id = wp.episode_id`,
		ss.profileID, ss.mediaID, ss.episodeID, pos, dur, percentOf(pos, dur),
		completed, completedAt, manual, resumable, ss.id, ss.startedAt, ss.deviceID))
	if err != nil {
		return nil, err
	}

	periodic := state == "playing" || state == "seeking"
	if !periodic || ss.lastEventAt == nil || now.Sub(*ss.lastEventAt) >= eventThrottle {
		if _, err := tx.Exec(ctx, `
			WITH ev AS (
				INSERT INTO watch_events (profile_id, session_id, media_id, episode_id, device_id, state, position, duration, seq)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			)
			UPDATE playback_sessions SET last_event_at = now() WHERE id = $2`,
			ss.profileID, ss.id, ss.mediaID, ss.episodeID, ss.deviceID, state, pos, dur, seq); err != nil {
			return nil, err
		}
	}
	return &ReportResult{Accepted: true, Progress: prog}, nil
}
