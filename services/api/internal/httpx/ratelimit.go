package httpx

import (
	"sync"
	"time"
)

// RateLimiter is a small in-memory fixed-window limiter keyed by string. It is
// sized for a single-instance deployment of a few dozen users; it does not
// need to survive restarts.
type RateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string]*window
	now    func() time.Time
}

type window struct {
	start time.Time
	count int
}

func NewRateLimiter(limit int, per time.Duration) *RateLimiter {
	return &RateLimiter{limit: limit, window: per, hits: map[string]*window{}, now: time.Now}
}

// Allow records a hit for key and reports whether it is within the limit. When
// it is not, it returns how long until the window resets.
func (r *RateLimiter) Allow(key string) (bool, time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	w, ok := r.hits[key]
	if !ok || now.Sub(w.start) >= r.window {
		if len(r.hits) > 10000 {
			r.sweepLocked(now)
		}
		r.hits[key] = &window{start: now, count: 1}
		return true, 0
	}
	if w.count >= r.limit {
		return false, r.window - now.Sub(w.start)
	}
	w.count++
	return true, 0
}

func (r *RateLimiter) sweepLocked(now time.Time) {
	for k, w := range r.hits {
		if now.Sub(w.start) >= r.window {
			delete(r.hits, k)
		}
	}
}

// Lockout tracks consecutive failures per key and imposes an exponentially
// growing lock once a threshold is crossed (used for login and PIN checks).
type Lockout struct {
	mu        sync.Mutex
	threshold int
	base, max time.Duration
	entries   map[string]*lockEntry
	now       func() time.Time
}

type lockEntry struct {
	failures    int
	lockedUntil time.Time
	lastFailure time.Time
}

func NewLockout(threshold int, base, max time.Duration) *Lockout {
	return &Lockout{threshold: threshold, base: base, max: max, entries: map[string]*lockEntry{}, now: time.Now}
}

// Check returns how long key remains locked (0 if not locked).
func (l *Lockout) Check(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[key]
	if !ok {
		return 0
	}
	if d := e.lockedUntil.Sub(l.now()); d > 0 {
		return d
	}
	return 0
}

// Fail records a failed attempt.
func (l *Lockout) Fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	e, ok := l.entries[key]
	if !ok || now.Sub(e.lastFailure) > 24*time.Hour {
		e = &lockEntry{}
		l.entries[key] = e
	}
	e.failures++
	e.lastFailure = now
	if over := e.failures - l.threshold; over >= 0 {
		d := l.base << min(over, 20)
		if d > l.max || d <= 0 {
			d = l.max
		}
		e.lockedUntil = now.Add(d)
	}
	if len(l.entries) > 10000 {
		for k, v := range l.entries {
			if now.Sub(v.lastFailure) > 24*time.Hour {
				delete(l.entries, k)
			}
		}
	}
}

// Succeed clears the failure history for key.
func (l *Lockout) Succeed(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}
