package foryou

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"strings"
	"sync"
	"time"
)

// Learned source weights («Учить веса по просмотрам»): the nightly run
// measures, per profile, which candidate sources lead to plays and turns
// that into a bounded multiplier per source (foryou_source_weights). Scoring
// reads the stored multipliers (Weights.SourceMult): the source-strength term
// and the order of the specific rows follow them; reasons don't change.
//
// Method (docs/architecture.md "Learned source weights"):
//   - every impression of a cached row carries the item's source shares (its
//     candidate sources' strength, the row's own source at least LearnRowShare)
//     and its position (Feedback, at log time);
//   - each impression earns a reward: open (or a play event from that row)
//     RewardOpen, a playback of ≥ LearnPlaySeconds after that open RewardPlay,
//     a completion RewardComplete, «Не интересно» without a play RewardDismiss;
//   - rewards are compared with the position-expected exposure (clicks over
//     expected clicks): an impression counts propensity(row, tile), so a source
//     doesn't win for being shown first; both decay with LearnHalfLife;
//   - rates are smoothed: profile → household (all profiles, per source) →
//     household overall → LearnBaseRate, LearnPrior pseudo-impressions each;
//   - target = smoothed source rate ÷ the profile's overall rate, clamped to
//     [LearnMin, LearnMax]; a source with < LearnMinImpressions impressions
//     targets 1 (it drifts back and gets re-measured: exploration);
//   - the stored weight moves towards the target by at most ±LearnStep a night.

// Learn keys: the sources a weight is learned for, in display order.
const (
	LearnTrending     = "trending"
	LearnBecause      = ReasonBecause
	LearnDirector     = ReasonDirector
	LearnActor        = ReasonActor
	LearnTheme        = ReasonTheme
	LearnGenre        = ReasonGenre
	LearnHiddenGem    = ReasonHiddenGem
	LearnDifferent    = ReasonDifferent
	LearnAICollection = ReasonAI
	LearnAITheme      = "ai_theme"
	LearnAIPicks      = "ai_picks"
	LearnRewatch      = ReasonRewatch
	LearnFamily       = ReasonFamily
	LearnCurated      = ReasonCurated
)

// LearnSources lists every learn key (admin table order).
var LearnSources = []string{LearnTrending, LearnBecause, LearnDirector, LearnActor, LearnTheme, LearnGenre, LearnHiddenGem,
	LearnDifferent, LearnAICollection, LearnAITheme, LearnAIPicks, LearnRewatch, LearnFamily, LearnCurated}

// AIFeatureLearn is the admin switch «Учить веса по просмотрам» (default on;
// stored like the AI feature switches, app_settings ai_feature_learn_weights).
const AIFeatureLearn = "learn_weights"

// learnEvery: the learner updates a profile at most once in this period (an
// admin rerun the same day doesn't take a second step).
const learnEvery = 20 * time.Hour

// learnKey maps a candidate source to its learn key.
func learnKey(src *Source) string {
	switch src.Type {
	case ReasonTrending, ReasonPopular:
		return LearnTrending
	case ReasonAI:
		if src.Rubric {
			return LearnAITheme
		}
		return LearnAICollection
	}
	return src.Type
}

// mult is a source's learned multiplier (1 when nothing is learned).
func (w Weights) mult(key string) float64 {
	if m, ok := w.SourceMult[key]; ok && m > 0 {
		return m
	}
	return 1
}

// itemShares splits the credit for a served item between its sources by
// strength; rowKey (the row's own source, "" for «Подобрано») gets at least
// LearnRowShare. Rounded to 2 decimals; never empty.
func itemShares(c *Candidate, rowKey string, w Weights) map[string]float64 {
	raw := map[string]float64{}
	total := 0.0
	for i := range c.Sources {
		v := math.Max(0, math.Min(1, c.Sources[i].Strength))
		if v > 0 {
			raw[learnKey(&c.Sources[i])] += v
			total += v
		}
	}
	out := map[string]float64{}
	switch {
	case total == 0 && rowKey == "":
		out[LearnGenre] = 1 // scored on taste alone
		return out
	case total == 0:
		out[rowKey] = 1
		return out
	}
	for k, v := range raw {
		out[k] = v / total
	}
	if rowKey != "" && out[rowKey] < w.LearnRowShare {
		rest := 1 - out[rowKey]
		for k := range out {
			if k != rowKey && rest > 0 {
				out[k] *= (1 - w.LearnRowShare) / rest
			}
		}
		out[rowKey] = w.LearnRowShare
	}
	for k, v := range out {
		if r := math.Round(v*100) / 100; r > 0 {
			out[k] = r
		} else {
			delete(out, k)
		}
	}
	return out
}

