package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// Imports from other services (Spotify, VK…): the client sends what it read
// (title, artists, duration); each item is matched to the catalog with a
// single Deezer search. Tracks the catalog lacks become "yq:" tracks, found
// on YouTube the first time they are played (GET /music/api/ytq).

type ImportItem struct {
	Title    string   `json:"title"`
	Artists  []string `json:"artists"`
	Album    string   `json:"album"`
	Duration int      `json:"duration"`
}

var reTitleNoise = regexp.MustCompile(`(?i)\s+-\s+.*(remaster|version|mix|edit|live|mono|stereo|single).*$|\s*[\(\[][^\)\]]*(feat|ft\.|remaster|version|zaycev|official)[^\)\]]*[\)\]]`)

func cleanTitle(s string) string { return strings.TrimSpace(reTitleNoise.ReplaceAllString(s, "")) }

func scoreImport(it ImportItem, c Track) float64 {
	tt, ct := normalize(cleanTitle(it.Title)), normalize(cleanTitle(c.Title))
	s := 0.0
	switch {
	case tt == "" || ct == "":
		return -1
	case tt == ct:
		s += 50
	case strings.Contains(ct, tt) || strings.Contains(tt, ct):
		s += 30
	default:
		return -1
	}
	cas := []string{normalize(c.Artist)}
	for _, a := range c.Artists {
		cas = append(cas, normalize(a.Name))
	}
	best := -30.0
	for _, ta := range it.Artists {
		ta = normalize(ta)
		for _, ca := range cas {
			switch {
			case ta != "" && ca == ta:
				best = math.Max(best, 40)
			case ta != "" && ca != "" && (strings.Contains(ca, ta) || strings.Contains(ta, ca)):
				best = math.Max(best, 25)
			}
		}
	}
	s += best
	if it.Duration > 0 && c.Duration > 0 {
		d := math.Abs(float64(it.Duration - c.Duration))
		switch {
		case d <= 3:
			s += 20
		case d <= 10:
			s += 8
		case d > 40:
			s -= 30
		}
	}
	if it.Album != "" && normalize(it.Album) == normalize(c.Album) {
		s += 10
	}
	return s
}

func (a *App) matchImport(ctx context.Context, it ImportItem) *Track {
	artist := ""
	if len(it.Artists) > 0 {
		artist = it.Artists[0]
	}
	title := cleanTitle(it.Title)
	queries := []string{`artist:"` + artist + `" track:"` + title + `"`, artist + " " + title}
	var best *Track
	bestScore := -1.0
	for _, q := range queries {
		ts, err := a.dz.SearchTracks(ctx, q, 15)
		if err != nil {
			continue
		}
		for i := range ts {
			if s := scoreImport(it, ts[i]); s > bestScore {
				bestScore, best = s, &ts[i]
			}
		}
		if bestScore >= 70 {
			break
		}
	}
	if best == nil || bestScore < 70 {
		return nil
	}
	return best
}

// yqID is a stable id for a track known only by artist + title.
func yqID(artist, title string) string {
	sum := sha1.Sum([]byte(normalize(artist) + "|" + normalize(title)))
	return "yq:" + hex.EncodeToString(sum[:10])
}

var yqRe = regexp.MustCompile(`^yq:[0-9a-f]{20}$`)

// hImportMatch: POST {items:[…]} (≤ 200) → [Track] in the same order;
// unmatched items come back as "yq:" tracks.
func (a *App) hImportMatch(w http.ResponseWriter, r *http.Request, u *User) error {
	var b struct {
		Items []ImportItem `json:"items"`
	}
	if err := readJSON(r, &b); err != nil {
		return err
	}
	if len(b.Items) > 200 {
		return errStatus(400, "too_many", "Не больше 200 за раз")
	}
	out := make([]Track, len(b.Items))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, it := range b.Items {
		wg.Add(1)
		go func(i int, it ImportItem) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if m := a.matchImport(r.Context(), it); m != nil {
				out[i] = *m
				return
			}
			artist := strings.Join(it.Artists, ", ")
			out[i] = Track{ID: yqID(artist, it.Title), Title: it.Title, Artist: artist, Album: it.Album, Duration: it.Duration}
		}(i, it)
	}
	wg.Wait()
	writeJSON(w, 200, out)
	return nil
}

// hYTQuery plays a "yq:" track: ?id=&artist=&title=&duration=. The YouTube
// match is found once (verified, cached like catalog matches).
func (a *App) hYTQuery(w http.ResponseWriter, r *http.Request, u *User) error {
	q := r.URL.Query()
	id := q.Get("id")
	t := &Track{Artist: q.Get("artist"), Title: q.Get("title")}
	t.Duration, _ = strconv.Atoi(q.Get("duration"))
	if !yqRe.MatchString(id) || t.Title == "" || yqID(t.Artist, t.Title) != id {
		return errStatus(400, "bad_request", "Некорректный трек")
	}
	t.ID = id
	if wantsRepick(r) {
		a.repick(r.Context(), id)
	}
	if a.serveManual(w, r, id) {
		return nil
	}
	v, ok := a.st.Match(r.Context(), id)
	if !ok || memo.isBad(id, v) {
		var err error
		v, err = a.findYT(r.Context(), &Track{ID: id, Artist: t.Artist, Title: t.Title, Duration: t.Duration})
		if err != nil {
			return a.playFallback(w, r, t, err)
		}
		_ = a.st.SetMatch(r.Context(), id, v, false)
	}
	memo.setServed(id, v)
	if a.serveCached(w, r, v) {
		return nil
	}
	a.cacheAudio(v)
	err := a.streamYT(w, r, v)
	if errors.Is(err, errYTNoAudio) {
		memo.markBad(id, v)
		_ = a.st.ForgetAutoMatch(r.Context(), id, v)
		return a.playFallback(w, r, t, err)
	}
	return err
}

// findYT: the best-ranked YouTube candidate that actually streams.
func (a *App) findYT(ctx context.Context, t *Track) (string, error) {
	t.Title = cleanTitle(t.Title)
	cands, err := a.yt.Candidates(ctx, t)
	if err != nil {
		return "", err
	}
	for i, c := range cands {
		if i >= 4 || c.Score < cands[0].Score-45 {
			break
		}
		if t.ID != "" && memo.isBad(t.ID, c.VideoID) {
			continue
		}
		if a.probeVideo(ctx, c.VideoID) {
			return c.VideoID, nil
		}
	}
	return "", errYTNoMatch
}

// hYTSearch: plain YouTube search (things the catalog lacks: covers, live
// versions, uploads). Results are "yt:" tracks; their covers are the video
// thumbnails ("yt:<id>" in the image proxy).
func (a *App) hYTSearch(w http.ResponseWriter, r *http.Request, u *User) error {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, 200, []Track{})
		return nil
	}
	items, err := a.yt.Search(r.Context(), q)
	if err != nil {
		return err
	}
	out := make([]Track, 0, len(items))
	for _, it := range items {
		if it.LengthSeconds > 20*60 {
			continue // mixes and full albums
		}
		out = append(out, Track{ID: "yt:" + it.VideoID, Title: it.Title, Artist: strings.TrimSuffix(it.Author, " - Topic"),
			Duration: it.LengthSeconds, Cover: "yt:" + it.VideoID})
	}
	writeJSON(w, 200, out)
	return nil
}
