package companion

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"martytv/api/internal/foryou"
)

// Pure rules: who gets which button and what the model is told.

const (
	// RecapBreak: «Ранее в сериале» shows once the series rests this long.
	RecapBreak = 7 * 24 * time.Hour
	// recapMaxEpisodes: the furthest watched episodes the recap is built from.
	recapMaxEpisodes = 12
	// recapEpisodeChars / recapTotalChars cap the synopses sent.
	recapEpisodeChars = 700
	recapTotalChars   = 6000
	// ChatMaxUser: user messages in one «После титров» chat.
	ChatMaxUser = 6
	// chatHistory: earlier turns sent with a question.
	chatHistory   = 10
	chatMinPrompt = 2
	chatMaxPrompt = 300
)

// watchedEpisode is one completed episode with its synopsis (any language).
type watchedEpisode struct {
	ID       string
	Season   int
	Episode  int
	Name     string
	Overview string
}

// recapEligible: something was watched to the end, and the series has
// rested for at least RecapBreak.
func recapEligible(completed int, last *time.Time, now time.Time) bool {
	return completed > 0 && last != nil && now.Sub(*last) >= RecapBreak
}

// selectRecap picks the input: the furthest recapMaxEpisodes completed
// episodes in story order (specials skipped), those with a synopsis, each
// clipped, dropping the oldest when the total is too long. eps must be in
// story order. through is the furthest completed episode (nil: none).
func selectRecap(eps []watchedEpisode) (sel []watchedEpisode, through *watchedEpisode) {
	var story []watchedEpisode
	for _, e := range eps {
		if e.Season > 0 {
			story = append(story, e)
		}
	}
	if len(story) == 0 {
		return nil, nil
	}
	last := story[len(story)-1]
	through = &last
	if len(story) > recapMaxEpisodes {
		story = story[len(story)-recapMaxEpisodes:]
	}
	total := 0
	for i := len(story) - 1; i >= 0; i-- {
		e := story[i]
		e.Overview = clipRunes(strings.TrimSpace(e.Overview), recapEpisodeChars)
		if e.Overview == "" {
			continue
		}
		n := len([]rune(e.Overview))
		if total+n > recapTotalChars && len(sel) > 0 {
			break
		}
		total += n
		sel = append(sel, e)
	}
	// Back to story order.
	for i, j := 0, len(sel)-1; i < j; i, j = i+1, j-1 {
		sel[i], sel[j] = sel[j], sel[i]
	}
	return sel, through
}

// missingSynopses: the seasons of the furthest episodes that have none
// (to load from TMDB once before giving up on them).
func missingSynopses(eps []watchedEpisode) []int {
	var story []watchedEpisode
	for _, e := range eps {
		if e.Season > 0 {
			story = append(story, e)
		}
	}
	if len(story) > recapMaxEpisodes {
		story = story[len(story)-recapMaxEpisodes:]
	}
	seen := map[int]bool{}
	var out []int
	for _, e := range story {
		if strings.TrimSpace(e.Overview) == "" && !seen[e.Season] {
			seen[e.Season] = true
			out = append(out, e.Season)
		}
	}
	return out
}

// recapScope keys the cache: the exact episodes (and so synopses) used.
func recapScope(sel []watchedEpisode) string {
	h := sha256.New()
	for _, e := range sel {
		fmt.Fprintf(h, "%s|", e.ID)
	}
	return "ep:" + hex.EncodeToString(h.Sum(nil))[:24]
}

func recapInput(sel []watchedEpisode) []foryou.RecapEpisode {
	out := make([]foryou.RecapEpisode, 0, len(sel))
	for _, e := range sel {
		out = append(out, foryou.RecapEpisode{Season: e.Season, Episode: e.Episode, Name: e.Name, Overview: e.Overview})
	}
	return out
}

// seasonFinale is one season's last episode and whether it was completed.
type seasonFinale struct {
	Season    int
	Completed bool
}

// afterScope decides what the viewer has finished, if anything:
//   - a movie: completed (watched to the end or marked watched);
//   - a series: the highest season whose last episode is completed. It is
//     the whole series when that is the final season of an ended (or
//     cancelled) show; otherwise just that season — the companion then
//     never talks past it.
func afterScope(kind string, movieCompleted bool, finales []seasonFinale, status string) (foryou.CompanionScope, bool) {
	if kind == "movie" {
		return foryou.CompanionScope{Kind: "movie"}, movieCompleted
	}
	best, maxSeason := 0, 0
	for _, f := range finales {
		if f.Season <= 0 {
			continue
		}
		maxSeason = max(maxSeason, f.Season)
		if f.Completed {
			best = max(best, f.Season)
		}
	}
	if best == 0 {
		return foryou.CompanionScope{}, false
	}
	ended := status == "Ended" || status == "Canceled" || status == "Cancelled"
	if ended && best == maxSeason {
		return foryou.CompanionScope{Kind: "series", Season: best}, true
	}
	return foryou.CompanionScope{Kind: "season", Season: best}, true
}

// scopeKey is the cache/chat key of a scope ("movie", "season:2", "series:5").
func scopeKey(sc foryou.CompanionScope) string {
	if sc.Kind == "movie" {
		return "movie"
	}
	return fmt.Sprintf("%s:%d", sc.Kind, sc.Season)
}

// chatState: user turns used and whether another may be sent.
func chatRemaining(msgs []foryou.ChatTurn) int {
	n := 0
	for _, m := range msgs {
		if m.Role == "user" {
			n++
		}
	}
	return max(0, ChatMaxUser-n)
}

// chatContext: the last chatHistory turns.
func chatContext(msgs []foryou.ChatTurn) []foryou.ChatTurn {
	if len(msgs) > chatHistory {
		return msgs[len(msgs)-chatHistory:]
	}
	return msgs
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n-1])) + "…"
}