// ---- estimator (pure) ----

// learnObs is one impression with its outcome.
type learnObs struct {
	Shares map[string]float64
	Age    time.Duration
	// RowPos / ItemPos: 0-based, −1 unknown.
	RowPos, ItemPos                      int
	Opened, Played, Completed, Dismissed bool
}

// SourceStats are one source's counts: the share-weighted raw counts (shown
// to the admin) and the decayed sums the estimator uses.
type SourceStats struct {
	Impressions, Opens, Plays, Completes, Dismisses float64
	// reward = Σ decay·share·reward; expo = Σ decay·share·propensity;
	// n = Σ decay·share (effective impressions).
	reward, expo, n float64
}

func (w Weights) learnReward(o learnObs) float64 {
	switch {
	case o.Completed:
		return w.RewardComplete
	case o.Played:
		return w.RewardPlay
	case o.Dismissed:
		return w.RewardDismiss
	case o.Opened:
		return w.RewardOpen
	}
	return 0
}

// propensity: how likely a tile at (row, item) is looked at, relative to the
// first tile of the first row. Unknown positions count as an average one.
func propensity(row, item int) float64 {
	if row < 0 || item < 0 {
		return 0.5
	}
	return 1 / (1 + 0.2*float64(row)) / (1 + 0.15*float64(item))
}

// aggregateLearn sums observations per source.
func aggregateLearn(obs []learnObs, w Weights) map[string]*SourceStats {
	out := map[string]*SourceStats{}
	for _, o := range obs {
		if o.ItemPos > w.LearnMaxItemPos || o.Age < 0 || o.Age > time.Duration(w.LearnWindowDays)*24*time.Hour {
			continue
		}
		d := math.Pow(0.5, float64(o.Age)/float64(w.LearnHalfLife))
		p := propensity(o.RowPos, o.ItemPos)
		r := w.learnReward(o)
		for k, sh := range o.Shares {
			if sh <= 0 {
				continue
			}
			st := out[k]
			if st == nil {
				st = &SourceStats{}
				out[k] = st
			}
			st.Impressions += sh
			if o.Opened {
				st.Opens += sh
			}
			if o.Played || o.Completed {
				st.Plays += sh
			}
			if o.Completed {
				st.Completes += sh
			}
			if o.Dismissed {
				st.Dismisses += sh
			}
			st.reward += d * sh * r
			st.expo += d * sh * p
			st.n += d * sh
		}
	}
	return out
}

// learnPrior is the household's smoothed rate per source and overall.
type learnPrior struct {
	all  float64
	rate map[string]float64
}

func (p learnPrior) of(key string) float64 {
	if r, ok := p.rate[key]; ok {
		return r
	}
	return p.all
}

// smooth is (reward + k·prior) / (exposure + k).
func smooth(reward, expo, prior, k float64) float64 { return (reward + k*prior) / (expo + k) }

// priorFrom builds the household prior from every profile's stats.
func priorFrom(global map[string]*SourceStats, w Weights) learnPrior {
	var r, e float64
	for _, st := range global {
		r += st.reward
		e += st.expo
	}
	p := learnPrior{all: smooth(r, e, w.LearnBaseRate, w.LearnPrior), rate: map[string]float64{}}
	for k, st := range global {
		p.rate[k] = smooth(st.reward, st.expo, p.all, w.LearnPrior)
	}
	return p
}

// learnTargets: the multiplier each source should have for a profile.
func learnTargets(stats map[string]*SourceStats, prior learnPrior, w Weights) map[string]float64 {
	var r, e float64
	for _, st := range stats {
		r += st.reward
		e += st.expo
	}
	base := math.Max(0, smooth(r, e, prior.all, w.LearnPrior))
	out := map[string]float64{}
	for k, st := range stats {
		if st.n < w.LearnMinImpressions {
			out[k] = 1
			continue
		}
		rate := math.Max(0, smooth(st.reward, st.expo, prior.of(k), w.LearnPrior))
		out[k] = clampF((rate+w.LearnEps)/(base+w.LearnEps), w.LearnMin, w.LearnMax)
	}
	return out
}

