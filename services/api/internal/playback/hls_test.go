package playback

import (
	"context"
	"errors"
	"flag"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestRewritePlaylistGolden(t *testing.T) {
	base, _ := url.Parse("https://cdn.example/videos/8789/1/720/index.m3u8?token=abc")
	mk := func(abs string) string { return "P(" + abs + ")" }
	for _, tc := range []struct{ name, in, want string }{
		{
			name: "media playlist, absolute + relative + root-relative segments",
			in: "#EXTM3U\r\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:19\n#EXTINF:11.3,\n" +
				"https://cache-rfn.libria.fun/videos/media/ts/8789/1/720/fff0.ts\n#EXTINF:8.7,\nfff1.ts\n" +
				"#EXTINF:8.7,\n/abs/fff2.ts?x=1#frag\n#EXTINF:1,\n../480/fff3.ts\n#EXT-X-ENDLIST\n",
			want: "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:19\n#EXTINF:11.3,\n" +
				"P(https://cache-rfn.libria.fun/videos/media/ts/8789/1/720/fff0.ts)\n#EXTINF:8.7,\n" +
				"P(https://cdn.example/videos/8789/1/720/fff1.ts)\n#EXTINF:8.7,\nP(https://cdn.example/abs/fff2.ts?x=1)\n" +
				"#EXTINF:1,\nP(https://cdn.example/videos/8789/1/480/fff3.ts)\n#EXT-X-ENDLIST\n",
		},
		{
			name: "keys, init map, data URIs kept, unproxyable dropped",
			in: "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x1\n#EXT-X-MAP:URI=\"init.mp4\"\n" +
				"#EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,AAAA\"\n#EXTINF:4,\nseg.m4s\n" +
				"#EXT-X-KEY:METHOD=AES-128,URI=\"file:///etc/passwd\"\n#EXTINF:4,\nftp://x/y.ts\n#EXTINF:4,\njavascript:alert(1)\n",
			want: "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"P(https://cdn.example/videos/8789/1/720/key.bin)\",IV=0x1\n" +
				"#EXT-X-MAP:URI=\"P(https://cdn.example/videos/8789/1/720/init.mp4)\"\n" +
				"#EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,AAAA\"\n#EXTINF:4,\n" +
				"P(https://cdn.example/videos/8789/1/720/seg.m4s)\n#EXTINF:4,\n#EXTINF:4,\n",
		},
		{
			name: "master playlist with renditions",
			in: "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"ru\",URI=\"audio/ru.m3u8\"\n" +
				"#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO=\"a\"\n720.m3u8\n" +
				"#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\"if.m3u8\"\n",
			want: "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"ru\",URI=\"P(https://cdn.example/videos/8789/1/720/audio/ru.m3u8)\"\n" +
				"#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO=\"a\"\nP(https://cdn.example/videos/8789/1/720/720.m3u8)\n" +
				"#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI=\"P(https://cdn.example/videos/8789/1/720/if.m3u8)\"\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out, err := rewritePlaylist([]byte(tc.in), base, mk)
			if err != nil {
				t.Fatal(err)
			}
			if string(out) != tc.want {
				t.Fatalf("got:\n%s\nwant:\n%s", out, tc.want)
			}
		})
	}
	if _, err := rewritePlaylist([]byte("<html>nope</html>"), base, mk); err == nil {
		t.Fatal("non-playlist accepted")
	}
	if _, err := rewritePlaylist([]byte("\xef\xbb\xbf#EXTM3U\nseg.ts\n"), base, mk); err != nil {
		t.Fatalf("BOM playlist rejected: %v", err)
	}
}

func TestURLSignerTamper(t *testing.T) {
	s := newURLSigner([]byte("secret-1"))
	const src = "11111111-1111-1111-1111-111111111111"
	u := "https://cache-rfn.libria.fun/videos/media/ts/8789/1/720/fff0.ts"
	ref := s.ref(src, u)
	if !strings.HasSuffix(ref, ".ts") || strings.Contains(ref, "/") {
		t.Fatalf("ref = %q", ref)
	}
	got, err := s.open(src, ref)
	if err != nil || got != u {
		t.Fatalf("open = %q, %v", got, err)
	}
	parts := strings.Split(ref, ".")
	// Another source's token cannot reuse the ref.
	if _, err := s.open("22222222-2222-2222-2222-222222222222", ref); err == nil {
		t.Fatal("ref accepted for another source")
	}
	// Another secret.
	if _, err := newURLSigner([]byte("secret-2")).open(src, ref); err == nil {
		t.Fatal("ref accepted with another key")
	}
	// Swapped URL with the old MAC (open proxy attempt).
	evil := s.ref(src, "http://169.254.169.254/latest/meta-data")
	ep := strings.Split(evil, ".")
	for _, bad := range []string{
		ep[0] + "." + parts[1] + ".ts",
		parts[0] + "." + parts[1][:len(parts[1])-2] + "AA.ts",
		parts[0] + ".ts",
		"",
		"index.m3u8",
		strings.Repeat("A", 5000) + "." + parts[1] + ".ts",
	} {
		if _, err := s.open(src, bad); err == nil {
			t.Fatalf("tampered ref %q accepted", bad)
		}
	}
	// Even a correctly signed non-http(s) URL is refused.
	if _, err := s.open(src, s.ref(src, "file:///etc/passwd")); err == nil {
		t.Fatal("file URL accepted")
	}
}

func TestPublicIP(t *testing.T) {
	for ip, want := range map[string]bool{
		"127.0.0.1": false, "10.1.2.3": false, "192.168.1.1": false, "172.16.0.1": false, "169.254.169.254": false,
		"100.64.0.1": false, "::1": false, "fd00::1": false, "0.0.0.0": false,
		"8.8.8.8": true, "185.1.2.3": true, "2a00:1450::1": true,
	} {
		if got := publicIP(net.ParseIP(ip)); got != want {
			t.Errorf("publicIP(%s) = %v", ip, got)
		}
	}
}

func TestUpstreamClientRefusesPrivateAddresses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("#EXTM3U\n"))
	}))
	defer srv.Close()
	_, _, _, err := fetchPlaylist(context.Background(), newUpstreamClient(false), srv.URL+"/a.m3u8", nil)
	if err == nil || !errors.Is(err, errBlockedTarget) {
		t.Fatalf("loopback fetch err = %v", err)
	}
	body, _, status, err := fetchPlaylist(context.Background(), newUpstreamClient(true), srv.URL+"/a.m3u8", nil)
	if err != nil || status != 200 || string(body) != "#EXTM3U\n" {
		t.Fatalf("allowed fetch = %q %d %v", body, status, err)
	}
}

