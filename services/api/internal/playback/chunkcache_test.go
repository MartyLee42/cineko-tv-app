package playback

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// rangeCDN serves file with Range support (or ignoring it), counting the
// bytes it sends and the requests.
type rangeCDN struct {
	srv      *httptest.Server
	file     []byte
	sent     atomic.Int64
	requests atomic.Int32
	plain    bool
}

type countingWriter struct {
	http.ResponseWriter
	n *atomic.Int64
}

func (w countingWriter) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	w.n.Add(int64(n))
	return n, err
}

func newRangeCDN(t *testing.T, size int, plain bool) *rangeCDN {
	f := &rangeCDN{file: make([]byte, size), plain: plain}
	for i := range f.file {
		f.file[i] = byte(i * 7 % 251)
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests.Add(1)
		w.Header().Set("Content-Type", "video/mp4")
		if f.plain {
			r.Header.Del("Range")
		}
		http.ServeContent(countingWriter{w, &f.sent}, r, "", time.Unix(1700000000, 0), bytes.NewReader(f.file))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *rangeCDN) fetch() mp4Fetch {
	target := func() (string, map[string]string) { return f.srv.URL + "/film.mp4", nil }
	return func(ctx context.Context, off, end int64) ([]byte, mp4Meta, error) {
		return fetchMP4Range(ctx, http.DefaultClient, target, nil, off, end)
	}
}

func readRange(t *testing.T, cc *chunkCache, f *rangeCDN, from, to int64) []byte {
	t.Helper()
	r := cc.reader("film", from, to, f.fetch())
	defer r.Close()
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestChunkCacheServesRangesAcrossChunks(t *testing.T) {
	f := newRangeCDN(t, 10_500, false)
	cc := newChunkCache(1<<20, 1000, 2)
	if _, err := cc.get(context.Background(), "film", 0, f.fetch()); err != nil {
		t.Fatal(err)
	}
	if m, _ := cc.meta("film"); m.size != 10_500 || m.ctype != "video/mp4" {
		t.Fatalf("meta %+v", m)
	}
	for _, rg := range [][2]int64{{0, 10}, {990, 2010}, {4321, 10_500}, {10_499, 10_500}, {0, 10_500}} {
		if got := readRange(t, cc, f, rg[0], rg[1]); !bytes.Equal(got, f.file[rg[0]:rg[1]]) {
			t.Fatalf("range %v: %d bytes, wrong content", rg, len(got))
		}
	}
}

// The TV pattern: many short reads, each a little further on, hanging up
// after a bit. The CDN sends each byte about once (plus the read-ahead).
func TestChunkCacheTVPatternFetchesEachChunkOnce(t *testing.T) {
	f := newRangeCDN(t, 100_000, false)
	cc := newChunkCache(1<<20, 1000, 3)
	fetch := f.fetch()
	for pos := int64(0); pos < 50_000; pos += 700 {
		r := cc.reader("film", pos, 100_000, fetch)
		buf := make([]byte, 1500)
		if _, err := io.ReadFull(r, buf); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(buf, f.file[pos:pos+1500]) {
			t.Fatalf("content at %d", pos)
		}
		r.Close()
	}
	// Let the last read-ahead land.
	time.Sleep(100 * time.Millisecond)
	if sent := f.sent.Load(); sent > 56_000 {
		t.Fatalf("CDN sent %d bytes for ~51 KB read", sent)
	}
}

func TestChunkCacheSharesOneFetch(t *testing.T) {
	f := newRangeCDN(t, 5000, false)
	cc := newChunkCache(1<<20, 1000, 0)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := cc.get(context.Background(), "film", 2, f.fetch()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("%d upstream requests", n)
	}
}

func TestChunkCacheEvictsOldest(t *testing.T) {
	f := newRangeCDN(t, 20_000, false)
	cc := newChunkCache(3000, 1000, 0)
	for i := int64(0); i < 10; i++ {
		if _, err := cc.get(context.Background(), "film", i, f.fetch()); err != nil {
			t.Fatal(err)
		}
	}
	cc.mu.Lock()
	used, n := cc.used, cc.lru.Len()
	_, newest := cc.m[chunkKey{"film", 9}]
	_, oldest := cc.m[chunkKey{"film", 0}]
	cc.mu.Unlock()
	if used > 3000 || n != 3 || !newest || oldest {
		t.Fatalf("used %d, %d chunks, newest %v oldest %v", used, n, newest, oldest)
	}
}

func TestChunkCacheUpstreamWithoutRanges(t *testing.T) {
	f := newRangeCDN(t, 5000, true)
	cc := newChunkCache(1<<20, 1000, 0)
	_, err := cc.get(context.Background(), "film", 0, f.fetch())
	if !errors.Is(err, errNoRanges) || !cc.isPlain("film") {
		t.Fatalf("err %v plain %v", err, cc.isPlain("film"))
	}
}

func TestParseClientRange(t *testing.T) {
	for _, c := range []struct {
		h                string
		start, end       int64
		suffix, none, ok bool
	}{
		{"", 0, -1, false, true, true},
		{"bytes=100-", 100, -1, false, false, true},
		{"bytes=100-199", 100, 199, false, false, true},
		{"bytes=-500", 500, -1, true, false, true},
		{"bytes=0-1,5-9", 0, 0, false, false, false},
		{"bytes=9-1", 0, 0, false, false, false},
		{"bytes=-", 0, 0, false, false, false},
		{"items=1-2", 0, 0, false, false, false},
	} {
		s, e, suf, none, ok := parseClientRange(c.h)
		if s != c.start || e != c.end || suf != c.suffix || none != c.none || ok != c.ok {
			t.Errorf("%q → %d %d %v %v %v", c.h, s, e, suf, none, ok)
		}
	}
}
