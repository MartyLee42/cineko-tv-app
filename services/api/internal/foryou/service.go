// Package foryou implements Phase 6 personal recommendations: per-profile
// taste profiles from real signals, explainable deterministic scoring of
// TMDB candidates into «Для вас» rows, Surprise Me («Удиви меня!»), Explore
// («Обзор»), AI collections (подборки, DeepSeek) generated daily, the
// diary and Taste DNA, and the admin rerun button.
//
// Not to be confused with internal/reco (people recommending titles to each
// other). See docs/architecture.md "Recommendations (Phase 6)".
package foryou

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"
	"golang.org/x/time/rate"

	"martytv/api/internal/appsettings"
	"martytv/api/internal/audit"
	"martytv/api/internal/catalog"
	"martytv/api/internal/config"
	"martytv/api/internal/family"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
	"martytv/api/internal/realtime"
)

const (
	cacheTTL = 24 * time.Hour
	// A stale cache (new signals) is rebuilt at most this often per profile.
	rebuildDebounce = 30 * time.Second
	langRebuildAge  = 6 * time.Hour
	// Rows with fewer items after read-time filtering are dropped.
	minRenderItems = 4
	// TypeUpdated is the realtime event after rows/collections changed.
	TypeUpdated = "foryou.updated"
)

// Catalog is what foryou needs from the catalog service.
type Catalog interface {
	Available() bool
	List(ctx context.Context, list, kind, lang string, page int, force bool) (*catalog.MediaPage, error)
	Discover(ctx context.Context, p catalog.DiscoverParams) (*catalog.MediaPage, error)
	Related(ctx context.Context, id, which, lang string, page int) (*catalog.MediaPage, error)
	SearchYear(ctx context.Context, query, kind, lang string, year int) (*catalog.MediaPage, error)
	PersonMovies(ctx context.Context, personTMDBID int, job, lang string, minVotes int) ([]catalog.MediaSummary, error)
	SummariesByID(ctx context.Context, ids []string, lang string) (map[string]catalog.MediaSummary, error)
	Detail(ctx context.Context, id, lang string) (*catalog.MediaDetail, error)
}

// FamilySource builds the «Семья советует» block (internal/family).
type FamilySource interface {
	Block(ctx context.Context, profileID, lang string, limit int) (*family.Block, error)
}

// Notifier is the realtime hub.
type Notifier interface {
	NotifyUsers(userIDs []string, env realtime.Envelope)
}

// Deps wires the service.
type Deps struct {
	Pool     *pgxpool.Pool
	Catalog  Catalog
	Personal catalog.Personalizer
	Profiles *profiles.Store
	Ratings  catalog.RatingsSource // optional
	Hub      Notifier              // optional
	Family   FamilySource          // optional: «Семья советует» row
	Curated  CuratedSource         // optional: «Подборки» row and Explore section
	Audit    *audit.Logger
	Config   config.ForYouConfig
	Log      *slog.Logger
	// Settings holds the admin's DeepSeek temperatures (optional: defaults).
	Settings AISettings
}

// AISettings is the part of appsettings.Store foryou uses.
type AISettings interface {
	AITemperature(ctx context.Context) appsettings.AITemperature
	SetAITemperature(ctx context.Context, t appsettings.AITemperature, by string) error
	FactsAIEnabled(ctx context.Context) bool
	SetFactsAIEnabled(ctx context.Context, enabled bool, by string) error
	CompanionAIEnabled(ctx context.Context) bool
	SetCompanionAIEnabled(ctx context.Context, enabled bool, by string) error
}

