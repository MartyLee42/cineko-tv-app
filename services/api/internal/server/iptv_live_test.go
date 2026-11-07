package server_test

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"martytv/api/internal/config"
	"martytv/api/internal/testutil"
)

// TestIPTVLiveFallbacks: the stream cases found by the real-data checker —
// mirrors of one tvg-id, Pluto-style 2 KB JWT URLs, 206 answers to plain
// GETs, variant playlists without .m3u8 sent as text/plain, dead (DNS) and
// geo-blocked (403) channels failing fast with a cause.
func TestIPTVLiveFallbacks(t *testing.T) {
	jwt := strings.Repeat("J", 2500)
	var deadHits, geoHits atomic.Int32
	var fake *httptest.Server
	fake = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := fake.URL
		switch p := r.URL.Path; {
		case p == "/list.m3u":
			fmt.Fprintf(w, "#EXTM3U\n"+
				"#EXTINF:-1 tvg-id=\"Mirror.ru\",Mirror\n%[1]s/gone/index.m3u8\n"+
				"#EXTINF:-1 tvg-id=\"Mirror.ru\",Mirror (backup)\n%[1]s/good/master.m3u8\n"+
				"#EXTINF:-1 tvg-id=\"Pluto.us\",Pluto\n%[1]s/plu-1.m3u8\n"+
				"#EXTINF:-1 tvg-id=\"Partial.ru\",Partial\n%[1]s/partial/index.m3u8\n"+
				"#EXTINF:-1 tvg-id=\"Plain.ru\",Plain\n%[1]s/plain/master.m3u8\n"+
				"#EXTINF:-1 tvg-id=\"Nxdomain.ru\",Nxdomain\nhttp://no-such-host.invalid/live/index.m3u8\n"+
				"#EXTINF:-1 tvg-id=\"Geo.ru\",Geo\n%[1]s/geo/index.m3u8\n", base)
		case p == "/gone/index.m3u8":
			deadHits.Add(1)
			http.NotFound(w, r)
		case p == "/good/master.m3u8":
			_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n")
		case p == "/good/v.m3u8", p == "/partial/index.m3u8":
			if p == "/partial/index.m3u8" {
				w.WriteHeader(http.StatusPartialContent)
			}
			_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\ns1.ts\n")
		case strings.HasSuffix(p, "/s1.ts"), p == "/pluto/seg.ts":
			if p == "/pluto/seg.ts" && r.URL.Query().Get("jwt") != jwt {
				http.Error(w, "bad jwt", http.StatusForbidden)
				return
			}
			_, _ = w.Write(bytes.Repeat([]byte{0x47, 1, 2, 3}, 47))
		case p == "/plu-1.m3u8": // jmp2.uk-style redirect to a JWT URL
			http.Redirect(w, r, base+"/pluto/master.m3u8?jwt="+jwt, http.StatusFound)
		case p == "/pluto/master.m3u8":
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8?jwt=%s\n", jwt)
		case p == "/pluto/v.m3u8":
			if r.URL.Query().Get("jwt") != jwt {
				http.Error(w, "bad jwt", http.StatusForbidden)
				return
			}
			fmt.Fprintf(w, "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg.ts?jwt=%s\n", jwt)
		case p == "/plain/master.m3u8":
			_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchunklist\n")
		case p == "/plain/chunklist":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\ns1.ts\n")
		case p == "/geo/index.m3u8":
			geoHits.Add(1)
			http.Error(w, "not in your region", http.StatusForbidden)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fake.Close)
	env := testutil.New(t, func(c *config.Config) {
		c.IPTV.AllowPrivate = true
		c.IPTV.ProxyURL = nil
		c.IPTV.OrgEPGOff = true
		c.Catalog.ImageCacheDir = t.TempDir()
	})
	t.Cleanup(env.Server.IPTV.Wait)
	admin, _ := env.NewUserClient("iptvadmin", "admin")
	admin.Do("POST", "/api/v1/admin/iptv/playlists", map[string]any{"kind": "m3u_url", "url": fake.URL + "/list.m3u"}).Expect(201)
	env.Server.IPTV.Wait()
	items := admin.Do("GET", "/api/v1/iptv/channels", nil).Expect(200).Items()
	anon := env.Client()

	// play follows the stream like hls.js: entry → first variant → first segment.
	play := func(name string) {
		t.Helper()
		id := chanByName(t, items, name)["id"].(string)
		src := admin.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "iptv", "channel_id": id}).Expect(201).JSON()
		body := anon.Do("GET", src["stream_url"].(string), nil).Expect(200).Body
		for i := 0; i < 2; i++ {
			var next string
			for _, l := range strings.Split(string(body), "\n") {
				if strings.HasPrefix(l, "/api/v1/live/") {
					next = l
					break
				}
			}
			if next == "" || len(next) > 1500 {
				t.Fatalf("%s: ref %q in %s", name, next, body)
			}
			r := anon.Do("GET", next, nil).Expect(200)
			body = r.Body
			if bytes.HasPrefix(body, []byte("#EXTM3U")) {
				if r.Header.Get("Content-Type") != "application/vnd.apple.mpegurl" || strings.Contains(string(body), fake.URL) {
					t.Fatalf("%s: nested playlist not rewritten: %s", name, body)
				}
				continue
			}
			if body[0] != 0x47 {
				t.Fatalf("%s: segment %q", name, body[:8])
			}
			return
		}
		t.Fatalf("%s: no segment reached", name)
	}
	play("Mirror")  // the first URL is gone (404): its duplicate plays
	play("Pluto")   // 2.5 KB URLs: kept server-side, short refs
	play("Partial") // 206 to a plain GET
	play("Plain")   // variant without .m3u8, text/plain

	// The mirror that worked is remembered: the dead URL isn't tried again.
	hits := deadHits.Load()
	play("Mirror")
	if deadHits.Load() != hits {
		t.Fatal("dead URL retried although a mirror is known to work")
	}

	// Dead (DNS) and geo-blocked channels fail fast with a cause; a retry
	// within the failure TTL is answered from memory.
	for name, code := range map[string]string{"Nxdomain": "channel_unavailable", "Geo": "channel_geo_blocked"} {
		id := chanByName(t, items, name)["id"].(string)
		t0 := time.Now()
		got := admin.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "iptv", "channel_id": id}).Expect(502).ErrorCode()
		if got != code || time.Since(t0) > 5*time.Second {
			t.Fatalf("%s: %s after %v", name, got, time.Since(t0))
		}
	}
	g := geoHits.Load()
	geo := chanByName(t, items, "Geo")["id"].(string)
	admin.Do("POST", "/api/v1/playback/sources", map[string]any{"kind": "iptv", "channel_id": geo}).Expect(502)
	if geoHits.Load() != g {
		t.Fatal("failure not cached")
	}
	after := admin.Do("GET", "/api/v1/iptv/channels", nil).Expect(200).Items()
	for name, health := range map[string]string{"Nxdomain": "dead", "Geo": "geo"} {
		if c := chanByName(t, after, name); c["offline"] != true || c["health"] != health {
			t.Fatalf("%s: %v", name, c)
		}
	}
	if c := chanByName(t, after, "Mirror"); c["offline"] != false {
		t.Fatalf("mirror: %v", c)
	}
}
