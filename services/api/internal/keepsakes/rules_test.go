package keepsakes

import (
	"fmt"
	"testing"
	"time"
)

var moscow, _ = time.LoadLocation("Europe/Moscow")

// at: a Moscow wall-clock time.
func at(s string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", s, moscow)
	if err != nil {
		panic(err)
	}
	return t
}

func date(y int) *time.Time {
	t := time.Date(y, 6, 1, 0, 0, 0, 0, time.UTC)
	return &t
}

func TestSeatIsStableAndInRange(t *testing.T) {
	a := SeatFor("p1", "m1")
	if a != SeatFor("p1", "m1") {
		t.Fatal("seat changed between calls")
	}
	distinct := map[Seat]bool{}
	for i := 0; i < 500; i++ {
		s := SeatFor("profile", fmt.Sprint("media-", i))
		if s.Hall < 1 || s.Hall > halls || s.Row < 1 || s.Row > rows || s.Seat < 1 || s.Seat > seatsPerRow {
			t.Fatalf("out of range %+v", s)
		}
		distinct[s] = true
	}
	if len(distinct) < 450 {
		t.Fatalf("seats collide too often: %d distinct of 500", len(distinct))
	}
	if SeatFor("other", "media-1") == SeatFor("profile", "media-1") && SeatFor("other", "media-2") == SeatFor("profile", "media-2") {
		t.Fatal("seat ignores the profile")
	}
}

func TestSeatGolden(t *testing.T) {
	// Locks the hash layout: changing the salt or layout would reseat every stub.
	if s := SeatFor("a", "b"); s != (Seat{Hall: 6, Row: 17, Seat: 27}) {
		t.Fatalf("%+v", s)
	}
}

func TestWeekendOf(t *testing.T) {
	for _, tc := range []struct {
		when string
		fri  string
		ok   bool
	}{
		{"2026-11-05 23:00", "", false},          // Thursday
		{"2026-11-06 17:59", "", false},          // Friday before 18:00
		{"2026-11-06 18:00", "2026-11-06", true}, // Friday 18:00
		{"2026-11-07 12:00", "2026-11-06", true},
		{"2026-11-08 23:59", "2026-11-06", true},
		{"2026-11-09 05:59", "2026-11-06", true}, // Monday before 06:00
		{"2026-11-09 06:00", "", false},
		{"2026-11-10 03:00", "", false}, // Tuesday night
	} {
		fri, mon, ok := WeekendOf(at(tc.when), moscow)
		if ok != tc.ok || fri != tc.fri {
			t.Errorf("%s: %q %v, want %q %v", tc.when, fri, ok, tc.fri, tc.ok)
		}
		if ok && mon != "2026-11-09" {
			t.Errorf("%s: monday %q", tc.when, mon)
		}
	}
	// The household clock decides: Fri 15:30 UTC is 18:30 in Moscow.
	u := time.Date(2026, 11, 6, 15, 30, 0, 0, time.UTC)
	if _, _, ok := WeekendOf(u, time.UTC); ok {
		t.Fatal("UTC: still Friday afternoon")
	}
	if fri, _, ok := WeekendOf(u, moscow); !ok || fri != "2026-11-06" {
		t.Fatal("Moscow: Friday evening")
	}
	// Across a DST change (Europe/Berlin, last Sunday of October).
	berlin, _ := time.LoadLocation("Europe/Berlin")
	sun := time.Date(2026, 10, 25, 23, 0, 0, 0, berlin)
	if fri, mon, ok := WeekendOf(sun, berlin); !ok || fri != "2026-10-23" || mon != "2026-10-26" {
		t.Fatalf("DST weekend %q %q %v", fri, mon, ok)
	}
}

const series = "series-1"

func season(n int, airDates ...string) []Episode {
	out := make([]Episode, len(airDates))
	for i, d := range airDates {
		out[i] = Episode{ID: fmt.Sprintf("s%de%d", n, i+1), AirDate: d}
	}
	return out
}

func ep(id, when string, manual bool) Completion {
	var n int
	fmt.Sscanf(id, "s%de", &n)
	return Completion{MediaID: series, Kind: "series", EpisodeID: id, Season: n, At: at(when), Manual: manual, Lang: "en"}
}