// learnStep moves a stored weight towards its target by at most ±LearnStep
// (relative), within [LearnMin, LearnMax].
func learnStep(old, target float64, w Weights) float64 {
	if old <= 0 {
		old = 1
	}
	ratio := clampF(target/old, 1-w.LearnStep, 1+w.LearnStep)
	return math.Round(clampF(old*ratio, w.LearnMin, w.LearnMax)*1000) / 1000
}

// learnedAt is a per-request row's index: base ÷ multiplier, at least 1
// («Подобрано для вас» stays first).
func learnedAt(base int, m float64) int {
	return max(1, int(math.Round(float64(base)/m)))
}

func clampF(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

// ---- storage ----

// SourceWeight is one stored row (contract ForYouSourceWeight).
type SourceWeight struct {
	Source      string  `json:"source"`
	Weight      float64 `json:"weight"`
	PrevWeight  float64 `json:"prev_weight"`
	Target      float64 `json:"target"`
	Impressions float64 `json:"impressions"`
	Opens       float64 `json:"opens"`
	Plays       float64 `json:"plays"`
	Completes   float64 `json:"completes"`
	Dismisses   float64 `json:"dismisses"`
}

// learnEnabled: the admin switch (default on).
func (s *Service) learnEnabled(ctx context.Context) bool {
	return s.settings == nil || s.settings.AIFeatureEnabled(ctx, AIFeatureLearn)
}

// sourceMult is the profile's stored multipliers (nil when switched off or
// nothing learned yet). Read, never recomputed per request.
func (s *Service) sourceMult(ctx context.Context, profileID string) map[string]float64 {
	if !s.learnEnabled(ctx) {
		return nil
	}
	rows, err := s.pool.Query(ctx, `SELECT source, weight FROM foryou_source_weights WHERE profile_id = $1`, profileID)
	if err != nil {
		s.log.WarnContext(ctx, "foryou: learned weights not read", "err", err)
		return nil
	}
	defer rows.Close()
	var out map[string]float64
	for rows.Next() {
		var k string
		var v float64
		if rows.Scan(&k, &v) != nil {
			return nil
		}
		if out == nil {
			out = map[string]float64{}
		}
		out[k] = v
	}
	return out
}

// loadLearnObs reads the impressions of the learning window with their
// outcomes, for one profile ("" = every profile).
func (s *Service) loadLearnObs(ctx context.Context, profileID string) ([]learnObs, error) {
	var pid any
	if profileID != "" {
		pid = profileID
	}
	now := s.now()
	rows, err := s.pool.Query(ctx, `
		WITH imp AS (
			SELECT DISTINCT ON (f.profile_id, f.media_id, f.row_id, date_trunc('day', f.created_at))
			       f.profile_id, f.media_id, f.row_id, f.created_at, f.sources, f.row_pos, f.item_pos
			FROM foryou_feedback f
			WHERE f.action = 'impression' AND f.sources IS NOT NULL AND f.created_at > $2
			  AND ($1::uuid IS NULL OR f.profile_id = $1::uuid)
			ORDER BY f.profile_id, f.media_id, f.row_id, date_trunc('day', f.created_at), f.created_at)
		SELECT i.created_at, i.sources, COALESCE(i.row_pos, -1), COALESCE(i.item_pos, -1), o.at IS NOT NULL,
		       o.at IS NOT NULL AND EXISTS (SELECT 1 FROM playback_sessions ps
		           WHERE ps.profile_id = i.profile_id AND ps.media_id = i.media_id
		             AND ps.started_at >= o.at - interval '1 minute' AND ps.started_at < o.at + interval '7 days' AND ps.last_position >= $3),
		       o.at IS NOT NULL AND EXISTS (SELECT 1 FROM watch_progress wp
		           WHERE wp.profile_id = i.profile_id AND wp.media_id = i.media_id AND wp.completed
		             AND wp.completed_at >= o.at AND wp.completed_at < o.at + interval '30 days'),
		       EXISTS (SELECT 1 FROM foryou_feedback d
		           WHERE d.profile_id = i.profile_id AND d.media_id = i.media_id AND d.action = 'dismiss'
		             AND d.created_at >= i.created_at - interval '1 minute' AND d.created_at < i.created_at + interval '3 days')
		FROM imp i
		LEFT JOIN LATERAL (
			SELECT min(x.created_at) AS at FROM foryou_feedback x
			WHERE x.profile_id = i.profile_id AND x.media_id = i.media_id AND x.row_id = i.row_id AND x.action IN ('open', 'play')
			  AND x.created_at >= i.created_at - interval '1 minute' AND x.created_at < i.created_at + interval '3 days') o ON true`,
		pid, now.Add(-time.Duration(s.w.LearnWindowDays)*24*time.Hour), s.w.LearnPlaySeconds)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []learnObs
	for rows.Next() {
		var o learnObs
		var at time.Time
		var raw []byte
		var rp, ip int16
		if err := rows.Scan(&at, &raw, &rp, &ip, &o.Opened, &o.Played, &o.Completed, &o.Dismissed); err != nil {
			return nil, err
		}
		if json.Unmarshal(raw, &o.Shares) != nil {
			continue
		}
		o.Age, o.RowPos, o.ItemPos = now.Sub(at), int(rp), int(ip)
		out = append(out, o)
	}
	return out, rows.Err()
}

// householdPrior is computed once per run (lazily).
type householdPrior struct {
	once sync.Once
	p    learnPrior
	err  error
}

func (s *Service) prior(ctx context.Context, hp *householdPrior) (learnPrior, error) {
	hp.once.Do(func() {
		obs, err := s.loadLearnObs(ctx, "")
		if err != nil {
			hp.err = err
			return
		}
		hp.p = priorFrom(aggregateLearn(obs, s.w), s.w)
	})
	return hp.p, hp.err
}

// learnProfile is the nightly step for one profile. It skips when the
// switch is off or the profile was updated within learnEvery.
func (s *Service) learnProfile(ctx context.Context, profileID string, hp *householdPrior) error {
	if !s.learnEnabled(ctx) {
		return nil
	}
	old := map[string]float64{}
	var last *time.Time
	rows, err := s.pool.Query(ctx, `SELECT source, weight, updated_at FROM foryou_source_weights WHERE profile_id = $1`, profileID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var k string
		var v float64
		var at time.Time
		if err := rows.Scan(&k, &v, &at); err != nil {
			rows.Close()
			return err
		}
		old[k] = v
		if last == nil || at.After(*last) {
			last = &at
		}
	}
	rows.Close()
	if last != nil && s.now().Sub(*last) < learnEvery {
		return nil
	}
	obs, err := s.loadLearnObs(ctx, profileID)
	if err != nil {
		return err
	}
	if len(obs) == 0 && len(old) == 0 {
		return nil
	}
	prior, err := s.prior(ctx, hp)
	if err != nil {
		return err
	}
	stats := aggregateLearn(obs, s.w)
	targets := learnTargets(stats, prior, s.w)
	for k := range old {
		if _, ok := targets[k]; !ok {
			targets[k] = 1 // no impressions left in the window: drift back
		}
	}
	keys := make([]string, 0, len(targets))
	for k := range targets {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	var changes []string
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, k := range keys {
		prev, ok := old[k]
		if !ok {
			prev = 1
		}
		nw := learnStep(prev, targets[k], s.w)
		st := stats[k]
		if st == nil {
			st = &SourceStats{}
		}
		if nw != prev {
			changes = append(changes, k+" "+fmtF(prev)+"→"+fmtF(nw))
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO foryou_source_weights (profile_id, source, weight, prev_weight, target, impressions, opens, plays, completes, dismisses, updated_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			ON CONFLICT (profile_id, source) DO UPDATE SET weight = EXCLUDED.weight, prev_weight = EXCLUDED.prev_weight, target = EXCLUDED.target,
				impressions = EXCLUDED.impressions, opens = EXCLUDED.opens, plays = EXCLUDED.plays, completes = EXCLUDED.completes,
				dismisses = EXCLUDED.dismisses, updated_at = EXCLUDED.updated_at`,
			profileID, k, nw, prev, math.Round(targets[k]*1000)/1000, round1(st.Impressions), round1(st.Opens), round1(st.Plays),
			round1(st.Completes), round1(st.Dismisses), s.now()); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.log.InfoContext(ctx, "foryou: learned source weights", "profile_id", profileID, "impressions", len(obs), "changes", strings.Join(changes, ", "))
	return nil
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

func fmtF(v float64) string {
	b, _ := json.Marshal(math.Round(v*1000) / 1000)
	return string(b)
}

// ProfileWeights is one profile in GET /admin/foryou/weights.
type ProfileWeights struct {
	ProfileID string         `json:"profile_id"`
	Name      string         `json:"name"`
	Owner     string         `json:"owner"`
	UpdatedAt time.Time      `json:"updated_at"`
	Items     []SourceWeight `json:"items"`
}

// learnedWeights lists every profile's stored weights (admin).
func (s *Service) learnedWeights(ctx context.Context) ([]ProfileWeights, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT w.profile_id, p.name, COALESCE(NULLIF(u.display_name, ''), u.username), w.updated_at,
		       w.source, w.weight, w.prev_weight, w.target, w.impressions, w.opens, w.plays, w.completes, w.dismisses
		FROM foryou_source_weights w JOIN profiles p ON p.id = w.profile_id JOIN users u ON u.id = p.user_id
		ORDER BY u.username, p.created_at, p.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProfileWeights{}
	for rows.Next() {
		var pid, name, owner string
		var at time.Time
		var sw SourceWeight
		if err := rows.Scan(&pid, &name, &owner, &at, &sw.Source, &sw.Weight, &sw.PrevWeight, &sw.Target,
			&sw.Impressions, &sw.Opens, &sw.Plays, &sw.Completes, &sw.Dismisses); err != nil {
			return nil, err
		}
		if len(out) == 0 || out[len(out)-1].ProfileID != pid {
			out = append(out, ProfileWeights{ProfileID: pid, Name: name, Owner: owner, UpdatedAt: at, Items: []SourceWeight{}})
		}
		pw := &out[len(out)-1]
		if at.After(pw.UpdatedAt) {
			pw.UpdatedAt = at
		}
		pw.Items = append(pw.Items, sw)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	order := map[string]int{}
	for i, k := range LearnSources {
		order[k] = i
	}
	for i := range out {
		slices.SortStableFunc(out[i].Items, func(a, b SourceWeight) int { return order[a.Source] - order[b.Source] })
	}
	return out, nil
}

// resetWeights forgets a profile's learned weights; false when there were none.
func (s *Service) resetWeights(ctx context.Context, profileID string) (bool, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM foryou_source_weights WHERE profile_id = $1`, profileID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// ---- attribution at log time ----

// feedbackAttr is what an event is credited to.
type feedbackAttr struct {
	shares          map[string]float64
	rowPos, itemPos *int
	score           *float64
}

// rowKindKey: a whole row's source (fallback for items cached without shares).
var rowKindKey = map[string]string{
	RowBecause: LearnBecause, RowDirector: LearnDirector, RowActor: LearnActor, RowGenre: LearnGenre, RowHiddenGems: LearnHiddenGem,
	RowDifferent: LearnDifferent, RowTrending: LearnTrending, RowPopular: LearnTrending, RowRewatch: LearnRewatch, RowAI: LearnAICollection,
	RowTheme: LearnTheme, RowFamily: LearnFamily, RowCurated: LearnCurated, RowTopPicks: LearnGenre,
}

// attribute resolves (row id, media id) against the profile's cached rows.
// Rows added per request (family, curated) and collection pages are credited
// to their source as a whole.
func attribute(cached []cachedRow, rowID, mediaID string) *feedbackAttr {
	ip := func(v int) *int { return &v }
	switch {
	case rowID == "":
		return nil
	case rowID == RowFamily:
		return &feedbackAttr{shares: map[string]float64{LearnFamily: 1}, rowPos: ip(1)}
	case strings.HasPrefix(rowID, "curated:"):
		return &feedbackAttr{shares: map[string]float64{LearnCurated: 1}, rowPos: ip(curatedRowAt)}
	case strings.HasPrefix(rowID, "collection:"):
		return &feedbackAttr{shares: map[string]float64{LearnAICollection: 1}}
	case rowID == ChannelRowID:
		// «Cineko TV»: the title's credit from the row it is cached in, if any
		// (no position: the channel shows one title at a time).
		for _, r := range cached {
			for _, it := range r.Items {
				if it.MediaID == mediaID && len(it.Src) > 0 {
					return &feedbackAttr{shares: it.Src}
				}
			}
		}
		return nil
	}
	for ri, r := range cached {
		if r.ID != rowID {
			continue
		}
		for ii, it := range r.Items {
			if it.MediaID != mediaID {
				continue
			}
			sh := it.Src
			if len(sh) == 0 {
				k := rowKindKey[r.Kind]
				if k == "" {
					return nil
				}
				sh = map[string]float64{k: 1}
			}
			sc := it.Score
			return &feedbackAttr{shares: sh, rowPos: ip(ri), itemPos: ip(ii), score: &sc}
		}
		return nil
	}
	return nil
}
