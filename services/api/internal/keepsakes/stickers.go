package keepsakes

import (
	"sort"
	"strconv"
	"time"
)

// Achievement ids (the clients' sticker art and strings are keyed by them).
const (
	Marathon      = "marathon"
	Archaeologist = "archaeologist"
	Polyglot      = "polyglot"
	NightOwl      = "night_owl"
)

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

// Genre keys: TMDB movie and tv genre ids folded together.
var genreKeys = map[int][]string{
	27: {"horror"}, 35: {"comedy"}, 16: {"animation"}, 99: {"documentary"},
	878: {"scifi"}, 10765: {"scifi", "fantasy"}, 37: {"western"}, 10402: {"music"},
	10752: {"war"}, 10768: {"war"}, 10749: {"romance"}, 80: {"crime"}, 9648: {"mystery"},
	14: {"fantasy"}, 36: {"history"}, 10751: {"family"}, 10762: {"family"}, 53: {"thriller"},
	28: {"action"}, 10759: {"action", "adventure"}, 12: {"adventure"}, 18: {"drama"},
}

// genreRules: «genre_<key>» stickers and how many titles of the genre each needs.
var genreRules = []struct {
	key  string
	goal int
}{
	{"horror", 5}, {"comedy", 10}, {"animation", 10}, {"documentary", 5}, {"scifi", 5},
	{"western", 3}, {"music", 3}, {"war", 3}, {"romance", 5}, {"crime", 10}, {"mystery", 5},
	{"fantasy", 5}, {"history", 3}, {"family", 10}, {"thriller", 5}, {"action", 10},
	{"adventure", 5}, {"drama", 25},
}

// Decades with a sticker each («decade_1920s» … «decade_2020s»).
const firstDecade, lastDecade = 1920, 2020

// Rules lists every achievement, in display order. Ids are stored: never
// rename them; tiers of a ladder go from the smallest goal up.
var Rules = buildRules()

