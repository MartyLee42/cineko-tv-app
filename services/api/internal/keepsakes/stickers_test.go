package keepsakes

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// ---- builders ----

type opt func(c *Completion)

func manual(c *Completion) { c.Manual = true }
func year(y int) opt       { return func(c *Completion) { c.Released = date(y) } }
func released(s string) opt {
	return func(c *Completion) { t, _ := time.Parse(time.DateOnly, s); c.Released = &t }
}
func genres(ids ...int) opt        { return func(c *Completion) { c.Genres = ids } }
func lang(l string) opt            { return func(c *Completion) { c.Lang = l } }
func countries(cs ...string) opt   { return func(c *Completion) { c.Countries = cs } }
func runtime(m int) opt            { return func(c *Completion) { c.Runtime = m } }
func votes(avg float64, n int) opt { return func(c *Completion) { c.Vote, c.Votes = avg, n } }
func oscar(c *Completion)          { c.Oscar = true }
func aired(s string) opt           { return func(c *Completion) { c.AirDate = s } }
func status(s string, total int) opt {
	return func(c *Completion) { c.Status, c.TotalEpisodes = s, total }
}
func media(id string) opt { return func(c *Completion) { c.MediaID = id } }
func with(c Completion, o ...opt) Completion { // apply options to a copy
	for _, f := range o {
		f(&c)
	}
	return c
}

func film(id, when string, o ...opt) Completion {
	return with(Completion{MediaID: id, Kind: "movie", At: at(when)}, o...)
}

// episode of series show: SxEy.
func episode(show string, s, e int, when string, o ...opt) Completion {
	return with(Completion{MediaID: show, Kind: "series", EpisodeID: fmt.Sprintf("%s-s%de%d", show, s, e), Season: s, EpisodeNumber: e, At: at(when)}, o...)
}

// films: n films, one a day from start (yyyy-mm-dd) at 20:00.
func films(n int, start string, o ...opt) []Completion {
	d, _ := time.ParseInLocation(time.DateOnly, start, moscow)
	out := make([]Completion, n)
	for i := range out {
		out[i] = film(fmt.Sprintf("f%04d", i), d.AddDate(0, 0, i).Format(time.DateOnly)+" 20:00", o...)
	}
	return out
}

func cs(c ...Completion) History { return History{Completions: c} }

// plus: base and more in a new slice (cases share their base slices).
func plus(base []Completion, more ...Completion) []Completion { return join(base, more) }

