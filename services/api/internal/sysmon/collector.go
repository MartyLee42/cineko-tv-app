package sysmon

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// Collector reads one /proc tree. Rates (CPU, network, per-process CPU) are
// deltas against the previous call, so it keeps a little state. Safe for
// concurrent use; calls closer than minGap reuse the last result.
type Collector struct {
	Proc  string   // "/proc" (or a fixture dir in tests)
	Scope string   // host | container
	Disks []string // mount points to statfs; the first is labelled "/"

	mu       sync.Mutex
	last     *HostStatus
	lastProc bool
	prevAt   time.Time
	prevCPU  *ProcStat
	prevNet  map[string]NetCounters
	// per-process CPU baseline
	prevTicks   map[int]uint64
	prevProcCPU uint64         // /proc/stat total jiffies when prevTicks was taken
	prevCgroups map[int]string // pid → container id ("" = none), last scan
	pageSize    uint64
	now         func() time.Time
}

const minGap = 2 * time.Second

func NewCollector(proc, scope string, disks ...string) *Collector {
	return &Collector{Proc: proc, Scope: scope, Disks: disks, pageSize: uint64(os.Getpagesize()), now: time.Now}
}

func (c *Collector) read(name string) ([]byte, error) {
	return os.ReadFile(filepath.Join(c.Proc, name))
}

// Collect gathers a snapshot. withProcs also scans /proc/[pid] (top
// processes); the history sampler skips that unless needed.
func (c *Collector) Collect(withProcs bool) HostStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if c.last != nil && now.Sub(c.last.CollectedAt) < minGap && (c.lastProc || !withProcs) {
		return *c.last
	}
	st := HostStatus{Scope: c.Scope, CollectedAt: now.UTC(), Disks: []Disk{}, Network: []NetIface{}, Processes: []Process{}, Containers: []Container{}}

	if b, err := c.read("uptime"); err == nil {
		st.UptimeSeconds, _ = ParseUptime(b)
	}
	if b, err := c.read("loadavg"); err == nil {
		st.LoadAvg, _ = ParseLoadavg(b)
	}
	if b, err := c.read("meminfo"); err == nil {
		st.Memory, _ = ParseMeminfo(b)
	}
	var cpu *ProcStat
	if b, err := c.read("stat"); err == nil {
		if ps, err := ParseProcStat(b); err == nil {
			cpu = &ps
		}
	}
	if cpu != nil {
		st.CPU.Cores = len(cpu.Cores)
		st.CPU.PerCore = make([]float64, len(cpu.Cores))
		if c.prevCPU != nil {
			p := CPUDelta(c.prevCPU.All, cpu.All)
			st.CPU.UsagePercent, st.CPU.StealPercent, st.CPU.IOWaitPercent = round1(p.Usage), round1(p.Steal), round1(p.IOWait)
			for i := range cpu.Cores {
				if i < len(c.prevCPU.Cores) {
					st.CPU.PerCore[i] = round1(CPUDelta(c.prevCPU.Cores[i], cpu.Cores[i]).Usage)
				}
			}
		}
	}

	if b, err := c.read("net/dev"); err == nil {
		dt := now.Sub(c.prevAt).Seconds()
		cur := map[string]NetCounters{}
		for _, n := range ParseNetDev(b) {
			cur[n.Iface] = n
			iface := NetIface{Iface: n.Iface, RxTotal: n.Rx, TxTotal: n.Tx}
			if p, ok := c.prevNet[n.Iface]; ok && dt > 0 {
				iface.RxBps = round1(float64(sub(n.Rx, p.Rx)) / dt)
				iface.TxBps = round1(float64(sub(n.Tx, p.Tx)) / dt)
			}
			st.Network = append(st.Network, iface)
		}
		c.prevNet = cur
	}

	seen := map[uint64]bool{}
	for i, m := range c.Disks {
		d, fsid, ok := statDisk(m)
		if !ok || seen[fsid] {
			continue
		}
		seen[fsid] = true
		if i == 0 {
			d.Mount = "/"
		}
		st.Disks = append(st.Disks, d)
	}

	if withProcs && cpu != nil {
		st.Processes = c.scanProcs(cpu)
	}

	c.prevAt = now
	if cpu != nil {
		c.prevCPU = cpu
	}
	c.last, c.lastProc = &st, withProcs
	return st
}

