package foryou

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"martytv/api/internal/catalog"
)

// Runs: the daily job (FORYOU_DAILY_AT, Moscow time) and the admin button
// share one pipeline per profile: credits fill → taste → rows cache → AI
// collections; scope "all" adds global collections and housekeeping. One
// run at a time; progress lives in foryou_runs.

// ErrRunning is returned by StartRun while another run is active.
type ErrRunning struct{ RunID string }

func (e *ErrRunning) Error() string { return "foryou: run " + e.RunID + " in progress" }

const maxRunErrors = 50

// RunError is one recorded failure (contract ForYouRunError).
type RunError struct {
	ProfileID *string `json:"profile_id"`
	Step      string  `json:"step"`
	Message   string  `json:"message"`
}

type runState struct {
	id string
	mu sync.Mutex
	// counters
	done, aiCalls, aiTokens, collections, tmdb int
	errs                                       []RunError
	aiStopped                                  bool
	// interactive: an Ask AI request (no background pacing).
	interactive bool
}

func (r *runState) tokens() int { r.mu.Lock(); defer r.mu.Unlock(); return r.aiTokens }
func (r *runState) addAI(t int) {
	r.mu.Lock()
	r.aiCalls++
	r.aiTokens += t
	r.mu.Unlock()
}
func (r *runState) addCollections(n int) { r.mu.Lock(); r.collections += n; r.mu.Unlock() }
func (r *runState) spendTMDB() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.tmdb >= resolveBudget {
		return false
	}
	r.tmdb++
	return true
}
func (r *runState) addError(profileID, step, msg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.errs) >= maxRunErrors {
		return
	}
	var pid *string
	if profileID != "" {
		pid = &profileID
	}
	r.errs = append(r.errs, RunError{ProfileID: pid, Step: step, Message: clip(msg, 300)})
}

// StartRun starts a background run. scope: all | user | profile.
func (s *Service) StartRun(ctx context.Context, scope, targetID string, ai bool, trigger, requestedBy string) (string, error) {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.running != "" {
		return "", &ErrRunning{RunID: s.running}
	}
	profiles, err := s.runProfiles(ctx, scope, targetID)
	if err != nil {
		return "", err
	}
	var target, by *string
	if targetID != "" {
		target = &targetID
	}
	if requestedBy != "" {
		by = &requestedBy
	}
	var id string
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO foryou_runs (scope, target_id, ai, trigger, requested_by, profiles_total)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, scope, target, ai, trigger, by, len(profiles)).Scan(&id); err != nil {
		return "", err
	}
	s.running = id
	run := &runState{id: id}
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		s.execute(run, scope, ai, profiles)
	}()
	return id, nil
}

// runProfiles lists the profiles a run covers. "all" = profiles active in
// the last 30 days, or every profile when there are few.
func (s *Service) runProfiles(ctx context.Context, scope, targetID string) ([]string, error) {
	var sql string
	var args []any
	switch scope {
	case "profile":
		sql, args = `SELECT id FROM profiles WHERE id = $1`, []any{targetID}
	case "user":
		sql, args = `SELECT id FROM profiles WHERE user_id = $1 ORDER BY created_at, id`, []any{targetID}
	default:
		sql = `
			WITH all_p AS (SELECT p.id, p.created_at FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.disabled_at IS NULL),
			active AS (
				SELECT profile_id FROM watch_progress WHERE updated_at > now() - interval '30 days'
				UNION SELECT profile_id FROM ratings WHERE updated_at > now() - interval '30 days'
				UNION SELECT profile_id FROM foryou_feedback WHERE created_at > now() - interval '30 days'
				UNION SELECT profile_id FROM playback_sessions WHERE started_at > now() - interval '30 days')
			SELECT id FROM all_p
			WHERE (SELECT count(*) FROM all_p) <= 30 OR id IN (SELECT profile_id FROM active)
			ORDER BY created_at, id`
	}
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if scope != "all" && len(out) == 0 {
		return nil, errNotFound
	}
	return out, nil
}

func (s *Service) execute(run *runState, scope string, ai bool, profiles []string) {
	ctx := s.base()
	start := time.Now()
	defer func() {
		status := "completed"
		if r := recover(); r != nil {
			status = "failed"
			run.addError("", "run", "internal error")
			s.log.Error("foryou: run panicked", "panic", r)
		}
		if ctx.Err() != nil {
			status = "failed"
			run.addError("", "run", "interrupted")
		}
		s.saveRun(context.WithoutCancel(ctx), run, status)
		if ai {
			s.refreshBalance(context.WithoutCancel(ctx))
		}
		s.runMu.Lock()
		s.running = ""
		s.runMu.Unlock()
		run.mu.Lock()
		s.log.Info("foryou: run finished", "run_id", run.id, "status", status, "profiles", run.done,
			"ai_calls", run.aiCalls, "ai_tokens", run.aiTokens, "collections", run.collections,
			"errors", len(run.errs), "duration_ms", time.Since(start).Milliseconds())
		run.mu.Unlock()
	}()
	s.log.Info("foryou: run started", "run_id", run.id, "scope", scope, "profiles", len(profiles), "ai", ai)
	for _, pid := range profiles {
		if ctx.Err() != nil {
			return
		}
		s.runProfile(ctx, run, pid, ai)
		run.mu.Lock()
		run.done++
		run.mu.Unlock()
		s.saveRun(ctx, run, "running")
	}
	if scope == "all" && ai && s.ai != nil && !run.aiStopped {
		pctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		if _, err := s.generateGlobalCollections(pctx, run); err != nil {
			s.recordAIError(run, "", "global_ai", err)
		} else {
			// Global collections show up for everyone.
			s.notify(ctx, profiles, "collections")
		}
		cancel()
	}
	if scope == "all" {
		s.housekeeping(ctx)
	}
}

