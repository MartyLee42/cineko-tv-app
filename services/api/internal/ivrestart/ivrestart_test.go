package ivrestart

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"martytv/api/internal/config"
)

func TestNextRun(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Almaty")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct{ now, want string }{
		{"2026-11-07T01:00:00", "2026-11-07T03:00:00"},
		{"2026-11-07T03:00:00", "2026-11-08T03:00:00"}, // exactly now → tomorrow
		{"2026-11-07T22:30:00", "2026-11-08T03:00:00"},
	}
	for _, c := range cases {
		now, _ := time.ParseInLocation("2006-01-02T15:04:05", c.now, loc)
		got := NextRun(now.UTC(), 3, 0, loc)
		if got.In(loc).Format("2006-01-02T15:04:05") != c.want {
			t.Errorf("NextRun(%s) = %s, want %s", c.now, got.In(loc), c.want)
		}
	}
}

func TestDecide(t *testing.T) {
	start := time.Date(2026, 11, 7, 3, 0, 0, 0, time.UTC)
	at := func(h, m int) time.Time { return time.Date(2026, 11, 7, h, m, 0, 0, time.UTC) }
	cases := []struct {
		name      string
		now, last time.Time
		want      action
	}{
		{"never watched", at(3, 0), time.Time{}, actRestart},
		{"idle for an hour", at(3, 0), at(2, 0), actRestart},
		{"idle just long enough", at(3, 0), at(2, 55), actRestart},
		{"watching", at(3, 0), at(2, 59), actWait},
		{"still watching at 04:45", at(4, 45), at(4, 44), actWait},
		{"still watching at 05:00", at(5, 0), at(4, 59), actSkip},
		{"stopped by 04:30", at(4, 30), at(4, 10), actRestart},
	}
	for _, c := range cases {
		if got := decide(c.now, start, c.last); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

// fakeDocker records restart calls.
type fakeDocker struct {
	mu    sync.Mutex
	calls []string
}

func (f *fakeDocker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.calls = append(f.calls, r.Method+" "+r.URL.RequestURI())
	f.mu.Unlock()
	if r.URL.Path == "/containers/missing/restart" {
		http.Error(w, `{"message":"No such container"}`, http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func newTest(t *testing.T, containers ...string) (*Restarter, *fakeDocker) {
	f := &fakeDocker{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	cfg := config.InvidiousRestartConfig{Hour: 3, Location: time.UTC, DockerURL: srv.URL, Containers: containers}
	r := New(cfg, func() time.Time { return time.Time{} }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return r, f
}

func TestRestartAllOrderAndErrors(t *testing.T) {
	r, f := newTest(t, "cineko-companion-1", "missing", "cineko-invidious-1")
	r.RestartAll(context.Background())
	want := []string{
		"POST /containers/cineko-companion-1/restart?t=10",
		"POST /containers/missing/restart?t=10",
		"POST /containers/cineko-invidious-1/restart?t=10",
	}
	if len(f.calls) != len(want) {
		t.Fatalf("calls %v", f.calls)
	}
	for i := range want {
		if f.calls[i] != want[i] {
			t.Fatalf("call %d = %q, want %q", i, f.calls[i], want[i])
		}
	}
}

func TestNightPostponesWhileWatching(t *testing.T) {
	r, f := newTest(t, "inv")
	start := time.Date(2026, 11, 7, 3, 0, 0, 0, time.UTC)
	now := start
	r.now = func() time.Time { return now }
	// Watching until 03:40, then the stream stops.
	r.lastActive = func() time.Time {
		if now.Before(start.Add(40 * time.Minute)) {
			return now.Add(-time.Minute)
		}
		return start.Add(40 * time.Minute)
	}
	var slept []time.Duration
	r.sleep = func(_ context.Context, d time.Duration) bool { slept = append(slept, d); now = now.Add(d); return true }
	if !r.night(context.Background(), start) {
		t.Fatal("night ended early")
	}
	// 03:00, 03:15, 03:30 busy; 03:45 idle for 5 min → restart.
	if len(slept) != 3 || len(f.calls) != 1 || !now.Equal(start.Add(45*time.Minute)) {
		t.Fatalf("slept %v calls %v now %s", slept, f.calls, now)
	}
}

func TestNightSkipsWhenStillWatching(t *testing.T) {
	r, f := newTest(t, "inv")
	start := time.Date(2026, 11, 7, 3, 0, 0, 0, time.UTC)
	now := start
	r.now = func() time.Time { return now }
	r.lastActive = func() time.Time { return now.Add(-30 * time.Second) }
	r.sleep = func(_ context.Context, d time.Duration) bool { now = now.Add(d); return true }
	r.night(context.Background(), start)
	if len(f.calls) != 0 || !now.Equal(start.Add(2*time.Hour)) {
		t.Fatalf("calls %v, last check at %s", f.calls, now)
	}
}

func TestRunOffWithoutProxy(t *testing.T) {
	r := New(config.InvidiousRestartConfig{Hour: 3, Location: time.UTC}, time.Now, slog.New(slog.NewTextHandler(io.Discard, nil)))
	done := make(chan struct{})
	go func() { r.Run(context.Background()); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run should return at once when off")
	}
}
