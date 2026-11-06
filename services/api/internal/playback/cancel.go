package playback

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"martytv/api/internal/integrations/torrserver"
)

// Cancelling a source the viewer gave up on while it was loading
// (DELETE /playback/sources/{id}): the preparer stops and, when this server
// added the torrent to TorrServer for this very source (it wasn't there
// before) and nothing else uses it, the torrent is removed again so it stops
// downloading. Torrents that were already in TorrServer (added by another
// app, another source, a download) are never touched.

// freshFor: how long after creation a source still counts as "ours to undo".
const freshFor = time.Hour

// markFresh records that this process added src's torrent for it.
func (s *Service) markFresh(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, at := range s.fresh {
		if now.Sub(at) > freshFor {
			delete(s.fresh, k)
		}
	}
	s.fresh[id] = now
}

func (s *Service) takeFresh(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	at, ok := s.fresh[id]
	delete(s.fresh, id)
	return ok && time.Since(at) <= freshFor
}

// stopPreparing cancels a running preparer of the source (no-op otherwise).
func (s *Service) stopPreparing(id string) {
	s.mu.Lock()
	cancel := s.prepCancel[id]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// inTorrServer reports whether TorrServer already has the hash (unknown → true: never undo).
func (s *Service) inTorrServer(ctx context.Context, hash string) bool {
	if !torrserver.ValidHash(hash) {
		return true
	}
	_, err := s.ts.Get(ctx, hash)
	return !errors.Is(err, torrserver.ErrNotFound)
}

// Cancel stops loading a source the caller may access.
func (s *Service) Cancel(ctx context.Context, who caller, id string) error {
	src, err := s.load(ctx, who, id)
	if err != nil {
		return err
	}
	if src.Kind != "" && src.Kind != "torrent" {
		return nil
	}
	s.stopPreparing(id)
	if !s.takeFresh(id) {
		return nil
	}
	hash := src.InfoHash
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		// The TV drops its stream request just before cancelling: give the
		// server a moment to see it closed.
		for i := 0; i < 10 && s.StreamingHashes()[hash]; i++ {
			time.Sleep(300 * time.Millisecond)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		log := s.log.With("source_id", id, "hash", hash)
		if s.StreamingHashes()[hash] {
			log.Info("cancel: still streaming, torrent kept")
			return
		}
		var others bool
		if err := s.pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM playback_sources WHERE info_hash = $1 AND id <> $2)
			    OR EXISTS (SELECT 1 FROM downloads WHERE info_hash = $1)
			    OR EXISTS (SELECT 1 FROM playback_sessions WHERE source_id = $2 AND last_position >= 30)`, hash, id).Scan(&others); err != nil {
			log.Warn("cancel: usage check", "err", err)
			return
		}
		if others {
			// Another source / a download uses it, or it was already watched (Continue plays it).
			log.Info("cancel: torrent used elsewhere, kept")
			return
		}
		if _, err := s.pool.Exec(ctx, `DELETE FROM playback_sources WHERE id = $1`, id); err != nil {
			log.Warn("cancel: delete source", "err", err)
			return
		}
		if err := s.ts.Remove(ctx, hash); err != nil && !errors.Is(err, torrserver.ErrNotFound) {
			log.Warn("cancel: torrserver remove", "err", err)
			return
		}
		log.Info("cancelled: torrent removed")
	}()
	return nil
}

var btihHex = regexp.MustCompile(`(?i)btih:([0-9a-f]{40})`)

// magnetHash: the hex info hash of a magnet link ("" when it has none).
func magnetHash(uri string) string {
	if m := btihHex.FindStringSubmatch(uri); m != nil {
		return strings.ToLower(m[1])
	}
	return ""
}
