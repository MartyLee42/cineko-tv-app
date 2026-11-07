// Package playback prepares releases for streaming through the household's
// TorrServer and proxies the stream to clients (Phase 4).
//
// Clients never see TorrServer: they get a source id and a relative,
// signed, expiring /api/v1/stream/<token> URL. Everything the proxy sends to
// TorrServer (hash, file index) comes from the database row the token is
// bound to.
package playback

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/config"
	"martytv/api/internal/integrations/torrserver"
	"martytv/api/internal/releases"
	"martytv/api/internal/segments"
)

// Error codes stored on sources / returned to clients.
const (
	ErrCodeNoMetadata         = "no_metadata"
	ErrCodeNoMatchingFile     = "no_matching_file"
	ErrCodeTorrServerDown     = "torrserver_unavailable"
	ErrCodeReleaseUnavailable = "release_unavailable"
)

// MediaStream / MediaInfo mirror the contract schemas.
type MediaStream struct {
	Index    int     `json:"index"`
	Codec    string  `json:"codec"`
	Language *string `json:"language"`
	Title    *string `json:"title"`
	Channels *int    `json:"channels"`
	Default  bool    `json:"default"`
}

type MediaInfo struct {
	Container       *string       `json:"container"`
	VideoCodec      *string       `json:"video_codec"`
	Width           *int          `json:"width"`
	Height          *int          `json:"height"`
	DurationSeconds *float64      `json:"duration_seconds"`
	Audio           []MediaStream `json:"audio"`
	Subtitles       []MediaStream `json:"subtitles"`
	// Video details (probe version 2+): what decides whether a TV's hardware
	// decoder can play the (copied) video — e.g. H.264 High 10 can't.
	VideoProfile *string `json:"video_profile,omitempty"` // "High", "High 10", "Main 10"…
	PixFmt       *string `json:"pix_fmt,omitempty"`       // "yuv420p", "yuv420p10le"…
	BitDepth     *int    `json:"bit_depth,omitempty"`
	VideoLevel   *int    `json:"video_level,omitempty"` // ffprobe's level (H.264: 41 = 4.1; HEVC: 120 = 4.0)
	Interlaced   *bool   `json:"interlaced,omitempty"`
	// VideoCodecString: ffprobe's RFC 6381 codec string ("avc1.6e0028") when
	// it prints one — ready for canPlayType.
	VideoCodecString *string `json:"video_codec_string,omitempty"`
	// ProbeVersion: mediaInfoVersion at the time of the probe; older rows
	// are re-probed once (lazily) to get the newer fields.
	ProbeVersion int `json:"probe_version,omitempty"`
	// Chapters (probe version 3+): the file's titled chapters; "Opening" /
	// «Заставка» / "Credits" ones become skip markers (segments.go).
	Chapters []MediaChapter `json:"chapters,omitempty"`
}

// MediaChapter is one titled chapter of the file.
type MediaChapter struct {
	StartSeconds float64 `json:"start_seconds"`
	EndSeconds   float64 `json:"end_seconds"`
	Title        string  `json:"title"`
}

// mediaInfoVersion 2 added the video profile fields, 3 the chapters.
const mediaInfoVersion = 3

// maxChapters: more than this is a menu of scenes, not intro/credits marks.
const maxChapters = 64

// TorrentStats is the live torrent block of a PlaybackSource.
type TorrentStats struct {
	Peers            int     `json:"peers"`
	Seeders          int     `json:"seeders"`
	DownloadSpeedBps float64 `json:"download_speed_bps"` // bytes per second
	PreloadedBytes   int64   `json:"preloaded_bytes"`
	TotalPeers       int     `json:"total_peers"`
	PreloadSize      int64   `json:"preload_size"`
	// Stage: metadata | preloading | working | idle (TorrServer's stat).
	Stage string `json:"stage"`
}

// torrentStats renders TorrServer's live numbers for a source.
func torrentStats(t *torrserver.Torrent) *TorrentStats {
	stage := "idle"
	switch t.Stat {
	case torrserver.StatGettingInfo:
		stage = "metadata"
	case torrserver.StatPreload:
		stage = "preloading"
	case torrserver.StatWorking:
		stage = "working"
	}
	if stage == "idle" && t.Stat == torrserver.StatAdded && !t.HasMetadata() {
		stage = "metadata"
	}
	return &TorrentStats{
		Peers: t.ActivePeers, Seeders: t.ConnectedSeeders,
		DownloadSpeedBps: t.DownloadSpeed, PreloadedBytes: t.PreloadedBytes,
		TotalPeers: t.TotalPeers, PreloadSize: t.PreloadSize, Stage: stage,
	}
}

