package ratings

import (
	"context"
	"sync"
)

// Priority orders queued work: titles opened in Details first, then titles
// merely shown in lists.
type Priority int

const (
	Low Priority = iota
	High
)

// queue is a deduplicating two-level FIFO of media ids. Low-priority pushes
// are dropped when it is full (they come back the next time the title is
// shown); high-priority pushes are always accepted. Progress itself is
// persisted on the media row, so losing the queue on restart loses nothing.
type queue struct {
	mu        sync.Mutex
	high, low []string
	// queued holds each pending id's current priority. An upgraded id stays
	// in the low slice too and is skipped there (lazy deletion).
	queued map[string]Priority
	max    int
	wake   chan struct{}
}

func newQueue(max int) *queue {
	return &queue{queued: map[string]Priority{}, max: max, wake: make(chan struct{}, 1)}
}

// Push enqueues id; it reports whether anything changed.
func (q *queue) Push(id string, p Priority) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	cur, ok := q.queued[id]
	switch {
	case ok && cur >= p:
		return false
	case !ok && p == Low && len(q.queued) >= q.max:
		return false
	}
	q.queued[id] = p
	if p == High {
		q.high = append(q.high, id)
	} else {
		q.low = append(q.low, id)
	}
	select {
	case q.wake <- struct{}{}:
	default:
	}
	return true
}

// TryPop returns the next id without blocking.
func (q *queue) TryPop() (string, Priority, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.high) > 0 {
		id := q.high[0]
		q.high = q.high[1:]
		if q.queued[id] == High {
			delete(q.queued, id)
			return id, High, true
		}
	}
	for len(q.low) > 0 {
		id := q.low[0]
		q.low = q.low[1:]
		if p, ok := q.queued[id]; ok && p == Low {
			delete(q.queued, id)
			return id, Low, true
		}
	}
	return "", 0, false
}

// Pop blocks until an id is available or ctx ends.
func (q *queue) Pop(ctx context.Context) (string, Priority, bool) {
	for {
		if id, p, ok := q.TryPop(); ok {
			return id, p, true
		}
		select {
		case <-ctx.Done():
			return "", 0, false
		case <-q.wake:
		}
	}
}

// Len is the number of pending ids.
func (q *queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.queued)
}

// DropLow forgets all low-priority work (used when the daily budget is gone).
func (q *queue) DropLow() {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, id := range q.low {
		if q.queued[id] == Low {
			delete(q.queued, id)
		}
	}
	q.low = nil
}
