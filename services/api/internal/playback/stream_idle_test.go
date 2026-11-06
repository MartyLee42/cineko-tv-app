package playback

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// upstream is an io.Pipe whose reader fails once the request context is
// cancelled (like an HTTP response body).
func upstream(ctx context.Context) (*io.PipeReader, *io.PipeWriter) {
	pr, pw := io.Pipe()
	go func() {
		<-ctx.Done()
		pw.CloseWithError(ctx.Err())
	}()
	return pr, pw
}

func TestIdleReaderBackpressureIsNotIdle(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := upstream(ctx)
	r := newIdleReader(pr, cancel, 50*time.Millisecond, streamMeta{})
	go func() { _, _ = pw.Write([]byte("abc")) }()
	buf := make([]byte, 8)
	if n, err := r.Read(buf); n != 3 || err != nil {
		t.Fatalf("read %d %v", n, err)
	}
	// The client stops pulling (full buffer / paused) for many idle periods.
	time.Sleep(300 * time.Millisecond)
	if ctx.Err() != nil {
		t.Fatal("upstream cancelled while the client was merely not reading")
	}
	go func() { _, _ = pw.Write([]byte("de")) }()
	if n, err := r.Read(buf); n != 2 || err != nil {
		t.Fatalf("read after pause %d %v", n, err)
	}
	_ = r.Close()
	if ctx.Err() == nil || r.closeReason() != closeClient || r.bytes.Load() != 5 {
		t.Fatalf("close: ctx %v reason %q bytes %d", ctx.Err(), r.closeReason(), r.bytes.Load())
	}
}

func TestIdleReaderStalledUpstreamTimesOut(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	pr, _ := upstream(ctx)
	var logs bytes.Buffer
	meta := streamMeta{log: slog.New(slog.NewTextHandler(&logs, nil)).With("source_id", "src-1"), kind: "torrent", client: "web", rangeStart: 1000}
	r := newIdleReader(pr, cancel, 80*time.Millisecond, meta)
	t0 := time.Now()
	n, err := r.Read(make([]byte, 8)) // upstream sends nothing
	if n != 0 || err == nil || time.Since(t0) > 2*time.Second {
		t.Fatalf("blocked read: %d %v after %v", n, err, time.Since(t0))
	}
	_ = r.Close()
	if r.closeReason() != closeIdle {
		t.Fatalf("reason %q", r.closeReason())
	}
	line := logs.String()
	for _, want := range []string{"stream closed", "source_id=src-1", "kind=torrent", "client=web", "range_start=1000", "bytes=0", "reason=idle_timeout"} {
		if !strings.Contains(line, want) {
			t.Fatalf("log %q lacks %q", line, want)
		}
	}
}

func TestIdleReaderEOFAndErrors(t *testing.T) {
	_, cancel := context.WithCancel(context.Background())
	r := newIdleReader(io.NopCloser(strings.NewReader("hello")), cancel, time.Minute, streamMeta{})
	if b, _ := io.ReadAll(r); string(b) != "hello" {
		t.Fatal(string(b))
	}
	_ = r.Close()
	if r.closeReason() != closeEOF {
		t.Fatalf("eof reason %q", r.closeReason())
	}

	ctx, cancel2 := context.WithCancel(context.Background())
	pr, pw := upstream(ctx)
	r = newIdleReader(pr, cancel2, time.Minute, streamMeta{})
	pw.CloseWithError(io.ErrUnexpectedEOF)
	_, _ = r.Read(make([]byte, 4))
	_ = r.Close()
	if r.closeReason() != closeUpstream {
		t.Fatalf("error reason %q", r.closeReason())
	}
}

func TestClientKind(t *testing.T) {
	for ua, want := range map[string]string{
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36":               "web",
		"Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/4.0 TV": "tv",
		"Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 Chrome/79.0 Safari/537.36 WebAppManager":         "tv",
		"VLC/3.0.20 LibVLC/3.0.20": "other",
		"":                         "other",
	} {
		if got := clientKind(ua); got != want {
			t.Errorf("%q → %s, want %s", ua, got, want)
		}
	}
}
