package sysmon

import (
	"os"
	"testing"
	"time"
)

func testTime() time.Time { return time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC) }

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/proc/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseProcStat(t *testing.T) {
	st, err := ParseProcStat(fixture(t, "stat"))
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Cores) != 2 || st.All.User != 1000 || st.All.Steal != 200 || st.All.Total() != 10000 {
		t.Fatalf("%+v", st)
	}
	if _, err := ParseProcStat([]byte("intr 1 2 3\n")); err == nil {
		t.Fatal("want error without a cpu line")
	}
}

func TestCPUDelta(t *testing.T) {
	prev := CPUTimes{User: 1000, System: 500, Idle: 8000, IOWait: 200, SoftIRQ: 100, Steal: 200}
	cases := []struct {
		name                 string
		cur                  CPUTimes
		usage, steal, iowait float64
	}{
		{"half busy", CPUTimes{User: 1300, System: 600, Idle: 8450, IOWait: 250, SoftIRQ: 100, Steal: 300}, 50, 10, 5},
		{"idle", CPUTimes{User: 1000, System: 500, Idle: 9000, IOWait: 200, SoftIRQ: 100, Steal: 200}, 0, 0, 0},
		{"no time passed", prev, 0, 0, 0},
		{"counter reset", CPUTimes{User: 1}, 0, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := CPUDelta(prev, c.cur)
			if round1(p.Usage) != c.usage || round1(p.Steal) != c.steal || round1(p.IOWait) != c.iowait {
				t.Fatalf("got %+v", p)
			}
		})
	}
}

func TestParseMeminfo(t *testing.T) {
	m, err := ParseMeminfo(fixture(t, "meminfo"))
	if err != nil {
		t.Fatal(err)
	}
	const k = 1024
	want := Memory{Total: 8000000 * k, Used: 6000000 * k, Available: 2000000 * k, Cached: 1800000 * k, SwapTotal: 4000000 * k, SwapUsed: 1000000 * k}
	if m != want {
		t.Fatalf("got %+v want %+v", m, want)
	}
	// Old kernels without MemAvailable.
	m, _ = ParseMeminfo([]byte("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n"))
	if m.Available != 300*k || m.Used != 700*k {
		t.Fatalf("fallback %+v", m)
	}
	if _, err := ParseMeminfo([]byte("garbage")); err == nil {
		t.Fatal("want error")
	}
}

func TestParseLoadUptime(t *testing.T) {
	l, err := ParseLoadavg(fixture(t, "loadavg"))
	if err != nil || l != [3]float64{1.5, 0.75, 0.25} {
		t.Fatalf("%v %v", l, err)
	}
	if _, err := ParseLoadavg([]byte("1 2")); err == nil {
		t.Fatal("want error")
	}
	u, err := ParseUptime(fixture(t, "uptime"))
	if err != nil || u != 123456.78 {
		t.Fatalf("%v %v", u, err)
	}
}

func TestParseNetDev(t *testing.T) {
	got := ParseNetDev(fixture(t, "net/dev"))
	want := []NetCounters{{"eth0", 1000000, 500000}, {"awg0", 2000, 3000}}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %+v", got)
		}
	}
}

func TestParsePidStat(t *testing.T) {
	cases := []struct {
		file  string
		comm  string
		ticks uint64
		rss   uint64
	}{
		{"42/stat", "TorrServer-linu", 400, 100000},
		{"43/stat", "postgres: wal (x)", 10, 1000}, // parentheses inside comm
		{"1/stat", "systemd", 30, 2000},
	}
	for _, c := range cases {
		ps, err := ParsePidStat(fixture(t, c.file))
		if err != nil || ps.Comm != c.comm || ps.Ticks != c.ticks || ps.RSS != c.rss {
			t.Fatalf("%s: %+v %v", c.file, ps, err)
		}
	}
	for _, bad := range []string{"", "x (a) S", "12 noparens S 1 2"} {
		if _, err := ParsePidStat([]byte(bad)); err == nil {
			t.Fatalf("want error for %q", bad)
		}
	}
}

func TestFriendlyName(t *testing.T) {
	for in, want := range map[string]string{
		"TorrServer-linu": "torrserver", "Prowlarr": "Prowlarr", "JackettConsole": "Jackett",
		"chrome": "chrome (browser)", "chromedriver": "chrome (browser)", "postgres: wal (x)": "postgres",
		"martytv": "martytv", "martytv-hostmon": "martytv", "containerd-shim": "docker", "dockerd": "docker",
		"hbbs": "rustdesk", "caddy": "caddy", "python3": "python3", "kworker/0:1": "kernel",
	} {
		if got := FriendlyName(in); got != want {
			t.Errorf("%s → %s, want %s", in, got, want)
		}
	}
}

func TestRing(t *testing.T) {
	r := NewRing(3)
	if _, ok := r.Latest(); ok {
		t.Fatal("empty ring has no latest")
	}
	base := testTime()
	for i := range 5 {
		r.Add(Sample{T: base.Add(SampleInterval * time.Duration(i)), Load1: float64(i)})
	}
	all := r.Since(base.Add(-time.Hour))
	if len(all) != 3 || all[0].Load1 != 2 || all[2].Load1 != 4 {
		t.Fatalf("%+v", all)
	}
	if s := r.Since(base.Add(3 * SampleInterval)); len(s) != 1 || s[0].Load1 != 4 {
		t.Fatalf("since %+v", s)
	}
	if l, _ := r.Latest(); l.Load1 != 4 {
		t.Fatalf("latest %+v", l)
	}
	for in, want := range map[int]int{0: 60, -5: 60, 15: 15, 600: 60} {
		if ClampMinutes(in) != want {
			t.Errorf("clamp %d", in)
		}
	}
}

func TestMergeStreams(t *testing.T) {
	base := testTime()
	n := func(v int) *int { return &v }
	host := []Sample{{T: base}, {T: base.Add(10 * time.Second)}, {T: base.Add(20 * time.Second)}, {T: base.Add(60 * time.Second)}}
	local := []Sample{{T: base.Add(2 * time.Second), ActiveStreams: n(1)}, {T: base.Add(13 * time.Second), ActiveStreams: n(2)}, {T: base.Add(21 * time.Second), ActiveStreams: n(3)}}
	got := MergeStreams(host, local, 6*time.Second)
	if *got[0].ActiveStreams != 1 || *got[1].ActiveStreams != 2 || *got[2].ActiveStreams != 3 || got[3].ActiveStreams != nil {
		t.Fatalf("%+v", got)
	}
}

func TestParseStatm(t *testing.T) {
	res, shr, err := ParseStatm([]byte("9000 3000 900 10 0 500 0\n"))
	if err != nil || res != 3000 || shr != 900 {
		t.Fatalf("%d %d %v", res, shr, err)
	}
	if _, _, err := ParseStatm([]byte("12")); err == nil {
		t.Fatal("expected error")
	}
}

func TestContainerIDFromCgroup(t *testing.T) {
	id := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for _, in := range []string{
		"0::/system.slice/docker-" + id + ".scope\n",
		"12:memory:/docker/" + id + "\n1:name=systemd:/docker/" + id + "\n",
	} {
		if got := ContainerIDFromCgroup([]byte(in)); got != id {
			t.Fatalf("%q → %q", in, got)
		}
	}
	if got := ContainerIDFromCgroup([]byte("0::/user.slice/user-1000.slice/session-2.scope\n")); got != "" {
		t.Fatalf("host process: %q", got)
	}
}
