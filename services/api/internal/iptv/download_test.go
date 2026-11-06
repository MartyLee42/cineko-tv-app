package iptv

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var payload = func() []byte {
	b := make([]byte, 3<<20)
	for i := range b {
		b[i] = byte(i * 7)
	}
	return b
}()

// flakyServer serves payload; the first `cuts` responses stop after half
// the bytes (connection closed); Range is honoured when ranges is true.
type flakyServer struct {
	srv     *httptest.Server
	cuts    atomic.Int32
	ranges  bool
	reqs    atomic.Int32
	rangeHd atomic.Value
	stallAt int           // stall this long once after writing stallAt bytes
	stall   time.Duration // 0 = no stall
	stalled atomic.Bool
	drip    bool // write 1 KB/100 ms forever
}

func newFlaky(t *testing.T, f *flakyServer) *flakyServer {
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.reqs.Add(1)
		if r.URL.Path == "/missing" {
			http.NotFound(w, r)
			return
		}
		f.rangeHd.Store(r.Header.Get("Range"))
		if f.drip {
			w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
			for i := 0; i < len(payload); i += 1024 {
				if _, err := w.Write(payload[i : i+1024]); err != nil {
					return
				}
				w.(http.Flusher).Flush()
				time.Sleep(100 * time.Millisecond)
			}
			return
		}
		start := 0
		if f.ranges {
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("ETag", `"v1"`)
			if rg := r.Header.Get("Range"); rg != "" {
				start, _ = strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(rg, "bytes="), "-"))
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, len(payload)-1, len(payload)))
				w.Header().Set("Content-Length", strconv.Itoa(len(payload)-start))
				w.WriteHeader(http.StatusPartialContent)
			}
		}
		if start == 0 {
			w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		}
		body := payload[start:]
		if f.cuts.Load() > 0 {
			f.cuts.Add(-1)
			_, _ = w.Write(body[:len(body)/2])
			w.(http.Flusher).Flush()
			if hj, ok := w.(http.Hijacker); ok {
				conn, _, _ := hj.Hijack()
				conn.Close()
			}
			return
		}
		if f.stall > 0 && !f.stalled.Load() && f.stallAt < len(body) {
			f.stalled.Store(true)
			_, _ = w.Write(body[:f.stallAt])
			w.(http.Flusher).Flush()
			select {
			case <-time.After(f.stall):
			case <-r.Context().Done():
			}
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func testFetcher() *fetcher { return newFetcher(nil, true, 0) }

func quickOpts() downloadOpts {
	o := defaultDownloadOpts()
	o.Total, o.Idle = 20*time.Second, 2*time.Second
	return o
}

func readFile(t *testing.T, p string) []byte {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestDownloadResumesWithRange(t *testing.T) {
	f := newFlaky(t, &flakyServer{ranges: true})
	f.cuts.Store(1)
	path := filepath.Join(t.TempDir(), "g.part")
	var last int64
	o := quickOpts()
	o.Progress = func(got, _ int64) { last = got }
	via, n, err := testFetcher().downloadTo(context.Background(), f.srv.URL+"/g.xml.gz", false, path, o)
	if err != nil || via != "direct" || n != int64(len(payload)) {
		t.Fatalf("via %s n %d err %v", via, n, err)
	}
	if !bytes.Equal(readFile(t, path), payload) {
		t.Fatal("content differs")
	}
	if f.reqs.Load() != 2 || f.rangeHd.Load() != "bytes="+strconv.Itoa(len(payload)/2)+"-" {
		t.Fatalf("requests %d last range %v", f.reqs.Load(), f.rangeHd.Load())
	}
	if last != int64(len(payload)) {
		t.Fatalf("progress %d", last)
	}
}

func TestDownloadRestartsWithoutRange(t *testing.T) {
	f := newFlaky(t, &flakyServer{})
	f.cuts.Store(2)
	path := filepath.Join(t.TempDir(), "g.part")
	_, n, err := testFetcher().downloadTo(context.Background(), f.srv.URL+"/g", false, path, quickOpts())
	if err != nil || n != int64(len(payload)) || !bytes.Equal(readFile(t, path), payload) {
		t.Fatalf("n %d err %v", n, err)
	}
	if f.reqs.Load() != 3 || f.rangeHd.Load() != "" {
		t.Fatalf("requests %d range %v", f.reqs.Load(), f.rangeHd.Load())
	}
}

func TestDownloadTruncated(t *testing.T) {
	f := newFlaky(t, &flakyServer{})
	f.cuts.Store(100)
	o := quickOpts()
	o.Resumes = 2
	_, _, err := testFetcher().downloadTo(context.Background(), f.srv.URL+"/g", false, filepath.Join(t.TempDir(), "g"), o)
	var de *downloadError
	if !errors.As(err, &de) || de.Code != "truncated" {
		t.Fatalf("err %v", err)
	}
	if f.reqs.Load() != 3 {
		t.Fatalf("requests %d", f.reqs.Load())
	}
}

func TestDownloadStallResumes(t *testing.T) {
	f := newFlaky(t, &flakyServer{ranges: true, stallAt: 100 << 10, stall: 10 * time.Second})
	o := quickOpts()
	o.Idle = 500 * time.Millisecond
	path := filepath.Join(t.TempDir(), "g")
	start := time.Now()
	_, n, err := testFetcher().downloadTo(context.Background(), f.srv.URL+"/g", false, path, o)
	if err != nil || n != int64(len(payload)) || !bytes.Equal(readFile(t, path), payload) {
		t.Fatalf("n %d err %v", n, err)
	}
	if time.Since(start) > 5*time.Second || f.rangeHd.Load() != "bytes="+strconv.Itoa(100<<10)+"-" {
		t.Fatalf("took %s range %v", time.Since(start), f.rangeHd.Load())
	}
}

func TestDownloadTimeout(t *testing.T) {
	f := newFlaky(t, &flakyServer{drip: true})
	o := quickOpts()
	o.Total = 700 * time.Millisecond
	_, _, err := testFetcher().downloadTo(context.Background(), f.srv.URL+"/g", false, filepath.Join(t.TempDir(), "g"), o)
	var de *downloadError
	if !errors.As(err, &de) || de.Code != "download_timeout" || !strings.Contains(de.Detail, "of 3.1 MB") {
		t.Fatalf("err %v", err)
	}
}

func TestDownloadNotFoundIsFinal(t *testing.T) {
	f := newFlaky(t, &flakyServer{})
	_, _, err := testFetcher().downloadTo(context.Background(), f.srv.URL+"/missing", false, filepath.Join(t.TempDir(), "g"), quickOpts())
	var de *downloadError
	if !errors.As(err, &de) || de.Status != 404 || f.reqs.Load() != 1 {
		t.Fatalf("err %v requests %d", err, f.reqs.Load())
	}
}

// A blocked direct path (loopback refused) falls back to the proxy; a
// via_proxy guide that the proxy can't serve falls back to direct.
func TestDownloadProxyFallback(t *testing.T) {
	f := newFlaky(t, &flakyServer{})
	var proxied atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxied.Add(1)
		resp, err := http.Get(r.URL.String())
		if err != nil {
			w.WriteHeader(502)
			return
		}
		defer resp.Body.Close()
		w.Header().Set("Content-Length", resp.Header.Get("Content-Length"))
		_, _ = io.Copy(w, resp.Body)
	}))
	defer proxy.Close()
	pu, _ := url.Parse(proxy.URL)
	fe := newFetcher(pu, false, 0) // direct may not dial loopback
	via, _, err := fe.downloadTo(context.Background(), f.srv.URL+"/g", false, filepath.Join(t.TempDir(), "g"), quickOpts())
	if err != nil || via != "proxy" || proxied.Load() != 1 {
		t.Fatalf("via %s err %v proxied %d", via, err, proxied.Load())
	}

	dead, _ := url.Parse("http://127.0.0.1:1")
	fe = newFetcher(dead, true, 0)
	via, _, err = fe.downloadTo(context.Background(), f.srv.URL+"/g", true, filepath.Join(t.TempDir(), "g"), quickOpts())
	if err != nil || via != "direct" {
		t.Fatalf("via %s err %v", via, err)
	}
}

