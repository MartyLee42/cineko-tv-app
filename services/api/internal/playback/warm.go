package playback

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"martytv/api/internal/integrations/torrserver"
	"martytv/api/internal/releases"
)

// Instant play («Мгновенный старт»). A title page that stays open for a
// couple of seconds sends POST /playback/warm with the release its Play
// would start (the client ranks releases for its own decoder, so it names
// the release; the server checks and prepares it). In the background the
// server creates the source exactly as Play would (s.create: TorrServer add,
// metadata, file choice), reads a small head of the file (or of the resume
// point) through TorrServer and keeps a reader open for a while so the
// torrent stays connected. Play (Create) with the same title / episode /
// release then gets that ready source at once — no resolve, no TorrServer
// round trip — and the TV skips straight to «starting».
//
// Limits: one warm per profile (a newer one replaces it), WarmMax per
// server; skipped when the admin switched it off, the server is busy
// (streams / transcoding), the file is already downloaded, or the release is
// online / unknown. A warm nobody played is dropped like a cancelled source
// (abandon: the torrent goes only when this process added it and nothing
// else uses it). Warms never create playback sessions: no history, no
// «Продолжить».

// Warm skip reasons (WarmResult.reason).
const (
	WarmSkipDisabled    = "disabled"
	WarmSkipBusy        = "busy"
	WarmSkipLimit       = "limit"
	WarmSkipLocal       = "local"
	WarmSkipOnline      = "online"
	WarmSkipNoRelease   = "no_release"
	WarmSkipUnavailable = "unavailable"
)

// WarmSettings are the instant-play knobs (tests shorten them).
type WarmSettings struct {
	TTL         time.Duration // the prepared source waits for Play this long
	Hold        time.Duration // a TorrServer reader keeps the torrent connected this long
	Grace       time.Duration // a cancelled / replaced warm is dropped after this (Play may be on its way)
	Bridge      time.Duration // after Play takes it, the reader stays open this long (until the player reads)
	HeadBytes   int64         // read ahead of Play
	Max         int           // warms at a time per server
	BusyStreams int           // skip while this many torrents are being streamed
}

// DefaultWarmSettings: TorrServer's own cache (128 MB by default) bounds
// what an open reader prefetches; 2 warms × that is the worst case.
func DefaultWarmSettings() WarmSettings {
	return WarmSettings{TTL: 12 * time.Minute, Hold: 4 * time.Minute, Grace: 15 * time.Second, Bridge: 30 * time.Second,
		HeadBytes: 16 << 20, Max: 2, BusyStreams: 3}
}

// WarmInput is the POST /playback/warm body.
type WarmInput struct {
	MediaID   string  `json:"media_id"`
	EpisodeID *string `json:"episode_id"`
	ProfileID string  `json:"profile_id"`
	ReleaseID string  `json:"release_id"`
	// SourceID instead of ReleaseID: «Продолжить» plays the source the
	// title was last watched with (its release and episode are used).
	SourceID *string `json:"source_id"`
	// StartSeconds: the resume position Play will start at (0 = the start).
	StartSeconds float64 `json:"start_seconds"`
}

// WarmResult is the POST /playback/warm answer.
type WarmResult struct {
	Status    string     `json:"status"` // warming | skipped
	Reason    *string    `json:"reason"`
	ExpiresAt *time.Time `json:"expires_at"`
}

type warmEntry struct {
	userID, profileID, mediaID, releaseID string
	episodeID                             *string
	sourceID, hash                        string
	expires                               time.Time
	active                                bool // preparing / holding a reader: counts toward Max
	ended                                 bool // cancelled / replaced / expired: dropped after Grace unless played
	claimed                               bool // Play took it
	ctx                                   context.Context
	stop                                  context.CancelFunc
	timer                                 *time.Timer
	set                                   WarmSettings // as when it started (runWarm reads it unlocked)
}