type Service struct {
	pool     *pgxpool.Pool
	cat      Catalog
	personal catalog.Personalizer
	profiles *profiles.Store
	ratings  catalog.RatingsSource
	hub      Notifier
	family   FamilySource
	curated  CuratedSource
	audit    *audit.Logger
	cfg      config.ForYouConfig
	log      *slog.Logger
	settings AISettings
	w        Weights
	ai       *aiClient

	now func() time.Time
	// rnd is the Surprise Me randomness (replaceable in tests).
	rndMu sync.Mutex
	rnd   func() float64

	// pace limits TMDB calls made by background runs (credits, resolution,
	// candidates), on top of the TMDB client's own limiter.
	pace *rate.Limiter

	compute    singleflight.Group
	tileImgs   tileImageCache // Explore tile pictures (explore_images.go)
	rebuilding sync.Map       // profile id → struct{}
	rebuildDue sync.Map       // profile id → lang: rebuild again when the running one ends
	noteTimers sync.Map       // profile id → struct{}: a delayed taste-note regeneration is pending
	regenRuns  sync.Map       // profile id → run id: a per-profile AI regeneration is running (regen.go)
	balance    balanceCache   // DeepSeek balance (admin)
	curatedDay sync.Map       // profile id → curatedChoice: the day's curated list (curated.go)

	runMu   sync.Mutex
	running string          // active run id
	baseCtx context.Context // guarded by runMu (set by Run)
	bg      sync.WaitGroup

	feedbackLimit *httpx.RateLimiter
}

func NewService(d Deps) *Service {
	s := &Service{
		pool: d.Pool, cat: d.Catalog, personal: d.Personal, profiles: d.Profiles, ratings: d.Ratings,
		hub: d.Hub, family: d.Family, curated: d.Curated, audit: d.Audit, cfg: d.Config, log: d.Log, settings: d.Settings, w: DefaultWeights(),
		now:     time.Now,
		pace:    rate.NewLimiter(rate.Limit(4), 4),
		baseCtx: context.Background(),

		feedbackLimit: httpx.NewRateLimiter(120, time.Minute),
	}
	r := rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 0x6d61727479))
	s.rnd = r.Float64
	if d.Config.AIConfigured() {
		s.ai = newAIClient(d.Config)
	}
	return s
}

// aiTemperature is the admin's temperatures (defaults without a store).
func (s *Service) aiTemperature(ctx context.Context) appsettings.AITemperature {
	if s.settings == nil {
		return appsettings.DefaultAITemperature()
	}
	return s.settings.AITemperature(ctx)
}

// factsAI: the admin allows AI-written «Факты» (default on).
func (s *Service) factsAI(ctx context.Context) bool {
	return s.settings == nil || s.settings.FactsAIEnabled(ctx)
}

// companionAI: the admin allows the watch companion (default on).
func (s *Service) companionAI(ctx context.Context) bool {
	return s.settings == nil || s.settings.CompanionAIEnabled(ctx)
}

// base is the service lifetime context (cancelled on shutdown).
func (s *Service) base() context.Context {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	return s.baseCtx
}

// SetRand replaces the Surprise Me random source (tests).
func (s *Service) SetRand(f func() float64) {
	s.rndMu.Lock()
	s.rnd = f
	s.rndMu.Unlock()
}

func (s *Service) random() float64 {
	s.rndMu.Lock()
	defer s.rndMu.Unlock()
	return s.rnd()
}

// SetPace changes the background TMDB pace (requests/second; tests).
func (s *Service) SetPace(perSecond float64) {
	s.pace.SetLimit(rate.Limit(perSecond))
	s.pace.SetBurst(max(1, int(perSecond)))
}

// SetAIBackoff replaces the retry backoff of the AI client (tests).
func (s *Service) SetAIBackoff(d time.Duration) {
	if s.ai != nil {
		s.ai.backoff = func(int) time.Duration { return d }
	}
}

// Wait blocks until background rebuilds and runs finish (tests).
func (s *Service) Wait() { s.bg.Wait() }

// ---- compute ----

