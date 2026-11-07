package video

import (
	"context"
	"encoding/json"
	"errors"
	"martytv/api/internal/playback"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func load[T any](t *testing.T, name string) T {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(name, err)
	}
	return v
}

func TestConvertFixtures(t *testing.T) {
	cv := load[ivChannelVideos](t, "channel_videos.json")
	items := toItems(cv.Videos)
	if len(items) != 6 {
		t.Fatalf("%d items", len(items))
	}
	it := items[0]
	if it.ID != "PXC_PYeB6F8" || it.ChannelID != "UCuAXFkgsw1L7xaCfnd5JJOw" || it.DurationSeconds == nil || *it.DurationSeconds != 231 ||
		it.Views == nil || *it.Views != 112000 || it.PublishedAt == nil || it.Live || it.Short {
		t.Fatalf("item: %+v", it)
	}
	if it.Thumbnail != "/api/v1/video/thumbs/vi/PXC_PYeB6F8/mqdefault.jpg" {
		t.Fatalf("thumbnail %q", it.Thumbnail)
	}
	if !items[1].Short { // the inserted Shorts entry (60 s)
		t.Fatalf("short not detected: %+v", items[1])
	}
	if got := filterShorts(items, true); len(got) != 5 {
		t.Fatalf("filterShorts: %d", len(got))
	}
	// Trending: live streams come with length 0.
	tr := toItems(load[[]ivItem](t, "trending_default.json"))
	if len(tr) == 0 || !tr[0].Live || tr[0].DurationSeconds != nil || tr[0].Short {
		t.Fatalf("trending live: %+v", tr[0])
	}
	if len(withoutLive(tr)) != 0 {
		t.Fatal("live kept")
	}
	// Search: videos, one channel, one playlist.
	var ch, pl int
	for _, x := range load[[]ivItem](t, "search.json") {
		if c, ok := toChannelRef(x); ok && x.Type == "channel" {
			ch++
			if c.Avatar == nil || !strings.HasPrefix(*c.Avatar, "/api/v1/video/thumbs/ggpht/") || !strings.Contains(*c.Avatar, "=s176-") {
				t.Fatalf("avatar %v", c.Avatar)
			}
			if c.Subscribers == nil || *c.Subscribers < 1_000_000 {
				t.Fatalf("subscribers %v", c.Subscribers)
			}
		}
		if p, ok := toPlaylistRef(x); ok && x.Type == "playlist" {
			pl++
			if p.Thumbnail == nil || !strings.HasSuffix(*p.Thumbnail, "/mqdefault.jpg") {
				t.Fatalf("playlist thumb %v", p.Thumbnail)
			}
		}
	}
	if ch != 1 || pl != 1 {
		t.Fatalf("channels %d playlists %d", ch, pl)
	}
}

func TestStreamsFromFixture(t *testing.T) {
	v := load[ivVideo](t, "video.json")
	c, _ := NewClient("http://invidious:3000", nil)
	s := NewService(Deps{Client: c})
	st := s.toStreams(&v)
	if st.Live || st.Duration != 214 {
		t.Fatalf("live %v duration %v", st.Live, st.Duration)
	}
	var itags []int
	for _, x := range st.Video {
		itags = append(itags, x.Itag)
		if !strings.HasPrefix(x.URL, "http://invidious:3000/videoplayback?") || x.InitEnd <= 0 || x.IndexFrom != x.InitEnd+1 {
			t.Fatalf("track %+v", x)
		}
	}
	// H.264 only (no VP9 248 / AV1 399), AAC only (no Opus 251).
	if len(itags) != 4 || len(st.Audio) != 1 || st.Audio[0].Itag != 140 || len(st.Progressive) != 1 || st.Progressive[0].Itag != 18 {
		t.Fatalf("video %v audio %+v progressive %+v", itags, st.Audio, st.Progressive)
	}
	if len(st.Captions) == 0 || !strings.HasPrefix(st.Captions[0].URL, "http://invidious:3000/api/v1/captions/dQw4w9WgXcQ") {
		t.Fatalf("captions %+v", st.Captions)
	}
	d := s.toDetail(&v)
	if !d.Playable || len(d.Qualities) != 4 || d.Qualities[0] != 1080 || d.Qualities[3] != 360 || d.Channel.ID != "UCuAXFkgsw1L7xaCfnd5JJOw" {
		t.Fatalf("detail: playable %v qualities %v channel %+v", d.Playable, d.Qualities, d.Channel)
	}
	if len(d.Related) != 4 || d.Related[0].Views == nil {
		t.Fatalf("related %+v", d.Related)
	}
	// Foreign hosts are dropped: a URL Invidious didn't proxy (local=false)
	// or anything not on the configured origin.
	v.AdaptiveFormats[4].URL = "https://rr5---sn-x.googlevideo.com/videoplayback?itag=136"
	v.FormatStreams[0].URL = "http://evil.example/videoplayback?itag=18"
	st = s.toStreams(&v)
	for _, x := range append(st.Video, st.Progressive...) {
		if x.Itag == 136 || x.Itag == 18 {
			t.Fatalf("foreign url kept: %+v", x)
		}
	}
}

