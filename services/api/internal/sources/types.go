// Package sources is the provider layer behind every place Cineko finds
// something to play: torrent indexers (Prowlarr, Jacred) feed the releases
// parse/match/rank pipeline; online/anime providers (AniLiberty) return
// playable variants that the playback package streams through the API.
//
// This file is the stable contract other packages code against. Exported
// names here do not change without updating every provider.
//
// Registering a provider: build it in server.New and call
// srcReg.Register(p) — see the "sources: register providers" block there.
package sources

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"time"
)

// Kind groups providers in the UI and decides which interface they serve.
type Kind string

const (
	KindTorrent Kind = "torrent" // TorrentProvider: results go through releases
	KindOnline  Kind = "online"  // OnlineProvider: films/series streamed directly
	KindAnime   Kind = "anime"   // OnlineProvider for anime (UI group «Аниме»)
)

// IDPattern is the allowed shape of a provider id (also used to validate
// profile settings).
var IDPattern = regexp.MustCompile(`^[a-z0-9:_-]{1,64}$`)

// Info describes a provider. Providers fill ID, Kind, Title,
// NeedsCredentials and Configured; the registry fills EnabledByAdmin and the
// health fields.
type Info struct {
	ID               string     `json:"id"` // "prowlarr", "jacred", "anilibria"
	Kind             Kind       `json:"kind"`
	Title            string     `json:"name"` // display name: "Prowlarr", "Jacred", "AniLiberty" (JSON "name")
	NeedsCredentials bool       `json:"needs_credentials"`
	Configured       bool       `json:"configured"` // URL / credentials present
	EnabledByAdmin   bool       `json:"enabled_by_admin"`
	Healthy          *bool      `json:"healthy"` // nil = not probed yet
	LastError        string     `json:"last_error,omitempty"`
	CheckedAt        *time.Time `json:"checked_at,omitempty"`
}

// Title is what providers get to look a title up. Built from the catalog
// (TMDB) plus the Kinopoisk mapping (internal/ratings).
type Title struct {
	MediaID          string
	TMDBID           int
	IMDbID           string // "tt0133093"; empty when unknown
	KPID             int    // Kinopoisk id; 0 when unknown (mapping pending)
	Kind             string // "movie" | "series"
	TitleRU          string
	TitleEN          string
	Original         string
	OriginalLanguage string
	Genres           []int // TMDB genre ids (16 = Animation)
	Year             int   // 0 when unknown
	Season           int   // 0 = movie / whole series
	Episode          int   // 0 = whole season
	// Queries are the free-text searches the releases package built for
	// this title (or the user's own «Уточнить» text). Torrent providers that
	// search by text run each of them; others may ignore them.
	Queries []string
	// UserQuery is the user's own «Уточнить» text ("" = automatic search).
	// When set, Queries is exactly [UserQuery].
	UserQuery string
}

// Provider is implemented by every source.
type Provider interface {
	Info() Info
	// Probe is a cheap health check (a fixed known title). nil = healthy.
	Probe(ctx context.Context) error
}

// Configurable providers receive admin settings (base URL override,
// credentials) whenever they change and once at startup. Optional.
type Configurable interface {
	Configure(c Config)
}

// Config is the admin-editable part of a provider (table source_config).
type Config struct {
	Enabled     bool
	BaseURL     string            // empty = provider default / env
	Credentials map[string]string // decrypted; never logged or returned
}

// ---------------------------------------------------------------- torrents

// Torrent is one raw search result. The releases package parses, matches,
// de-duplicates (by info hash) and ranks it.
type Torrent struct {
	GUID        string // stable per result within the provider
	Title       string
	Indexer     string // tracker name shown to users ("RuTor", "rutracker")
	IndexerID   int
	Size        int64
	Seeders     *int
	Leechers    *int
	PublishDate *time.Time
	InfoHash    string // 40 hex chars when known
	MagnetURI   string // "magnet:?…" when known
	// DownloadURL is a .torrent (or redirect-to-magnet) link. It must be safe
	// to store: providers strip secrets (Prowlarr re-adds its API key at
	// resolve time).
	DownloadURL string
	IMDbID      int
	Categories  []int  // Newznab category ids, when known
	Protocol    string // "torrent" (others are skipped)
	// Voices are voice-over names the provider parsed itself (Jacred
	// "voices"), merged with the ones parsed from Title.
	Voices []string
}

