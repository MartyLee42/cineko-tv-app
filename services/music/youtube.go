package main

import (
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

// YouTube through the household's Invidious (internal network). Catalog
// tracks are matched to an upload by search + scoring; audio is the AAC
// adaptive format (itag 140, plays everywhere incl. Safari), proxied.

type YouTube struct {
	base   *url.URL
	hc     *http.Client
	region string
	cache  *ttlCache

	mu      sync.Mutex
	formats map[string]ytAudio
}

type ytAudio struct {
	URL  string
	Size int64
	Mime string
	at   time.Time
}

var (
	errYTNotConfigured = errors.New("invidious not configured")
	errYTNoAudio       = errors.New("no playable audio for this video")
	errYTNoMatch       = errors.New("no YouTube upload found for this track")
)

func newYouTube(base, region string) *YouTube {
	y := &YouTube{region: region, cache: newTTLCache(2000), formats: map[string]ytAudio{}}
	if u, err := url.Parse(base); err == nil && u.Host != "" {
		y.base = u
	}
	y.hc = &http.Client{
		Timeout: 25 * time.Second,
		Transport: &http.Transport{
			Proxy: nil, MaxIdleConnsPerHost: 16, IdleConnTimeout: 90 * time.Second,
			ResponseHeaderTimeout: 20 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return y
}

func (y *YouTube) Configured() bool { return y.base != nil }

type ytItem struct {
	Type          string `json:"type"`
	Title         string `json:"title"`
	VideoID       string `json:"videoId"`
	Author        string `json:"author"`
	AuthorID      string `json:"authorId"`
	LengthSeconds int    `json:"lengthSeconds"`
	ViewCount     int64  `json:"viewCount"`
	LiveNow       bool   `json:"liveNow"`
	IsUpcoming    bool   `json:"isUpcoming"`
}

// getJSON calls the Invidious API. Its route to YouTube (a VPN SOCKS proxy)
// fails transiently, which shows up as HTTP 400/5xx "Failed to open SOCKS
// connection": those are retried.
func (y *YouTube) getJSON(ctx context.Context, path string, q url.Values, out any) error {
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		var retry bool
		retry, err = y.getJSONOnce(ctx, path, q, out)
		if err == nil || !retry || ctx.Err() != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(time.Duration(300*(attempt+1)) * time.Millisecond):
		}
	}
	return err
}

func (y *YouTube) getJSONOnce(ctx context.Context, path string, q url.Values, out any) (bool, error) {
	if y.base == nil {
		return false, errYTNotConfigured
	}
	u := *y.base
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return false, err
	}
	resp, err := y.hc.Do(req)
	if err != nil {
		return true, fmt.Errorf("invidious: %w", shortErr(err))
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return true, err
	}
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		transient := resp.StatusCode >= 500 || strings.Contains(e.Error, "SOCKS") || strings.Contains(e.Error, "timed out") ||
			strings.Contains(e.Error, "Connection")
		return transient, fmt.Errorf("invidious: HTTP %d %s", resp.StatusCode, clip(e.Error, 120))
	}
	return false, json.Unmarshal(body, out)
}

func (y *YouTube) Search(ctx context.Context, q string) ([]ytItem, error) {
	key := "s|" + q
	if b, ok := y.cache.get(key); ok {
		var items []ytItem
		if json.Unmarshal(b, &items) == nil {
			return items, nil
		}
	}
	var items []ytItem
	if err := y.getJSON(ctx, "/api/v1/search", url.Values{"q": {q}, "type": {"video"}, "region": {y.region}, "hl": {"ru"}}, &items); err != nil {
		return nil, err
	}
	out := items[:0]
	for _, it := range items {
		if it.Type == "video" && it.VideoID != "" && !it.LiveNow && !it.IsUpcoming && it.LengthSeconds > 0 {
			out = append(out, it)
		}
	}
	b, _ := json.Marshal(out)
	y.cache.set(key, b, 6*time.Hour)
	return out, nil
}

var videoIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

