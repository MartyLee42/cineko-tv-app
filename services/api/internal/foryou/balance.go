package foryou

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DeepSeek account balance for the admin «Рекомендации» tab:
// GET {DEEPSEEK_BASE_URL}/user/balance with the same key. Cached for
// balanceTTL and refreshed after every run; failures are cached too (as
// null) so a broken endpoint isn't hammered by the admin page.

const (
	balanceTTL     = 10 * time.Minute
	balanceTimeout = 10 * time.Second
)

// Balance is the contract's ForYouAIBalance.
type Balance struct {
	Available bool      `json:"available"`
	Currency  string    `json:"currency"`
	Total     float64   `json:"total"`
	Granted   float64   `json:"granted"`
	ToppedUp  float64   `json:"topped_up"`
	CheckedAt time.Time `json:"checked_at"`
}

type balanceCache struct {
	mu  sync.Mutex
	val *Balance
	at  time.Time
	ok  bool // at is set (a value or a failure is cached)
}

// Balance fetches the account balance. The first balance_infos entry is
// used, preferring USD. Errors never carry the URL or key.
func (c *aiClient) Balance(ctx context.Context) (*Balance, error) {
	ctx, cancel := context.WithTimeout(ctx, balanceTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/user/balance", nil)
	if err != nil {
		return nil, &aiError{"ai: bad request"}
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.key)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &aiError{"ai: balance request failed"}
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		return nil, &aiError{fmt.Sprintf("ai: balance HTTP %d", resp.StatusCode)}
	}
	var out struct {
		IsAvailable  bool `json:"is_available"`
		BalanceInfos []struct {
			Currency        string      `json:"currency"`
			TotalBalance    json.Number `json:"total_balance"`
			GrantedBalance  json.Number `json:"granted_balance"`
			ToppedUpBalance json.Number `json:"topped_up_balance"`
		} `json:"balance_infos"`
	}
	if err := json.Unmarshal(b, &out); err != nil || len(out.BalanceInfos) == 0 {
		return nil, &aiError{"ai: malformed balance"}
	}
	info := out.BalanceInfos[0]
	for _, bi := range out.BalanceInfos {
		if strings.EqualFold(bi.Currency, "USD") {
			info = bi
			break
		}
	}
	num := func(n json.Number) float64 {
		f, _ := strconv.ParseFloat(strings.TrimSpace(n.String()), 64)
		return f
	}
	return &Balance{Available: out.IsAvailable, Currency: strings.ToUpper(info.Currency), Total: num(info.TotalBalance),
		Granted: num(info.GrantedBalance), ToppedUp: num(info.ToppedUpBalance)}, nil
}

// aiBalance returns the cached balance (nil without a key or on failure),
// fetching it when older than balanceTTL.
func (s *Service) aiBalance(ctx context.Context) *Balance {
	if s.ai == nil {
		return nil
	}
	s.balance.mu.Lock()
	if s.balance.ok && s.now().Sub(s.balance.at) < balanceTTL {
		v := s.balance.val
		s.balance.mu.Unlock()
		return v
	}
	s.balance.mu.Unlock()
	return s.refreshBalance(ctx)
}

// refreshBalance fetches the balance now and caches it (also after runs).
func (s *Service) refreshBalance(ctx context.Context) *Balance {
	if s.ai == nil {
		return nil
	}
	b, err := s.ai.Balance(ctx)
	if err != nil {
		s.log.Warn("foryou: deepseek balance unavailable", "err", err)
		b = nil
	} else {
		b.CheckedAt = s.now().UTC()
	}
	s.balance.mu.Lock()
	s.balance.val, s.balance.at, s.balance.ok = b, s.now(), true
	s.balance.mu.Unlock()
	return b
}
