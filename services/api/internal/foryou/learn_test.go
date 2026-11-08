package foryou

import (
	"math"
	"testing"
	"time"
)

// obsN: n impressions of one source at the first position, k of them with
// the given outcome.
func obsN(src string, n, k int, age time.Duration, outcome func(*learnObs)) []learnObs {
	var out []learnObs
	for i := 0; i < n; i++ {
		o := learnObs{Shares: map[string]float64{src: 1}, Age: age, RowPos: 0, ItemPos: 0}
		if i < k {
			outcome(&o)
		}
		out = append(out, o)
	}
	return out
}

func played(o *learnObs) { o.Opened, o.Played = true, true }
func opened(o *learnObs) { o.Opened = true }

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestLearnRewardOrder(t *testing.T) {
	w := DefaultWeights()
	r := func(o learnObs) float64 { return w.learnReward(o) }
	none, open := r(learnObs{}), r(learnObs{Opened: true})
	play, done := r(learnObs{Opened: true, Played: true}), r(learnObs{Opened: true, Played: true, Completed: true})
	dis := r(learnObs{Dismissed: true})
	if !(dis < none && none < open && open < play && play < done) {
		t.Fatalf("rewards dismiss %v none %v open %v play %v complete %v", dis, none, open, play, done)
	}
	// A dismissal after a real play doesn't erase the play.
	if r(learnObs{Opened: true, Played: true, Dismissed: true}) != play {
		t.Fatal("play then dismiss")
	}
}

func TestLearnSmoothingAndMinImpressions(t *testing.T) {
	w := DefaultWeights()
	prior := priorFrom(nil, w)
	if !near(prior.all, w.LearnBaseRate) {
		t.Fatalf("empty prior %v", prior.all)
	}
	// Few impressions: target stays 1 however good they look.
	few := append(obsN("director", 10, 10, 0, played), obsN("trending", 10, 0, 0, nil)...)
	tg := learnTargets(aggregateLearn(few, w), prior, w)
	if tg["director"] != 1 || tg["trending"] != 1 {
		t.Fatalf("few impressions %v", tg)
	}
	// Plenty: the source that leads to plays goes up, the ignored one down.
	many := append(obsN("director", 80, 16, 0, played), obsN("trending", 80, 0, 0, nil)...)
	stats := aggregateLearn(many, w)
	tg = learnTargets(stats, prior, w)
	if tg["director"] <= 1 || tg["trending"] >= 1 {
		t.Fatalf("targets %v", tg)
	}
	// Smoothing: the same rate with more data moves further from the prior.
	more := append(obsN("director", 400, 80, 0, played), obsN("trending", 400, 0, 0, nil)...)
	tg2 := learnTargets(aggregateLearn(more, w), prior, w)
	if tg2["director"] < tg["director"] || tg2["trending"] > tg["trending"] {
		t.Fatalf("more data %v vs %v", tg2, tg)
	}
	// A household prior pulls a profile's rate toward it.
	house := priorFrom(aggregateLearn(append(obsN("director", 2000, 0, 0, nil), obsN("trending", 2000, 0, 0, nil)...), w), w)
	tg3 := learnTargets(stats, house, w)
	if tg3["director"] > tg["director"] {
		t.Fatalf("household prior %v vs %v", tg3, tg)
	}
}

func TestLearnBoundsAndStep(t *testing.T) {
	w := DefaultWeights()
	prior := priorFrom(nil, w)
	extreme := append(obsN("director", 500, 500, 0, func(o *learnObs) { played(o); o.Completed = true }), obsN("trending", 500, 0, 0, func(o *learnObs) { o.Dismissed = true })...)
	extreme = append(extreme, obsN("trending", 500, 0, 0, nil)...)
	tg := learnTargets(aggregateLearn(extreme, w), prior, w)
	if tg["director"] > w.LearnMax || tg["trending"] < w.LearnMin {
		t.Fatalf("unbounded %v", tg)
	}
	if tg["trending"] != w.LearnMin {
		t.Fatalf("dismissed source floor %v", tg["trending"])
	}
	// One night moves at most ±15 %.
	if v := learnStep(1, 2, w); !near(v, 1.15) {
		t.Fatalf("up step %v", v)
	}
	if v := learnStep(1, 0.5, w); !near(v, 0.85) {
		t.Fatalf("down step %v", v)
	}
	if v := learnStep(1.1, 1.05, w); !near(v, 1.05) {
		t.Fatalf("small step %v", v)
	}
	// Repeated nights converge to the target, never past the bounds.
	v := 1.0
	for i := 0; i < 30; i++ {
		v = learnStep(v, 5, w)
	}
	if v != w.LearnMax {
		t.Fatalf("converged %v", v)
	}
	for i := 0; i < 30; i++ {
		v = learnStep(v, 0, w)
	}
	if v != w.LearnMin {
		t.Fatalf("floor %v", v)
	}
}

