// Package video is the YouTube «Видео» tab: a typed client for a
// self-hosted Invidious (+ invidious-companion) instance on the internal
// network, cached catalog endpoints (/video/*), per-profile subscriptions,
// «Смотреть позже», history with resume positions, and the thumbnail proxy.
// Streams are served by internal/playback (video.go) through the
// VideoProvider this package implements. See docs/architecture.md
// "Video (Invidious)".
package video

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Errors returned by the client.
var (
	// ErrNotConfigured: INVIDIOUS_URL is not set.
	ErrNotConfigured = errors.New("invidious not configured")
	// ErrNotFound: Invidious answered 404 (unknown video/channel/playlist).
	ErrNotFound = errors.New("not found")
)

// UpstreamError is any other Invidious failure (network, 5xx, bad JSON).
type UpstreamError struct {
	Status int    // 0 = network error
	Msg    string // short, safe to show admins
}

func (e *UpstreamError) Error() string {
	if e.Status == 0 {
		return "invidious unreachable: " + e.Msg
	}
	return fmt.Sprintf("invidious %d: %s", e.Status, e.Msg)
}

// Cache TTLs (task: search 10 min, trending 30 min, video 6 h).
const (
	ttlSearch      = 10 * time.Minute
	ttlSuggestions = time.Hour
	ttlTrending    = 30 * time.Minute
	ttlChannel     = 30 * time.Minute
	ttlPlaylist    = 30 * time.Minute
	ttlVideo       = 6 * time.Hour
	// Stream URLs inside a video expire (YouTube: ~6 h, `expire` param);
	// a cached video is dropped this long before they do.
	streamSlack = 30 * time.Minute

	maxResponseBytes = 8 << 20
	maxCacheEntries  = 1500
)

// Client talks to the Invidious API (/api/v1/*) on the internal network.
type Client struct {
	base *url.URL // nil = not configured
	hc   *http.Client

	mu    sync.Mutex
	cache map[string]cacheEntry

	// onResult reports every call's outcome (health card).
	onResult func(err error)

	// lang (hl) and region (gl) sent with every API call; see SetLocale.
	lang, region string

	// Original (untranslated) titles and channel names, see originals.go.
	orig originals
}

type cacheEntry struct {
	v     any
	until time.Time
}

// NewClient returns a client for base (e.g. http://invidious:3000); an
// empty base gives a client whose every call fails with ErrNotConfigured.
func NewClient(base string, hc *http.Client) (*Client, error) {
	c := &Client{hc: hc, cache: map[string]cacheEntry{}, lang: DefaultLang}
	if hc == nil {
		c.hc = newInternalClient()
	}
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return c, nil
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return nil, errors.New("INVIDIOUS_URL must be an http(s) URL without credentials")
	}
	c.base = u
	return c, nil
}

