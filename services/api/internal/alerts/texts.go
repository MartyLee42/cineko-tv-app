package alerts

import (
	"fmt"
	"strings"
	"time"
)

// Locales of alert texts (the PWA's: ru first).
var Locales = []string{"ru", "en", "kk"}

// NormalizeLocale maps anything else to "ru".
func NormalizeLocale(l string) string {
	l = strings.ToLower(strings.TrimSpace(l))
	if i := strings.IndexAny(l, "-_"); i > 0 {
		l = l[:i]
	}
	switch l {
	case "en", "kk":
		return l
	}
	return "ru"
}

type tr struct{ ru, en, kk string }

func (t tr) in(l string) string {
	switch l {
	case "en":
		return t.en
	case "kk":
		return t.kk
	}
	return t.ru
}

var names = map[string]tr{
	KindTMDB:       {"TMDB", "TMDB", "TMDB"},
	KindProwlarr:   {"Prowlarr", "Prowlarr", "Prowlarr"},
	KindJackett:    {"Jackett", "Jackett", "Jackett"},
	KindTorrServer: {"TorrServer", "TorrServer", "TorrServer"},
	KindInvidious:  {"YouTube", "YouTube", "YouTube"},
	KindYouTube:    {"YouTube", "YouTube", "YouTube"},
	KindProxy:      {"VPN", "VPN", "VPN"},
	KindVPN:        {"VPN", "VPN", "VPN"},
	KindDisk:       {"диск", "disk", "диск"},
	KindDatabase:   {"база данных", "database", "дерекқор"},
	KindUpdater:    {"обновление", "update", "жаңарту"},
}

// problems: what is broken, by kind or kind/cause (most specific first).
var problems = map[string]tr{
	KindTMDB: {"TMDB недоступен — каталог не обновляется",
		"TMDB is unreachable — the catalog isn't updating",
		"TMDB қолжетімсіз — каталог жаңармайды"},
	KindTMDB + "/unauthorized": {"TMDB отклоняет ключ — каталог не обновляется. Проверьте TMDB_ACCESS_TOKEN",
		"TMDB rejects the key — the catalog isn't updating. Check TMDB_ACCESS_TOKEN",
		"TMDB кілтті қабылдамайды — каталог жаңармайды. TMDB_ACCESS_TOKEN тексеріңіз"},
	KindProwlarr: {"Prowlarr не отвечает — поиск торрентов не работает",
		"Prowlarr isn't answering — torrent search doesn't work",
		"Prowlarr жауап бермейді — торрент іздеу жұмыс істемейді"},
	KindJackett: {"Jackett не отвечает — поиск торрентов не работает",
		"Jackett isn't answering — torrent search doesn't work",
		"Jackett жауап бермейді — торрент іздеу жұмыс істемейді"},
	KindTorrServer: {"TorrServer не отвечает — торренты не воспроизводятся",
		"TorrServer isn't answering — torrents don't play",
		"TorrServer жауап бермейді — торренттер ойнатылмайды"},
	KindInvidious: {"YouTube не работает: Invidious не отвечает",
		"YouTube is down: Invidious isn't answering",
		"YouTube жұмыс істемейді: Invidious жауап бермейді"},
	KindYouTube: {"YouTube не работает",
		"YouTube is down",
		"YouTube жұмыс істемейді"},
	KindYouTube + "/search": {"YouTube не работает: поиск не отвечает",
		"YouTube is down: search isn't answering",
		"YouTube жұмыс істемейді: іздеу жауап бермейді"},
	KindYouTube + "/streams": {"YouTube не работает: видео не отдаёт потоки",
		"YouTube is down: videos have no streams",
		"YouTube жұмыс істемейді: бейнелер ағын бермейді"},
	KindVPN: {"VPN недоступен — TMDB и YouTube не открываются",
		"The VPN is down — TMDB and YouTube can't be reached",
		"VPN қолжетімсіз — TMDB мен YouTube ашылмайды"},
	KindProxy: {"VPN недоступен: прокси не принимает соединения",
		"The VPN is down: the proxy refuses connections",
		"VPN қолжетімсіз: прокси қосылымды қабылдамайды"},
	KindDisk: {"Диск почти заполнен",
		"The disk is almost full",
		"Диск толуға жақын"},
	KindDatabase: {"База данных недоступна",
		"The database is down",
		"Дерекқор қолжетімсіз"},
	KindUpdater + "/rollback": {"Обновление откатено: новая версия не воспроизводит видео",
		"Update rolled back: the new version doesn't play videos",
		"Жаңарту кері қайтарылды: жаңа нұсқа бейнені ойнатпайды"},
}

