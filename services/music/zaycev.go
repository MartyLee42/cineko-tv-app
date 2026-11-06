package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// zaycev.net as an alternative source (Russian MP3 site, reachable from the
// server, 320 kbps). Uses the JSON API its own web player calls:
//   GET  /api/external/pages/search/tracks?q=&page=1&limit=
//   POST /api/external/track/filezmeta {trackIds:[id]} → streaming hash
//   GET  /api/external/track/play/<hash> → {url} (a short-lived MP3 link)

const zvBase = "https://zaycev.net/api/external"

type Zaycev struct {
	hc *http.Client

	mu   sync.Mutex
	urls map[int64]zvURL
}

type zvURL struct {
	url string
	at  time.Time
}

func newZaycev() *Zaycev {
	return &Zaycev{hc: &http.Client{Timeout: 20 * time.Second}, urls: map[int64]zvURL{}}
}

type zvTrack struct {
	ID       int64
	Artist   string
	Title    string
	Duration int
	Bitrate  int
	Cover    string
	Playable bool
}

func (z *Zaycev) do(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, zvBase+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36")
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := z.hc.Do(req)
	if err != nil {
		return fmt.Errorf("zaycev: %w", shortErr(err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("zaycev: HTTP %d", resp.StatusCode)
	}
	return json.Unmarshal(raw, out)
}

func parseMMSS(s string) int {
	parts := strings.Split(s, ":")
	total := 0
	for _, p := range parts {
		n, _ := strconv.Atoi(strings.TrimSpace(p))
		total = total*60 + n
	}
	return total
}

func (z *Zaycev) Search(ctx context.Context, q string, limit int) ([]zvTrack, error) {
	var r struct {
		TrackIDs   []int64 `json:"trackIds"`
		TracksInfo map[string]struct {
			Track    string `json:"track"`
			Artist   string `json:"artistName"`
			Duration string `json:"duration"`
			Bitrate  int    `json:"bitrate"`
			Playback bool   `json:"playbackEnabled"`
			Image    string `json:"imageJpg"`
		} `json:"tracksInfo"`
	}
	v := url.Values{"q": {q}, "page": {"1"}, "limit": {strconv.Itoa(limit)}}
	if err := z.do(ctx, http.MethodGet, "/pages/search/tracks?"+v.Encode(), nil, &r); err != nil {
		return nil, err
	}
	out := make([]zvTrack, 0, len(r.TrackIDs))
	for _, id := range r.TrackIDs {
		ti, ok := r.TracksInfo[strconv.FormatInt(id, 10)]
		if !ok {
			continue
		}
		out = append(out, zvTrack{ID: id, Artist: strings.TrimPrefix(ti.Artist, "By "), Title: ti.Track, Duration: parseMMSS(ti.Duration),
			Bitrate: ti.Bitrate, Cover: strings.Replace(ti.Image, "square100", "square250", 1), Playable: ti.Playback})
	}
	return out, nil
}

// PlayURL returns the MP3 link of a track (cached ~10 min).
func (z *Zaycev) PlayURL(ctx context.Context, id int64, fresh bool) (string, error) {
	z.mu.Lock()
	c, ok := z.urls[id]
	z.mu.Unlock()
	if ok && !fresh && time.Since(c.at) < 10*time.Minute {
		return c.url, nil
	}
	var meta struct {
		Tracks []struct {
			ID        int64  `json:"id"`
			Streaming string `json:"streaming"`
		} `json:"tracks"`
	}
	if err := z.do(ctx, http.MethodPost, "/track/filezmeta", map[string]any{"trackIds": []int64{id}, "subscription": false}, &meta); err != nil {
		return "", err
	}
	if len(meta.Tracks) == 0 || meta.Tracks[0].Streaming == "" {
		return "", errors.New("zaycev: track not playable")
	}
	var play struct {
		URL string `json:"url"`
	}
	if err := z.do(ctx, http.MethodGet, "/track/play/"+url.PathEscape(meta.Tracks[0].Streaming), nil, &play); err != nil {
		return "", err
	}
	if !strings.HasPrefix(play.URL, "https://") {
		return "", errors.New("zaycev: no play url")
	}
	z.mu.Lock()
	if len(z.urls) > 2000 {
		z.urls = map[int64]zvURL{}
	}
	z.urls[id] = zvURL{url: play.URL, at: time.Now()}
	z.mu.Unlock()
	return play.URL, nil
}

func zvToTrack(t zvTrack) Track {
	return Track{ID: "zv:" + strconv.FormatInt(t.ID, 10), Title: t.Title, Artist: t.Artist, Duration: t.Duration, Cover: t.Cover}
}

// zvScore rates a zaycev upload against a catalog track: same title and
// artist are required, the length decides between versions.
func zvScore(t *Track, c *zvTrack) (float64, bool) {
	if !c.Playable {
		return 0, false
	}
	artist := strings.TrimSpace(strings.Split(t.Artist, ",")[0])
	nt, na := normalize(cleanTitle(t.Title)), normalize(artist)
	ct, ca := normalize(cleanTitle(c.Title)), normalize(c.Artist)
	s := 0.0
	switch {
	case ct == nt:
		s += 50
	case len(nt) > 3 && strings.Contains(ct, nt):
		s += 25
	default:
		return 0, false
	}
	switch {
	case na != "" && (ca == na || strings.Contains(ca, na)):
		s += 40
	case na != "" && strings.Contains(na, ca) && ca != "":
		s += 20
	default:
		return 0, false // another artist's song with the same name
	}
	if t.Duration > 0 && c.Duration > 0 {
		d := math.Abs(float64(t.Duration - c.Duration))
		switch {
		case d <= 4:
			s += 20
		case d <= 10:
			s += 5
		case d > 30:
			s -= 40
		}
	}
	for _, w := range variantWords {
		if containsWord(normalize(c.Title), w) && !containsWord(normalize(t.Title+" "+t.Version), w) {
			s -= 22
		}
	}
	return s, true
}

// ZvCandidate is a zaycev upload offered in the "choose recording" dialog.
type ZvCandidate struct {
	ID       string  `json:"id"` // "zv:<n>"
	Title    string  `json:"title"`
	Artist   string  `json:"artist"`
	Duration int     `json:"duration"`
	Bitrate  int     `json:"bitrate,omitempty"`
	Score    float64 `json:"score"`
}

// Ranked: the zaycev uploads of a track, best first.
func (z *Zaycev) Ranked(ctx context.Context, t *Track) ([]ZvCandidate, error) {
	artist := strings.TrimSpace(strings.Split(t.Artist, ",")[0])
	cands, err := z.Search(ctx, strings.TrimSpace(artist+" "+cleanTitle(t.Title)), 20)
	if err != nil {
		return nil, err
	}
	out := []ZvCandidate{}
	for i := range cands {
		c := &cands[i]
		if sc, ok := zvScore(t, c); ok {
			out = append(out, ZvCandidate{ID: "zv:" + strconv.FormatInt(c.ID, 10), Title: c.Title, Artist: c.Artist,
				Duration: c.Duration, Bitrate: c.Bitrate, Score: sc - float64(i)*0.5})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	return out, nil
}

// Best finds the zaycev upload of a track (same title, artist, ±6 s).
func (z *Zaycev) Best(ctx context.Context, t *Track) (int64, error) {
	r, err := z.Ranked(ctx, t)
	if err != nil {
		return 0, err
	}
	if len(r) == 0 || r[0].Score < 70 {
		return 0, errors.New("zaycev: no match")
	}
	return strconv.ParseInt(strings.TrimPrefix(r[0].ID, "zv:"), 10, 64)
}

var zvIDRe = regexp.MustCompile(`^\d{1,12}$`)

// ---- handlers ----

func (a *App) hZvSearch(w http.ResponseWriter, r *http.Request, u *User) error {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, 200, []Track{})
		return nil
	}
	res, err := a.zv.Search(r.Context(), q, 40)
	if err != nil {
		return err
	}
	out := []Track{}
	for _, t := range res {
		if t.Playable {
			out = append(out, zvToTrack(t))
		}
	}
	writeJSON(w, 200, out)
	return nil
}

// hZvPlay proxies a zaycev MP3 with Range support.
func (a *App) hZvPlay(w http.ResponseWriter, r *http.Request, u *User) error {
	raw := r.PathValue("id")
	if !zvIDRe.MatchString(raw) {
		return errStatus(400, "bad_request", "Некорректный id")
	}
	if a.serveManual(w, r, "zv:"+raw) {
		return nil
	}
	id, _ := strconv.ParseInt(raw, 10, 64)
	return a.streamZv(w, r, id)
}

func (a *App) streamZv(w http.ResponseWriter, r *http.Request, id int64) error {
	for attempt := 0; attempt < 2; attempt++ {
		u, err := a.zv.PlayURL(r.Context(), id, attempt > 0)
		if err != nil {
			return errStatus(404, "not_found", "Трек недоступен на Zaycev")
		}
		req, _ := http.NewRequestWithContext(r.Context(), r.Method, u, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0")
		if rg := r.Header.Get("Range"); rg != "" {
			req.Header.Set("Range", rg)
		}
		resp, err := a.zvStream.Do(req)
		if err != nil {
			return fmt.Errorf("zaycev stream: %w", shortErr(err))
		}
		if (resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound) && attempt == 0 {
			resp.Body.Close()
			continue // link expired: get a fresh one
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusRequestedRangeNotSatisfiable {
			return fmt.Errorf("zaycev stream: HTTP %d", resp.StatusCode)
		}
		h := w.Header()
		for _, k := range []string{"Content-Length", "Content-Range", "Accept-Ranges"} {
			if v := resp.Header.Get(k); v != "" {
				h.Set(k, v)
			}
		}
		h.Set("Content-Type", "audio/mpeg")
		h.Set("Cache-Control", "private, max-age=3600")
		w.WriteHeader(resp.StatusCode)
		if r.Method != http.MethodHead {
			_, _ = io.Copy(flushWriter{w}, resp.Body)
		}
		return nil
	}
	return errStatus(404, "not_found", "Трек недоступен на Zaycev")
}

// zaycevFallback: the zaycev upload of a catalog track (cached per track),
// checked to give a play link; a dead one is replaced.
func (a *App) zaycevFallback(ctx context.Context, t *Track) (int64, bool) {
	key := "zv|" + t.ID
	if v, ok := a.st.Match(ctx, key); ok {
		if id, err := strconv.ParseInt(v, 10, 64); err == nil && id > 0 && !memo.isBad(t.ID, "zv:"+v) {
			if _, err := a.zv.PlayURL(ctx, id, false); err == nil {
				return id, true
			}
			memo.markBad(t.ID, "zv:"+v)
			_ = a.st.ForgetAutoMatch(ctx, key, v)
		}
	}
	id, ok := a.zvPick(ctx, t)
	if !ok {
		return 0, false
	}
	_ = a.st.SetMatch(ctx, key, strconv.FormatInt(id, 10), false)
	return id, true
}