// newInternalClient: Invidious lives on the internal docker network, so no
// public-address dial check; redirects are handled by callers.
func newInternalClient() *http.Client {
	d := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Client{
		Timeout: 25 * time.Second,
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           d.DialContext,
			MaxIdleConnsPerHost:   16,
			IdleConnTimeout:       90 * time.Second,
			ResponseHeaderTimeout: 20 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// DefaultLang is the hl sent to Invidious unless SetLocale says otherwise.
const DefaultLang = "ru"

// SetLocale sets the interface language (`hl`, sent with every /api/v1
// call: Invidious localizes its own strings such as "2 дня назад") and the
// region (`region`, sent where Invidious uses it: search, trending, videos).
// Call before use. Note: Invidious' innertube context is always hl=en, so
// list titles stay YouTube's auto-translations whatever hl says; originals
// (RSS + video details) restore them.
func (c *Client) SetLocale(lang, region string) {
	c.lang = strings.ToLower(strings.TrimSpace(lang))
	c.region = strings.ToUpper(strings.TrimSpace(region))
}

// Configured reports whether INVIDIOUS_URL is set.
func (c *Client) Configured() bool { return c.base != nil }

// Base is the Invidious base URL (nil when not configured).
func (c *Client) Base() *url.URL { return c.base }

// SameOrigin reports whether u points at the Invidious instance (scheme,
// host and port). Stream/caption/thumbnail fetches use only such URLs.
func (c *Client) SameOrigin(u *url.URL) bool {
	return c.base != nil && u != nil && u.Scheme == c.base.Scheme && strings.EqualFold(u.Host, c.base.Host) && u.User == nil
}

// Resolve turns a path (or an absolute URL Invidious gave us) into an
// absolute URL on the instance; foreign hosts are refused.
func (c *Client) Resolve(ref string) (*url.URL, error) {
	if c.base == nil {
		return nil, ErrNotConfigured
	}
	r, err := url.Parse(ref)
	if err != nil {
		return nil, err
	}
	abs := c.base.ResolveReference(r)
	if !c.SameOrigin(abs) {
		return nil, errors.New("foreign url refused")
	}
	return abs, nil
}

// HTTP is the client used for every Invidious request (streams too).
func (c *Client) HTTP() *http.Client { return c.hc }

func (c *Client) cached(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.cache[key]
	if !ok || time.Now().After(e.until) {
		return nil, false
	}
	return e.v, true
}

func (c *Client) store(key string, v any, ttl time.Duration) {
	if ttl <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.cache) >= maxCacheEntries {
		now := time.Now()
		for k, e := range c.cache {
			if now.After(e.until) {
				delete(c.cache, k)
			}
		}
		for k := range c.cache { // still full: drop an arbitrary half
			if len(c.cache) < maxCacheEntries/2 {
				break
			}
			delete(c.cache, k)
		}
	}
	c.cache[key] = cacheEntry{v: v, until: time.Now().Add(ttl)}
}

// Forget drops one cached key (e.g. a video whose stream URLs went stale).
func (c *Client) Forget(key string) {
	c.mu.Lock()
	delete(c.cache, key)
	c.mu.Unlock()
}

// getJSON GETs /api/v1/<path>?q into out (with hl added).
func (c *Client) getJSON(ctx context.Context, path string, q url.Values, out any) error {
	if c.lang != "" && q.Get("hl") == "" {
		q2 := url.Values{}
		for k, v := range q {
			q2[k] = v
		}
		q2.Set("hl", c.lang)
		q = q2
	}
	return c.get(ctx, "/api/v1/"+path, q, "application/json", func(body []byte) error { return json.Unmarshal(body, out) }, "invalid JSON")
}

// get GETs <base><path>?q and decodes a 200 body; errors are mapped to
// ErrNotFound / *UpstreamError and reported to onResult.
func (c *Client) get(ctx context.Context, path string, q url.Values, accept string, decode func([]byte) error, badBody string) (err error) {
	if c.base == nil {
		return ErrNotConfigured
	}
	defer func() {
		if c.onResult != nil && !errors.Is(err, ErrNotFound) && ctx.Err() == nil {
			c.onResult(err)
		}
	}()
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", accept)
	resp, err := c.hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &UpstreamError{Msg: shortNetErr(err)}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return &UpstreamError{Status: resp.StatusCode, Msg: "read failed"}
	}
	if len(body) > maxResponseBytes {
		return &UpstreamError{Status: resp.StatusCode, Msg: "response too large"}
	}
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		msg := clip(e.Error, 200)
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		// Invidious answers 500 "This video is unavailable" / "Video unavailable"
		// for removed or private videos and 4xx for bad ids.
		if l := strings.ToLower(msg); resp.StatusCode < 500 || strings.Contains(l, "unavailable") ||
			strings.Contains(l, "does not exist") || strings.Contains(l, "private") || strings.Contains(l, "removed") {
			return &notFoundError{msg: msg}
		}
		return &UpstreamError{Status: resp.StatusCode, Msg: msg}
	}
	if err := decode(body); err != nil {
		return &UpstreamError{Status: resp.StatusCode, Msg: badBody}
	}
	return nil
}

// notFoundError is ErrNotFound with Invidious' reason.
type notFoundError struct{ msg string }

func (e *notFoundError) Error() string { return "not found: " + e.msg }
func (e *notFoundError) Unwrap() error { return ErrNotFound }

func shortNetErr(err error) string {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout"
	}
	var oe *net.OpError
	if errors.As(err, &oe) {
		return oe.Op + " " + oe.Err.Error()
	}
	return clip(err.Error(), 160)
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

// cachedJSON is getJSON behind the TTL cache.
func cachedJSON[T any](ctx context.Context, c *Client, ttl time.Duration, path string, q url.Values) (T, error) {
	key := path + "?" + q.Encode()
	if v, ok := c.cached(key); ok {
		return v.(T), nil
	}
	var out T
	if err := c.getJSON(ctx, path, q, &out); err != nil {
		return out, err
	}
	c.store(key, out, ttl)
	return out, nil
}

// ---- Invidious API wire types (only the fields Cineko uses) ----

