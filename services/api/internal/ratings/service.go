// Package ratings adds Kinopoisk and IMDb ratings to the catalog.
//
// Sources:
//   - rating.kinopoisk.ru/<kp_id>.xml (no key) gives the Kinopoisk and IMDb
//     ratings of a Kinopoisk id. Refreshed at most weekly per title, lazily
//     when the title is displayed.
//   - Wikidata (keyless SPARQL, wikidata.go) maps TMDB/IMDb ids to Kinopoisk
//     ids in batches of 150: tried first for every title, by a background
//     backfill of the whole catalog and on display. Misses are remembered
//     for 30 days.
//   - a keyed API (kinopoiskapiunofficial.tech or kinopoisk.dev) maps a TMDB
//     title to its Kinopoisk id when Wikidata has nothing: by IMDb id first
//     (fetched from TMDB when missing), then by TMDB id (kinopoisk.dev) or
//     title + year + kind. Requests are capped per day
//     (KINOPOISK_DAILY_BUDGET; list/background work may use 80% of it, the
//     rest is kept for titles opened in Details) and per second. Misses are
//     remembered for 30 days.
//
// Work is queued by priority: titles opened in Details (resolved
// synchronously with a short deadline so the page shows the rating), then
// titles shown in lists/search/home (background, deduplicated). Without a
// key only Wikidata resolves ids.
package ratings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
	"golang.org/x/time/rate"

	"martytv/api/internal/catalog"
	"martytv/api/internal/integrations/tmdb"
)

const (
	refreshAfter = 7 * 24 * time.Hour  // ratings are cached this long, then refetched when shown
	missRetry    = 30 * 24 * time.Hour // a failed lookup is not retried before this
	wdRetry      = 30 * 24 * time.Hour // nor a Wikidata miss
	detailWait   = 1500 * time.Millisecond
	opTimeout    = 30 * time.Second
	queueMax     = 2000
	// After a transient failure the matching worker pauses (don't hammer a
	// failing API); the refresh worker pauses for less.
	apiPause = 5 * time.Minute
	xmlPause = 1 * time.Minute
	// Keyword searches per title (each costs one request).
	maxTitleSearches = 2
	// Wikidata backfill pacing: one batch per wdBackfillGap (≈ 54,000
	// titles/hour at 150 per batch), idle wdBackfillIdle once done.
	wdBackfillGap   = 10 * time.Second
	wdBackfillIdle  = 6 * time.Hour
	wdBackfillStart = 45 * time.Second
)

var (
	errBudget = errors.New("kinopoisk: daily budget spent")
	errMiss   = errors.New("kinopoisk: no confident match")
	errPaused = errors.New("kinopoisk: paused after a failure")
)

// TMDB is the part of the TMDB client used to fetch missing IMDb ids.
type TMDB interface {
	Configured() bool
	Get(ctx context.Context, path string, q url.Values) ([]byte, error)
}

type Options struct {
	Store    Store
	Provider Provider        // nil: no key → the keyed API is never used
	Wikidata *WikidataClient // nil: Wikidata is not used
	Ratings  *RatingClient
	TMDB     TMDB // optional
	Budget   int
	// APIRate / XMLRate are requests per second (defaults 3 and 5).
	APIRate, XMLRate rate.Limit
	// WikidataGap spaces backfill batches (default wdBackfillGap).
	WikidataGap time.Duration
	Log         *slog.Logger
	Now         func() time.Time
}

type Service struct {
	store    Store
	prov     Provider
	wd       *WikidataClient
	xml      *RatingClient
	tmdb     TMDB
	budget   *Budget
	apiLimit *rate.Limiter
	xmlLimit *rate.Limiter
	wdGap    time.Duration
	log      *slog.Logger
	now      func() time.Time

	resolveQ, refreshQ, wdQ *queue
	sf                      singleflight.Group
	bg                      sync.WaitGroup

	mu         sync.Mutex
	apiPaused  time.Time // until
	xmlPaused  time.Time
	authErr    error
	quotaAt    time.Time
	quotaCache quotaInfo
}

