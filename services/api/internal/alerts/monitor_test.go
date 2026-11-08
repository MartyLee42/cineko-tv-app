package alerts

import (
	"context"
	"net"
	"net/url"
	"testing"
	"time"

	"martytv/api/internal/integrations"
	"martytv/api/internal/sysmon"
)

func find(obs []Observation, kind string) *Observation {
	for i := range obs {
		if obs[i].Kind == kind {
			return &obs[i]
		}
	}
	return nil
}

func TestObserve(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	reachable := false
	checks := []integrations.Status{
		{Name: "tmdb", Configured: true, Error: "unexpected HTTP 401"},
		{Name: "prowlarr", Configured: true, OK: true},
		{Name: "torrserver", Configured: false},
		{Name: "kinopoisk", Configured: true},
	}
	s := New(Deps{
		Checks:   func(context.Context) []integrations.Status { return checks },
		Video:    func() (bool, *bool, time.Duration) { return true, &reachable, 0 },
		Disks:    func(context.Context) []sysmon.Disk { return []sysmon.Disk{{Mount: "/", Total: 100e9, Free: 4e9}} },
		ProxyURL: &url.URL{Scheme: "socks5h", Host: ln.Addr().String()},
	})
	obs := s.observe(context.Background())
	if o := find(obs, KindTMDB); o == nil || o.OK || o.Cause != "unauthorized" {
		t.Fatalf("tmdb %+v", o)
	}
	if o := find(obs, KindProwlarr); o == nil || !o.OK {
		t.Fatalf("prowlarr %+v", o)
	}
	if find(obs, KindTorrServer) != nil || find(obs, "kinopoisk") != nil {
		t.Fatal("unconfigured / unknown checks observed")
	}
	if o := find(obs, KindInvidious); o == nil || o.OK {
		t.Fatalf("invidious %+v", o)
	}
	if o := find(obs, KindDisk); o == nil || o.OK || o.Detail != "/ 4.0 GB" {
		t.Fatalf("disk %+v", o)
	}
	if o := find(obs, KindProxy); o == nil || !o.OK {
		t.Fatalf("proxy %+v", o)
	}

	// Proxy down: the TMDB failure is the VPN's, not observed separately.
	ln.Close()
	obs = s.observe(context.Background())
	if o := find(obs, KindProxy); o == nil || o.OK {
		t.Fatalf("proxy down %+v", o)
	}
	if find(obs, KindTMDB) != nil {
		t.Fatal("tmdb observed while the proxy is down")
	}
}

func TestDiskLow(t *testing.T) {
	for _, c := range []struct {
		total, free uint64
		low         bool
	}{
		{20e9, 1.5e9, true}, // < 10 %
		{20e9, 3e9, false},  // 15 %
		{2e12, 4e9, true},   // < 5 GiB
		{2e12, 50e9, false}, // plenty
		{0, 0, false},       // unknown
	} {
		if got := diskLow(sysmon.Disk{Total: c.total, Free: c.free}); got != c.low {
			t.Errorf("%d/%d: %v", c.free, c.total, got)
		}
	}
}

// CheckOnce: 3 failing minutes open TMDB, 2 good ones recover it (no DB:
// nothing stored or sent, the state machine still runs).
func TestCheckOnceDebounces(t *testing.T) {
	ok := false
	s := New(Deps{Checks: func(context.Context) []integrations.Status {
		return []integrations.Status{{Name: "tmdb", Configured: true, OK: ok}}
	}})
	now := fixedNow
	s.now = func() time.Time { return now }
	for i := 0; i < 3; i++ {
		s.CheckOnce(context.Background())
		now = now.Add(time.Minute)
	}
	if !s.m.Open(KindTMDB) {
		t.Fatal("not open after 3 minutes")
	}
	ok = true
	s.CheckOnce(context.Background())
	now = now.Add(time.Minute)
	s.CheckOnce(context.Background())
	if s.m.Open(KindTMDB) {
		t.Fatal("still open")
	}
	s.Wait()
}

func TestHostReportValidation(t *testing.T) {
	s := New(Deps{})
	for _, r := range []HostReport{
		{Kind: "tmdb", State: "down"},
		{Kind: KindYouTube, State: "sideways"},
		{Kind: KindYouTube, State: "down", Cause: "bogus"},
		{Kind: KindYouTube, State: "event"},
		{Kind: KindVPN, State: "down", Action: "reboot_host"},
		{Kind: KindUpdater, State: "down", Cause: "rollback"},
		{Kind: KindUpdater, State: "event"},
	} {
		if err := s.Report(context.Background(), r); err != ErrBadReport {
			t.Errorf("%+v accepted (%v)", r, err)
		}
	}
	if err := s.Report(context.Background(), HostReport{Kind: KindVPN, State: "down", Action: "vpn_restarted", Detail: "line\nbreak"}); err != nil {
		t.Fatal(err)
	}
	if !s.m.Open(KindVPN) {
		t.Fatal("vpn not open")
	}
	s.Wait()
}
