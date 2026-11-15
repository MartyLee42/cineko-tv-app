package playback

// Online MP4 through a chunk cache.
//
// TV engines read an online MP4 in short open-ended requests ("bytes=N-"):
// they take ~1 MB, hang up and ask again from a little further on. Passed
// straight through, every such request made the CDN send "to the end" as
// fast as it could, and all that sat in socket buffers was thrown away —
// ~70 Mbit/s in for a ~3 Mbit/s film. Instead the file is fetched in fixed
// chunks (bounded Range requests) kept in a shared in-memory LRU, and each
// client request is answered from them: repeats come from memory, misses
// fetch only the missing chunk, and a few chunks are read ahead of where
// the client reads.

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	mp4ChunkSize     = 2 << 20
	mp4ChunkAhead    = 3
	mp4CacheMax      = 256 << 20
	mp4FetchTimeout  = 45 * time.Second
	maxCachedMP4Meta = 500
)

// errNoRanges: the upstream ignores Range (answers 200 with the whole file).
var errNoRanges = errors.New("upstream ignores range requests")

// upstreamStatusError is an upstream answer other than 206.
type upstreamStatusError struct{ code int }

func (e upstreamStatusError) Error() string { return fmt.Sprintf("upstream status %d", e.code) }

// mp4Meta describes a cached upstream file.
type mp4Meta struct {
	size    int64
	ctype   string
	etag    string
	lastMod string
}

// mp4Fetch fetches bytes [off, end] of a file (one chunk).
type mp4Fetch func(ctx context.Context, off, end int64) ([]byte, mp4Meta, error)

type chunkKey struct {
	file string
	idx  int64
}

type mp4Chunk struct {
	key  chunkKey
	done chan struct{}
	data []byte
	err  error
	el   *list.Element // in the LRU once fetched
}

type chunkCache struct {
	max   int64
	chunk int64
	ahead int

	mu    sync.Mutex
	used  int64
	lru   *list.List // *mp4Chunk, front = most recent
	m     map[chunkKey]*mp4Chunk
	files map[string]mp4Meta
	plain map[string]bool // files whose upstream ignores Range
}

func newChunkCache(max, chunk int64, ahead int) *chunkCache {
	return &chunkCache{max: max, chunk: chunk, ahead: ahead, lru: list.New(), m: map[chunkKey]*mp4Chunk{}, files: map[string]mp4Meta{}, plain: map[string]bool{}}
}

func (cc *chunkCache) meta(file string) (mp4Meta, bool) {
	cc.mu.Lock()
	defer cc.mu.Unlock()
	m, ok := cc.files[file]
	return m, ok
}

func (cc *chunkCache) isPlain(file string) bool {
	cc.mu.Lock()
	defer cc.mu.Unlock()
	return cc.plain[file]
}