func TestLearnExplorationDriftsBack(t *testing.T) {
	w := DefaultWeights()
	// A down-weighted source no longer shown much targets 1 again (it keeps
	// its rows, is re-measured, and climbs back by the step limit).
	tg := learnTargets(aggregateLearn(obsN("trending", 5, 0, 0, nil), w), priorFrom(nil, w), w)
	if tg["trending"] != 1 {
		t.Fatalf("starved source %v", tg)
	}
	if v := learnStep(0.5, tg["trending"], w); v <= 0.5 || v > 0.5*1.15+1e-9 {
		t.Fatalf("drift back %v", v)
	}
}

func TestLearnDecayAndPosition(t *testing.T) {
	w := DefaultWeights()
	fresh := aggregateLearn(obsN("theme", 10, 2, 0, played), w)["theme"]
	old := aggregateLearn(obsN("theme", 10, 2, 42*24*time.Hour, played), w)["theme"]
	if !near(old.n, fresh.n/4) || !near(old.reward, fresh.reward/4) {
		t.Fatalf("decay: %+v vs %+v", old, fresh)
	}
	if fresh.Impressions != 10 || old.Impressions != 10 || fresh.Plays != 2 {
		t.Fatalf("raw counts %+v", fresh)
	}
	// Outside the window: ignored.
	if st := aggregateLearn(obsN("theme", 10, 2, 70*24*time.Hour, played), w); len(st) != 0 {
		t.Fatalf("window %v", st)
	}
	// Position bias: the same plays from a low row count for more.
	top := obsN("trending", 100, 10, 0, played)
	low := obsN("hidden_gem", 100, 10, 0, played)
	for i := range low {
		low[i].RowPos, low[i].ItemPos = 8, 6
	}
	tg := learnTargets(aggregateLearn(append(top, low...), w), priorFrom(nil, w), w)
	if tg["hidden_gem"] <= tg["trending"] {
		t.Fatalf("position bias: %v", tg)
	}
	// Far-right tiles are ignored.
	far := obsN("trending", 5, 0, 0, nil)
	far[0].ItemPos = w.LearnMaxItemPos + 1
	if st := aggregateLearn(far, w)["trending"]; st.Impressions != 4 {
		t.Fatalf("far tile %+v", st)
	}
}

func TestItemShares(t *testing.T) {
	w := DefaultWeights()
	c := &Candidate{MediaID: "x", Sources: []Source{
		{Type: ReasonTrending, Strength: 0.3}, {Type: ReasonDirector, PersonID: 1, Strength: 0.6}, {Type: ReasonAI, CollectionID: "c", Rubric: true, Strength: 0.3}}}
	sh := itemShares(c, "", w)
	if sh[LearnDirector] != 0.5 || sh[LearnTrending] != 0.25 || sh[LearnAITheme] != 0.25 {
		t.Fatalf("shares %v", sh)
	}
	// In the trending row trending gets at least half.
	sh = itemShares(c, LearnTrending, w)
	if sh[LearnTrending] != 0.5 || !near(sh[LearnDirector]+sh[LearnAITheme], 0.5) || sh[LearnDirector] <= sh[LearnAITheme] {
		t.Fatalf("row shares %v", sh)
	}
	if sh := itemShares(&Candidate{}, "", w); sh[LearnGenre] != 1 {
		t.Fatalf("no sources %v", sh)
	}
	if sh := itemShares(&Candidate{}, LearnRewatch, w); sh[LearnRewatch] != 1 {
		t.Fatalf("no sources in a row %v", sh)
	}
}

func TestAttribute(t *testing.T) {
	cached := []cachedRow{
		{ID: RowTopPicks, Kind: RowTopPicks, Items: []cachedItem{{MediaID: "a", Score: 2, Src: map[string]float64{"director": 1}}}},
		{ID: "trending", Kind: RowTrending, Items: []cachedItem{{MediaID: "b"}, {MediaID: "c", Score: 1.5}}},
	}
	a := attribute(cached, RowTopPicks, "a")
	if a == nil || *a.rowPos != 0 || *a.itemPos != 0 || a.shares["director"] != 1 || *a.score != 2 {
		t.Fatalf("top %+v", a)
	}
	// Cached without shares: the row's source.
	a = attribute(cached, "trending", "c")
	if a == nil || *a.rowPos != 1 || *a.itemPos != 1 || a.shares[LearnTrending] != 1 {
		t.Fatalf("trending %+v", a)
	}
	if attribute(cached, "trending", "zzz") != nil || attribute(cached, "", "a") != nil || attribute(cached, "surprise", "a") != nil {
		t.Fatal("unknown attributed")
	}
	if a := attribute(nil, RowFamily, "q"); a == nil || a.shares[LearnFamily] != 1 || *a.rowPos != 1 {
		t.Fatalf("family %+v", a)
	}
	if a := attribute(nil, "curated:x", "q"); a == nil || a.shares[LearnCurated] != 1 {
		t.Fatalf("curated %+v", a)
	}
}

