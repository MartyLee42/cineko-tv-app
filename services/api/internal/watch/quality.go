package watch

import (
	"context"
	"encoding/json"
	"math"
	"time"
)

// Playback quality telemetry. Players add running totals to some progress
// reports, so it costs no extra request; a bad or failed sample is dropped
// and never touches the progress report it came with.

const (
	qualityWriteTimeout = 2 * time.Second
	qualityKeepDays     = 180
	qualityMaxDays      = 90
	qualityWorstRows    = 20
	// A session shorter than this says little about quality.
	qualityMinWatchS = 30
)

// QualitySample is the "quality" object of a progress report.
type QualitySample struct {
	App            string `json:"app"`
	Engine         string `json:"engine"`
	StartupMS      *int64 `json:"startup_ms"`
	WatchedS       int64  `json:"watched_s"`
	Stalls         int64  `json:"stalls"`
	StallMS        int64  `json:"stall_ms"`
	LongestStallMS int64  `json:"longest_stall_ms"`
	Seeks          int64  `json:"seeks"`
	SeekWaitMS     int64  `json:"seek_wait_ms"`
	DroppedFrames  int64  `json:"dropped_frames"`
	TotalFrames    int64  `json:"total_frames"`
	Width          *int64 `json:"width"`
	Height         *int64 `json:"height"`
	Errors         int64  `json:"errors"`
}

func clampInt(v, hi int64) int64 { return max(0, min(v, hi)) }

func clampOpt(v *int64, hi int64) *int64 {
	if v == nil || *v <= 0 {
		return nil
	}
	c := min(*v, hi)
	return &c
}

// parseQuality decodes and bounds a sample; nil when it is unusable.
func parseQuality(raw json.RawMessage) *QualitySample {
	if len(raw) == 0 {
		return nil
	}
	var q QualitySample
	if json.Unmarshal(raw, &q) != nil || (q.App != "tv" && q.App != "web") {
		return nil
	}
	const day = int64(86_400)
	const dayMS = day * 1000
	if len(q.Engine) > 16 {
		q.Engine = q.Engine[:16]
	}
	q.StartupMS = clampOpt(q.StartupMS, 3_600_000)
	q.WatchedS = clampInt(q.WatchedS, day)
	q.Stalls = clampInt(q.Stalls, 100_000)
	q.StallMS = clampInt(q.StallMS, dayMS)
	q.LongestStallMS = clampInt(q.LongestStallMS, min(q.StallMS, math.MaxInt32))
	q.Seeks = clampInt(q.Seeks, 100_000)
	q.SeekWaitMS = clampInt(q.SeekWaitMS, dayMS)
	q.TotalFrames = clampInt(q.TotalFrames, 100_000_000)
	q.DroppedFrames = clampInt(q.DroppedFrames, q.TotalFrames)
	q.Width, q.Height = clampOpt(q.Width, 16_000), clampOpt(q.Height, 16_000)
	q.Errors = clampInt(q.Errors, 100_000)
	return &q
}

