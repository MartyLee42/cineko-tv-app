package main

import (
	"context"
	"encoding/json"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"unicode"
)

// «Моя волна» settings, like a streaming service's wave:
//   character: favorite (your artists' radios + likes) | discover (artists
//              related to yours that you don't play) | popular (charts)
//   mood:      energetic | happy | calm | sad
//   activity:  wake | work | workout | road | sleep
//   lang:      ru | foreign (filter by Cyrillic in artist/title)
// Moods and activities come from Deezer playlists found by keyword, mixed
// with the character pool (taste-matching tracks first).

var waveKeywords = map[string][]string{
	"energetic": {"energy", "бодрая музыка", "power hits"},
	"happy":     {"happy hits", "весёлая музыка", "good vibes"},
	"calm":      {"chill", "спокойная музыка", "relax"},
	"sad":       {"sad songs", "грустные песни", "melancholy"},
	"wake":      {"morning", "утро", "wake up"},
	"work":      {"focus", "для работы", "deep focus"},
	"workout":   {"workout", "тренировка", "gym"},
	"road":      {"road trip", "в дорогу", "driving"},
	"sleep":     {"sleep", "для сна", "calm piano"},
}

func hasCyrillic(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Cyrillic, r) {
			return true
		}
	}
	return false
}

// moodPool: tracks of the top playlists for the mood/activity keywords.
func (a *App) moodPool(ctx context.Context, keys []string) []Track {
	var mu sync.Mutex
	var wg sync.WaitGroup
	out := []Track{}
	for _, k := range keys {
		for _, q := range waveKeywords[k] {
			wg.Add(1)
			go func(q string) {
				defer wg.Done()
				var r dzList[dzPlaylist]
				if a.dz.get(ctx, "/search/playlist", url.Values{"q": {q}, "limit": {"3"}}, ttlLong, &r) != nil {
					return
				}
				for i, p := range r.Data {
					if i >= 2 {
						break
					}
					pl, err := a.dz.Playlist(ctx, p.ID)
					if err != nil {
						continue
					}
					mu.Lock()
					out = append(out, pl.Tracks...)
					mu.Unlock()
				}
			}(q)
		}
	}
	wg.Wait()
	return out
}

func (a *App) characterPool(ctx context.Context, user, character string) []Track {
	switch character {
	case "popular":
		c, err := a.dz.Chart(ctx, 0)
		if err != nil {
			return nil
		}
		return append([]Track(nil), c.Tracks...)
	case "discover":
		top := a.topArtists(ctx, user, 8)
		known := map[int64]bool{}
		for _, t := range top {
			known[t.ID] = true
		}
		var mu sync.Mutex
		var wg sync.WaitGroup
		out := []Track{}
		for _, t := range top {
			wg.Add(1)
			go func(id int64) {
				defer wg.Done()
				p, err := a.dz.Artist(ctx, id)
				if err != nil {
					return
				}
				rel := p.Related
				rand.Shuffle(len(rel), func(i, j int) { rel[i], rel[j] = rel[j], rel[i] })
				for i, r := range rel {
					if i >= 4 || known[r.ID] {
						continue
					}
					ts, err := a.dz.ArtistTop(ctx, r.ID, 5)
					if err != nil {
						continue
					}
					mu.Lock()
					out = append(out, ts...)
					mu.Unlock()
				}
			}(t.ID)
		}
		wg.Wait()
		if len(out) == 0 {
			return a.characterPool(ctx, user, "popular")
		}
		return out
	default: // favorite
		top := a.topArtists(ctx, user, 10)
		rand.Shuffle(len(top), func(i, j int) { top[i], top[j] = top[j], top[i] })
		if len(top) > 5 {
			top = top[:5]
		}
		var mu sync.Mutex
		var wg sync.WaitGroup
		out := []Track{}
		for _, t := range top {
			wg.Add(1)
			go func(id int64) {
				defer wg.Done()
				ts, err := a.dz.ArtistRadio(ctx, id)
				if err != nil || len(ts) == 0 {
					ts, _ = a.dz.ArtistTop(ctx, id, 20)
				}
				mu.Lock()
				out = append(out, ts...)
				mu.Unlock()
			}(t.ID)
		}
		wg.Wait()
		if likes, err := a.st.Likes(ctx, user); err == nil {
			rand.Shuffle(len(likes), func(i, j int) { likes[i], likes[j] = likes[j], likes[i] })
			for i, raw := range likes {
				if i >= 30 {
					break
				}
				var t Track
				if json.Unmarshal(raw, &t) == nil && t.ID != "" {
					out = append(out, t)
				}
			}
		}
		if len(out) == 0 {
			return a.characterPool(ctx, user, "popular")
		}
		return out
	}
}

