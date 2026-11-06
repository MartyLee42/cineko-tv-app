package ratings

import (
	"context"
	"sync"
	"time"
)

// msk is Moscow time: Kinopoisk API quotas reset at Moscow midnight.
var msk = time.FixedZone("MSK", 3*60*60)

// BudgetStore persists the per-day request counter.
type BudgetStore interface {
	LoadBudget(ctx context.Context, day string) (int, error)
	SaveBudget(ctx context.Context, day string, used int) error
}

// lowShare is the part of the daily budget low-priority work (titles shown
// in lists, background) may spend; the rest is kept for titles a user opens.
const lowShare = 0.8

// Budget caps keyed API requests per (Moscow) day. The counter survives
// restarts through BudgetStore. Low-priority requests stop at lowShare of
// the limit so Details lookups always have budget left.
type Budget struct {
	mu     sync.Mutex
	limit  int
	day    string
	used   int
	loaded bool
	store  BudgetStore
	now    func() time.Time
}

func NewBudget(limit int, store BudgetStore, now func() time.Time) *Budget {
	if now == nil {
		now = time.Now
	}
	return &Budget{limit: limit, store: store, now: now}
}

// roll switches to today's counter (loading it once per day). Caller holds mu.
func (b *Budget) roll(ctx context.Context) {
	day := b.now().In(msk).Format("2006-01-02")
	if day == b.day && b.loaded {
		return
	}
	b.day, b.used, b.loaded = day, 0, true
	if b.store != nil {
		if n, err := b.store.LoadBudget(ctx, day); err == nil {
			b.used = n
		} else {
			b.loaded = false // retry the load next time
		}
	}
}

// capFor is the part of the limit priority p may use.
func (b *Budget) capFor(p Priority) int {
	if p == High {
		return b.limit
	}
	return int(float64(b.limit) * lowShare)
}

// Take spends one request at priority p; false when p's share of today's
// budget is gone.
func (b *Budget) Take(ctx context.Context, p Priority) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.roll(ctx)
	if b.used >= b.capFor(p) {
		return false
	}
	b.used++
	if b.store != nil {
		_ = b.store.SaveBudget(ctx, b.day, b.used)
	}
	return true
}

// Exhaust marks today's budget as spent (the API said the quota is over).
func (b *Budget) Exhaust(ctx context.Context) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.roll(ctx)
	if b.used < b.limit {
		b.used = b.limit
		if b.store != nil {
			_ = b.store.SaveBudget(ctx, b.day, b.used)
		}
	}
}

// Remaining is today's unspent budget available to priority p (High: all
// of it).
func (b *Budget) Remaining(ctx context.Context, p Priority) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.roll(ctx)
	return max(b.capFor(p)-b.used, 0)
}
