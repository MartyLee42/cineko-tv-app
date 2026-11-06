package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/realtime"
	"martytv/api/internal/testutil"
)

// fakeInvidious serves the trimmed fixtures recorded from a real instance
// (internal/video/testdata), a second channel for the feed, a live video,
// the videoplayback byte ranges (with the real sidx boxes), thumbnails and
// captions.
type fakeInvidious struct {
	srv       *httptest.Server
	playback  atomic.Int32
	stale     atomic.Int32 // answer this many videoplayback calls with 403
	videoHits atomic.Int32
	thumbHits atomic.Int32
	lastRange atomic.Value
}

const (
	rickChannel  = "UCuAXFkgsw1L7xaCfnd5JJOw"
	otherChannel = "UCaaaaaaaaaaaaaaaaaaaaaa"
	rickVideo    = "dQw4w9WgXcQ"
)

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("../video/testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func newFakeInvidious(t *testing.T) *fakeInvidious {
	f := &fakeInvidious{}
	sidx := map[string][]byte{"136": readFixture(t, "sidx_136.bin"), "140": readFixture(t, "sidx_140.bin")}
	indexFrom := map[string]int64{"136": 740, "140": 723}
	jpeg := append([]byte{0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 'J', 'F', 'I', 'F', 0}, make([]byte, 64)...)
	fixture := func(name string) []byte {
		return []byte(strings.ReplaceAll(string(readFixture(t, name)), "http://invidious:3000", f.srv.URL))
	}
	rangeRe := regexp.MustCompile(`^bytes=(\d+)-(\d*)$`)
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/api/v1/") && !strings.HasPrefix(p, "/api/v1/captions/") && r.URL.Query().Get("hl") != "ru" {
			t.Errorf("%s without hl=ru: %s", p, r.URL.RawQuery)
		}
		switch {
		case p == "/api/v1/stats":
			_, _ = w.Write(fixture("stats.json"))
		case p == "/api/v1/search":
			_, _ = w.Write(fixture("search.json"))
		case p == "/api/v1/search/suggestions":
			_, _ = w.Write(fixture("suggestions.json"))
		case p == "/api/v1/trending" && r.URL.Query().Get("type") == "gaming":
			var cv struct {
				Videos json.RawMessage `json:"videos"`
			}
			_ = json.Unmarshal(fixture("channel_videos.json"), &cv)
			_, _ = w.Write(cv.Videos)
		case p == "/api/v1/trending":
			_, _ = w.Write(fixture("trending_default.json"))
		case p == "/api/v1/videos/"+rickVideo:
			f.videoHits.Add(1)
			if r.URL.Query().Get("local") != "true" {
				t.Errorf("video fetched without local=true")
			}
			_, _ = w.Write(fixture("video.json"))
		case p == "/api/v1/videos/liveLIVE001":
			fmt.Fprintf(w, `{"type":"video","videoId":"liveLIVE001","title":"Live","author":"X","authorId":"%s","lengthSeconds":0,"liveNow":true,"adaptiveFormats":[],"formatStreams":[]}`, otherChannel)
		case strings.HasPrefix(p, "/api/v1/videos/"):
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"error":"This video is unavailable"}`))
		case p == "/api/v1/channels/"+rickChannel:
			_, _ = w.Write(fixture("channel.json"))
		case p == "/api/v1/channels/"+rickChannel+"/videos":
			_, _ = w.Write(fixture("channel_videos.json"))
		case p == "/feed/channel/"+rickChannel:
			// The RSS feed: the uploader's own title (YouTube translates list titles).
			w.Header().Set("Content-Type", "application/atom+xml")
			fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">`+
				`<yt:channelId>%[1]s</yt:channelId><title>Rick Astley</title><author><name>Rick Astley</name></author>`+
				`<entry><yt:videoId>PXC_PYeB6F8</yt:videoId><yt:channelId>%[1]s</yt:channelId><title>Рик Эстли — Ангелы на моей стороне</title></entry></feed>`, rickChannel)
		case p == "/api/v1/channels/"+otherChannel:
			fmt.Fprintf(w, `{"author":"Other","authorId":"%s","authorThumbnails":[],"subCount":10}`, otherChannel)
		case p == "/api/v1/channels/"+otherChannel+"/videos":
			// Newer than everything on Rick's channel.
			fmt.Fprintf(w, `{"videos":[{"type":"video","title":"Brand new","videoId":"newNEWnew01","author":"Other","authorId":"%[1]s","lengthSeconds":600,"viewCount":5,"published":%[2]d,"publishedText":"1 hour ago"},`+
				`{"type":"video","title":"Tiny #shorts","videoId":"shortSHORT1","author":"Other","authorId":"%[1]s","lengthSeconds":30,"viewCount":5,"published":%[2]d,"publishedText":"1 hour ago"}]}`,
				otherChannel, time.Now().Add(-time.Hour).Unix())
		case strings.HasPrefix(p, "/api/v1/captions/"):
			w.Header().Set("Content-Type", "text/vtt")
			_, _ = w.Write([]byte("WEBVTT\n\n00:00.000 --> 00:02.000\nWe're no strangers to love\n"))
		case p == "/videoplayback":
			f.playback.Add(1)
			if f.stale.Load() > 0 {
				f.stale.Add(-1)
				w.WriteHeader(403)
				return
			}
			itag := r.URL.Query().Get("itag")
			size := int64(4_000_000)
			m := rangeRe.FindStringSubmatch(r.Header.Get("Range"))
			if m == nil {
				t.Errorf("videoplayback without a Range header")
				w.WriteHeader(400)
				return
			}
			f.lastRange.Store(r.Header.Get("Range"))
			from, _ := strconv.ParseInt(m[1], 10, 64)
			to := size - 1
			if m[2] != "" {
				to, _ = strconv.ParseInt(m[2], 10, 64)
			}
			to = min(to, from+2_000_000, size-1)
			body := make([]byte, to-from+1)
			for i := range body {
				body[i] = byte((from + int64(i)) % 251)
			}
			if sb, ok := sidx[itag]; ok && from == indexFrom[itag] {
				copy(body, sb)
			}
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", from, to, size))
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			w.WriteHeader(206)
			_, _ = w.Write(body)
		case strings.HasPrefix(p, "/vi/") || strings.HasPrefix(p, "/ggpht/"):
			f.thumbHits.Add(1)
			w.Header().Set("Content-Type", "image/jpeg")
			_, _ = w.Write(jpeg)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func newVideoEnv(t *testing.T) (*testutil.Env, *fakeInvidious) {
	f := newFakeInvidious(t)
	env := testutil.New(t, func(c *config.Config) {
		c.Video.InvidiousURL = f.srv.URL
		c.Catalog.ImageCacheDir = t.TempDir()
	})
	return env, f
}