type quotaInfo struct {
	remaining int
	plan      string
	ok        bool
	err       error
}

func New(o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.APIRate == 0 {
		o.APIRate = 3
	}
	if o.XMLRate == 0 {
		o.XMLRate = 5
	}
	if o.WikidataGap == 0 {
		o.WikidataGap = wdBackfillGap
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return &Service{
		store: o.Store, prov: o.Provider, wd: o.Wikidata, xml: o.Ratings, tmdb: o.TMDB,
		budget:   NewBudget(o.Budget, o.Store, o.Now),
		apiLimit: rate.NewLimiter(o.APIRate, 1),
		xmlLimit: rate.NewLimiter(o.XMLRate, 2),
		wdGap:    o.WikidataGap,
		log:      o.Log, now: o.Now,
		resolveQ: newQueue(queueMax), refreshQ: newQueue(queueMax), wdQ: newQueue(queueMax),
	}
}

// Wikidata is the shared SPARQL client (nil when Wikidata is off); other
// modules (internal/awards) query through it so one spacing/back-off
// covers all Wikidata traffic.
func (s *Service) Wikidata() *WikidataClient { return s.wd }

// Configured reports whether Kinopoisk ids can be resolved (Wikidata or a key).
func (s *Service) Configured() bool { return s.prov != nil || s.wd != nil }

func toTitle(r Row) catalog.TitleRatings {
	return catalog.TitleRatings{KP: catalog.RoundRating(r.KP), IMDb: catalog.RoundRating(r.IMDb), KPID: r.KPID}
}

func (s *Service) stale(r Row) bool {
	return r.KPID != nil && (r.FetchedAt == nil || s.now().Sub(*r.FetchedAt) > refreshAfter)
}

func (s *Service) recentMiss(r Row) bool {
	return r.LookupFailedAt != nil && s.now().Sub(*r.LookupFailedAt) < missRetry
}

// wdUsable: Wikidata may still know r's Kinopoisk id.
func (s *Service) wdUsable(r Row) bool {
	return s.wd != nil && r.KPID == nil && (r.WikidataAt == nil || s.now().Sub(*r.WikidataAt) >= wdRetry)
}

func (s *Service) paused(api bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if api {
		return s.now().Before(s.apiPaused)
	}
	return s.now().Before(s.xmlPaused)
}

func (s *Service) pause(api bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if api {
		s.apiPaused = s.now().Add(apiPause)
	} else {
		s.xmlPaused = s.now().Add(xmlPause)
	}
	s.log.Warn("kinopoisk request failed; pausing", "api", api, "err", err)
}

// keyedOK: the keyed API may be asked about r at priority p (a key, no
// pause, p's share of the budget left). The budget check may read the
// database once per day; afterwards it is in memory.
func (s *Service) keyedOK(ctx context.Context, r Row, p Priority) bool {
	return s.prov != nil && r.KPID == nil && !s.recentMiss(r) && !s.paused(true) && s.budget.Remaining(ctx, p) > 0
}

// Ratings returns stored ratings (one query) and queues lookups/refreshes
// at low priority: Wikidata first, the keyed API only for Wikidata misses.
// It never calls Kinopoisk or Wikidata itself.
func (s *Service) Ratings(ctx context.Context, ids []string) (map[string]catalog.TitleRatings, error) {
	rows, err := s.store.Rows(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[string]catalog.TitleRatings, len(rows))
	resolveOK := -1 // lazily computed: same answer for the whole batch
	for id, r := range rows {
		out[id] = toTitle(r)
		switch {
		case s.stale(r):
			s.refreshQ.Push(id, Low)
		case r.KPID != nil:
		case s.wdUsable(r):
			s.wdQ.Push(id, Low)
		case s.prov != nil && !s.recentMiss(r):
			if resolveOK < 0 {
				resolveOK = 0
				if !s.paused(true) && s.budget.Remaining(ctx, Low) > 0 {
					resolveOK = 1
				}
			}
			if resolveOK == 1 {
				s.resolveQ.Push(id, Low)
			}
		}
	}
	return out, nil
}

// DetailRatings returns a title's ratings, resolving/refreshing it first
// when needed and possible. It waits at most detailWait; slower work goes on
// in the background and shows up next time.
func (s *Service) DetailRatings(ctx context.Context, id string) (catalog.TitleRatings, error) {
	rows, err := s.store.Rows(ctx, []string{id})
	if err != nil {
		return catalog.TitleRatings{}, err
	}
	r, ok := rows[id]
	if !ok {
		return catalog.TitleRatings{}, nil
	}
	needs := (s.stale(r) && !s.paused(false)) || s.wdUsable(r) || s.keyedOK(ctx, r, High)
	if !needs {
		return toTitle(r), nil
	}
	// Queued at high priority too: if the synchronous attempt below runs out
	// of time and then fails, the worker retries it before list titles.
	if r.KPID == nil {
		s.resolveQ.Push(id, High)
	} else {
		s.refreshQ.Push(id, High)
	}
	done := make(chan struct{})
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		defer close(done)
		if err := s.process(id, High); err != nil {
			s.log.Debug("ratings lookup failed", "media_id", id, "err", err)
		}
	}()
	t := time.NewTimer(detailWait)
	defer t.Stop()
	select {
	case <-done:
	case <-t.C:
		return toTitle(r), nil
	case <-ctx.Done():
		return toTitle(r), nil
	}
	if rows, err = s.store.Rows(ctx, []string{id}); err != nil {
		return catalog.TitleRatings{}, err
	}
	return toTitle(rows[id]), nil
}