func evalOne(t *testing.T, id string, h History, loc *time.Location) (Unlock, bool) {
	t.Helper()
	for _, r := range Rules {
		if r.ID == id {
			return r.Eval(h, loc)
		}
	}
	t.Fatalf("no rule %s", id)
	return Unlock{}, false
}

func TestMarathon(t *testing.T) {
	seasons := map[SeasonKey][]Episode{
		{series, 1}: season(1, "2020-01-01", "2020-01-08", "2020-01-15"),
		// S2: the third episode airs after the weekend (2026-11-20).
		{series, 2}: season(2, "2026-10-01", "2026-10-08", "2026-11-20"),
		{series, 3}: season(3, "2021-01-01", "2021-01-02"),
	}
	cases := []struct {
		name string
		c    []Completion
		ok   bool
		when string
	}{
		{"whole season Fri-Sun", []Completion{ep("s1e1", "2026-11-06 19:00", false), ep("s1e2", "2026-11-07 14:00", false), ep("s1e3", "2026-11-08 22:10", false)}, true, "2026-11-08 22:10"},
		{"last one Monday 05:30", []Completion{ep("s1e1", "2026-11-06 19:00", false), ep("s1e2", "2026-11-07 14:00", false), ep("s1e3", "2026-11-09 05:30", false)}, true, "2026-11-09 05:30"},
		{"last one Monday 06:10", []Completion{ep("s1e1", "2026-11-06 19:00", false), ep("s1e2", "2026-11-07 14:00", false), ep("s1e3", "2026-11-09 06:10", false)}, false, ""},
		{"first one Friday 17:00", []Completion{ep("s1e1", "2026-11-06 17:00", false), ep("s1e2", "2026-11-07 14:00", false), ep("s1e3", "2026-11-08 22:10", false)}, false, ""},
		{"one missing", []Completion{ep("s1e1", "2026-11-06 19:00", false), ep("s1e3", "2026-11-08 22:10", false)}, false, ""},
		{"two weekends", []Completion{ep("s1e1", "2026-10-31 19:00", false), ep("s1e2", "2026-11-07 14:00", false), ep("s1e3", "2026-11-08 22:10", false)}, false, ""},
		{"marked watched", []Completion{ep("s1e1", "2026-11-07 19:00", true), ep("s1e2", "2026-11-07 19:00", true), ep("s1e3", "2026-11-07 19:00", true)}, false, ""},
		// Only the aired episodes of S2 count (2 of 3 aired by then) — but that's below the minimum.
		{"aired part too short", []Completion{ep("s2e1", "2026-11-07 19:00", false), ep("s2e2", "2026-11-07 21:00", false)}, false, ""},
		{"two-episode season", []Completion{ep("s3e1", "2026-11-07 19:00", false), ep("s3e2", "2026-11-07 21:00", false)}, false, ""},
	}
	for _, tc := range cases {
		u, ok := evalOne(t, Marathon, History{Completions: tc.c, Seasons: seasons}, moscow)
		if ok != tc.ok || (ok && (!u.At.Equal(at(tc.when)) || u.MediaID != series)) {
			t.Errorf("%s: %+v %v", tc.name, u, ok)
		}
	}
	// S2 once all three aired: a later weekend works.
	s2 := []Completion{ep("s2e1", "2026-11-20 20:00", false), ep("s2e2", "2026-11-21 20:00", false), ep("s2e3", "2026-11-22 20:00", false)}
	if _, ok := evalOne(t, Marathon, History{Completions: s2, Seasons: seasons}, moscow); !ok {
		t.Error("S2 after its finale aired")
	}
	// The weekend is judged on the household clock: in UTC the first episode
	// (Fri 18:30 Moscow = 15:30 UTC) is still Friday afternoon.
	tz := []Completion{ep("s1e1", "2026-11-06 18:30", false), ep("s1e2", "2026-11-07 14:00", false), ep("s1e3", "2026-11-08 22:10", false)}
	if _, ok := evalOne(t, Marathon, History{Completions: tz, Seasons: seasons}, moscow); !ok {
		t.Error("Moscow weekend")
	}
	if _, ok := evalOne(t, Marathon, History{Completions: tz, Seasons: seasons}, time.UTC); ok {
		t.Error("UTC: not a weekend")
	}
}

