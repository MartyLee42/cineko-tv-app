// Package keepsakes is the collectable side of watch history: a paper ticket
// stub per finished film and silent achievement stickers. Both are derived
// from watch_progress (no hooks in the playback path): GET calls issue the
// missing stubs and record newly earned stickers, then read them.
package keepsakes

import (
	"crypto/sha256"
	"encoding/binary"
	"sort"
	"time"
)

// ---- seats ----

// Seat is a stub's place in the (imaginary) hall. It is a hash of the
// profile and the title, so the same film always has the same seat.
type Seat struct{ Hall, Row, Seat int }

const (
	halls        = 9
	rows         = 20
	seatsPerRow  = 30
	seatHashSalt = "martytv/keepsakes/seat/v1"
)

func SeatFor(profileID, mediaID string) Seat {
	h := sha256.Sum256([]byte(seatHashSalt + "|" + profileID + "|" + mediaID))
	return Seat{
		Hall: 1 + int(binary.BigEndian.Uint32(h[0:4])%halls),
		Row:  1 + int(binary.BigEndian.Uint32(h[4:8])%rows),
		Seat: 1 + int(binary.BigEndian.Uint32(h[8:12])%seatsPerRow),
	}
}

// ---- history facts ----

// Completion is one finished item: a film (EpisodeID == "") or an episode.
// Titles marked watched by hand or imported are Manual: they count for what
// was watched, never for when (no stickers for the time of a button press).
type Completion struct {
	MediaID       string
	Kind          string // movie | series
	EpisodeID     string
	Season        int
	EpisodeNumber int
	AirDate       string // the episode's air date (yyyy-mm-dd, "" = unknown)
	At            time.Time
	Manual        bool
	Lang          string     // TMDB original language
	Released      *time.Time // release / first air date (a date at 00:00 UTC)
	// Title facts (the same for every episode of a series).
	Genres        []int    // TMDB genre ids
	Countries     []string // ISO 3166-1 (SU = the Soviet Union)
	Runtime       int      // minutes: the film, or this episode (0 = unknown)
	Vote          float64  // TMDB vote average
	Votes         int      // TMDB vote count
	Oscar         bool     // won an Academy Award
	Status        string   // series: TMDB status (Ended, Canceled, …)
	TotalEpisodes int      // series: TMDB number_of_episodes (no specials)
}

func (c *Completion) film() bool    { return c.Kind == "movie" && c.EpisodeID == "" }
func (c *Completion) episode() bool { return c.EpisodeID != "" }

// SeasonKey names a series season.
type SeasonKey struct {
	MediaID string
	Season  int
}

// Episode is a stored episode of a season (AirDate as a yyyy-mm-dd string, "" = unknown).
type Episode struct {
	ID      string
	AirDate string
}

// Rewatch is a playback that reached the end of a film already finished.
type Rewatch struct {
	MediaID string
	At      time.Time
}

// Rating is the profile's own 1–10 rating of a title.
type Rating struct {
	MediaID          string
	Value            int
	Created, Updated time.Time
}

// History is everything the rules look at for one profile.
type History struct {
	Completions []Completion
	// Seasons: the episodes of every (non-special) season with a completion.
	Seasons   map[SeasonKey][]Episode
	Rewatches []Rewatch
	Ratings   []Rating
	// Earned: stickers already stored (id → unlocked_at); they count for the
	// «collected» stickers even when the history that earned them is gone.
	Earned map[string]time.Time
}

// Unlock is an earned sticker: when the history first satisfied the rule,
// and the title that did it.
type Unlock struct {
	ID      string
	At      time.Time
	MediaID string
}

// Progress is a locked counter sticker on its way: Have of Need.
type Progress struct {
	ID   string
	Have int
	Need int
}

// Rule is one achievement. Evaluation is pure and deterministic.
//
// A counter rule names a Ladder (a time-ordered list of steps: the 1st film
// finished, the 2nd, …) and is earned at its Goal-th step. Progress: while it
// is the lowest locked goal of its ladder, clients see «have / need» instead
// of a secret.
type Rule struct {
	ID       string
	Ladder   string
	Goal     int
	Progress bool
	eval     func(f *facts) (Unlock, bool)
}

// Eval runs one rule on a history.
func (r Rule) Eval(h History, loc *time.Location) (Unlock, bool) {
	return newFacts(h, loc).result(r)
}

// Evaluate runs every rule.
func Evaluate(h History, loc *time.Location) []Unlock {
	u, _ := Assess(h, loc)
	return u
}

// Assess runs every rule and lists the progress of the next locked goal of
// each ladder that shows progress (once something counts towards it).
func Assess(h History, loc *time.Location) ([]Unlock, []Progress) {
	f := newFacts(h, loc)
	var out []Unlock
	got := map[string]bool{}
	for id := range h.Earned {
		got[id] = true
	}
	for _, r := range Rules {
		if u, ok := f.result(r); ok {
			u.ID = r.ID
			out = append(out, u)
			got[r.ID] = true
		}
	}
	var next []Progress
	seen := map[string]bool{}
	for _, r := range Rules {
		if !r.Progress || got[r.ID] || seen[r.Ladder] {
			continue
		}
		seen[r.Ladder] = true
		if have := len(f.ladder(r.Ladder)); have > 0 && have < r.Goal {
			next = append(next, Progress{ID: r.ID, Have: have, Need: r.Goal})
		}
	}
	return out, next
}

