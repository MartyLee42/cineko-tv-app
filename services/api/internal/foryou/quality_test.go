package foryou

import "testing"

func fp(v float64) *float64 { return &v }

func TestComputeQuality(t *testing.T) {
	obs := []qualityObs{
		{MediaID: "a", Shares: map[string]float64{"director": 1}, Score: fp(3), Top10: true, Played: true, Done: true, Rating: 9},
		{MediaID: "b", Shares: map[string]float64{"director": 0.5, "trending": 0.5}, Score: fp(2.5), Top10: true, Played: true, Rating: 8},
		{MediaID: "c", Shares: map[string]float64{"trending": 1}, Score: fp(1), Played: true, Rating: 3},
		{MediaID: "d", Shares: map[string]float64{"trending": 1}, Score: fp(0.5), Top10: true},
		{MediaID: "e", Shares: map[string]float64{"theme": 1}, Score: fp(2), Done: true},
		{MediaID: "f", Score: fp(1.5)},
	}
	st := computeQuality(obs, []int{5, 6, 7})
	if f := st.Funnel; f != (Funnel{Shown: 6, Played: 4, Finished: 2, Rated: 3, Liked: 2, Disliked: 1}) {
		t.Fatalf("funnel %+v", f)
	}
	if r := st.Recommended; r.N != 3 || *r.Avg != 6.67 || *r.Liked != 0.67 || *r.Disliked != 0.33 {
		t.Fatalf("recommended %+v", r)
	}
	if e := st.Elsewhere; e.N != 3 || *e.Avg != 6 {
		t.Fatalf("elsewhere %+v", e)
	}
	if st.PrecisionShown != 3 || st.PrecisionLiked != 2 {
		t.Fatalf("precision %d/%d", st.PrecisionLiked, st.PrecisionShown)
	}
	// Calibration: tertiles low → high; the top bucket holds a and b (9, 8).
	if len(st.Calibration) != 3 {
		t.Fatalf("calibration %+v", st.Calibration)
	}
	lo, hi := st.Calibration[0], st.Calibration[2]
	if lo.ScoreMin != 0.5 || lo.ScoreMax != 1 || lo.N != 1 || *lo.Avg != 3 || hi.ScoreMin != 2.5 || hi.ScoreMax != 3 || hi.N != 2 || *hi.Avg != 8.5 || hi.Played != 2 {
		t.Fatalf("buckets lo %+v hi %+v", lo, hi)
	}
	// Per source, share-weighted, in LearnSources order.
	if len(st.Sources) != 3 || st.Sources[0].Source != "trending" || st.Sources[1].Source != "director" || st.Sources[2].Source != "theme" {
		t.Fatalf("sources %+v", st.Sources)
	}
	tr, dir := st.Sources[0], st.Sources[1]
	if tr.Shown != 2.5 || tr.Plays != 1.5 || tr.Rated != 1.5 || *tr.Avg != 4.67 || *tr.Liked != 0.33 {
		t.Fatalf("trending %+v", tr)
	}
	if dir.Shown != 1.5 || *dir.Avg != 8.67 || *dir.Liked != 1 {
		t.Fatalf("director %+v", dir)
	}
	if st.Sources[2].Avg != nil {
		t.Fatalf("unrated source %+v", st.Sources[2])
	}
	if len(st.Hits) != 2 || st.Hits[0].MediaID != "a" || st.Hits[1].MediaID != "b" || len(st.Misses) != 1 || st.Misses[0].MediaID != "c" {
		t.Fatalf("hits %v misses %v", st.Hits, st.Misses)
	}
}

func TestComputeQualityEmpty(t *testing.T) {
	st := computeQuality(nil, nil)
	if st.Funnel != (Funnel{}) || st.Recommended.Avg != nil || len(st.Calibration) != 0 || st.Sources == nil || st.Hits == nil {
		t.Fatalf("empty %+v", st)
	}
	// Under three scored titles there is no calibration.
	if st := computeQuality([]qualityObs{{MediaID: "a", Score: fp(1)}, {MediaID: "b", Score: fp(2)}}, nil); len(st.Calibration) != 0 {
		t.Fatalf("calibration %+v", st.Calibration)
	}
}
