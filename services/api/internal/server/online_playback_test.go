package server_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"martytv/api/internal/segments"
	"martytv/api/internal/sources"
)

// fakeCDN serves a tiny HLS: /<ver>/<q>.m3u8 (media playlist with a key,
// a relative and an absolute segment) and the segments. /old/ answers 403
// (an expired URL).
type fakeCDN struct {
	srv  *httptest.Server
	seg  []byte
	hits sync.Map // path → *atomic.Int32
}

func newFakeCDN(t *testing.T) *fakeCDN {
	f := &fakeCDN{seg: bytes.Repeat([]byte("TSDATA-"), 2000)}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := f.hits.LoadOrStore(r.URL.Path, &atomic.Int32{})
		n.(*atomic.Int32).Add(1)
		switch {
		case strings.HasPrefix(r.URL.Path, "/old/"):
			w.WriteHeader(http.StatusForbidden)
		case strings.HasSuffix(r.URL.Path, ".m3u8"):
			q := strings.TrimSuffix(r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:], ".m3u8")
			w.Header().Set("Content-Type", "application/x-mpegURL")
			_, _ = w.Write([]byte("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n" +
				"#EXT-X-KEY:METHOD=AES-128,URI=\"keys/k1.key\"\n" +
				"#EXTINF:10,\nseg-" + q + "-0.ts\n#EXTINF:10,\n" + f.srv.URL + "/media/seg-" + q + "-1.ts\n#EXT-X-ENDLIST\n"))
		case strings.HasSuffix(r.URL.Path, ".ts"):
			w.Header().Set("Content-Type", "video/mp2t")
			http.ServeContent(w, r, "", time.Unix(1700000000, 0), bytes.NewReader(f.seg))
		case strings.HasSuffix(r.URL.Path, ".vtt"):
			w.Header().Set("Content-Type", "text/vtt")
			_, _ = w.Write([]byte("WEBVTT\n"))
		case strings.HasSuffix(r.URL.Path, ".key"):
			_, _ = w.Write([]byte("0123456789abcdef"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeCDN) count(path string) int32 {
	if n, ok := f.hits.Load(path); ok {
		return n.(*atomic.Int32).Load()
	}
	return 0
}

// fakeAnime is an online provider whose first resolution is stale (403)
// until Refresh is called, like an expired signed CDN URL.
type fakeAnime struct {
	cdn       *fakeCDN
	stale     atomic.Bool
	refreshed atomic.Int32
	resolves  atomic.Int32
}

func (p *fakeAnime) Info() sources.Info {
	return sources.Info{ID: "anilibria", Kind: sources.KindAnime, Title: "AniLiberty", Configured: true}
}
func (p *fakeAnime) Probe(context.Context) error { return nil }
func (p *fakeAnime) Variants(context.Context, sources.Title) ([]sources.Variant, error) {
	return nil, nil
}
func (p *fakeAnime) Resolve(_ context.Context, v sources.Variant, q int) (*sources.Stream, error) {
	p.resolves.Add(1)
	if q == 0 {
		q = 1080
	}
	ver := "v1"
	if p.stale.Load() {
		ver = "old"
	}
	return &sources.Stream{URL: p.cdn.srv.URL + "/" + ver + "/" + itoa(q) + ".m3u8?ep=" + itoa(v.Episode), Format: "hls", Quality: q,
		Subtitles: []sources.Subtitle{{URL: p.cdn.srv.URL + "/subs/ru.vtt", Lang: "ru", Label: "Надписи"}}}, nil
}
func (p *fakeAnime) Refresh(sources.Variant) { p.refreshed.Add(1); p.stale.Store(false) }
func (p *fakeAnime) SkipMarkers(context.Context, sources.Variant) map[string][2]float64 {
	return map[string][2]float64{"opening": {56, 145}}
}

type fakeSegments struct {
	segs []segments.Segment
	last segments.Query
}

func (f *fakeSegments) Name() string { return "fake" }
func (f *fakeSegments) Fetch(_ context.Context, q segments.Query) ([]segments.Segment, error) {
	f.last = q
	return f.segs, nil
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

type fakeProviders struct{ p sources.OnlineProvider }

func (f fakeProviders) Online(_ context.Context, id string) (sources.OnlineProvider, error) {
	if id != "anilibria" {
		return nil, sources.ErrNotFound
	}
	return f.p, nil
}

type fakeLookup map[string]sources.Variant // media|variant → variant

func (f fakeLookup) LookupVariant(_ context.Context, mediaID, id string) (*sources.Variant, error) {
	v, ok := f[mediaID+"|"+id]
	if !ok {
		return nil, sources.ErrNotFound
	}
	return &v, nil
}

func TestOnlinePlaybackHLSProxy(t *testing.T) {
	pe := newPlaybackEnv(t)
	cdn := newFakeCDN(t)
	prov := &fakeAnime{cdn: cdn}
	prov.stale.Store(true)
	ref := json.RawMessage(`{"r":8789}`)
	lookup := fakeLookup{
		pe.movieID + "|omovie": {ID: "omovie", Provider: "anilibria", Voice: "AniLibria", VoiceKind: "mvo", MaxQuality: 1080,
			Qualities: []int{1080, 720, 480}, Format: "hls", Title: "Твоё имя", Ref: ref},
		pe.showID + "|oseason": {ID: "oseason", Provider: "anilibria", Voice: "AniLibria", VoiceKind: "mvo", MaxQuality: 1080,
			Qualities: []int{1080, 720, 480}, Format: "hls", Season: 1, Episodes: []int{1, 2}, Ref: ref},
		pe.movieID + "|ogone": {ID: "ogone", Provider: "kodik", Format: "hls", Ref: ref},
	}
	pe.Server.Playback.SetOnline(fakeProviders{prov}, lookup)
	pe.Server.Playback.SetUpstreamClient(http.DefaultClient) // the fake CDN is on loopback

	alice, _ := pe.NewUserClient("alice", "user")
	bob, _ := pe.NewUserClient("bob", "user")
	anon := pe.Client()

	// Unknown / foreign-media / disabled-provider variants.
	if code := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "onope"}).Expect(404).ErrorCode(); code != "release_not_found" {
		t.Fatal(code)
	}
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.showID, "release_id": "omovie", "episode_id": pe.episodes[1]}).Expect(404)
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "ogone"}).Expect(502)
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "omovie", "quality": -5}).Expect(422)

	// Create: ready at once, HLS stream URL, release rendered with the studio.
	res := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "omovie", "quality": 720}).Expect(201)
	if bytes.Contains(res.Body, []byte(cdn.srv.URL)) || bytes.Contains(res.Body, []byte("8789")) {
		t.Fatalf("upstream leaked: %s", res.Body)
	}
	src := res.JSON()
	id := src["id"].(string)
	streamURL, _ := src["stream_url"].(string)
	if src["status"] != "ready" || src["kind"] != "online" || src["format"] != "hls" || src["quality"].(float64) != 720 ||
		!strings.HasSuffix(streamURL, "/index.m3u8") || src["mime_type"] != "application/vnd.apple.mpegurl" || src["torrent"] != nil {
		t.Fatalf("source: %s", res.Body)
	}
	vo := src["release"].(map[string]any)["voiceovers"].([]any)[0].(map[string]any)
	if vo["studio"] != "AniLibria" || vo["kind"] != "mvo" {
		t.Fatalf("voiceover: %v", vo)
	}
	again := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "omovie", "quality": 720}).Expect(201).JSON()
	if again["id"] != id {
		t.Fatal("online source not reused")
	}
	got := alice.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200).JSON()
	if m, _ := got["markers"].([]any); len(m) != 1 || m[0].(map[string]any)["kind"] != "opening" || got["media_info"] != nil || got["file"] != nil {
		t.Fatalf("markers/media_info: %v", got)
	}
	// Intro databases: the provider's opening wins, their credits join.
	db := &fakeSegments{segs: []segments.Segment{{Kind: "opening", Start: 50, End: 140, Source: "theintrodb"}, {Kind: "ending", Start: 5000, Source: "theintrodb"}}}
	pe.Server.Playback.SetSegments(segments.New(pe.Pool, nil, db))
	got = alice.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(200).JSON()
	if m, _ := got["markers"].([]any); len(m) != 2 || m[0].(map[string]any)["source"] != "provider" || m[0].(map[string]any)["start_seconds"] != 56.0 ||
		m[1].(map[string]any)["kind"] != "ending" || m[1].(map[string]any)["source"] != "theintrodb" || db.last.TMDBID == 0 || !db.last.Movie {
		t.Fatalf("merged markers: %v (query %+v)", got["markers"], db.last)
	}
	pe.Server.Playback.SetSegments(nil)
	if pr, _ := got["provider"].(map[string]any); pr["id"] != "anilibria" || pr["name"] != "AniLiberty" || pr["kind"] != "anime" {
		t.Fatalf("provider: %v", got["provider"])
	}
	subs, _ := got["subtitles"].([]any)
	if len(subs) != 1 || subs[0].(map[string]any)["lang"] != "ru" {
		t.Fatalf("subtitles: %v", got["subtitles"])
	}
	subURL := subs[0].(map[string]any)["url"].(string)
	if strings.Contains(subURL, "127.0.0.1") || !strings.HasSuffix(subURL, ".vtt") {
		t.Fatalf("subtitle url %q", subURL)
	}
	if b := anon.Do("GET", subURL, nil).Expect(200).Body; string(b) != "WEBVTT\n" {
		t.Fatalf("subtitle body %q", b)
	}
	alice.Do("GET", "/api/v1/playback/sources/"+id+"/files", nil).Expect(404)
	alice.Do("PATCH", "/api/v1/playback/sources/"+id, map[string]any{"file_index": 1}).Expect(422)
	bob.Do("GET", "/api/v1/playback/sources/"+id, nil).Expect(404)
	bob.Do("PATCH", "/api/v1/playback/sources/"+id, map[string]any{"quality": 480}).Expect(404)

	// Playlist: the first upstream URL is stale (403) → re-resolved once.
	r := anon.Do("GET", streamURL, nil).Expect(200)
	if prov.refreshed.Load() != 1 || cdn.count("/old/720.m3u8") != 1 || cdn.count("/v1/720.m3u8") != 1 {
		t.Fatalf("re-resolve: refreshed=%d old=%d new=%d", prov.refreshed.Load(), cdn.count("/old/720.m3u8"), cdn.count("/v1/720.m3u8"))
	}
	if ct := r.Header.Get("Content-Type"); ct != "application/vnd.apple.mpegurl" || r.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("playlist headers: %v", r.Header)
	}
	pl := string(r.Body)
	if strings.Contains(pl, cdn.srv.URL) || strings.Contains(pl, "127.0.0.1") {
		t.Fatalf("playlist leaks upstream:\n%s", pl)
	}
	prefix := strings.TrimSuffix(streamURL, "index.m3u8")
	var segs []string
	for _, line := range strings.Split(pl, "\n") {
		switch {
		case strings.HasPrefix(line, "#EXT-X-KEY"):
			k := line[strings.Index(line, `URI="`)+5 : strings.LastIndex(line, `"`)]
			if !strings.HasPrefix(k, prefix) || !strings.HasSuffix(k, ".key") {
				t.Fatalf("key uri %q", k)
			}
			if body := anon.Do("GET", k, nil).Expect(200).Body; string(body) != "0123456789abcdef" {
				t.Fatalf("key body %q", body)
			}
		case line != "" && !strings.HasPrefix(line, "#"):
			if !strings.HasPrefix(line, prefix) || !strings.HasSuffix(line, ".ts") {
				t.Fatalf("segment uri %q", line)
			}
			segs = append(segs, line)
		}
	}
	if len(segs) != 2 {
		t.Fatalf("segments: %v", segs)
	}
	// Segments (relative and absolute upstream) stream through, Range kept.
	for i, s := range segs {
		r := anon.Do("GET", s, nil).Expect(200)
		if !bytes.Equal(r.Body, cdn.seg) || r.Header.Get("Content-Type") != "video/mp2t" {
			t.Fatalf("segment %d: %d bytes, %v", i, len(r.Body), r.Header)
		}
	}
	r = anon.Do("GET", segs[0], nil, "Range", "bytes=7-13").Expect(206)
	if string(r.Body) != "TSDATA-" {
		t.Fatalf("range body %q", r.Body)
	}
	if cdn.count("/v1/seg-720-0.ts") != 2 || cdn.count("/media/seg-720-1.ts") != 1 {
		t.Fatal("segment upstream paths")
	}

	// No open proxy: tampered / foreign refs and tokens are refused.
	tok := strings.TrimSuffix(strings.TrimPrefix(streamURL, "/api/v1/stream/"), "/index.m3u8")
	seg := strings.TrimPrefix(segs[0], prefix)
	parts := strings.Split(seg, ".")
	evil := base64.RawURLEncoding.EncodeToString([]byte(cdn.srv.URL + "/v1/seg-720-0.ts?x=1"))
	for _, bad := range []string{
		evil + "." + parts[1] + ".ts", // other URL, old MAC
		base64.RawURLEncoding.EncodeToString([]byte("http://169.254.169.254/")) + ".AAAAAAAAAAAAAAAAAAAAAA.ts", // forged
		"x.ts",
	} {
		if code := anon.Do("GET", prefix+bad, nil).Expect(403).ErrorCode(); code != "invalid_stream_url" {
			t.Fatalf("bad ref %q: %s", bad, code)
		}
	}
	anon.Do("GET", "/api/v1/stream/"+tok[:len(tok)-1]+flip(tok[len(tok)-1:])+"/"+seg, nil).Expect(403)
	anon.Do("GET", "/api/v1/stream/"+tok[:len(tok)-1]+flip(tok[len(tok)-1:])+"/index.m3u8", nil).Expect(403)
	// A ref minted for one source does not work with another source's token.
	src2 := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.showID, "release_id": "oseason", "episode_id": pe.episodes[2]}).Expect(201).JSON()
	url2 := src2["stream_url"].(string)
	anon.Do("GET", strings.TrimSuffix(url2, "index.m3u8")+seg, nil).Expect(403)

	// Series: the season variant is narrowed to the episode.
	if src2["kind"] != "online" || src2["episode_id"] != pe.episodes[2] {
		t.Fatalf("series source: %v", src2)
	}
	if pl2 := string(anon.Do("GET", url2, nil).Expect(200).Body); !strings.Contains(pl2, ".ts") {
		t.Fatalf("series playlist: %s", pl2)
	}
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.showID, "release_id": "oseason", "episode_id": pe.episodes[3]}).Expect(422)
	alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.showID, "release_id": "oseason"}).Expect(422)

	// PATCH quality → the next playlist comes from the 480 rendition.
	alice.Do("PATCH", "/api/v1/playback/sources/"+id, map[string]any{"quality": 360}).Expect(422)
	p := alice.Do("PATCH", "/api/v1/playback/sources/"+id, map[string]any{"quality": 480}).Expect(200).JSON()
	if p["quality"].(float64) != 480 {
		t.Fatalf("patched: %v", p)
	}
	if pl := string(anon.Do("GET", p["stream_url"].(string), nil).Expect(200).Body); !strings.Contains(pl, ".ts") || cdn.count("/v1/480.m3u8") != 1 {
		t.Fatalf("480 playlist: %s", pl)
	}

	// Watch sessions work with an online source exactly like a torrent one.
	pid := alice.Do("POST", "/api/v1/profiles", map[string]string{"name": "Alice"}).Expect(201).JSON()["id"].(string)
	sess := startSession(t, alice, map[string]any{"profile_id": pid, "media_id": pe.movieID, "source_id": id})
	expectAccepted(t, report(t, alice, sess["id"].(string), 1, 120, 1435, "playing"), true, "")
}
