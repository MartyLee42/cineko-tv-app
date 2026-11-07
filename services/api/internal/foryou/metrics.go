package foryou

import "context"

// AIStats is today's DeepSeek use for /metrics (internal/metrics): every
// API feature (daily run, «Спросить ИИ», facts) shares one daily budget.
type AIStats struct {
	Enabled     bool
	TokensToday int
	CallsToday  int
	DailyBudget int
	AsksToday   int // «Спросить ИИ» requests, all accounts
	AskLimit    int // per account per day
	// Balance is the cached DeepSeek balance (nil: unknown / no key).
	Balance *Balance
}

// AIStats reads today's (Moscow day) counters: two indexed reads plus the
// cached balance (refetched at most every balanceTTL).
func (s *Service) AIStats(ctx context.Context) (AIStats, error) {
	out := AIStats{Enabled: s.ai != nil, DailyBudget: s.cfg.AIDailyTokens, AskLimit: s.cfg.AskDailyPerUser}
	var err error
	if out.TokensToday, out.CallsToday, err = s.aiUsageToday(ctx); err != nil {
		return out, err
	}
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE(sum(asks), 0)::int FROM foryou_ask_usage WHERE day = $1::date`,
		s.mskDay()).Scan(&out.AsksToday); err != nil {
		return out, err
	}
	out.Balance = s.aiBalance(ctx)
	return out, nil
}