// computeProfile recomputes a profile's taste, candidates, rows and pool
// and stores them in recs_cache.
func (s *Service) computeProfile(ctx context.Context, profileID, lang string, paced bool) (*cacheRow, error) {
	st, err := s.profiles.GetSettings(ctx, profileID)
	if err != nil {
		return nil, err
	}
	hideAnime := st.HideAnime != nil && *st.HideAnime
	latest, err := s.latestSignal(ctx, profileID)
	if err != nil {
		return nil, err
	}
	t, signals, err := s.computeTaste(ctx, profileID)
	if err != nil {
		return nil, err
	}
	cold := t.Stats.Positive < s.w.MinSignals
	cs := s.generate(ctx, t, lang, cold, paced, minVotesOf(st))

	// Local candidates: watchlist (Surprise pool), favourites to rewatch.
	now := s.now()
	for _, sg := range signals {
		if sg.Watchlist && !sg.Completed && sg.Rating == 0 && !sg.Dismissed {
			cs.add(sg.MediaID, Source{Type: ReasonGenre, Strength: 0})
		}
		if sg.Completed && !sg.Dismissed && (sg.Rating >= 9 || sg.Favorite && sg.Rating == 0) {
			last := sg.CompletedAt
			if sg.RatedAt.After(last) {
				last = sg.RatedAt
			}
			if now.Sub(last) > 365*24*time.Hour {
				strength := 0.9
				if sg.Rating > 0 {
					strength = float64(sg.Rating) / 10
				}
				cs.add(sg.MediaID, Source{Type: ReasonRewatch, MediaID: sg.MediaID, Strength: strength})
			}
		}
	}
	// The profile's latest AI collections (rows + candidates).
	cols, err := s.latestCollections(ctx, profileID, false)
	if err != nil {
		return nil, err
	}
	var refs []CollectionRef
	for _, c := range cols {
		refs = append(refs, CollectionRef{ID: c.id})
		for i, mid := range c.items {
			cs.add(mid, Source{Type: ReasonAI, CollectionID: c.id, Strength: s.w.SrcAI * (1 - float64(i)*0.02)})
		}
	}

	ids := make([]string, 0, len(cs.m))
	for id := range cs.m {
		ids = append(ids, id)
	}
	facts, err := s.loadFeatures(ctx, ids)
	if err != nil {
		return nil, err
	}
	seen, err := s.seenSet(ctx, profileID)
	if err != nil {
		return nil, err
	}
	fatigue, shown, err := s.impressionStats(ctx, profileID)
	if err != nil {
		return nil, err
	}
	watchlist := map[string]bool{}
	for _, sg := range signals {
		if sg.Watchlist {
			watchlist[sg.MediaID] = true
		}
	}
	var scored []Scored
	for _, id := range cs.order {
		c := cs.m[id]
		f, ok := facts[id]
		if !ok {
			continue
		}
		if hideAnime && catalog.IsAnime(f.Genres, f.Lang) {
			continue
		}
		if seen[id] {
			// Seen titles only come back as "rewatch".
			var keep []Source
			for _, src := range c.Sources {
				if src.Type == ReasonRewatch {
					keep = append(keep, src)
				}
			}
			if len(keep) == 0 {
				continue
			}
			c.Sources = keep
		}
		c.Features = f.Features
		c.VoteAverage, c.VoteCount, c.Popularity, c.KPRating = f.VoteAverage, f.VoteCount, f.Popularity, f.KPRating
		c.Impressions, c.Shown, c.Watchlist = fatigue[id], shown[id], watchlist[id]
		c.Runtime = f.Runtime
		// Drop the zero-strength placeholder source of watchlist titles.
		var srcs []Source
		for _, src := range c.Sources {
			if src.Strength > 0 {
				srcs = append(srcs, src)
			}
		}
		c.Sources = srcs
		scored = append(scored, Score(c, t, s.w))
	}
	cache := &cacheRow{
		Rows:      BuildRows(scored, t, s.w, refs, cold),
		Pool:      BuildPool(scored, s.w),
		ColdStart: cold,
		Lang:      lang,
		SignalsAt: latest,
	}
	if err := s.saveCache(ctx, profileID, cache); err != nil {
		return nil, err
	}
	cache.ComputedAt = s.now()
	cache.ExpiresAt = cache.ComputedAt.Add(cacheTTL)
	return cache, nil
}

