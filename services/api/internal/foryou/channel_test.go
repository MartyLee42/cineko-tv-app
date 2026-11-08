package foryou

import (
	"fmt"
	"testing"
)

func zero() float64 { return 0 }

func TestBuildProgrammeAlternatesGenres(t *testing.T) {
	var cands []progCand
	// Ten sci-fi films ranked above five dramas and five comedies.
	for i := 0; i < 10; i++ {
		cands = append(cands, progCand{ID: fmt.Sprintf("sf%d", i), Genres: []int{878}, Score: 1 - 0.01*float64(i)})
	}
	for i := 0; i < 5; i++ {
		cands = append(cands, progCand{ID: fmt.Sprintf("dr%d", i), Genres: []int{18}, Score: 0.8 - 0.01*float64(i)})
		cands = append(cands, progCand{ID: fmt.Sprintf("co%d", i), Genres: []int{35}, Score: 0.79 - 0.01*float64(i)})
	}
	got := buildProgramme(cands, 6, zero)
	if len(got) != 6 || got[0].ID != "sf0" {
		t.Fatalf("programme %v", got)
	}
	for i := 1; i < len(got); i++ {
		if got[i].Genres[0] == got[i-1].Genres[0] {
			t.Fatalf("same genre twice in a row at %d: %v", i, got)
		}
	}
}

func TestBuildProgrammeSeriesSpacing(t *testing.T) {
	cands := []progCand{
		{ID: "s1", Series: true, Score: 0.95, Genres: []int{18}},
		{ID: "s2", Series: true, Score: 0.94, Genres: []int{80}},
		{ID: "s3", Series: true, Score: 0.93, Genres: []int{99}},
		{ID: "s4", Series: true, Score: 0.92, Genres: []int{10765}},
	}
	for i := 0; i < 8; i++ {
		cands = append(cands, progCand{ID: fmt.Sprintf("m%d", i), Score: 0.5, Genres: []int{100 + i}})
	}
	got := buildProgramme(cands, 6, zero)
	series := 0
	for i, c := range got {
		if c.Series {
			series++
			if i > 0 && got[i-1].Series {
				t.Fatalf("two episodes in a row: %v", got)
			}
		}
	}
	if series != 2 || !got[0].Series {
		t.Fatalf("series share %d: %v", series, got)
	}
}

func TestBuildProgrammeShortPool(t *testing.T) {
	if got := buildProgramme(nil, 8, zero); len(got) != 0 {
		t.Fatalf("empty %v", got)
	}
	got := buildProgramme([]progCand{{ID: "a"}, {ID: "b"}}, 8, zero)
	if len(got) != 2 {
		t.Fatalf("short %v", got)
	}
	// Only series left over the cap: the programme just ends.
	got = buildProgramme([]progCand{{ID: "s1", Series: true}, {ID: "s2", Series: true}, {ID: "s3", Series: true}}, 3, zero)
	if len(got) != 1 {
		t.Fatalf("series cap %v", got)
	}
}

func TestRankScore(t *testing.T) {
	if rankScore(0, 1) != 1 || rankScore(0, 11) != 1 || rankScore(10, 11) != 0.5 {
		t.Fatal("rank score")
	}
}