func TestHelpers(t *testing.T) {
	for in, want := range map[string]int64{"448K": 448000, "1.2M": 1200000, "12,345 views": 12345, "3B": 3000000000} {
		if got, ok := parseCount(in); !ok || got != want {
			t.Fatalf("parseCount(%q) = %d %v", in, got, ok)
		}
	}
	if _, ok := parseCount("lots"); ok {
		t.Fatal("garbage count")
	}
	if !isShort("Funny #shorts", 200) || !isShort("x", 45) || isShort("x", 61) || isShort("x", 0) {
		t.Fatal("isShort")
	}
	for _, bad := range []string{"https://evil.example/a=s88", "", "https://yt3.ggpht.com/../../etc=s88"} {
		if ggphtURL(bad, "s88") != nil {
			t.Fatalf("ggphtURL(%q) accepted", bad)
		}
	}
	if u := ggphtURL("https://yt3.googleusercontent.com/abcdEFGH-ij=w2560-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj", "w1280"); u == nil ||
		*u != "/api/v1/video/thumbs/ggpht/abcdEFGH-ij=w1280-c-k-c0x00ffffff-no-rj" {
		t.Fatalf("banner %v", u)
	}
	if !ValidVideoID("dQw4w9WgXcQ") || ValidVideoID("dQw4w9WgXc") || ValidVideoID("dQw4w9WgXc/") {
		t.Fatal("ValidVideoID")
	}
	if !isFinished(195, 214) || isFinished(100, 214) || isFinished(10, 0) {
		t.Fatal("isFinished")
	}
}

