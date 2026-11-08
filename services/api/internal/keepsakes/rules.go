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
	MediaID   string
	Kind      string // movie | series
	EpisodeID string
	Season    int
	At        time.Time
	Manual    bool
	Lang      string     // TMDB original language
	Released  *time.Time // release / first air date (a date at 00:00 UTC)
}

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

// History is everything the rules look at for one profile.
type History struct {
	Completions []Completion
	// Seasons: the episodes of every (non-special) season with a completion.
	Seasons map[SeasonKey][]Episode
}

// Unlock is an earned sticker: when the history first satisfied the rule,
// and the title that did it.
type Unlock struct {
	ID      string
	At      time.Time
	MediaID string
}

// Rule is one achievement. Eval is pure and deterministic.
type Rule struct {
	ID   string
	Eval func(h History, loc *time.Location) (Unlock, bool)
}

// Achievement ids (the clients' sticker art is keyed by them).
const (
	Marathon      = "marathon"
	Archaeologist = "archaeologist"
	Polyglot      = "polyglot"
	NightOwl      = "night_owl"
)

// Rules lists every achievement, in display order. Add new ones at the end;
// ids are stored, never rename them.
var Rules = []Rule{
	{ID: Marathon, Eval: marathon},
	{ID: Archaeologist, Eval: archaeologist},
	{ID: Polyglot, Eval: polyglot},
	{ID: NightOwl, Eval: nightOwl},
}

const (
	// MarathonMinEpisodes: a season this short is an evening, not a marathon.
	MarathonMinEpisodes = 3
	// ArchaeologistBefore: «Киноархеолог» — a film released before this year.
	ArchaeologistBefore = 1960
	// PolyglotLanguages: «Полиглот» — finished titles in this many original languages.
	PolyglotLanguages = 5
	// NightOwlFrom/To: «Ночная сова» — finished between 02:00 and 05:00 local time.
	NightOwlFrom, NightOwlTo = 2, 5
)

// Evaluate runs every rule.
func Evaluate(h History, loc *time.Location) []Unlock {
	var out []Unlock
	for _, r := range Rules {
		if u, ok := r.Eval(h, loc); ok {
			u.ID = r.ID
			out = append(out, u)
		}
	}
	return out
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

// «Марафонец»: every aired episode of one season (at least
// MarathonMinEpisodes) finished, by playback, within one weekend window.
func marathon(h History, loc *time.Location) (Unlock, bool) {
	type group struct {
		monday string
		eps    map[string]bool
		last   time.Time
	}
	bySeason := map[SeasonKey]map[string]*group{}
	for _, c := range h.Completions {
		if c.EpisodeID == "" || c.Manual || c.Season <= 0 {
			continue
		}
		fri, mon, ok := WeekendOf(c.At, loc)
		if !ok {
			continue
		}
		k := SeasonKey{c.MediaID, c.Season}
		if bySeason[k] == nil {
			bySeason[k] = map[string]*group{}
		}
		g := bySeason[k][fri]
		if g == nil {
			g = &group{monday: mon, eps: map[string]bool{}}
			bySeason[k][fri] = g
		}
		g.eps[c.EpisodeID] = true
		if c.At.After(g.last) {
			g.last = c.At
		}
	}
	var best Unlock
	for k, weekends := range bySeason {
		for _, g := range weekends {
			aired := 0
			all := true
			for _, e := range h.Seasons[k] {
				if e.AirDate == "" || e.AirDate > g.monday {
					continue // not out yet that weekend
				}
				aired++
				if !g.eps[e.ID] {
					all = false
				}
			}
			if all && aired >= MarathonMinEpisodes {
				earliest(&best, Unlock{At: g.last, MediaID: k.MediaID})
			}
		}
	}
	return best, !best.At.IsZero()
}

// «Киноархеолог»: a film released before ArchaeologistBefore finished.
func archaeologist(h History, _ *time.Location) (Unlock, bool) {
	var best Unlock
	for _, c := range h.Completions {
		if c.Kind == "movie" && c.EpisodeID == "" && c.Released != nil && c.Released.Year() < ArchaeologistBefore {
			earliest(&best, Unlock{At: c.At, MediaID: c.MediaID})
		}
	}
	return best, !best.At.IsZero()
}

// «Полиглот»: finished titles (a film, or any episode of a series) in
// PolyglotLanguages different original languages; unlocked by the title
// that brought the last one.
func polyglot(h History, _ *time.Location) (Unlock, bool) {
	first := map[string]Unlock{} // language → its first finished title
	for _, c := range h.Completions {
		if c.Lang == "" || c.Lang == "xx" {
			continue
		}
		u := Unlock{At: c.At, MediaID: c.MediaID}
		cur, ok := first[c.Lang]
		if !ok {
			first[c.Lang] = u
			continue
		}
		earliest(&cur, u)
		first[c.Lang] = cur
	}
	if len(first) < PolyglotLanguages {
		return Unlock{}, false
	}
	list := make([]Unlock, 0, len(first))
	for _, u := range first {
		list = append(list, u)
	}
	sort.Slice(list, func(i, j int) bool {
		if !list[i].At.Equal(list[j].At) {
			return list[i].At.Before(list[j].At)
		}
		return list[i].MediaID < list[j].MediaID
	})
	return list[PolyglotLanguages-1], true
}

// «Ночная сова»: something finished, by playback, between 02:00 and 05:00 local time.
func nightOwl(h History, loc *time.Location) (Unlock, bool) {
	var best Unlock
	for _, c := range h.Completions {
		if c.Manual {
			continue
		}
		if hr := c.At.In(loc).Hour(); hr >= NightOwlFrom && hr < NightOwlTo {
			earliest(&best, Unlock{At: c.At, MediaID: c.MediaID})
		}
	}
	return best, !best.At.IsZero()
}