// PlaybackSource is the API representation (contract: PlaybackSource).
type PlaybackSource struct {
	ID              string           `json:"id"`
	MediaID         string           `json:"media_id"`
	EpisodeID       *string          `json:"episode_id"`
	Release         releases.Release `json:"release"`
	Status          string           `json:"status"`
	Error           *string          `json:"error"`
	File            *TorrentFile     `json:"file"`
	StreamURL       *string          `json:"stream_url"`
	StreamExpiresAt *time.Time       `json:"stream_expires_at"`
	// CompatURL (torrent): the browser compatibility stream (compat.go), null
	// when the transcoder isn't configured. Add ?audio=&start=.
	CompatURL *string `json:"compat_url"`
	// CompatVideo (torrent): the compat stream can re-encode this file's
	// video to H.264 (add video=h264): XviD / MPEG-2 / VC-1 ≤ 1080p.
	CompatVideo bool          `json:"compat_video"`
	MimeType    *string       `json:"mime_type"`
	MediaInfo   *MediaInfo    `json:"media_info"`
	Torrent     *TorrentStats `json:"torrent"`
	CreatedAt   time.Time     `json:"created_at"`
	// Download (torrent): the server download of the file (library.go).
	Download *DownloadBrief `json:"download"`
	// Kind is "torrent" or "online"; the fields below are for online
	// sources (null / empty for torrents).
	Kind      string           `json:"kind"`
	Provider  *ProviderRef     `json:"provider"`
	Format    *string          `json:"format"` // hls | mp4
	Quality   *int             `json:"quality"`
	Qualities []int            `json:"qualities"`
	Subtitles []StreamSubtitle `json:"subtitles"`
	// Markers (opening/ending) let players offer "skip intro".
	Markers []SkipMarker `json:"markers,omitempty"`
	// DurationSeconds (online): the provider's film/episode length when
	// known; players use it for resume and end-of-title guards.
	DurationSeconds *float64 `json:"duration_seconds,omitempty"`
}

// Timings are tunable for tests.
type Timings struct {
	InlineWait      time.Duration // how long POST waits for metadata
	MetadataTimeout time.Duration // give up → no_metadata
	PollInterval    time.Duration
	TokenTTL        time.Duration
	StatsTimeout    time.Duration // live stats on GET
	MediaInfoRetry  time.Duration // min gap between ffprobe attempts
	StreamIdle      time.Duration // abort a stream with no upstream bytes for this long
	// VideoHeaderWait: a YouTube request (through Invidious) that hasn't
	// started answering by then is retried once on a fresh connection.
	VideoHeaderWait time.Duration
}

func DefaultTimings() Timings {
	return Timings{
		InlineWait:      3 * time.Second,
		MetadataTimeout: 60 * time.Second,
		PollInterval:    500 * time.Millisecond,
		TokenTTL:        12 * time.Hour,
		StatsTimeout:    2 * time.Second,
		MediaInfoRetry:  2 * time.Minute,
		StreamIdle:      2 * time.Minute,
		VideoHeaderWait: 6 * time.Second,
	}
}

// Service manages playback sources.
type Service struct {
	hls      hlsActivity // HLS compat requests (StreamingHashes)
	pool     *pgxpool.Pool
	cfg      *config.Config
	releases releases.Resolver
	log      *slog.Logger

	st      *store
	ts      *torrserver.Client
	fetcher *torrentFetcher
	signer  *signer
	t       Timings

	mu         sync.Mutex
	preparing  map[string]chan struct{}      // source id → closed when done
	prepCancel map[string]context.CancelFunc // source id → stops its preparer
	fresh      map[string]time.Time          // source id → when this process added its torrent (cancel.go)
	probing    map[string]time.Time          // source id → last ffprobe attempt
	waking     map[string]time.Time          // source id → last preload asked of an idle torrent
	bg         sync.WaitGroup

	online *onlineDeps       // nil until SetOnline (online.go)
	live   *liveDeps         // nil until SetLive (live.go, IPTV)
	video  *videoDeps        // nil until SetVideo (video.go, YouTube via Invidious)
	tc     *transcoder       // nil = no compat streams (compat.go)
	lib    Library           // nil = no server downloads (library.go)
	segs   *segments.Service // nil = no intro/credits databases (segments.go)
}

