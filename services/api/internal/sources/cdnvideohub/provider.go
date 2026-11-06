// Package cdnvideohub is the CDNVideoHub online provider (the default
// balancer of the Lampa plugin online_mod): a public player API, no key,
// looked up by Kinopoisk id. Every voice-over is a separate VK Video upload
// with progressive MP4 renditions (144p…2160p) and HLS. Stream URLs are
// signed for the resolver's IP (srcIp) and expire after ~24 h, so playback
// always goes through the API's proxy (internal/playback).
//
//	GET {base}/playlist?pub=12&aggr=kp&id=<kp>  → {titleName,isSerial,items:[{vkId,voiceStudio,voiceType,season,episode}]}
//	GET {base}/video/<vkId>                     → {duration, sources:{mpeg*Url, hlsUrl, dashUrl}}
//
// The playlist also carries ads (VAST); they are ignored.
package cdnvideohub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"martytv/api/internal/sources"
	"martytv/api/internal/sources/internal/webfetch"
)

const (
	// ID is the provider id (profile settings, admin).
	ID = "cdnvideohub"
	// DefaultBaseURL is the player API (admin can override it).
	DefaultBaseURL = "https://plapi.cdnvideohub.com/api/v1/player/sv"

	requestTimeout = 10 * time.Second
	minInterval    = 150 * time.Millisecond
	maxBody        = 4 << 20
	playlistTTL    = 30 * time.Minute
	missTTL        = 10 * time.Minute
	videoTTL       = 6 * time.Hour // capped by the URLs' own expiry
	expirySlack    = 15 * time.Minute
	cacheEntries   = 1000
	maxProbeVideos = 6 // per lookup: videos fetched to learn qualities/duration
	probeKP        = 301
)

// Provider implements sources.OnlineProvider (kind online).
type Provider struct {
	c *webfetch.Client

	mu   sync.RWMutex
	base string

	playlists *webfetch.Cache[*playlist]
	videos    *webfetch.Cache[*video]
}

var _ sources.OnlineProvider = (*Provider)(nil)
var _ sources.Configurable = (*Provider)(nil)

// New builds the provider. baseURL "" = DefaultBaseURL; hc nil = default
// client (no redirects).
func New(baseURL string, hc *http.Client) *Provider {
	p := &Provider{c: webfetch.New(hc, minInterval, requestTimeout, maxBody),
		playlists: webfetch.NewCache[*playlist](cacheEntries), videos: webfetch.NewCache[*video](cacheEntries)}
	p.setBase(baseURL)
	return p
}

func (p *Provider) setBase(b string) {
	b = strings.TrimRight(strings.TrimSpace(b), "/")
	if b == "" {
		b = DefaultBaseURL
	}
	p.mu.Lock()
	p.base = b
	p.mu.Unlock()
}

func (p *Provider) baseURL() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.base
}

func (p *Provider) Info() sources.Info {
	return sources.Info{ID: ID, Kind: sources.KindOnline, Title: "CDNVideoHub", Configured: true}
}

// Configure applies the admin base URL override.
func (p *Provider) Configure(c sources.Config) { p.setBase(c.BaseURL) }

// Probe looks up «Матрица» (kp 301).
func (p *Provider) Probe(ctx context.Context) error {
	pl, err := p.fetchPlaylist(ctx, probeKP, true)
	if err != nil {
		return err
	}
	if len(pl.Items) == 0 {
		return errors.New("cdnvideohub: probe title returned no voices")
	}
	return nil
}

// ---------------------------------------------------------------- api

type item struct {
	VKID        json.Number `json:"vkId"`
	VoiceStudio string      `json:"voiceStudio"`
	VoiceType   string      `json:"voiceType"`
	Season      *int        `json:"season"`
	Episode     *int        `json:"episode"`
	Name        string      `json:"name"`
}

type playlist struct {
	TitleName string `json:"titleName"`
	IsSerial  bool   `json:"isSerial"`
	Items     []item `json:"items"`
}

type videoSources struct {
	HLS       string `json:"hlsUrl"`
	Mpeg2K    string `json:"mpeg2kUrl"` // 2160p (the API swaps the 2K/4K names)
	Mpeg4K    string `json:"mpeg4kUrl"` // 1440p
	MpegQHD   string `json:"mpegQhdUrl"`
	MpegFHD   string `json:"mpegFullHdUrl"`
	MpegHigh  string `json:"mpegHighUrl"`
	MpegMed   string `json:"mpegMediumUrl"`
	MpegLow   string `json:"mpegLowUrl"`
	MpegLeast string `json:"mpegLowestUrl"`
	MpegTiny  string `json:"mpegTinyUrl"`
}

type video struct {
	Duration float64      `json:"duration"`
	Sources  videoSources `json:"sources"`
}

