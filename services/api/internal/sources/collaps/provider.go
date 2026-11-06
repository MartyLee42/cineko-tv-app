// Package collaps is the Collaps online provider (as used by the Lampa
// plugin online_mod): an embed page per Kinopoisk or IMDb id, no key,
//
//	GET {base}/embed/kp/<kp>   (or /embed/imdb/<tt>)
//
// whose inline makePlayer({...}) call carries one HLS master per film or
// episode with every voice-over as an EXT-X-MEDIA audio rendition (plus
// WebVTT subtitles). Cineko lists one variant per voice; when it is
// played, the playback proxy rewrites the master to keep only that audio
// rendition (sources.Stream.AudioTrack), because old TV engines can't
// switch HLS audio tracks. DASH (1080p) is ignored: TVs can't play it.
//
// The page is a JS object literal, not JSON; it is never evaluated — only
// the known keys whose values are JSON (seasons, audio, cc, qualityByWidth)
// or plain strings (hls, title) are read.
package collaps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
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
	ID = "collaps"
	// DefaultBaseURLs: the primary host and its mirror (tried on errors).
	DefaultBaseURLs = "https://api.nextembed.ws https://api.kinogram.best"

	requestTimeout = 10 * time.Second
	minInterval    = 250 * time.Millisecond
	maxBody        = 8 << 20 // long series pages are ~0.5 MB
	pageTTL        = 30 * time.Minute
	missTTL        = 30 * time.Minute
	cacheEntries   = 300
	hlsQuality     = 720 // the HLS ladder tops out at 720p (1080p is DASH-only)
	probeKP        = 301
)

// Provider implements sources.OnlineProvider (kind online).
type Provider struct {
	c *webfetch.Client

	mu    sync.RWMutex
	bases []string

	pages *webfetch.Cache[*page]
}

var _ sources.OnlineProvider = (*Provider)(nil)
var _ sources.Configurable = (*Provider)(nil)

// New builds the provider. baseURLs "" = DefaultBaseURLs (space/comma
// separated: primary first, then mirrors); hc nil = default client.
func New(baseURLs string, hc *http.Client) *Provider {
	p := &Provider{c: webfetch.New(hc, minInterval, requestTimeout, maxBody), pages: webfetch.NewCache[*page](cacheEntries)}
	p.setBases(baseURLs)
	return p
}

func (p *Provider) setBases(s string) {
	var bases []string
	for _, b := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == ';' }) {
		if b = strings.TrimRight(strings.TrimSpace(b), "/"); b != "" && !slices.Contains(bases, b) {
			bases = append(bases, b)
		}
	}
	if len(bases) == 0 {
		bases = strings.Fields(DefaultBaseURLs)
	}
	p.mu.Lock()
	p.bases = bases
	p.mu.Unlock()
}

func (p *Provider) baseURLs() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return slices.Clone(p.bases)
}

func (p *Provider) Info() sources.Info {
	return sources.Info{ID: ID, Kind: sources.KindOnline, Title: "Collaps", Configured: true}
}

// Configure applies the admin base URL override: "primary[, mirror…]".
func (p *Provider) Configure(c sources.Config) { p.setBases(c.BaseURL) }

// Probe looks up «Матрица» (kp 301).
func (p *Provider) Probe(ctx context.Context) error {
	pg, err := p.fetch(ctx, "kp/"+strconv.Itoa(probeKP), true)
	if err != nil {
		return err
	}
	if pg == nil || pg.Source == nil || pg.Source.HLS == "" {
		return errors.New("collaps: probe title has no stream")
	}
	return nil
}

// ---------------------------------------------------------------- page

type audio struct {
	Names []string `json:"names"`
	Order []int    `json:"order"`
}

type caption struct {
	URL  string `json:"url"`
	Name string `json:"name"`
}

type media struct {
	Episode  json.RawMessage `json:"episode"` // "1", 1 or "17-18" (a double episode)
	HLS      string          `json:"hls"`
	Audio    audio           `json:"audio"`
	CC       []caption       `json:"cc"`
	Duration float64         `json:"duration"`
	Title    string          `json:"title"`
}

type season struct {
	Season   int     `json:"season"`
	Blocked  bool    `json:"blocked"`
	Episodes []media `json:"episodes"`
}

// page is what we read from makePlayer({...}).
type page struct {
	Title          string
	Blocked        bool
	Source         *media   // films
	Seasons        []season // series
	QualityByWidth map[string]int
	Base           string // host that answered (Referer for streams)
}

var (
	reTitle   = regexp.MustCompile(`(?m)^\s*title:\s*"((?:[^"\\]|\\.)*)"`)
	reBlocked = regexp.MustCompile(`(?m)^\s*blocked:\s*true\b`)
	reHLS     = regexp.MustCompile(`\bhls:\s*"((?:[^"\\]|\\.)*)"`)
)