func NewService(pool *pgxpool.Pool, cfg *config.Config, r releases.Resolver, log *slog.Logger) *Service {
	return &Service{
		pool: pool, cfg: cfg, releases: r, log: log.With("module", "playback"),
		st:         &store{q: pool},
		ts:         torrserver.New(cfg.TorrServer),
		fetcher:    newTorrentFetcher(cfg.Prowlarr.URL),
		signer:     newSigner(cfg.SessionSecret),
		t:          DefaultTimings(),
		preparing:  map[string]chan struct{}{},
		prepCancel: map[string]context.CancelFunc{},
		fresh:      map[string]time.Time{},
		probing:    map[string]time.Time{},
		waking:     map[string]time.Time{},
		tc:         newTranscoder(cfg.Transcoder),
	}
}

// SetResolver replaces the release resolver (tests).
func (s *Service) SetResolver(r releases.Resolver) { s.releases = r }

// SetTimings replaces the timings (tests).
func (s *Service) SetTimings(t Timings) { s.t = t }

// Wait blocks until background work has finished (tests, shutdown).
func (s *Service) Wait() { s.bg.Wait() }

// apiError is a service-level failure the handlers map to HTTP.
type apiError struct {
	Status int
	Code   string
	Msg    string
	Fields map[string]string
}

func (e *apiError) Error() string { return e.Code }

var (
	errSourceNotFound = &apiError{Status: 404, Code: "not_found", Msg: "Not found."}
	errTorrServerDown = &apiError{Status: 502, Code: ErrCodeTorrServerDown, Msg: "The streaming server is unavailable."}
)

func validation(field, msg string) *apiError {
	return &apiError{Status: 422, Code: "validation_failed", Msg: "Some fields are invalid.", Fields: map[string]string{field: msg}}
}

// caller identifies who acts.
type caller struct {
	UserID   string
	DeviceID string // set for TV device credentials
}

// CreateInput is the POST /playback/sources body.
type CreateInput struct {
	MediaID   string  `json:"media_id"`
	ReleaseID string  `json:"release_id"`
	EpisodeID *string `json:"episode_id"`
	ProfileID *string `json:"profile_id"`
	Quality   *int    `json:"quality"` // online sources: preferred quality (0/nil = best)
	// Kind "iptv" + ChannelID: a live channel (live.go); "" / "release" otherwise.
	Kind      string  `json:"kind"`
	ChannelID *string `json:"channel_id"`
	// Kind "video" + VideoID: a YouTube video via Invidious (video.go).
	VideoID *string `json:"video_id"`
}

