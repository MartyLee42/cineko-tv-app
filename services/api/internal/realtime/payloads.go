package realtime

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"unicode/utf8"

	"github.com/google/uuid"
)

// Typed command payloads (contract: openapi.yaml *Payload schemas). The server
// validates every command before forwarding it, so a TV never receives a
// malformed payload.

type MediaOpenPayload struct {
	MediaID       string `json:"media_id"`
	SeasonNumber  *int   `json:"season_number,omitempty"`
	EpisodeNumber *int   `json:"episode_number,omitempty"`
	Force         bool   `json:"force,omitempty"`
}

type MediaPlayPayload struct {
	MediaID   string  `json:"media_id"`
	EpisodeID *string `json:"episode_id,omitempty"`
	SourceID  *string `json:"source_id,omitempty"`
	// ReleaseID: the release chosen on the phone; the TV prepares the source itself.
	ReleaseID       *string  `json:"release_id,omitempty"`
	Quality         *int     `json:"quality,omitempty"` // online variants
	PositionSeconds *float64 `json:"position_seconds,omitempty"`
	Force           bool     `json:"force,omitempty"`
	Player          string   `json:"player,omitempty"` // builtin | msx | external; empty = TV default
}

// IptvPlayPayload is iptv.play: switch the TV to a live channel.
type IptvPlayPayload struct {
	ChannelID string  `json:"channel_id"`
	ProfileID *string `json:"profile_id,omitempty"`
	Force     bool    `json:"force,omitempty"`
}

// VideoPlayPayload is video.play: play a YouTube video (the «Видео» tab).
type VideoPlayPayload struct {
	VideoID         string   `json:"video_id"`
	ProfileID       *string  `json:"profile_id,omitempty"`
	PositionSeconds *float64 `json:"position_seconds,omitempty"`
	Quality         *int     `json:"quality,omitempty"`
	Force           bool     `json:"force,omitempty"`
}

var youtubeID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

type SeekPayload struct {
	PositionSeconds *float64 `json:"position_seconds"`
}

type SelectSourcePayload struct {
	SourceID string `json:"source_id"`
}

type SetTrackPayload struct {
	TrackID *string `json:"track_id"`
}

// SetVolumePayload is playback.set_volume: the TV's sound level (at least one field).
type SetVolumePayload struct {
	Volume *float64 `json:"volume,omitempty"` // 0..1, absolute (wins over delta)
	Delta  *float64 `json:"delta,omitempty"`  // -1..1 (not 0), a relative step
	Muted  *bool    `json:"muted,omitempty"`
}

type ShowMessagePayload struct {
	Text string `json:"text"`
}

// ErrInvalidPayload wraps every validation failure.
var ErrInvalidPayload = errors.New("bad payload")

func bad(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidPayload, fmt.Sprintf(format, args...))
}

