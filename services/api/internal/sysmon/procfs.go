package sysmon

import (
	"bufio"
	"bytes"
	"errors"
	"strconv"
	"strings"
)

// Pure parsers for /proc files. They take file contents so they can be
// table-tested with fixtures (testdata/).

var errFormat = errors.New("unexpected /proc format")

// CPUTimes are jiffies from one /proc/stat cpu line.
type CPUTimes struct {
	User, Nice, System, Idle, IOWait, IRQ, SoftIRQ, Steal uint64
}

// Total is all time except guest (already counted in user/nice).
func (c CPUTimes) Total() uint64 {
	return c.User + c.Nice + c.System + c.Idle + c.IOWait + c.IRQ + c.SoftIRQ + c.Steal
}

// Idle time includes iowait (the CPU had nothing to run).
func (c CPUTimes) idleAll() uint64 { return c.Idle + c.IOWait }

// ProcStat is /proc/stat: the aggregate line and one per core.
type ProcStat struct {
	All   CPUTimes
	Cores []CPUTimes
}

// ParseProcStat parses /proc/stat.
func ParseProcStat(b []byte) (ProcStat, error) {
	var st ProcStat
	found := false
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 5 || !strings.HasPrefix(f[0], "cpu") {
			continue
		}
		var v [8]uint64
		for i := 0; i < 8 && i+1 < len(f); i++ {
			v[i], _ = strconv.ParseUint(f[i+1], 10, 64)
		}
		t := CPUTimes{v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]}
		if f[0] == "cpu" {
			st.All, found = t, true
		} else {
			st.Cores = append(st.Cores, t)
		}
	}
	if !found {
		return st, errFormat
	}
	return st, nil
}

// CPUPercents are usage shares between two samples, 0..100.
type CPUPercents struct{ Usage, Steal, IOWait float64 }

// CPUDelta computes usage between two samples of the same CPU.
func CPUDelta(prev, cur CPUTimes) CPUPercents {
	total := float64(sub(cur.Total(), prev.Total()))
	if total <= 0 {
		return CPUPercents{}
	}
	idle := float64(sub(cur.idleAll(), prev.idleAll()))
	return CPUPercents{
		Usage:  clamp100((total - idle) / total * 100),
		Steal:  clamp100(float64(sub(cur.Steal, prev.Steal)) / total * 100),
		IOWait: clamp100(float64(sub(cur.IOWait, prev.IOWait)) / total * 100),
	}
}

func sub(a, b uint64) uint64 {
	if a < b {
		return 0 // counter reset (or a CPU went offline)
	}
	return a - b
}

func clamp100(v float64) float64 {
	switch {
	case v < 0:
		return 0
	case v > 100:
		return 100
	}
	return v
}

// ParseMeminfo parses /proc/meminfo into bytes.
func ParseMeminfo(b []byte) (Memory, error) {
	kv := map[string]uint64{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		k, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		n, err := strconv.ParseUint(f[0], 10, 64)
		if err != nil {
			continue
		}
		if len(f) > 1 && f[1] == "kB" {
			n *= 1024
		}
		kv[k] = n
	}
	total, ok := kv["MemTotal"]
	if !ok || total == 0 {
		return Memory{}, errFormat
	}
	avail, ok := kv["MemAvailable"]
	if !ok { // kernels < 3.14
		avail = kv["MemFree"] + kv["Buffers"] + kv["Cached"]
	}
	if avail > total {
		avail = total
	}
	return Memory{
		Total:     total,
		Used:      total - avail,
		Available: avail,
		Cached:    kv["Cached"] + kv["Buffers"] + kv["SReclaimable"],
		SwapTotal: kv["SwapTotal"],
		SwapUsed:  sub(kv["SwapTotal"], kv["SwapFree"]),
	}, nil
}

// ParseLoadavg parses /proc/loadavg.
func ParseLoadavg(b []byte) ([3]float64, error) {
	var out [3]float64
	f := strings.Fields(string(b))
	if len(f) < 3 {
		return out, errFormat
	}
	for i := range 3 {
		v, err := strconv.ParseFloat(f[i], 64)
		if err != nil {
			return out, errFormat
		}
		out[i] = v
	}
	return out, nil
}

