package video

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/singleflight"
)

// thumbCache is the thumbnail proxy's disk cache: files under
// dir/<xx>/<sha256(path)>, bounded by size (least recently used go first)
// and age (unused for maxAge). A file's mtime is its last use, so the order
// survives restarts. Misses are fetched once however many viewers ask at
// the same time (single-flight); at most fgSlots upstream fetches run for
// viewers, and prefetches (warm) use their own bgWorkers so a row of
// thumbnails being prepared never delays one somebody is looking at.
type thumbCache struct {
	dir    string
	max    int64 // bytes; 0 = no disk cache
	maxAge time.Duration
	fetch  func(ctx context.Context, path string) (string, []byte, error)
	now    func() time.Time

	mu     sync.Mutex
	idx    map[string]*thumbEntry
	total  int64
	loaded bool // the startup scan finished (eviction waits for it)

	group singleflight.Group
	fg    chan struct{}
	queue chan string
	bad   sync.Map // name → time.Time of a failed fetch

	fetches atomic.Int64 // upstream fetches (tests, logs)
}

type thumbEntry struct {
	size int64
	used time.Time
}

const (
	thumbFgSlots   = 8
	thumbBgWorkers = 4
	thumbQueue     = 256
	// A hit refreshes the file's mtime at most this often.
	thumbTouchEvery = time.Hour
	thumbFetchWait  = 15 * time.Second
)

func newThumbCache(dir string, maxBytes int64, maxAge time.Duration, fetch func(context.Context, string) (string, []byte, error)) *thumbCache {
	if dir == "" {
		maxBytes = 0
	}
	return &thumbCache{dir: dir, max: maxBytes, maxAge: maxAge, fetch: fetch, now: time.Now,
		idx: map[string]*thumbEntry{}, fg: make(chan struct{}, thumbFgSlots), queue: make(chan string, thumbQueue)}
}

func thumbKey(path string) string {
	k := sha256.Sum256([]byte(path))
	return hex.EncodeToString(k[:])
}

func (c *thumbCache) file(name string) string { return filepath.Join(c.dir, name[:2], name) }

// get returns a cached image and marks it used.
func (c *thumbCache) get(name string) ([]byte, string, bool) {
	if c.max <= 0 {
		return nil, "", false
	}
	f := c.file(name)
	b, err := os.ReadFile(f)
	if err != nil {
		return nil, "", false
	}
	ct := sniffThumb(b)
	if ct == "" {
		_ = os.Remove(f)
		return nil, "", false
	}
	now := c.now()
	c.mu.Lock()
	e := c.idx[name]
	if e == nil {
		e = &thumbEntry{size: int64(len(b))}
		c.idx[name] = e
		c.total += e.size
	}
	touch := now.Sub(e.used) > thumbTouchEvery
	e.used = now
	c.mu.Unlock()
	if touch {
		_ = os.Chtimes(f, now, now)
	}
	return b, ct, true
}

// has reports whether the image is cached (no read).
func (c *thumbCache) has(name string) bool {
	if c.max <= 0 {
		return false
	}
	c.mu.Lock()
	_, ok := c.idx[name]
	loaded := c.loaded
	c.mu.Unlock()
	if ok || loaded {
		return ok
	}
	_, err := os.Stat(c.file(name))
	return err == nil
}

func (c *thumbCache) put(name string, b []byte) {
	if c.max <= 0 || int64(len(b)) > c.max {
		return
	}
	f := c.file(name)
	if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(f), ".tmp-*")
	if err != nil {
		return
	}
	_, werr := tmp.Write(b)
	if cerr := tmp.Close(); werr != nil || cerr != nil || os.Rename(tmp.Name(), f) != nil {
		_ = os.Remove(tmp.Name())
		return
	}
	c.mu.Lock()
	if e := c.idx[name]; e != nil {
		c.total -= e.size
	}
	c.idx[name] = &thumbEntry{size: int64(len(b)), used: c.now()}
	c.total += int64(len(b))
	over := c.loaded && c.total > c.max
	c.mu.Unlock()
	if over {
		c.evict()
	}
}

// bad: a failed fetch is not retried for thumbBadTTL.
func (c *thumbCache) isBad(name string) bool {
	at, ok := c.bad.Load(name)
	return ok && c.now().Sub(at.(time.Time)) < thumbBadTTL
}