func TestVideoCatalogAndAuth(t *testing.T) {
	env, f := newVideoEnv(t)
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	ap := alice.Do("POST", "/api/v1/profiles", map[string]string{"name": "Alice"}).Expect(201).JSON()["id"].(string)
	bp := bob.Do("POST", "/api/v1/profiles", map[string]string{"name": "Bob"}).Expect(201).JSON()["id"].(string)

	anon := env.Client()
	anon.Do("GET", "/api/v1/video/search?q=rick", nil).Expect(401)
	anon.Do("GET", "/api/v1/video/trending", nil).Expect(401)
	alice.Do("GET", "/api/v1/video/trending?profile_id="+bp, nil).Expect(404)
	alice.Do("GET", "/api/v1/video/feed", nil).Expect(422) // profile_id required
	alice.Do("GET", "/api/v1/video/search", nil).Expect(422)
	alice.Do("GET", "/api/v1/video/search?q=x&type=bogus", nil).Expect(422)

	res := alice.Do("GET", "/api/v1/video/search?q=rick+astley&profile_id="+ap, nil).Expect(200).JSON()
	if len(res["videos"].([]any)) != 4 || len(res["channels"].([]any)) != 1 || len(res["playlists"].([]any)) != 1 {
		t.Fatalf("search %v", res)
	}
	if n := len(alice.Do("GET", "/api/v1/video/search/suggestions?q=rick", nil).Expect(200).JSON()["items"].([]any)); n != 10 {
		t.Fatalf("suggestions %d", n)
	}

	// Trending: the default list is live-only → topped up from gaming.
	tr := alice.Do("GET", "/api/v1/video/trending?profile_id="+ap, nil).Expect(200).Items()
	for _, it := range tr {
		if it["live"] == true || it["short"] == true {
			t.Fatalf("trending kept live/short %v", it)
		}
	}
	alice.Do("GET", "/api/v1/video/trending?region=russia", nil).Expect(422)

	d := alice.Do("GET", "/api/v1/video/videos/"+rickVideo+"?profile_id="+ap, nil).Expect(200).JSON()
	if d["title"] == "" || d["playable"] != true || d["channel"].(map[string]any)["id"] != rickChannel || d["in_watch_later"] != false {
		t.Fatalf("detail %v", d)
	}
	if q := d["qualities"].([]any); len(q) != 4 || q[0] != 1080.0 {
		t.Fatalf("qualities %v", q)
	}
	alice.Do("GET", "/api/v1/video/videos/gone0000000", nil).Expect(404)
	alice.Do("GET", "/api/v1/video/videos/not-an-id", nil).Expect(404)
	before := f.videoHits.Load()
	alice.Do("GET", "/api/v1/video/videos/"+rickVideo, nil).Expect(200)
	if f.videoHits.Load() != before {
		t.Fatal("video not cached")
	}

	ch := alice.Do("GET", "/api/v1/video/channels/"+rickChannel+"?profile_id="+ap, nil).Expect(200).JSON()
	if ch["name"] != "Rick Astley" || ch["subscribed"] != false || len(ch["videos"].([]any)) != 5 { // the Short is hidden by default
		t.Fatalf("channel %v", ch)
	}
	all := alice.Do("GET", "/api/v1/video/channels/"+rickChannel+"?shorts=true", nil).Expect(200).JSON()
	if len(all["videos"].([]any)) != 6 {
		t.Fatalf("shorts=true %d", len(all["videos"].([]any)))
	}
	alice.Do("PUT", "/api/v1/profiles/"+ap+"/settings", map[string]any{"video_hide_shorts": false, "video_quality": 480}).Expect(200)
	alice.Do("PUT", "/api/v1/profiles/"+ap+"/settings", map[string]any{"video_quality": 360}).Expect(422)
	ch = alice.Do("GET", "/api/v1/video/channels/"+rickChannel+"?profile_id="+ap, nil).Expect(200).JSON()
	if len(ch["videos"].([]any)) != 6 {
		t.Fatal("hide_shorts=false still hides")
	}
	alice.Do("GET", "/api/v1/video/channels/UCnope", nil).Expect(404)

	// Thumbnails: public (TV <img>), cached on disk, only known shapes.
	img := anon.Do("GET", "/api/v1/video/thumbs/vi/"+rickVideo+"/mqdefault.jpg", nil).Expect(200)
	if img.Header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("thumb type %q", img.Header.Get("Content-Type"))
	}
	anon.Do("GET", "/api/v1/video/thumbs/vi/"+rickVideo+"/mqdefault.jpg", nil).Expect(200)
	if f.thumbHits.Load() != 1 {
		t.Fatalf("thumb not cached: %d", f.thumbHits.Load())
	}
	anon.Do("GET", "/api/v1/video/thumbs/vi/"+rickVideo+"/../../etc.jpg", nil).Expect(404)
	anon.Do("GET", "/api/v1/video/thumbs/vi/"+rickVideo+"/x.php", nil).Expect(404)
	avatar := *ptrString(ch["avatar"])
	anon.Do("GET", avatar, nil).Expect(200)

	// Admin health card.
	alice.Do("GET", "/api/v1/admin/video/status", nil).Expect(403)
	admin, _ := env.NewUserClient("vadmin", "admin")
	st := admin.Do("GET", "/api/v1/admin/video/status?check=true", nil).Expect(200).JSON()
	if st["configured"] != true || st["reachable"] != true || st["version"] != "2026.08.04-48c6110" {
		t.Fatalf("status %v", st)
	}
}