var updateGolden = flag.Bool("update", false, "rewrite golden files")

// TestKeepAudioGolden: a real Collaps master (17 voices × 2 CDN groups,
// URLs shortened) reduced to the 3rd voice («НТВ»), then rewritten through
// the proxy like streamOnline does.
func TestKeepAudioGolden(t *testing.T) {
	in, err := os.ReadFile("testdata/collaps_master.m3u8")
	if err != nil {
		t.Fatal(err)
	}
	out := keepAudio(in, 3)
	base, _ := url.Parse("https://cdn-a.example/m/master.m3u8?t=1&vp")
	signer := newURLSigner([]byte("golden"))
	rewritten, err := rewritePlaylist(out, base, func(abs string) string { return "/api/v1/stream/TOKEN/" + signer.ref("src", abs) })
	if err != nil {
		t.Fatal(err)
	}
	golden := "testdata/collaps_master_track3.golden.m3u8"
	if *updateGolden {
		if err := os.WriteFile(golden, rewritten, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if string(rewritten) != string(want) {
		t.Fatalf("golden mismatch (go test -run TestKeepAudioGolden -update):\n%s", rewritten)
	}
	// Exactly one audio rendition per group, the chosen one, as default.
	s := string(out)
	if n := strings.Count(s, "TYPE=AUDIO"); n != 2 {
		t.Fatalf("audio renditions: %d\n%s", n, s)
	}
	for _, g := range []string{`GROUP-ID="audio0",NAME="rus2",DEFAULT=YES,AUTOSELECT=YES`, `GROUP-ID="failover-audio-0",NAME="rus2",DEFAULT=YES,AUTOSELECT=YES`} {
		if !strings.Contains(s, g) {
			t.Fatalf("missing %s", g)
		}
	}
	if strings.Count(s, "#EXT-X-STREAM-INF") != 4 || strings.Contains(s, "rus0") || strings.Contains(s, "eng16") {
		t.Fatalf("variants/other voices:\n%s", s)
	}
}

func TestKeepAudioEdgeCases(t *testing.T) {
	media := []byte("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n")
	if string(keepAudio(media, 2)) != string(media) {
		t.Fatal("media playlist changed")
	}
	master := []byte("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"x\",URI=\"x.m3u8\"\n" +
		"#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"s\",NAME=\"s\",URI=\"s.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"a\"\nv.m3u8\n")
	if string(keepAudio(master, 0)) != string(master) || string(keepAudio(master, 2)) != string(master) {
		t.Fatal("out-of-range track must keep the playlist")
	}
	got := string(keepAudio(master, 1))
	if !strings.Contains(got, `NAME="x",URI="x.m3u8",DEFAULT=YES,AUTOSELECT=YES`) || !strings.Contains(got, "TYPE=SUBTITLES") {
		t.Fatalf("got\n%s", got)
	}
}