// ParseUptime parses /proc/uptime (seconds).
func ParseUptime(b []byte) (float64, error) {
	f := strings.Fields(string(b))
	if len(f) < 1 {
		return 0, errFormat
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0, errFormat
	}
	return v, nil
}

// NetCounters are cumulative bytes of one interface.
type NetCounters struct {
	Iface  string
	Rx, Tx uint64
}

// ParseNetDev parses /proc/net/dev, skipping loopback and virtual
// container plumbing (veth*, docker*, br-*).
func ParseNetDev(b []byte) []NetCounters {
	var out []NetCounters
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		name, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue // header lines
		}
		name = strings.TrimSpace(name)
		if SkipIface(name) {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 {
			continue
		}
		rx, err1 := strconv.ParseUint(f[0], 10, 64)
		tx, err2 := strconv.ParseUint(f[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		out = append(out, NetCounters{Iface: name, Rx: rx, Tx: tx})
	}
	return out
}

// SkipIface reports interfaces not worth showing.
func SkipIface(name string) bool {
	return name == "" || name == "lo" || strings.HasPrefix(name, "veth") ||
		strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "br-")
}

// PidStat is the part of /proc/[pid]/stat we use.
type PidStat struct {
	PID   int
	Comm  string
	Ticks uint64 // utime + stime
	RSS   uint64 // pages
}

// ParsePidStat parses /proc/[pid]/stat. The command name is in parentheses
// and may itself contain spaces or ")".
func ParsePidStat(b []byte) (PidStat, error) {
	s := string(b)
	open := strings.IndexByte(s, '(')
	end := strings.LastIndexByte(s, ')')
	if open < 1 || end < open {
		return PidStat{}, errFormat
	}
	pid, err := strconv.Atoi(strings.TrimSpace(s[:open]))
	if err != nil {
		return PidStat{}, errFormat
	}
	f := strings.Fields(s[end+1:])
	// f[0] is field 3 (state): field n is f[n-3].
	if len(f) < 22 {
		return PidStat{}, errFormat
	}
	ut, _ := strconv.ParseUint(f[11], 10, 64)
	st, _ := strconv.ParseUint(f[12], 10, 64)
	rss, _ := strconv.ParseInt(f[21], 10, 64)
	if rss < 0 {
		rss = 0
	}
	return PidStat{PID: pid, Comm: s[open+1 : end], Ticks: ut + st, RSS: uint64(rss)}, nil
}

// FriendlyName groups known process names (case-insensitive prefix match on
// the 15-character comm) so e.g. dozens of Chrome or postgres processes show
// as one row.
func FriendlyName(comm string) string {
	c := strings.ToLower(comm)
	switch {
	case strings.HasPrefix(c, "torrserver"):
		return "torrserver"
	case strings.HasPrefix(c, "prowlarr"):
		return "Prowlarr"
	case strings.HasPrefix(c, "jackett"):
		return "Jackett"
	case strings.HasPrefix(c, "flaresolverr"), strings.HasPrefix(c, "byparr"):
		return "flaresolverr"
	case strings.HasPrefix(c, "chrom"), strings.HasPrefix(c, "camoufox"), strings.HasPrefix(c, "firefox"),
		strings.HasPrefix(c, "xvfb"), c == "undetected_chro":
		return "chrome (browser)"
	case strings.HasPrefix(c, "postgres"), strings.HasPrefix(c, "postmaster"):
		return "postgres"
	case strings.HasPrefix(c, "martytv"):
		return "martytv"
	case c == "caddy":
		return "caddy"
	case c == "dockerd", strings.HasPrefix(c, "containerd"), c == "docker-proxy", c == "runc":
		return "docker"
	case c == "hbbs", c == "hbbr", strings.HasPrefix(c, "rustdesk"):
		return "rustdesk"
	case strings.HasPrefix(c, "amneziawg"), strings.HasPrefix(c, "awg"), strings.HasPrefix(c, "wg-"):
		return "amneziawg"
	case strings.HasPrefix(c, "systemd"):
		return "systemd"
	case strings.HasPrefix(c, "kworker"), strings.HasPrefix(c, "ksoftirqd"):
		return "kernel"
	}
	return comm
}
