package segments

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestTheIntroDB(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		switch {
		case r.URL.Path != "/v2/media":
			http.NotFound(w, r)
		case q.Get("tmdb_id") == "1396" && q.Get("season") == "1" && q.Get("episode") == "1":
			_, _ = w.Write([]byte(`{"tmdb_id":1396,"type":"tv","season":1,"episode":1,"intro":[{"start_ms":228647,"end_ms":246339}],"recap":[{"start_ms":0,"end_ms":0}],"credits":[{"start_ms":3433269,"end_ms":null}]}`))
		case q.Get("tmdb_id") == "603" && q.Get("season") == "":
			_, _ = w.Write([]byte(`{"tmdb_id":603,"type":"movie","intro":[{"start_ms":null,"end_ms":40000}]}`))
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":"media not found","code":"episode_not_found"}`))
		}
	}))
	defer srv.Close()
	p := TheIntroDB{Base: srv.URL, HTTP: srv.Client()}
	ctx := context.Background()

	got, err := p.Fetch(ctx, Query{TMDBID: 1396, Season: 1, Episode: 1})
	if err != nil || len(got) != 2 {
		t.Fatalf("episode: %v %+v", err, got)
	}
	if got[0].Kind != Opening || got[0].Start != 228.647 || got[0].End != 246.339 {
		t.Fatalf("intro: %+v", got[0])
	}
	// The {0,0} recap is "none"; the credits run to the end (End 0).
	if got[1].Kind != Ending || got[1].Start != 3433.269 || got[1].End != 0 {
		t.Fatalf("credits: %+v", got[1])
	}
	got, err = p.Fetch(ctx, Query{Movie: true, TMDBID: 603})
	if err != nil || len(got) != 1 || got[0].Start != 0 || got[0].End != 40 {
		t.Fatalf("movie: %v %+v", err, got)
	}
	if _, err := p.Fetch(ctx, Query{TMDBID: 1396, Season: 9, Episode: 1}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
}

func TestIntroDB(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("imdb_id") != "tt0944947" {
			_, _ = w.Write([]byte(`{"intro":null,"recap":null,"outro":null}`))
			return
		}
		_, _ = w.Write([]byte(`{"imdb_id":"tt0944947","intro":{"start_ms":6000,"end_ms":105000},"recap":null,"outro":{"start_ms":3252000,"end_ms":3320000}}`))
	}))
	defer srv.Close()
	p := IntroDB{Base: srv.URL, HTTP: srv.Client()}
	got, err := p.Fetch(context.Background(), Query{IMDbID: "tt0944947", Season: 1, Episode: 2})
	if err != nil || len(got) != 2 || got[0].Kind != Opening || got[0].End != 105 || got[1].Kind != Ending || got[1].Start != 3252 {
		t.Fatalf("got %v %+v", err, got)
	}
	if _, err := p.Fetch(context.Background(), Query{IMDbID: "tt1111111", Season: 1, Episode: 1}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty: %v", err)
	}
	// Films and bad ids never reach the server.
	if _, err := p.Fetch(context.Background(), Query{Movie: true, IMDbID: "tt0944947"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("movie: %v", err)
	}
}

type fakeProvider struct {
	name  string
	segs  []Segment
	err   error
	calls atomic.Int32
	delay time.Duration
}

func (f *fakeProvider) Name() string { return f.name }
func (f *fakeProvider) Fetch(ctx context.Context, q Query) ([]Segment, error) {
	f.calls.Add(1)
	if f.delay > 0 {
		time.Sleep(f.delay)
	}
	return f.segs, f.err
}