func (e *warmEntry) sameTarget(media string, episode *string, release string) bool {
	return e.mediaID == media && deref(e.episodeID) == deref(episode) && e.releaseID == release
}

type warmer struct {
	mu      sync.Mutex
	root    context.Context // every warm's context; endAll cancels it
	stopAll context.CancelFunc
	set     WarmSettings
	enabled func(context.Context) bool
	entries []*warmEntry
	counts  map[string]*atomic.Uint64
}

// warmResults are the cineko_instant_play_total{result} values.
var warmResults = []string{"started", "hit", "miss", "cancelled", "expired", "failed", "skipped"}

func newWarmer() *warmer {
	w := &warmer{set: DefaultWarmSettings(), counts: map[string]*atomic.Uint64{}}
	w.root, w.stopAll = context.WithCancel(context.Background())
	for _, r := range warmResults {
		w.counts[r] = &atomic.Uint64{}
	}
	return w
}

func (w *warmer) inc(result string) { w.counts[result].Add(1) }

// SetInstantPlay connects the admin switch «Мгновенный старт» (nil = on).
func (s *Service) SetInstantPlay(enabled func(context.Context) bool) {
	s.warm.mu.Lock()
	s.warm.enabled = enabled
	s.warm.mu.Unlock()
}

// SetWarmSettings replaces the instant-play knobs (tests).
func (s *Service) SetWarmSettings(set WarmSettings) {
	s.warm.mu.Lock()
	s.warm.set = set
	s.warm.mu.Unlock()
}

// InstantPlayStats: warm outcomes since start (/metrics).
func (s *Service) InstantPlayStats() map[string]uint64 {
	out := make(map[string]uint64, len(warmResults))
	for _, r := range warmResults {
		out[r] = s.warm.counts[r].Load()
	}
	return out
}

func skipped(reason string) *WarmResult {
	return &WarmResult{Status: "skipped", Reason: &reason}
}

// transcoding: a compat stream (MP4 or HLS) is running.
func (s *Service) transcoding() bool {
	return compatStreams.Load() > 0 || s.hls.any()
}

// Warm prepares the release Play would start for this profile (see above).
func (s *Service) Warm(ctx context.Context, who caller, in WarmInput, log *slog.Logger) (*WarmResult, error) {
	w := s.warm
	w.mu.Lock()
	enabled, set := w.enabled, w.set
	w.mu.Unlock()
	if in.SourceID != nil {
		src, err := s.load(ctx, who, *in.SourceID)
		if err != nil {
			return nil, err
		}
		if src.MediaID != in.MediaID || (src.Kind != "" && src.Kind != "torrent") {
			w.inc("skipped")
			return skipped(WarmSkipNoRelease), nil
		}
		in.ReleaseID, in.EpisodeID = src.ReleaseID, src.EpisodeID
	}
	ci := CreateInput{MediaID: in.MediaID, ReleaseID: in.ReleaseID, EpisodeID: in.EpisodeID, ProfileID: &in.ProfileID}
	if _, _, err := s.checkCreate(ctx, who, ci); err != nil {
		return nil, err
	}
	skip := func(reason string) (*WarmResult, error) {
		w.inc("skipped")
		log.Debug("instant play skipped", "reason", reason, "media_id", in.MediaID)
		return skipped(reason), nil
	}
	if enabled != nil && !enabled(ctx) {
		return skip(WarmSkipDisabled)
	}
	if isOnlineRelease(in.ReleaseID) {
		return skip(WarmSkipOnline)
	}
	if s.releases == nil || !s.ts.Configured() {
		return skip(WarmSkipUnavailable)
	}
	// The same page again (back from the player, a re-render): keep it.
	if exp, ok := w.renew(who.UserID, in); ok {
		return &WarmResult{Status: "warming", ExpiresAt: &exp}, nil
	}
	if len(s.StreamingHashes()) >= set.BusyStreams || s.transcoding() {
		return skip(WarmSkipBusy)
	}
	res, err := s.releases.Resolve(ctx, in.MediaID, in.ReleaseID)
	if errors.Is(err, releases.ErrReleaseNotFound) || (err == nil && (res == nil || res.MediaID != in.MediaID)) {
		return skip(WarmSkipNoRelease)
	}
	if err != nil {
		return skip(WarmSkipUnavailable)
	}
	hash := strings.ToLower(deref(res.Release.InfoHash))
	if !torrserver.ValidHash(hash) {
		hash = magnetHash(res.MagnetURI)
	}
	if s.lib != nil && torrserver.ValidHash(hash) && s.lib.HasCompleted(ctx, hash) {
		return skip(WarmSkipLocal) // plays from disk anyway
	}
	e := w.start(s, who.UserID, in)
	if e == nil {
		return skip(WarmSkipLimit)
	}
	w.inc("started")
	log.Info("instant play: warming", "media_id", in.MediaID, "release_id", in.ReleaseID, "profile_id", in.ProfileID)
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		s.runWarm(e, who, ci, in.StartSeconds, log)
	}()
	exp := e.expires
	return &WarmResult{Status: "warming", ExpiresAt: &exp}, nil
}

