package companion

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"martytv/api/internal/foryou"
)

func TestRecapEligible(t *testing.T) {
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) *time.Time { t := now.Add(-d); return &t }
	for _, c := range []struct {
		completed int
		last      *time.Time
		want      bool
	}{
		{3, ago(8 * 24 * time.Hour), true},
		{3, ago(7 * 24 * time.Hour), true},
		{3, ago(6*24*time.Hour + 23*time.Hour), false}, // watched less than a week ago
		{0, ago(30 * 24 * time.Hour), false},           // started, nothing finished
		{2, nil, false},
	} {
		if got := recapEligible(c.completed, c.last, now); got != c.want {
			t.Errorf("recapEligible(%d, %v) = %v", c.completed, c.last, got)
		}
	}
}

func eps(n int, overview func(i int) string) []watchedEpisode {
	var out []watchedEpisode
	for i := 1; i <= n; i++ {
		s, e := (i-1)/10+1, (i-1)%10+1
		out = append(out, watchedEpisode{ID: fmt.Sprintf("id-%d", i), Season: s, Episode: e, Overview: overview(i)})
	}
	return out
}

func TestSelectRecap(t *testing.T) {
	// The furthest 12 of 25, in story order, through S3E5; specials skipped.
	all := append([]watchedEpisode{{ID: "sp", Season: 0, Episode: 1, Overview: "special"}}, eps(25, func(i int) string { return fmt.Sprintf("Synopsis %d.", i) })...)
	sel, through := selectRecap(all)
	if through == nil || through.Season != 3 || through.Episode != 5 {
		t.Fatalf("through %+v", through)
	}
	if len(sel) != 12 || sel[0].ID != "id-14" || sel[11].ID != "id-25" {
		t.Fatalf("sel %d: %v … %v", len(sel), sel[0], sel[len(sel)-1])
	}
	for _, e := range sel {
		if e.Season == 0 {
			t.Fatal("special included")
		}
	}

	// Episodes without a synopsis are skipped (through still counts them).
	sel, through = selectRecap(eps(5, func(i int) string {
		if i == 5 || i == 2 {
			return " "
		}
		return "Text."
	}))
	if len(sel) != 3 || through.Episode != 5 || sel[2].ID != "id-4" {
		t.Fatalf("sel %v through %v", sel, through)
	}
	if got := missingSynopses(eps(3, func(i int) string { return map[bool]string{true: "", false: "x"}[i == 3] })); fmt.Sprint(got) != "[1]" {
		t.Fatalf("missing %v", got)
	}

	// Long synopses: each clipped, the oldest dropped past the total.
	sel, _ = selectRecap(eps(12, func(int) string { return strings.Repeat("я", 2000) }))
	if n := len([]rune(sel[0].Overview)); n != recapEpisodeChars || len(sel) != recapTotalChars/recapEpisodeChars || sel[len(sel)-1].ID != "id-12" {
		t.Fatalf("clipped: %d episodes, first %d runes, last %s", len(sel), n, sel[len(sel)-1].ID)
	}

	if sel, through := selectRecap(nil); sel != nil || through != nil {
		t.Fatal("empty")
	}
}

func TestRecapScope(t *testing.T) {
	a := []watchedEpisode{{ID: "a"}, {ID: "b"}}
	b := []watchedEpisode{{ID: "a"}, {ID: "c"}}
	if recapScope(a) == recapScope(b) || recapScope(a) != recapScope([]watchedEpisode{{ID: "a"}, {ID: "b"}}) || !strings.HasPrefix(recapScope(a), "ep:") {
		t.Fatal("scope must follow the exact episodes")
	}
}

func TestAfterScope(t *testing.T) {
	f := func(done ...bool) []seasonFinale {
		var out []seasonFinale
		for i, d := range done {
			out = append(out, seasonFinale{Season: i + 1, Completed: d})
		}
		return out
	}
	for _, c := range []struct {
		name    string
		kind    string
		movie   bool
		finales []seasonFinale
		status  string
		want    string
		ok      bool
	}{
		{"movie done", "movie", true, nil, "", "movie", true},
		{"movie not done", "movie", false, nil, "", "", false},
		{"no finale", "series", false, f(false, false), "Ended", "", false},
		{"season 1 finale", "series", false, f(true, false), "Returning Series", "season:1", true},
		{"highest finished season", "series", false, f(true, true, false), "Ended", "season:2", true},
		{"final season of an ended show", "series", false, f(false, true), "Ended", "series:2", true},
		{"last season, still running", "series", false, f(true, true), "Returning Series", "season:2", true},
		{"cancelled", "series", false, f(true), "Canceled", "series:1", true},
		{"specials ignored", "series", false, []seasonFinale{{Season: 0, Completed: true}}, "Ended", "", false},
	} {
		sc, ok := afterScope(c.kind, c.movie, c.finales, c.status)
		got := ""
		if ok {
			got = scopeKey(sc)
		}
		if ok != c.ok || got != c.want {
			t.Errorf("%s: %q %v, want %q %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestChatRemaining(t *testing.T) {
	var msgs []foryou.ChatTurn
	for i := 0; i < 5; i++ {
		msgs = append(msgs, foryou.ChatTurn{Role: "user", Text: "q"}, foryou.ChatTurn{Role: "assistant", Text: "a"})
	}
	if chatRemaining(msgs) != 1 || chatRemaining(nil) != ChatMaxUser {
		t.Fatal("remaining")
	}
	if c := chatContext(msgs); len(c) != chatHistory || c[len(c)-1].Role != "assistant" {
		t.Fatalf("context %v", c)
	}
	if cleanMessage("  a\nb\t c ") != "a b c" {
		t.Fatal("clean")
	}
}