// jsonAfter decodes the JSON value that follows `key:` at or after from.
func jsonAfter(s, key string, from int, out any) bool {
	re := regexp.MustCompile(`\b` + regexp.QuoteMeta(key) + `:\s*`)
	loc := re.FindStringIndex(s[from:])
	if loc == nil {
		return false
	}
	dec := json.NewDecoder(strings.NewReader(s[from+loc[1]:]))
	dec.UseNumber()
	return dec.Decode(out) == nil
}

func unquote(s string) string {
	if u, err := strconv.Unquote(`"` + s + `"`); err == nil {
		return u
	}
	return s
}

// parsePage reads the makePlayer({...}) call. nil = no player on the page.
func parsePage(html string) (*page, error) {
	i := strings.Index(html, "makePlayer({")
	if i < 0 {
		return nil, nil
	}
	body := html[i:]
	if end := strings.Index(body, "});"); end > 0 {
		body = body[:end]
	}
	pg := &page{Blocked: reBlocked.MatchString(body)}
	if m := reTitle.FindStringSubmatch(body); m != nil {
		pg.Title = unquote(m[1])
	}
	_ = jsonAfter(body, "qualityByWidth", 0, &pg.QualityByWidth)
	if pi := strings.Index(body, "playlist:"); pi >= 0 {
		if !jsonAfter(body, "seasons", pi, &pg.Seasons) {
			return nil, fmt.Errorf("collaps: %w: unreadable playlist", webfetch.ErrUnavailable)
		}
		slices.SortStableFunc(pg.Seasons, func(a, b season) int { return a.Season - b.Season })
		return pg, nil
	}
	si := strings.Index(body, "source:")
	if si < 0 {
		return pg, nil
	}
	src := &media{}
	if m := reHLS.FindStringSubmatch(body[si:]); m != nil {
		src.HLS = unquote(m[1])
	}
	_ = jsonAfter(body, "audio", si, &src.Audio)
	_ = jsonAfter(body, "cc", si, &src.CC)
	pg.Source = src
	return pg, nil
}

// fetch loads /embed/<id> from the primary host, then mirrors on errors.
// A 404 (or a page without a player) is "not found" (nil, nil).
func (p *Provider) fetch(ctx context.Context, id string, fresh bool) (*page, error) {
	now := p.c.Now()
	if !fresh {
		if pg, ok := p.pages.Get(id, now); ok {
			return pg, nil
		}
	}
	var lastErr error
	for _, base := range p.baseURLs() {
		b, err := p.c.Get(ctx, base+"/embed/"+id, map[string]string{"Accept": "text/html", "Referer": base + "/"})
		if errors.Is(err, webfetch.ErrNotFound) {
			p.pages.Put(id, nil, now.Add(missTTL), now)
			return nil, nil
		}
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				break
			}
			continue
		}
		pg, err := parsePage(string(b))
		if err != nil {
			lastErr = err
			continue
		}
		if pg == nil || pg.Blocked {
			p.pages.Put(id, nil, now.Add(missTTL), now)
			return nil, nil
		}
		pg.Base = base
		p.pages.Put(id, pg, now.Add(pageTTL), now)
		return pg, nil
	}
	return nil, fmt.Errorf("collaps: %w", lastErr)
}

// lookup tries the Kinopoisk id, then the IMDb id.
func (p *Provider) lookup(ctx context.Context, t sources.Title) (*page, string, error) {
	var ids []string
	if t.KPID > 0 {
		ids = append(ids, "kp/"+strconv.Itoa(t.KPID))
	}
	if imdbRe.MatchString(t.IMDbID) {
		ids = append(ids, "imdb/"+t.IMDbID)
	}
	for _, id := range ids {
		pg, err := p.fetch(ctx, id, false)
		if err != nil {
			return nil, "", err
		}
		if pg != nil {
			return pg, id, nil
		}
	}
	return nil, "", nil
}

var imdbRe = regexp.MustCompile(`^tt\d{5,10}$`)

// ---------------------------------------------------------------- voices

// voice is one usable audio rendition of a media.
type voice struct {
	Track int    // 1-based position in the master's audio group
	Raw   string // name as Collaps spells it
	Label string // display label, unique within the media
	Kind  string
	Lang  string
}

func langOf(raw string) string {
	l := strings.ToLower(raw)
	switch {
	case strings.HasPrefix(l, "укр"):
		return "uk"
	case strings.HasPrefix(l, "eng"), strings.HasPrefix(l, "англ"):
		return "en"
	case strings.HasPrefix(l, "каз"):
		return "kk"
	}
	return "ru"
}

var rePrefix = regexp.MustCompile(`(?i)^(рус|укр|eng|англ|каз)\.?\s*`)

