package playback

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestParseSidxRealYouTube(t *testing.T) {
	for _, tc := range []struct {
		file          string
		from          int64
		count         int
		first, maxDur float64
	}{
		{"../video/testdata/sidx_136.bin", 740, 38, 5.24, 7.0},
		{"../video/testdata/sidx_140.bin", 723, 22, 9.98, 9.99},
	} {
		b, err := os.ReadFile(tc.file)
		if err != nil {
			t.Fatal(err)
		}
		segs, err := parseSidx(b, tc.from)
		if err != nil {
			t.Fatal(tc.file, err)
		}
		if len(segs) != tc.count {
			t.Fatalf("%s: %d segments", tc.file, len(segs))
		}
		// The first fragment starts right after the sidx box.
		if segs[0].Offset != tc.from+int64(len(b)) {
			t.Fatalf("%s: first offset %d", tc.file, segs[0].Offset)
		}
		total := 0.0
		for i, s := range segs {
			if i > 0 && s.Offset != segs[i-1].Offset+segs[i-1].Size {
				t.Fatalf("%s: gap at %d", tc.file, i)
			}
			if s.Duration > tc.maxDur+0.01 {
				t.Fatalf("%s: fragment %d is %.2f s", tc.file, i, s.Duration)
			}
			total += s.Duration
		}
		if total < 210 || total > 215 { // the video is 3:33
			t.Fatalf("%s: total %.1f s", tc.file, total)
		}
		if d := segs[0].Duration; d < tc.first-0.01 || d > tc.first+0.01 {
			t.Fatalf("%s: first duration %.3f", tc.file, d)
		}
	}
	if _, err := parseSidx([]byte("garbage-garbage-garbage-garbage-garbage"), 0); err == nil {
		t.Fatal("garbage accepted")
	}
	b, _ := os.ReadFile("../video/testdata/sidx_136.bin")
	if _, err := parseSidx(b[:100], 0); err == nil {
		t.Fatal("truncated box accepted")
	}
	h := append([]byte{}, b...)
	h[12+8+8+4] |= 0x80 // first reference → another sidx
	if _, err := parseSidx(h, 0); err == nil {
		t.Fatal("hierarchical sidx accepted")
	}
}

func TestVideoPlaylists(t *testing.T) {
	segs := []sidxSegment{{Offset: 1228, Size: 1000, Duration: 5.24}, {Offset: 2228, Size: 900, Duration: 6.96}}
	pl := string(mediaPlaylist("m136.mp4", 740, segs))
	for _, want := range []string{
		"#EXT-X-TARGETDURATION:7\n", "#EXT-X-PLAYLIST-TYPE:VOD\n", `#EXT-X-MAP:URI="m136.mp4",BYTERANGE="740@0"`,
		"#EXTINF:5.240,\n#EXT-X-BYTERANGE:1000@1228\nm136.mp4\n", "#EXT-X-BYTERANGE:900@2228\n", "#EXT-X-ENDLIST\n",
	} {
		if !strings.Contains(pl, want) {
			t.Fatalf("media playlist lacks %q:\n%s", want, pl)
		}
	}
	v := &VideoTrack{Itag: 136, Width: 1280, Height: 720, FPS: 25, Bandwidth: 1_000_000, Codecs: "avc1.4D401F"}
	a := &VideoTrack{Itag: 140, Bandwidth: 130_000, Codecs: "mp4a.40.2"}
	m := string(masterPlaylist(v, a))
	for _, want := range []string{
		`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="a140.m3u8"`,
		`#EXT-X-STREAM-INF:BANDWIDTH=1130000,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",FRAME-RATE=25.000,AUDIO="aud"` + "\nv136.m3u8\n",
	} {
		if !strings.Contains(m, want) {
			t.Fatalf("master lacks %q:\n%s", want, m)
		}
	}
	tracks := []VideoTrack{{Itag: 137, Height: 1080}, {Itag: 134, Height: 360}, {Itag: 136, Height: 720}, {Itag: 135, Height: 480}}
	for cap, want := range map[int]int{1080: 137, 720: 136, 480: 135, 600: 135, 240: 134} {
		if got := pickVideoTrack(tracks, cap); got.Itag != want {
			t.Fatalf("cap %d → %d, want %d", cap, got.Itag, want)
		}
	}
	if pickVideoTrack(nil, 720) != nil {
		t.Fatal("empty → track")
	}
}

func TestVideoToken(t *testing.T) {
	s := &videoSigner{key: []byte("k")}
	now := time.Now()
	tok, err := s.Sign("dQw4w9WgXcQ", 720, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	id, q, err := s.Verify(tok, now)
	if err != nil || id != "dQw4w9WgXcQ" || q != 720 {
		t.Fatalf("verify: %q %d %v", id, q, err)
	}
	if _, _, err := s.Verify(tok, now.Add(2*time.Hour)); err != errExpiredToken {
		t.Fatalf("expired: %v", err)
	}
	other := &videoSigner{key: []byte("other")}
	if _, _, err := other.Verify(tok, now); err != errBadToken {
		t.Fatalf("foreign key: %v", err)
	}
	if _, err := s.Sign("../etc/pass", 720, now); err == nil {
		t.Fatal("bad id signed")
	}
	// A live/IPTV token is not a video token and vice versa.
	sg := &signer{key: []byte("k")}
	lt, _ := sg.Sign("6f1c1f9e-1111-4111-8111-111111111111", now.Add(time.Hour))
	if _, _, err := s.Verify(lt, now); err == nil {
		t.Fatal("uuid token accepted as video token")
	}
}