// renew: this profile already warms exactly this; extends it.
func (w *warmer) renew(userID string, in WarmInput) (time.Time, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, e := range w.entries {
		if !e.ended && !e.claimed && e.userID == userID && e.profileID == in.ProfileID && e.sameTarget(in.MediaID, in.EpisodeID, in.ReleaseID) {
			e.expires = time.Now().Add(w.set.TTL)
			e.timer.Reset(w.set.TTL)
			return e.expires, true
		}
	}
	return time.Time{}, false
}

// start registers a warm, replacing the profile's previous one; nil at the
// server limit.
func (w *warmer) start(s *Service, userID string, in WarmInput) *warmEntry {
	w.mu.Lock()
	defer w.mu.Unlock()
	var prev *warmEntry
	active := 0
	for _, e := range w.entries {
		if e.ended || e.claimed {
			continue
		}
		if e.profileID == in.ProfileID {
			prev = e
			continue
		}
		if e.active {
			active++
		}
	}
	if active >= w.set.Max {
		return nil
	}
	if prev != nil {
		w.endLocked(s, prev, "cancelled")
	}
	ctx, stop := context.WithCancel(w.root)
	e := &warmEntry{userID: userID, profileID: in.ProfileID, mediaID: in.MediaID, episodeID: in.EpisodeID, releaseID: in.ReleaseID,
		expires: time.Now().Add(w.set.TTL), active: true, ctx: ctx, stop: stop, set: w.set}
	e.timer = time.AfterFunc(w.set.TTL, func() { w.end(s, e, "expired") })
	w.entries = append(w.entries, e)
	return e
}

func (w *warmer) end(s *Service, e *warmEntry, result string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.endLocked(s, e, result)
}

// endLocked stops a warm; unless Play takes it within Grace, its source is
// abandoned (cancel.go). result "" = shutdown: no drop, no count.
func (w *warmer) endLocked(s *Service, e *warmEntry, result string) {
	if e.ended || e.claimed {
		return
	}
	e.ended, e.active = true, false
	e.stop()
	e.timer.Stop()
	if result == "" {
		w.removeLocked(e)
		return
	}
	w.inc(result)
	time.AfterFunc(w.set.Grace, func() {
		w.mu.Lock()
		drop := !e.claimed
		w.removeLocked(e)
		id, hash := e.sourceID, e.hash
		w.mu.Unlock()
		if drop && id != "" {
			s.abandon(id, hash)
		}
	})
}

func (w *warmer) removeLocked(e *warmEntry) {
	for i, x := range w.entries {
		if x == e {
			w.entries = append(w.entries[:i], w.entries[i+1:]...)
			return
		}
	}
}