// computeTaste recomputes and stores a profile's taste (DB only, no TMDB).
func (s *Service) computeTaste(ctx context.Context, profileID string) (*Taste, []Signal, error) {
	signals, err := s.loadSignals(ctx, profileID)
	if err != nil {
		return nil, nil, err
	}
	ids := make([]string, len(signals))
	for i, sg := range signals {
		ids[i] = sg.MediaID
	}
	facts, err := s.loadFeatures(ctx, ids)
	if err != nil {
		return nil, nil, err
	}
	feats := make(map[string]Features, len(facts))
	for id, f := range facts {
		feats[id] = f.Features
	}
	t := ComputeTaste(signals, feats, s.now(), s.w)
	// The taste quiz's answers nudge the affinities (quiz.go).
	if qa, err := s.quizAnswers(ctx, profileID); err == nil {
		applyQuiz(t, qa)
	}
	if err := s.saveTaste(ctx, profileID, t); err != nil {
		return nil, nil, err
	}
	return t, signals, nil
}

// ensureCache returns a usable cache, computing it synchronously when
// missing or expired (deduped per profile).
func (s *Service) ensureCache(ctx context.Context, profileID, lang string) (*cacheRow, error) {
	c, err := s.loadCache(ctx, profileID)
	if err != nil {
		return nil, err
	}
	if c != nil && s.now().Before(c.ExpiresAt) {
		return c, nil
	}
	v, err, _ := s.compute.Do(profileID, func() (any, error) {
		cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		return s.computeProfile(cctx, profileID, lang, false)
	})
	if err != nil {
		if c != nil {
			s.log.WarnContext(ctx, "foryou: recompute failed; serving expired rows", "err", err)
			return c, nil
		}
		return nil, err
	}
	return v.(*cacheRow), nil
}

// rebuildAsync recomputes a profile in the background and notifies its
// owner. At most one rebuild per profile runs at a time; a request while
// one runs schedules another right after it (settings may have changed).
func (s *Service) rebuildAsync(profileID, lang string, reason ...string) {
	why := "signals"
	if len(reason) > 0 {
		why = reason[0]
	}
	if _, busy := s.rebuilding.LoadOrStore(profileID, struct{}{}); busy {
		if why != "signals" {
			s.rebuildDue.Store(profileID, lang)
		}
		return
	}
	s.bg.Add(1)
	go func() {
		defer s.bg.Done()
		ctx, cancel := context.WithTimeout(s.base(), 2*time.Minute)
		defer cancel()
		_, err, _ := s.compute.Do(profileID, func() (any, error) { return s.computeProfile(ctx, profileID, lang, false) })
		s.rebuilding.Delete(profileID)
		if again, ok := s.rebuildDue.LoadAndDelete(profileID); ok {
			s.rebuildAsync(profileID, again.(string), why)
			return
		}
		if err != nil {
			if ctx.Err() == nil {
				s.log.Warn("foryou: background rebuild failed", "err", err)
			}
			return
		}
		s.notify(ctx, []string{profileID}, why)
	}()
}

// notify sends foryou.updated to the owners of the profiles.
func (s *Service) notify(ctx context.Context, profileIDs []string, reason string) {
	if s.hub == nil || len(profileIDs) == 0 {
		return
	}
	byUser := map[string][]string{}
	for _, pid := range profileIDs {
		uid, err := s.profileOwner(ctx, pid)
		if err != nil || uid == "" {
			continue
		}
		byUser[uid] = append(byUser[uid], pid)
	}
	for uid, pids := range byUser {
		b, _ := json.Marshal(map[string]any{"profile_ids": pids, "reason": reason})
		s.hub.NotifyUsers([]string{uid}, realtime.Envelope{Type: TypeUpdated, Payload: b})
	}
}

// ---- rows (read) ----

