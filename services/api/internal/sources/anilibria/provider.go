// Package anilibria is the AniLiberty (AniLibria) anime provider: the
// studio's public API (api.anilibria.app/api/v1, no key) maps TMDB titles
// to releases and returns per-episode HLS playlists (480/720/1080) voiced by
// AniLibria. Streams are proxied by the playback package.
package anilibria

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"martytv/api/internal/sources"
)

const (
	// ID is the provider id (profile settings, admin).
	ID = "anilibria"
	// Studio is the voice-over studio shown on variants; it is spelled like
	// the releases package's known studio so both render alike.
	Studio = "AniLibria"

	mappingTTL     = 24 * time.Hour
	mappingMissTTL = time.Hour
	maxChain       = 4 // releases followed for absolute episode numbers
	genreAnimation = 16
)

// Provider implements sources.OnlineProvider (kind anime).
type Provider struct {
	c *client

	mu       sync.Mutex
	mappings map[string]mappingEntry
}

type mappingEntry struct {
	chain []int // matched release first, then later seasons of the show
	exp   time.Time
}

// New builds the provider. baseURL "" = DefaultBaseURL; hc nil = default
// client (10 s timeout, no redirects).
func New(baseURL string, hc *http.Client) *Provider {
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	return &Provider{c: newClient(baseURL, hc), mappings: map[string]mappingEntry{}}
}

var _ sources.OnlineProvider = (*Provider)(nil)
var _ sources.Configurable = (*Provider)(nil)

func (p *Provider) Info() sources.Info {
	return sources.Info{ID: ID, Kind: sources.KindAnime, Title: "AniLiberty", Configured: true}
}

// Configure applies an admin base URL override (credentials unused).
func (p *Provider) Configure(c sources.Config) {
	base := strings.TrimSpace(c.BaseURL)
	if base == "" {
		base = DefaultBaseURL
	}
	p.c.setBase(base)
}

// Probe searches a fixed, long-running title.
func (p *Provider) Probe(ctx context.Context) error {
	var out []apiRelease
	if err := p.c.getJSON(ctx, "/app/search/releases", map[string][]string{"query": {"Магическая битва"}}, &out); err != nil {
		return err
	}
	if len(out) == 0 {
		return errors.New("anilibria: probe search returned nothing")
	}
	return nil
}

// ref is the provider-private part of a variant.
type ref struct {
	Release int              `json:"r,omitempty"`
	Episode string           `json:"e,omitempty"` // AniLiberty episode uuid
	Ordinal float64          `json:"o,omitempty"`
	Eps     map[string]epRef `json:"eps,omitempty"` // season variant: TMDB episode → episode
}

type epRef struct {
	Release int     `json:"r"`
	Episode string  `json:"e"`
	Ordinal float64 `json:"o"`
}

// isAnime gates lookups: only TMDB Animation (16) from JP/CN/KR (or an
// unknown language) is searched, so ordinary titles cost no API calls.
func isAnime(t sources.Title) bool {
	if !slices.Contains(t.Genres, genreAnimation) {
		return false
	}
	switch strings.ToLower(t.OriginalLanguage) {
	case "", "ja", "zh", "ko", "cn":
		return true
	}
	return false
}

func mappingKey(t sources.Title, season int) string {
	return fmt.Sprintf("%s|%d|%d|%s|%s|%s", t.Kind, t.Year, season, norm(t.TitleRU), norm(t.TitleEN), norm(t.Original))
}

// match finds the release chain for a title and season (cached).
func (p *Provider) match(ctx context.Context, t sources.Title, season int) ([]int, error) {
	key := mappingKey(t, season)
	now := p.c.now()
	p.mu.Lock()
	if e, ok := p.mappings[key]; ok && now.Before(e.exp) {
		p.mu.Unlock()
		return e.chain, nil
	}
	p.mu.Unlock()

	movie := t.Kind == "movie"
	tg := newTarget(movie, []string{t.TitleRU, t.TitleEN, t.Original}, t.Year, season)
	if len(tg.Titles) == 0 {
		return nil, nil
	}
	queries := uniq([]string{strings.TrimSpace(t.TitleRU), strings.TrimSpace(t.TitleEN)})
	if o := strings.TrimSpace(t.Original); o != "" && isLatin(o) {
		queries = uniq(append(queries, o))
	}
	var cands []candidate
	var result []int
	var lastErr error
	for _, q := range queries {
		hits, err := p.c.search(ctx, q)
		if err != nil {
			lastErr = err
			continue
		}
		for i := range hits {
			cands = append(cands, newCandidate(&hits[i]))
		}
		if m, ok := tg.pick(cands); ok {
			result = []int{m.ID}
			if !movie {
				result = result[:0]
				for _, c := range chain(m, cands) {
					result = append(result, c.ID)
					if len(result) == maxChain {
						break
					}
				}
				if len(result) == 0 {
					result = []int{m.ID}
				}
			}
			break
		}
	}
	if result == nil && lastErr != nil {
		// Do not cache a failure as "not found".
		return nil, lastErr
	}
	ttl := mappingTTL
	if result == nil {
		ttl = mappingMissTTL
	}
	p.mu.Lock()
	if len(p.mappings) >= cacheMaxEntries {
		p.mappings = map[string]mappingEntry{}
	}
	p.mappings[key] = mappingEntry{chain: result, exp: now.Add(ttl)}
	p.mu.Unlock()
	return result, nil
}

