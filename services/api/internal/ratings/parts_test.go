package ratings

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Captured live from rating.kinopoisk.ru/301.xml (The Matrix), 2026-10.
const matrixXML = `<?xml version="1.0" encoding="WINDOWS-1251" standalone="yes"?><rating><kp_rating num_vote="817709">8.501</kp_rating><imdb_rating num_vote="2200000">8.7</imdb_rating></rating>`

func TestParseRatingXML(t *testing.T) {
	v, err := ParseRatingXML([]byte(matrixXML))
	if err != nil {
		t.Fatal(err)
	}
	if *v.KP != 8.501 || *v.KPVotes != 817709 || *v.IMDb != 8.7 || *v.IMDbVotes != 2200000 {
		t.Fatalf("%+v", v)
	}
	// No IMDb rating; KP rating without votes yet (unreleased) is unknown.
	v, err = ParseRatingXML([]byte(`<?xml version="1.0" encoding="WINDOWS-1251"?><rating><kp_rating num_vote="12">6.9</kp_rating></rating>`))
	if err != nil || *v.KP != 6.9 || *v.KPVotes != 12 || v.IMDb != nil || v.IMDbVotes != nil {
		t.Fatalf("%+v %v", v, err)
	}
	v, err = ParseRatingXML([]byte(`<rating><kp_rating num_vote="0">0</kp_rating><imdb_rating num_vote="">7.5</imdb_rating></rating>`))
	if err != nil || v.KP != nil || *v.IMDb != 7.5 || v.IMDbVotes != nil {
		t.Fatalf("%+v %v", v, err)
	}
	if _, err := ParseRatingXML([]byte(`<!DOCTYPE html><html>`)); err == nil {
		t.Fatal("html must fail")
	}
}

func TestRatingClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/301.xml":
			w.Header().Set("Content-Type", "text/xml; charset=Windows-1251")
			_, _ = w.Write([]byte(matrixXML))
		case "/2.xml": // some ids answer with a GIF
			w.Header().Set("Content-Type", "image/gif")
			_, _ = w.Write([]byte("GIF89a"))
		case "/500.xml":
			w.WriteHeader(http.StatusBadGateway)
		default:
			w.Header().Set("Content-Type", "text/html; charset=Windows-1251")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("<!DOCTYPE html>"))
		}
	}))
	defer srv.Close()
	c := NewRatingClient(srv.URL, HTTPClient(nil, 2*time.Second))
	ctx := context.Background()
	if v, err := c.Fetch(ctx, 301); err != nil || *v.KP != 8.501 {
		t.Fatalf("%+v %v", v, err)
	}
	for _, id := range []int{2, 999} {
		if _, err := c.Fetch(ctx, id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%d: %v", id, err)
		}
	}
	if _, err := c.Fetch(ctx, 500); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("5xx: %v", err)
	}
}

func TestPick(t *testing.T) {
	no, yes := ptr(false), ptr(true)
	matrix := Target{Kind: "movie", TMDBID: 603, IMDbID: "tt0133093", Year: 1999, Titles: []string{"The Matrix", "Матрица"}}

	// 1. IMDb id wins regardless of names.
	if id, ok := Pick(matrix, []Candidate{{KPID: 1, Names: []string{"Матрица"}, Year: 1999, Series: no},
		{KPID: 301, IMDbID: "tt0133093", Series: no}}); !ok || id != 301 {
		t.Fatalf("imdb: %d %v", id, ok)
	}
	// 2. Title + year (punctuation, case, ё) with a contradicting IMDb id rejected.
	cands := []Candidate{
		{KPID: 7, IMDbID: "tt9999999", Names: []string{"Матрица"}, Year: 1999, Series: no},
		{KPID: 301, Names: []string{"МАТРИЦА!", "The Matrix"}, Year: 1999, Series: no},
		{KPID: 8, Names: []string{"The Matrix"}, Year: 1999, Series: yes}, // a series: wrong kind
	}
	if id, ok := Pick(matrix, cands); !ok || id != 301 {
		t.Fatalf("title: %d %v", id, ok)
	}
	// Exact year beats ±1; two different exact-year matches are ambiguous.
	dune := Target{Kind: "movie", Year: 2021, Titles: []string{"Dune", "Дюна"}}
	if id, ok := Pick(dune, []Candidate{{KPID: 1, Names: []string{"Dune"}, Year: 2020}, {KPID: 2, Names: []string{"Дюна"}, Year: 2021}}); !ok || id != 2 {
		t.Fatalf("year: %d %v", id, ok)
	}
	if _, ok := Pick(dune, []Candidate{{KPID: 1, Names: []string{"Dune"}, Year: 2021}, {KPID: 2, Names: []string{"Дюна"}, Year: 2021}}); ok {
		t.Fatal("ambiguous must miss")
	}
	// Year too far, or no name match → miss.
	if _, ok := Pick(dune, []Candidate{{KPID: 3, Names: []string{"Dune"}, Year: 1984}, {KPID: 4, Names: []string{"Dune: Part Two"}, Year: 2021}}); ok {
		t.Fatal("must miss")
	}
	// TMDB id needs an explicit, matching kind (movie and tv ids collide).
	show := Target{Kind: "series", TMDBID: 1396}
	if _, ok := Pick(show, []Candidate{{KPID: 5, TMDBID: 1396}}); ok {
		t.Fatal("tmdb without kind must miss")
	}
	if id, ok := Pick(show, []Candidate{{KPID: 6, TMDBID: 1396, Series: no}, {KPID: 5, TMDBID: 1396, Series: yes}}); !ok || id != 5 {
		t.Fatalf("tmdb: %d %v", id, ok)
	}
	if normalize("Spider-Man: No Way Home") != normalize("spider man no way home") || normalize("Ёлки") != normalize("елки") {
		t.Fatal("normalize")
	}
}

