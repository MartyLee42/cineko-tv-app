package sysmon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Docker is a read-only Docker Engine API client over the unix socket. It can
// only issue two requests — GET /containers/json and
// GET /containers/{id}/stats?stream=false&one-shot=true — there is no code
// path for anything that changes state.
type Docker struct {
	hc *http.Client

	mu   sync.Mutex
	prev map[string]dockerCPU // container id → last CPU counters
}

type dockerCPU struct{ total, system uint64 }

func NewDocker(socket string) *Docker {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     30 * time.Second,
	}
	return &Docker{hc: &http.Client{Transport: tr, Timeout: 5 * time.Second}, prev: map[string]dockerCPU{}}
}

var containerID = regexp.MustCompile(`^[0-9a-f]{12,64}$`)

func (d *Docker) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := d.hc.Do(req)
	if err != nil {
		return errors.New("docker unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		return errors.New("docker: HTTP " + resp.Status)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out)
}

type dockerSummary struct {
	ID    string   `json:"Id"`
	Names []string `json:"Names"`
	State string   `json:"State"`
}

type dockerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  int    `json:"online_cpus"`
	} `json:"cpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
}

// Containers lists all containers with CPU% (since the previous call) and
// memory (excluding reclaimable page cache, like `docker stats`).
func (d *Docker) Containers(ctx context.Context, hostMem uint64) ([]Container, error) {
	var list []dockerSummary
	if err := d.get(ctx, "/containers/json?all=1", &list); err != nil {
		return nil, err
	}
	out := make([]Container, len(list))
	var wg sync.WaitGroup
	for i, s := range list {
		name := s.ID
		if len(s.Names) > 0 {
			name = strings.TrimPrefix(s.Names[0], "/")
		}
		out[i] = Container{Name: name, State: s.State}
		if s.State != "running" || !containerID.MatchString(s.ID) {
			continue
		}
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			var st dockerStats
			if err := d.get(ctx, "/containers/"+id+"/stats?stream=false&one-shot=true", &st); err != nil {
				return
			}
			out[i].MemBytes, out[i].MemLimitBytes = containerMem(st, hostMem)
			out[i].CPUPercent = d.cpu(id, st)
		}(i, s.ID)
	}
	wg.Wait()
	d.forget(list)
	sort.Slice(out, func(i, j int) bool {
		if (out[i].State == "running") != (out[j].State == "running") {
			return out[i].State == "running"
		}
		if out[i].MemBytes != out[j].MemBytes {
			return out[i].MemBytes > out[j].MemBytes
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

func containerMem(st dockerStats, hostMem uint64) (uint64, uint64) {
	m := st.MemoryStats
	cache := m.Stats["inactive_file"]                // cgroup v2
	if v, ok := m.Stats["total_inactive_file"]; ok { // cgroup v1
		cache = v
	}
	used := sub(m.Usage, cache)
	limit := m.Limit
	if hostMem > 0 && limit >= hostMem {
		limit = 0 // unlimited: Docker reports the host's RAM
	}
	return used, limit
}

func (d *Docker) cpu(id string, st dockerStats) float64 {
	cur := dockerCPU{st.CPUStats.CPUUsage.TotalUsage, st.CPUStats.SystemUsage}
	d.mu.Lock()
	prev, ok := d.prev[id]
	d.prev[id] = cur
	d.mu.Unlock()
	return ContainerCPUPercent(prev, cur, st.CPUStats.OnlineCPUs, ok)
}

// ContainerCPUPercent is Docker's formula: share of system time × CPUs × 100
// (100 = one full core).
func ContainerCPUPercent(prev, cur dockerCPU, cpus int, havePrev bool) float64 {
	if !havePrev || cpus <= 0 {
		return 0
	}
	dc, ds := sub(cur.total, prev.total), sub(cur.system, prev.system)
	if ds == 0 {
		return 0
	}
	return round1(float64(dc) / float64(ds) * float64(cpus) * 100)
}

func (d *Docker) forget(list []dockerSummary) {
	live := map[string]bool{}
	for _, s := range list {
		live[s.ID] = true
	}
	d.mu.Lock()
	for id := range d.prev {
		if !live[id] {
			delete(d.prev, id)
		}
	}
	d.mu.Unlock()
}