// runProfile never fails the run: each step records its error and moves on.
func (s *Service) runProfile(ctx context.Context, run *runState, pid string, ai bool) {
	pctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	if err := s.fillCredits(pctx, pid); err != nil {
		run.addError(pid, "credits", errText(err))
	}
	lang := s.profileLang(pctx, pid)
	t, _, err := s.computeTaste(pctx, pid)
	if err != nil {
		run.addError(pid, "taste", errText(err))
		return
	}
	if ai && s.ai != nil && !run.aiStopped {
		if _, err := s.generateProfileCollections(pctx, run, pid, t); err != nil {
			s.recordAIError(run, pid, "ai", err)
		}
	}
	// Rows last, so today's collections become rows.
	if _, err := s.computeProfile(pctx, pid, lang, true); err != nil {
		run.addError(pid, "rows", errText(err))
		return
	}
	s.notify(ctx, []string{pid}, "run")
}

func (s *Service) recordAIError(run *runState, pid, step string, err error) {
	if errors.Is(err, errBudget) {
		run.mu.Lock()
		run.aiStopped = true
		run.mu.Unlock()
	}
	run.addError(pid, step, errText(err))
}

// errText is a safe error message (no URLs or keys: every client error is
// already sanitized; DB errors carry no secrets).
func errText(err error) string {
	switch {
	case errors.Is(err, errBudget):
		return "ai token budget exhausted"
	case errors.Is(err, errInvalidAI):
		return "ai returned invalid JSON"
	case errors.Is(err, context.DeadlineExceeded):
		return "timed out"
	}
	return err.Error()
}

// fillCredits loads TMDB details (cast/crew, countries, runtime) for the
// profile's most important signal titles that lack them, so director and
// actor affinities work for imported ratings. Budgeted per run and paced.
func (s *Service) fillCredits(ctx context.Context, profileID string) error {
	if !s.cat.Available() || s.cfg.CreditsPerProfile <= 0 {
		return nil
	}
	lang := s.profileLang(ctx, profileID)
	rows, err := s.pool.Query(ctx, `
		SELECT m.id FROM media m
		LEFT JOIN ratings r ON r.profile_id = $1 AND r.media_id = m.id
		LEFT JOIN favorites f ON f.profile_id = $1 AND f.media_id = m.id
		WHERE m.details_fetched_at = '{}'::jsonb
		  AND (r.media_id IS NOT NULL OR f.media_id IS NOT NULL
		       OR EXISTS (SELECT 1 FROM watch_progress wp WHERE wp.profile_id = $1 AND wp.media_id = m.id AND wp.completed))
		ORDER BY (f.media_id IS NOT NULL) DESC, r.rating DESC NULLS LAST, r.updated_at DESC NULLS LAST, m.id
		LIMIT $2`, profileID, s.cfg.CreditsPerProfile)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	failures := 0
	for _, id := range ids {
		if err := s.pace.Wait(ctx); err != nil {
			return err
		}
		if _, err := s.cat.Detail(ctx, id, lang); err != nil && !errors.Is(err, catalog.ErrNotFound) {
			failures++
			if failures >= 5 {
				return errors.New("tmdb details failing; credits fill paused")
			}
		}
	}
	return nil
}

func (s *Service) saveRun(ctx context.Context, run *runState, status string) {
	run.mu.Lock()
	errs, _ := json.Marshal(nonNilSlice(run.errs))
	done, calls, tokens, cols := run.done, run.aiCalls, run.aiTokens, run.collections
	run.mu.Unlock()
	_, err := s.pool.Exec(ctx, `
		UPDATE foryou_runs SET status = $2, profiles_done = $3, ai_calls = $4, ai_tokens = $5, collections_created = $6,
			errors = $7, finished_at = CASE WHEN $2 = 'running' THEN NULL ELSE now() END
		WHERE id = $1`, run.id, status, done, calls, tokens, cols, errs)
	if err != nil {
		s.log.Warn("foryou: run update failed", "err", err)
	}
}