// ---- evaluation context ----

// facts is a history prepared once for all rules: completions in time order
// (ties: media, then episode id), their household-clock times and watch
// days, and memoized ladders and results.
type facts struct {
	h       History
	loc     *time.Location
	c       []Completion
	local   []time.Time
	day     []int64
	ladders map[string][]Unlock
	results map[string]*Unlock
}

func newFacts(h History, loc *time.Location) *facts {
	if loc == nil {
		loc = time.UTC
	}
	c := make([]Completion, len(h.Completions))
	copy(c, h.Completions)
	sort.SliceStable(c, func(i, j int) bool {
		a, b := &c[i], &c[j]
		if !a.At.Equal(b.At) {
			return a.At.Before(b.At)
		}
		if a.MediaID != b.MediaID {
			return a.MediaID < b.MediaID
		}
		return a.EpisodeID < b.EpisodeID
	})
	f := &facts{h: h, loc: loc, c: c, local: make([]time.Time, len(c)), day: make([]int64, len(c)),
		ladders: map[string][]Unlock{}, results: map[string]*Unlock{}}
	for i := range c {
		f.local[i] = c[i].At.In(loc)
		f.day[i] = watchDay(c[i].At, loc)
	}
	return f
}

// dayIndex: days since 1970-01-01 of t's calendar date (in t's location).
func dayIndex(t time.Time) int64 {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix() / 86400
}

// WatchDayStart: a day of watching runs 06:00 – 06:00 on the household
// clock (a film finished at 1 am belongs to the evening before).
const WatchDayStart = 6 * time.Hour

func watchDay(t time.Time, loc *time.Location) int64 {
	return dayIndex(t.In(loc).Add(-WatchDayStart))
}

func (f *facts) result(r Rule) (Unlock, bool) {
	if u, ok := f.results[r.ID]; ok {
		if u == nil {
			return Unlock{}, false
		}
		return *u, true
	}
	var u Unlock
	var ok bool
	if r.Ladder != "" {
		if l := f.ladder(r.Ladder); r.Goal > 0 && len(l) >= r.Goal {
			u, ok = l[r.Goal-1], true
		}
	} else {
		u, ok = r.eval(f)
	}
	if ok {
		f.results[r.ID] = &u
	} else {
		f.results[r.ID] = nil
	}
	return u, ok
}

func (f *facts) ladder(name string) []Unlock {
	if l, ok := f.ladders[name]; ok {
		return l
	}
	var l []Unlock
	if build, ok := ladders[name]; ok {
		l = build(f)
	}
	f.ladders[name] = l
	return l
}

// first: the earliest completion that passes ok (playback: manual ones skipped).
func (f *facts) first(playback bool, ok func(i int, c *Completion) bool) (Unlock, bool) {
	for i := range f.c {
		c := &f.c[i]
		if playback && c.Manual {
			continue
		}
		if ok(i, c) {
			return Unlock{At: c.At, MediaID: c.MediaID}, true
		}
	}
	return Unlock{}, false
}

// distinct: a ladder with a step each time a completion brings a new key
// (several new keys at once make several steps; "" is skipped).
func (f *facts) distinct(playback bool, keys func(c *Completion, add func(string))) []Unlock {
	seen := map[string]bool{}
	var out []Unlock
	for i := range f.c {
		c := &f.c[i]
		if playback && c.Manual {
			continue
		}
		keys(c, func(k string) {
			if k != "" && !seen[k] {
				seen[k] = true
				out = append(out, Unlock{At: c.At, MediaID: c.MediaID})
			}
		})
	}
	return out
}

// within: the first playback completion that brings a group to n items
// (key reports the completion's group, or false to skip it).
func (f *facts) within(n int, key func(i int, c *Completion) (int64, bool)) (Unlock, bool) {
	count := map[int64]int{}
	for i := range f.c {
		c := &f.c[i]
		if c.Manual {
			continue
		}
		k, ok := key(i, c)
		if !ok {
			continue
		}
		count[k]++
		if count[k] == n {
			return Unlock{At: c.At, MediaID: c.MediaID}, true
		}
	}
	return Unlock{}, false
}

// earliest keeps the first unlock (ties: the smaller media id, for determinism).
func earliest(best *Unlock, u Unlock) {
	if best.At.IsZero() || u.At.Before(best.At) || (u.At.Equal(best.At) && u.MediaID < best.MediaID) {
		*best = u
	}
}

// WeekendOf returns the Friday (yyyy-mm-dd) of the local weekend window
// Fri 18:00 – Mon 06:00 that contains t, and that window's Monday.
func WeekendOf(t time.Time, loc *time.Location) (friday, monday string, ok bool) {
	l := t.In(loc)
	back := 0
	switch l.Weekday() {
	case time.Friday:
		if l.Hour() < 18 {
			return "", "", false
		}
	case time.Saturday:
		back = 1
	case time.Sunday:
		back = 2
	case time.Monday:
		if l.Hour() >= 6 {
			return "", "", false
		}
		back = 3
	default:
		return "", "", false
	}
	y, m, d := l.Date()
	fri := time.Date(y, m, d-back, 12, 0, 0, 0, loc) // noon: safe from DST edges
	return fri.Format(time.DateOnly), fri.AddDate(0, 0, 3).Format(time.DateOnly), true
}