type ivThumb struct {
	Quality string `json:"quality"`
	URL     string `json:"url"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
}

// flexInt accepts 123, "123" or "" (Invidious mixes them).
type flexInt int64

func (f *flexInt) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		*f = 0
		return nil
	}
	*f = flexInt(n)
	return nil
}

// flexTime accepts a unix timestamp or an RFC 3339 string (related videos).
type flexTime int64

func (f *flexTime) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		*f = flexTime(n)
		return nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		*f = flexTime(t.Unix())
		return nil
	}
	*f = 0
	return nil
}

// ivItem is a search/trending/channel/related entry (video, channel or playlist).
type ivItem struct {
	Type             string    `json:"type"`
	Title            string    `json:"title"`
	VideoID          string    `json:"videoId"`
	Author           string    `json:"author"`
	AuthorID         string    `json:"authorId"`
	AuthorVerified   bool      `json:"authorVerified"`
	AuthorThumbnails []ivThumb `json:"authorThumbnails"`
	VideoThumbnails  []ivThumb `json:"videoThumbnails"`
	ViewCount        flexInt   `json:"viewCount"`
	ViewCountText    string    `json:"viewCountText"`
	Published        flexTime  `json:"published"`
	PublishedText    string    `json:"publishedText"`
	LengthSeconds    flexInt   `json:"lengthSeconds"`
	LiveNow          bool      `json:"liveNow"`
	IsUpcoming       bool      `json:"isUpcoming"`
	// channel results
	SubCount    flexInt `json:"subCount"`
	VideoCount  flexInt `json:"videoCount"`
	Description string  `json:"description"`
	// playlist results
	PlaylistID        string `json:"playlistId"`
	PlaylistThumbnail string `json:"playlistThumbnail"`
}

type ivFormat struct {
	URL          string  `json:"url"`
	Itag         flexInt `json:"itag"`
	Type         string  `json:"type"` // `video/mp4; codecs="avc1.4D401F"`
	Init         string  `json:"init"` // "0-739"
	Index        string  `json:"index"`
	Clen         flexInt `json:"clen"`
	Bitrate      flexInt `json:"bitrate"`
	Size         string  `json:"size"` // "1280x720"
	QualityLabel string  `json:"qualityLabel"`
	FPS          int     `json:"fps"`
	Container    string  `json:"container"`
	Encoding     string  `json:"encoding"`
	AudioQuality string  `json:"audioQuality"`
}

type ivCaption struct {
	Label        string `json:"label"`
	LanguageCode string `json:"language_code"`
	URL          string `json:"url"`
}

type ivVideo struct {
	ivItem
	DescriptionFull  string      `json:"description"`
	LikeCount        flexInt     `json:"likeCount"`
	SubCountText     string      `json:"subCountText"`
	Genre            string      `json:"genre"`
	HLSURL           string      `json:"hlsUrl"`
	AdaptiveFormats  []ivFormat  `json:"adaptiveFormats"`
	FormatStreams    []ivFormat  `json:"formatStreams"`
	Captions         []ivCaption `json:"captions"`
	RecommendedVideo []ivItem    `json:"recommendedVideos"`
	PremiereTS       flexInt     `json:"premiereTimestamp"`
}

type ivChannel struct {
	Author           string    `json:"author"`
	AuthorID         string    `json:"authorId"`
	AuthorVerified   bool      `json:"authorVerified"`
	AuthorBanners    []ivThumb `json:"authorBanners"`
	AuthorThumbnails []ivThumb `json:"authorThumbnails"`
	SubCount         flexInt   `json:"subCount"`
	Description      string    `json:"description"`
	LatestVideos     []ivItem  `json:"latestVideos"`
}

type ivChannelVideos struct {
	Videos       []ivItem `json:"videos"`
	Continuation string   `json:"continuation"`
}

type ivPlaylist struct {
	Title       string   `json:"title"`
	PlaylistID  string   `json:"playlistId"`
	Author      string   `json:"author"`
	AuthorID    string   `json:"authorId"`
	Description string   `json:"description"`
	VideoCount  flexInt  `json:"videoCount"`
	Thumbnail   string   `json:"playlistThumbnail"`
	Videos      []ivItem `json:"videos"`
}

type ivSuggestions struct {
	Suggestions []string `json:"suggestions"`
}

// Stats is /api/v1/stats (software version for the admin card).
type Stats struct {
	Software struct {
		Name    string `json:"name"`
		Version string `json:"version"`
		Branch  string `json:"branch"`
	} `json:"software"`
}

// ---- calls ----

func (c *Client) Search(ctx context.Context, q, typ string, page int, region string) ([]ivItem, error) {
	v := url.Values{"q": {q}, "type": {typ}, "page": {strconv.Itoa(page)}}
	if region != "" {
		v.Set("region", region)
	}
	return cachedJSON[[]ivItem](ctx, c, ttlSearch, "search", v)
}

func (c *Client) Suggestions(ctx context.Context, q string) ([]string, error) {
	s, err := cachedJSON[ivSuggestions](ctx, c, ttlSuggestions, "search/suggestions", url.Values{"q": {q}})
	return s.Suggestions, err
}

func (c *Client) Trending(ctx context.Context, region, typ string) ([]ivItem, error) {
	v := url.Values{"region": {region}}
	if typ != "" {
		v.Set("type", typ)
	}
	return cachedJSON[[]ivItem](ctx, c, ttlTrending, "trending", v)
}

func (c *Client) Popular(ctx context.Context) ([]ivItem, error) {
	return cachedJSON[[]ivItem](ctx, c, ttlTrending, "popular", url.Values{})
}

func (c *Client) Channel(ctx context.Context, id string) (ivChannel, error) {
	return cachedJSON[ivChannel](ctx, c, ttlChannel, "channels/"+id, url.Values{})
}

func (c *Client) ChannelVideos(ctx context.Context, id, continuation string) (ivChannelVideos, error) {
	v := url.Values{}
	if continuation != "" {
		v.Set("continuation", continuation)
	}
	return cachedJSON[ivChannelVideos](ctx, c, ttlChannel, "channels/"+id+"/videos", v)
}

// ChannelVideosFresh bypasses the cache (subscription feed refresh).
func (c *Client) ChannelVideosFresh(ctx context.Context, id string) (ivChannelVideos, error) {
	var out ivChannelVideos
	err := c.getJSON(ctx, "channels/"+id+"/videos", url.Values{}, &out)
	if err == nil {
		c.store("channels/"+id+"/videos?", out, ttlChannel)
	}
	return out, err
}

func (c *Client) Playlist(ctx context.Context, id string) (ivPlaylist, error) {
	return cachedJSON[ivPlaylist](ctx, c, ttlPlaylist, "playlists/"+id, url.Values{})
}

func videoKey(id string) string { return "videos/" + id + "?local=true" }

// Video returns a video with local=true stream URLs (they point at the
// Invidious instance, which fetches googlevideo through the VPN). fresh
// skips the cache (stream URLs went stale).
func (c *Client) Video(ctx context.Context, id string, fresh bool) (*ivVideo, error) {
	key := videoKey(id)
	if !fresh {
		if v, ok := c.cached(key); ok {
			return v.(*ivVideo), nil
		}
	}
	var out ivVideo
	q := url.Values{"local": {"true"}}
	if c.region != "" {
		q.Set("region", c.region)
	}
	if err := c.getJSON(ctx, "videos/"+id, q, &out); err != nil {
		return nil, err
	}
	// The player data (companion) carries the original title, not YouTube's
	// auto-translation: remember it for the lists.
	if ValidVideoID(out.VideoID) {
		c.orig.setTitle(out.VideoID, out.Title)
	}
	if ValidChannelID(out.AuthorID) {
		c.orig.setChannel(out.AuthorID, out.Author)
	}
	ttl := ttlVideo
	if exp := streamsExpire(&out); !exp.IsZero() {
		if d := time.Until(exp) - streamSlack; d < ttl {
			ttl = max(d, time.Minute)
		}
	}
	c.store(key, &out, ttl)
	return &out, nil
}

// streamsExpire reads the `expire` query parameter of the first stream URL.
func streamsExpire(v *ivVideo) time.Time {
	for _, f := range append(append([]ivFormat{}, v.FormatStreams...), v.AdaptiveFormats...) {
		u, err := url.Parse(f.URL)
		if err != nil {
			continue
		}
		if n, err := strconv.ParseInt(u.Query().Get("expire"), 10, 64); err == nil && n > 0 {
			return time.Unix(n, 0)
		}
	}
	return time.Time{}
}

// Stats fetches /api/v1/stats uncached (health probe).
func (c *Client) Stats(ctx context.Context) (Stats, error) {
	var s Stats
	err := c.getJSON(ctx, "stats", url.Values{}, &s)
	return s, err
}