// get returns chunk idx of file, fetching it (once, shared) when missing.
// The fetch runs on its own context: a client hanging up doesn't waste it.
func (cc *chunkCache) get(ctx context.Context, file string, idx int64, fetch mp4Fetch) (*mp4Chunk, error) {
	ch := cc.start(file, idx, fetch)
	select {
	case <-ch.done:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if ch.err != nil {
		return nil, ch.err
	}
	return ch, nil
}

// prefetch starts fetching chunk idx unless it's cached or in flight.
func (cc *chunkCache) prefetch(file string, idx int64, fetch mp4Fetch) {
	if m, ok := cc.meta(file); ok && idx*cc.chunk >= m.size {
		return
	}
	cc.start(file, idx, fetch)
}

func (cc *chunkCache) start(file string, idx int64, fetch mp4Fetch) *mp4Chunk {
	k := chunkKey{file, idx}
	cc.mu.Lock()
	if ch, ok := cc.m[k]; ok {
		if ch.el != nil {
			cc.lru.MoveToFront(ch.el)
		}
		cc.mu.Unlock()
		return ch
	}
	ch := &mp4Chunk{key: k, done: make(chan struct{})}
	cc.m[k] = ch
	cc.mu.Unlock()
	go cc.fill(ch, fetch)
	return ch
}

func (cc *chunkCache) fill(ch *mp4Chunk, fetch mp4Fetch) {
	ctx, cancel := context.WithTimeout(context.Background(), mp4FetchTimeout)
	defer cancel()
	off := ch.key.idx * cc.chunk
	data, meta, err := fetch(ctx, off, off+cc.chunk-1)
	cc.mu.Lock()
	defer cc.mu.Unlock()
	defer close(ch.done)
	if err != nil {
		ch.err = err
		delete(cc.m, ch.key)
		if errors.Is(err, errNoRanges) {
			cc.plain[ch.key.file] = true
		}
		return
	}
	if old, ok := cc.files[ch.key.file]; ok && old.size != meta.size {
		// Another file behind the same key (a new rendition): forget the old chunks.
		cc.dropFileLocked(ch.key.file, ch)
	}
	if _, ok := cc.files[ch.key.file]; !ok && len(cc.files) >= maxCachedMP4Meta {
		cc.files = map[string]mp4Meta{}
	}
	cc.files[ch.key.file] = meta
	ch.data = data
	ch.el = cc.lru.PushFront(ch)
	cc.used += int64(len(data))
	for cc.used > cc.max {
		last := cc.lru.Back()
		if last == nil || last == ch.el {
			break
		}
		cc.removeLocked(last.Value.(*mp4Chunk))
	}
}

func (cc *chunkCache) removeLocked(ch *mp4Chunk) {
	if ch.el != nil {
		cc.lru.Remove(ch.el)
		ch.el = nil
		cc.used -= int64(len(ch.data))
	}
	if cc.m[ch.key] == ch {
		delete(cc.m, ch.key)
	}
}

func (cc *chunkCache) dropFileLocked(file string, keep *mp4Chunk) {
	for k, ch := range cc.m {
		if k.file == file && ch != keep && ch.el != nil {
			cc.removeLocked(ch)
		}
	}
}

// reader serves bytes [pos, end) of file from the cache.
func (cc *chunkCache) reader(file string, pos, end int64, fetch mp4Fetch) *chunkReader {
	ctx, cancel := context.WithCancel(context.Background())
	return &chunkReader{cc: cc, file: file, pos: pos, end: end, fetch: fetch, ctx: ctx, cancel: cancel}
}

type chunkReader struct {
	cc       *chunkCache
	file     string
	pos, end int64
	fetch    mp4Fetch
	ctx      context.Context
	cancel   context.CancelFunc
}

func (r *chunkReader) Read(p []byte) (int, error) {
	if r.pos >= r.end {
		return 0, io.EOF
	}
	cs := r.cc.chunk
	idx := r.pos / cs
	for i := 1; i <= r.cc.ahead && (idx+int64(i))*cs < r.end; i++ {
		r.cc.prefetch(r.file, idx+int64(i), r.fetch)
	}
	ch, err := r.cc.get(r.ctx, r.file, idx, r.fetch)
	if err != nil {
		return 0, err
	}
	from := r.pos - idx*cs
	if from >= int64(len(ch.data)) {
		return 0, io.ErrUnexpectedEOF
	}
	n := copy(p, ch.data[from:min(int64(len(ch.data)), from+(r.end-r.pos))])
	r.pos += int64(n)
	return n, nil
}

func (r *chunkReader) Close() error {
	r.cancel()
	return nil
}

var contentRangeTotal = regexp.MustCompile(`^bytes \d+-\d+/(\d+)$`)

// fetchMP4Range fetches [off, end] of u: 206 with the total size, or
// errNoRanges / upstreamStatusError. Network failures are retried like
// proxyUpstreamRetry does; a 403/410 is re-resolved once (resolve may be nil).
func fetchMP4Range(ctx context.Context, hc *http.Client, target func() (string, map[string]string), resolve func() error, off, end int64) ([]byte, mp4Meta, error) {
	failed, resolved := 0, false
	for {
		u, headers := target()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, mp4Meta{}, err
		}
		setUpstreamHeaders(req, headers)
		req.Header.Set("Range", "bytes="+strconv.FormatInt(off, 10)+"-"+strconv.FormatInt(end, 10))
		resp, err := hc.Do(req)
		if err != nil {
			if failed < len(upstreamRetryWait) && ctx.Err() == nil {
				time.Sleep(upstreamRetryWait[failed])
				failed++
				continue
			}
			return nil, mp4Meta{}, err
		}
		if (resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusGone) && !resolved && resolve != nil {
			resp.Body.Close()
			resolved = true
			if err := resolve(); err != nil {
				return nil, mp4Meta{}, upstreamStatusError{resp.StatusCode}
			}
			continue
		}
		defer resp.Body.Close()
		meta := mp4Meta{ctype: resp.Header.Get("Content-Type"), etag: resp.Header.Get("ETag"), lastMod: resp.Header.Get("Last-Modified")}
		switch resp.StatusCode {
		case http.StatusPartialContent:
			m := contentRangeTotal.FindStringSubmatch(strings.TrimSpace(resp.Header.Get("Content-Range")))
			if m == nil {
				return nil, mp4Meta{}, errNoRanges // "*" total or garbage: can't cache
			}
			meta.size, _ = strconv.ParseInt(m[1], 10, 64)
		case http.StatusOK:
			return nil, mp4Meta{}, errNoRanges
		default:
			return nil, mp4Meta{}, upstreamStatusError{resp.StatusCode}
		}
		want := min(end, meta.size-1) - off + 1
		if want <= 0 {
			return nil, mp4Meta{}, upstreamStatusError{http.StatusRequestedRangeNotSatisfiable}
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, want))
		if err != nil {
			return nil, mp4Meta{}, err
		}
		if int64(len(data)) != want {
			return nil, mp4Meta{}, io.ErrUnexpectedEOF
		}
		return data, meta, nil
	}
}

var clientRange = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

// parseClientRange: one "bytes=a-b" / "a-" / "-n" range (ok=false: multi /
// malformed → the caller passes it through). none = no Range header.
func parseClientRange(h string) (start, end int64, suffix bool, none, ok bool) {
	h = strings.TrimSpace(h)
	if h == "" {
		return 0, -1, false, true, true
	}
	m := clientRange.FindStringSubmatch(h)
	if m == nil || (m[1] == "" && m[2] == "") {
		return 0, 0, false, false, false
	}
	if m[1] == "" {
		n, err := strconv.ParseInt(m[2], 10, 64)
		if err != nil || n <= 0 {
			return 0, 0, false, false, false
		}
		return n, -1, true, false, true
	}
	start, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0, 0, false, false, false
	}
	end = -1
	if m[2] != "" {
		if end, err = strconv.ParseInt(m[2], 10, 64); err != nil || end < start {
			return 0, 0, false, false, false
		}
	}
	return start, end, false, false, true
}