func buildRules() []Rule {
	ladder := func(id, name string, goal int, progress bool) Rule {
		return Rule{ID: id, Ladder: name, Goal: goal, Progress: progress}
	}
	one := func(id string, eval func(f *facts) (Unlock, bool)) Rule { return Rule{ID: id, eval: eval} }
	r := []Rule{
		one(Marathon, marathon),
		one(Archaeologist, archaeologist),
		ladder(Polyglot, "lang", PolyglotLanguages, true),
		one(NightOwl, nightOwl),

		// How much: films, episodes, whole series, hours in the hall.
		ladder("films_1", "films", 1, true),
		ladder("films_10", "films", 10, true),
		ladder("films_50", "films", 50, true),
		ladder("films_100", "films", 100, true),
		ladder("films_250", "films", 250, true),
		ladder("films_500", "films", 500, true),
		ladder("episodes_10", "episodes", 10, true),
		ladder("episodes_100", "episodes", 100, true),
		ladder("episodes_500", "episodes", 500, true),
		ladder("episodes_1000", "episodes", 1000, true),
		ladder("series_done_1", "series_done", 1, true),
		ladder("series_done_5", "series_done", 5, true),
		ladder("series_done_20", "series_done", 20, true),
		ladder("hours_24", "hours", 24, true),
		ladder("hours_100", "hours", 100, true),
		ladder("hours_500", "hours", 500, true),

		// When (playback only).
		one("early_bird", hours(5, 9)),
		one("lunch_break", lunchBreak),
		one("all_week", allWeek),
		ladder("streak_7", "streak", 7, true),
		ladder("streak_30", "streak", 30, true),
		one("new_year", newYear),
		one("valentine", onDate(time.February, 14, nil)),
		one("april_fools", onDate(time.April, 1, hasGenre("comedy"))),
		one("halloween", onDate(time.October, 31, hasGenre("horror"))),
		one("friday_13", friday13),
		one("leap_day", onDate(time.February, 29, nil)),
		one("cinema_day", onDate(time.December, 28, nil)),
		one("weekend_fest", weekendFest),
		one("binge_day", bingeDay),
		one("double_feature", feature(2)),
		one("triple_feature", feature(3)),
		one("nine_lives", nineLives),
	}

	// What: decades, the silent era.
	for y := firstDecade; y <= lastDecade; y += 10 {
		r = append(r, one(decadeID(y), decade(y)))
	}
	r = append(r,
		ladder("time_machine", "decades", (lastDecade-firstDecade)/10+1, true),
		one("silent", filmWhere(func(c *Completion) bool { return c.Released != nil && c.Released.Year() < 1927 })),
	)

	// Genres.
	for _, g := range genreRules {
		r = append(r, ladder("genre_"+g.key, "genre:"+g.key, g.goal, false))
	}
	r = append(r, ladder("genre_mix", "genres", 12, true))

	// Languages and countries.
	r = append(r,
		ladder("polyglot_10", "lang", 10, true),
		ladder("polyglot_20", "lang", 20, true),
		one("lang_korean", titleWhere(langIn("ko"))),
		one("lang_japanese", titleWhere(langIn("ja"))),
		one("lang_indian", titleWhere(indian)),
		one("lang_french", titleWhere(langIn("fr"))),
		one("lang_italian", titleWhere(langIn("it"))),
		one("lang_spanish", titleWhere(langIn("es"))),
		one("lang_chinese", titleWhere(langIn("zh", "cn"))),
		one("soviet", titleWhere(func(c *Completion) bool { return hasCountry(c, "SU") })),
		one("anime", titleWhere(func(c *Completion) bool { return c.Lang == "ja" && genreOf(c, "animation") })),
		ladder("world_10", "countries", 10, true),
		ladder("world_25", "countries", 25, true),

		// The film itself.
		one("epic", filmWhere(func(c *Completion) bool { return c.Runtime >= 180 })),
		one("short", filmWhere(func(c *Completion) bool { return c.Runtime > 0 && c.Runtime < 40 })),
		one("premiere", premiere),
		one("fresh_episode", freshEpisode),
		one("masterpiece", filmWhere(func(c *Completion) bool { return c.Votes >= 1000 && c.Vote >= 8.4 })),
		one("cult_trash", filmWhere(func(c *Completion) bool { return c.Votes >= 100 && c.Vote > 0 && c.Vote < 4.5 })),
		one("hidden_gem", filmWhere(func(c *Completion) bool { return c.Votes >= 20 && c.Votes < 300 && c.Vote >= 7.5 })),
		one("oscar", filmWhere(func(c *Completion) bool { return c.Oscar })),
		one("long_series", longSeries),
		ladder("pilots_10", "pilots", 10, false),
		one("rewatch", rewatch(1)),
		one("rewatch_3", rewatch(2)),

		// The profile's own ratings.
		ladder("rated_10", "rated", 10, true),
		ladder("rated_50", "rated", 50, true),
		one("perfect_10", gaveRating(10)),
		one("harsh_1", gaveRating(1)),

		// Stickers collected (counts every other sticker, stored ones too).
		ladder("collector_10", "collector", 10, true),
		ladder("collector_25", "collector", 25, true),
		ladder("collector_50", "collector", 50, true),
	)
	return r
}

func decadeID(y int) string { return "decade_" + strconv.Itoa(y) + "s" }

// ladders builds each ladder from the facts (set in init: some read Rules).
var ladders map[string]func(f *facts) []Unlock

func init() {
	ladders = map[string]func(f *facts) []Unlock{
		"films": func(f *facts) []Unlock {
			return f.distinct(false, func(c *Completion, add func(string)) {
				if c.film() {
					add(c.MediaID)
				}
			})
		},
		"episodes": func(f *facts) []Unlock {
			return f.distinct(false, func(c *Completion, add func(string)) {
				if c.episode() {
					add(c.MediaID + "/" + c.EpisodeID)
				}
			})
		},
		"series_done": seriesDone,
		"hours":       hoursLadder,
		"streak":      streak,
		"lang": func(f *facts) []Unlock {
			return f.distinct(false, func(c *Completion, add func(string)) {
				if c.Lang != "xx" {
					add(c.Lang)
				}
			})
		},
		"countries": func(f *facts) []Unlock {
			return f.distinct(false, func(c *Completion, add func(string)) {
				for _, k := range c.Countries {
					add(k)
				}
			})
		},
		"decades": func(f *facts) []Unlock {
			return f.distinct(false, func(c *Completion, add func(string)) {
				if y, ok := filmYear(c); ok && y >= firstDecade && y < lastDecade+10 {
					add(strconv.Itoa(y / 10))
				}
			})
		},
		"genres": func(f *facts) []Unlock {
			return f.distinct(false, func(c *Completion, add func(string)) {
				for _, id := range c.Genres {
					for _, k := range genreKeys[id] {
						add(k)
					}
				}
			})
		},
		"pilots": func(f *facts) []Unlock {
			return f.distinct(false, func(c *Completion, add func(string)) {
				if c.episode() && c.Season == 1 && c.EpisodeNumber == 1 {
					add(c.MediaID)
				}
			})
		},
		"rated":     rated,
		"collector": collected,
	}
	for _, g := range genreRules {
		key := g.key
		ladders["genre:"+key] = func(f *facts) []Unlock {
			return f.distinct(false, func(c *Completion, add func(string)) {
				if genreOf(c, key) {
					add(c.MediaID)
				}
			})
		}
	}
}