// load is the image for a viewer: from disk, else fetched (one fetch per
// path at a time, at most thumbFgSlots at once).
func (c *thumbCache) load(ctx context.Context, path string) ([]byte, string, error) {
	name := thumbKey(path)
	if b, ct, ok := c.get(name); ok {
		return b, ct, nil
	}
	if c.isBad(name) {
		return nil, "", errThumbBad
	}
	v, err, _ := c.group.Do(name, func() (any, error) {
		select {
		case c.fg <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		defer func() { <-c.fg }()
		return c.fill(ctx, name, path)
	})
	if err != nil {
		return nil, "", err
	}
	r := v.(thumbResult)
	return r.b, r.ct, nil
}

type thumbResult struct {
	ct string
	b  []byte
}

type thumbErr string

func (e thumbErr) Error() string { return string(e) }

const errThumbBad = thumbErr("thumbnail recently failed")

func (c *thumbCache) fill(ctx context.Context, name, path string) (any, error) {
	// A prefetch (or another viewer) may have filled it meanwhile.
	if b, ct, ok := c.get(name); ok {
		return thumbResult{ct, b}, nil
	}
	c.fetches.Add(1)
	ct, b, err := c.fetch(ctx, path)
	if err != nil {
		c.bad.Store(name, c.now())
		return nil, err
	}
	c.put(name, b)
	return thumbResult{ct, b}, nil
}

// warm queues paths to fetch ahead of the viewer (the rest of a list just
// sent): skipped when cached, recently failed or the queue is full.
func (c *thumbCache) warm(paths ...string) {
	for _, p := range paths {
		name := thumbKey(p)
		if c.has(name) || c.isBad(name) {
			continue
		}
		select {
		case c.queue <- p:
		default:
			return
		}
	}
}

// runWarm drains the prefetch queue with thumbBgWorkers workers.
func (c *thumbCache) runWarm(ctx context.Context) {
	var wg sync.WaitGroup
	for range thumbBgWorkers {
		wg.Go(func() {
			for {
				select {
				case <-ctx.Done():
					return
				case p := <-c.queue:
					name := thumbKey(p)
					if c.has(name) || c.isBad(name) {
						continue
					}
					fctx, cancel := context.WithTimeout(ctx, thumbFetchWait)
					_, _, _ = c.group.Do(name, func() (any, error) { return c.fill(fctx, name, p) })
					cancel()
				}
			}
		})
	}
	wg.Wait()
}

// scan indexes the files on disk (mtime = last use) and applies the limits.
func (c *thumbCache) scan() {
	if c.max <= 0 {
		return
	}
	found := map[string]*thumbEntry{}
	_ = filepath.WalkDir(c.dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		name := d.Name()
		if len(name) != 64 { // .tmp-* leftovers of a crash
			if c.now().Sub(info.ModTime()) > time.Hour {
				_ = os.Remove(p)
			}
			return nil
		}
		found[name] = &thumbEntry{size: info.Size(), used: info.ModTime()}
		return nil
	})
	c.mu.Lock()
	for name, e := range found {
		if cur, ok := c.idx[name]; ok {
			c.total -= cur.size
			if cur.used.After(e.used) {
				e.used = cur.used
			}
		}
		c.idx[name] = e
		c.total += e.size
	}
	c.loaded = true
	c.mu.Unlock()
	c.evict()
}

// evict removes images unused for maxAge, then the least recently used
// until the cache is at 90 % of its size (so one new file doesn't evict
// every time).
func (c *thumbCache) evict() {
	cutoff := c.now().Add(-c.maxAge)
	c.mu.Lock()
	type kv struct {
		name string
		e    *thumbEntry
	}
	all := make([]kv, 0, len(c.idx))
	for n, e := range c.idx {
		all = append(all, kv{n, e})
	}
	slices.SortFunc(all, func(a, b kv) int { return a.e.used.Compare(b.e.used) })
	over := c.total > c.max
	target := c.max * 9 / 10
	var drop []string
	for _, x := range all {
		// Oldest first: past the expired ones, only an over-full cache shrinks.
		if !x.e.used.Before(cutoff) && (!over || c.total <= target) {
			break
		}
		drop = append(drop, x.name)
		c.total -= x.e.size
		delete(c.idx, x.name)
	}
	c.mu.Unlock()
	for _, n := range drop {
		_ = os.Remove(c.file(n))
	}
}

// stats: files and bytes in the cache.
func (c *thumbCache) stats() (int, int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.idx), c.total
}