// wave builds one batch of «Моя волна» for the given settings.
func (a *App) wave(ctx context.Context, user string, q url.Values, exclude map[string]bool) []Track {
	character := q.Get("character")
	var keys []string
	for _, k := range []string{q.Get("mood"), q.Get("activity")} {
		if _, ok := waveKeywords[k]; ok {
			keys = append(keys, k)
		}
	}
	lang := q.Get("lang")

	var charPool, mood []Track
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); charPool = a.characterPool(ctx, user, character) }()
	if len(keys) > 0 {
		wg.Add(1)
		go func() { defer wg.Done(); mood = a.moodPool(ctx, keys) }()
	}
	wg.Wait()

	keep := func(t Track) bool {
		if t.ID == "" || exclude[t.ID] {
			return false
		}
		switch lang {
		case "ru":
			return hasCyrillic(t.Artist + t.Title)
		case "foreign":
			return !hasCyrillic(t.Artist + t.Title)
		}
		return true
	}
	rand.Shuffle(len(charPool), func(i, j int) { charPool[i], charPool[j] = charPool[j], charPool[i] })
	rand.Shuffle(len(mood), func(i, j int) { mood[i], mood[j] = mood[j], mood[i] })
	if len(mood) > 0 && character != "popular" {
		// Mood tracks by artists the listener knows come first.
		taste := map[int64]bool{}
		for _, t := range charPool {
			taste[t.ArtistID] = true
		}
		var mine, other []Track
		for _, t := range mood {
			if taste[t.ArtistID] {
				mine = append(mine, t)
			} else {
				other = append(other, t)
			}
		}
		mood = append(mine, other...)
	}

	// Interleave: with a mood, 2 mood tracks per 1 character track.
	out := []Track{}
	seen := map[string]bool{}
	artistCount := map[int64]int{}
	add := func(t Track) bool {
		if !keep(t) || seen[t.ID] || (t.ArtistID != 0 && artistCount[t.ArtistID] >= 3) {
			return false
		}
		if n := len(out); n > 0 && t.ArtistID != 0 && out[n-1].ArtistID == t.ArtistID {
			return false
		}
		seen[t.ID] = true
		artistCount[t.ArtistID]++
		out = append(out, t)
		return true
	}
	ci, mi := 0, 0
	for len(out) < 40 && (ci < len(charPool) || mi < len(mood)) {
		if len(mood) > 0 {
			for k := 0; k < 2 && mi < len(mood); mi++ {
				if add(mood[mi]) {
					k++
				}
			}
		}
		for ci < len(charPool) {
			ci++
			if add(charPool[ci-1]) {
				break
			}
		}
	}
	return out
}

func waveParams(q url.Values) bool {
	for _, k := range []string{"character", "mood", "activity", "lang"} {
		if q.Get(k) != "" {
			return true
		}
	}
	return false
}

// hWave: GET /music/api/flow with wave settings.
func (a *App) hWave(w http.ResponseWriter, r *http.Request, u *User) error {
	exclude := map[string]bool{}
	if hist, err := a.st.HistoryRaw(r.Context(), u.ID, 60); err == nil {
		for _, raw := range hist {
			var t Track
			if json.Unmarshal(raw, &t) == nil {
				exclude[t.ID] = true
			}
		}
	}
	for _, x := range strings.Split(r.URL.Query().Get("exclude"), ",") {
		if x != "" {
			exclude[x] = true
		}
	}
	out := a.wave(r.Context(), u.ID, r.URL.Query(), exclude)
	if len(out) == 0 {
		// Too strict (e.g. a language filter on a foreign-only taste): drop the filter.
		q := r.URL.Query()
		q.Del("lang")
		out = a.wave(r.Context(), u.ID, q, exclude)
	}
	writeJSON(w, 200, out)
	return nil
}
