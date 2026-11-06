package foryou

import (
	"context"
	"errors"
	"time"
)

// «Обновить подборки ИИ»: a user regenerates one profile's AI collections
// (and rows) in the background — the daily run's per-profile pipeline with
// AI on, minus the credits fill. One per profile per Moscow day on top of
// the daily run (admins unlimited), within the global token budget. The
// taste-note regeneration (prefs.go) shares the pipeline but not the limit.

var errRegenLimit = errors.New("regenerate limit reached")

// RegenStatus is the contract's ForYouRegenStatus.
type RegenStatus struct {
	Available       bool      `json:"available"`
	UsedToday       int       `json:"used_today"`
	DailyLimit      int       `json:"daily_limit"`
	Unlimited       bool      `json:"unlimited"`
	NextAvailableAt time.Time `json:"next_available_at"`
	Running         bool      `json:"running"`
	RunID           *string   `json:"run_id"`
	AIEnabled       bool      `json:"ai_enabled"`
}

const regenDailyLimit = 1

func (s *Service) mskDay() string { return s.now().In(msk).Format("2006-01-02") }

// nextMidnightMSK is the start of the next Moscow day.
func (s *Service) nextMidnightMSK() time.Time {
	y, m, d := s.now().In(msk).Date()
	return time.Date(y, m, d+1, 0, 0, 0, 0, msk).UTC()
}

// RegenStatus reports whether the profile may regenerate now.
func (s *Service) RegenStatus(ctx context.Context, profileID string, unlimited bool) (*RegenStatus, error) {
	st := &RegenStatus{DailyLimit: regenDailyLimit, Unlimited: unlimited, AIEnabled: s.ai != nil, NextAvailableAt: s.now().UTC().Truncate(time.Second)}
	if err := s.pool.QueryRow(ctx, `SELECT COALESCE((SELECT used FROM foryou_regen_usage WHERE profile_id = $1 AND day = $2::date), 0)`,
		profileID, s.mskDay()).Scan(&st.UsedToday); err != nil {
		return nil, err
	}
	if v, ok := s.regenRuns.Load(profileID); ok {
		id := v.(string)
		st.Running, st.RunID = true, &id
	}
	if !unlimited && st.UsedToday >= regenDailyLimit {
		st.NextAvailableAt = s.nextMidnightMSK()
	}
	st.Available = st.AIEnabled && !st.Running && (unlimited || st.UsedToday < regenDailyLimit)
	return st, nil
}

// Regenerate starts a manual regeneration for the profile. A regeneration
// already running for it is returned as is (not counted again).
func (s *Service) Regenerate(ctx context.Context, profileID, userID string, unlimited bool) (string, error) {
	if s.ai == nil {
		return "", errAIDisabled
	}
	if v, ok := s.regenRuns.Load(profileID); ok {
		return v.(string), nil
	}
	if err := s.aiBudgetCheck(ctx, &runState{}); err != nil {
		return "", err
	}
	var used int
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO foryou_regen_usage (profile_id, day, used) VALUES ($1, $2::date, 1)
		ON CONFLICT (profile_id, day) DO UPDATE SET used = foryou_regen_usage.used + 1
		RETURNING used`, profileID, s.mskDay()).Scan(&used); err != nil {
		return "", err
	}
	if used > regenDailyLimit && !unlimited {
		s.refundRegen(ctx, profileID)
		return "", errRegenLimit
	}
	id, err := s.startProfileRegen(ctx, profileID, "user", userID)
	if err != nil {
		s.refundRegen(ctx, profileID)
		return "", err
	}
	return id, nil
}

// refundRegen gives the day's manual regeneration back (nothing was made).
func (s *Service) refundRegen(ctx context.Context, profileID string) {
	if _, err := s.pool.Exec(context.WithoutCancel(ctx), `
		UPDATE foryou_regen_usage SET used = greatest(used - 1, 0) WHERE profile_id = $1 AND day = $2::date`,
		profileID, s.mskDay()); err != nil {
		s.log.Warn("foryou: regenerate refund failed", "err", err)
	}
}

// startProfileRegen records a run (scope profile) and runs taste → AI
// collections → rows → foryou.updated in the background. At most one per
// profile at a time (the running one's id is returned).
func (s *Service) startProfileRegen(ctx context.Context, profileID, trigger, requestedBy string) (string, error) {
	var by *string
	if requestedBy != "" {
		by = &requestedBy
	}
	var id string
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO foryou_runs (scope, target_id, ai, trigger, requested_by, profiles_total)
		VALUES ('profile', $1, true, $2, $3, 1) RETURNING id`, profileID, trigger, by).Scan(&id); err != nil {
		return "", err
	}
	if prev, busy := s.regenRuns.LoadOrStore(profileID, id); busy {
		_, _ = s.pool.Exec(context.WithoutCancel(ctx), `DELETE FROM foryou_runs WHERE id = $1`, id)
		return prev.(string), nil
	}
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		defer s.regenRuns.Delete(profileID)
		s.regenerateProfile(id, profileID, trigger)
	}()
	return id, nil
}

func (s *Service) regenerateProfile(runID, profileID, trigger string) {
	ctx, cancel := context.WithTimeout(s.base(), 10*time.Minute)
	defer cancel()
	run := &runState{id: runID}
	defer func() {
		run.mu.Lock()
		run.done = 1
		run.mu.Unlock()
		status := "completed"
		if ctx.Err() != nil {
			status = "failed"
			run.addError(profileID, "run", "interrupted")
		}
		s.saveRun(context.WithoutCancel(ctx), run, status)
		s.refreshBalance(context.WithoutCancel(ctx))
	}()
	t, _, err := s.computeTaste(ctx, profileID)
	if err != nil {
		run.addError(profileID, "taste", errText(err))
		return
	}
	if _, err := s.generateProfileCollections(ctx, run, profileID, t); err != nil {
		s.recordAIError(run, profileID, "ai", err)
		if trigger == "user" {
			s.refundRegen(ctx, profileID) // the model failed: the user may try again
		}
	}
	if _, err := s.computeProfile(ctx, profileID, s.profileLang(ctx, profileID), true); err != nil {
		run.addError(profileID, "rows", errText(err))
		return
	}
	s.notify(ctx, []string{profileID}, "collections")
}