// process resolves (if needed) and refreshes one title. Concurrent calls
// for the same id share one run, detached from any request.
func (s *Service) process(id string, p Priority) error {
	_, err, _ := s.sf.Do(id, func() (any, error) {
		ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
		defer cancel()
		return nil, s.processNow(ctx, id, p)
	})
	return err
}

func (s *Service) processNow(ctx context.Context, id string, p Priority) error {
	rows, err := s.store.Rows(ctx, []string{id})
	if err != nil {
		return err
	}
	r, ok := rows[id]
	if !ok {
		return nil
	}
	if r.KPID == nil && s.wdUsable(r) {
		res, err := s.wikidataBatch(ctx, []string{id}, "detail")
		switch kp, found := res.Found[id]; {
		case found:
			r.KPID, r.FetchedAt = &kp, nil
		case err != nil && p == Low:
			return err // don't spend the keyed budget while Wikidata is down
		case err != nil:
			s.log.Debug("wikidata lookup failed; trying the keyed API", "media_id", id, "err", err)
		}
	}
	if r.KPID == nil {
		if s.prov == nil || s.recentMiss(r) {
			return nil
		}
		if s.paused(true) {
			return errPaused
		}
		kp, err := s.resolve(ctx, id, p)
		switch {
		case errors.Is(err, errMiss):
			return s.store.SaveMiss(ctx, id)
		case err != nil:
			return err
		}
		if err := s.store.SaveKPID(ctx, id, kp); err != nil {
			return err
		}
		r.KPID, r.FetchedAt = &kp, nil
	}
	if !s.stale(r) {
		return nil
	}
	return s.refresh(ctx, id, *r.KPID)
}