// scanProcs reads /proc/[pid]/stat for every process (one small read each;
// pids that vanish mid-scan are skipped), groups them by FriendlyName and
// returns the biggest groups by RSS.
func (c *Collector) scanProcs(cpu *ProcStat) []Process {
	entries, err := os.ReadDir(c.Proc)
	if err != nil {
		return []Process{}
	}
	cores := len(cpu.Cores)
	if cores == 0 {
		cores = 1
	}
	total := cpu.All.Total()
	// Jiffies one core had available since the baseline.
	var perCore float64
	if c.prevTicks != nil && total > c.prevProcCPU {
		perCore = float64(total-c.prevProcCPU) / float64(cores)
	}
	ticks := make(map[int]uint64, len(entries))
	cgroups := make(map[int]string, len(entries))
	groups := map[string]*Process{}
	biggest := map[string]uint64{}
	shared := map[string]uint64{} // the group's largest shared part, added once
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		b, err := os.ReadFile(filepath.Join(c.Proc, e.Name(), "stat"))
		if err != nil {
			continue // exited
		}
		ps, err := ParsePidStat(b)
		if err != nil {
			continue
		}
		ticks[pid] = ps.Ticks
		var pct float64
		if prev, ok := c.prevTicks[pid]; ok && perCore > 0 {
			pct = float64(sub(ps.Ticks, prev)) / perCore * 100
		}
		rss := ps.RSS * c.pageSize
		if rss == 0 && pct == 0 {
			continue // idle kernel threads
		}
		// Shared pages (shared memory, libraries) are mapped by many members
		// of a group; summing RSS counts them once per process.
		private, shr := rss, uint64(0)
		if b, err := os.ReadFile(filepath.Join(c.Proc, e.Name(), "statm")); err == nil {
			if res, s, err := ParseStatm(b); err == nil && s <= res {
				private, shr = (res-s)*c.pageSize, s*c.pageSize
			}
		}
		// The container never changes for a pid: read its cgroup once.
		cid, ok := c.prevCgroups[pid]
		if !ok {
			if b, err := os.ReadFile(filepath.Join(c.Proc, e.Name(), "cgroup")); err == nil {
				cid = ContainerIDFromCgroup(b)
			}
		}
		cgroups[pid] = cid
		name := FriendlyName(ps.Comm)
		key := cid + "/" + name
		g := groups[key]
		if g == nil {
			g = &Process{Name: name, containerID: cid}
			groups[key] = g
		}
		g.Count++
		g.RSSBytes += private
		g.CPUPercent += pct
		if shr > shared[key] {
			shared[key] = shr
		}
		if rss >= biggest[key] {
			biggest[key], g.PID = rss, pid
		}
	}
	for key, s := range shared {
		groups[key].RSSBytes += s
	}
	c.prevTicks, c.prevProcCPU, c.prevCgroups = ticks, total, cgroups
	return TopGroups(groups, TopProcesses)
}

// TopGroups sorts groups by RSS (then CPU) and keeps n.
func TopGroups(groups map[string]*Process, n int) []Process {
	out := make([]Process, 0, len(groups))
	for _, g := range groups {
		g.CPUPercent = round1(g.CPUPercent)
		out = append(out, *g)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].RSSBytes != out[j].RSSBytes {
			return out[i].RSSBytes > out[j].RSSBytes
		}
		if out[i].CPUPercent != out[j].CPUPercent {
			return out[i].CPUPercent > out[j].CPUPercent
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].containerID < out[j].containerID
	})
	if len(out) > n {
		out = out[:n]
	}
	return out
}

// statDisk runs statfs on a path (never reads files under it).
func statDisk(path string) (Disk, uint64, bool) {
	var s syscall.Statfs_t
	if path == "" || syscall.Statfs(path, &s) != nil {
		return Disk{}, 0, false
	}
	bs := uint64(s.Bsize)
	total := s.Blocks * bs
	free := s.Bavail * bs
	used := sub(total, s.Bfree*bs)
	fsid := uint64(uint32(s.Fsid.X__val[0]))<<32 | uint64(uint32(s.Fsid.X__val[1]))
	return Disk{Mount: path, Total: total, Used: used, Free: free}, fsid, true
}

// StatDisk is statDisk for callers outside the package (the API adds the
// image-cache volume).
func StatDisk(path string) (Disk, bool) {
	d, _, ok := statDisk(path)
	return d, ok
}

func round1(v float64) float64 {
	return float64(int64(v*10+0.5)) / 10
}

// SampleFrom turns a snapshot into a history point.
func SampleFrom(st HostStatus) Sample {
	s := Sample{T: st.CollectedAt, CPUPercent: st.CPU.UsagePercent, MemUsed: st.Memory.Used, Load1: st.LoadAvg[0]}
	for _, n := range st.Network {
		s.RxBps += n.RxBps
		s.TxBps += n.TxBps
	}
	return s
}