// ladder lists the MP4 renditions, best first.
func (v *video) ladder() []rendition {
	s := v.Sources
	var out []rendition
	add := func(q int, u string) {
		if u == "" || slices.ContainsFunc(out, func(r rendition) bool { return r.q == q }) {
			return
		}
		out = append(out, rendition{q, u})
	}
	add(2160, s.Mpeg2K)
	add(1440, s.Mpeg4K)
	add(1440, s.MpegQHD)
	add(1080, s.MpegFHD)
	add(720, s.MpegHigh)
	add(480, s.MpegMed)
	add(360, s.MpegLow)
	add(240, s.MpegLeast)
	add(144, s.MpegTiny)
	return out
}

type rendition struct {
	q int
	u string
}

func qualitiesOf(r []rendition) []int {
	out := make([]int, 0, len(r))
	for _, x := range r {
		out = append(out, x.q)
	}
	return out
}

// expiry reads the VK `expires` parameter (milliseconds or seconds).
func expiry(u string) time.Time {
	pu, err := url.Parse(u)
	if err != nil {
		return time.Time{}
	}
	n, err := strconv.ParseInt(pu.Query().Get("expires"), 10, 64)
	if err != nil || n <= 0 {
		return time.Time{}
	}
	if n > 1e12 {
		return time.UnixMilli(n)
	}
	return time.Unix(n, 0)
}

func (p *Provider) fetchPlaylist(ctx context.Context, kp int, fresh bool) (*playlist, error) {
	key := strconv.Itoa(kp)
	now := p.c.Now()
	if !fresh {
		if pl, ok := p.playlists.Get(key, now); ok {
			return pl, nil
		}
	}
	u := p.baseURL() + "/playlist?" + url.Values{"pub": {"12"}, "aggr": {"kp"}, "id": {key}}.Encode()
	b, err := p.c.Get(ctx, u, map[string]string{"Accept": "application/json"})
	if errors.Is(err, webfetch.ErrNotFound) {
		pl := &playlist{}
		p.playlists.Put(key, pl, now.Add(missTTL), now)
		return pl, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cdnvideohub: %w", err)
	}
	var pl playlist
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	if err := dec.Decode(&pl); err != nil {
		return nil, fmt.Errorf("cdnvideohub: %w: bad json", webfetch.ErrUnavailable)
	}
	ttl := playlistTTL
	if len(pl.Items) == 0 {
		ttl = missTTL
	}
	p.playlists.Put(key, &pl, now.Add(ttl), now)
	return &pl, nil
}

func (p *Provider) fetchVideo(ctx context.Context, vkID string) (*video, error) {
	now := p.c.Now()
	if v, ok := p.videos.Get(vkID, now); ok {
		return v, nil
	}
	b, err := p.c.Get(ctx, p.baseURL()+"/video/"+url.PathEscape(vkID), map[string]string{"Accept": "application/json"})
	if errors.Is(err, webfetch.ErrNotFound) {
		return nil, fmt.Errorf("%w: video gone", sources.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("cdnvideohub: %w", err)
	}
	var v video
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, fmt.Errorf("cdnvideohub: %w: bad json", webfetch.ErrUnavailable)
	}
	until := now.Add(videoTTL)
	for _, r := range v.ladder() {
		if e := expiry(r.u); !e.IsZero() && e.Add(-expirySlack).Before(until) {
			until = e.Add(-expirySlack)
		}
	}
	p.videos.Put(vkID, &v, until, now)
	return &v, nil
}

// ---------------------------------------------------------------- variants

// ref is the provider-private part of a variant.
type ref struct {
	VK  string            `json:"vk,omitempty"`  // movie / one episode
	Eps map[string]string `json:"eps,omitempty"` // season variant: episode → vkId
}

func voiceOf(it item) (label, kind string) {
	kind = webfetch.VoiceKind(it.VoiceType)
	label = strings.TrimSpace(it.VoiceStudio)
	if label == "" {
		label = strings.TrimSpace(it.VoiceType)
		if g := webfetch.GenericVoice(kind); g != "" {
			label = g
		}
	}
	if label == "" {
		label = "CDNVideoHub"
	}
	return label, kind
}

// defaultLadder is shown when the per-video lookup failed.
var defaultLadder = []int{1080, 720, 480, 360}