// label turns "Рус. Проф. многоголосый" into "Многоголосый" and keeps
// studio names ("НТВ", "П.Гланц и И.Королёва") as they are.
func label(raw string) (string, string) {
	kind := webfetch.VoiceKind(raw)
	if g := webfetch.GenericVoice(kind); g != "" {
		return g, kind
	}
	s := strings.TrimSpace(rePrefix.ReplaceAllString(strings.TrimSpace(raw), ""))
	if s == "" {
		s = strings.TrimSpace(raw)
	}
	return s, kind
}

// voices lists a media's audio renditions in the master's order, minus the
// placeholders Collaps marks "delete". Duplicate labels get " 2", " 3"…
func voices(m *media) []voice {
	var out []voice
	seen := map[string]int{}
	for i, raw := range m.Audio.Names {
		raw = strings.TrimSpace(raw)
		if raw == "" || strings.EqualFold(raw, "delete") {
			continue
		}
		l, kind := label(raw)
		lang := langOf(raw)
		if lang != "ru" && webfetch.GenericVoice(kind) != "" {
			l += " (" + lang + ")" // "Многоголосый (uk)", "Оригинал (en)"
		}
		key := lang + "|" + l
		seen[key]++
		if n := seen[key]; n > 1 {
			l += " " + strconv.Itoa(n)
		}
		out = append(out, voice{Track: i + 1, Raw: raw, Label: l, Kind: kind, Lang: lang})
	}
	return out
}

// episodes reads a media's episode number(s): "3" → [3], "17-18" → [17 18].
func (m *media) episodes() []int {
	s := strings.Trim(strings.TrimSpace(string(m.Episode)), `"`)
	a, b, isRange := strings.Cut(s, "-")
	from, err := strconv.Atoi(strings.TrimSpace(a))
	if err != nil || from < 1 {
		return nil
	}
	if !isRange {
		return []int{from}
	}
	to, err := strconv.Atoi(strings.TrimSpace(b))
	if err != nil || to < from || to-from > 5 {
		return []int{from}
	}
	out := []int{}
	for n := from; n <= to; n++ {
		out = append(out, n)
	}
	return out
}

func subtitleLangs(cc []caption) []string {
	out := []string{}
	for _, c := range cc {
		if l := langOf(c.Name); !slices.Contains(out, l) {
			out = append(out, l)
		}
	}
	return out
}

// ---------------------------------------------------------------- variants

// ref is the provider-private part of a variant: the embed id, the season
// (series) and the voice (its label, unique per media, plus the Collaps
// name, so a re-ordered audio list still finds it).
type ref struct {
	ID     string `json:"id"`
	Season int    `json:"s,omitempty"`
	Voice  string `json:"v"`
	Raw    string `json:"r"`
}

func (p *page) maxQuality() int {
	best := 0
	for _, q := range p.QualityByWidth {
		if q <= hlsQuality && q > best {
			best = q
		}
	}
	if best == 0 {
		best = hlsQuality
	}
	return best
}

// Variants implements sources.OnlineProvider.
func (p *Provider) Variants(ctx context.Context, t sources.Title) ([]sources.Variant, error) {
	pg, id, err := p.lookup(ctx, t)
	if err != nil {
		return nil, err
	}
	if pg == nil {
		return []sources.Variant{}, nil
	}
	q := pg.maxQuality()
	mk := func(m *media, vo voice, seasonN int) sources.Variant {
		b, _ := json.Marshal(ref{ID: id, Season: seasonN, Voice: vo.Label, Raw: vo.Raw})
		return sources.Variant{Provider: ID, Voice: vo.Label, VoiceKind: vo.Kind, Language: vo.Lang, MaxQuality: q,
			Qualities: []int{q}, Format: "hls", SubtitleLangs: subtitleLangs(m.CC), Season: seasonN, Ref: b}
	}
	out := []sources.Variant{}
	if t.Kind == "movie" {
		if pg.Source == nil || pg.Source.HLS == "" {
			return out, nil
		}
		for _, vo := range voices(pg.Source) {
			v := mk(pg.Source, vo, 0)
			v.Title = pg.Title
			out = append(out, v)
		}
		return out, nil
	}

	sn := t.Season
	if sn < 1 {
		sn = 1
	}
	var se *season
	for i := range pg.Seasons {
		if pg.Seasons[i].Season == sn && !pg.Seasons[i].Blocked {
			se = &pg.Seasons[i]
		}
	}
	if se == nil {
		return out, nil
	}
	// One variant per voice: the episodes that have it.
	byLabel := map[string]int{}
	for i := range se.Episodes {
		m := &se.Episodes[i]
		nums := m.episodes()
		if len(nums) == 0 || m.HLS == "" || t.Episode > 0 && !slices.Contains(nums, t.Episode) {
			continue
		}
		for _, vo := range voices(m) {
			j, ok := byLabel[vo.Lang+"|"+vo.Label]
			if !ok {
				v := mk(m, vo, sn)
				if t.Episode > 0 {
					v.Episode = t.Episode
					v.Title = m.Title
				}
				out = append(out, v)
				j = len(out) - 1
				byLabel[vo.Lang+"|"+vo.Label] = j
			}
			if t.Episode == 0 {
				for _, n := range nums {
					if !slices.Contains(out[j].Episodes, n) {
						out[j].Episodes = append(out[j].Episodes, n)
					}
				}
			}
		}
	}
	for i := range out {
		slices.Sort(out[i].Episodes)
	}
	return out, nil
}