// Rows is GET /foryou/rows.
func (s *Service) Rows(ctx context.Context, profileID, lang string) (*Rows, error) {
	s.noteVisit(ctx, profileID)
	c, err := s.ensureCache(ctx, profileID, lang)
	if err != nil {
		return nil, err
	}
	latest, err := s.latestSignal(ctx, profileID)
	if err != nil {
		return nil, err
	}
	stale := latest != nil && (c.SignalsAt == nil || latest.After(*c.SignalsAt))
	// A request in another language rebuilds (so titles get translated)
	// only when the cache is older than langRebuildAge: a ru TV and an en
	// phone must not make it flip-flop.
	age := s.now().Sub(c.ComputedAt)
	if stale && age > rebuildDebounce || c.Lang != lang && age > langRebuildAge {
		s.rebuildAsync(profileID, lang)
	}
	rows, err := s.hydrateRows(ctx, profileID, lang, c.Rows)
	if err != nil {
		return nil, err
	}
	rows = s.withFamily(ctx, profileID, lang, rows)
	rows = s.withCurated(ctx, profileID, lang, rows)
	at := c.ComputedAt
	return &Rows{ProfileID: profileID, GeneratedAt: &at, Stale: stale, ColdStart: c.ColdStart, Rows: rows}, nil
}

// renderCtx resolves ids to localized names for one response.
type renderCtx struct {
	lang    string
	sums    map[string]catalog.MediaSummary
	persons map[int]personName
	genres  map[int]string
	cols    map[string]string // collection id → title
}

func (s *Service) newRender(ctx context.Context, lang string, mediaIDs []string, reasons []Reason) (*renderCtx, error) {
	rc := &renderCtx{lang: lang, genres: s.genreNamesFor(ctx, lang), cols: map[string]string{}}
	ids := slicesUniq(mediaIDs)
	var people []int
	var colIDs []string
	for _, r := range reasons {
		if r.MediaID != "" {
			ids = append(ids, r.MediaID)
		}
		if r.PersonID != 0 {
			people = append(people, r.PersonID)
		}
		if r.CollectionID != "" {
			colIDs = append(colIDs, r.CollectionID)
		}
	}
	var err error
	if rc.sums, err = s.cat.SummariesByID(ctx, slicesUniq(ids), lang); err != nil {
		return nil, err
	}
	if rc.persons, err = s.personNames(ctx, people, lang); err != nil {
		return nil, err
	}
	if len(colIDs) > 0 {
		rows, err := s.pool.Query(ctx, `SELECT id, title_ru, title_en FROM foryou_collections WHERE id = ANY($1::uuid[])`, slicesUniq(colIDs))
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, ru, en string
			if err := rows.Scan(&id, &ru, &en); err != nil {
				rows.Close()
				return nil, err
			}
			rc.cols[id] = pick(lang, ru, en)
		}
		rows.Close()
	}
	return rc, nil
}

func pick(lang, ru, en string) string {
	if lang == "ru" && ru != "" || en == "" {
		return ru
	}
	return en
}

func (rc *renderCtx) reason(r Reason) ReasonOut {
	out := ReasonOut{Type: r.Type, GenreIDs: []int{}, GenreNames: []string{}}
	if r.MediaID != "" {
		id := r.MediaID
		out.MediaID = &id
		if m, ok := rc.sums[id]; ok {
			t := m.Title
			out.MediaTitle = &t
		}
	}
	if r.PersonID != 0 {
		pid := r.PersonID
		out.PersonTMDBID = &pid
		if p, ok := rc.persons[pid]; ok {
			n := p.Name
			out.PersonName = &n
		}
	}
	for _, g := range r.GenreIDs {
		out.GenreIDs = append(out.GenreIDs, g)
		out.GenreNames = append(out.GenreNames, genreName(rc.genres, rc.lang, g))
	}
	if r.CollectionID != "" {
		cid := r.CollectionID
		out.CollectionID = &cid
		if t, ok := rc.cols[cid]; ok {
			out.CollectionTitle = &t
		}
	}
	if r.Mood != "" {
		m := r.Mood
		out.Mood = &m
	}
	out.Text = reasonText(rc.lang, out)
	return out
}