func isLatin(s string) bool {
	for _, r := range s {
		if r > 0x24F {
			return false
		}
	}
	return true
}

// episodes returns the integer-numbered playable episodes of a release,
// keyed by ordinal.
func playable(r *apiRelease) map[int]*apiEpisode {
	out := map[int]*apiEpisode{}
	for i := range r.Episodes {
		e := &r.Episodes[i]
		if e.Ordinal < 1 || e.Ordinal != math.Trunc(e.Ordinal) || len(qualities(e)) == 0 {
			continue
		}
		k := int(e.Ordinal)
		if _, dup := out[k]; !dup {
			out[k] = e
		}
	}
	return out
}

func qualities(e *apiEpisode) []int {
	var q []int
	if e.HLS1080 != "" {
		q = append(q, 1080)
	}
	if e.HLS720 != "" {
		q = append(q, 720)
	}
	if e.HLS480 != "" {
		q = append(q, 480)
	}
	return q
}

func urlFor(e *apiEpisode, q int) string {
	switch q {
	case 1080:
		return e.HLS1080
	case 720:
		return e.HLS720
	case 480:
		return e.HLS480
	}
	return ""
}

func variantFor(r *apiRelease, e *apiEpisode, season, episode int, rf ref) sources.Variant {
	qs := qualities(e)
	b, _ := json.Marshal(rf)
	title := strings.TrimSpace(e.Name)
	if title == "" {
		title = r.Name.Main
	}
	v := sources.Variant{
		Provider: ID, Voice: Studio, VoiceKind: "mvo", Language: "ru",
		Qualities: qs, Format: "hls", SubtitleLangs: []string{},
		Season: season, Episode: episode, Title: title, Ref: b,
	}
	if len(qs) > 0 {
		v.MaxQuality = qs[0]
	}
	return v
}

// Variants implements sources.OnlineProvider.
func (p *Provider) Variants(ctx context.Context, t sources.Title) ([]sources.Variant, error) {
	if !isAnime(t) {
		return []sources.Variant{}, nil
	}
	movie := t.Kind == "movie"
	season := t.Season
	if !movie && season < 1 {
		season = 1
	}
	ids, err := p.match(ctx, t, season)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return []sources.Variant{}, nil
	}
	first, err := p.c.release(ctx, ids[0], false)
	if errors.Is(err, errNotFound) {
		return []sources.Variant{}, nil
	}
	if err != nil {
		return nil, err
	}
	eps := playable(first)

	if movie {
		e := lowest(eps)
		if e == nil {
			return []sources.Variant{}, nil
		}
		return []sources.Variant{variantFor(first, e, 0, 0, ref{Release: first.ID, Episode: e.ID, Ordinal: e.Ordinal})}, nil
	}

	if t.Episode > 0 {
		r, e, err := p.episode(ctx, ids, first, eps, t.Episode)
		if err != nil {
			return nil, err
		}
		if e == nil {
			return []sources.Variant{}, nil
		}
		return []sources.Variant{variantFor(r, e, season, t.Episode, ref{Release: r.ID, Episode: e.ID, Ordinal: e.Ordinal})}, nil
	}

	// Whole season: one variant (one voice) listing the episodes.
	if len(eps) == 0 {
		return []sources.Variant{}, nil
	}
	nums := make([]int, 0, len(eps))
	rf := ref{Release: first.ID, Eps: map[string]epRef{}}
	best := map[int]bool{}
	for k, e := range eps {
		nums = append(nums, k)
		rf.Eps[strconv.Itoa(k)] = epRef{Release: first.ID, Episode: e.ID, Ordinal: e.Ordinal}
		for _, q := range qualities(e) {
			best[q] = true
		}
	}
	slices.Sort(nums)
	v := variantFor(first, eps[nums[0]], season, 0, rf)
	v.Title = first.Name.Main
	v.Episodes = nums
	v.Qualities = v.Qualities[:0]
	for _, q := range []int{1080, 720, 480} {
		if best[q] {
			v.Qualities = append(v.Qualities, q)
		}
	}
	if len(v.Qualities) > 0 {
		v.MaxQuality = v.Qualities[0]
	}
	return []sources.Variant{v}, nil
}

func lowest(eps map[int]*apiEpisode) *apiEpisode {
	best := -1
	for k := range eps {
		if best < 0 || k < best {
			best = k
		}
	}
	if best < 0 {
		return nil
	}
	return eps[best]
}