func validVideoID(id string) bool { return videoIDRe.MatchString(id) }

// audio returns the best AAC audio format of a video (cached ~1 h; the
// googlevideo URLs behind Invidious expire after a few hours).
func (y *YouTube) audio(ctx context.Context, id string, fresh bool) (ytAudio, error) {
	if !validVideoID(id) {
		return ytAudio{}, errYTNoAudio
	}
	y.mu.Lock()
	a, ok := y.formats[id]
	y.mu.Unlock()
	if ok && !fresh && time.Since(a.at) < time.Hour {
		return a, nil
	}
	var v struct {
		AdaptiveFormats []struct {
			URL     string `json:"url"`
			Itag    string `json:"itag"`
			Type    string `json:"type"`
			Bitrate string `json:"bitrate"`
			Clen    string `json:"clen"`
		} `json:"adaptiveFormats"`
	}
	if err := y.getJSON(ctx, "/api/v1/videos/"+id, url.Values{"local": {"true"}, "hl": {"ru"}}, &v); err != nil {
		return ytAudio{}, err
	}
	best := -1
	var bestRate int64
	var opus = -1
	var opusRate int64
	for i, f := range v.AdaptiveFormats {
		rate, _ := strconv.ParseInt(f.Bitrate, 10, 64)
		switch {
		case strings.HasPrefix(f.Type, "audio/mp4") && strings.Contains(f.Type, "mp4a"):
			if best < 0 || rate > bestRate {
				best, bestRate = i, rate
			}
		case strings.HasPrefix(f.Type, "audio/webm"):
			if opus < 0 || rate > opusRate {
				opus, opusRate = i, rate
			}
		}
	}
	mime := "audio/mp4"
	if best < 0 {
		if opus < 0 {
			return ytAudio{}, errYTNoAudio
		}
		best, mime = opus, "audio/webm"
	}
	f := v.AdaptiveFormats[best]
	u, err := y.resolve(f.URL)
	if err != nil {
		return ytAudio{}, errYTNoAudio
	}
	size, _ := strconv.ParseInt(f.Clen, 10, 64)
	a = ytAudio{URL: u, Size: size, Mime: mime, at: time.Now()}
	y.mu.Lock()
	if len(y.formats) > 3000 {
		y.formats = map[string]ytAudio{}
	}
	y.formats[id] = a
	y.mu.Unlock()
	return a, nil
}

// resolve keeps only URLs on the Invidious origin (local=true).
func (y *YouTube) resolve(ref string) (string, error) {
	u, err := y.base.Parse(ref)
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(u.Host, y.base.Host) {
		// Invidious builds absolute URLs from its configured domain; serve
		// them from the address we know.
		if u.Path != "/videoplayback" && !strings.HasPrefix(u.Path, "/videoplayback") {
			return "", errors.New("off-origin stream url")
		}
		u.Scheme, u.Host = y.base.Scheme, y.base.Host
	}
	return u.String(), nil
}

func (y *YouTube) fetchRange(ctx context.Context, u string, from, to int64) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", from, to))
	// Streams can be slow to start; the client-level timeout would cut long reads.
	hc := &http.Client{Transport: y.hc.Transport, CheckRedirect: y.hc.CheckRedirect}
	for hop := 0; hop < 4; hop++ {
		resp, err := hc.Do(req)
		if err != nil {
			return nil, err
		}
		loc := resp.Header.Get("Location")
		if resp.StatusCode < 300 || resp.StatusCode >= 400 || loc == "" {
			return resp, nil
		}
		resp.Body.Close()
		next, err := req.URL.Parse(loc)
		if err != nil || !strings.EqualFold(next.Host, y.base.Host) {
			return nil, errors.New("redirect off Invidious")
		}
		req, _ = http.NewRequestWithContext(ctx, http.MethodGet, next.String(), nil)
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", from, to))
	}
	return nil, errors.New("too many redirects")
}

// ---- matching ----

