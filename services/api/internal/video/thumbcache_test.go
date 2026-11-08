package video

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
)

// A tiny JPEG header is enough for http.DetectContentType.
var testJPEG = append([]byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 'J', 'F', 'I', 'F', 0}, make([]byte, 989)...) // 1000 bytes

type fakeClock struct{ t time.Time }

func (f *fakeClock) now() time.Time { return f.t }

func newTestCache(t *testing.T, maxBytes int64, fetch func(context.Context, string) (string, []byte, error)) (*thumbCache, *fakeClock) {
	t.Helper()
	clk := &fakeClock{t: time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)}
	if fetch == nil {
		fetch = func(context.Context, string) (string, []byte, error) { return "image/jpeg", testJPEG, nil }
	}
	c := newThumbCache(t.TempDir(), maxBytes, 14*24*time.Hour, fetch)
	c.now = clk.now
	c.scan() // empty dir: marks the index loaded
	return c, clk
}

func thumbPath(i int) string { return "/vi/vid" + strconv.Itoa(1000+i) + "abcd/hqdefault.jpg" }

func TestThumbCacheEvictsLeastRecentlyUsed(t *testing.T) {
	c, clk := newTestCache(t, 10_000, nil) // room for 10 images
	ctx := context.Background()
	for i := range 10 {
		clk.t = clk.t.Add(time.Minute)
		if _, _, err := c.load(ctx, thumbPath(i)); err != nil {
			t.Fatal(err)
		}
	}
	// Image 0 is used again: image 1 is now the least recently used.
	clk.t = clk.t.Add(time.Minute)
	if _, _, ok := c.get(thumbKey(thumbPath(0))); !ok {
		t.Fatal("image 0 not cached")
	}
	clk.t = clk.t.Add(time.Minute)
	if _, _, err := c.load(ctx, thumbPath(10)); err != nil {
		t.Fatal(err)
	}
	n, total := c.stats()
	// Over the limit: down to 90 % (9 images), oldest first: 1 and 2 go.
	if n != 9 || total != 9000 {
		t.Fatalf("%d files, %d bytes", n, total)
	}
	for i, want := range map[int]bool{0: true, 1: false, 2: false, 3: true, 10: true} {
		_, err := os.Stat(c.file(thumbKey(thumbPath(i))))
		if (err == nil) != want {
			t.Errorf("image %d on disk = %v, want %v", i, err == nil, want)
		}
	}
	if c.fetches.Load() != 11 {
		t.Fatalf("%d fetches", c.fetches.Load())
	}
}

func TestThumbCacheAgeAndRestart(t *testing.T) {
	c, clk := newTestCache(t, 1<<20, nil)
	ctx := context.Background()
	_, _, _ = c.load(ctx, thumbPath(1))
	clk.t = clk.t.Add(10 * 24 * time.Hour)
	_, _, _ = c.load(ctx, thumbPath(2))
	// A restart rebuilds the index from the files' mtimes (= last use).
	_ = os.Chtimes(c.file(thumbKey(thumbPath(1))), clk.t.Add(-10*24*time.Hour), clk.t.Add(-10*24*time.Hour))
	_ = os.Chtimes(c.file(thumbKey(thumbPath(2))), clk.t, clk.t)
	_ = os.MkdirAll(c.dir+"/ab", 0o755)
	_ = os.WriteFile(c.dir+"/ab/.tmp-123", []byte("x"), 0o644)
	r := newThumbCache(c.dir, 1<<20, 14*24*time.Hour, c.fetch)
	clk.t = clk.t.Add(5 * 24 * time.Hour) // image 1 unused for 15 days, image 2 for 5
	r.now = clk.now
	r.scan()
	if n, _ := r.stats(); n != 1 {
		t.Fatalf("%d files after restart", n)
	}
	if !r.has(thumbKey(thumbPath(2))) || r.has(thumbKey(thumbPath(1))) {
		t.Fatal("the wrong image expired")
	}
	if _, err := os.Stat(c.dir + "/ab/.tmp-123"); err == nil {
		t.Fatal("stale temp file kept")
	}
}

