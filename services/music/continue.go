package main

import (
	"context"
	"encoding/json"
	"math/rand/v2"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// «Дальше — похожие»: when a finite list (playlist, album, AI or imported
// playlist, search results…) runs out and autoplay is on, the player goes on
// with recommendations made from the list itself: the radios of its most
// frequent artists. Imported / AI tracks ("yq:") carry only an artist name,
// so names are looked up in the catalog.

const (
	continueSeeds   = 5  // artist radios mixed
	continuePool    = 10 // most frequent artists the seeds are drawn from
	continueTracks  = 30 // tracks per answer
	continueMaxBody = 200
)

type continueSeed struct {
	id    int64
	name  string // looked up when id is 0
	count int
	last  int // index of the artist's last track (later = more recent)
}

// continueSeedsFor: the artists of tracks, most frequent first (ties: the
// most recent), keyed by catalog id or, without one, by normalized name.
func continueSeedsFor(tracks []Track) []continueSeed {
	by := map[string]*continueSeed{}
	for i, t := range tracks {
		var key string
		s := continueSeed{last: i}
		switch {
		case t.ArtistID > 0:
			key = "id:" + strconv.FormatInt(t.ArtistID, 10)
			s.id = t.ArtistID
		default:
			name := firstArtist(t.Artist)
			if name == "" {
				continue
			}
			key = "name:" + normalize(name)
			s.name = name
		}
		if p := by[key]; p != nil {
			p.count++
			p.last = i
			continue
		}
		s.count = 1
		by[key] = &s
	}
	out := make([]continueSeed, 0, len(by))
	for _, s := range by {
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].count != out[j].count {
			return out[i].count > out[j].count
		}
		return out[i].last > out[j].last
	})
	return out
}

// firstArtist: "A, B feat. C" → "A" ("Simon & Garfunkel" stays).
func firstArtist(s string) string {
	s = strings.TrimSpace(s)
	for _, sep := range []string{",", ";", " feat.", " feat ", " ft.", " ft "} {
		if i := strings.Index(strings.ToLower(s), sep); i > 0 {
			s = s[:i]
		}
	}
	return strings.TrimSpace(s)
}

// artistByName: the catalog artist whose name matches (0: none).
func (a *App) artistByName(ctx context.Context, name string) int64 {
	var r dzList[dzArtist]
	if a.dz.get(ctx, "/search/artist", url.Values{"q": {name}, "limit": {"5"}}, ttlLong, &r) != nil {
		return 0
	}
	want := normalize(name)
	for _, x := range r.Data {
		if normalize(x.Name) == want {
			return x.ID
		}
	}
	// "The Beatles" for "Beatles", "Ludovico Einaudi" for "Einaudi"…
	if len(r.Data) > 0 && want != "" {
		if n := normalize(r.Data[0].Name); strings.Contains(n, want) || strings.Contains(want, n) {
			return r.Data[0].ID
		}
	}
	return 0
}

// hContinue: POST {tracks:[…], exclude:[ids]} → [Track]: recommendations
// to play after the list.
func (a *App) hContinue(w http.ResponseWriter, r *http.Request, u *User) error {
	var b struct {
		Tracks  []Track  `json:"tracks"`
		Exclude []string `json:"exclude"`
	}
	if err := readJSON(r, &b); err != nil {
		return err
	}
	if len(b.Tracks) > continueMaxBody {
		b.Tracks = b.Tracks[len(b.Tracks)-continueMaxBody:]
	}
	if len(b.Exclude) > 2000 {
		b.Exclude = b.Exclude[len(b.Exclude)-2000:]
	}
	ctx := r.Context()
	// Not again: what is in the queue, what was played lately, and the same
	// song under another id (an imported track and its catalog twin).
	recent := map[string]bool{}
	for _, id := range b.Exclude {
		recent[id] = true
	}
	songs := map[string]bool{}
	for _, t := range b.Tracks {
		recent[t.ID] = true
		songs[yqID(t.Artist, t.Title)] = true
	}
	if hist, err := a.st.HistoryRaw(ctx, u.ID, 60); err == nil {
		for _, raw := range hist {
			var t Track
			if json.Unmarshal(raw, &t) == nil {
				recent[t.ID] = true
				songs[yqID(t.Artist, t.Title)] = true
			}
		}
	}

	pool := continueSeedsFor(b.Tracks)
	if len(pool) > continuePool {
		pool = pool[:continuePool]
	}
	rand.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })
	if len(pool) > continueSeeds {
		pool = pool[:continueSeeds]
	}
	var wg sync.WaitGroup
	for i := range pool {
		if pool[i].id == 0 {
			wg.Add(1)
			go func(s *continueSeed) {
				defer wg.Done()
				s.id = a.artistByName(ctx, s.name)
			}(&pool[i])
		}
	}
	wg.Wait()
	seeds := []ArtistRef{}
	have := map[int64]bool{}
	for _, s := range pool {
		if s.id > 0 && !have[s.id] {
			have[s.id] = true
			seeds = append(seeds, ArtistRef{ID: s.id})
		}
	}
	if len(seeds) == 0 {
		// Nobody in the catalog: the listener's own wave.
		seeds = a.topArtists(ctx, u.ID, continueSeeds)
	}
	if len(seeds) == 0 {
		writeJSON(w, 200, []Track{})
		return nil
	}
	out := a.mixRadios(ctx, seeds, recent, continueTracks*2)
	fresh := make([]Track, 0, continueTracks)
	for _, t := range out {
		if songs[yqID(t.Artist, t.Title)] {
			continue
		}
		fresh = append(fresh, t)
		if len(fresh) == continueTracks {
			break
		}
	}
	writeJSON(w, 200, fresh)
	return nil
}