// Scoring integration: a learned multiplier changes the order of titles and
// rows as expected; reasons stay the same.
func TestLearnedWeightsChangeOrder(t *testing.T) {
	signals, feats := scifiFixture()
	tst := ComputeTaste(signals, feats, now, DefaultWeights())
	mk := func(id string, src Source) *Candidate {
		return &Candidate{MediaID: id, Features: Features{Kind: "movie", Genres: []int{878}, Year: 2000, Lang: "en"},
			VoteAverage: 7.5, VoteCount: 3000, Sources: []Source{src}}
	}
	trend := mk("t", Source{Type: ReasonTrending, Strength: 0.5})
	dir := mk("d", Source{Type: ReasonDirector, PersonID: 1, Strength: 0.4})
	w := DefaultWeights()
	st, sd := Score(trend, tst, w), Score(dir, tst, w)
	if st.Score <= sd.Score {
		t.Fatalf("default: trending %v director %v", st.Score, sd.Score)
	}
	w.SourceMult = map[string]float64{LearnTrending: 0.5, LearnDirector: 2}
	st2, sd2 := Score(trend, tst, w), Score(dir, tst, w)
	if st2.Score >= sd2.Score {
		t.Fatalf("learned: trending %v director %v", st2.Score, sd2.Score)
	}
	if st2.Reason.Type != st.Reason.Type || sd2.Reason.Type != sd.Reason.Type || sd2.Reason.PersonID != 1 {
		t.Fatalf("reasons changed: %+v %+v", st2.Reason, sd2.Reason)
	}

	// Row order: hidden gems (slot 3) vs trending (slot 11).
	var all []Scored
	var cands []*Candidate
	for i := 0; i < 12; i++ {
		id := string(rune('a' + i))
		cands = append(cands, mk("h"+id, Source{Type: ReasonHiddenGem, Strength: 0.4}), mk("t"+id, Source{Type: ReasonTrending, Strength: 0.4}))
	}
	for i := 0; i < 40; i++ {
		cands = append(cands, mk("z"+string(rune('a'+i%26))+string(rune('a'+i/26)), Source{Type: ReasonGenre, Strength: 0.3}))
	}
	rowIdx := func(w Weights) (int, int) {
		all = all[:0]
		for _, c := range cands {
			all = append(all, Score(c, tst, w))
		}
		rows := BuildRows(all, tst, w, nil, false)
		h, tr := -1, -1
		for i, r := range rows {
			switch r.ID {
			case "hidden_gems":
				h = i
			case "trending":
				tr = i
			}
		}
		if h < 0 || tr < 0 {
			t.Fatalf("rows missing: %v", rows)
		}
		return h, tr
	}
	h, tr := rowIdx(DefaultWeights())
	if h > tr {
		t.Fatalf("default order hidden %d trending %d", h, tr)
	}
	w = DefaultWeights()
	w.SourceMult = map[string]float64{LearnTrending: 2, LearnHiddenGem: 0.5}
	h, tr = rowIdx(w)
	if h < tr {
		t.Fatalf("learned order hidden %d trending %d", h, tr)
	}
	// Items carry their credit shares.
	rows := BuildRows(all, tst, w, nil, false)
	for _, r := range rows {
		for _, it := range r.Items {
			if len(it.Src) == 0 {
				t.Fatalf("item without shares in %s", r.ID)
			}
		}
		if r.ID == "trending" && r.Items[0].Src[LearnTrending] < 0.5 {
			t.Fatalf("trending share %v", r.Items[0].Src)
		}
	}
	// Fewer AI picks lead «Подобрано» when they don't get played.
	var picks []string
	for _, c := range cands[:20] {
		picks = append(picks, c.MediaID)
	}
	countAI := func(w Weights) int {
		rows, _ := BuildRowsAI(all, tst, w, nil, false, picks)
		n := 0
		for _, it := range rows[0].Items {
			if it.Src[LearnAIPicks] > 0 {
				n++
			}
		}
		return n
	}
	full := countAI(DefaultWeights())
	w = DefaultWeights()
	w.SourceMult = map[string]float64{LearnAIPicks: 0.5}
	if half := countAI(w); full == 0 || half >= full {
		t.Fatalf("ai picks full %d half %d", full, half)
	}
	if learnedAt(1, 0.5) != 2 || learnedAt(2, 2) != 1 || learnedAt(2, 1) != 2 {
		t.Fatal("learnedAt")
	}
}