// episode maps a TMDB episode number to a release episode: directly in the
// matched release, or past its end into later seasons of the chain
// (absolute numbering, as TMDB often lumps several cours into one season).
func (p *Provider) episode(ctx context.Context, ids []int, first *apiRelease, eps map[int]*apiEpisode, n int) (*apiRelease, *apiEpisode, error) {
	if e, ok := eps[n]; ok {
		return first, e, nil
	}
	offset := maxKey(eps)
	if offset == 0 || n <= offset || len(eps) != offset {
		// Gaps (not yet released) or unknown count: no absolute mapping.
		return nil, nil, nil
	}
	for _, id := range ids[1:] {
		r, err := p.c.release(ctx, id, false)
		if err != nil {
			if errors.Is(err, errNotFound) {
				return nil, nil, nil
			}
			return nil, nil, err
		}
		next := playable(r)
		if e, ok := next[n-offset]; ok {
			return r, e, nil
		}
		m := maxKey(next)
		if m == 0 || len(next) != m {
			return nil, nil, nil
		}
		offset += m
	}
	return nil, nil, nil
}

func maxKey(m map[int]*apiEpisode) int {
	k := 0
	for x := range m {
		k = max(k, x)
	}
	return k
}

// errNoStream is returned by Resolve when the episode or quality vanished.
var errNoStream = fmt.Errorf("%w: episode not available", sources.ErrNotFound)

func (p *Provider) findEpisode(ctx context.Context, rf ref, fresh bool) (*apiEpisode, error) {
	r, err := p.c.release(ctx, rf.Release, fresh)
	if errors.Is(err, errNotFound) {
		return nil, errNoStream
	}
	if err != nil {
		return nil, err
	}
	for i := range r.Episodes {
		if e := &r.Episodes[i]; e.ID == rf.Episode && rf.Episode != "" {
			return e, nil
		}
	}
	for i := range r.Episodes {
		if e := &r.Episodes[i]; e.Ordinal == rf.Ordinal && rf.Ordinal > 0 {
			return e, nil
		}
	}
	return nil, errNoStream
}

// pickRef narrows a season variant to its episode.
func pickRef(v sources.Variant) (ref, error) {
	var rf ref
	if err := json.Unmarshal(v.Ref, &rf); err != nil {
		return rf, fmt.Errorf("%w: bad ref", sources.ErrNotFound)
	}
	if len(rf.Eps) > 0 {
		if v.Episode <= 0 {
			return rf, fmt.Errorf("%w: episode required", sources.ErrNotFound)
		}
		e, ok := rf.Eps[strconv.Itoa(v.Episode)]
		if !ok {
			return rf, errNoStream
		}
		return ref{Release: e.Release, Episode: e.Episode, Ordinal: e.Ordinal}, nil
	}
	if rf.Release == 0 {
		return rf, fmt.Errorf("%w: bad ref", sources.ErrNotFound)
	}
	return rf, nil
}

// Resolve implements sources.OnlineProvider: the episode's HLS playlist at
// the requested quality (exact, else the best below, else the lowest above;
// 0 = best). AniLiberty URLs carry no signature, so Expires is zero; a
// cached release older than releaseTTL is refetched.
func (p *Provider) Resolve(ctx context.Context, v sources.Variant, quality int) (*sources.Stream, error) {
	rf, err := pickRef(v)
	if err != nil {
		return nil, err
	}
	e, err := p.findEpisode(ctx, rf, false)
	if err != nil {
		return nil, err
	}
	q := chooseQuality(qualities(e), quality)
	if q == 0 {
		return nil, errNoStream
	}
	return &sources.Stream{URL: urlFor(e, q), Format: "hls", Quality: q, Headers: map[string]string{}}, nil
}

// Refresh drops the cached release behind a variant so the next Resolve
// fetches fresh URLs (called by playback after an upstream 403/404).
func (p *Provider) Refresh(v sources.Variant) {
	if rf, err := pickRef(v); err == nil {
		p.c.releases.drop(strconv.Itoa(rf.Release))
	}
}

func chooseQuality(have []int, want int) int {
	if len(have) == 0 {
		return 0
	}
	if want <= 0 {
		return have[0]
	}
	for _, q := range have { // descending
		if q <= want {
			return q
		}
	}
	return have[len(have)-1]
}

// SkipMarkers returns the episode's opening/ending ranges in seconds
// ("opening"/"ending" → [start, stop]) when AniLiberty has them.
func (p *Provider) SkipMarkers(ctx context.Context, v sources.Variant) map[string][2]float64 {
	rf, err := pickRef(v)
	if err != nil {
		return nil
	}
	e, err := p.findEpisode(ctx, rf, false)
	if err != nil {
		return nil
	}
	out := map[string][2]float64{}
	for name, m := range map[string]*apiMarker{"opening": e.Opening, "ending": e.Ending} {
		if m != nil && m.Start != nil && m.Stop != nil && *m.Stop > *m.Start && *m.Start >= 0 {
			out[name] = [2]float64{*m.Start, *m.Stop}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