// Create resolves a release, registers it with TorrServer and starts
// preparing the source (or reuses an existing one).
func (s *Service) Create(ctx context.Context, who caller, in CreateInput, log *slog.Logger) (*PlaybackSource, error) {
	m, err := s.st.media(ctx, in.MediaID)
	if errors.Is(err, errNotFound) {
		return nil, &apiError{Status: 404, Code: "not_found", Msg: "Media not found."}
	}
	if err != nil {
		return nil, err
	}
	tgt := target{}
	if m.Kind == "series" {
		if in.EpisodeID == nil {
			return nil, validation("episode_id", "Required for series.")
		}
		season, number, err := s.st.episode(ctx, in.MediaID, *in.EpisodeID)
		if errors.Is(err, errNotFound) {
			return nil, validation("episode_id", "Unknown episode for this title.")
		}
		if err != nil {
			return nil, err
		}
		tgt = target{Episode: true, Season: season, Number: number}
	} else if in.EpisodeID != nil {
		return nil, validation("episode_id", "Movies have no episodes.")
	}
	if in.ProfileID != nil {
		ok, err := s.st.profileAccessible(ctx, *in.ProfileID, who.UserID, who.DeviceID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, validation("profile_id", "Unknown profile.")
		}
	}

	// Intro/credits times: looked up while the source prepares.
	s.prefetchSegments(in.MediaID, in.EpisodeID)
	if isOnlineRelease(in.ReleaseID) {
		return s.createOnline(ctx, who, in, tgt, log)
	}
	if s.releases == nil {
		return nil, &apiError{Status: 404, Code: "release_not_found", Msg: "Release not found; search again."}
	}
	res, err := s.releases.Resolve(ctx, in.MediaID, in.ReleaseID)
	if errors.Is(err, releases.ErrReleaseNotFound) || (err == nil && (res == nil || res.MediaID != in.MediaID)) {
		return nil, &apiError{Status: 404, Code: "release_not_found", Msg: "Release not found; search again."}
	}
	if err != nil {
		log.Warn("release resolve failed", "err", err)
		return nil, &apiError{Status: 502, Code: ErrCodeReleaseUnavailable, Msg: "The release could not be retrieved."}
	}
	tgt.ReleaseSeasons, tgt.ReleaseEpisodes = res.Release.Seasons, res.Release.Episodes

	if !s.ts.Configured() {
		return nil, &apiError{Status: 502, Code: ErrCodeTorrServerDown, Msg: "The streaming server is not configured."}
	}

	row := &source{
		MediaID: in.MediaID, EpisodeID: in.EpisodeID, ReleaseID: in.ReleaseID, Release: res.Release,
		CreatedByUserID: who.UserID, ProfileID: in.ProfileID,
	}
	if who.DeviceID != "" {
		row.DeviceID = &who.DeviceID
	}

	// Fast path: the release's info hash is known and a usable source exists.
	if h := strings.ToLower(deref(res.Release.InfoHash)); torrserver.ValidHash(h) {
		if existing, err := s.st.findReusable(ctx, who.UserID, h, in.EpisodeID); err == nil && existing.Status != "error" {
			s.ensurePreparing(existing, tgt)
			return s.present(ctx, existing, false), nil
		} else if err != nil && !errors.Is(err, errNotFound) {
			return nil, err
		}
		// Already downloaded to the server: ready at once, no TorrServer.
		if src := s.createFromLibrary(ctx, row, h, res.MagnetURI, tgt, log); src != nil {
			return s.present(ctx, src, false), nil
		}
	}

	knownHash := strings.ToLower(deref(res.Release.InfoHash))
	if !torrserver.ValidHash(knownHash) {
		knownHash = magnetHash(res.MagnetURI)
	}
	existed := s.inTorrServer(ctx, knownHash)
	t, magnet, err := s.register(ctx, res, row, m.Kind)
	if err != nil {
		return nil, err
	}
	row.InfoHash = t.Hash
	row.Magnet = magnet

	src, created, err := s.st.insertOrGet(ctx, row)
	if err != nil {
		return nil, err
	}
	if !created && src.Status == "error" {
		if err := s.st.restart(ctx, src.ID, row); err != nil {
			return nil, err
		}
		if src, err = s.st.get(ctx, src.ID); err != nil {
			return nil, err
		}
	}
	if created && !existed && knownHash == strings.ToLower(t.Hash) {
		s.markFresh(src.ID)
	}
	log.Info("playback source", "source_id", src.ID, "created", created, "status", src.Status)

	done := s.ensurePreparing(src, tgt)
	if done != nil {
		select {
		case <-done:
		case <-time.After(s.t.InlineWait):
		case <-ctx.Done():
		}
		if fresh, err := s.st.get(ctx, src.ID); err == nil {
			src = fresh
		}
	}
	return s.present(ctx, src, false), nil
}

// register adds the release to TorrServer by magnet or .torrent upload.
func (s *Service) register(ctx context.Context, res *releases.Resolved, row *source, kind string) (*torrserver.Torrent, *string, error) {
	category := "movie"
	if kind == "series" {
		category = "tv"
	}
	req := torrserver.AddRequest{
		Title: res.Release.Title, Category: category, SaveToDB: true,
		Data: `{"martytv":{"media_id":"` + row.MediaID + `"}}`,
	}
	var f *fetched
	switch {
	case strings.HasPrefix(strings.ToLower(res.MagnetURI), "magnet:"):
		f = &fetched{Magnet: res.MagnetURI}
	case res.DownloadURL != "":
		var err error
		f, err = s.fetcher.Fetch(ctx, res.DownloadURL)
		if err != nil {
			// The same upload from another provider with a magnet (Prowlarr
			// has no hash for RuTracker.org and its downloads sometimes fail).
			alt := s.alternate(ctx, row.MediaID, res.Release)
			s.log.Warn("release download failed", "media_id", row.MediaID, "release_id", res.Release.ID,
				"indexer", res.Release.Indexer, "err", err, "alternate", alt != nil)
			if alt == nil {
				return nil, nil, &apiError{Status: 502, Code: ErrCodeReleaseUnavailable, Msg: "The release could not be downloaded."}
			}
			f = &fetched{Magnet: alt.MagnetURI}
		}
	case res.Release.InfoHash != nil && torrserver.ValidHash(strings.ToLower(*res.Release.InfoHash)):
		f = &fetched{Magnet: "magnet:?xt=urn:btih:" + strings.ToLower(*res.Release.InfoHash)}
	default:
		return nil, nil, &apiError{Status: 502, Code: ErrCodeReleaseUnavailable, Msg: "The release has no download link."}
	}

	var t *torrserver.Torrent
	var err error
	var magnet *string
	if f.Magnet != "" {
		req.Link = f.Magnet
		magnet = &f.Magnet
		t, err = s.ts.Add(ctx, req)
	} else {
		t, err = s.ts.Upload(ctx, f.Torrent, req)
	}
	if err != nil {
		s.log.Warn("torrserver add failed", "err", err)
		return nil, nil, tsError(err)
	}
	return t, magnet, nil
}

