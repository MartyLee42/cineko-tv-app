package downloads

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

// rangeServer serves payload with Range (like TorrServer's /stream). cutAt>0
// makes the first request stop after cutAt bytes (connection dropped).
func rangeServer(t *testing.T, payload []byte, cutAt int) (*httptest.Server, *atomic.Int32, *[]string) {
	var calls atomic.Int32
	var ranges []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		ranges = append(ranges, r.Header.Get("Range"))
		if n == 1 && cutAt > 0 {
			w.Header().Set("Content-Length", "999999999")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(payload[:cutAt])
			w.(http.Flusher).Flush()
			// Hijack and close: the client sees an unexpected EOF.
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
			return
		}
		http.ServeContent(w, r, "", time.Unix(1700000000, 0), bytes.NewReader(payload))
	}))
	t.Cleanup(srv.Close)
	return srv, &calls, &ranges
}

func openerFor(url string) opener {
	return func(ctx context.Context, off int64) (*http.Response, error) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		req.Header.Set("Range", "bytes="+itoa64(off)+"-")
		return http.DefaultClient.Do(req)
	}
}

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

func fmtInt(n int64) string { return strconv.FormatInt(n, 10) }

func payload(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i * 31)
	}
	return b
}

func opts() transferOpts {
	return transferOpts{CheckpointBytes: 64 << 10, CheckpointEvery: time.Second, Idle: 2 * time.Second}
}

func TestTransferResumesAfterInterruption(t *testing.T) {
	data := payload(3<<20 + 123)
	srv, calls, ranges := rangeServer(t, data, 0)
	part := filepath.Join(t.TempDir(), "1.part")
	// Simulate a previous run that wrote the first 1 MiB + 7 bytes.
	if err := os.WriteFile(part, data[:1<<20+7], 0o640); err != nil {
		t.Fatal(err)
	}
	var cps []int64
	o := opts()
	o.OnCheckpoint = func(done int64) error { cps = append(cps, done); return nil }
	var live atomic.Int64
	o.Progress = &live
	n, err := transfer(context.Background(), openerFor(srv.URL), part, int64(len(data)), o)
	if err != nil || n != int64(len(data)) || live.Load() != n {
		t.Fatalf("transfer: %d %v (live %d)", n, err, live.Load())
	}
	got, _ := os.ReadFile(part)
	if !bytes.Equal(got, data) {
		t.Fatal("content differs")
	}
	if calls.Load() != 1 || (*ranges)[0] != "bytes=1048583-" {
		t.Fatalf("requests: %d %v", calls.Load(), *ranges)
	}
	if len(cps) == 0 || cps[0] <= 1<<20+7 {
		t.Fatalf("checkpoints: %v", cps)
	}
	// Already complete: no request at all.
	if n, err := transfer(context.Background(), openerFor(srv.URL), part, int64(len(data)), opts()); err != nil || n != int64(len(data)) || calls.Load() != 1 {
		t.Fatalf("complete: %d %v %d", n, err, calls.Load())
	}
}

func TestTransferInterruptedMidwayThenResumes(t *testing.T) {
	data := payload(2<<20 + 5)
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			// 206 for the whole file, but the connection drops after 700 KiB.
			w.Header().Set("Content-Range", "bytes 0-"+fmtInt(int64(len(data)-1))+"/"+fmtInt(int64(len(data))))
			w.Header().Set("Content-Length", fmtInt(int64(len(data))))
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write(data[:700<<10])
			w.(http.Flusher).Flush()
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
			return
		}
		http.ServeContent(w, r, "", time.Unix(1700000000, 0), bytes.NewReader(data))
	}))
	defer srv.Close()
	part := filepath.Join(t.TempDir(), "2.part")
	n, err := transfer(context.Background(), openerFor(srv.URL), part, int64(len(data)), opts())
	if err == nil || n != 700<<10 {
		t.Fatalf("first run: %d %v", n, err)
	}
	if errors.Is(err, errSizeMismatch) {
		t.Fatal("an interruption is not a size mismatch")
	}
	st, _ := os.Stat(part)
	if st.Size() != 700<<10 {
		t.Fatalf("part size %d", st.Size())
	}
	n, err = transfer(context.Background(), openerFor(srv.URL), part, int64(len(data)), opts())
	if err != nil || n != int64(len(data)) {
		t.Fatalf("resume: %d %v", n, err)
	}
	got, _ := os.ReadFile(part)
	if !bytes.Equal(got, data) {
		t.Fatal("content differs after resume")
	}
}

func TestTransferSizeMismatch(t *testing.T) {
	data := payload(1 << 20)
	srv, _, _ := rangeServer(t, data, 0)
	dir := t.TempDir()
	// The source said the file is bigger than what TorrServer serves.
	_, err := transfer(context.Background(), openerFor(srv.URL), filepath.Join(dir, "a.part"), int64(len(data))+10, opts())
	if !errors.Is(err, errSizeMismatch) {
		t.Fatalf("bigger: %v", err)
	}
	// …or smaller.
	_, err = transfer(context.Background(), openerFor(srv.URL), filepath.Join(dir, "b.part"), int64(len(data))-10, opts())
	if !errors.Is(err, errSizeMismatch) {
		t.Fatalf("smaller: %v", err)
	}
	// A part already past the expected size.
	p := filepath.Join(dir, "c.part")
	_ = os.WriteFile(p, data, 0o640)
	if _, err = transfer(context.Background(), openerFor(srv.URL), p, 100, opts()); !errors.Is(err, errSizeMismatch) {
		t.Fatalf("part too big: %v", err)
	}
}

func TestTransferIdleAndCheckpointStop(t *testing.T) {
	data := payload(1 << 20)
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", fmtInt(int64(len(data))))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data[:1000])
		w.(http.Flusher).Flush()
		select {
		case <-block:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(block)
	o := opts()
	o.Idle = 200 * time.Millisecond
	start := time.Now()
	n, err := transfer(context.Background(), openerFor(srv.URL), filepath.Join(t.TempDir(), "i.part"), int64(len(data)), o)
	if !errors.Is(err, errIdle) || n != 1000 || time.Since(start) > 5*time.Second {
		t.Fatalf("idle: %d %v", n, err)
	}

	// A checkpoint error (disk below reserve) stops the transfer.
	srv2, _, _ := rangeServer(t, payload(1<<20), 0)
	o = opts()
	o.CheckpointBytes = 1
	o.OnCheckpoint = func(int64) error { return errNoSpace }
	if _, err := transfer(context.Background(), openerFor(srv2.URL), filepath.Join(t.TempDir(), "s.part"), 1<<20, o); !errors.Is(err, errNoSpace) {
		t.Fatalf("no space: %v", err)
	}
}
