package main

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// AudioCache keeps whole YouTube audio files on disk. Every played or
// prefetched track is downloaded in the background, so replays, seeking and
// the next track in the queue never wait on YouTube (or on the VPN that
// Invidious reaches it through). Least recently played files are evicted
// above the size limit.
type AudioCache struct {
	dir      string
	maxBytes int64

	mu       sync.Mutex
	inflight map[string]bool
	sem      chan struct{}
	evicting bool
}

func newAudioCache(dir string, maxBytes int64) *AudioCache {
	_ = os.MkdirAll(dir, 0o700)
	// Leftovers of interrupted downloads.
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".part") {
			_ = os.Remove(p)
		}
		return nil
	})
	return &AudioCache{dir: dir, maxBytes: maxBytes, inflight: map[string]bool{}, sem: make(chan struct{}, 2)}
}

func (c *AudioCache) file(videoID, ext string) string {
	return filepath.Join(c.dir, videoID[:2], videoID+"."+ext)
}

// Lookup returns the cached file and its MIME type.
func (c *AudioCache) Lookup(videoID string) (string, string, bool) {
	if !validVideoID(videoID) {
		return "", "", false
	}
	for ext, mime := range map[string]string{"m4a": "audio/mp4", "webm": "audio/webm"} {
		p := c.file(videoID, ext)
		if _, err := os.Stat(p); err == nil {
			return p, mime, true
		}
	}
	return "", "", false
}

// Fetch downloads a video's audio into the cache in the background (no-op
// when cached or already downloading).
func (a *App) cacheAudio(videoID string) {
	c := a.cache
	if c == nil || !validVideoID(videoID) {
		return
	}
	if _, _, ok := c.Lookup(videoID); ok {
		return
	}
	c.mu.Lock()
	if c.inflight[videoID] {
		c.mu.Unlock()
		return
	}
	c.inflight[videoID] = true
	c.mu.Unlock()
	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.inflight, videoID)
			c.mu.Unlock()
		}()
		c.sem <- struct{}{}
		defer func() { <-c.sem }()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		if err := a.downloadAudio(ctx, videoID); err != nil {
			a.log.Info("audio cache download failed", "video", videoID, "err", err.Error())
			return
		}
		a.evict()
	}()
}

func (a *App) downloadAudio(ctx context.Context, videoID string) error {
	au, err := a.yt.audio(ctx, videoID, false)
	if err != nil {
		return err
	}
	if au.Size <= 0 || au.Size > 300<<20 {
		return errors.New("unknown or too large size")
	}
	ext := "m4a"
	if au.Mime == "audio/webm" {
		ext = "webm"
	}
	final := a.cache.file(videoID, ext)
	if err := os.MkdirAll(filepath.Dir(final), 0o700); err != nil {
		return err
	}
	tmp := final + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		f.Close()
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	var pos int64
	fails := 0
	for pos < au.Size {
		to := min(au.Size-1, pos+ytChunk-1)
		body, err := a.ytChunk(ctx, videoID, &au, pos, to)
		if err == nil {
			var n int64
			n, err = io.Copy(f, body)
			body.Close()
			pos += n
			if err == nil && n == 0 {
				err = errors.New("empty chunk")
			}
		}
		if err != nil {
			fails++
			if fails > 4 || ctx.Err() != nil {
				return err
			}
			// Resume where it stopped.
			if _, serr := f.Seek(pos, io.SeekStart); serr != nil {
				return serr
			}
			if terr := f.Truncate(pos); terr != nil {
				return terr
			}
			time.Sleep(time.Duration(fails) * 2 * time.Second)
			continue
		}
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, final); err != nil {
		return err
	}
	ok = true
	return nil
}

// serveCached answers from the cache with full Range support.
func (a *App) serveCached(w http.ResponseWriter, r *http.Request, videoID string) bool {
	if a.cache == nil {
		return false
	}
	p, mime, ok := a.cache.Lookup(videoID)
	if !ok {
		return false
	}
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	t := time.Now()
	_ = os.Chtimes(p, t, t) // LRU: recently played files stay
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "", fi.ModTime(), f)
	return true
}

// evict removes the least recently played files above the limit.
func (a *App) evict() {
	c := a.cache
	c.mu.Lock()
	if c.evicting {
		c.mu.Unlock()
		return
	}
	c.evicting = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.evicting = false
		c.mu.Unlock()
	}()
	type ent struct {
		path string
		size int64
		mod  time.Time
	}
	var all []ent
	var total int64
	_ = filepath.WalkDir(c.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.HasSuffix(p, ".part") {
			return nil
		}
		if fi, err := d.Info(); err == nil {
			all = append(all, ent{p, fi.Size(), fi.ModTime()})
			total += fi.Size()
		}
		return nil
	})
	if total <= c.maxBytes {
		return
	}
	sort.Slice(all, func(i, j int) bool { return all[i].mod.Before(all[j].mod) })
	target := c.maxBytes * 9 / 10
	for _, e := range all {
		if total <= target {
			break
		}
		if os.Remove(e.path) == nil {
			total -= e.size
		}
	}
	a.log.Info("audio cache evicted", "bytes", total)
}