type memBudget struct{ days map[string]int }

func (m *memBudget) LoadBudget(_ context.Context, day string) (int, error) { return m.days[day], nil }
func (m *memBudget) SaveBudget(_ context.Context, day string, used int) error {
	m.days[day] = used
	return nil
}

func TestBudget(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 28, 20, 0, 0, 0, time.UTC) // 23:00 MSK
	store := &memBudget{days: map[string]int{"2026-10-28": 1}}
	b := NewBudget(3, store, func() time.Time { return now })
	if b.Remaining(ctx, High) != 2 { // loaded from the store (survives restarts)
		t.Fatal(b.Remaining(ctx, High))
	}
	if !b.Take(ctx, High) || !b.Take(ctx, High) || b.Take(ctx, High) {
		t.Fatal("limit")
	}
	if store.days["2026-10-28"] != 3 {
		t.Fatalf("persisted %v", store.days)
	}
	now = now.Add(90 * time.Minute) // 00:30 MSK next day: a new budget
	if b.Remaining(ctx, High) != 3 || !b.Take(ctx, High) {
		t.Fatal("rollover")
	}
	b.Exhaust(ctx)
	if b.Remaining(ctx, High) != 0 || b.Take(ctx, High) || store.days["2026-10-29"] != 3 {
		t.Fatalf("exhaust %v", store.days)
	}
}

// Low priority (lists, background) stops at 80% of the daily budget; the
// rest is kept for titles a user opens. The production 450 → 360 + 90.
func TestBudgetReservation(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	store := &memBudget{days: map[string]int{}}
	b := NewBudget(10, store, func() time.Time { return now })
	if b.Remaining(ctx, Low) != 8 || b.Remaining(ctx, High) != 10 {
		t.Fatalf("low %d high %d", b.Remaining(ctx, Low), b.Remaining(ctx, High))
	}
	low := 0
	for b.Take(ctx, Low) {
		low++
	}
	if low != 8 || b.Remaining(ctx, Low) != 0 || b.Remaining(ctx, High) != 2 {
		t.Fatalf("low took %d, remaining low %d high %d", low, b.Remaining(ctx, Low), b.Remaining(ctx, High))
	}
	if !b.Take(ctx, High) || !b.Take(ctx, High) || b.Take(ctx, High) || b.Take(ctx, Low) {
		t.Fatal("high must use the reserve, then stop")
	}
	// High work spent first eats into the shared pool: low still stops at 8.
	b2 := NewBudget(450, &memBudget{days: map[string]int{"2026-10-28": 355}}, func() time.Time { return now })
	if b2.Remaining(ctx, Low) != 5 || b2.Remaining(ctx, High) != 95 {
		t.Fatalf("450: low %d high %d", b2.Remaining(ctx, Low), b2.Remaining(ctx, High))
	}
}

func TestQueuePriority(t *testing.T) {
	q := newQueue(3)
	q.Push("a", Low)
	q.Push("b", Low)
	if q.Push("a", Low) {
		t.Fatal("dedupe")
	}
	q.Push("c", High)
	q.Push("b", High) // upgrade
	if q.Push("d", Low) {
		t.Fatal("full: low must be dropped")
	}
	if !q.Push("e", High) {
		t.Fatal("high is always accepted")
	}
	var got []string
	for {
		id, _, ok := q.TryPop()
		if !ok {
			break
		}
		got = append(got, id)
	}
	if strings.Join(got, ",") != "c,b,e,a" {
		t.Fatalf("order %v", got)
	}
	q.Push("x", Low)
	q.Push("y", High)
	q.DropLow()
	if id, _, _ := q.TryPop(); id != "y" || q.Len() != 0 {
		t.Fatalf("droplow %q %d", id, q.Len())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, _, ok := q.Pop(ctx); ok {
		t.Fatal("empty pop must block until ctx ends")
	}
}
