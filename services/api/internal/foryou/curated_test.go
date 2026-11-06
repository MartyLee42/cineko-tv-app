package foryou

import (
	"testing"

	"martytv/api/internal/curated"
)

func TestPickCuratedPrefersPartlyWatched(t *testing.T) {
	cands := []curatedCand{{id: "a", taste: 0.9}, {id: "b", partial: true, taste: -0.5}, {id: "c", taste: 0.2}}
	for _, day := range []string{"2026-11-01", "2026-11-02", "2026-11-03"} {
		if got := pickCurated(cands, "p1", day); got != "b" {
			t.Fatalf("%s: picked %s, want the partly watched list", day, got)
		}
	}
	if pickCurated(nil, "p1", "2026-11-01") != "" {
		t.Fatal("empty pick")
	}
}

func TestPickCuratedTasteThenRotation(t *testing.T) {
	// A strong taste match wins over the daily jitter.
	cands := []curatedCand{{id: "a", taste: 0.9}, {id: "b", taste: -0.3}}
	if got := pickCurated(cands, "p1", "2026-11-01"); got != "a" {
		t.Fatalf("taste: %s", got)
	}
	// Equal lists rotate across days (and differ between profiles).
	eq := []curatedCand{{id: "a"}, {id: "b"}, {id: "c"}, {id: "d"}}
	seen := map[string]bool{}
	for d := 1; d <= 20; d++ {
		day := "2026-11-" + string(rune('0'+d/10)) + string(rune('0'+d%10))
		got := pickCurated(eq, "p1", day)
		if got != pickCurated(eq, "p1", day) {
			t.Fatal("not stable within a day")
		}
		seen[got] = true
	}
	if len(seen) < 2 {
		t.Fatalf("no rotation: %v", seen)
	}
}

func TestCuratedEligibleAndTitle(t *testing.T) {
	es := func(n, watched int) []curated.Entry {
		out := make([]curated.Entry, n)
		for i := range out {
			out[i] = curated.Entry{Position: i + 1, MediaID: "m", Watched: i < watched}
		}
		return out
	}
	if curatedEligible(&curated.Progress{Entries: es(3, 0)}) {
		t.Fatal("too short list eligible")
	}
	if curatedEligible(&curated.Progress{Entries: es(6, 6), Watched: 6}) {
		t.Fatal("finished list eligible")
	}
	if !curatedEligible(&curated.Progress{Entries: es(6, 2), Watched: 2}) {
		t.Fatal("started list not eligible")
	}
	if got := curatedRowTitle("ru", "Делёз: «Кино 2»", 7, 48); got != "Подборка: Делёз: «Кино 2» · 7 из 48" {
		t.Fatalf("title %q", got)
	}
	if got := curatedRowTitle("en", "Deleuze", 1, 6); got != "Collection: Deleuze · 1 of 6" {
		t.Fatalf("title %q", got)
	}
}
