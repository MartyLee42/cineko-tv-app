package video

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// API types (contract: openapi.yaml Video* schemas).

// Item is a video card.
type Item struct {
	ID              string    `json:"id"`
	Title           string    `json:"title"`
	ChannelID       string    `json:"channel_id"`
	ChannelName     string    `json:"channel_name"`
	ChannelVerified bool      `json:"channel_verified"`
	DurationSeconds *int      `json:"duration_seconds"` // null: live / unknown
	Views           *int64    `json:"views"`
	PublishedAt     *string   `json:"published_at"` // RFC 3339; null when unknown
	PublishedText   *string   `json:"published_text"`
	Thumbnail       string    `json:"thumbnail"`    // 320×180 (mqdefault), same-origin proxy
	ThumbnailHD     string    `json:"thumbnail_hd"` // 480×360 letterboxed (hqdefault): use object-fit cover
	Live            bool      `json:"live"`
	Upcoming        bool      `json:"upcoming"`
	Short           bool      `json:"short"`
	Progress        *Progress `json:"progress,omitempty"`
}

// Progress is a profile's position in a video.
type Progress struct {
	PositionSeconds float64 `json:"position_seconds"`
	DurationSeconds float64 `json:"duration_seconds"`
	Finished        bool    `json:"finished"`
	UpdatedAt       string  `json:"updated_at"`
}

// ChannelRef is a channel card.
type ChannelRef struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Avatar      *string `json:"avatar"`
	Subscribers *int64  `json:"subscribers"`
	VideoCount  *int64  `json:"video_count"`
	Verified    bool    `json:"verified"`
	Subscribed  bool    `json:"subscribed"`
}

// PlaylistRef is a playlist card (search results).
type PlaylistRef struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	ChannelID   string  `json:"channel_id"`
	ChannelName string  `json:"channel_name"`
	VideoCount  int64   `json:"video_count"`
	Thumbnail   *string `json:"thumbnail"`
}

// Caption is a subtitle track of a video (served by playback as VTT).
type Caption struct {
	Label    string `json:"label"`
	Language string `json:"language"`
}

// Detail is GET /video/videos/{id}.
type Detail struct {
	Item
	Description  string     `json:"description"`
	Likes        *int64     `json:"likes"`
	Genre        *string    `json:"genre"`
	Channel      ChannelRef `json:"channel"`
	Related      []Item     `json:"related"`
	InWatchLater bool       `json:"in_watch_later"`
	Qualities    []int      `json:"qualities"` // playable heights (≤ 1080), descending
	Captions     []Caption  `json:"captions"`
	// Playable is false for live streams and premieres (not supported yet).
	Playable bool `json:"playable"`
}

// Channel is GET /video/channels/{id}.
type Channel struct {
	ChannelRef
	Banner       *string `json:"banner"`
	Description  string  `json:"description"`
	Videos       []Item  `json:"videos"`
	Continuation *string `json:"continuation"`
}

// Page is a list of videos with an optional continuation.
type Page struct {
	Items        []Item  `json:"items"`
	Continuation *string `json:"continuation"`
}

// SearchResult is GET /video/search.
type SearchResult struct {
	Videos    []Item        `json:"videos"`
	Channels  []ChannelRef  `json:"channels"`
	Playlists []PlaylistRef `json:"playlists"`
	Page      int           `json:"page"`
}

// Playlist is GET /video/playlists/{id}.
type Playlist struct {
	PlaylistRef
	Description string `json:"description"`
	Videos      []Item `json:"videos"`
}

var (
	videoIDRe    = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	channelIDRe  = regexp.MustCompile(`^UC[A-Za-z0-9_-]{22}$`)
	playlistIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{10,64}$`)
	shortsTagRe  = regexp.MustCompile(`(?i)#shorts?\b`)
)

// ValidVideoID reports whether s looks like a YouTube video id.
func ValidVideoID(s string) bool { return videoIDRe.MatchString(s) }

// ValidChannelID reports whether s looks like a YouTube channel id (UC…).
func ValidChannelID(s string) bool { return channelIDRe.MatchString(s) }

const thumbPrefix = "/api/v1/video/thumbs/"

func thumbURL(videoID, name string) string {
	return thumbPrefix + "vi/" + videoID + "/" + name + ".jpg"
}

// avatarURL maps a yt3.ggpht.com / yt3.googleusercontent.com image to the
// same-origin proxy (Invidious serves it under /ggpht/), resized to size px.
func avatarURL(thumbs []ivThumb, size int) *string {
	best := ""
	for _, t := range thumbs {
		if t.URL != "" {
			best = t.URL
			if t.Width >= size {
				break
			}
		}
	}
	return ggphtURL(best, "s"+strconv.Itoa(size))
}

var ggphtSize = regexp.MustCompile(`=(?:s|w)\d+[^/]*$`)

// ggphtURL rewrites a Google user-content image URL to the proxy; sizeSpec
// ("s176", "w1280") replaces the size suffix, "" keeps it.
func ggphtURL(raw, sizeSpec string) *string {
	if raw == "" {
		return nil
	}
	if strings.HasPrefix(raw, "//") {
		raw = "https:" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil
	}
	host := strings.ToLower(u.Host)
	p := u.Path
	switch {
	case strings.HasPrefix(p, "/ggpht/"):
		p = strings.TrimPrefix(p, "/ggpht")
	case host == "yt3.ggpht.com" || host == "yt3.googleusercontent.com" || strings.HasSuffix(host, ".ggpht.com"):
	default:
		return nil
	}
	if sizeSpec != "" {
		if ggphtSize.MatchString(p) {
			p = ggphtSize.ReplaceAllString(p, "="+sizeSpec+"-c-k-c0x00ffffff-no-rj")
		}
	}
	p = strings.TrimPrefix(p, "/")
	if !validGgphtPath(p) {
		return nil
	}
	s := thumbPrefix + "ggpht/" + p
	return &s
}

