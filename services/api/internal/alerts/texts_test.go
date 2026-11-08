package alerts

import (
	"strings"
	"testing"
	"time"
)

func TestRenderTexts(t *testing.T) {
	opened := fixedNow // 21:30 UTC
	cases := []struct {
		e     Event
		l     string
		title string
		body  string
	}{
		{Event{Type: EventOpened, Kind: KindYouTube, Cause: "streams", Notes: []string{"companion_restarted"}, OpenedAt: opened, At: opened.Add(5 * time.Minute)},
			"ru", "Сбой: YouTube", "YouTube не работает: видео не отдаёт потоки (с 21:30). Компаньон перезапущен, не помогло."},
		{Event{Type: EventOpened, Kind: KindTMDB, OpenedAt: opened, At: opened},
			"ru", "Сбой: TMDB", "TMDB недоступен — каталог не обновляется (с 21:30)."},
		{Event{Type: EventOpened, Kind: KindVPN, OpenedAt: opened, At: opened},
			"en", "Outage: VPN", "The VPN is down — TMDB and YouTube can't be reached (since 21:30)."},
		{Event{Type: EventRecovered, Kind: KindInvidious, OpenedAt: opened, At: opened.Add(23 * time.Minute)},
			"ru", "Снова работает: YouTube", "Снова работает: YouTube (сбой 23 мин)."},
		{Event{Type: EventRecovered, Kind: KindTorrServer, OpenedAt: opened, At: opened.Add(125 * time.Minute)},
			"kk", "Қайта жұмыс істейді: TorrServer", "Қайта жұмыс істейді: TorrServer (ақау 2 сағ 5 мин)."},
		{Event{Type: EventReminder, Kind: KindDisk, Detail: "/ 3.2 GB", OpenedAt: opened, At: opened.Add(6 * time.Hour)},
			"ru", "Всё ещё сбой: диск", "Диск почти заполнен — свободно / 3.2 GB (с 07.11 21:30, уже 6 ч)."},
		{Event{Type: EventOpened, Kind: KindUpdater, Cause: "rollback", Detail: "companion", OpenedAt: opened, At: opened},
			"ru", "Обновление", "Обновление откатено: новая версия не воспроизводит видео (companion)."},
		{Event{Type: EventOpened, Kind: KindTMDB, OpenedAt: opened.Add(-24 * time.Hour), At: opened},
			"ru", "Сбой: TMDB", "TMDB недоступен — каталог не обновляется (с 06.11 21:30)."},
	}
	for _, c := range cases {
		got := Render(c.e, c.l, time.UTC)
		if got.Title != c.title || got.Body != c.body {
			t.Errorf("%s/%s:\n got %q / %q\nwant %q / %q", c.e.Kind, c.l, got.Title, got.Body, c.title, c.body)
		}
	}
}

// Every kind and cause has a text in all locales, short enough for a message title.
func TestTextsComplete(t *testing.T) {
	for k, v := range problems {
		if v.ru == "" || v.en == "" || v.kk == "" {
			t.Errorf("problem %s incomplete", k)
		}
	}
	for k, v := range actions {
		if v.ru == "" || v.en == "" || v.kk == "" {
			t.Errorf("action %s incomplete", k)
		}
	}
	for k := range problems {
		kind, _, _ := strings.Cut(k, "/")
		if _, ok := names[kind]; !ok {
			t.Errorf("no name for %s", kind)
		}
	}
	for k := range names {
		for _, l := range Locales {
			for _, typ := range []EventType{EventOpened, EventRecovered, EventReminder} {
				txt := Render(Event{Type: typ, Kind: k, OpenedAt: fixedNow, At: fixedNow}, l, nil)
				if n := len([]rune(txt.Title)); n < 1 || n > 80 || txt.Body == "" {
					t.Errorf("%s/%s/%d: %q", k, l, typ, txt.Title)
				}
			}
		}
	}
}

func TestNormalizeLocale(t *testing.T) {
	for in, want := range map[string]string{"en-US": "en", "kk": "kk", "ru_RU": "ru", "de": "ru", "": "ru"} {
		if got := NormalizeLocale(in); got != want {
			t.Errorf("%q → %q", in, got)
		}
	}
}