func TestArchaeologist(t *testing.T) {
	h := History{Completions: []Completion{
		{MediaID: "new", Kind: "movie", At: at("2026-01-01 20:00"), Released: date(1960)},
		{MediaID: "old-series", Kind: "series", EpisodeID: "e", Season: 1, At: at("2026-01-02 20:00"), Released: date(1951)},
		{MediaID: "nodate", Kind: "movie", At: at("2026-01-03 20:00")},
	}}
	if _, ok := evalOne(t, Archaeologist, h, moscow); ok {
		t.Fatal("1960 film / an old series / no date must not count")
	}
	h.Completions = append(h.Completions,
		Completion{MediaID: "casablanca", Kind: "movie", At: at("2026-03-01 20:00"), Released: date(1942), Manual: true},
		Completion{MediaID: "metropolis", Kind: "movie", At: at("2026-02-01 20:00"), Released: date(1927)})
	u, ok := evalOne(t, Archaeologist, h, moscow)
	if !ok || u.MediaID != "metropolis" || !u.At.Equal(at("2026-02-01 20:00")) {
		t.Fatalf("%+v %v", u, ok)
	}
}

func TestPolyglot(t *testing.T) {
	var c []Completion
	for i, l := range []string{"en", "ru", "fr", "xx", "", "en", "ja"} {
		c = append(c, Completion{MediaID: fmt.Sprint("m", i), Kind: "movie", Lang: l, At: at(fmt.Sprintf("2026-01-%02d 20:00", i+1))})
	}
	if _, ok := evalOne(t, Polyglot, History{Completions: c}, moscow); ok {
		t.Fatal("4 real languages")
	}
	// A series counts with one finished episode.
	c = append(c, Completion{MediaID: "kdrama", Kind: "series", EpisodeID: "e1", Season: 1, Lang: "ko", At: at("2026-02-10 20:00"), Manual: true})
	u, ok := evalOne(t, Polyglot, History{Completions: c}, moscow)
	if !ok || u.MediaID != "kdrama" || !u.At.Equal(at("2026-02-10 20:00")) {
		t.Fatalf("%+v %v", u, ok)
	}
	// Order of input doesn't matter.
	rev := make([]Completion, len(c))
	for i := range c {
		rev[len(c)-1-i] = c[i]
	}
	if u2, _ := evalOne(t, Polyglot, History{Completions: rev}, moscow); u2 != u {
		t.Fatalf("order-dependent: %+v vs %+v", u2, u)
	}
}

func TestNightOwl(t *testing.T) {
	mk := func(when string, manual bool) []Completion {
		return []Completion{{MediaID: "m", Kind: "movie", At: at(when), Manual: manual}}
	}
	for _, tc := range []struct {
		when   string
		manual bool
		ok     bool
	}{
		{"2026-11-07 01:59", false, false},
		{"2026-11-07 02:00", false, true},
		{"2026-11-07 04:59", false, true},
		{"2026-11-07 05:00", false, false},
		{"2026-11-07 03:00", true, false}, // pressing «Просмотрено» at 3 am is not watching
	} {
		if _, ok := evalOne(t, NightOwl, History{Completions: mk(tc.when, tc.manual)}, moscow); ok != tc.ok {
			t.Errorf("%s manual=%v: %v", tc.when, tc.manual, ok)
		}
	}
	// 03:00 in Moscow is 00:00 UTC: the household clock decides.
	if _, ok := evalOne(t, NightOwl, History{Completions: mk("2026-11-07 03:00", false)}, time.UTC); ok {
		t.Error("UTC midnight")
	}
}

func TestEvaluateIDs(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range Rules {
		if seen[r.ID] {
			t.Fatalf("duplicate id %s", r.ID)
		}
		seen[r.ID] = true
	}
	h := History{Completions: []Completion{{MediaID: "m", Kind: "movie", At: at("2026-11-07 03:00"), Released: date(1950), Lang: "fr"}}}
	got := Evaluate(h, moscow)
	if len(got) != 2 || got[0].ID != Archaeologist || got[1].ID != NightOwl {
		t.Fatalf("%+v", got)
	}
}