// findMedia returns the film or the episode a variant points at.
func (p *Provider) findMedia(ctx context.Context, rf ref, episode int, fresh bool) (*page, *media, error) {
	pg, err := p.fetch(ctx, rf.ID, fresh)
	if err != nil {
		return nil, nil, err
	}
	if pg == nil {
		return nil, nil, fmt.Errorf("%w: title gone", sources.ErrNotFound)
	}
	if rf.Season == 0 {
		if pg.Source == nil || pg.Source.HLS == "" {
			return nil, nil, fmt.Errorf("%w: no stream", sources.ErrNotFound)
		}
		return pg, pg.Source, nil
	}
	for i := range pg.Seasons {
		if pg.Seasons[i].Season != rf.Season {
			continue
		}
		for j := range pg.Seasons[i].Episodes {
			m := &pg.Seasons[i].Episodes[j]
			if slices.Contains(m.episodes(), episode) && m.HLS != "" {
				return pg, m, nil
			}
		}
	}
	return nil, nil, fmt.Errorf("%w: episode not available", sources.ErrNotFound)
}

// pickVoice finds the variant's voice in a media: by label, then by the
// Collaps name.
func pickVoice(m *media, rf ref) (voice, bool) {
	vs := voices(m)
	for _, v := range vs {
		if v.Label == rf.Voice {
			return v, true
		}
	}
	for _, v := range vs {
		if v.Raw == rf.Raw {
			return v, true
		}
	}
	return voice{}, false
}

// Resolve implements sources.OnlineProvider: the HLS master (with the
// voice's audio track to keep) and the subtitles. quality is ignored: the
// master is adaptive.
func (p *Provider) Resolve(ctx context.Context, v sources.Variant, _ int) (*sources.Stream, error) {
	var rf ref
	if err := json.Unmarshal(v.Ref, &rf); err != nil || rf.ID == "" {
		return nil, fmt.Errorf("%w: bad ref", sources.ErrNotFound)
	}
	if rf.Season > 0 && v.Episode <= 0 {
		return nil, fmt.Errorf("%w: episode required", sources.ErrNotFound)
	}
	pg, m, err := p.findMedia(ctx, rf, v.Episode, false)
	if err != nil {
		return nil, err
	}
	vo, ok := pickVoice(m, rf)
	if !ok {
		return nil, fmt.Errorf("%w: voice not available for this episode", sources.ErrNotFound)
	}
	u := m.HLS
	if !strings.Contains(u, "&vp") && !strings.Contains(u, "?vp") {
		if strings.Contains(u, "?") {
			u += "&vp"
		} else {
			u += "?vp"
		}
	}
	st := &sources.Stream{URL: u, Format: "hls", Quality: pg.maxQuality(), AudioTrack: vo.Track, Duration: m.Duration,
		Headers: map[string]string{"Referer": pg.Base + "/", "Origin": pg.Base, "User-Agent": webfetch.UserAgent}}
	if ts := tParam(u); !ts.IsZero() {
		st.Expires = ts
	}
	for _, c := range m.CC {
		if c.URL == "" {
			continue
		}
		st.Subtitles = append(st.Subtitles, sources.Subtitle{URL: c.URL, Lang: langOf(c.Name), Label: strings.TrimSpace(c.Name)})
	}
	return st, nil
}

// tParam reads the `t=` expiry (unix seconds) of a Collaps CDN URL.
func tParam(u string) time.Time {
	i := strings.Index(u, "&t=")
	if i < 0 {
		i = strings.Index(u, "?t=")
	}
	if i < 0 {
		return time.Time{}
	}
	s := u[i+3:]
	if j := strings.IndexByte(s, '&'); j >= 0 {
		s = s[:j]
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 1e9 || n > 1e10 {
		return time.Time{}
	}
	return time.Unix(n, 0)
}

// Refresh drops the cached page behind a variant (after an upstream
// 403/410 the next Resolve fetches fresh URLs).
func (p *Provider) Refresh(v sources.Variant) {
	var rf ref
	if json.Unmarshal(v.Ref, &rf) == nil && rf.ID != "" {
		p.pages.Drop(rf.ID)
	}
}
