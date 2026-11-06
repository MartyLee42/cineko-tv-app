package sysmon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// unixServer serves h on a short unix socket path (sun_path is ~108 bytes).
func unixServer(t *testing.T, h http.Handler) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "hm")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "s.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewUnstartedServer(h)
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	return sock
}

const (
	idTS  = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	idAPI = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

// fakeDocker answers the two read-only endpoints and records every request.
type fakeDocker struct {
	mu    sync.Mutex
	calls []string
	round int
}

func (f *fakeDocker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.calls = append(f.calls, r.Method+" "+r.URL.RequestURI())
	round := f.round
	f.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/containers/json":
		fmt.Fprintf(w, `[{"Id":%q,"Names":["/torrserver"],"State":"running"},{"Id":%q,"Names":["/martytv-api-1"],"State":"running"},{"Id":"cccc","Names":["/old"],"State":"exited"}]`, idTS, idAPI)
	case r.Method == http.MethodGet && r.URL.Path == "/containers/"+idTS+"/stats":
		// 4 CPUs; between rounds the container used 1e9 of 4e9 system ns → 100% (one core).
		fmt.Fprintf(w, `{"cpu_stats":{"cpu_usage":{"total_usage":%d},"system_cpu_usage":%d,"online_cpus":4},
			"memory_stats":{"usage":600000000,"limit":8000000000,"stats":{"total_inactive_file":100000000}}}`, 1e9+round*1e9, 1e10+round*4e9)
	case r.Method == http.MethodGet && r.URL.Path == "/containers/"+idAPI+"/stats":
		fmt.Fprintf(w, `{"cpu_stats":{"cpu_usage":{"total_usage":%d},"system_cpu_usage":%d,"online_cpus":4},
			"memory_stats":{"usage":50000000,"limit":536870912,"stats":{"inactive_file":10000000}}}`, 1e8+round*2e8, 1e10+round*4e9)
	default:
		http.Error(w, "nope", http.StatusNotFound)
	}
}

func TestDockerContainers(t *testing.T) {
	fd := &fakeDocker{}
	d := NewDocker(unixServer(t, fd))
	ctx := context.Background()
	cs, err := d.Containers(ctx, 8000000000)
	if err != nil {
		t.Fatal(err)
	}
	if len(cs) != 3 || cs[0].Name != "torrserver" || cs[0].MemBytes != 500000000 || cs[0].MemLimitBytes != 0 || cs[0].CPUPercent != 0 {
		t.Fatalf("first %+v", cs)
	}
	if cs[1].Name != "martytv-api-1" || cs[1].MemBytes != 40000000 || cs[1].MemLimitBytes != 536870912 {
		t.Fatalf("api %+v", cs[1])
	}
	if cs[2].Name != "old" || cs[2].State != "exited" {
		t.Fatalf("exited %+v", cs[2])
	}
	fd.mu.Lock()
	fd.round = 1
	fd.mu.Unlock()
	cs, _ = d.Containers(ctx, 8000000000)
	if cs[0].CPUPercent != 100 || cs[1].CPUPercent != 20 {
		t.Fatalf("cpu %+v", cs)
	}
	for _, c := range fd.calls {
		if !strings.HasPrefix(c, "GET /containers/") {
			t.Fatalf("unexpected docker call %q", c)
		}
	}
	// Unreachable socket.
	if _, err := NewDocker("/nonexistent.sock").Containers(ctx, 0); err == nil {
		t.Fatal("want error")
	}
}

func TestHostmonHandler(t *testing.T) {
	proc := copyProc(t)
	col := NewCollector(proc, "host", t.TempDir())
	fd := &fakeDocker{}
	hm := NewHostmon(col, NewDocker(unixServer(t, fd)), slog.New(slog.NewTextHandler(io.Discard, nil)))
	hm.Tick(context.Background())
	srv := httptest.NewServer(hm.Handler())
	defer srv.Close()

	var st HostStatus
	getJSON(t, srv.URL+"/v1/status", &st)
	if st.Scope != "host" || st.CPU.Cores != 2 || len(st.Containers) != 3 || st.Containers[0].Name != "torrserver" || len(st.Processes) == 0 {
		t.Fatalf("status %+v", st)
	}
	var h History
	getJSON(t, srv.URL+"/v1/history?minutes=5", &h)
	if h.Scope != "host" || h.IntervalSeconds != 10 || h.Cores != 2 || h.MemTotal != 8000000*1024 || len(h.Samples) != 1 {
		t.Fatalf("history %+v", h)
	}
	// Old samples fall out of the window.
	hm.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	getJSON(t, srv.URL+"/v1/history", &h)
	if len(h.Samples) != 0 {
		t.Fatalf("stale history %+v", h.Samples)
	}
	resp, _ := http.Post(srv.URL+"/v1/status", "application/json", nil)
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST status %d", resp.StatusCode)
	}
}

func getJSON(t *testing.T, url string, out any) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("%s: %d", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		t.Fatal(err)
	}
}

func TestServiceUsesHostmon(t *testing.T) {
	proc := copyProc(t)
	hm := NewHostmon(NewCollector(proc, "host", "/"), nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	hm.Tick(context.Background())
	sock := unixServer(t, hm.Handler())

	streams := int64(2)
	svc := NewService(Deps{
		Version: "v-test", Socket: sock, ImageCacheDir: t.TempDir(),
		Hub:           fakeHub{3, 1},
		ActiveStreams: func() int64 { return streams },
	})
	svc.Tick()
	st := svc.Status(context.Background())
	if st.Hostmon != "ok" || st.Scope != "host" || st.CPU.Cores != 2 || st.Memory.Total != 8000000*1024 {
		t.Fatalf("status %+v", st)
	}
	if st.App.MartyTVVersion != "v-test" || st.App.ActiveStreams != 2 || st.App.WSConnections != (WSCounts{3, 1}) ||
		st.App.DBSizeBytes != nil || st.App.ImageCacheBytes == nil || *st.App.ImageCacheBytes != 0 || st.App.TorrServer.Configured || st.Containers == nil {
		t.Fatalf("app %+v", st.App)
	}
	h := svc.History(context.Background(), 60)
	if h.Scope != "host" || len(h.Samples) != 1 || h.Samples[0].ActiveStreams == nil || *h.Samples[0].ActiveStreams != 2 {
		t.Fatalf("history %+v", h)
	}
}

func TestServiceFallback(t *testing.T) {
	svc := NewService(Deps{Socket: "/nonexistent/hostmon.sock"})
	svc.Tick()
	st := svc.Status(context.Background())
	if st.Hostmon != "unavailable" || st.Scope != "container" || st.Memory.Total == 0 || len(st.Disks) == 0 {
		t.Fatalf("fallback %+v", st)
	}
	h := svc.History(context.Background(), 10)
	if h.Scope != "container" || len(h.Samples) != 1 || *h.Samples[0].ActiveStreams != 0 {
		t.Fatalf("fallback history %+v", h)
	}
	// Never configured socket: same fallback.
	if st := NewService(Deps{}).Status(context.Background()); st.Hostmon != "unavailable" {
		t.Fatal("want unavailable")
	}
}

func TestDirSize(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "a/b.jpg", "12345")
	write(t, dir, "c.jpg", "123")
	if n := dirSize(dir, 10); n == nil || *n != 8 {
		t.Fatalf("size %v", n)
	}
	if n := dirSize(dir, 1); n != nil {
		t.Fatal("capped walk should give up")
	}
	if dirSize("", 10) != nil {
		t.Fatal("no dir")
	}
}

type fakeHub struct{ u, d int }

func (f fakeHub) Counts() (int, int) { return f.u, f.d }