var ggphtPathRe = regexp.MustCompile(`^[A-Za-z0-9_\-=/.~]{8,600}$`)

func validGgphtPath(p string) bool {
	return ggphtPathRe.MatchString(p) && !strings.Contains(p, "..") && !strings.Contains(p, "//")
}

// isShort: YouTube Shorts are ≤ 60 s (older) and are tagged #shorts by
// most uploaders. Invidious has no flag for them in lists.
func isShort(title string, length int64) bool {
	return (length > 0 && length <= 60) || shortsTagRe.MatchString(title)
}

// toItem converts an Invidious list entry; ok=false for non-videos.
func toItem(it ivItem) (Item, bool) {
	if (it.Type != "" && it.Type != "video" && it.Type != "shortVideo") || !ValidVideoID(it.VideoID) {
		return Item{}, false
	}
	out := Item{
		ID: it.VideoID, Title: it.Title, ChannelID: it.AuthorID, ChannelName: it.Author, ChannelVerified: it.AuthorVerified,
		Thumbnail: thumbURL(it.VideoID, "mqdefault"), ThumbnailHD: thumbURL(it.VideoID, "hqdefault"),
		Upcoming: it.IsUpcoming,
	}
	length := int64(it.LengthSeconds)
	// Live streams come with length 0 (trending lists them without liveNow).
	out.Live = it.LiveNow || (length == 0 && !it.IsUpcoming)
	if length > 0 {
		n := int(length)
		out.DurationSeconds = &n
	}
	if it.ViewCount > 0 {
		n := int64(it.ViewCount)
		out.Views = &n
	} else if n, ok := parseCount(it.ViewCountText); ok {
		out.Views = &n
	}
	if it.Published > 0 && !out.Live {
		s := time.Unix(int64(it.Published), 0).UTC().Format(time.RFC3339)
		out.PublishedAt = &s
		if it.PublishedText != "" {
			t := it.PublishedText
			out.PublishedText = &t
		}
	}
	out.Short = !out.Live && isShort(it.Title, length)
	return out, true
}

// parseCount reads "448K", "1.2M", "12,345 views" (related videos).
func parseCount(s string) (int64, bool) {
	s = strings.TrimSpace(strings.ToUpper(s))
	s = strings.TrimSuffix(strings.TrimSuffix(s, " VIEWS"), " VIEW")
	s = strings.ReplaceAll(s, ",", "")
	if s == "" {
		return 0, false
	}
	mult := 1.0
	switch s[len(s)-1] {
	case 'K':
		mult, s = 1e3, s[:len(s)-1]
	case 'M':
		mult, s = 1e6, s[:len(s)-1]
	case 'B':
		mult, s = 1e9, s[:len(s)-1]
	}
	var whole, frac float64
	div := 1.0
	dot := false
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			if dot {
				div *= 10
				frac += float64(r-'0') / div
			} else {
				whole = whole*10 + float64(r-'0')
			}
		case r == '.' && !dot:
			dot = true
		default:
			return 0, false
		}
	}
	return int64((whole + frac) * mult), true
}

func toItems(in []ivItem) []Item {
	out := make([]Item, 0, len(in))
	seen := map[string]bool{}
	for _, it := range in {
		if v, ok := toItem(it); ok && !seen[v.ID] {
			seen[v.ID] = true
			out = append(out, v)
		}
	}
	return out
}

func toChannelRef(it ivItem) (ChannelRef, bool) {
	if !ValidChannelID(it.AuthorID) {
		return ChannelRef{}, false
	}
	c := ChannelRef{ID: it.AuthorID, Name: it.Author, Avatar: avatarURL(it.AuthorThumbnails, 176), Verified: it.AuthorVerified}
	if it.SubCount > 0 {
		n := int64(it.SubCount)
		c.Subscribers = &n
	}
	if it.VideoCount > 0 {
		n := int64(it.VideoCount)
		c.VideoCount = &n
	}
	return c, true
}

func toPlaylistRef(it ivItem) (PlaylistRef, bool) {
	if !playlistIDRe.MatchString(it.PlaylistID) {
		return PlaylistRef{}, false
	}
	p := PlaylistRef{ID: it.PlaylistID, Title: it.Title, ChannelID: it.AuthorID, ChannelName: it.Author, VideoCount: int64(it.VideoCount)}
	if id := videoIDFromThumb(it.PlaylistThumbnail); id != "" {
		s := thumbURL(id, "mqdefault")
		p.Thumbnail = &s
	}
	return p, true
}

var viPath = regexp.MustCompile(`/vi(?:_webp)?/([A-Za-z0-9_-]{11})/`)

func videoIDFromThumb(u string) string {
	if m := viPath.FindStringSubmatch(u); m != nil {
		return m[1]
	}
	return ""
}

// filterShorts drops Shorts when hide is set.
func filterShorts(items []Item, hide bool) []Item {
	if !hide {
		return items
	}
	out := items[:0:0]
	for _, it := range items {
		if !it.Short {
			out = append(out, it)
		}
	}
	return out
}