// actions: notes the host scripts attach ("…, не помогло": they are only
// shown while the incident is still open).
var actions = map[string]tr{
	"invidious_restarted": {"Invidious перезапущен, не помогло.", "Invidious was restarted; it didn't help.", "Invidious қайта іске қосылды, көмектеспеді."},
	"companion_restarted": {"Компаньон перезапущен, не помогло.", "The companion was restarted; it didn't help.", "Компаньон қайта іске қосылды, көмектеспеді."},
	"vpn_restarted":       {"VPN перезапущен, не помогло.", "The VPN was restarted; it didn't help.", "VPN қайта іске қосылды, көмектеспеді."},
	"rolled_back":         {"Обновление откатено, не помогло.", "The update was rolled back; it didn't help.", "Жаңарту кері қайтарылды, көмектеспеді."},
}

// ValidAction reports whether a host-reported action is known.
func ValidAction(a string) bool { _, ok := actions[a]; return ok }

// ValidCause reports whether cause is known for a host-reported kind.
func ValidCause(kind, cause string) bool {
	if cause == "" {
		return true
	}
	_, ok := problems[kind+"/"+cause]
	return ok
}

// Text is one localized notice.
type Text struct {
	Title string
	Body  string
}

func problem(kind, cause, l string) string {
	if p, ok := problems[kind+"/"+cause]; ok {
		return p.in(l)
	}
	if p, ok := problems[kind]; ok {
		return p.in(l)
	}
	return kind
}

func name(kind, l string) string {
	if n, ok := names[kind]; ok {
		return n.in(l)
	}
	return kind
}

func capitalize(s string) string {
	r := []rune(s)
	if len(r) == 0 {
		return s
	}
	return strings.ToUpper(string(r[:1])) + string(r[1:])
}

// clock renders when an incident started: "21:30", or "07.11 21:30" on
// another day.
func clock(t, now time.Time, loc *time.Location) string {
	if loc == nil {
		loc = time.UTC
	}
	t, now = t.In(loc), now.In(loc)
	if t.YearDay() == now.YearDay() && t.Year() == now.Year() {
		return t.Format("15:04")
	}
	return t.Format("02.01 15:04")
}

// FormatDuration: "23 мин", "2 ч 5 мин" (at least 1 minute).
func FormatDuration(d time.Duration, l string) string {
	m := int(d.Round(time.Minute) / time.Minute)
	if m < 1 {
		m = 1
	}
	h, mm := m/60, m%60
	hu, mu := "ч", "мин"
	switch l {
	case "en":
		hu, mu = "h", "min"
	case "kk":
		hu, mu = "сағ", "мин"
	}
	switch {
	case h == 0:
		return fmt.Sprintf("%d %s", mm, mu)
	case mm == 0:
		return fmt.Sprintf("%d %s", h, hu)
	}
	return fmt.Sprintf("%d %s %d %s", h, hu, mm, mu)
}

// Render builds the notice for an event in locale l (times in loc).
func Render(e Event, l string, loc *time.Location) Text {
	l = NormalizeLocale(l)
	n := name(e.Kind, l)
	since := clock(e.OpenedAt, e.At, loc)
	var notes []string
	for _, a := range e.Notes {
		if t, ok := actions[a]; ok {
			notes = append(notes, t.in(l))
		}
	}
	detail := ""
	if e.Kind == KindDisk && e.Detail != "" {
		detail = tr{" — свободно ", " — free: ", " — бос орын "}.in(l) + e.Detail
	}
	switch e.Type {
	case EventRecovered:
		title := tr{"Снова работает: " + n, "Working again: " + n, "Қайта жұмыс істейді: " + n}.in(l)
		dur := FormatDuration(e.Duration(), l)
		body := tr{"Снова работает: " + n + " (сбой " + dur + ").",
			"Working again: " + n + " (down for " + dur + ").",
			"Қайта жұмыс істейді: " + n + " (ақау " + dur + ")."}.in(l)
		return Text{Title: title, Body: body}
	case EventReminder:
		title := tr{"Всё ещё сбой: " + n, "Still down: " + n, "Әлі ақау: " + n}.in(l)
		dur := FormatDuration(e.Duration(), l)
		body := problem(e.Kind, e.Cause, l) + detail + " " + tr{"(с " + since + ", уже " + dur + ").",
			"(since " + since + ", " + dur + " so far).", "(" + since + " бастап, " + dur + ")."}.in(l)
		if len(notes) > 0 {
			body += " " + strings.Join(notes, " ")
		}
		return Text{Title: title, Body: body}
	}
	if e.Kind == KindUpdater { // one-off event
		body := problem(e.Kind, e.Cause, l)
		if e.Detail != "" {
			body += " (" + e.Detail + ")"
		}
		return Text{Title: capitalize(n), Body: body + "."}
	}
	title := tr{"Сбой: " + n, "Outage: " + n, "Ақау: " + n}.in(l)
	body := problem(e.Kind, e.Cause, l) + detail + " " + tr{"(с " + since + ").", "(since " + since + ").", "(" + since + " бастап)."}.in(l)
	if len(notes) > 0 {
		body += " " + strings.Join(notes, " ")
	}
	return Text{Title: title, Body: body}
}