func ptrString(v any) *string {
	s, _ := v.(string)
	return &s
}

func TestVideoSubscriptionsWatchLaterHistory(t *testing.T) {
	env, _ := newVideoEnv(t)
	alice, _ := env.NewUserClient("alice", "user")
	bob, _ := env.NewUserClient("bob", "user")
	ap := alice.Do("POST", "/api/v1/profiles", map[string]string{"name": "Alice"}).Expect(201).JSON()["id"].(string)
	bp := bob.Do("POST", "/api/v1/profiles", map[string]string{"name": "Bob"}).Expect(201).JSON()["id"].(string)
	q := "?profile_id=" + ap

	alice.Do("PUT", "/api/v1/video/subscriptions/not-a-channel"+q, nil).Expect(422)
	alice.Do("PUT", "/api/v1/video/subscriptions/"+rickChannel+"?profile_id="+bp, nil).Expect(404)
	sub := alice.Do("PUT", "/api/v1/video/subscriptions/"+rickChannel+q, nil).Expect(200).JSON()
	if sub["name"] != "Rick Astley" || sub["subscribed"] != true {
		t.Fatalf("subscribe %v", sub)
	}
	alice.Do("PUT", "/api/v1/video/subscriptions/"+rickChannel+q, nil).Expect(200) // idempotent
	alice.Do("PUT", "/api/v1/video/subscriptions/"+otherChannel+q, nil).Expect(200)
	subs := alice.Do("GET", "/api/v1/video/subscriptions"+q, nil).Expect(200).Items()
	if len(subs) != 2 || subs[0]["name"] != "Other" {
		t.Fatalf("subs %v", subs)
	}
	if len(bob.Do("GET", "/api/v1/video/subscriptions?profile_id="+bp, nil).Expect(200).Items()) != 0 {
		t.Fatal("bob sees alice's subscriptions")
	}

	// Feed: merged across channels, newest first, Shorts hidden by default.
	env.Server.Video.RefreshFeeds(context.Background())
	feed := alice.Do("GET", "/api/v1/video/feed"+q, nil).Expect(200).JSON()
	items := feed["items"].([]any)
	first := items[0].(map[string]any)
	if first["id"] != "newNEWnew01" || feed["refreshed_at"] == nil || len(items) != 6 {
		t.Fatalf("feed %d items, first %v", len(items), first)
	}
	for _, it := range items {
		if it.(map[string]any)["short"] == true {
			t.Fatal("short in feed")
		}
	}
	alice.Do("DELETE", "/api/v1/video/subscriptions/"+otherChannel+q, nil).Expect(204)
	left := alice.Do("GET", "/api/v1/video/feed"+q, nil).Expect(200).Items()
	if len(left) != 5 || left[0]["channel_id"] != rickChannel {
		t.Fatalf("feed after unsubscribe %v", left)
	}

	// Watch later.
	wl := alice.Do("PUT", "/api/v1/video/watch-later/"+rickVideo+q, nil).Expect(200).JSON()
	if wl["id"] != rickVideo {
		t.Fatalf("watch later %v", wl)
	}
	alice.Do("PUT", "/api/v1/video/watch-later/gone0000000"+q, nil).Expect(404)
	if got := alice.Do("GET", "/api/v1/video/watch-later"+q, nil).Expect(200).Items(); len(got) != 1 || got[0]["title"] == "" {
		t.Fatalf("watch later list %v", got)
	}
	if alice.Do("GET", "/api/v1/video/videos/"+rickVideo+q, nil).Expect(200).JSON()["in_watch_later"] != true {
		t.Fatal("in_watch_later false")
	}
	bob.Do("GET", "/api/v1/video/watch-later"+q, nil).Expect(404)

	// Progress → history / continue / resume.
	alice.Do("POST", "/api/v1/video/progress", map[string]any{"profile_id": ap, "video_id": rickVideo, "position_seconds": -1}).Expect(422)
	alice.Do("POST", "/api/v1/video/progress", map[string]any{"profile_id": bp, "video_id": rickVideo, "position_seconds": 1}).Expect(404)
	alice.Do("POST", "/api/v1/video/progress", map[string]any{"profile_id": ap, "video_id": rickVideo, "position_seconds": 61.5, "duration_seconds": 213}).Expect(204)
	cont := alice.Do("GET", "/api/v1/video/continue"+q, nil).Expect(200).Items()
	if len(cont) != 1 || cont[0]["progress"].(map[string]any)["position_seconds"] != 61.5 {
		t.Fatalf("continue %v", cont)
	}
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "video", "video_id": rickVideo, "profile_id": ap}).Expect(201).JSON()
	if src["position_seconds"] != 61.5 {
		t.Fatalf("resume %v", src["position_seconds"])
	}
	alice.Do("POST", "/api/v1/video/progress", map[string]any{"profile_id": ap, "video_id": rickVideo, "position_seconds": 205}).Expect(204)
	if len(alice.Do("GET", "/api/v1/video/continue"+q, nil).Expect(200).Items()) != 0 {
		t.Fatal("finished video still in continue")
	}
	hist := alice.Do("GET", "/api/v1/video/history"+q, nil).Expect(200).Items()
	if len(hist) != 1 || hist[0]["progress"].(map[string]any)["finished"] != true {
		t.Fatalf("history %v", hist)
	}
	alice.Do("DELETE", "/api/v1/video/history/"+rickVideo+q, nil).Expect(204)
	if len(alice.Do("GET", "/api/v1/video/history"+q, nil).Expect(200).Items()) != 0 {
		t.Fatal("history not cleared")
	}
	alice.Do("DELETE", "/api/v1/video/watch-later/"+rickVideo+q, nil).Expect(204)

	// Deleting the profile removes everything.
	alice.Do("PUT", "/api/v1/video/watch-later/"+rickVideo+q, nil).Expect(200)
	alice.Do("DELETE", "/api/v1/profiles/"+ap, nil).Expect(204)
	var n int
	_ = env.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM video_watch_later) + (SELECT count(*) FROM video_subscriptions)`).Scan(&n)
	if n != 0 {
		t.Fatalf("%d rows left after profile delete", n)
	}
}

func TestVideoPlaybackHLS(t *testing.T) {
	env, f := newVideoEnv(t)
	alice, _ := env.NewUserClient("alice", "user")
	ap := alice.Do("POST", "/api/v1/profiles", map[string]string{"name": "Alice"}).Expect(201).JSON()["id"].(string)

	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "video"}).Expect(422)
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "video", "video_id": "../../etc/x"}).Expect(422)
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "video", "video_id": "gone0000000"}).Expect(404)
	if code := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "video", "video_id": "liveLIVE001"}).Expect(422).ErrorCode(); code != "video_live_unsupported" {
		t.Fatalf("live: %s", code)
	}
	env.Client().Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "video", "video_id": rickVideo}).Expect(401)

	// Default cap 720 (no profile).
	src := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "video", "video_id": rickVideo}).Expect(201).JSON()
	if src["kind"] != "video" || src["format"] != "hls" || src["quality"] != 720.0 || src["status"] != "ready" || src["video_id"] != rickVideo {
		t.Fatalf("source %v", src)
	}
	if q := src["qualities"].([]any); len(q) != 4 {
		t.Fatalf("qualities %v", q)
	}
	stream := src["stream_url"].(string)
	if !strings.HasPrefix(stream, "/api/v1/vstream/") || !strings.HasSuffix(stream, "/master.m3u8") {
		t.Fatalf("stream_url %s", stream)
	}
	fallback := src["fallback_url"].(string)
	if !strings.HasSuffix(fallback, "/p18.mp4") {
		t.Fatalf("fallback %s", fallback)
	}
	subs := src["subtitles"].([]any)
	if len(subs) == 0 {
		t.Fatal("no captions")
	}
	base := strings.TrimSuffix(stream, "master.m3u8")

	// The stream proxy is token-gated, not cookie-gated (TV <video src>).
	tv := env.Client()
	master := tv.Do("GET", stream, nil).Expect(200)
	if !strings.Contains(string(master.Body), "v136.m3u8") || !strings.Contains(string(master.Body), `URI="a140.m3u8"`) ||
		strings.Contains(string(master.Body), f.srv.URL) {
		t.Fatalf("master:\n%s", master.Body)
	}
	vpl := string(tv.Do("GET", base+"v136.m3u8", nil).Expect(200).Body)
	if !strings.Contains(vpl, `#EXT-X-MAP:URI="m136.mp4",BYTERANGE="740@0"`) || strings.Count(vpl, "#EXTINF:") != 38 ||
		!strings.Contains(vpl, "#EXT-X-BYTERANGE:675354@1228\n") || strings.Contains(vpl, "googlevideo") {
		t.Fatalf("video playlist:\n%s", vpl)
	}
	apl := string(tv.Do("GET", base+"a140.m3u8", nil).Expect(200).Body)
	if strings.Count(apl, "#EXTINF:") != 22 {
		t.Fatalf("audio playlist:\n%s", apl)
	}
	// A fragment: Range passes through.
	seg := tv.Do("GET", base+"m136.mp4", nil, "Range", "bytes=1228-2227").Expect(206)
	if len(seg.Body) != 1000 || seg.Header.Get("Content-Range") != "bytes 1228-2227/4000000" || f.lastRange.Load() != "bytes=1228-2227" {
		t.Fatalf("segment %d bytes, %q, upstream %v", len(seg.Body), seg.Header.Get("Content-Range"), f.lastRange.Load())
	}
	// Progressive fallback without Range → 200.
	mp4 := tv.Do("GET", fallback, nil, "Range", "bytes=0-99").Expect(206)
	if len(mp4.Body) != 100 {
		t.Fatalf("mp4 %d", len(mp4.Body))
	}
	// Stale upstream URL (403) → the video is refetched once and retried.
	hits := f.videoHits.Load()
	f.stale.Store(1)
	tv.Do("GET", base+"m140.mp4", nil, "Range", "bytes=1019-1100").Expect(206)
	if f.videoHits.Load() != hits+1 {
		t.Fatal("stale url not refreshed")
	}
	cc := tv.Do("GET", base+"cc0.vtt", nil).Expect(200)
	if !strings.HasPrefix(string(cc.Body), "WEBVTT") {
		t.Fatalf("caption %s", cc.Body)
	}

	// Only this video's formats: other itags/names, tampered tokens refused.
	tv.Do("GET", base+"m248.mp4", nil, "Range", "bytes=0-10").Expect(404) // VP9 is not offered
	tv.Do("GET", base+"m999.mp4", nil).Expect(404)
	tv.Do("GET", base+"cc99.vtt", nil).Expect(404)
	tv.Do("GET", base+"evil.php", nil).Expect(404)
	tok := strings.Split(stream, "/")[4]
	bad := tok[:len(tok)-2] + "AA"
	tv.Do("GET", "/api/v1/vstream/"+bad+"/master.m3u8", nil).Expect(403)
	tv.Do("GET", "/api/v1/live/"+tok+"/index.m3u8", nil).Expect(403) // not a live token

	// The profile's quality setting caps the source.
	alice.Do("PUT", "/api/v1/profiles/"+ap+"/settings", map[string]any{"video_quality": 480}).Expect(200)
	src = alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "video", "video_id": rickVideo, "profile_id": ap}).Expect(201).JSON()
	if src["quality"] != 480.0 {
		t.Fatalf("profile quality %v", src["quality"])
	}
	m := string(tv.Do("GET", src["stream_url"].(string), nil).Expect(200).Body)
	if !strings.Contains(m, "v135.m3u8") {
		t.Fatalf("480 master:\n%s", m)
	}
	src = alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "video", "video_id": rickVideo, "profile_id": ap, "quality": 1080}).Expect(201).JSON()
	if src["quality"] != 1080.0 {
		t.Fatalf("explicit quality %v", src["quality"])
	}
}