func TestLookupMergesAndCaches(t *testing.T) {
	a := &fakeProvider{name: "a", segs: []Segment{{Kind: Opening, Start: 10, End: 60, Source: "a"}}}
	b := &fakeProvider{name: "b", segs: []Segment{{Kind: Opening, Start: 11, End: 61, Source: "b"}, {Kind: Ending, Start: 2000, Source: "b"}}}
	s := New(nil, nil, a, b)
	q := Query{TMDBID: 1, Season: 1, Episode: 1}
	got := s.Lookup(context.Background(), q)
	if len(got) != 2 || got[0].Source != "a" || got[1].Kind != Ending || got[1].Source != "b" {
		t.Fatalf("merge: %+v", got)
	}
	s.Lookup(context.Background(), q)
	if a.calls.Load() != 1 || b.calls.Load() != 1 {
		t.Fatalf("not cached: %d %d", a.calls.Load(), b.calls.Load())
	}
	// Expired → asked again.
	s.now = func() time.Time { return time.Now().Add(foundTTL + time.Minute) }
	s.Lookup(context.Background(), q)
	if a.calls.Load() != 2 {
		t.Fatalf("expired entry reused")
	}
}

func TestLookupFailureShortTTL(t *testing.T) {
	a := &fakeProvider{name: "a", err: errors.New("boom")}
	s := New(nil, nil, a)
	q := Query{TMDBID: 2}
	if got := s.Lookup(context.Background(), q); got != nil {
		t.Fatalf("got %+v", got)
	}
	s.now = func() time.Time { return time.Now().Add(failedTTL + time.Minute) }
	s.Lookup(context.Background(), q)
	if a.calls.Load() != 2 {
		t.Fatalf("failure cached too long")
	}
}

func TestLookupWaitsOnlyUntilDeadline(t *testing.T) {
	a := &fakeProvider{name: "a", segs: []Segment{{Kind: Opening, Start: 0, End: 30}}, delay: 300 * time.Millisecond}
	s := New(nil, nil, a)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if got := s.Lookup(ctx, Query{TMDBID: 3}); got != nil {
		t.Fatalf("should give up: %+v", got)
	}
	// The fetch finishes in the background and lands in the cache.
	time.Sleep(400 * time.Millisecond)
	if got := s.Lookup(context.Background(), Query{TMDBID: 3}); len(got) != 1 || a.calls.Load() != 1 {
		t.Fatalf("background fetch not cached: %+v (%d calls)", got, a.calls.Load())
	}
}

func TestFromChapters(t *testing.T) {
	got := FromChapters([]Chapter{
		{0, 30, "Previously on"},
		{30, 95, "Opening"},
		{95, 1300, "Chapter 3"},
		{1300, 1380, "Ending"},
		{1380, 1410, "Preview"},
	})
	if len(got) != 3 || got[0].Kind != Recap || got[1].Kind != Opening || got[1].End != 95 {
		t.Fatalf("got %+v", got)
	}
	if got[2].Kind != Ending || got[2].Start != 1300 || got[2].End != 1410 {
		t.Fatalf("ending + preview not joined: %+v", got[2])
	}
	if ru := FromChapters([]Chapter{{0, 90, "Заставка"}, {2500, 2600, "Титры"}}); len(ru) != 2 || ru[0].Kind != Opening || ru[1].Kind != Ending {
		t.Fatalf("ru: %+v", ru)
	}
	if none := FromChapters([]Chapter{{0, 600, "Chapter 1"}, {600, 1200, "Глава 2"}}); len(none) != 0 {
		t.Fatalf("plain chapters: %+v", none)
	}
}

func TestFit(t *testing.T) {
	segs := []Segment{{Kind: Opening, Start: 10, End: 70}, {Kind: Ending, Start: 2500}, {Kind: Recap, Start: 4000, End: 4100}}
	got := Fit(segs, 2600)
	if len(got) != 2 || got[1].End != 2600 {
		t.Fatalf("fit: %+v", got)
	}
	// Unknown length: open ends stay open, nothing dropped.
	if got := Fit(segs, 0); len(got) != 3 || got[1].End != 0 {
		t.Fatalf("unknown length: %+v", got)
	}
}

func TestMergeDropsJunk(t *testing.T) {
	got := Merge([]Segment{{Kind: Opening, Start: 5, End: 6}, {Kind: "weird", Start: 0, End: 50}, {Kind: Ending, Start: -1, End: 9}})
	if len(got) != 0 {
		t.Fatalf("junk kept: %+v", got)
	}
}