// saveQuality stores the session's latest totals; failures are only logged.
func (s *Service) saveQuality(ctx context.Context, sessionID, state string, q *QualitySample) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), qualityWriteTimeout)
	defer cancel()
	final := state == "ended" || state == "stopped"
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO playback_quality (session_id, app, engine, startup_ms, watched_s, stalls, stall_ms,
			longest_stall_ms, seeks, seek_wait_ms, dropped_frames, total_frames, width, height, errors, final)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
		ON CONFLICT (session_id) DO UPDATE SET app = EXCLUDED.app, engine = EXCLUDED.engine,
			startup_ms = EXCLUDED.startup_ms, watched_s = EXCLUDED.watched_s, stalls = EXCLUDED.stalls,
			stall_ms = EXCLUDED.stall_ms, longest_stall_ms = EXCLUDED.longest_stall_ms, seeks = EXCLUDED.seeks,
			seek_wait_ms = EXCLUDED.seek_wait_ms, dropped_frames = EXCLUDED.dropped_frames,
			total_frames = EXCLUDED.total_frames, width = EXCLUDED.width, height = EXCLUDED.height,
			errors = EXCLUDED.errors, final = EXCLUDED.final, updated_at = now()`,
		sessionID, q.App, q.Engine, q.StartupMS, q.WatchedS, q.Stalls, q.StallMS, q.LongestStallMS, q.Seeks,
		q.SeekWaitMS, q.DroppedFrames, q.TotalFrames, q.Width, q.Height, q.Errors, final); err != nil {
		s.log.Warn("playback quality not saved", "err", err)
		return
	}
	if final {
		if _, err := s.pool.Exec(ctx, `DELETE FROM playback_quality WHERE updated_at < now() - make_interval(days => $1)`, qualityKeepDays); err != nil {
			s.log.Warn("playback quality cleanup failed", "err", err)
		}
	}
}

// QualityGroup is one line of the admin summary.
type QualityGroup struct {
	App          string   `json:"app"`
	SourceKind   string   `json:"source_kind"`
	Sessions     int      `json:"sessions"`
	WatchedS     int64    `json:"watched_s"`
	SmoothPct    float64  `json:"smooth_pct"`
	StallsPerH   float64  `json:"stalls_per_hour"`
	StallPct     float64  `json:"stall_pct"`
	DroppedPct   *float64 `json:"dropped_pct"`
	MedianStartS *float64 `json:"median_startup_s"`
}

// QualitySession is one session in the «worst lately» list.
type QualitySession struct {
	ID            string    `json:"id"`
	UpdatedAt     time.Time `json:"updated_at"`
	Title         string    `json:"title"`
	Device        *string   `json:"device"`
	App           string    `json:"app"`
	Engine        string    `json:"engine"`
	SourceKind    string    `json:"source_kind"`
	Provider      *string   `json:"provider"`
	Height        *int      `json:"height"`
	WatchedS      int64     `json:"watched_s"`
	Stalls        int       `json:"stalls"`
	StallS        float64   `json:"stall_s"`
	LongestStallS float64   `json:"longest_stall_s"`
	DroppedPct    *float64  `json:"dropped_pct"`
	StartupS      *float64  `json:"startup_s"`
	Errors        int       `json:"errors"`
}

// QualityReport is GET /admin/playback-quality.
type QualityReport struct {
	Days   int              `json:"days"`
	Groups []QualityGroup   `json:"groups"`
	Worst  []QualitySession `json:"worst"`
}

const qualityBase = `
	FROM playback_quality q
	JOIN playback_sessions s ON s.id = q.session_id
	LEFT JOIN playback_sources ps ON ps.id = s.source_id`

const qualityKind = `COALESCE(NULLIF(ps.release->'provider'->>'kind', ''), 'other')`

// QualityReport summarises the last days: per app and source kind, and the
// sessions that played worst.
func (s *Service) QualityReport(ctx context.Context, days int, lang string) (*QualityReport, error) {
	days = max(1, min(days, qualityMaxDays))
	out := &QualityReport{Days: days, Groups: []QualityGroup{}, Worst: []QualitySession{}}
	rows, err := s.pool.Query(ctx, `
		SELECT q.app, `+qualityKind+` AS kind, count(*)::int, COALESCE(sum(q.watched_s), 0)::bigint,
			(100.0 * count(*) FILTER (WHERE q.stalls = 0) / count(*))::float8,
			(COALESCE(sum(q.stalls), 0) * 3600.0 / GREATEST(sum(q.watched_s), 1))::float8,
			(COALESCE(sum(q.stall_ms), 0) / 10.0 / GREATEST(sum(q.watched_s) + sum(q.stall_ms) / 1000.0, 1))::float8,
			(100.0 * sum(q.dropped_frames) / NULLIF(sum(q.total_frames), 0))::float8,
			(percentile_cont(0.5) WITHIN GROUP (ORDER BY q.startup_ms) / 1000.0)::float8
		`+qualityBase+`
		WHERE q.updated_at > now() - make_interval(days => $1) AND q.watched_s >= $2
		GROUP BY 1, 2 ORDER BY 4 DESC`, days, qualityMinWatchS)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var g QualityGroup
		if err := rows.Scan(&g.App, &g.SourceKind, &g.Sessions, &g.WatchedS, &g.SmoothPct, &g.StallsPerH,
			&g.StallPct, &g.DroppedPct, &g.MedianStartS); err != nil {
			return nil, err
		}
		out.Groups = append(out.Groups, g)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	worst, err := s.pool.Query(ctx, `
		SELECT q.session_id, q.updated_at,
			COALESCE(NULLIF(m.translations -> $3::text ->> 'title', ''), NULLIF(m.translations -> 'en' ->> 'title', ''), m.original_title, ''),
			d.name, q.app, q.engine, `+qualityKind+`, ps.release->'provider'->>'id', q.height, q.watched_s, q.stalls,
			(q.stall_ms / 1000.0)::float8, (q.longest_stall_ms / 1000.0)::float8,
			(100.0 * q.dropped_frames / NULLIF(q.total_frames, 0))::float8, (q.startup_ms / 1000.0)::float8, q.errors
		`+qualityBase+`
		JOIN media m ON m.id = s.media_id
		LEFT JOIN devices d ON d.id = s.device_id
		WHERE q.updated_at > now() - make_interval(days => $1) AND q.watched_s >= $2
		  AND (q.stalls > 0 OR q.errors > 0 OR q.dropped_frames * 50 > q.total_frames)
		ORDER BY q.stall_ms * 3600.0 / GREATEST(q.watched_s, 60) DESC, q.errors DESC, q.updated_at DESC
		LIMIT $4`, days, qualityMinWatchS, lang, qualityWorstRows)
	if err != nil {
		return nil, err
	}
	defer worst.Close()
	for worst.Next() {
		var r QualitySession
		if err := worst.Scan(&r.ID, &r.UpdatedAt, &r.Title, &r.Device, &r.App, &r.Engine, &r.SourceKind, &r.Provider,
			&r.Height, &r.WatchedS, &r.Stalls, &r.StallS, &r.LongestStallS, &r.DroppedPct, &r.StartupS, &r.Errors); err != nil {
			return nil, err
		}
		out.Worst = append(out.Worst, r)
	}
	return out, worst.Err()
}