// ---- predicates ----

func genreOf(c *Completion, key string) bool {
	for _, id := range c.Genres {
		for _, k := range genreKeys[id] {
			if k == key {
				return true
			}
		}
	}
	return false
}

func hasGenre(key string) func(c *Completion) bool {
	return func(c *Completion) bool { return genreOf(c, key) }
}

func hasCountry(c *Completion, code string) bool {
	for _, k := range c.Countries {
		if k == code {
			return true
		}
	}
	return false
}

func langIn(langs ...string) func(c *Completion) bool {
	return func(c *Completion) bool {
		for _, l := range langs {
			if c.Lang == l {
				return true
			}
		}
		return false
	}
}

var indianLangs = langIn("hi", "ta", "te", "ml", "kn", "bn", "mr", "pa")

func indian(c *Completion) bool { return indianLangs(c) || hasCountry(c, "IN") }

func filmYear(c *Completion) (int, bool) {
	if !c.film() || c.Released == nil {
		return 0, false
	}
	return c.Released.Year(), true
}

// filmWhere: a finished film that passes ok (manual counts).
func filmWhere(ok func(c *Completion) bool) func(f *facts) (Unlock, bool) {
	return func(f *facts) (Unlock, bool) {
		return f.first(false, func(_ int, c *Completion) bool { return c.film() && ok(c) })
	}
}

// titleWhere: a finished film, or any finished episode of a series, that passes ok.
func titleWhere(ok func(c *Completion) bool) func(f *facts) (Unlock, bool) {
	return func(f *facts) (Unlock, bool) {
		return f.first(false, func(_ int, c *Completion) bool { return ok(c) })
	}
}

// ---- the original four ----