// A video whose stream URLs point anywhere but the Invidious origin is
// never fetched.
func TestVideoForeignStreamURLsRefused(t *testing.T) {
	f := &fakeInvidious{}
	var foreignHits atomic.Int32
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { foreignHits.Add(1) }))
	defer foreign.Close()
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/videos/"+rickVideo {
			b, _ := os.ReadFile("../video/testdata/video.json")
			_, _ = w.Write([]byte(strings.ReplaceAll(string(b), "http://invidious:3000", foreign.URL)))
			return
		}
		w.WriteHeader(404)
	}))
	defer f.srv.Close()
	env := testutil.New(t, func(c *config.Config) { c.Video.InvidiousURL = f.srv.URL })
	alice, _ := env.NewUserClient("alice", "user")
	code := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "video", "video_id": rickVideo}).Expect(422).ErrorCode()
	if code != "video_unplayable" || foreignHits.Load() != 0 {
		t.Fatalf("code %s, foreign hits %d", code, foreignHits.Load())
	}
}

func TestVideoUnavailable(t *testing.T) {
	env := testutil.New(t) // INVIDIOUS_URL unset
	alice, _ := env.NewUserClient("alice", "user")
	if c := alice.Do("GET", "/api/v1/video/trending", nil).Expect(503).ErrorCode(); c != "video_unavailable" {
		t.Fatal(c)
	}
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "video", "video_id": rickVideo}).Expect(503)
	admin, _ := env.NewUserClient("vadmin", "admin")
	if st := admin.Do("GET", "/api/v1/admin/video/status", nil).Expect(200).JSON(); st["configured"] != false {
		t.Fatalf("status %v", st)
	}
}