// claimLocked: Play took e (hit); the reader stays open for Bridge.
func (w *warmer) claimLocked(e *warmEntry) {
	if e.claimed {
		return
	}
	e.claimed = true
	e.timer.Stop()
	w.removeLocked(e)
	w.inc("hit")
	stop := e.stop
	time.AfterFunc(w.set.Bridge, stop)
}

// endAll stops every warm without dropping (shutdown, tests).
func (w *warmer) endAll(s *Service) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, e := range append([]*warmEntry(nil), w.entries...) {
		w.endLocked(s, e, "")
	}
	w.entries = nil
	w.stopAll() // also the readers of warms Play already took
	w.root, w.stopAll = context.WithCancel(context.Background())
}

// CancelWarm: the viewer left the title page (DELETE /playback/warm).
func (s *Service) CancelWarm(who caller, profileID string) {
	w := s.warm
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, e := range append([]*warmEntry(nil), w.entries...) {
		if !e.ended && !e.claimed && e.userID == who.UserID && e.profileID == profileID {
			w.endLocked(s, e, "cancelled")
		}
	}
}

// warmHit: a warm of exactly this (user, title, episode, release) has its
// source: Play gets it as is.
func (s *Service) warmHit(ctx context.Context, who caller, in CreateInput, log *slog.Logger) *PlaybackSource {
	if in.Kind != "" && in.Kind != "release" {
		return nil
	}
	w := s.warm
	w.mu.Lock()
	var e *warmEntry
	for _, x := range w.entries {
		if !x.claimed && x.sourceID != "" && x.userID == who.UserID && x.sameTarget(in.MediaID, in.EpisodeID, in.ReleaseID) {
			e = x
			break
		}
	}
	w.mu.Unlock()
	if e == nil {
		return nil
	}
	src, err := s.st.get(ctx, e.sourceID)
	if err != nil || src.Status == "error" || src.CreatedByUserID != who.UserID {
		return nil
	}
	if in.ProfileID != nil {
		if ok, err := s.st.profileAccessible(ctx, *in.ProfileID, who.UserID, who.DeviceID); err != nil || !ok {
			return nil // the regular path answers the validation error
		}
	}
	w.mu.Lock()
	if e.claimed {
		w.mu.Unlock()
		return nil
	}
	w.claimLocked(e)
	w.mu.Unlock()
	if src.Status == "preparing" {
		if tgt, err := s.targetFor(ctx, src); err == nil {
			s.ensurePreparing(src, tgt)
		}
	}
	log.Info("instant play: hit", "source_id", src.ID, "status", src.Status)
	return s.present(ctx, src, false)
}

// warmPlayed: Play created / reused source id the regular way. A warm of
// it (still preparing) is a hit; a warm of the same title with another
// release a miss (and is dropped).
func (s *Service) warmPlayed(who caller, in CreateInput, id string) {
	w := s.warm
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, e := range append([]*warmEntry(nil), w.entries...) {
		if e.claimed || e.userID != who.UserID {
			continue
		}
		switch {
		case e.sourceID == id || (e.sourceID == "" && e.sameTarget(in.MediaID, in.EpisodeID, in.ReleaseID)):
			w.claimLocked(e)
		case e.mediaID == in.MediaID && deref(e.episodeID) == deref(in.EpisodeID) && !e.ended:
			w.endLocked(s, e, "miss")
		}
	}
}

// warmGot: GET /playback/sources/{id} of a warm source («Продолжить» plays
// a source by id, without POST): Play took it.
func (s *Service) warmGot(who caller, id string) {
	w := s.warm
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, e := range w.entries {
		if e.sourceID == id && e.userID == who.UserID {
			w.claimLocked(e)
			return
		}
	}
}