// alternate finds a magnet for the same upload as r, or nil.
func (s *Service) alternate(ctx context.Context, mediaID string, r releases.Release) *releases.Resolved {
	af, ok := s.releases.(releases.AlternateFinder)
	if !ok {
		return nil
	}
	alt, err := af.Alternate(ctx, mediaID, r)
	if err != nil {
		s.log.Warn("release alternate lookup failed", "err", err)
		return nil
	}
	return alt
}

func tsError(err error) error {
	switch {
	case errors.Is(err, torrserver.ErrUnsupported):
		return &apiError{Status: 502, Code: ErrCodeTorrServerDown, Msg: "The streaming server version is not supported."}
	case errors.Is(err, torrserver.ErrBadResponse):
		return &apiError{Status: 502, Code: ErrCodeReleaseUnavailable, Msg: "The streaming server rejected the release."}
	default:
		return errTorrServerDown
	}
}

// ensurePreparing starts the background preparer for a preparing source
// unless one is already running; it returns the done channel (nil if the
// source is not preparing).
func (s *Service) ensurePreparing(src *source, tgt target) chan struct{} {
	if src.Status != "preparing" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if ch, ok := s.preparing[src.ID]; ok {
		return ch
	}
	ch := make(chan struct{})
	s.preparing[src.ID] = ch
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		defer func() {
			s.mu.Lock()
			delete(s.preparing, src.ID)
			s.mu.Unlock()
			close(ch)
		}()
		s.prepare(src, tgt)
	}()
	return ch
}

// prepare waits for torrent metadata and selects the file.
func (s *Service) prepare(src *source, tgt target) {
	ctx, cancel := context.WithTimeout(context.Background(), s.t.MetadataTimeout)
	defer cancel()
	s.mu.Lock()
	s.prepCancel[src.ID] = cancel
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.prepCancel, src.ID)
		s.mu.Unlock()
	}()
	log := s.log.With("source_id", src.ID)
	var lastErr error
	for {
		t, err := s.ts.Get(ctx, src.InfoHash)
		if errors.Is(err, torrserver.ErrNotFound) && src.Magnet != nil {
			// Removed from TorrServer meanwhile: register it again.
			t, err = s.ts.Add(ctx, torrserver.AddRequest{Link: *src.Magnet, Title: src.Release.Title, SaveToDB: true})
		}
		if err == nil && t.HasMetadata() {
			files := make([]fileStat, len(t.FileStats))
			for i, f := range t.FileStats {
				files[i] = fileStat{ID: f.ID, Path: f.Path, Length: f.Length}
			}
			bg := context.Background()
			if err := s.st.setFiles(bg, src.ID, files); err != nil {
				log.Error("store files", "err", err)
			}
			f, ok := selectFile(classify(files), tgt)
			if !ok {
				log.Info("no matching file", "files", len(files))
				_ = s.st.setError(bg, src.ID, ErrCodeNoMatchingFile)
				return
			}
			if err := s.st.setReady(bg, src.ID, f); err != nil {
				log.Error("mark ready", "err", err)
				return
			}
			log.Info("source ready", "file_index", f.Index)
			return
		}
		if err != nil {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.Canceled) {
				log.Info("source preparation cancelled")
				return
			}
			code := ErrCodeNoMetadata
			if lastErr != nil && !errors.Is(lastErr, torrserver.ErrNotFound) && !errors.Is(lastErr, context.DeadlineExceeded) &&
				(errors.Is(lastErr, torrserver.ErrUnavailable) || errors.Is(lastErr, torrserver.ErrUnauthorized)) {
				code = ErrCodeTorrServerDown
			}
			log.Info("source preparation failed", "error", code, "last_err", errString(lastErr))
			_ = s.st.setError(context.Background(), src.ID, code)
			return
		case <-time.After(s.t.PollInterval):
		}
	}
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// Get returns a source the caller may access, with live stats and a fresh
// stream URL.
func (s *Service) Get(ctx context.Context, who caller, id string) (*PlaybackSource, error) {
	src, err := s.load(ctx, who, id)
	if err != nil {
		return nil, err
	}
	if src.Status == "preparing" {
		// Resume after a restart (no preparer in this process).
		if tgt, err := s.targetFor(ctx, src); err == nil {
			s.ensurePreparing(src, tgt)
		}
	}
	return s.present(ctx, src, true), nil
}

