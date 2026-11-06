package devices

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"time"

	"github.com/gofiber/fiber/v3"

	"martytv/api/internal/auth"
	"martytv/api/internal/httpx"
)

// TV health («Состояние»): browsers can't read system CPU/RAM, so a TV
// reports the closest proxies it has — JS heap (performance.memory), the
// navigator.deviceMemory bucket and core count, frame rate and event-loop
// lag over a short sample, long tasks, and dropped video frames of the last
// playback session. Posted by the TV itself (≈2 min after start, then every
// 10 min, plus once after playback); owners and super_admins read it.

// HealthSample is contract DeviceHealthSample (every measurement optional:
// old engines lack most APIs).
type HealthSample struct {
	At             *time.Time `json:"at,omitempty"`
	Reason         string     `json:"reason"`
	UptimeS        *int64     `json:"uptime_s,omitempty"`
	Screen         *string    `json:"screen,omitempty"`
	Playing        *bool      `json:"playing,omitempty"`
	Model          *string    `json:"model,omitempty"`
	HeapUsedMB     *float64   `json:"heap_used_mb,omitempty"`
	HeapTotalMB    *float64   `json:"heap_total_mb,omitempty"`
	HeapLimitMB    *float64   `json:"heap_limit_mb,omitempty"`
	DeviceMemoryGB *float64   `json:"device_memory_gb,omitempty"`
	Cores          *int64     `json:"cores,omitempty"`
	FPS            *float64   `json:"fps,omitempty"`
	SlowFramesPct  *float64   `json:"slow_frames_pct,omitempty"`
	LagMS          *float64   `json:"lag_ms,omitempty"`
	LagMaxMS       *float64   `json:"lag_max_ms,omitempty"`
	LongTasks      *int64     `json:"long_tasks,omitempty"`
	LongTaskMS     *float64   `json:"long_task_ms,omitempty"`
	DroppedFrames  *int64     `json:"dropped_frames,omitempty"`
	TotalFrames    *int64     `json:"total_frames,omitempty"`
}

// DeviceHealth is contract DeviceHealth.
type DeviceHealth struct {
	Latest  *HealthSample  `json:"latest"`
	History []HealthSample `json:"history"`
}

const (
	// HealthHistory is how many samples are kept per device.
	HealthHistory = 50
	// HealthMinInterval is the per-device rate limit (1 post per interval).
	HealthMinInterval = time.Minute
	// MaxHealthBody bounds a health POST body.
	MaxHealthBody = 4 << 10
)

var screenRe = regexp.MustCompile(`^[a-z_]{0,24}$`)

func numRange(fields map[string]string, name string, v *float64, hi float64) {
	if v != nil && (math.IsNaN(*v) || math.IsInf(*v, 0) || *v < 0 || *v > hi) {
		fields[name] = "out of range"
	}
}

func int64Range(fields map[string]string, name string, v *int64, hi int64) {
	if v != nil && (*v < 0 || *v > hi) {
		fields[name] = "out of range"
	}
}

func round1(v *float64) {
	if v != nil {
		*v = math.Round(*v*10) / 10
	}
}

// Normalize validates a posted sample in place.
func (h *HealthSample) Normalize(fields map[string]string) {
	h.At = nil
	if h.Reason == "" {
		h.Reason = "periodic"
	}
	if h.Reason != "periodic" && h.Reason != "playback" {
		fields["reason"] = "must be periodic or playback"
	}
	if h.Screen != nil && !screenRe.MatchString(*h.Screen) {
		fields["screen"] = "must be a short screen id"
	}
	h.Model = clipStr(h.Model, 120)
	int64Range(fields, "uptime_s", h.UptimeS, 366*24*3600)
	numRange(fields, "heap_used_mb", h.HeapUsedMB, 65536)
	numRange(fields, "heap_total_mb", h.HeapTotalMB, 65536)
	numRange(fields, "heap_limit_mb", h.HeapLimitMB, 65536)
	numRange(fields, "device_memory_gb", h.DeviceMemoryGB, 1024)
	int64Range(fields, "cores", h.Cores, 1024)
	numRange(fields, "fps", h.FPS, 1000)
	numRange(fields, "slow_frames_pct", h.SlowFramesPct, 100)
	numRange(fields, "lag_ms", h.LagMS, 600_000)
	numRange(fields, "lag_max_ms", h.LagMaxMS, 600_000)
	int64Range(fields, "long_tasks", h.LongTasks, 1_000_000)
	numRange(fields, "long_task_ms", h.LongTaskMS, 1e9)
	int64Range(fields, "dropped_frames", h.DroppedFrames, 1e9)
	int64Range(fields, "total_frames", h.TotalFrames, 1e9)
	if h.DroppedFrames != nil && h.TotalFrames != nil && *h.DroppedFrames > *h.TotalFrames {
		fields["dropped_frames"] = "must not exceed total_frames"
	}
	for _, v := range []*float64{h.HeapUsedMB, h.HeapTotalMB, h.HeapLimitMB, h.FPS, h.SlowFramesPct, h.LagMS, h.LagMaxMS, h.LongTaskMS} {
		round1(v)
	}
}