func join(parts ...[]Completion) []Completion {
	var out []Completion
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

type stickerCase struct {
	name  string
	id    string
	h     History
	ok    bool
	media string // "" = don't check
	when  string // "" = don't check
	loc   *time.Location
}

func runCases(t *testing.T, cases []stickerCase) {
	t.Helper()
	for _, tc := range cases {
		loc := tc.loc
		if loc == nil {
			loc = moscow
		}
		u, ok := evalOne(t, tc.id, tc.h, loc)
		if ok != tc.ok {
			t.Errorf("%s / %s: got %v, want %v (%+v)", tc.id, tc.name, ok, tc.ok, u)
			continue
		}
		if ok && tc.media != "" && u.MediaID != tc.media {
			t.Errorf("%s / %s: media %q, want %q", tc.id, tc.name, u.MediaID, tc.media)
		}
		if ok && tc.when != "" && !u.At.Equal(at(tc.when)) {
			t.Errorf("%s / %s: at %v, want %s", tc.id, tc.name, u.At.In(moscow), tc.when)
		}
	}
}

// ---- how much ----

func TestCounterStickers(t *testing.T) {
	ten := films(10, "2026-01-01")
	ten[3].Manual = true // «Просмотрено» counts for how many
	fiveHundred := films(500, "2024-01-01")
	var eps []Completion
	for i := 1; i <= 10; i++ {
		eps = append(eps, episode("show", 1, i, fmt.Sprintf("2026-02-%02d 20:00", i)))
	}
	var longEps []Completion
	for i := 1; i <= 99; i++ {
		longEps = append(longEps, episode("long", 1+i/20, i, "2026-03-01 10:00"))
	}
	runCases(t, []stickerCase{
		{"one manual film", "films_1", cs(film("m", "2026-01-01 03:00", manual)), true, "m", "2026-01-01 03:00", nil},
		{"an episode is not a film", "films_1", cs(episode("show", 1, 1, "2026-01-01 20:00")), false, "", "", nil},
		{"nine films", "films_10", cs(ten[:9]...), false, "", "", nil},
		{"the tenth", "films_10", cs(ten...), true, "f0009", "2026-01-10 20:00", nil},
		{"499", "films_500", cs(fiveHundred[:499]...), false, "", "", nil},
		{"500", "films_500", cs(fiveHundred...), true, "f0499", "", nil},
		{"9 episodes", "episodes_10", cs(eps[:9]...), false, "", "", nil},
		{"10 episodes", "episodes_10", cs(eps...), true, "show", "2026-02-10 20:00", nil},
		{"films are not episodes", "episodes_10", cs(ten...), false, "", "", nil},
		{"99 of one show", "long_series", cs(join(longEps, []Completion{episode("other", 1, 1, "2026-03-02 10:00")})...), false, "", "", nil},
		{"100 of one show", "long_series", cs(join(longEps, []Completion{episode("long", 9, 1, "2026-03-02 10:00")})...), true, "long", "2026-03-02 10:00", nil},
	})
}

func TestSeriesDone(t *testing.T) {
	ended := status("Ended", 3)
	all := []Completion{
		episode("a", 1, 1, "2026-01-01 20:00", ended),
		episode("a", 1, 2, "2026-01-02 20:00", ended, manual),
		episode("a", 2, 1, "2026-01-03 20:00", ended),
	}
	running := []Completion{
		episode("b", 1, 1, "2026-01-01 20:00", status("Returning Series", 2)),
		episode("b", 1, 2, "2026-01-02 20:00", status("Returning Series", 2)),
	}
	special := []Completion{
		episode("c", 0, 1, "2026-01-01 20:00", status("Canceled", 2)),
		episode("c", 1, 1, "2026-01-02 20:00", status("Canceled", 2)),
	}
	runCases(t, []stickerCase{
		{"every episode (one by hand)", "series_done_1", cs(all...), true, "a", "2026-01-03 20:00", nil},
		{"one missing", "series_done_1", cs(all[:2]...), false, "", "", nil},
		{"still running", "series_done_1", cs(running...), false, "", "", nil},
		{"specials don't count", "series_done_1", cs(special...), false, "", "", nil},
		{"canceled counts", "series_done_1", cs(plus(special, episode("c", 1, 2, "2026-01-05 20:00", status("Canceled", 2)))...), true, "c", "", nil},
		{"unknown count", "series_done_1", cs(episode("d", 1, 1, "2026-01-01 20:00", status("Ended", 0))), false, "", "", nil},
	})
}

func TestHoursInTheHall(t *testing.T) {
	sixteen := films(16, "2026-01-01", runtime(90)) // 24 h
	runCases(t, []stickerCase{
		{"24 h", "hours_24", cs(sixteen...), true, "f0015", "2026-01-16 20:00", nil},
		{"22.5 h", "hours_24", cs(sixteen[:15]...), false, "", "", nil},
		{"unknown runtimes", "hours_24", cs(films(40, "2026-01-01")...), false, "", "", nil},
		{"episodes count too", "hours_24", cs(join(sixteen[:15], []Completion{episode("s", 1, 1, "2026-03-01 20:00", runtime(90))})...), true, "s", "", nil},
	})
}

// ---- when ----

func TestTimeOfDay(t *testing.T) {
	one := func(when string, o ...opt) History { return cs(film("m", when, o...)) }
	runCases(t, []stickerCase{
		{"05:00", "early_bird", one("2026-11-07 05:00"), true, "m", "", nil},
		{"04:59 is the night", "early_bird", one("2026-11-07 04:59"), false, "", "", nil},
		{"09:00", "early_bird", one("2026-11-07 09:00"), false, "", "", nil},
		{"by hand", "early_bird", one("2026-11-07 06:00", manual), false, "", "", nil},
		{"06:00 Moscow = 03:00 UTC", "early_bird", one("2026-11-07 06:00"), false, "", "", time.UTC},
		{"Wednesday 12:30", "lunch_break", one("2026-11-04 12:30"), true, "", "", nil},
		{"Saturday 12:30", "lunch_break", one("2026-11-07 12:30"), false, "", "", nil},
		{"Wednesday 14:00", "lunch_break", one("2026-11-04 14:00"), false, "", "", nil},
	})
}

func TestAllWeek(t *testing.T) {
	week := films(6, "2026-11-02") // Mon … Sat
	runCases(t, []stickerCase{
		{"Mon-Sat", "all_week", cs(week...), false, "", "", nil},
		{"Sunday", "all_week", cs(plus(week, film("sun", "2026-11-08 20:00"))...), true, "sun", "", nil},
		// Monday 01:00 still belongs to Sunday evening.
		{"Monday night is Sunday", "all_week", cs(plus(week, film("late", "2026-11-09 01:00"))...), true, "late", "", nil},
		{"Monday 07:00 is Monday", "all_week", cs(plus(week, film("mon", "2026-11-09 07:00"))...), false, "", "", nil},
		{"Sunday by hand", "all_week", cs(plus(week, film("sun", "2026-11-08 20:00", manual))...), false, "", "", nil},
	})
}

func TestStreaks(t *testing.T) {
	six := films(6, "2026-11-01")
	gap := append(films(3, "2026-11-01"), films(4, "2026-11-05")...)
	runCases(t, []stickerCase{
		{"six days", "streak_7", cs(six...), false, "", "", nil},
		{"seven days", "streak_7", cs(films(7, "2026-11-01")...), true, "f0006", "2026-11-07 20:00", nil},
		{"a gap", "streak_7", cs(gap...), false, "", "", nil},
		{"a night counts for the evening before", "streak_7", cs(plus(six, film("late", "2026-11-08 01:30"))...), true, "late", "", nil},
		{"by hand", "streak_7", cs(plus(six, film("m", "2026-11-07 20:00", manual))...), false, "", "", nil},
		{"thirty days", "streak_30", cs(films(30, "2026-01-01")...), true, "", "2026-01-30 20:00", nil},
		{"29 days", "streak_30", cs(films(29, "2026-01-01")...), false, "", "", nil},
	})
}

func TestDates(t *testing.T) {
	one := func(when string, o ...opt) History { return cs(film("m", when, o...)) }
	comedy, horror := genres(35), genres(27)
	runCases(t, []stickerCase{
		{"31 Dec 23:30", "new_year", one("2026-12-31 23:30"), true, "", "", nil},
		{"1 Jan 05:59", "new_year", one("2027-01-01 05:59"), true, "", "", nil},
		{"31 Dec 17:00", "new_year", one("2026-12-31 17:00"), false, "", "", nil},
		{"1 Jan 06:00", "new_year", one("2027-01-01 06:00"), false, "", "", nil},
		{"by hand", "new_year", one("2026-12-31 23:30", manual), false, "", "", nil},
		// 31 Dec 18:30 Moscow is 15:30 UTC.
		{"UTC afternoon", "new_year", one("2026-12-31 18:30"), false, "", "", time.UTC},
		{"14 Feb", "valentine", one("2027-02-14 20:00"), true, "", "", nil},
		{"15 Feb 01:00", "valentine", one("2027-02-15 01:00"), false, "", "", nil},
		{"comedy on 1 Apr", "april_fools", one("2027-04-01 20:00", comedy), true, "", "", nil},
		{"drama on 1 Apr", "april_fools", one("2027-04-01 20:00", genres(18)), false, "", "", nil},
		{"horror on 31 Oct", "halloween", one("2026-10-31 23:00", horror), true, "", "", nil},
		{"horror on 1 Nov", "halloween", one("2026-11-01 00:30", horror), false, "", "", nil},
		{"Friday 13 Nov 2026", "friday_13", one("2026-11-13 21:00"), true, "", "", nil},
		{"Sunday 13 Dec 2026", "friday_13", one("2026-12-13 21:00"), false, "", "", nil},
		{"29 Feb 2028", "leap_day", one("2028-02-29 20:00"), true, "", "", nil},
		{"1 Mar 2027", "leap_day", one("2027-03-01 20:00"), false, "", "", nil},
		{"28 Dec", "cinema_day", one("2026-12-28 20:00"), true, "", "", nil},
		{"28 Dec by hand", "cinema_day", one("2026-12-28 20:00", manual), false, "", "", nil},
	})
}

func TestSessions(t *testing.T) {
	fest := []Completion{
		film("a", "2026-11-06 19:00"), film("b", "2026-11-07 15:00"),
		film("c", "2026-11-07 21:00"), film("d", "2026-11-08 20:00"),
	}
	var binge []Completion
	for i := 0; i < 8; i++ { // 20:00 … 03:00
		binge = append(binge, episode("s", 1, i+1, at("2026-11-07 20:00").Add(time.Duration(i)*time.Hour).In(moscow).Format("2006-01-02 15:04")))
	}
	nine := func(step time.Duration) []Completion {
		var out []Completion
		for i := 0; i < 9; i++ {
			out = append(out, film(fmt.Sprint("n", i), at("2026-11-01 20:00").Add(time.Duration(i)*step).In(moscow).Format("2006-01-02 15:04")))
		}
		return out
	}
	runCases(t, []stickerCase{
		{"four films one weekend", "weekend_fest", cs(fest...), true, "d", "2026-11-08 20:00", nil},
		{"the fourth on Monday morning", "weekend_fest", cs(join(fest[:3], []Completion{film("d", "2026-11-09 07:00")})...), false, "", "", nil},
		{"one by hand", "weekend_fest", cs(join(fest[:3], []Completion{film("d", "2026-11-08 20:00", manual)})...), false, "", "", nil},
		{"8 episodes past midnight", "binge_day", cs(binge...), true, "s", "2026-11-08 03:00", nil},
		{"7 episodes", "binge_day", cs(binge[:7]...), false, "", "", nil},
		{"evening pair", "double_feature", cs(film("a", "2026-11-07 18:00"), film("b", "2026-11-07 21:30")), true, "b", "", nil},
		{"across midnight", "double_feature", cs(film("a", "2026-11-07 23:00"), film("b", "2026-11-08 01:30")), true, "b", "", nil},
		{"morning + evening", "double_feature", cs(film("a", "2026-11-07 10:00"), film("b", "2026-11-07 21:30")), false, "", "", nil},
		{"two evenings", "double_feature", cs(film("a", "2026-11-07 21:00"), film("b", "2026-11-08 21:00")), false, "", "", nil},
		{"an episode is not a feature", "double_feature", cs(film("a", "2026-11-07 18:00"), episode("s", 1, 1, "2026-11-07 21:30")), false, "", "", nil},
		{"three", "triple_feature", cs(film("a", "2026-11-07 17:30"), film("b", "2026-11-07 20:00"), film("c", "2026-11-08 00:10")), true, "c", "", nil},
		{"two", "triple_feature", cs(film("a", "2026-11-07 17:30"), film("b", "2026-11-07 20:00")), false, "", "", nil},
		{"nine in six days", "nine_lives", cs(nine(16 * time.Hour)...), true, "n8", "", nil},
		{"nine in eight days", "nine_lives", cs(nine(24 * time.Hour)...), false, "", "", nil},
	})
}

// ---- what ----

func TestDecades(t *testing.T) {
	var every []Completion
	for i, y := range []int{1925, 1931, 1942, 1950, 1969, 1977, 1985, 1994, 2001, 2016, 2023} {
		every = append(every, film(fmt.Sprint("d", y), fmt.Sprintf("2026-01-%02d 20:00", i+1), year(y), manual))
	}
	runCases(t, []stickerCase{
		{"1950", "decade_1950s", cs(film("m", "2026-01-01 20:00", year(1950))), true, "m", "", nil},
		{"1960", "decade_1950s", cs(film("m", "2026-01-01 20:00", year(1960))), false, "", "", nil},
		{"a series", "decade_1950s", cs(episode("s", 1, 1, "2026-01-01 20:00", year(1955))), false, "", "", nil},
		{"no date", "decade_1950s", cs(film("m", "2026-01-01 20:00")), false, "", "", nil},
		{"2020s", "decade_2020s", cs(film("m", "2026-01-01 20:00", year(2026))), true, "", "", nil},
		{"every decade", "time_machine", cs(every...), true, "d2023", "2026-01-11 20:00", nil},
		{"one missing", "time_machine", cs(every[1:]...), false, "", "", nil},
		{"1910s don't count", "time_machine", cs(plus(every[1:], film("old", "2026-02-01 20:00", year(1915)))...), false, "", "", nil},
		{"1926", "silent", cs(film("m", "2026-01-01 20:00", year(1926))), true, "", "", nil},
		{"1927", "silent", cs(film("m", "2026-01-01 20:00", year(1927))), false, "", "", nil},
	})
}

func TestGenres(t *testing.T) {
	horror := func(n int) []Completion {
		var out []Completion
		for i := 0; i < n; i++ {
			out = append(out, film(fmt.Sprint("h", i), fmt.Sprintf("2026-01-%02d 20:00", i+1), genres(27, 53)))
		}
		return out
	}
	// A series counts once, however many episodes.
	show := []Completion{episode("s", 1, 1, "2026-02-01 20:00", genres(27)), episode("s", 1, 2, "2026-02-02 20:00", genres(27))}
	var mix []Completion
	for i, g := range []int{27, 35, 16, 99, 10765, 37, 10402, 10752, 10749, 80, 9648} { // 10765: sci-fi and fantasy
		mix = append(mix, film(fmt.Sprint("g", g), fmt.Sprintf("2026-03-%02d 20:00", i+1), genres(g)))
	}
	runCases(t, []stickerCase{
		{"five horror films", "genre_horror", cs(horror(5)...), true, "h4", "", nil},
		{"four films + a series", "genre_horror", cs(plus(horror(4), show...)...), true, "s", "2026-02-01 20:00", nil},
		{"three films + a series", "genre_horror", cs(plus(horror(3), show...)...), false, "", "", nil},
		{"tv sci-fi & fantasy", "genre_scifi", cs(join(
			[]Completion{episode("a", 1, 1, "2026-01-01 20:00", genres(10765))},
			films(4, "2026-01-02", genres(878)))...), true, "", "", nil},
		{"12 genres", "genre_mix", cs(mix...), true, "g9648", "", nil},
		{"11 genres", "genre_mix", cs(mix[:10]...), false, "", "", nil},
		{"unknown genre ids", "genre_mix", cs(film("x", "2026-01-01 20:00", genres(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13))), false, "", "", nil},
	})
}

func TestLanguagesAndCountries(t *testing.T) {
	var langs []Completion
	for i, l := range []string{"en", "ru", "fr", "de", "it", "es", "ja", "ko", "zh", "hi"} {
		langs = append(langs, film("l"+l, fmt.Sprintf("2026-01-%02d 20:00", i+1), lang(l)))
	}
	var world []Completion
	for i, c := range []string{"US", "RU", "FR", "DE", "IT", "ES", "JP", "KR"} {
		world = append(world, film("c"+c, fmt.Sprintf("2026-01-%02d 20:00", i+1), countries(c)))
	}
	runCases(t, []stickerCase{
		{"ten languages", "polyglot_10", cs(langs...), true, "lhi", "", nil},
		{"nine", "polyglot_10", cs(langs[:9]...), false, "", "", nil},
		{"a k-drama episode", "lang_korean", cs(episode("k", 1, 1, "2026-01-01 20:00", lang("ko"), manual)), true, "k", "", nil},
		{"Indian by country", "lang_indian", cs(film("m", "2026-01-01 20:00", lang("en"), countries("GB", "IN"))), true, "", "", nil},
		{"Tamil", "lang_indian", cs(film("m", "2026-01-01 20:00", lang("ta"))), true, "", "", nil},
		{"Cantonese", "lang_chinese", cs(film("m", "2026-01-01 20:00", lang("cn"))), true, "", "", nil},
		{"Japanese live action", "anime", cs(film("m", "2026-01-01 20:00", lang("ja"), genres(18))), false, "", "", nil},
		{"anime", "anime", cs(film("m", "2026-01-01 20:00", lang("ja"), genres(16))), true, "", "", nil},
		{"Soviet", "soviet", cs(film("m", "2026-01-01 20:00", countries("SU"))), true, "", "", nil},
		{"Russian is not Soviet", "soviet", cs(film("m", "2026-01-01 20:00", countries("RU"))), false, "", "", nil},
		{"8 countries", "world_10", cs(world...), false, "", "", nil},
		{"a co-production brings two", "world_10", cs(plus(world, film("co", "2026-02-01 20:00", countries("CN", "HK")))...), true, "co", "", nil},
	})
}

func TestTheFilmItself(t *testing.T) {
	one := func(o ...opt) History { return cs(film("m", "2026-11-07 20:00", o...)) }
	runCases(t, []stickerCase{
		{"180 min", "epic", one(runtime(180)), true, "", "", nil},
		{"179 min", "epic", one(runtime(179)), false, "", "", nil},
		{"39 min", "short", one(runtime(39)), true, "", "", nil},
		{"40 min", "short", one(runtime(40)), false, "", "", nil},
		{"unknown", "short", one(), false, "", "", nil},
		{"an episode", "short", cs(episode("s", 1, 1, "2026-01-01 20:00", runtime(20))), false, "", "", nil},
		{"8.4 / 1000", "masterpiece", one(votes(8.4, 1000)), true, "", "", nil},
		{"8.4 / 999", "masterpiece", one(votes(8.4, 999)), false, "", "", nil},
		{"4.4 / 100", "cult_trash", one(votes(4.4, 100)), true, "", "", nil},
		{"unrated", "cult_trash", one(votes(0, 500)), false, "", "", nil},
		{"7.8 / 120", "hidden_gem", one(votes(7.8, 120)), true, "", "", nil},
		{"7.8 / 3000", "hidden_gem", one(votes(7.8, 3000)), false, "", "", nil},
		{"Oscar", "oscar", one(oscar, manual), true, "", "", nil},
		{"no Oscar", "oscar", one(), false, "", "", nil},
	})
}

func TestFreshness(t *testing.T) {
	rel := released("2026-11-01")
	runCases(t, []stickerCase{
		{"14 days after", "premiere", cs(film("m", "2026-11-15 23:00", rel)), true, "", "", nil},
		{"15 days after", "premiere", cs(film("m", "2026-11-16 10:00", rel)), false, "", "", nil},
		{"before release", "premiere", cs(film("m", "2026-10-31 20:00", rel)), false, "", "", nil},
		{"by hand", "premiere", cs(film("m", "2026-11-02 20:00", rel, manual)), false, "", "", nil},
		{"air day", "fresh_episode", cs(episode("s", 1, 1, "2026-11-06 22:00", aired("2026-11-06"))), true, "", "", nil},
		{"the day after", "fresh_episode", cs(episode("s", 1, 1, "2026-11-07 22:00", aired("2026-11-06"))), true, "", "", nil},
		{"two days after", "fresh_episode", cs(episode("s", 1, 1, "2026-11-08 00:30", aired("2026-11-06"))), false, "", "", nil},
		// 00:30 on the 8th in Moscow is still the 7th in UTC.
		{"two days after (UTC: one)", "fresh_episode", cs(episode("s", 1, 1, "2026-11-08 00:30", aired("2026-11-06"))), true, "", "", time.UTC},
		{"no air date", "fresh_episode", cs(episode("s", 1, 1, "2026-11-06 22:00")), false, "", "", nil},
	})
}

func TestPilots(t *testing.T) {
	var pilots []Completion
	for i := 0; i < 10; i++ {
		pilots = append(pilots, episode(fmt.Sprint("show", i), 1, 1, fmt.Sprintf("2026-01-%02d 20:00", i+1)))
	}
	second := append(append([]Completion{}, pilots[:9]...), episode("show9", 1, 2, "2026-02-01 20:00"))
	runCases(t, []stickerCase{
		{"ten pilots", "pilots_10", cs(pilots...), true, "show9", "", nil},
		{"nine pilots + a second episode", "pilots_10", cs(second...), false, "", "", nil},
	})
}

func TestRewatch(t *testing.T) {
	first := film("m", "2026-11-01 20:00", manual)
	h := func(r ...Rewatch) History { return History{Completions: []Completion{first}, Rewatches: r} }
	rw := func(when string) Rewatch { return Rewatch{MediaID: "m", At: at(when)} }
	runCases(t, []stickerCase{
		{"another day", "rewatch", h(rw("2026-11-05 21:00")), true, "m", "2026-11-05 21:00", nil},
		{"same day", "rewatch", h(rw("2026-11-01 23:00")), false, "", "", nil},
		{"that night", "rewatch", h(rw("2026-11-02 02:00")), false, "", "", nil},
		{"not finished before", "rewatch", History{Rewatches: []Rewatch{rw("2026-11-05 21:00")}}, false, "", "", nil},
		{"two more days", "rewatch_3", h(rw("2026-11-05 21:00"), rw("2026-11-05 23:00"), rw("2026-12-01 20:00")), true, "", "2026-12-01 20:00", nil},
		{"one more day, twice", "rewatch_3", h(rw("2026-11-05 21:00"), rw("2026-11-05 23:00")), false, "", "", nil},
	})
}

func TestRatings(t *testing.T) {
	var r []Rating
	for i := 0; i < 10; i++ {
		v := 7
		if i == 4 {
			v = 10
		}
		c := at(fmt.Sprintf("2026-01-%02d 20:00", i+1))
		r = append(r, Rating{MediaID: fmt.Sprint("r", i), Value: v, Created: c, Updated: c.Add(time.Hour)})
	}
	runCases(t, []stickerCase{
		{"ten", "rated_10", History{Ratings: r}, true, "r9", "2026-01-10 20:00", nil},
		{"nine", "rated_10", History{Ratings: r[:9]}, false, "", "", nil},
		{"a ten", "perfect_10", History{Ratings: r}, true, "r4", "2026-01-05 21:00", nil},
		{"no ones", "harsh_1", History{Ratings: r}, false, "", "", nil},
		{"a one", "harsh_1", History{Ratings: append(r, Rating{MediaID: "bad", Value: 1, Created: at("2026-02-01 20:00"), Updated: at("2026-02-01 20:00")})}, true, "bad", "", nil},
	})
}

func TestCollector(t *testing.T) {
	// From history: films_1, decade_2020s, lang_french (1 Jan), all_week and
	// streak_7 (7 Jan), films_10 (10 Jan).
	h := cs(films(10, "2026-01-01", year(2024), lang("fr"))...)
	got := map[string]bool{}
	for _, u := range Evaluate(h, moscow) {
		got[u.ID] = true
	}
	n := len(got)
	if n >= 10 || got["collector_10"] {
		t.Fatalf("setup: %d stickers %v", n, got)
	}
	// Stored stickers count even when their history is gone (and unknown ids don't).
	h.Earned = map[string]time.Time{"retired_one": at("2025-01-01 10:00")}
	ids := []string{"night_owl", "marathon", "oscar", "epic", "short", "silent", "premiere", "anime", "soviet", "rewatch"}
	for i := 0; i < 10-n; i++ {
		h.Earned[ids[i]] = at(fmt.Sprintf("2025-06-%02d 10:00", i+1))
	}
	u, ok := evalOne(t, "collector_10", h, moscow)
	if !ok || u.MediaID != "" || !u.At.Equal(at("2026-01-10 20:00")) {
		t.Fatalf("collector_10 %+v %v", u, ok)
	}
	// An earlier stored time wins over the history's: films_10 no longer comes last.
	h.Earned["films_10"] = at("2025-01-02 10:00")
	if u, _ := evalOne(t, "collector_10", h, moscow); !u.At.Equal(at("2026-01-07 20:00")) {
		t.Fatalf("collector_10 with a stored films_10: %v", u.At.In(moscow))
	}
	if _, ok := evalOne(t, "collector_25", h, moscow); ok {
		t.Fatal("collector_25")
	}
}

func TestProgress(t *testing.T) {
	progress := func(h History) map[string]Progress {
		_, next := Assess(h, moscow)
		out := map[string]Progress{}
		for _, p := range next {
			out[p.ID] = p
		}
		return out
	}
	if p := progress(History{}); len(p) != 0 {
		t.Fatalf("empty history: %v", p)
	}
	h := cs(films(37, "2026-01-01", lang("en"), genres(27))...)
	p := progress(h)
	if p["films_50"] != (Progress{ID: "films_50", Have: 37, Need: 50}) {
		t.Fatalf("films %v", p)
	}
	if _, ok := p["films_100"]; ok {
		t.Fatal("only the next goal of a ladder")
	}
	if p[Polyglot] != (Progress{ID: Polyglot, Have: 1, Need: 5}) {
		t.Fatalf("polyglot %v", p)
	}
	if _, ok := p["genre_horror"]; ok {
		t.Fatal("genre stickers stay secret")
	}
	if _, ok := p["episodes_10"]; ok {
		t.Fatal("nothing counts towards episodes yet")
	}
	// films_50 stored earlier, history now shorter: the next goal is films_100.
	h.Earned = map[string]time.Time{"films_50": at("2025-01-01 10:00")}
	if p := progress(h); p["films_100"].Have != 37 || p["films_50"].Need != 0 {
		t.Fatalf("after a stored tier %v", p)
	}
}

func TestEveryRuleIsUniqueAndValid(t *testing.T) {
	re := regexp.MustCompile(`^[a-z][a-z0-9_]{1,40}$`) // profile_achievements CHECK
	seen := map[string]bool{}
	last := map[string]int{}
	for _, r := range Rules {
		if !re.MatchString(r.ID) || seen[r.ID] {
			t.Fatalf("bad or duplicate id %q", r.ID)
		}
		seen[r.ID] = true
		if r.Ladder != "" {
			if _, ok := ladders[r.Ladder]; !ok || r.Goal <= 0 || r.Goal <= last[r.Ladder] {
				t.Fatalf("%s: ladder %q goal %d", r.ID, r.Ladder, r.Goal)
			}
			last[r.Ladder] = r.Goal
		} else if r.eval == nil {
			t.Fatalf("%s: no rule", r.ID)
		}
	}
	if len(Rules) < 75 {
		t.Fatalf("only %d stickers", len(Rules))
	}
	// The first four never move (stored, and the original art).
	for i, id := range []string{Marathon, Archaeologist, Polyglot, NightOwl} {
		if Rules[i].ID != id {
			t.Fatalf("rule %d is %s", i, Rules[i].ID)
		}
	}
}

// The clients draw and name every sticker (packages/ui/src/keepsakes/stickers.ts).
func TestClientsKnowEverySticker(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/ui/src/keepsakes/stickers.ts")
	if err != nil {
		t.Skip("no client checkout:", err)
	}
	src := string(raw)
	for _, r := range Rules {
		if !strings.Contains(src, "\n  "+r.ID+": ") {
			t.Errorf("stickers.ts has no art for %s", r.ID)
		}
	}
}

func TestAssessIsFast(t *testing.T) {
	var c []Completion
	start := at("2020-01-01 20:00")
	for i := 0; i < 3000; i++ {
		c = append(c, Completion{MediaID: fmt.Sprint("f", i), Kind: "movie", At: start.Add(time.Duration(i) * 7 * time.Hour),
			Lang: []string{"en", "fr", "ja"}[i%3], Genres: []int{27, 35, 18}, Countries: []string{"US"}, Runtime: 100, Released: date(1930 + i%90)})
	}
	for i := 0; i < 3000; i++ {
		c = append(c, Completion{MediaID: fmt.Sprint("s", i%40), Kind: "series", EpisodeID: fmt.Sprint("e", i), Season: 1 + i%5, EpisodeNumber: i,
			At: start.Add(time.Duration(i)*5*time.Hour + time.Minute), Runtime: 45, Status: "Ended", TotalEpisodes: 75})
	}
	t0 := time.Now()
	u, _ := Assess(History{Completions: c, Seasons: map[SeasonKey][]Episode{}}, moscow)
	if d := time.Since(t0); d > 2*time.Second {
		t.Fatalf("Assess took %v", d)
	}
	if len(u) < 40 {
		t.Fatalf("only %d unlocked", len(u))
	}
}