func (s *Service) targetFor(ctx context.Context, src *source) (target, error) {
	tgt := target{ReleaseSeasons: src.Release.Seasons, ReleaseEpisodes: src.Release.Episodes}
	if src.EpisodeID != nil {
		season, number, err := s.st.episode(ctx, src.MediaID, *src.EpisodeID)
		if err != nil {
			return tgt, err
		}
		tgt.Episode, tgt.Season, tgt.Number = true, season, number
	}
	return tgt, nil
}

func (s *Service) load(ctx context.Context, who caller, id string) (*source, error) {
	src, err := s.st.get(ctx, id)
	if errors.Is(err, errNotFound) {
		return nil, errSourceNotFound
	}
	if err != nil {
		return nil, err
	}
	ok, err := s.st.canAccess(ctx, src, who.UserID, who.DeviceID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errSourceNotFound
	}
	return src, nil
}

// Files lists the torrent's files (cached once metadata arrived).
func (s *Service) Files(ctx context.Context, who caller, id string) ([]TorrentFile, error) {
	src, err := s.load(ctx, who, id)
	if err != nil {
		return nil, err
	}
	if src.Kind == "online" {
		return nil, errSourceNotFound
	}
	return classify(src.Files), nil
}

// SelectFile switches the source to another (video) file.
func (s *Service) SelectFile(ctx context.Context, who caller, id string, index int) (*PlaybackSource, error) {
	src, err := s.load(ctx, who, id)
	if err != nil {
		return nil, err
	}
	if src.Kind == "online" {
		return nil, validation("file_index", "Online sources have no files.")
	}
	if len(src.Files) == 0 {
		return nil, &apiError{Status: 409, Code: "source_not_ready", Msg: "The torrent's file list is not known yet."}
	}
	var chosen *TorrentFile
	for _, f := range classify(src.Files) {
		if f.Index == index {
			chosen = &f
			break
		}
	}
	if chosen == nil {
		return nil, validation("file_index", "No such file in this torrent.")
	}
	if !chosen.IsVideo {
		return nil, validation("file_index", "Not a playable video file.")
	}
	if err := s.st.setReady(ctx, src.ID, *chosen); err != nil {
		return nil, err
	}
	if src, err = s.st.get(ctx, src.ID); err != nil {
		return nil, err
	}
	return s.present(ctx, src, true), nil
}