// wikidataBatch looks ids up on Wikidata (skipping titles that got a
// Kinopoisk id or a Wikidata answer meanwhile), stores the matches like the
// keyed resolver does (kp_id + media_external_ids) and marks the misses.
// On an error the result still holds what was stored.
func (s *Service) wikidataBatch(ctx context.Context, ids []string, source string) (WDResult, error) {
	res := WDResult{Found: map[string]int{}}
	rows, err := s.store.Rows(ctx, ids)
	if err != nil {
		return res, err
	}
	todo := make([]string, 0, len(ids))
	for _, id := range ids {
		if r, ok := rows[id]; ok && s.wdUsable(r) {
			todo = append(todo, id)
		}
	}
	if len(todo) == 0 {
		return res, nil
	}
	titles, err := s.store.WDTitles(ctx, todo)
	if err != nil {
		return res, err
	}
	res, lerr := s.wd.Lookup(ctx, titles)
	var misses []string
	for _, id := range res.Queried {
		kp, ok := res.Found[id]
		if !ok {
			misses = append(misses, id)
			continue
		}
		if err := s.store.SaveKPID(ctx, id, kp); err != nil {
			delete(res.Found, id)
			return res, err
		}
	}
	if err := s.store.SaveWikidataMiss(ctx, misses); err != nil {
		return res, err
	}
	lvl := slog.LevelInfo
	if len(todo) == 1 {
		lvl = slog.LevelDebug
	}
	s.log.Log(ctx, lvl, "ratings: wikidata lookup", "source", source, "titles", len(todo), "queries", res.Queries,
		"found", len(res.Found), "misses", len(misses), "conflicts", res.Conflicts, "err", lerr)
	return res, lerr
}

// wikidataQueued handles a batch of titles shown in lists: matches go to
// the refresh queue, misses to the keyed API queue (budget permitting).
func (s *Service) wikidataQueued(ctx context.Context, ids []string) {
	ctx, cancel := context.WithTimeout(ctx, opTimeout+wikidataTimeout)
	defer cancel()
	res, err := s.wikidataBatch(ctx, ids, "list")
	for id := range res.Found {
		s.refreshQ.Push(id, Low)
	}
	if err != nil || s.prov == nil || s.paused(true) || s.budget.Remaining(ctx, Low) == 0 {
		return // on an error the rest comes back the next time it is shown
	}
	for _, id := range res.Queried {
		if _, ok := res.Found[id]; !ok {
			s.resolveQ.Push(id, Low)
		}
	}
}

// refresh fetches the keyless rating XML and stores it.
func (s *Service) refresh(ctx context.Context, id string, kpID int) error {
	if s.paused(false) {
		return errPaused
	}
	if err := s.xmlLimit.Wait(ctx); err != nil {
		return err
	}
	v, err := s.xml.Fetch(ctx, kpID)
	if errors.Is(err, ErrNotFound) {
		v, err = Values{}, nil // no rating page: store "fetched, nothing" (retry in a week)
	}
	if err != nil {
		if ctx.Err() == nil {
			s.pause(false, err)
		}
		return err
	}
	return s.store.SaveRatings(ctx, id, v)
}

// resolve finds the Kinopoisk id of a title through the keyed API (errMiss
// when not confident), spending budget at priority p.
func (s *Service) resolve(ctx context.Context, id string, p Priority) (int, error) {
	t, err := s.store.Target(ctx, id)
	if err != nil {
		return 0, err
	}
	if t.IMDbID == "" && s.tmdb != nil && s.tmdb.Configured() {
		if imdb, err := s.fetchIMDb(ctx, t); err != nil {
			s.log.Debug("tmdb external ids failed", "media_id", id, "err", err)
		} else if imdb != "" {
			t.IMDbID = imdb
			if err := s.store.SaveIMDb(ctx, id, imdb); err != nil {
				return 0, err
			}
		}
	}

	if t.IMDbID != "" {
		c, err := s.call(ctx, p, func() ([]Candidate, error) { return s.prov.ByIMDb(ctx, t.IMDbID) })
		if err != nil {
			return 0, err
		}
		if kp, ok := Pick(t, c); ok {
			return kp, nil
		}
	}
	if s.prov.CanTMDB() {
		c, err := s.call(ctx, p, func() ([]Candidate, error) { return s.prov.ByTMDB(ctx, t.TMDBID) })
		if err != nil {
			return 0, err
		}
		if kp, ok := Pick(t, c); ok {
			return kp, nil
		}
	}
	if s.prov.CanTitle() {
		for _, kw := range keywords(t.Titles) {
			c, err := s.call(ctx, p, func() ([]Candidate, error) { return s.prov.ByTitle(ctx, kw, t.Year) })
			if err != nil {
				return 0, err
			}
			if kp, ok := Pick(t, c); ok {
				return kp, nil
			}
		}
	}
	return 0, errMiss
}