// housekeeping prunes old collections, feedback and runs.
func (s *Service) housekeeping(ctx context.Context) {
	for _, q := range []string{
		`DELETE FROM foryou_collections WHERE generated_at < now() - interval '7 days'`,
		`DELETE FROM foryou_feedback WHERE created_at < now() - interval '180 days'`,
		`DELETE FROM foryou_runs WHERE started_at < now() - interval '60 days' AND status <> 'running'`,
		`DELETE FROM foryou_ai_usage WHERE day < current_date - 90`,
	} {
		if _, err := s.pool.Exec(ctx, q); err != nil && ctx.Err() == nil {
			s.log.Warn("foryou: housekeeping failed", "err", err)
		}
	}
}

// ---- scheduler ----

// nextDaily is the next HH:MM Moscow time after now.
func (s *Service) nextDaily(now time.Time) *time.Time {
	if s.cfg.DailyOff {
		return nil
	}
	m := now.In(msk)
	next := time.Date(m.Year(), m.Month(), m.Day(), s.cfg.DailyHour, s.cfg.DailyMinute, 0, 0, msk)
	if !next.After(m) {
		next = next.AddDate(0, 0, 1)
	}
	t := next.UTC()
	return &t
}

// Run is the daily scheduler (started from main). Runs left "running" by a
// previous process are marked failed; a missed daily run is caught up a
// few minutes after start.
func (s *Service) Run(ctx context.Context) {
	s.runMu.Lock()
	s.baseCtx = ctx
	s.runMu.Unlock()
	if _, err := s.pool.Exec(ctx, `
		UPDATE foryou_runs SET status = 'failed', finished_at = now(),
			errors = errors || '[{"profile_id": null, "step": "run", "message": "interrupted by restart"}]'::jsonb
		WHERE status = 'running'`); err != nil {
		s.log.Warn("foryou: could not close stale runs", "err", err)
	}
	if s.cfg.DailyOff {
		s.log.Info("foryou: daily run disabled (FORYOU_DAILY_AT=off)")
		<-ctx.Done()
		return
	}
	var recent bool
	_ = s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM foryou_runs WHERE scope = 'all' AND status = 'completed'
		AND trigger IN ('schedule', 'startup') AND started_at > now() - interval '26 hours')`).Scan(&recent)
	wait := time.Until(*s.nextDaily(s.now()))
	trigger := "schedule"
	if !recent && wait > time.Hour {
		wait, trigger = 3*time.Minute, "startup"
	}
	for {
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		if _, err := s.StartRun(ctx, "all", "", true, trigger, ""); err != nil {
			s.log.Warn("foryou: scheduled run not started", "err", err)
		}
		trigger = "schedule"
		wait = time.Until(*s.nextDaily(s.now().Add(time.Minute)))
	}
}

// ---- admin listing ----

// RunInfo is the contract's ForYouRun.
type RunInfo struct {
	ID                 string     `json:"id"`
	Scope              string     `json:"scope"`
	TargetID           *string    `json:"target_id"`
	AI                 bool       `json:"ai"`
	Trigger            string     `json:"trigger"`
	Status             string     `json:"status"`
	RequestedBy        *UserRef   `json:"requested_by"`
	ProfilesTotal      int        `json:"profiles_total"`
	ProfilesDone       int        `json:"profiles_done"`
	AICalls            int        `json:"ai_calls"`
	AITokens           int        `json:"ai_tokens"`
	CollectionsCreated int        `json:"collections_created"`
	Errors             []RunError `json:"errors"`
	StartedAt          time.Time  `json:"started_at"`
	FinishedAt         *time.Time `json:"finished_at"`
	DurationMS         *int64     `json:"duration_ms"`
}

type UserRef struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

func (s *Service) listRuns(ctx context.Context) ([]RunInfo, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT r.id, r.scope, r.target_id, r.ai, r.trigger, r.status, u.id, u.username,
		       r.profiles_total, r.profiles_done, r.ai_calls, r.ai_tokens, r.collections_created, r.errors,
		       r.started_at, r.finished_at
		FROM foryou_runs r LEFT JOIN users u ON u.id = r.requested_by
		ORDER BY r.started_at DESC, r.id LIMIT 30`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RunInfo{}
	for rows.Next() {
		var r RunInfo
		var uid, uname *string
		var errs []byte
		if err := rows.Scan(&r.ID, &r.Scope, &r.TargetID, &r.AI, &r.Trigger, &r.Status, &uid, &uname,
			&r.ProfilesTotal, &r.ProfilesDone, &r.AICalls, &r.AITokens, &r.CollectionsCreated, &errs,
			&r.StartedAt, &r.FinishedAt); err != nil {
			return nil, err
		}
		if uid != nil && uname != nil {
			r.RequestedBy = &UserRef{ID: *uid, Username: *uname}
		}
		_ = json.Unmarshal(errs, &r.Errors)
		if r.Errors == nil {
			r.Errors = []RunError{}
		}
		if r.FinishedAt != nil {
			d := r.FinishedAt.Sub(r.StartedAt).Milliseconds()
			r.DurationMS = &d
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