// «Марафонец»: every aired episode of one season (at least
// MarathonMinEpisodes) finished, by playback, within one weekend window.
func marathon(f *facts) (Unlock, bool) {
	type group struct {
		monday string
		eps    map[string]bool
		last   time.Time
	}
	bySeason := map[SeasonKey]map[string]*group{}
	for _, c := range f.c {
		if c.EpisodeID == "" || c.Manual || c.Season <= 0 {
			continue
		}
		fri, mon, ok := WeekendOf(c.At, f.loc)
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
			for _, e := range f.h.Seasons[k] {
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
func archaeologist(f *facts) (Unlock, bool) {
	return filmWhere(func(c *Completion) bool { return c.Released != nil && c.Released.Year() < ArchaeologistBefore })(f)
}

// «Ночная сова»: something finished, by playback, between 02:00 and 05:00 local time.
func nightOwl(f *facts) (Unlock, bool) { return hours(NightOwlFrom, NightOwlTo)(f) }

// ---- ladders ----

// «Финальные титры»: every episode of an ended series (TMDB's episode count,
// specials aside) finished; a step per series, when its last one was.
func seriesDone(f *facts) []Unlock {
	n := map[string]int{}
	seen := map[string]bool{}
	var out []Unlock
	for i := range f.c {
		c := &f.c[i]
		if !c.episode() || c.Season <= 0 || c.TotalEpisodes <= 0 || (c.Status != "Ended" && c.Status != "Canceled") {
			continue
		}
		if k := c.MediaID + "/" + c.EpisodeID; !seen[k] {
			seen[k] = true
			n[c.MediaID]++
			if n[c.MediaID] == c.TotalEpisodes {
				out = append(out, Unlock{At: c.At, MediaID: c.MediaID})
			}
		}
	}
	return out
}

// Hours in the hall: a step per full hour of runtime finished (films and episodes).
func hoursLadder(f *facts) []Unlock {
	mins := 0
	var out []Unlock
	for i := range f.c {
		c := &f.c[i]
		if c.Runtime <= 0 {
			continue
		}
		mins += c.Runtime
		for len(out) < mins/60 {
			out = append(out, Unlock{At: c.At, MediaID: c.MediaID})
		}
	}
	return out
}

// Streak: step k = the first time k watch days in a row had a playback finish.
func streak(f *facts) []Unlock {
	var out []Unlock
	var last int64
	run := 0
	for i := range f.c {
		c := &f.c[i]
		if c.Manual {
			continue
		}
		d := f.day[i]
		if run > 0 && d == last {
			continue
		}
		if run > 0 && d == last+1 {
			run++
		} else {
			run = 1
		}
		last = d
		if run > len(out) {
			out = append(out, Unlock{At: c.At, MediaID: c.MediaID})
		}
	}
	return out
}

// Ratings given, in the order they were first given.
func rated(f *facts) []Unlock {
	list := append([]Rating(nil), f.h.Ratings...)
	sort.Slice(list, func(i, j int) bool {
		if !list[i].Created.Equal(list[j].Created) {
			return list[i].Created.Before(list[j].Created)
		}
		return list[i].MediaID < list[j].MediaID
	})
	out := make([]Unlock, 0, len(list))
	for _, r := range list {
		out = append(out, Unlock{At: r.Created, MediaID: r.MediaID})
	}
	return out
}

// Every other sticker, earned now or stored before, by when it was earned.
func collected(f *facts) []Unlock {
	var out []Unlock
	for _, r := range Rules {
		if r.Ladder == "collector" {
			continue
		}
		var at time.Time
		if u, ok := f.result(r); ok {
			at = u.At
		}
		if t, ok := f.h.Earned[r.ID]; ok && (at.IsZero() || t.Before(at)) {
			at = t
		}
		if !at.IsZero() {
			out = append(out, Unlock{At: at})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out
}

// ---- when ----

// hours: something finished, by playback, in [from, to) local time.
func hours(from, to int) func(f *facts) (Unlock, bool) {
	return func(f *facts) (Unlock, bool) {
		return f.first(true, func(i int, _ *Completion) bool {
			h := f.local[i].Hour()
			return h >= from && h < to
		})
	}
}

// «Обеденный перерыв»: finished on a weekday between 12:00 and 14:00.
func lunchBreak(f *facts) (Unlock, bool) {
	return f.first(true, func(i int, _ *Completion) bool {
		l := f.local[i]
		return l.Weekday() >= time.Monday && l.Weekday() <= time.Friday && l.Hour() >= 12 && l.Hour() < 14
	})
}

// «Семь дней кино»: playback finishes on every day of the week (watch days).
func allWeek(f *facts) (Unlock, bool) {
	mask := 0
	return f.first(true, func(i int, _ *Completion) bool {
		mask |= 1 << uint(time.Unix(f.day[i]*86400, 0).UTC().Weekday())
		return mask == 1<<7-1
	})
}

// «Новогодний сеанс»: finished between 31 Dec 18:00 and 1 Jan 06:00.
func newYear(f *facts) (Unlock, bool) {
	return f.first(true, func(i int, _ *Completion) bool {
		l := f.local[i]
		return (l.Month() == time.December && l.Day() == 31 && l.Hour() >= 18) || (l.Month() == time.January && l.Day() == 1 && l.Hour() < 6)
	})
}

// onDate: finished, by playback, on a calendar date (and passing ok, if set).
func onDate(m time.Month, d int, ok func(c *Completion) bool) func(f *facts) (Unlock, bool) {
	return func(f *facts) (Unlock, bool) {
		return f.first(true, func(i int, c *Completion) bool {
			l := f.local[i]
			return l.Month() == m && l.Day() == d && (ok == nil || ok(c))
		})
	}
}

func friday13(f *facts) (Unlock, bool) {
	return f.first(true, func(i int, _ *Completion) bool { return f.local[i].Day() == 13 && f.local[i].Weekday() == time.Friday })
}

// «Кинофестиваль выходного дня»: 4 films finished in one weekend window.
func weekendFest(f *facts) (Unlock, bool) {
	return f.within(4, func(_ int, c *Completion) (int64, bool) {
		if !c.film() {
			return 0, false
		}
		fri, _, ok := WeekendOf(c.At, f.loc)
		if !ok {
			return 0, false
		}
		t, _ := time.Parse(time.DateOnly, fri)
		return dayIndex(t), true
	})
}

// «Ещё одну — и спать»: 8 episodes finished in one watch day.
func bingeDay(f *facts) (Unlock, bool) {
	return f.within(8, func(i int, c *Completion) (int64, bool) { return f.day[i], c.episode() })
}

// Double / triple feature: n films finished in one evening (17:00 – 06:00).
func feature(n int) func(f *facts) (Unlock, bool) {
	return func(f *facts) (Unlock, bool) {
		return f.within(n, func(i int, c *Completion) (int64, bool) {
			h := f.local[i].Hour()
			return f.day[i], c.film() && (h >= 17 || h < 6)
		})
	}
}

// «Девять жизней»: 9 films finished, by playback, within 7 days.
func nineLives(f *facts) (Unlock, bool) {
	var films []*Completion
	for i := range f.c {
		if c := &f.c[i]; c.film() && !c.Manual {
			films = append(films, c)
			if n := len(films); n >= 9 && c.At.Sub(films[n-9].At) < 7*24*time.Hour {
				return Unlock{At: c.At, MediaID: c.MediaID}, true
			}
		}
	}
	return Unlock{}, false
}

// ---- what ----

func decade(y int) func(f *facts) (Unlock, bool) {
	return filmWhere(func(c *Completion) bool {
		r, ok := filmYear(c)
		return ok && r >= y && r < y+10
	})
}

// «Премьера»: a film finished, by playback, within 14 days of its release.
func premiere(f *facts) (Unlock, bool) {
	return f.first(true, func(i int, c *Completion) bool {
		if !c.film() || c.Released == nil {
			return false
		}
		d := dayIndex(f.local[i]) - dayIndex(*c.Released)
		return d >= 0 && d <= 14
	})
}

// «С пылу с жару»: an episode finished, by playback, on its air date or the day after.
func freshEpisode(f *facts) (Unlock, bool) {
	return f.first(true, func(i int, c *Completion) bool {
		if !c.episode() || c.AirDate == "" {
			return false
		}
		air, err := time.Parse(time.DateOnly, c.AirDate)
		if err != nil {
			return false
		}
		d := dayIndex(f.local[i]) - dayIndex(air)
		return d >= 0 && d <= 1
	})
}

// LongSeriesEpisodes: «Долгожитель» — this many episodes of one series.
const LongSeriesEpisodes = 100

func longSeries(f *facts) (Unlock, bool) {
	n := map[string]int{}
	return f.first(false, func(_ int, c *Completion) bool {
		if !c.episode() {
			return false
		}
		n[c.MediaID]++
		return n[c.MediaID] == LongSeriesEpisodes
	})
}

// rewatch: a film already finished, played to the end again on n other days
// (watch days, not the day it was first finished).
func rewatch(n int) func(f *facts) (Unlock, bool) {
	return func(f *facts) (Unlock, bool) {
		firstDay := map[string]int64{}
		for i := range f.c {
			if c := &f.c[i]; c.film() {
				if _, ok := firstDay[c.MediaID]; !ok {
					firstDay[c.MediaID] = f.day[i]
				}
			}
		}
		list := append([]Rewatch(nil), f.h.Rewatches...)
		sort.Slice(list, func(i, j int) bool {
			if !list[i].At.Equal(list[j].At) {
				return list[i].At.Before(list[j].At)
			}
			return list[i].MediaID < list[j].MediaID
		})
		days := map[string]map[int64]bool{}
		for _, r := range list {
			first, ok := firstDay[r.MediaID]
			d := watchDay(r.At, f.loc)
			if !ok || d == first {
				continue
			}
			if days[r.MediaID] == nil {
				days[r.MediaID] = map[int64]bool{}
			}
			days[r.MediaID][d] = true
			if len(days[r.MediaID]) == n {
				return Unlock{At: r.At, MediaID: r.MediaID}, true
			}
		}
		return Unlock{}, false
	}
}

// gaveRating: the profile rated something exactly v (when it was last set).
func gaveRating(v int) func(f *facts) (Unlock, bool) {
	return func(f *facts) (Unlock, bool) {
		var best Unlock
		for _, r := range f.h.Ratings {
			if r.Value == v {
				earliest(&best, Unlock{At: r.Updated, MediaID: r.MediaID})
			}
		}
		return best, !best.At.IsZero()
	}
}