// present renders a source; live adds TorrServer stats and kicks ffprobe.
func (s *Service) present(ctx context.Context, src *source, live bool) *PlaybackSource {
	if src.Kind == "online" {
		return s.presentOnline(ctx, src, live)
	}
	out := &PlaybackSource{
		ID: src.ID, MediaID: src.MediaID, EpisodeID: src.EpisodeID, Release: src.Release,
		Status: src.Status, Error: src.ErrorCode, MediaInfo: src.MediaInfo, CreatedAt: src.CreatedAt, Kind: "torrent",
		Qualities: []int{}, Subtitles: []StreamSubtitle{},
	}
	if out.Release.AudioCodecs == nil {
		out.Release.AudioCodecs = []string{}
	}
	if out.Release.Languages == nil {
		out.Release.Languages = []string{}
	}
	if out.Release.Seasons == nil {
		out.Release.Seasons = []int{}
	}
	if out.Release.Episodes == nil {
		out.Release.Episodes = []int{}
	}
	if out.Release.Reasons == nil {
		out.Release.Reasons = []string{}
	}
	if out.Release.Warnings == nil {
		out.Release.Warnings = []string{}
	}
	if src.Status == "ready" && src.FileIndex != nil {
		f := TorrentFile{Index: *src.FileIndex, Path: deref(src.FilePath), IsVideo: true}
		if src.FileSize != nil {
			f.SizeBytes = *src.FileSize
		}
		for _, c := range classify([]fileStat{{ID: f.Index, Path: f.Path, Length: f.SizeBytes}}) {
			f.Season, f.Episode = c.Season, c.Episode
		}
		out.File = &f
		if mt := MimeType(f.Path); mt != "" {
			out.MimeType = &mt
		}
		exp := time.Now().Add(s.t.TokenTTL).UTC().Truncate(time.Second)
		if tok, err := s.signer.Sign(src.ID, exp); err == nil {
			u := "/api/v1/stream/" + tok
			out.StreamURL, out.StreamExpiresAt = &u, &exp
			if s.tc != nil {
				cu := u + "/" + compatName
				out.CompatURL = &cu
				out.CompatVideo = VideoTranscodable(src.MediaInfo)
			}
		}
	}
	local := false
	if s.lib != nil && src.Status == "ready" && src.FileIndex != nil {
		out.Download = s.lib.Brief(ctx, src.CreatedByUserID, src.InfoHash, *src.FileIndex)
		local = out.Download != nil && out.Download.Status == "done"
	}
	// A downloaded file plays from disk: no need to wake the torrent up.
	if live && src.Status != "error" && !local {
		sctx, cancel := context.WithTimeout(ctx, s.t.StatsTimeout)
		if t, err := s.ts.Get(sctx, src.InfoHash); err == nil {
			out.Torrent = torrentStats(t)
			// Someone is waiting on it (the TV polls while loading or
			// stuck), yet TorrServer stopped fetching (e.g. after a long
			// pause): wake it, as its «Preload» button would.
			if src.Status == "ready" && src.FileIndex != nil && t.Idle() {
				s.wakeLater(src.ID, src.InfoHash, *src.FileIndex)
			}
		}
		cancel()
	}
	if live && src.Status == "ready" {
		var length float64
		if src.MediaInfo != nil && src.MediaInfo.DurationSeconds != nil {
			length = *src.MediaInfo.DurationSeconds
		}
		var season, episode *int
		if out.File != nil {
			season, episode = out.File.Season, out.File.Episode
		}
		out.Markers = s.markersFor(ctx, src, season, episode, nil, length)
	}
	// Until ffprobe reports the length, the slow-torrent hint needs the
	// release's bitrate: estimate it from the TMDB runtime (the snapshot
	// taken when the source was created may not carry it).
	if live && out.Release.EstBitrateBps == nil && (src.MediaInfo == nil || src.MediaInfo.DurationSeconds == nil) {
		out.Release.EstBitrateBps = s.estBitrate(ctx, src)
	}
	// Probe when there's no media info yet, or (once per MediaInfoRetry)
	// re-probe an older row for the newer fields — unless the file plays
	// from disk, where the torrent isn't worth waking for that.
	stale := src.MediaInfo != nil && src.MediaInfo.ProbeVersion < mediaInfoVersion && !local
	if live && src.Status == "ready" && (src.MediaInfo == nil || stale) && src.FileIndex != nil {
		s.probeLater(src.ID, src.InfoHash, *src.FileIndex)
	}
	return out
}

// estBitrate is the playing file's size × 8 / the TMDB runtime of the film
// or episode, bits/s; nil when either is unknown. Before a file is chosen
// only a single-title release has a meaningful size.
func (s *Service) estBitrate(ctx context.Context, src *source) *float64 {
	var size int64
	switch {
	case src.FileSize != nil:
		size = *src.FileSize
	case src.EpisodeID == nil:
		size = src.Release.SizeBytes
	}
	if size <= 0 {
		return nil
	}
	minutes, err := s.st.runtime(ctx, src.MediaID, src.EpisodeID)
	if err != nil || minutes <= 0 {
		return nil
	}
	v := math.Round(float64(size) * 8 / float64(minutes*60))
	return &v
}

// wakeIdleEvery: at most one preload per source this often.
const wakeIdleEvery = time.Minute

// wakeLater asks TorrServer to preload an idle torrent in the background.
func (s *Service) wakeLater(id, hash string, index int) {
	s.mu.Lock()
	if last, ok := s.waking[id]; ok && time.Since(last) < wakeIdleEvery {
		s.mu.Unlock()
		return
	}
	if len(s.waking) > 1000 {
		s.waking = map[string]time.Time{}
	}
	s.waking[id] = time.Now()
	s.mu.Unlock()
	s.log.Info("torrent idle: preloading", "source_id", id)
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		if err := s.ts.Preload(ctx, hash, index); err != nil && !errors.Is(err, context.DeadlineExceeded) {
			s.log.Info("preload failed", "source_id", id, "err", err)
		}
	}()
}

// probeLater fetches media info via TorrServer's ffprobe in the background
// (at most one attempt per source per MediaInfoRetry).
func (s *Service) probeLater(id, hash string, index int) {
	s.mu.Lock()
	if last, ok := s.probing[id]; ok && time.Since(last) < s.t.MediaInfoRetry {
		s.mu.Unlock()
		return
	}
	s.probing[id] = time.Now()
	s.mu.Unlock()
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		p, err := s.ts.FFProbe(ctx, hash, index)
		if err != nil {
			if !errors.Is(err, torrserver.ErrUnsupported) {
				s.log.Info("ffprobe failed", "source_id", id, "err", err)
			}
			return
		}
		if err := s.st.setMediaInfo(ctx, id, index, mediaInfoFrom(p)); err != nil {
			s.log.Warn("store media info", "source_id", id, "err", err)
		}
	}()
}

