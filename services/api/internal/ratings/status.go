package ratings

import (
	"context"
	"fmt"
	"strings"
	"time"

	"martytv/api/internal/integrations"
)

// quotaTTL keeps the admin status from asking the API on every poll.
const quotaTTL = 5 * time.Minute

// Name and Probe make the service an integrations.Prober ("kinopoisk" in
// GET /admin/integrations): configured = ids can be resolved (Wikidata
// and/or a key); ok = the key works (Wikidata alone: always ok, its
// failures show in error); budget_remaining = today's remaining keyed
// requests (our budget, capped by the API's own daily quota when it reports
// one); version names the sources ("kinopoiskapiunofficial.tech FREE +
// wikidata"). Nothing configured → configured=false and ratings stay null.
// The probe itself never queries Wikidata: it reports the last outcome.
func (s *Service) Name() string { return "kinopoisk" }

func (s *Service) Probe(ctx context.Context) integrations.Status {
	st := integrations.Status{Name: s.Name(), Configured: s.Configured(), CheckedAt: time.Now().UTC()}
	if !st.Configured {
		return st
	}
	var notes, version []string
	if s.prov != nil {
		remaining := s.budget.Remaining(ctx, High)
		st.BudgetRemaining = &remaining
		name := s.prov.Name()

		s.mu.Lock()
		q, fresh := s.quotaCache, time.Since(s.quotaAt) < quotaTTL
		authErr := s.authErr
		s.mu.Unlock()
		if !fresh {
			q = quotaInfo{}
			q.remaining, q.plan, q.ok, q.err = s.prov.Quota(ctx)
			s.mu.Lock()
			s.quotaCache, s.quotaAt = q, time.Now()
			s.mu.Unlock()
		}
		switch {
		case q.err != nil:
			st.Version, st.Error = name, q.err.Error()
			return st
		case authErr != nil:
			st.Version, st.Error = name, authErr.Error()
			return st
		}
		if q.ok {
			if q.plan != "" {
				name += " " + q.plan
			}
			remaining = min(remaining, q.remaining)
			st.BudgetRemaining = &remaining
		}
		version = append(version, name)
	}
	if s.wd != nil {
		version = append(version, "wikidata")
		if _, err := s.wd.Health(); err != nil {
			note := "wikidata: " + err.Error()
			if d := s.wd.BackoffRemaining(); d > 0 {
				note += fmt.Sprintf("; retrying in %s", d.Round(time.Second))
			}
			notes = append(notes, note)
		}
	}
	st.Version = strings.Join(version, " + ")
	st.OK = true
	if s.paused(false) {
		notes = append(notes, "rating.kinopoisk.ru is failing; retrying shortly")
	}
	st.Error = strings.Join(notes, "; ")
	return st
}