func TestClientCacheAndErrors(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		switch r.URL.Path {
		case "/api/v1/search":
			_, _ = w.Write([]byte(`[]`))
		case "/api/v1/videos/gone0000000":
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"error":"This video is unavailable"}`))
		case "/api/v1/videos/broken00000":
			w.WriteHeader(502)
			_, _ = w.Write([]byte(`<html>bad gateway</html>`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c, err := NewClient(srv.URL+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, err := c.Search(ctx, "q", "all", 1, "RU"); err != nil {
			t.Fatal(err)
		}
	}
	if hits.Load() != 1 {
		t.Fatalf("search not cached: %d hits", hits.Load())
	}
	if _, err := c.Video(ctx, "gone0000000", false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unavailable video: %v", err)
	}
	var ue *UpstreamError
	if _, err := c.Video(ctx, "broken00000", false); !errors.As(err, &ue) || ue.Status != 502 {
		t.Fatalf("502: %v", err)
	}
	if _, err := c.Channel(ctx, "UCuAXFkgsw1L7xaCfnd5JJOw"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("404: %v", err)
	}
	off, _ := NewClient("", nil)
	if _, err := off.Trending(ctx, "RU", ""); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("unconfigured: %v", err)
	}
	if _, err := NewClient("ftp://x", nil); err == nil {
		t.Fatal("ftp accepted")
	}
	if _, err := c.Resolve("http://evil.example/videoplayback"); err == nil {
		t.Fatal("foreign url resolved")
	}
	if u, err := c.Resolve("/vi/dQw4w9WgXcQ/mqdefault.jpg"); err != nil || !strings.HasPrefix(u.String(), srv.URL+"/vi/") {
		t.Fatalf("resolve: %v %v", u, err)
	}
}

func TestParseChannelFeed(t *testing.T) {
	b, err := os.ReadFile("testdata/channel_feed.xml")
	if err != nil {
		t.Fatal(err)
	}
	f, err := parseChannelFeed(b)
	if err != nil {
		t.Fatal(err)
	}
	if f.Name != "Едим ТВ" || len(f.Titles) != 2 || f.Titles["8JOzrxNMnDA"] != "ХЭЛЛОУИН 🎃 5 простых рецептов, включая пунш" {
		t.Fatalf("feed %+v", f)
	}
	if _, err := parseChannelFeed([]byte("<html>oops")); err == nil {
		t.Fatal("garbage parsed")
	}
}

// hl / region go out with the API calls; the RSS feed's and the player
// data's original titles replace YouTube's auto-translations in lists; a
// failing RSS feed changes nothing.
func TestLocaleAndOriginalTitles(t *testing.T) {
	const edim = "UC_WdeoiTXMr-c_jMSP7PLmQ"
	feed, err := os.ReadFile("testdata/channel_feed.xml")
	if err != nil {
		t.Fatal(err)
	}
	var rssFail atomic.Bool
	queries := map[string]string{}
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		queries[r.URL.Path] = r.URL.RawQuery
		mu.Unlock()
		switch r.URL.Path {
		case "/feed/channel/" + edim:
			if rssFail.Load() {
				w.WriteHeader(500)
				return
			}
			w.Header().Set("Content-Type", "application/atom+xml")
			_, _ = w.Write(feed)
		case "/api/v1/search":
			_, _ = w.Write([]byte(`[{"type":"video","videoId":"8JOzrxNMnDA","title":"HALLOWEEN 🎃 5 Easy Recipes, Including Punch","author":"Edim TV","authorId":"` + edim + `","lengthSeconds":900},` +
				`{"type":"video","videoId":"QLeX4kqTBtI","title":"5 AUTUMN COCKTAILS","author":"Edim TV","authorId":"` + edim + `","lengthSeconds":900}]`))
		case "/api/v1/videos/QLeX4kqTBtI":
			_, _ = w.Write([]byte(`{"videoId":"QLeX4kqTBtI","title":"5 ОСЕННИХ КОКТЕЙЛЕЙ","author":"Едим ТВ","authorId":"` + edim + `","lengthSeconds":900}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c, err := NewClient(srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	c.SetLocale("ru", "ru")
	ctx := context.Background()

	raw, err := c.Search(ctx, "edim", "video", 1, "RU")
	if err != nil {
		t.Fatal(err)
	}
	if q := queries["/api/v1/search"]; !strings.Contains(q, "hl=ru") || !strings.Contains(q, "region=RU") {
		t.Fatalf("search query %q", q)
	}
	items := c.Originals(toItems(raw))
	if items[0].Title != "HALLOWEEN 🎃 5 Easy Recipes, Including Punch" {
		t.Fatalf("nothing known yet, title changed: %q", items[0].Title)
	}

	// RSS down: an error, nothing remembered.
	rssFail.Store(true)
	if _, err := c.ChannelFeed(ctx, edim); err == nil {
		t.Fatal("failing RSS returned no error")
	}
	if items := c.Originals(toItems(raw)); items[0].Title != "HALLOWEEN 🎃 5 Easy Recipes, Including Punch" || items[0].ChannelName != "Edim TV" {
		t.Fatalf("after failed RSS %+v", items[0])
	}
	rssFail.Store(false)
	if f, err := c.ChannelFeed(ctx, edim); err != nil || f.Name != "Едим ТВ" {
		t.Fatalf("rss %+v %v", f, err)
	}
	if strings.Contains(queries["/feed/channel/"+edim], "hl=") {
		t.Fatal("hl sent to the RSS feed")
	}
	// The video's player data: original title, with hl + region.
	if _, err := c.Video(ctx, "QLeX4kqTBtI", false); err != nil {
		t.Fatal(err)
	}
	if q := queries["/api/v1/videos/QLeX4kqTBtI"]; !strings.Contains(q, "hl=ru") || !strings.Contains(q, "region=RU") || !strings.Contains(q, "local=true") {
		t.Fatalf("video query %q", q)
	}
	items = c.Originals(toItems(raw))
	if items[0].Title != "ХЭЛЛОУИН 🎃 5 простых рецептов, включая пунш" || items[1].Title != "5 ОСЕННИХ КОКТЕЙЛЕЙ" || items[0].ChannelName != "Едим ТВ" {
		t.Fatalf("originals %+v", items)
	}
	if n, ok := c.OriginalChannelName(edim); !ok || n != "Едим ТВ" {
		t.Fatalf("channel name %q", n)
	}
}

func TestOriginalsBounded(t *testing.T) {
	var o originals
	for i := 0; i < maxOrigTitles+10; i++ {
		o.setTitle(strconv.Itoa(i), "x")
	}
	if len(o.titles) > maxOrigTitles {
		t.Fatalf("%d titles kept", len(o.titles))
	}
}

// Auto-dubbed videos list every language under itag 140; the player plays
// the first track, so the viewer's language (then the original) comes first.
func TestSortAudioByLanguage(t *testing.T) {
	tr := func(xtags string, bw int64) playback.VideoTrack {
		u := "http://invidious:3000/videoplayback?itag=140"
		if xtags != "" {
			u += "&xtags=" + url.QueryEscape(xtags)
		}
		return playback.VideoTrack{Itag: 140, URL: u, Bandwidth: bw}
	}
	lang := func(ts []playback.VideoTrack) []string {
		var out []string
		for _, x := range ts {
			l, orig, drc := audioTag(x.URL)
			if orig {
				l += "*"
			}
			if drc {
				l += "~"
			}
			out = append(out, l)
		}
		return out
	}
	mk := func() []playback.VideoTrack {
		return []playback.VideoTrack{
			tr("acont=dubbed:lang=ja", 133990), tr("acont=original:drc=1:lang=en", 133800), tr("acont=dubbed:lang=de", 133950),
			tr("acont=original:lang=en", 133700), tr("acont=dubbed:lang=ru", 133600), tr("acont=dubbed:lang=pt-BR", 133980),
		}
	}
	cases := []struct {
		want string
		head []string
	}{
		{"ru", []string{"ru", "en*", "en*~"}},    // Russian dub, then the original (plain before levelled)
		{"pt", []string{"pt-br", "en*", "en*~"}}, // region variants count
		{"fr", []string{"en*", "en*~"}},          // no French: the original
		{"", []string{"en*", "en*~"}},
	}
	for _, c := range cases {
		ts := mk()
		sortAudio(ts, c.want)
		if got := lang(ts)[:len(c.head)]; strings.Join(got, ",") != strings.Join(c.head, ",") {
			t.Errorf("want %q: %v", c.want, lang(ts))
		}
	}
	// A dubbed-only list without the viewer's language: English before the rest.
	ts := []playback.VideoTrack{tr("acont=dubbed:lang=ja", 2), tr("acont=dubbed:lang=en", 1)}
	sortAudio(ts, "ru")
	if l, _, _ := audioTag(ts[0].URL); l != "en" {
		t.Errorf("dubs only: %v", lang(ts))
	}
	// Single-track videos carry no xtags: the original.
	if l, orig, _ := audioTag(tr("", 1).URL); l != "" || !orig {
		t.Errorf("untagged: %q %v", l, orig)
	}
}