func mediaInfoFrom(p *torrserver.Probe) *MediaInfo {
	mi := &MediaInfo{Audio: []MediaStream{}, Subtitles: []MediaStream{}, ProbeVersion: mediaInfoVersion}
	if p.Format.FormatName != "" {
		c := p.Format.FormatName
		mi.Container = &c
	}
	if d, err := strconv.ParseFloat(p.Format.Duration, 64); err == nil && d > 0 {
		mi.DurationSeconds = &d
	}
	if len(p.Chapters) <= maxChapters {
		for _, c := range p.Chapters {
			if t := strings.TrimSpace(c.Tags["title"]); t != "" && c.EndTime > c.StartTime {
				mi.Chapters = append(mi.Chapters, MediaChapter{StartSeconds: float64(c.StartTime), EndSeconds: float64(c.EndTime), Title: truncRunes(t, 80)})
			}
		}
	}
	for _, st := range p.Streams {
		ms := MediaStream{Index: st.Index, Codec: st.CodecName, Default: st.Disposition["default"] == 1}
		if l := st.Tags["language"]; l != "" && l != "und" {
			ms.Language = &l
		}
		if t := st.Tags["title"]; t != "" {
			ms.Title = &t
		}
		switch st.CodecType {
		case "video":
			if mi.VideoCodec == nil && st.Disposition["attached_pic"] != 1 {
				c, w, h := st.CodecName, st.Width, st.Height
				mi.VideoCodec, mi.Width, mi.Height = &c, &w, &h
				videoDetails(mi, st.Profile, st.PixFmt, st.BitsPerRawSample, st.Level, st.FieldOrder)
				if st.MimeCodec != "" {
					mc := st.MimeCodec
					mi.VideoCodecString = &mc
				}
			}
		case "audio":
			if st.Channels > 0 {
				ch := st.Channels
				ms.Channels = &ch
			}
			mi.Audio = append(mi.Audio, ms)
		case "subtitle":
			mi.Subtitles = append(mi.Subtitles, ms)
		}
	}
	return mi
}

// videoDetails fills the video profile fields. The bit depth comes from
// pix_fmt ("yuv420p10le" → 10, "p010le" → 10, plain formats → 8), else from
// bits_per_raw_sample, else from the profile name ("High 10", "Main 10").
func videoDetails(mi *MediaInfo, profile, pixFmt, rawBits string, level int, fieldOrder string) {
	if profile != "" && profile != "unknown" {
		mi.VideoProfile = &profile
	}
	if pixFmt != "" && pixFmt != "unknown" {
		mi.PixFmt = &pixFmt
	}
	if level > 0 {
		mi.VideoLevel = &level
	}
	bits := pixFmtDepth(pixFmt)
	if bits == 0 {
		if n, err := strconv.Atoi(rawBits); err == nil && n > 0 && n <= 16 {
			bits = n
		}
	}
	if bits == 0 {
		switch pl := strings.ToLower(profile); {
		case strings.Contains(pl, "12"):
			bits = 12
		case strings.Contains(pl, "10"):
			bits = 10
		}
	}
	if bits > 0 {
		mi.BitDepth = &bits
	}
	switch fieldOrder {
	case "progressive":
		f := false
		mi.Interlaced = &f
	case "tt", "bb", "tb", "bt":
		t := true
		mi.Interlaced = &t
	}
}

// pixFmtBitsRe: the depth suffix of a planar pix_fmt (yuv420p10le, gbrp12be,
// yuva444p16le, gray10le…).
var pixFmtBitsRe = regexp.MustCompile(`[a-z](9|10|12|14|16)(?:le|be)?$`)

// pixFmtDepth: the bit depth a pix_fmt name implies, 0 if unknown.
func pixFmtDepth(f string) int {
	f = strings.ToLower(f)
	switch {
	case f == "" || f == "unknown":
		return 0
	case f == "nv12" || f == "nv21" || f == "nv16" || f == "nv24":
		return 8
	case strings.HasPrefix(f, "p010"):
		return 10
	case strings.HasPrefix(f, "p012"):
		return 12
	case strings.HasPrefix(f, "p016"):
		return 16
	}
	if m := pixFmtBitsRe.FindStringSubmatch(f); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	if strings.HasPrefix(f, "yuv") || strings.HasPrefix(f, "nv12") || strings.HasPrefix(f, "nv21") || f == "gray" ||
		f == "rgb24" || f == "bgr24" || f == "gbrp" {
		return 8
	}
	return 0
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
