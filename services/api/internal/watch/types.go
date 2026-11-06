// Package watch implements Phase 5 watch sync: playback sessions, progress
// reports with ordering/staleness protection, completion, manual overrides,
// series "next up", continue watching, history, watchlist/favorites/ratings,
// the profile-aware catalog hooks, and the admin activity views.
package watch

import (
	"time"

	"martytv/api/internal/catalog"
)

// Rules (see docs/architecture.md "Watch sync").
const (
	// MinWatchSeconds: nothing is recorded before this position (opening a
	// title is not watching it) and shorter positions are not resume points.
	MinWatchSeconds = 30.0
	// CompletePercent: at or beyond this share an item is complete.
	CompletePercent = 0.9
	// Remaining-time rule (only for items of at least minDurationForTail).
	movieTailSeconds   = 180.0
	episodeTailSeconds = 90.0
	minDurationForTail = 600.0
	// Periodic ("playing"/"seeking") events are stored at most this often per session.
	eventThrottle = 10 * time.Second
	// Continue watching looks back this far and returns at most continueMax items.
	continueWindow = 90 * 24 * time.Hour
	continueMax    = 30
	listPageSize   = 20
	// Retention.
	eventRetention   = 400 * 24 * time.Hour
	sessionRetention = 30 * 24 * time.Hour
	// Report tokens (sendBeacon without headers) are valid this long after a session starts.
	reportTokenTTL = 24 * time.Hour
)

// WatchProgress is the contract's WatchProgress.
type WatchProgress struct {
	MediaID         string     `json:"media_id"`
	EpisodeID       *string    `json:"episode_id"`
	SeasonNumber    *int       `json:"season_number"`
	EpisodeNumber   *int       `json:"episode_number"`
	PositionSeconds float64    `json:"position_seconds"`
	DurationSeconds *float64   `json:"duration_seconds"`
	Percent         float64    `json:"percent"`
	Completed       bool       `json:"completed"`
	CompletedAt     *time.Time `json:"completed_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
	DeviceID        *string    `json:"device_id"`
	// SourceID is the playback source of the session that last saved this
	// position (null when unknown): «Продолжить» plays it again.
	SourceID *string `json:"source_id"`

	id                   string
	profileID            string
	resumable            bool
	manual               bool
	lastSessionID        *string
	lastSessionStartedAt *time.Time
}

type NextUp struct {
	EpisodeID     string  `json:"episode_id"`
	SeasonNumber  int     `json:"season_number"`
	EpisodeNumber int     `json:"episode_number"`
	Name          string  `json:"name"`
	AirDate       *string `json:"air_date"`
}

type SeasonCount struct {
	SeasonNumber int `json:"season_number"`
	Completed    int `json:"completed"`
	Total        int `json:"total"`
}

type MediaProgress struct {
	MediaID  string          `json:"media_id"`
	Kind     string          `json:"kind"`
	Movie    *WatchProgress  `json:"movie"`
	Episodes []WatchProgress `json:"episodes"`
	Seasons  []SeasonCount   `json:"seasons"`
	NextUp   *NextUp         `json:"next_up"`
}

type ContinueItem struct {
	Media    catalog.MediaSummary `json:"media"`
	Progress *WatchProgress       `json:"progress"`
	NextUp   *NextUp              `json:"next_up"`
}

type HistoryItem struct {
	Media    catalog.MediaSummary `json:"media"`
	Progress WatchProgress        `json:"progress"`
}

type ProfileRef struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type AdminHistoryItem struct {
	HistoryItem
	Profile    ProfileRef `json:"profile"`
	DeviceName *string    `json:"device_name"`
}
