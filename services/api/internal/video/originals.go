package video

import (
	"context"
	"encoding/xml"
	"net/url"
	"strings"
	"sync"
)

// Original titles. Invidious builds its innertube requests with hl=en (not
// configurable, `hl` only localizes Invidious' own strings), so YouTube
// answers lists (search, channel uploads, trending, related) with its
// auto-translated English titles: "HALLOWEEN 🎃 5 Easy Recipes…" for
// «ХЭЛЛОУИН 🎃 5 простых рецептов…». Two sources carry the uploader's own
// title: the channel RSS feed (Invidious proxies /feed/channel/{ucid}, the
// latest ~15 uploads, plus the channel's own name) and the player data of a
// video (companion). Every title seen there is remembered here and put back
// into the lists.

const (
	maxOrigTitles   = 20000
	maxOrigChannels = 5000
)

// originals is a bounded id → original text store.
type originals struct {
	mu       sync.Mutex
	titles   map[string]string // video id → title
	channels map[string]string // channel id → name
}

func boundedSet(m map[string]string, max int, k, v string) map[string]string {
	if m == nil {
		m = map[string]string{}
	}
	if _, ok := m[k]; !ok && len(m) >= max {
		for x := range m { // full: drop an arbitrary half
			if len(m) < max/2 {
				break
			}
			delete(m, x)
		}
	}
	m[k] = v
	return m
}

func (o *originals) setTitle(videoID, title string) {
	title = strings.TrimSpace(title)
	if videoID == "" || title == "" {
		return
	}
	o.mu.Lock()
	o.titles = boundedSet(o.titles, maxOrigTitles, videoID, title)
	o.mu.Unlock()
}

func (o *originals) setChannel(channelID, name string) {
	name = strings.TrimSpace(name)
	if channelID == "" || name == "" {
		return
	}
	o.mu.Lock()
	o.channels = boundedSet(o.channels, maxOrigChannels, channelID, name)
	o.mu.Unlock()
}

func (o *originals) channel(id string) (string, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	n, ok := o.channels[id]
	return n, ok
}

// Originals puts the remembered original titles and channel names into
// items (in place) and returns them. A title that turns out to be tagged
// #shorts marks the item as a Short.
func (c *Client) Originals(items []Item) []Item {
	o := &c.orig
	o.mu.Lock()
	defer o.mu.Unlock()
	for i := range items {
		it := &items[i]
		if t, ok := o.titles[it.ID]; ok && t != it.Title {
			it.Title = t
			if !it.Live && shortsTagRe.MatchString(t) {
				it.Short = true
			}
		}
		if n, ok := o.channels[it.ChannelID]; ok {
			it.ChannelName = n
		}
	}
	return items
}

// OriginalChannelName is the channel's own name, when known.
func (c *Client) OriginalChannelName(id string) (string, bool) { return c.orig.channel(id) }

// rssFeed is the Atom feed of a channel (/feed/channel/{ucid}).
type rssFeed struct {
	ChannelID string `xml:"http://www.youtube.com/xml/schemas/2015 channelId"`
	Title     string `xml:"title"`
	Author    struct {
		Name string `xml:"name"`
	} `xml:"author"`
	Entries []struct {
		VideoID   string `xml:"http://www.youtube.com/xml/schemas/2015 videoId"`
		ChannelID string `xml:"http://www.youtube.com/xml/schemas/2015 channelId"`
		Title     string `xml:"title"`
		Author    struct {
			Name string `xml:"name"`
		} `xml:"author"`
	} `xml:"entry"`
}

// ChannelFeed is a channel's RSS feed: its own name and the original titles
// of its latest uploads (also remembered for Originals).
type ChannelFeed struct {
	Name   string
	Titles map[string]string // video id → title
}

func parseChannelFeed(body []byte) (ChannelFeed, error) {
	var f rssFeed
	if err := xml.Unmarshal(body, &f); err != nil {
		return ChannelFeed{}, err
	}
	out := ChannelFeed{Name: strings.TrimSpace(f.Author.Name), Titles: map[string]string{}}
	if out.Name == "" {
		out.Name = strings.TrimSpace(f.Title)
	}
	for _, e := range f.Entries {
		if t := strings.TrimSpace(e.Title); ValidVideoID(e.VideoID) && t != "" {
			out.Titles[e.VideoID] = t
		}
	}
	return out, nil
}

// ChannelFeed fetches /feed/channel/{id} (cached like channels) and
// remembers what it found. Callers treat errors as "no originals".
func (c *Client) ChannelFeed(ctx context.Context, id string) (ChannelFeed, error) {
	if !ValidChannelID(id) {
		return ChannelFeed{}, ErrNotFound
	}
	key := "rss/" + id
	if v, ok := c.cached(key); ok {
		return v.(ChannelFeed), nil
	}
	var out ChannelFeed
	err := c.get(ctx, "/feed/channel/"+id, url.Values{}, "application/atom+xml, application/xml", func(b []byte) error {
		var err error
		out, err = parseChannelFeed(b)
		return err
	}, "invalid feed")
	if err != nil {
		return ChannelFeed{}, err
	}
	c.orig.setChannel(id, out.Name)
	for vid, t := range out.Titles {
		c.orig.setTitle(vid, t)
	}
	c.store(key, out, ttlChannel)
	return out, nil
}
