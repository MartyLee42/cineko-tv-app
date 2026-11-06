package foryou

import (
	"slices"
	"strconv"
	"testing"
	"time"
)

func TestGenerateQuizAnswers(t *testing.T) {
	now := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	w := DefaultWeights()
	feats := map[string]Features{}
	var sigs []Signal
	n := 0
	title := func(f Features, s Signal) {
		n++
		id := "m" + strconv.Itoa(n)
		feats[id] = f
		s.MediaID = id
		s.RatedAt, s.CompletedAt, s.LastActivity = now.AddDate(0, -1, 0), now.AddDate(0, -1, 0), now.AddDate(0, -1, 0)
		sigs = append(sigs, s)
	}
	// Loves Soviet comedies and 2010s sci-fi series; hates horror (low
	// ratings + an abandoned one); never watched westerns or war films.
	for i := 0; i < 4; i++ {
		title(Features{Kind: "movie", Genres: []int{35}, Year: 1973 + i, Lang: "ru", Countries: []string{"SU"}}, Signal{Rating: 9})
	}
	for i := 0; i < 3; i++ {
		title(Features{Kind: "series", Genres: []int{878, 18}, Year: 2012 + i, Lang: "en", Countries: []string{"US"}}, Signal{Completed: true, Favorite: i == 0})
	}
	title(Features{Kind: "movie", Genres: []int{27, 53}, Year: 2015, Lang: "en", Countries: []string{"US"}}, Signal{Rating: 2})
	title(Features{Kind: "movie", Genres: []int{27}, Year: 2018, Lang: "en", Countries: []string{"US"}}, Signal{Rating: 3})
	title(Features{Kind: "movie", Genres: []int{27}, Year: 2019, Lang: "en"}, Signal{Started: true, Percent: 0.05, LastActivity: now.AddDate(0, -2, 0)})
	// A neutral 6 says nothing.
	title(Features{Kind: "movie", Genres: []int{10749}, Year: 2001, Lang: "fr", Countries: []string{"FR"}}, Signal{Rating: 6})
	sigs[len(sigs)-2].LastActivity = now.AddDate(0, -2, 0)

	a, b := GenerateQuizAnswers(sigs, feats, now, w)
	if b.Titles != 10 || b.Rated != 7 || b.Completed != 3 || b.Favorites != 1 || b.Liked != 7 || b.Disliked != 3 {
		t.Fatalf("basis %+v", b)
	}
	has := func(q, o string) bool { return slices.Contains(a[q], o) }
	if !has("genres_like", "35") || !has("genres_like", "878") || has("genres_like", "27") {
		t.Fatalf("likes %v", a["genres_like"])
	}
	if !slices.Equal(a["genres_dislike"], []string{"27"}) {
		t.Fatalf("dislikes %v (only horror has negative evidence)", a["genres_dislike"])
	}
	if !has("eras", "1970") || !has("eras", "2010") || has("eras", "2000") {
		t.Fatalf("eras %v", a["eras"])
	}
	if !has("origins", "soviet") || has("origins", "europe") {
		t.Fatalf("origins %v", a["origins"])
	}
	if !has("mood", "funny") {
		t.Fatalf("mood %v", a["mood"])
	}
	if !slices.Equal(a["format"], []string{"both"}) || !slices.Equal(a["intensity"], []string{"avoid"}) {
		t.Fatalf("format %v intensity %v", a["format"], a["intensity"])
	}
	if f := validateQuizAnswers(a); len(f) > 0 {
		t.Fatalf("invalid %v", f)
	}
	for q := range a {
		if !slices.Contains(quizGenQuestions, q) {
			t.Fatalf("unexpected question %s", q)
		}
	}
	// Deterministic.
	a2, _ := GenerateQuizAnswers(sigs, feats, now, w)
	for q, v := range a {
		if !slices.Equal(v, a2[q]) {
			t.Fatalf("not deterministic: %s %v vs %v", q, v, a2[q])
		}
	}

	// Only likes: nothing disliked, absence is not dislike.
	a, _ = GenerateQuizAnswers(sigs[:7], feats, now, w)
	if len(a["genres_dislike"]) != 0 || len(a["intensity"]) != 0 {
		t.Fatalf("dislikes from absence %v / %v", a["genres_dislike"], a["intensity"])
	}
	// Mostly series → series.
	a, _ = GenerateQuizAnswers(sigs[4:7], feats, now, w)
	if !slices.Equal(a["format"], []string{"series"}) {
		t.Fatalf("format %v", a["format"])
	}
}
