package sysmon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// copyProc copies the fixture /proc into a temp dir the test can mutate.
func copyProc(t *testing.T) string {
	t.Helper()
	dst := t.TempDir()
	err := filepath.Walk("testdata/proc", func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel("testdata/proc", p)
		if info.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dst, rel), b, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

func write(t *testing.T, dir, name, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fakeClock returns a Collector clock the test advances.
func fakeClock(c *Collector) *time.Time {
	now := testTime()
	c.now = func() time.Time { return now }
	return &now
}

func TestCollectorDeltas(t *testing.T) {
	proc := copyProc(t)
	c := NewCollector(proc, "host", t.TempDir())
	c.pageSize = 4096
	now := fakeClock(c)

	first := c.Collect(true)
	if first.Scope != "host" || first.CPU.Cores != 2 || first.CPU.UsagePercent != 0 || first.LoadAvg[0] != 1.5 ||
		first.Memory.Total != 8000000*1024 || first.UptimeSeconds != 123456.78 {
		t.Fatalf("first %+v", first)
	}
	if len(first.Disks) != 1 || first.Disks[0].Mount != "/" || first.Disks[0].Total == 0 {
		t.Fatalf("disks %+v", first.Disks)
	}
	if len(first.Network) != 2 || first.Network[0].RxBps != 0 || first.Network[0].RxTotal != 1000000 {
		t.Fatalf("net %+v", first.Network)
	}
	// postgres groups two processes; torrserver is biggest (no statm: plain RSS).
	if len(first.Processes) != 3 || first.Processes[0].Name != "torrserver" || first.Processes[0].RSSBytes != 100000*4096 ||
		first.Processes[1].Name != "postgres" || first.Processes[1].Count != 2 || first.Processes[1].PID != 77 {
		t.Fatalf("procs %+v", first.Processes)
	}
	// Shared pages once: private 200 + 2100, plus the largest shared part 900.
	if first.Processes[1].RSSBytes != (200+2100+900)*4096 {
		t.Fatalf("postgres mem %d pages", first.Processes[1].RSSBytes/4096)
	}

	// Within minGap: cached.
	if again := c.Collect(true); !again.CollectedAt.Equal(first.CollectedAt) {
		t.Fatal("expected cached result")
	}

	// 10 s later: 1000 jiffies passed (500 per core), half of it busy.
	*now = now.Add(10 * time.Second)
	write(t, proc, "stat", "cpu  1300 0 600 8450 250 0 100 300 0 0\ncpu0 900 0 350 4000 100 0 50 100 0 0\ncpu1 500 0 250 4450 150 0 50 100 0 0\n")
	write(t, proc, "net/dev", "h\nh\n  eth0: 1100000 0 0 0 0 0 0 0 520000 0 0 0 0 0 0 0\n  awg0: 2000 0 0 0 0 0 0 0 3000 0 0 0 0 0 0 0\n")
	// torrserver used 100 ticks = 20% of one core; pid 43 exited; 99 is new.
	write(t, proc, "42/stat", "42 (TorrServer-linu) S 1 42 42 0 -1 4194560 100 0 0 0 350 150 0 0 20 0 30 0 100 900000000 100000 0 0 0 0")
	if err := os.RemoveAll(filepath.Join(proc, "43")); err != nil {
		t.Fatal(err)
	}
	write(t, proc, "99/stat", "99 (caddy) S 1 99 99 0 -1 0 0 0 0 0 1 1 0 0 20 0 5 0 100 1 500 0 0 0 0")

	st := c.Collect(true)
	if st.CPU.UsagePercent != 50 || st.CPU.StealPercent != 10 || st.CPU.IOWaitPercent != 5 {
		t.Fatalf("cpu %+v", st.CPU)
	}
	if st.CPU.PerCore[0] != 100 || st.CPU.PerCore[1] != 0 {
		t.Fatalf("per core %+v", st.CPU.PerCore)
	}
	if st.Network[0].Iface != "eth0" || st.Network[0].RxBps != 10000 || st.Network[0].TxBps != 2000 || st.Network[1].RxBps != 0 {
		t.Fatalf("net %+v", st.Network)
	}
	byName := map[string]Process{}
	for _, p := range st.Processes {
		byName[p.Name] = p
	}
	if byName["torrserver"].CPUPercent != 20 || byName["postgres"].Count != 1 || byName["postgres"].RSSBytes != 3000*4096 || byName["caddy"].CPUPercent != 0 {
		t.Fatalf("procs %+v", st.Processes)
	}
	s := SampleFrom(st)
	if s.CPUPercent != 50 || s.RxBps != 10000 || s.TxBps != 2000 || s.Load1 != 1.5 || s.MemUsed != st.Memory.Used {
		t.Fatalf("sample %+v", s)
	}
}

func TestCollectorMissingProc(t *testing.T) {
	c := NewCollector(filepath.Join(t.TempDir(), "nope"), "container")
	st := c.Collect(true)
	if st.CPU.Cores != 0 || len(st.Processes) != 0 || st.Disks == nil || st.Network == nil {
		t.Fatalf("%+v", st)
	}
}

// Two postgres containers are two rows; each counts its shared memory once.
func TestScanProcsPerContainer(t *testing.T) {
	proc := copyProc(t)
	idA, idB := strings.Repeat("a", 64), strings.Repeat("b", 64)
	write(t, proc, "43/cgroup", "0::/system.slice/docker-"+idA+".scope\n")
	write(t, proc, "77/cgroup", "0::/system.slice/docker-"+idA+".scope\n")
	write(t, proc, "88/stat", "88 (postgres) S 1 88 88 0 -1 4194560 100 0 0 0 5 5 0 0 20 0 1 0 100 9000000 500 18446744073709551615 0 0 0")
	write(t, proc, "88/statm", "9000 500 300 10 0 200 0\n")
	write(t, proc, "88/cgroup", "12:memory:/docker/"+idB+"\n")
	c := NewCollector(proc, "host")
	c.pageSize = 4096

	procs := NameContainers(c.Collect(true).Processes, []Container{{ID: idA, Name: "martytv-postgres-1"}})
	var a, b *Process
	for i := range procs {
		switch procs[i].Container {
		case "martytv-postgres-1":
			a = &procs[i]
		case idB[:12]: // not listed by Docker: the short id
			b = &procs[i]
		}
	}
	if a == nil || b == nil || a.Name != "postgres" || a.Count != 2 || a.RSSBytes != 3200*4096 || b.Count != 1 || b.RSSBytes != 500*4096 {
		t.Fatalf("procs %+v", procs)
	}
	// The collector's cached slice is not modified.
	for _, p := range c.Collect(true).Processes {
		if p.Container != "" {
			t.Fatalf("cached slice named: %+v", p)
		}
	}
}