func TestParseGuideErrors(t *testing.T) {
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write([]byte(sampleXMLTV))
	_ = zw.Close()
	cut := gz.Bytes()[:gz.Len()/2]
	err := ParseXMLTV(bytes.NewReader(cut), nil, nil)
	if !errors.Is(err, errTruncated) || !strings.Contains(err.Error(), "at byte") {
		t.Fatalf("truncated gzip: %v", err)
	}
	err = ParseXMLTV(strings.NewReader("<tv><channel id=\"a\"/>\x00</tv>"), func(XChannel) error { return nil }, nil)
	if !errors.Is(err, errParse) || !strings.HasPrefix(err.Error(), "parse_error at byte ") {
		t.Fatalf("bad xml: %v", err)
	}
	// The filter skips unwanted programmes without decoding them.
	n := 0
	err = parseXMLTV(strings.NewReader(sampleXMLTV), nil, func(ch string) bool { return ch == "5755" }, func(p XProgramme) error { n++; return nil })
	if err != nil || n != 0 { // the 5755 programme has an empty title → dropped
		t.Fatalf("filter: n=%d err=%v", n, err)
	}
	err = parseXMLTV(strings.NewReader(sampleXMLTV), nil, func(ch string) bool { return ch == "2x2.ru" }, func(p XProgramme) error { n++; return nil })
	if err != nil || n != 2 {
		t.Fatalf("filter 2x2: n=%d err=%v", n, err)
	}
}

func TestSplitURLsAndPresets(t *testing.T) {
	got := splitURLs("https://a/x.xml.gz, https://b/y.xml\nftp://no https://a/x.xml.gz")
	if len(got) != 2 || got[1] != "https://b/y.xml" {
		t.Fatalf("%v", got)
	}
	if g := presetGuides("ru"); len(g) != 3 || g[0] != guideIPTVX || g[1] != guideEPGPWRU {
		t.Fatalf("ru %v", g)
	}
	if g := presetGuides("kz"); g[0] != guideIPTVX {
		t.Fatalf("kz %v", g)
	}
	if g := presetGuides("int"); !strings.Contains(g[0], "ALL_SOURCES") {
		t.Fatalf("int %v", g)
	}
	if g := presetGuides("uk"); !strings.Contains(g[0], "UK1") || !strings.HasSuffix(g[1], "epg_GB.xml.gz") {
		t.Fatalf("uk %v", g)
	}
}