// keywords are the distinct titles to search, original first.
func keywords(titles []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, t := range titles {
		n := normalize(t)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, t)
		if len(out) == maxTitleSearches {
			break
		}
	}
	return out
}

// call spends one budget unit at priority p, waits for the rate limiter
// and runs one provider request.
func (s *Service) call(ctx context.Context, p Priority, f func() ([]Candidate, error)) ([]Candidate, error) {
	if !s.budget.Take(ctx, p) {
		s.resolveQ.DropLow()
		return nil, errBudget
	}
	if err := s.apiLimit.Wait(ctx); err != nil {
		return nil, err
	}
	c, err := f()
	switch {
	case err == nil:
		s.mu.Lock()
		s.authErr = nil
		s.mu.Unlock()
	case errors.Is(err, ErrQuota):
		s.budget.Exhaust(ctx)
		s.resolveQ.DropLow()
	case errors.Is(err, ErrUnauthorized):
		s.mu.Lock()
		s.authErr = err
		s.mu.Unlock()
		s.pause(true, err)
	case ctx.Err() == nil:
		s.pause(true, err)
	}
	return c, err
}

func (s *Service) fetchIMDb(ctx context.Context, t Target) (string, error) {
	body, err := s.tmdb.Get(ctx, fmt.Sprintf("/%s/%d/external_ids", tmdb.MediaType(t.Kind), t.TMDBID), url.Values{})
	if err != nil {
		return "", err
	}
	var ids struct {
		IMDbID *string `json:"imdb_id"`
	}
	if err := json.Unmarshal(body, &ids); err != nil {
		return "", err
	}
	return deref(ids.IMDbID), nil
}

// Run processes the queues until ctx ends: Wikidata batches, keyed id
// matching (budgeted), rating refreshes (keyless), plus the startup
// refresh backfill and the continuous Wikidata backfill.
func (s *Service) Run(ctx context.Context) {
	var wg sync.WaitGroup
	run := func(f func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			f()
		}()
	}
	run(func() { s.backfill(ctx) })
	run(func() { s.work(ctx, s.resolveQ, true) })
	run(func() { s.work(ctx, s.refreshQ, false) })
	if s.wd != nil {
		run(func() { s.workWikidata(ctx) })
		run(func() { s.backfillWikidata(ctx) })
	}
	wg.Wait()
}

func (s *Service) work(ctx context.Context, q *queue, api bool) {
	for {
		// While paused, leave the queue alone (pushes keep deduping).
		for s.paused(api) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(10 * time.Second):
			}
		}
		id, p, ok := q.Pop(ctx)
		if !ok {
			return
		}
		if err := s.process(id, p); err != nil && !errors.Is(err, errBudget) && !errors.Is(err, errPaused) {
			s.log.Debug("ratings work failed", "media_id", id, "err", err)
		}
	}
}

// popBatch takes up to n queued ids without blocking.
func popBatch(q *queue, n int) []string {
	var ids []string
	for len(ids) < n {
		id, _, ok := q.TryPop()
		if !ok {
			break
		}
		ids = append(ids, id)
	}
	return ids
}

// workWikidata looks up titles shown in lists, a batch at a time.
func (s *Service) workWikidata(ctx context.Context) {
	for {
		if err := sleepCtx(ctx, s.wd.BackoffRemaining()); err != nil {
			return
		}
		id, _, ok := s.wdQ.Pop(ctx)
		if !ok {
			return
		}
		s.wikidataQueued(ctx, append([]string{id}, popBatch(s.wdQ, wikidataBatch-1)...))
	}
}

