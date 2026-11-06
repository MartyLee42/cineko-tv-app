package family

import (
	"testing"
	"time"
)

var now = time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)

func daysAgo(d int) time.Time { return now.Add(-time.Duration(d) * 24 * time.Hour) }

func TestSimilarity(t *testing.T) {
	me := map[string]int{"a": 9, "b": 8, "c": 3, "d": 10, "e": 2}
	twin := map[string]int{"a": 10, "b": 8, "c": 2, "d": 9, "e": 3}
	opposite := map[string]int{"a": 2, "b": 3, "c": 9, "d": 1, "e": 10}
	s1, ok1, co1 := Similarity(me, twin, nil, nil)
	s2, ok2, _ := Similarity(me, opposite, nil, nil)
	if !ok1 || !ok2 || co1 != 5 || s1 < 0.5 || s2 > -0.5 {
		t.Fatalf("twin %v (%v, %d), opposite %v", s1, ok1, co1, s2)
	}
	if MatchPercent(s1) <= 75 || MatchPercent(s2) >= 25 {
		t.Fatalf("match %d / %d", MatchPercent(s1), MatchPercent(s2))
	}
	// One co-rated title: not enough; no genres either → unknown.
	if _, ok, co := Similarity(me, map[string]int{"a": 9, "z": 5}, nil, nil); ok || co != 1 {
		t.Fatalf("one co-rating known=%v co=%d", ok, co)
	}
	// Genre affinities (taste quiz / viewing) fill in without co-ratings.
	g1 := map[string]float64{"878": 1, "28": 0.6, "10749": -0.8}
	g2 := map[string]float64{"878": 0.9, "28": 0.4, "10749": -0.5}
	g3 := map[string]float64{"878": -0.7, "10749": 1, "35": 0.8}
	sg, ok, _ := Similarity(nil, nil, g1, g2)
	sd, _, _ := Similarity(nil, nil, g1, g3)
	if !ok || sg <= 0.5 || sd >= 0 {
		t.Fatalf("genre sim same %v different %v", sg, sd)
	}
	// Ratings agreeing at a constant level (no spread) still count.
	flat, ok, _ := Similarity(map[string]int{"a": 8, "b": 8, "c": 8}, map[string]int{"a": 8, "b": 8, "c": 8}, nil, nil)
	if !ok || flat <= 0.5 {
		t.Fatalf("flat %v", flat)
	}
}

func TestRankBySimilarityAndExclusions(t *testing.T) {
	// The viewer agrees with Twin and disagrees with Other on co-rated titles.
	viewer := Viewer{
		Ratings:  map[string]int{"a": 9, "b": 8, "c": 3, "d": 10, "e": 2},
		Excluded: map[string]bool{"a": true, "b": true, "c": true, "d": true, "e": true, "seen": true, "dismissed": true},
	}
	twin := Sharer{Person: Person{ProfileID: "p-twin", Name: "Twin"}, Signals: map[string]Signal{
		"a": {Rating: 10, RatedAt: daysAgo(30)}, "b": {Rating: 8, RatedAt: daysAgo(30)}, "c": {Rating: 2, RatedAt: daysAgo(30)},
		"d": {Rating: 9, RatedAt: daysAgo(30)}, "e": {Rating: 3, RatedAt: daysAgo(30)},
		"twin-pick": {Rating: 8, RatedAt: daysAgo(10)},
		"seen":      {Rating: 10, RatedAt: daysAgo(1)},
		"dismissed": {Rating: 10, RatedAt: daysAgo(1)},
		"meh":       {Rating: 6, RatedAt: daysAgo(1)},
	}}
	other := Sharer{Person: Person{ProfileID: "p-other", Name: "Other"}, Signals: map[string]Signal{
		"a": {Rating: 2, RatedAt: daysAgo(30)}, "b": {Rating: 3, RatedAt: daysAgo(30)}, "c": {Rating: 9, RatedAt: daysAgo(30)},
		"d": {Rating: 1, RatedAt: daysAgo(30)}, "e": {Rating: 10, RatedAt: daysAgo(30)},
		"other-pick": {Rating: 8, RatedAt: daysAgo(10)},
		"both":       {Rating: 9, RatedAt: daysAgo(5)},
	}}
	twin.Signals["both"] = Signal{Completed: true, CompletedAt: daysAgo(1)}
	stranger := Sharer{Person: Person{ProfileID: "p-new", Name: "New"}, Signals: map[string]Signal{
		"old-watch": {Completed: true, CompletedAt: daysAgo(400)},
		"fav":       {Favorite: true, FavoriteAt: daysAgo(3)},
		"hated":     {Rating: 2, RatedAt: daysAgo(2), Completed: true, CompletedAt: daysAgo(2)},
	}}
	members, items := Rank(viewer, []Sharer{other, stranger, twin}, now, 10)

	if len(members) != 3 || members[0].Name != "Twin" || members[1].Name != "Other" || members[2].Match != nil {
		t.Fatalf("members %+v", members)
	}
	if *members[0].Match < 75 || *members[1].Match > 25 || members[0].CoRated != 5 {
		t.Fatalf("matches %d %d", *members[0].Match, *members[1].Match)
	}
	pos := map[string]int{}
	for i, it := range items {
		pos[it.MediaID] = i
	}
	for _, id := range []string{"seen", "dismissed", "a", "meh", "old-watch", "hated"} {
		if _, ok := pos[id]; ok {
			t.Fatalf("%s should be excluded: %+v", id, items)
		}
	}
	// Liked by two → first; the similar member's pick beats the dissimilar one's.
	if items[0].MediaID != "both" || items[0].LikedBy != 2 || len(items[0].People) != 2 {
		t.Fatalf("top %+v", items[0])
	}
	if pos["twin-pick"] > pos["other-pick"] {
		t.Fatalf("similarity ignored: %+v", items)
	}
	if _, ok := pos["fav"]; !ok {
		t.Fatalf("favorite missing: %+v", items)
	}
	// "both": weighted by similarity, Twin's finished-yesterday comes before
	// the dissimilar Other's ★9.
	p := items[0].People
	if p[1].Name != "Other" || p[1].Rating == nil || *p[1].Rating != 9 || p[0].Name != "Twin" || !p[0].Completed || p[0].CompletedAt == nil {
		t.Fatalf("people %+v", p)
	}
	// Limit applies.
	if _, few := Rank(viewer, []Sharer{other, stranger, twin}, now, 2); len(few) != 2 {
		t.Fatalf("limit %d", len(few))
	}
}

func TestWhyText(t *testing.T) {
	r := 9
	y := daysAgo(1)
	people := []Endorsement{
		{Person: Person{Name: "Анна"}, Rating: &r, Liked: true},
		{Person: Person{Name: "Олег"}, Completed: true, CompletedAt: &y, Liked: true},
		{Person: Person{Name: "Ира"}, Favorite: true, Liked: true},
	}
	if got := WhyText("ru", people, now); got != "Анна ★9 · Олег: посмотрено вчера · Ира ♥" {
		t.Fatalf("ru %q", got)
	}
	if got := WhyText("en", people[1:2], now); got != "Олег: watched yesterday" {
		t.Fatalf("en %q", got)
	}
}
