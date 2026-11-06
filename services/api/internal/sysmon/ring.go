package sysmon

import (
	"sync"
	"time"
)

// Ring keeps the last N samples in memory.
type Ring struct {
	mu   sync.Mutex
	buf  []Sample
	next int
	full bool
}

func NewRing(n int) *Ring { return &Ring{buf: make([]Sample, n)} }

// HistorySize is the ring length for HistoryWindow at SampleInterval.
const HistorySize = int(HistoryWindow / SampleInterval)

func (r *Ring) Add(s Sample) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf[r.next] = s
	r.next = (r.next + 1) % len(r.buf)
	if r.next == 0 {
		r.full = true
	}
}

// Since returns samples newer than t, oldest first.
func (r *Ring) Since(t time.Time) []Sample {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Sample{}
	start, n := 0, r.next
	if r.full {
		start, n = r.next, len(r.buf)
	}
	for i := range n {
		s := r.buf[(start+i)%len(r.buf)]
		if s.T.After(t) {
			out = append(out, s)
		}
	}
	return out
}

// Latest returns the newest sample.
func (r *Ring) Latest() (Sample, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.next == 0 && !r.full {
		return Sample{}, false
	}
	return r.buf[(r.next-1+len(r.buf))%len(r.buf)], true
}

// ClampMinutes bounds the ?minutes= query to 1..60 (default 60).
func ClampMinutes(m int) int {
	if m <= 0 || m > int(HistoryWindow/time.Minute) {
		return int(HistoryWindow / time.Minute)
	}
	return m
}