// backfillWikidata walks every title without a Kinopoisk id through
// Wikidata, one batch per wdGap (watched/saved titles first), then checks
// for new titles every wdBackfillIdle. Matches go to the refresh queue,
// which is kept from overflowing.
func (s *Service) backfillWikidata(ctx context.Context) {
	if sleepCtx(ctx, wdBackfillStart) != nil {
		return
	}
	for {
		for s.refreshQ.Len() > queueMax/2 {
			if sleepCtx(ctx, 2*time.Second) != nil {
				return
			}
		}
		n, err := s.BackfillWikidataOnce(ctx)
		wait := s.wdGap
		switch {
		case ctx.Err() != nil:
			return
		case errors.Is(err, ErrWikidataBackoff) || s.wd.BackoffRemaining() > 0:
			wait = max(s.wd.BackoffRemaining(), s.wdGap)
		case err != nil:
			s.log.Warn("ratings: wikidata backfill failed", "err", err)
			wait = 5 * time.Minute
		case n == 0:
			wait = wdBackfillIdle
		}
		if sleepCtx(ctx, wait) != nil {
			return
		}
	}
}

// BackfillWikidataOnce looks up one batch of titles without a Kinopoisk id
// that Wikidata was not asked about in the last 30 days; it returns how
// many were looked up (0 = backlog empty).
func (s *Service) BackfillWikidataOnce(ctx context.Context) (int, error) {
	lister, ok := s.store.(interface {
		WikidataBacklog(ctx context.Context, retry time.Duration, limit int) ([]string, error)
	})
	if !ok || s.wd == nil {
		return 0, nil
	}
	ids, err := lister.WikidataBacklog(ctx, wdRetry, wikidataBatch)
	if err != nil || len(ids) == 0 {
		return 0, err
	}
	res, err := s.wikidataBatch(ctx, ids, "backfill")
	for id := range res.Found {
		s.refreshQ.Push(id, Low)
	}
	return len(res.Queried), err
}

// backfill refreshes, once after startup, every title that has a Kinopoisk
// id but stale or never-fetched ratings (e.g. thousands seeded by a CSV
// import), feeding the keyless refresh queue without overflowing it. After
// that the normal on-display refresh (refreshAfter) keeps them cached.
func (s *Service) backfill(ctx context.Context) {
	lister, ok := s.store.(interface {
		StaleIDs(ctx context.Context, age time.Duration, limit int) ([]string, error)
	})
	if !ok {
		return
	}
	select {
	case <-ctx.Done():
		return
	case <-time.After(30 * time.Second): // let startup traffic settle
	}
	ids, err := lister.StaleIDs(ctx, refreshAfter, 20000)
	if err != nil {
		s.log.Warn("ratings backfill: list failed", "err", err)
		return
	}
	if len(ids) > 0 {
		s.log.Info("ratings backfill", "titles", len(ids))
	}
	for _, id := range ids {
		for s.refreshQ.Len() > queueMax/2 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
		s.refreshQ.Push(id, Low)
	}
}

// Drain processes everything queued right now, synchronously (tests).
func (s *Service) Drain() {
	for {
		if ids := popBatch(s.wdQ, wikidataBatch); len(ids) > 0 {
			s.wikidataQueued(context.Background(), ids)
			continue
		}
		id, p, ok := s.resolveQ.TryPop()
		if !ok {
			if id, p, ok = s.refreshQ.TryPop(); !ok {
				break
			}
		}
		_ = s.process(id, p)
	}
	s.bg.Wait()
}

// Pending is the number of queued titles (matching incl. Wikidata, refresh).
func (s *Service) Pending() (int, int) { return s.resolveQ.Len() + s.wdQ.Len(), s.refreshQ.Len() }
