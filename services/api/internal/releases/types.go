// Package releases finds and ranks torrent releases for a title via the
// torrent providers of internal/sources (Prowlarr, Jacred; Phase 4). The Prowlarr API key and retrieval links never leave the server.
package releases

import (
	"context"
	"errors"
	"time"
)

// Release is the normalized result returned to clients (contract: Release).
type Release struct {
	ID            string      `json:"id"`
	Title         string      `json:"title"`
	Indexer       string      `json:"indexer"`
	SizeBytes     int64       `json:"size_bytes"`
	Seeders       int         `json:"seeders"`
	Leechers      *int        `json:"leechers"`
	PublishedAt   *time.Time  `json:"published_at"`
	InfoHash      *string     `json:"info_hash"`
	Resolution    *string     `json:"resolution"`
	VideoCodec    *string     `json:"video_codec"`
	HDR           *string     `json:"hdr"`
	AudioCodecs   []string    `json:"audio_codecs"`
	Languages     []string    `json:"languages"`
	Voiceovers    []Voiceover `json:"voiceovers"`
	ReleaseGroup  *string     `json:"release_group"`
	SourceQuality *string     `json:"source_quality"`
	Year          *int        `json:"year"`
	Seasons       []int       `json:"seasons"`
	Episodes      []int       `json:"episodes"`
	IsSeasonPack  bool        `json:"is_season_pack"`
	Confidence    float64     `json:"confidence"`
	Score         float64     `json:"score"`
	Reasons       []string    `json:"reasons"`
	Warnings      []string    `json:"warnings"`
	// EstBitrateBps is size × 8 / runtime (per episode for packs); nil when
	// the runtime is unknown. Computed per request, never cached.
	EstBitrateBps *float64 `json:"est_bitrate_bps"`
	// Provider is the torrent provider that found it (first one when
	// several returned the same info hash).
	Provider ProviderRef `json:"provider"`
}

// Resolved is a release plus its server-only retrieval data, for the
// playback package. MagnetURI and/or DownloadURL is set; DownloadURL may
// embed the Prowlarr API key and must never be logged or returned.
type Resolved struct {
	MediaID     string
	Release     Release
	MagnetURI   string
	DownloadURL string
}

// ErrReleaseNotFound means the release id is unknown or its search expired.
var ErrReleaseNotFound = errors.New("release not found")

// Resolver is what the playback package needs from this package.
type Resolver interface {
	Resolve(ctx context.Context, mediaID, releaseID string) (*Resolved, error)
}

// AlternateFinder finds the same upload offered by another provider with a
// magnet or info hash, for when a release's .torrent download fails.
type AlternateFinder interface {
	Alternate(ctx context.Context, mediaID string, r Release) (*Resolved, error)
}