// ValidatePayload checks a command's payload and returns it re-encoded in
// canonical form (unknown fields dropped). mediaIDs receives any media ids
// the command references so the caller can verify they exist.
func ValidatePayload(cmd string, raw json.RawMessage) (json.RawMessage, []string, error) {
	empty := len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
	decode := func(v any) error {
		if empty {
			return bad("payload required")
		}
		if err := json.Unmarshal(raw, v); err != nil {
			return bad("malformed payload")
		}
		return nil
	}

	switch cmd {
	case "media.pause", "media.resume", "media.stop", "media.next_episode", "device.request_state":
		// No payload; anything sent is ignored.
		return nil, nil, nil

	case "media.open":
		var p MediaOpenPayload
		if err := decode(&p); err != nil {
			return nil, nil, err
		}
		if !isUUID(p.MediaID) {
			return nil, nil, bad("media_id must be a uuid")
		}
		if p.SeasonNumber != nil && *p.SeasonNumber < 0 {
			return nil, nil, bad("season_number must be >= 0")
		}
		if p.EpisodeNumber != nil {
			if p.SeasonNumber == nil {
				return nil, nil, bad("episode_number requires season_number")
			}
			if *p.EpisodeNumber < 1 {
				return nil, nil, bad("episode_number must be >= 1")
			}
		}
		return mustJSON(p), []string{p.MediaID}, nil

	case "media.play":
		var p MediaPlayPayload
		if err := decode(&p); err != nil {
			return nil, nil, err
		}
		if !isUUID(p.MediaID) {
			return nil, nil, bad("media_id must be a uuid")
		}
		if p.EpisodeID != nil && !isUUID(*p.EpisodeID) {
			return nil, nil, bad("episode_id must be a uuid")
		}
		if p.SourceID != nil && (*p.SourceID == "" || len(*p.SourceID) > 128) {
			return nil, nil, bad("source_id must be 1-128 characters")
		}
		if p.ReleaseID != nil && (*p.ReleaseID == "" || len(*p.ReleaseID) > 128) {
			return nil, nil, bad("release_id must be 1-128 characters")
		}
		if p.Quality != nil && (*p.Quality < 1 || *p.Quality > 4320) {
			return nil, nil, bad("quality must be 1-4320")
		}
		if p.PositionSeconds != nil && !validSeconds(*p.PositionSeconds) {
			return nil, nil, bad("position_seconds must be >= 0")
		}
		switch p.Player {
		case "", "builtin", "msx", "external":
		default:
			return nil, nil, bad("player must be builtin, msx or external")
		}
		return mustJSON(p), []string{p.MediaID}, nil

	case "media.seek":
		var p SeekPayload
		if err := decode(&p); err != nil {
			return nil, nil, err
		}
		if p.PositionSeconds == nil || !validSeconds(*p.PositionSeconds) {
			return nil, nil, bad("position_seconds must be >= 0")
		}
		return mustJSON(p), nil, nil

	case "media.select_source":
		var p SelectSourcePayload
		if err := decode(&p); err != nil {
			return nil, nil, err
		}
		if p.SourceID == "" || len(p.SourceID) > 128 {
			return nil, nil, bad("source_id must be 1-128 characters")
		}
		return mustJSON(p), nil, nil

	case "playback.set_audio", "playback.set_subtitles":
		var p struct {
			TrackID json.RawMessage `json:"track_id"`
		}
		if err := decode(&p); err != nil {
			return nil, nil, err
		}
		if len(p.TrackID) == 0 {
			return nil, nil, bad("track_id required (null turns subtitles off)")
		}
		var out SetTrackPayload
		if string(p.TrackID) != "null" {
			var id string
			if json.Unmarshal(p.TrackID, &id) != nil || id == "" || len(id) > 64 {
				return nil, nil, bad("track_id must be a string of 1-64 characters or null")
			}
			out.TrackID = &id
		} else if cmd == "playback.set_audio" {
			return nil, nil, bad("an audio track is required")
		}
		return mustJSON(out), nil, nil

	case "playback.set_volume":
		var p SetVolumePayload
		if err := decode(&p); err != nil {
			return nil, nil, err
		}
		if p.Volume == nil && p.Delta == nil && p.Muted == nil {
			return nil, nil, bad("volume, delta or muted required")
		}
		if p.Volume != nil && !inRange(*p.Volume, 0, 1) {
			return nil, nil, bad("volume must be 0..1")
		}
		if p.Delta != nil && (!inRange(*p.Delta, -1, 1) || *p.Delta == 0) {
			return nil, nil, bad("delta must be -1..1 and not 0")
		}
		return mustJSON(p), nil, nil

	case "iptv.play":
		var p IptvPlayPayload
		if err := decode(&p); err != nil {
			return nil, nil, err
		}
		if !isUUID(p.ChannelID) {
			return nil, nil, bad("channel_id must be a uuid")
		}
		if p.ProfileID != nil && !isUUID(*p.ProfileID) {
			return nil, nil, bad("profile_id must be a uuid")
		}
		return mustJSON(p), nil, nil

	case "video.play":
		var p VideoPlayPayload
		if err := decode(&p); err != nil {
			return nil, nil, err
		}
		if !youtubeID.MatchString(p.VideoID) {
			return nil, nil, bad("video_id must be an 11-character YouTube id")
		}
		if p.ProfileID != nil && !isUUID(*p.ProfileID) {
			return nil, nil, bad("profile_id must be a uuid")
		}
		if p.PositionSeconds != nil && !validSeconds(*p.PositionSeconds) {
			return nil, nil, bad("position_seconds must be >= 0")
		}
		if p.Quality != nil && *p.Quality != 480 && *p.Quality != 720 && *p.Quality != 1080 {
			return nil, nil, bad("quality must be 480, 720 or 1080")
		}
		return mustJSON(p), nil, nil

	case "device.show_message":
		var p ShowMessagePayload
		if err := decode(&p); err != nil {
			return nil, nil, err
		}
		if n := utf8.RuneCountInString(p.Text); n < 1 || n > 200 {
			return nil, nil, bad("text must be 1-200 characters")
		}
		return mustJSON(p), nil, nil
	}
	return nil, nil, bad("unknown command %q", cmd)
}

func isUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil && len(s) == 36
}

func inRange(f, lo, hi float64) bool {
	return !math.IsNaN(f) && f >= lo && f <= hi
}

func validSeconds(f float64) bool {
	return f >= 0 && !math.IsInf(f, 0) && !math.IsNaN(f) && f < 1e7
}
