// Package sysmon collects server load for the admin "Server" tab.
//
// Two programs use it:
//
//   - martytv-hostmon (cmd/martytv-hostmon), a small root service on the
//     host: it reads the host's /proc, statfs("/") and the Docker Engine API
//     (read-only GETs) and answers JSON on a unix socket. It owns the 10 s
//     sampler and the 1 h history ring, so history survives API restarts.
//   - the API (Service): asks hostmon over the socket and adds app metrics
//     (streams, WebSockets, DB size, image cache, TorrServer). Without
//     hostmon (dev) it falls back to the container's own /proc with
//     scope "container".
//
// Only process names (comm), pids, RSS and CPU% are ever reported: never
// command lines or environments.
package sysmon

import "time"

// HostStatus is what hostmon (or the local fallback) reports.
type HostStatus struct {
	Scope         string      `json:"scope"` // host | container
	CollectedAt   time.Time   `json:"collected_at"`
	UptimeSeconds float64     `json:"uptime_seconds"`
	LoadAvg       [3]float64  `json:"load_avg"`
	CPU           CPUStatus   `json:"cpu"`
	Memory        Memory      `json:"memory"`
	Disks         []Disk      `json:"disks"`
	Network       []NetIface  `json:"network"`
	Processes     []Process   `json:"processes"`
	Containers    []Container `json:"containers"`
}

type CPUStatus struct {
	Cores         int       `json:"cores"`
	UsagePercent  float64   `json:"usage_percent"`
	PerCore       []float64 `json:"per_core_percent"`
	StealPercent  float64   `json:"steal_percent"`
	IOWaitPercent float64   `json:"iowait_percent"`
}

// Memory values are bytes.
type Memory struct {
	Total     uint64 `json:"total"`
	Used      uint64 `json:"used"`
	Available uint64 `json:"available"`
	Cached    uint64 `json:"cached"`
	SwapTotal uint64 `json:"swap_total"`
	SwapUsed  uint64 `json:"swap_used"`
}

type Disk struct {
	Mount string `json:"mount"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Free  uint64 `json:"free"`
}

type NetIface struct {
	Iface   string  `json:"iface"`
	RxBps   float64 `json:"rx_bps"` // bytes per second
	TxBps   float64 `json:"tx_bps"`
	RxTotal uint64  `json:"rx_total"`
	TxTotal uint64  `json:"tx_total"`
}

// Process is one process or a friendly group of them (Count > 1).
type Process struct {
	Name       string  `json:"name"`
	PID        int     `json:"pid"` // the group's biggest member
	Count      int     `json:"count"`
	RSSBytes   uint64  `json:"rss_bytes"`
	CPUPercent float64 `json:"cpu_percent"` // of one core, like top
}

// Container is one Docker container's usage (hostmon only).
type Container struct {
	Name          string  `json:"name"`
	State         string  `json:"state"`
	CPUPercent    float64 `json:"cpu_percent"` // of one core
	MemBytes      uint64  `json:"mem_bytes"`
	MemLimitBytes uint64  `json:"mem_limit_bytes"` // 0 = no limit
}

// Sample is one history point (every 10 s).
type Sample struct {
	T             time.Time `json:"t"`
	CPUPercent    float64   `json:"cpu_percent"`
	MemUsed       uint64    `json:"mem_used"`
	Load1         float64   `json:"load1"`
	RxBps         float64   `json:"rx_bps"`
	TxBps         float64   `json:"tx_bps"`
	ActiveStreams *int      `json:"active_streams"`
}

// History is GET /v1/history (hostmon) and the API's history response body.
type History struct {
	Scope           string   `json:"scope"`
	IntervalSeconds int      `json:"interval_seconds"`
	MemTotal        uint64   `json:"mem_total"`
	Cores           int      `json:"cores"`
	Samples         []Sample `json:"samples"`
}

const (
	// SampleInterval is the history resolution.
	SampleInterval = 10 * time.Second
	// HistoryWindow is how much history is kept.
	HistoryWindow = time.Hour
	// TopProcesses is how many (grouped) processes are reported.
	TopProcesses = 12
)