// Variants implements sources.OnlineProvider.
func (p *Provider) Variants(ctx context.Context, t sources.Title) ([]sources.Variant, error) {
	if t.KPID <= 0 {
		return []sources.Variant{}, nil
	}
	pl, err := p.fetchPlaylist(ctx, t.KPID, false)
	if err != nil {
		return nil, err
	}
	movie := t.Kind == "movie"
	season := t.Season
	if !movie && season < 1 {
		season = 1
	}

	type group struct {
		v     sources.Variant
		first string // vkId used to learn qualities/duration
		eps   map[string]string
	}
	var groups []*group
	byVoice := map[string]*group{}
	for _, it := range pl.Items {
		vk := it.VKID.String()
		if vk == "" || vk == "0" {
			continue
		}
		if movie != (it.Season == nil) {
			continue // a series hit for a movie lookup or vice versa
		}
		if !movie && (*it.Season != season || it.Episode == nil || *it.Episode < 1) {
			continue
		}
		if !movie && t.Episode > 0 && *it.Episode != t.Episode {
			continue
		}
		label, kind := voiceOf(it)
		key := label
		if movie {
			key = label + "\x00" + vk // every upload is its own variant
		}
		g, ok := byVoice[key]
		if !ok {
			g = &group{v: sources.Variant{Provider: ID, Voice: label, VoiceKind: kind, Language: "ru", Format: "mp4",
				SubtitleLangs: []string{}, Title: strings.TrimSpace(pl.TitleName)}, first: vk, eps: map[string]string{}}
			if !movie {
				g.v.Season = season
				g.v.Episode = t.Episode
			}
			byVoice[key] = g
			groups = append(groups, g)
		}
		if !movie {
			e := strconv.Itoa(*it.Episode)
			if _, dup := g.eps[e]; !dup {
				g.eps[e] = vk
				g.v.Episodes = append(g.v.Episodes, *it.Episode)
			}
		}
	}

	// Learn real qualities from one video per voice (cached; bounded).
	var wg sync.WaitGroup
	for i, g := range groups {
		if i >= maxProbeVideos {
			break
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if v, err := p.fetchVideo(ctx, g.first); err == nil {
				if qs := qualitiesOf(v.ladder()); len(qs) > 0 {
					g.v.Qualities = qs
				} else if v.Sources.HLS != "" {
					g.v.Format = "hls"
				}
			}
		}()
	}
	wg.Wait()

	out := make([]sources.Variant, 0, len(groups))
	for _, g := range groups {
		v := g.v
		if len(v.Qualities) == 0 && v.Format == "mp4" {
			v.Qualities = slices.Clone(defaultLadder)
		}
		if len(v.Qualities) > 0 {
			v.MaxQuality = v.Qualities[0]
		}
		var rf ref
		switch {
		case movie || t.Episode > 0:
			rf.VK = g.first
			v.Episodes = nil
		default:
			slices.Sort(v.Episodes)
			rf.Eps = g.eps
		}
		v.Ref, _ = json.Marshal(rf)
		out = append(out, v)
	}
	return out, nil
}

// vkFor narrows a variant to the upload to play.
func vkFor(v sources.Variant) (string, error) {
	var rf ref
	if err := json.Unmarshal(v.Ref, &rf); err != nil {
		return "", fmt.Errorf("%w: bad ref", sources.ErrNotFound)
	}
	if rf.VK != "" {
		return rf.VK, nil
	}
	if v.Episode <= 0 {
		return "", fmt.Errorf("%w: episode required", sources.ErrNotFound)
	}
	vk, ok := rf.Eps[strconv.Itoa(v.Episode)]
	if !ok {
		return "", fmt.Errorf("%w: episode not available", sources.ErrNotFound)
	}
	return vk, nil
}

// Resolve implements sources.OnlineProvider: the MP4 rendition closest to
// the requested quality (0 = best), else the HLS master.
func (p *Provider) Resolve(ctx context.Context, v sources.Variant, quality int) (*sources.Stream, error) {
	vk, err := vkFor(v)
	if err != nil {
		return nil, err
	}
	vid, err := p.fetchVideo(ctx, vk)
	if err != nil {
		return nil, err
	}
	// The CDN binds each URL to the resolver's IP and User-Agent (srcIp,
	// srcAg): the proxy must fetch it with the same UA or the CDN answers 400.
	st := &sources.Stream{Headers: map[string]string{"User-Agent": webfetch.UserAgent}, Duration: vid.Duration}
	lad := vid.ladder()
	if q := webfetch.ChooseQuality(qualitiesOf(lad), quality); q > 0 {
		for _, r := range lad {
			if r.q == q {
				st.URL, st.Format, st.Quality = r.u, "mp4", q
				break
			}
		}
	} else if vid.Sources.HLS != "" {
		st.URL, st.Format = vid.Sources.HLS, "hls"
	} else {
		return nil, fmt.Errorf("%w: no stream", sources.ErrNotFound)
	}
	st.Expires = expiry(st.URL)
	return st, nil
}

// Refresh drops the cached video behind a variant (after an upstream
// 403/410 the next Resolve fetches freshly signed URLs).
func (p *Provider) Refresh(v sources.Variant) {
	if vk, err := vkFor(v); err == nil {
		p.videos.Drop(vk)
	}
}