// SearchWarning is a non-fatal per-indexer problem (ReleaseList.indexer_errors).
type SearchWarning struct {
	Indexer string `json:"indexer"`
	Message string `json:"message"`
}

// TorrentResult is one provider's answer.
type TorrentResult struct {
	Torrents []Torrent
	Warnings []SearchWarning
}

// TorrentProvider searches torrent indexers. An error means the provider
// failed entirely (other providers' results are still shown).
type TorrentProvider interface {
	Provider
	SearchTorrents(ctx context.Context, t Title) (*TorrentResult, error)
}

// ---------------------------------------------------------------- online

// Variant is one playable choice for a movie or an episode (or, for a
// series looked up without an episode, a voice with its Episodes list).
type Variant struct {
	// ID is assigned by the core ("o" + hash of provider and Ref); providers
	// leave it empty.
	ID            string   `json:"id"`
	Provider      string   `json:"provider"`
	Voice         string   `json:"voice"`                // "Дубляж", "AniLiberty", "LostFilm"
	VoiceKind     string   `json:"voice_kind,omitempty"` // dub|mvo|dvo|avo|vo|original|sub; "" unknown
	Language      string   `json:"language,omitempty"`   // ISO 639-1 audio language; "" = ru
	MaxQuality    int      `json:"max_quality"`          // 2160, 1080, 720, 480; 0 unknown
	Qualities     []int    `json:"qualities"`
	Format        string   `json:"format"` // "mp4" | "hls"
	SubtitleLangs []string `json:"subtitle_langs"`
	Season        int      `json:"season,omitempty"`
	Episode       int      `json:"episode,omitempty"`
	// Episodes lists available episode numbers when the variant stands for
	// a whole season (lookup without episode).
	Episodes []int  `json:"episodes,omitempty"`
	Title    string `json:"title,omitempty"` // episode/release name for display
	// Ref is provider-private data needed by Resolve (release id, episode
	// id, upstream URLs…). Stored server-side, never sent to clients.
	Ref json.RawMessage `json:"-"`
}

// Subtitle is an external subtitle track of a stream.
type Subtitle struct {
	URL   string
	Lang  string
	Label string
}

// Stream is a resolved upstream URL for one variant and quality.
type Stream struct {
	URL       string            // absolute upstream URL (CDN)
	Headers   map[string]string // Referer/Origin/User-Agent to replay
	Format    string            // "mp4" | "hls"
	Quality   int
	Expires   time.Time // zero = unknown (re-resolve on 403/410)
	Subtitles []Subtitle
	// AudioTrack (HLS only), 1-based: the playback proxy rewrites the master
	// playlist to keep only this audio rendition of every audio group (and
	// marks it DEFAULT), so a multi-audio stream plays one voice on engines
	// that cannot switch HLS audio tracks. 0 = keep the playlist as is.
	AudioTrack int
	// Duration of the film/episode in seconds when the provider knows it
	// (0 = unknown); clients use it before the media metadata loads.
	Duration float64
}

// OnlineProvider returns variants and resolves them to streams. Used for
// both KindOnline and KindAnime.
type OnlineProvider interface {
	Provider
	// Variants for a movie, a season (t.Episode == 0: one variant per voice
	// with Episodes filled) or one episode. Empty slice = not found.
	Variants(ctx context.Context, t Title) ([]Variant, error)
	// Resolve turns a variant (with its Ref) into a stream. quality 0 = best.
	Resolve(ctx context.Context, v Variant, quality int) (*Stream, error)
}

// VariantLookup finds a variant shown by GET /media/{id}/online (kept 24 h),
// Ref included. Implemented by the online search service; used by playback.
type VariantLookup interface {
	LookupVariant(ctx context.Context, mediaID, variantID string) (*Variant, error)
}

var (
	// ErrNotFound: unknown provider or variant id.
	ErrNotFound = errors.New("sources: not found")
	// ErrDisabled: the provider exists but is disabled by the admin or not configured.
	ErrDisabled = errors.New("sources: provider disabled")
)

// ---------------------------------------------------------------- selection

// Selection is a profile's choice of providers (ProfileSettings.sources).
// All = every provider that is enabled by the admin and configured.
type Selection struct {
	All bool
	IDs []string
}

// AllSources is the default selection.
var AllSources = Selection{All: true}

// Allows reports whether the selection includes a provider id.
func (s Selection) Allows(id string) bool {
	if s.All {
		return true
	}
	for _, x := range s.IDs {
		if x == id {
			return true
		}
	}
	return false
}