// AddHealth stores a sample and drops the device's oldest beyond HealthHistory.
func (s *Store) AddHealth(ctx context.Context, deviceID string, h HealthSample) (*HealthSample, error) {
	h.At = nil
	raw, err := json.Marshal(h)
	if err != nil {
		return nil, err
	}
	var at time.Time
	if err := s.q.QueryRow(ctx, `INSERT INTO device_health_samples (device_id, sample) VALUES ($1, $2) RETURNING at`,
		deviceID, raw).Scan(&at); err != nil {
		return nil, err
	}
	if _, err := s.q.Exec(ctx, `
		DELETE FROM device_health_samples WHERE device_id = $1 AND id NOT IN (
			SELECT id FROM device_health_samples WHERE device_id = $1 ORDER BY id DESC LIMIT $2)`,
		deviceID, HealthHistory); err != nil {
		return nil, err
	}
	h.At = &at
	return &h, nil
}

// Health returns a device's samples, newest first.
func (s *Store) Health(ctx context.Context, deviceID string) (*DeviceHealth, error) {
	rows, err := s.q.Query(ctx, `SELECT at, sample FROM device_health_samples WHERE device_id = $1 ORDER BY id DESC LIMIT $2`,
		deviceID, HealthHistory)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &DeviceHealth{History: []HealthSample{}}
	for rows.Next() {
		var at time.Time
		var raw []byte
		if err := rows.Scan(&at, &raw); err != nil {
			return nil, err
		}
		var h HealthSample
		if err := json.Unmarshal(raw, &h); err != nil {
			continue
		}
		h.At = &at
		out.History = append(out.History, h)
	}
	if len(out.History) > 0 {
		out.Latest = &out.History[0]
	}
	return out, rows.Err()
}

// canReadHealth: the TV itself, its owner, any super_admin. Shared users,
// plain admins and strangers are treated as not found.
func (s *Store) canReadHealth(ctx context.Context, p *auth.Principal, deviceID string) error {
	if p.Kind == auth.KindDevice {
		if p.DeviceID != deviceID {
			return ErrNotFound
		}
		return nil
	}
	owner, err := s.ownerOf(ctx, deviceID)
	if err != nil {
		return err
	}
	if owner == p.UserID || p.HasScope(auth.ScopeAdmin) && p.IsSuperAdmin() {
		return nil
	}
	return ErrNotFound
}

// HealthRoutes registers GET/POST /devices/{id}/health ("me" = the calling TV).
func (h *Handlers) HealthRoutes(api fiber.Router) {
	api.Get("/devices/:id/health", requireUserOrDevice(), h.getHealth)
	api.Post("/devices/:id/health", auth.RequireDevice(), h.postHealth)
}

// healthID resolves :id; "me" only for a TV credential.
func healthID(c fiber.Ctx) (string, error) {
	if c.Params("id") == "me" {
		p := auth.PrincipalFrom(c)
		if p.Kind != auth.KindDevice {
			return "", httpx.NotFound()
		}
		return p.DeviceID, nil
	}
	return httpx.ParamUUID(c, "id")
}

func (h *Handlers) getHealth(c fiber.Ctx) error {
	id, err := healthID(c)
	if err != nil {
		return err
	}
	ctx := c.Context()
	if err := h.store.canReadHealth(ctx, auth.PrincipalFrom(c), id); errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	out, err := h.store.Health(ctx, id)
	if err != nil {
		return err
	}
	return c.JSON(out)
}

func (h *Handlers) postHealth(c fiber.Ctx) error {
	id, err := healthID(c)
	if err != nil {
		return err
	}
	p := auth.PrincipalFrom(c)
	if id != p.DeviceID {
		return httpx.NotFound()
	}
	if len(c.Body()) > MaxHealthBody {
		return httpx.NewError(fiber.StatusRequestEntityTooLarge, "payload_too_large", "Body is larger than 4 KB.")
	}
	var req HealthSample
	if err := httpx.BindJSON(c, &req); err != nil {
		return err
	}
	fields := map[string]string{}
	req.Normalize(fields)
	if len(fields) > 0 {
		return httpx.Validation(fields)
	}
	if ok, wait := h.healthLimit.Allow(id); !ok {
		return httpx.TooManyRequests(wait)
	}
	ctx := c.Context()
	if _, err := h.store.ownerOf(ctx, id); errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	} else if err != nil {
		return err
	}
	saved, err := h.store.AddHealth(ctx, id, req)
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(saved)
}