func TestVideoPlayCommandPayload(t *testing.T) {
	ok := []string{`{"video_id":"dQw4w9WgXcQ"}`,
		`{"video_id":"dQw4w9WgXcQ","profile_id":"6f1c1f9e-2222-4111-8111-111111111111","position_seconds":42.5,"quality":1080,"force":true,"junk":1}`}
	for _, p := range ok {
		out, media, err := realtime.ValidatePayload("video.play", json.RawMessage(p))
		if err != nil || media != nil || strings.Contains(string(out), "junk") {
			t.Fatalf("%s → %s %v %v", p, out, media, err)
		}
	}
	for _, p := range []string{``, `{}`, `{"video_id":"short"}`, `{"video_id":"dQw4w9WgXc/"}`,
		`{"video_id":"dQw4w9WgXcQ","profile_id":"no"}`, `{"video_id":"dQw4w9WgXcQ","position_seconds":-1}`,
		`{"video_id":"dQw4w9WgXcQ","quality":360}`} {
		if _, _, err := realtime.ValidatePayload("video.play", json.RawMessage(p)); err == nil {
			t.Fatalf("%s accepted", p)
		}
	}
}

// «Подписки» a page at a time (offset/limit → next_offset); list titles come
// back in the uploader's language from the channel's RSS feed.
func TestVideoFeedPagingAndOriginalTitles(t *testing.T) {
	env, _ := newVideoEnv(t)
	alice, _ := env.NewUserClient("alice", "user")
	ap := alice.Do("POST", "/api/v1/profiles", map[string]string{"name": "Alice"}).Expect(201).JSON()["id"].(string)
	q := "?profile_id=" + ap
	alice.Do("PUT", "/api/v1/video/subscriptions/"+rickChannel+q, nil).Expect(200)
	alice.Do("PUT", "/api/v1/video/subscriptions/"+otherChannel+q, nil).Expect(200)
	env.Server.Video.RefreshFeeds(context.Background())

	for _, bad := range []string{"&offset=-1", "&offset=5001", "&offset=x", "&limit=0", "&limit=201"} {
		alice.Do("GET", "/api/v1/video/feed"+q+bad, nil).Expect(422)
	}
	// 8 entries (6 Rick + 2 Other, one a Short): pages of 3 with Shorts kept.
	var all []string
	offset := 0
	for page := 0; page < 5; page++ {
		r := alice.Do("GET", fmt.Sprintf("/api/v1/video/feed%s&shorts=true&limit=3&offset=%d", q, offset), nil).Expect(200).JSON()
		for _, it := range r["items"].([]any) {
			all = append(all, it.(map[string]any)["id"].(string))
		}
		next, ok := r["next_offset"].(float64)
		if !ok {
			if page != 2 {
				t.Fatalf("last page at %d", page)
			}
			break
		}
		offset = int(next)
	}
	seen := map[string]bool{}
	for _, id := range all {
		if seen[id] {
			t.Fatalf("duplicate %s across pages %v", id, all)
		}
		seen[id] = true
	}
	if len(all) != 8 || !seen["shortSHORT1"] {
		t.Fatalf("paged feed %v", all)
	}
	// Default: one page of 100, both Shorts dropped, no next page.
	r := alice.Do("GET", "/api/v1/video/feed"+q, nil).Expect(200).JSON()
	if len(r["items"].([]any)) != 6 || r["next_offset"] != nil {
		t.Fatalf("default feed %v", r)
	}
	// The stored feed carries the RSS title…
	title := func(items []map[string]any, id string) string {
		for _, it := range items {
			if it["id"] == id {
				return it["title"].(string)
			}
		}
		return ""
	}
	feed := alice.Do("GET", "/api/v1/video/feed"+q, nil).Expect(200).Items()
	if got := title(feed, "PXC_PYeB6F8"); got != "Рик Эстли — Ангелы на моей стороне" {
		t.Fatalf("feed title %q", got)
	}
	// …and so does the channel page.
	ch := alice.Do("GET", "/api/v1/video/channels/"+rickChannel+q, nil).Expect(200).JSON()
	var vids []map[string]any
	for _, v := range ch["videos"].([]any) {
		vids = append(vids, v.(map[string]any))
	}
	if got := title(vids, "PXC_PYeB6F8"); got != "Рик Эстли — Ангелы на моей стороне" {
		t.Fatalf("channel title %q", got)
	}
	if got := title(vids, "LaOUkDBDjW8"); got != "Rick Astley - Dance (Live at The O2, London, April 2026)" {
		t.Fatalf("unknown title changed: %q", got)
	}
}