// hydrateRows turns cached rows into the API shape, filtering titles the
// profile has rated, completed or dismissed since (cheap read-time patch).
func (s *Service) hydrateRows(ctx context.Context, profileID, lang string, cached []cachedRow) ([]Row, error) {
	var ids []string
	var reasons []Reason
	for _, r := range cached {
		reasons = append(reasons, r.Reason)
		for _, it := range r.Items {
			ids = append(ids, it.MediaID)
			reasons = append(reasons, it.Reason)
		}
	}
	ids = slicesUniq(ids)
	rc, err := s.newRender(ctx, lang, ids, reasons)
	if err != nil {
		return nil, err
	}
	states, err := s.personal.UserStates(ctx, profileID, ids)
	if err != nil {
		return nil, err
	}
	dismissed, err := s.dismissedSet(ctx, profileID, ids)
	if err != nil {
		return nil, err
	}
	anime, err := s.animeFilter(ctx, profileID, ids)
	if err != nil {
		return nil, err
	}
	s.annotateRatings(ctx, rc.sums)
	out := make([]Row, 0, len(cached))
	for _, r := range cached {
		row := Row{ID: r.ID, Kind: r.Kind, Reason: rc.reason(r.Reason), Items: []Item{}}
		row.Title = rowTitle(lang, r.Kind, row.Reason)
		for _, it := range r.Items {
			m, ok := rc.sums[it.MediaID]
			if !ok || dismissed[it.MediaID] || anime[it.MediaID] {
				continue
			}
			st := states[it.MediaID]
			if r.Kind != RowRewatch && (st.Rating != nil || st.Completed) {
				continue
			}
			m.Me = &st
			row.Items = append(row.Items, Item{Media: m, Reason: rc.reason(it.Reason), Score: it.Score})
		}
		if len(row.Items) >= minRenderItems {
			out = append(out, row)
		}
	}
	return out, nil
}

// animeFilter returns anime ids among ids when the profile hides anime.
func (s *Service) animeFilter(ctx context.Context, profileID string, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	st, err := s.profiles.GetSettings(ctx, profileID)
	if err != nil {
		return nil, err
	}
	if st.HideAnime == nil || !*st.HideAnime || len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT m.id FROM media m WHERE m.id = ANY($1::uuid[]) AND m.original_language = 'ja'
		  AND EXISTS (SELECT 1 FROM media_genres g WHERE g.media_id = m.id AND g.genre_id = $2)`, ids, catalog.GenreAnimation)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func (s *Service) annotateRatings(ctx context.Context, sums map[string]catalog.MediaSummary) {
	if s.ratings == nil || len(sums) == 0 {
		return
	}
	ids := make([]string, 0, len(sums))
	for id := range sums {
		ids = append(ids, id)
	}
	rs, err := s.ratings.Ratings(ctx, ids)
	if err != nil {
		s.log.WarnContext(ctx, "foryou: ratings lookup failed", "err", err)
		return
	}
	for id, m := range sums {
		if r, ok := rs[id]; ok {
			m.KPRating, m.IMDbRating, m.AwardBadge = r.KP, r.IMDb, r.Award
			sums[id] = m
		}
	}
}

// summaries loads titles in order with `me` and ratings (helpers for
// collections, surprise, diary).
func (s *Service) summaries(ctx context.Context, profileID, lang string, ids []string) ([]catalog.MediaSummary, error) {
	sums, err := s.cat.SummariesByID(ctx, ids, lang)
	if err != nil {
		return nil, err
	}
	s.annotateRatings(ctx, sums)
	states := map[string]catalog.MediaUserState{}
	if profileID != "" && len(ids) > 0 {
		if states, err = s.personal.UserStates(ctx, profileID, ids); err != nil {
			return nil, err
		}
	}
	out := make([]catalog.MediaSummary, 0, len(ids))
	for _, id := range ids {
		m, ok := sums[id]
		if !ok {
			continue
		}
		if profileID != "" {
			st := states[id]
			m.Me = &st
		}
		out = append(out, m)
	}
	return out, nil
}

func slicesUniq(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

var errNotFound = errors.New("foryou: not found")
