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

	"martytv/api/internal/sources"
)

// balancerCDN imitates the online balancers' CDNs: signed MP4 renditions
// (/mp4/<sig>/<q>.mp4, 403 unless sig is current — like VK's expiring,
// IP-bound URLs) and a Collaps-style multi-audio HLS master.
type balancerCDN struct {
	srv  *httptest.Server
	mp4  []byte
	sig  atomic.Value // current valid signature
	hits sync.Map
}

func newBalancerCDN(t *testing.T) *balancerCDN {
	c := &balancerCDN{mp4: bytes.Repeat([]byte("MP4BYTES"), 4096)}
	c.sig.Store("s1")
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := c.hits.LoadOrStore(r.URL.Path, &atomic.Int32{})
		n.(*atomic.Int32).Add(1)
		switch {
		case strings.HasPrefix(r.URL.Path, "/mp4/"):
			parts := strings.Split(r.URL.Path, "/")
			if len(parts) != 4 || parts[2] != c.sig.Load().(string) || r.Header.Get("Referer") != "https://player.example/" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.Header().Set("Content-Type", "video/mp4")
			http.ServeContent(w, r, "", time.Unix(1700000000, 0), bytes.NewReader(c.mp4))
		case r.URL.Path == "/hls/master.m3u8":
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte("#EXTM3U\n" +
				"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"rus0\",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE=\"ru\",URI=\"a1.m3u8\"\n" +
				"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"rus1\",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE=\"ru\",URI=\"a2.m3u8\"\n" +
				"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"eng2\",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE=\"en\",URI=\"a3.m3u8\"\n" +
				"#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x534,AUDIO=\"a\"\nv1.m3u8\n"))
		case strings.HasPrefix(r.URL.Path, "/hls/") && strings.HasSuffix(r.URL.Path, ".m3u8"):
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = w.Write([]byte("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n"))
		case strings.HasSuffix(r.URL.Path, ".ts"):
			_, _ = w.Write([]byte("TS"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(c.srv.Close)
	return c
}

func (c *balancerCDN) count(path string) int32 {
	if n, ok := c.hits.Load(path); ok {
		return n.(*atomic.Int32).Load()
	}
	return 0
}

// fakeBalancer is an online provider like CDNVideoHub (mp4 variants,
// signed URLs re-issued on Refresh) and Collaps (hls + AudioTrack).
type fakeBalancer struct {
	cdn      *balancerCDN
	resolves atomic.Int32
	issued   atomic.Value // signature handed out by Resolve
}

func (p *fakeBalancer) Info() sources.Info {
	return sources.Info{ID: "cdnvideohub", Kind: sources.KindOnline, Title: "CDNVideoHub", Configured: true}
}
func (p *fakeBalancer) Probe(context.Context) error { return nil }
func (p *fakeBalancer) Variants(context.Context, sources.Title) ([]sources.Variant, error) {
	return nil, nil
}
func (p *fakeBalancer) Resolve(_ context.Context, v sources.Variant, q int) (*sources.Stream, error) {
	p.resolves.Add(1)
	if v.Format == "hls" {
		return &sources.Stream{URL: p.cdn.srv.URL + "/hls/master.m3u8", Format: "hls", Quality: 720, AudioTrack: 2, Duration: 1371}, nil
	}
	if q == 0 {
		q = 1080
	}
	sig, _ := p.issued.Load().(string)
	return &sources.Stream{URL: p.cdn.srv.URL + "/mp4/" + sig + "/" + itoa(q) + ".mp4", Format: "mp4", Quality: q, Duration: 8178,
		Headers: map[string]string{"Referer": "https://player.example/"}, Expires: time.Now().Add(24 * time.Hour)}, nil
}

// Refresh: the CDN re-signs (the stale signature stops working).
func (p *fakeBalancer) Refresh(sources.Variant) { p.issued.Store(p.cdn.sig.Load()) }

type balancerProviders struct{ p sources.OnlineProvider }

func (f balancerProviders) Online(_ context.Context, id string) (sources.OnlineProvider, error) {
	if id != "cdnvideohub" {
		return nil, sources.ErrNotFound
	}
	return f.p, nil
}

func TestOnlineBalancerPlayback(t *testing.T) {
	pe := newPlaybackEnv(t)
	cdn := newBalancerCDN(t)
	prov := &fakeBalancer{cdn: cdn}
	prov.issued.Store("s1")
	ref := json.RawMessage(`{"vk":"19023318440670"}`)
	pe.Server.Playback.SetOnline(balancerProviders{prov}, fakeLookup{
		pe.movieID + "|omp4": {ID: "omp4", Provider: "cdnvideohub", Voice: "Дубляж", VoiceKind: "dub", MaxQuality: 1080,
			Qualities: []int{1080, 720, 480}, Format: "mp4", Title: "Матрица (1999)", Ref: ref},
		pe.movieID + "|ohls": {ID: "ohls", Provider: "cdnvideohub", Voice: "НТВ", MaxQuality: 720, Qualities: []int{720},
			Format: "hls", Ref: json.RawMessage(`{"id":"kp/301","v":"НТВ"}`)},
	})
	pe.Server.Playback.SetUpstreamClient(http.DefaultClient) // loopback CDN

	alice, _ := pe.NewUserClient("alice", "user")
	anon := pe.Client()

	// MP4: ready at once, /video.mp4 URL, provider duration for the players.
	res := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "omp4", "quality": 720}).Expect(201)
	if bytes.Contains(res.Body, []byte(cdn.srv.URL)) || bytes.Contains(res.Body, []byte("19023318440670")) {
		t.Fatalf("upstream leaked: %s", res.Body)
	}
	src := res.JSON()
	u, _ := src["stream_url"].(string)
	if src["format"] != "mp4" || src["mime_type"] != "video/mp4" || !strings.HasSuffix(u, "/video.mp4") ||
		src["duration_seconds"] != 8178.0 || src["quality"].(float64) != 720 {
		t.Fatalf("mp4 source: %s", res.Body)
	}
	if got := alice.Do("GET", "/api/v1/playback/sources/"+src["id"].(string), nil).Expect(200).JSON(); got["duration_seconds"] != 8178.0 {
		t.Fatalf("GET duration: %v", got["duration_seconds"])
	}

	// Range pass-through with the provider's headers.
	r := anon.Do("GET", u, nil, "Range", "bytes=8-15").Expect(206)
	if string(r.Body) != "MP4BYTES" || r.Header.Get("Content-Range") != "bytes 8-15/32768" || r.Header.Get("Content-Type") != "video/mp4" {
		t.Fatalf("range: %q %v", r.Body, r.Header)
	}
	if b := anon.Do("GET", u, nil).Expect(200).Body; !bytes.Equal(b, cdn.mp4) {
		t.Fatalf("full body %d bytes", len(b))
	}
	anon.Do("HEAD", u, nil).Expect(200)

	// The signed URL expires (403): the same request re-resolves and retries.
	cdn.sig.Store("s2")
	before := prov.resolves.Load()
	r = anon.Do("GET", u, nil, "Range", "bytes=0-7").Expect(206)
	if string(r.Body) != "MP4BYTES" || prov.resolves.Load() != before+1 || cdn.count("/mp4/s1/720.mp4") < 2 || cdn.count("/mp4/s2/720.mp4") != 1 {
		t.Fatalf("re-resolve: body %q resolves %d→%d s1=%d s2=%d", r.Body, before, prov.resolves.Load(),
			cdn.count("/mp4/s1/720.mp4"), cdn.count("/mp4/s2/720.mp4"))
	}

	// No open proxy for MP4 sources either.
	prefix := strings.TrimSuffix(u, "video.mp4")
	evil := base64.RawURLEncoding.EncodeToString([]byte(cdn.srv.URL + "/mp4/s2/1080.mp4"))
	anon.Do("GET", prefix+evil+".AAAAAAAAAAAAAAAAAAAAAA.mp4", nil).Expect(403)
	anon.Do("GET", prefix+base64.RawURLEncoding.EncodeToString([]byte("http://127.0.0.1:1/x"))+".AAAAAAAAAAAAAAAAAAAAAA.mp4", nil).Expect(403)

	// HLS multi-audio: the master keeps only the variant's voice.
	h := alice.Do("POST", "/api/v1/playback/sources", map[string]any{"media_id": pe.movieID, "release_id": "ohls"}).Expect(201).JSON()
	hu := h["stream_url"].(string)
	if h["format"] != "hls" || !strings.HasSuffix(hu, "/index.m3u8") || h["duration_seconds"] != 1371.0 {
		t.Fatalf("hls source: %v", h)
	}
	pl := string(anon.Do("GET", hu, nil).Expect(200).Body)
	if strings.Count(pl, "TYPE=AUDIO") != 1 || !strings.Contains(pl, `NAME="rus1",DEFAULT=YES,AUTOSELECT=YES`) ||
		strings.Contains(pl, "rus0") || strings.Contains(pl, "eng2") || strings.Contains(pl, cdn.srv.URL) {
		t.Fatalf("master:\n%s", pl)
	}
	// The kept rendition's playlist is reachable through the proxy.
	i := strings.Index(pl, `URI="`) + 5
	audioURL := pl[i : i+strings.Index(pl[i:], `"`)]
	if a := string(anon.Do("GET", audioURL, nil).Expect(200).Body); !strings.Contains(a, ".ts") || cdn.count("/hls/a2.m3u8") != 1 {
		t.Fatalf("audio playlist: %s", a)
	}
}
