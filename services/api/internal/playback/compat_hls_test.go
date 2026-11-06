package playback

import (
	"strings"
	"testing"
)

func TestRewriteHLSPlaylist(t *testing.T) {
	in := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:14\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n" +
		"#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"http://evil/key\"\n#EXTINF:13.5,\nseg0.m4s\n#EXT-X-ENDLIST\n"
	out, err := rewriteHLSPlaylist([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	want := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:14\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n" +
		"#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:13.5,\nseg0.m4s\n#EXT-X-ENDLIST\n"
	if string(out) != want {
		t.Fatalf("got:\n%s", out)
	}
	for _, bad := range []string{
		"",
		"<html>",
		"#EXTM3U\n#EXTINF:4,\nhttp://evil/seg0.m4s\n",
		"#EXTM3U\n#EXTINF:4,\n../seg0.m4s\n",
		"#EXTM3U\n#EXT-X-TARGETDURATION:x\n",
	} {
		if _, err := rewriteHLSPlaylist([]byte(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	// A short first playlist still gets the floor target duration.
	out, _ = rewriteHLSPlaylist([]byte("#EXTM3U\n#EXT-X-TARGETDURATION:4\n"))
	if !strings.Contains(string(out), "#EXT-X-TARGETDURATION:10\n") {
		t.Fatalf("%s", out)
	}
}

func TestCompatMaster(t *testing.T) {
	size, dur, w, h := int64(1_800_000_000), 3600.0, 1920, 1080
	src := &source{FileSize: &size, MediaInfo: &MediaInfo{DurationSeconds: &dur, Width: &w, Height: &h}}
	got := string(compatMaster(src, "0123456789abcdef0123456789abcdef"))
	want := "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=4192000,RESOLUTION=1920x1080\ncompat/0123456789abcdef0123456789abcdef/index.m3u8\n"
	if got != want {
		t.Fatalf("got:\n%s", got)
	}
	if got := string(compatMaster(&source{}, "x")); !strings.Contains(got, "BANDWIDTH=8000000\n") {
		t.Fatalf("default: %s", got)
	}
}