// Candidate is a scored YouTube upload for a catalog track.
type Candidate struct {
	VideoID  string  `json:"videoId"`
	Title    string  `json:"title"`
	Author   string  `json:"author"`
	Duration int     `json:"duration"`
	Views    int64   `json:"views"`
	Score    float64 `json:"score"`
}

// Words that mark a different recording than the studio track, unless the
// catalog title has them too.
var variantWords = []string{"live", "concert", "концерт", "живое", "cover", "кавер", "karaoke", "караоке", "remix", "ремикс",
	"slowed", "sped up", "speed up", "reverb", "nightcore", "8d", "instrumental", "минус", "минусовка", "acoustic", "акустика",
	"reaction", "реакция", "tutorial", "урок", "разбор", "chords", "аккорды", "full album", "полный альбом", "mashup", "bass boosted",
	"extended", "edit", "version", "demo", "демо", "tiktok", "1 hour", "1 час", "loop"}

func containsWord(hay, w string) bool {
	return strings.Contains(" "+hay+" ", " "+w+" ")
}

func scoreCandidate(t *Track, it ytItem) float64 {
	title := normalize(it.Title)
	author := normalize(strings.TrimSuffix(it.Author, " - Topic"))
	artist := normalize(t.Artist)
	track := normalize(t.Title)
	full := normalize(t.Title + " " + t.Version)
	s := 0.0

	// Duration is the strongest signal: same recording ⇒ same length.
	if t.Duration > 0 {
		d := math.Abs(float64(it.LengthSeconds - t.Duration))
		switch {
		case d <= 2:
			s += 45
		case d <= 5:
			s += 35
		case d <= 10:
			s += 20
		case d <= 25:
			s += 0
		case d <= 60:
			s -= 25
		default:
			s -= 60
		}
	}
	if strings.HasSuffix(it.Author, " - Topic") && artist != "" && (author == artist || strings.Contains(author, artist) || strings.Contains(artist, author)) {
		s += 40 // YouTube Music's auto-generated "Artist - Topic" upload
	} else if artist != "" && (strings.Contains(author, artist) || strings.Contains(artist, author) && author != "") {
		s += 25
	} else if artist != "" && strings.Contains(title, artist) {
		s += 12
	}
	if track != "" {
		if strings.Contains(title, track) {
			s += 25
		} else {
			// partial: share of the title's words found
			words := strings.Fields(track)
			hit := 0
			for _, w := range words {
				if containsWord(title, w) {
					hit++
				}
			}
			if len(words) > 0 {
				s += 20 * float64(hit) / float64(len(words))
			}
			if hit == 0 {
				s -= 20
			}
		}
	}
	for _, w := range variantWords {
		if containsWord(title, w) && !containsWord(full, w) && !containsWord(normalize(t.Album), w) {
			s -= 22
		}
	}
	if containsWord(title, "official audio") || containsWord(title, "audio") {
		s += 4
	}
	if containsWord(title, "official video") || containsWord(title, "клип") || containsWord(title, "music video") {
		s -= 3 // often has an intro/outro
	}
	if it.ViewCount > 0 {
		s += math.Min(8, math.Log10(float64(it.ViewCount)))
	}
	return s
}

// Candidates searches YouTube for a catalog track and scores the results.
func (y *YouTube) Candidates(ctx context.Context, t *Track) ([]Candidate, error) {
	q := strings.TrimSpace(t.Artist + " - " + t.Title)
	if t.Version != "" && !strings.Contains(strings.ToLower(t.Title), strings.ToLower(t.Version)) {
		q += " " + t.Version
	}
	items, err := y.Search(ctx, q)
	if err != nil {
		return nil, err
	}
	out := make([]Candidate, 0, len(items))
	for i, it := range items {
		if i >= 20 {
			break
		}
		out = append(out, Candidate{VideoID: it.VideoID, Title: it.Title, Author: it.Author, Duration: it.LengthSeconds,
			Views: it.ViewCount, Score: scoreCandidate(t, it) - float64(i)*0.8})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	return out, nil
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