func TestThumbCacheCoalescesAndLimits(t *testing.T) {
	var running, peak, calls atomic.Int32
	release := make(chan struct{})
	fetch := func(ctx context.Context, path string) (string, []byte, error) {
		calls.Add(1)
		n := running.Add(1)
		defer running.Add(-1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		<-release
		return "image/jpeg", testJPEG, nil
	}
	c, _ := newTestCache(t, 1<<20, fetch)
	ctx := context.Background()
	var wg sync.WaitGroup
	// 20 viewers of one image + one viewer each of 12 others, all at once.
	for range 20 {
		wg.Go(func() { _, _, _ = c.load(ctx, thumbPath(0)) })
	}
	for i := 1; i <= 12; i++ {
		wg.Go(func() { _, _, _ = c.load(ctx, thumbPath(i)) })
	}
	time.Sleep(100 * time.Millisecond)
	if p := peak.Load(); p > thumbFgSlots {
		t.Fatalf("%d upstream fetches at once", p)
	}
	close(release)
	wg.Wait()
	if calls.Load() != 13 {
		t.Fatalf("%d upstream fetches for 13 images", calls.Load())
	}
	// Cached now: no more fetches.
	_, _, _ = c.load(ctx, thumbPath(0))
	if calls.Load() != 13 {
		t.Fatal("cached image fetched again")
	}
}

func TestThumbCacheWarmAndFailures(t *testing.T) {
	var calls atomic.Int32
	fetch := func(ctx context.Context, path string) (string, []byte, error) {
		calls.Add(1)
		if path == thumbPath(9) {
			return "", nil, errors.New("upstream 404")
		}
		return "image/jpeg", testJPEG, nil
	}
	c, _ := newTestCache(t, 1<<20, fetch)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.runWarm(ctx)
	c.warm(thumbPath(1), thumbPath(2), thumbPath(9))
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	if !c.has(thumbKey(thumbPath(1))) || !c.has(thumbKey(thumbPath(2))) {
		t.Fatal("prefetch did not fill the cache")
	}
	// Prefetched images are served without a fetch; a failed one is not retried for a while.
	if _, _, err := c.load(ctx, thumbPath(1)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.load(ctx, thumbPath(9)); !errors.Is(err, errThumbBad) {
		t.Fatalf("failed image: %v", err)
	}
	c.warm(thumbPath(1), thumbPath(9))
	time.Sleep(50 * time.Millisecond)
	if calls.Load() != 3 {
		t.Fatalf("%d fetches", calls.Load())
	}
}

func TestThumbCacheOff(t *testing.T) {
	var calls atomic.Int32
	c := newThumbCache("", 500<<20, time.Hour, func(context.Context, string) (string, []byte, error) {
		calls.Add(1)
		return "image/jpeg", testJPEG, nil
	})
	_, _, _ = c.load(context.Background(), thumbPath(1))
	_, _, _ = c.load(context.Background(), thumbPath(1))
	if calls.Load() != 2 {
		t.Fatalf("no dir: %d fetches", calls.Load())
	}
}

func TestThumbHeaders(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write(testJPEG)
	}))
	defer srv.Close()
	cl, err := NewClient(srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	s := NewService(Deps{Client: cl, ThumbDir: t.TempDir(), ThumbCacheBytes: 1 << 20})
	app := fiber.New()
	app.Get("/vi/:id/:name", s.thumbVideo)
	get := func(etag string) *http.Response {
		req := httptest.NewRequest("GET", "/vi/dQw4w9WgXcQ/hqdefault.jpg", nil)
		if etag != "" {
			req.Header.Set("If-None-Match", etag)
		}
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	r := get("")
	if r.StatusCode != 200 || r.Header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("%d %q", r.StatusCode, r.Header.Get("Content-Type"))
	}
	if cc := r.Header.Get("Cache-Control"); cc != "public, max-age=604800, immutable" {
		t.Fatalf("cache-control %q", cc)
	}
	etag := r.Header.Get("ETag")
	if etag == "" {
		t.Fatal("no etag")
	}
	if r := get(etag); r.StatusCode != 304 {
		t.Fatalf("revalidation: %d", r.StatusCode)
	}
	if hits.Load() != 1 {
		t.Fatalf("%d upstream hits", hits.Load())
	}
}