// runWarm prepares the source like Play, then reads its head and holds the
// reader (until Hold, the end of the warm or Bridge after Play).
func (s *Service) runWarm(e *warmEntry, who caller, ci CreateInput, startAt float64, log *slog.Logger) {
	w := s.warm
	log = log.With("warm_media_id", ci.MediaID, "release_id", ci.ReleaseID)
	fail := func(msg string, args ...any) {
		log.Info("instant play: "+msg, args...)
		w.mu.Lock()
		if !e.claimed && !e.ended {
			w.endLocked(s, e, "failed")
		}
		e.active = false
		w.mu.Unlock()
	}
	cctx, cancel := context.WithTimeout(context.Background(), s.t.MetadataTimeout+30*time.Second)
	out, err := s.create(cctx, who, ci, log)
	var src *source
	if err == nil {
		src, err = s.st.get(cctx, out.ID)
	}
	cancel()
	if err != nil {
		fail("create failed", "err", err)
		return
	}
	w.mu.Lock()
	e.sourceID, e.hash = src.ID, src.InfoHash
	gone := e.ended && !e.claimed
	w.mu.Unlock()
	if gone {
		// Cancelled while it was being created: the grace timer may have
		// fired before the id was known.
		time.AfterFunc(e.set.Grace, func() {
			w.mu.Lock()
			claimed := e.claimed
			w.mu.Unlock()
			if !claimed {
				s.abandon(src.ID, src.InfoHash)
			}
		})
		return
	}
	ctx, cancelHold := context.WithTimeout(e.ctx, e.set.Hold)
	defer cancelHold()
	for src.Status == "preparing" {
		select {
		case <-ctx.Done():
			w.mu.Lock()
			e.active = false
			w.mu.Unlock()
			return
		case <-time.After(s.t.PollInterval):
		}
		if src, err = s.st.get(ctx, src.ID); err != nil {
			fail("source lookup failed", "err", err)
			return
		}
	}
	if src.Status != "ready" || src.FileIndex == nil {
		fail("source failed", "error", deref(src.ErrorCode))
		return
	}
	// Media info (audio tracks, length) is known by Play time.
	if src.MediaInfo == nil {
		s.probeLater(src.ID, src.InfoHash, *src.FileIndex)
	}
	s.holdHead(ctx, src, startAt, e.set.HeadBytes, log)
	w.mu.Lock()
	e.active = false
	w.mu.Unlock()
}

// holdHead reads HeadBytes from the start (or just before the resume
// point) through TorrServer and keeps the response open until ctx ends:
// TorrServer keeps an open torrent connected and fills its cache ahead of
// the reader (bounded by its CacheSize).
func (s *Service) holdHead(ctx context.Context, src *source, startAt float64, head int64, log *slog.Logger) {
	off := warmOffset(src, startAt)
	resp, err := s.ts.Stream(ctx, src.InfoHash, *src.FileIndex, "bytes="+strconv.FormatInt(off, 10)+"-", "")
	if err != nil {
		if ctx.Err() == nil {
			log.Info("instant play: head read failed", "err", err)
		}
		return
	}
	defer resp.Body.Close()
	t0 := time.Now()
	n, _ := io.CopyN(io.Discard, resp.Body, head)
	log.Info("instant play: warm", "source_id", src.ID, "head_bytes", n, "offset", off, "took_ms", time.Since(t0).Milliseconds())
	<-ctx.Done()
}

// warmOffset: where Play will start reading — the file start, or (resume)
// a little before the position's share of the file.
func warmOffset(src *source, startAt float64) int64 {
	if startAt <= 0 || src.FileSize == nil || src.MediaInfo == nil || src.MediaInfo.DurationSeconds == nil || *src.MediaInfo.DurationSeconds <= 0 {
		return 0
	}
	frac := startAt / *src.MediaInfo.DurationSeconds
	if frac >= 1 {
		return 0
	}
	off := int64(float64(*src.FileSize)*frac) - 4<<20
	if off < 0 {
		return 0
	}
	return off
}
