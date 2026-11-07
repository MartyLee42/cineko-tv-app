package livecheck

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// tsPacket builds one 188-byte packet carrying a PSI section on pid.
func tsPacket(pid int, section []byte) []byte {
	p := []byte{0x47, 0x40 | byte(pid>>8), byte(pid), 0x10, 0x00}
	p = append(p, section...)
	for len(p) < 188 {
		p = append(p, 0xff)
	}
	return p
}

// tsWith returns a PAT + PMT announcing a video and an audio stream type
// (desc: ES descriptors of the audio stream).
func tsWith(video, audio byte, desc ...byte) []byte {
	pat := []byte{0x00, 0xb0, 13, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe1, 0x00, 0, 0, 0, 0}
	es := []byte{video, 0xe1, 0x01, 0xf0, 0x00, audio, 0xe1, 0x02, 0xf0, byte(len(desc))}
	es = append(es, desc...)
	pmt := []byte{0x02, 0xb0, byte(9 + len(es) + 4), 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00}
	pmt = append(pmt, es...)
	pmt = append(pmt, 0, 0, 0, 0)
	return append(tsPacket(0, pat), tsPacket(0x100, pmt)...)
}

func TestSniffTS(t *testing.T) {
	cases := []struct {
		b            []byte
		video, audio string
	}{
		{tsWith(0x1b, 0x0f), "h264", "aac"},
		{tsWith(0x24, 0x0f), "hevc", "aac"},
		{tsWith(0x02, 0x03), "mpeg2", "mp2"},
		{tsWith(0x1b, 0x81), "h264", "ac3"},
		{tsWith(0x1b, 0x06, 0x7a, 0x00), "h264", "eac3"},
		{tsWith(0x1b, 0x06, 0x6a, 0x00), "h264", "ac3"},
		{append([]byte{0x00, 0x12}, tsWith(0x1b, 0x0f)...), "h264", "aac"}, // not packet aligned
	}
	for i, c := range cases {
		if v, a := sniffTS(c.b); v != c.video || a != c.audio {
			t.Errorf("%d: got %s/%s, want %s/%s", i, v, a, c.video, c.audio)
		}
	}
}

func TestCodecsAttr(t *testing.T) {
	if v, a := codecsAttr("avc1.64001f,mp4a.40.2"); v != "h264" || a != "aac" {
		t.Fatal(v, a)
	}
	if v, a := codecsAttr("hvc1.1.6.L93.B0, ec-3"); v != "hevc" || a != "eac3" {
		t.Fatal(v, a)
	}
}

func TestCheck(t *testing.T) {
	seg := tsWith(0x1b, 0x0f)
	ac3 := tsWith(0x1b, 0x81)
	mux := http.NewServeMux()
	mux.HandleFunc("/ok/master.m3u8", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") != "TestUA" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		w.Write([]byte("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS=\"avc1.4d401f,mp4a.40.2\"\nv/index.m3u8\n"))
	})
	mux.HandleFunc("/ok/v/index.m3u8", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n1.ts\n#EXTINF:6,\n2.ts\n#EXTINF:6,\n/abs/3.ts\n"))
	})
	mux.HandleFunc("/ok/v/1.ts", func(w http.ResponseWriter, r *http.Request) { w.Write(seg) })
	mux.HandleFunc("/ac3/index.m3u8", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("#EXTM3U\n#EXTINF:6,\nseg.ts\n"))
	})
	mux.HandleFunc("/ac3/seg.ts", func(w http.ResponseWriter, r *http.Request) { w.Write(ac3) })
	mux.HandleFunc("/raw.ts", func(w http.ResponseWriter, r *http.Request) { w.Write(seg) })
	mux.HandleFunc("/geo.m3u8", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "geo", http.StatusForbidden) })
	mux.HandleFunc("/html.m3u8", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("<html>blocked</html>")) })
	mux.HandleFunc("/dash.mpd", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`<?xml version="1.0"?><MPD>`)) })
	mux.HandleFunc("/empty.m3u8", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("#EXTM3U\n#EXT-X-TARGETDURATION:6\n")) })
	mux.HandleFunc("/segfail/index.m3u8", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("#EXTM3U\n#EXTINF:6,\ngone.ts\n"))
	})
	mux.HandleFunc("/key/index.m3u8", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\"\n#EXTINF:6,\ns.ts\n"))
	})
	mux.HandleFunc("/key/k.bin", func(w http.ResponseWriter, r *http.Request) { w.Write(make([]byte, 16)) })
	mux.HandleFunc("/key/s.ts", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte{1, 2, 3}) })
	mux.HandleFunc("/slow.m3u8", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(3 * time.Second):
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	hc := &http.Client{Timeout: 500 * time.Millisecond}
	ctx := context.Background()

	cases := []struct {
		path    string
		headers map[string]string
		health  string
		cause   string
		format  string
		video   string
		audio   string
	}{
		{"/ok/master.m3u8", map[string]string{"User-Agent": "TestUA"}, HealthOK, "ok", "hls", "h264", "aac"},
		{"/ok/master.m3u8", nil, HealthGeo, "http_403", "", "", ""}, // the #EXTVLCOPT UA is needed
		{"/ac3/index.m3u8", nil, HealthCodec, "codec_ac3", "hls", "h264", "ac3"},
		{"/raw.ts", nil, HealthOK, "ok", "ts", "h264", "aac"},
		{"/geo.m3u8", nil, HealthGeo, "http_403", "", "", ""},
		{"/missing.m3u8", nil, HealthDead, "http_404", "", "", ""},
		{"/html.m3u8", nil, HealthDead, "not_stream", "", "", ""},
		{"/dash.mpd", nil, HealthDead, "dash", "dash", "", ""},
		{"/empty.m3u8", nil, HealthDead, "empty_playlist", "hls", "", ""},
		{"/segfail/index.m3u8", nil, HealthDead, "segment_http_404", "hls", "", ""},
		{"/key/index.m3u8", nil, HealthOK, "ok", "hls", "", ""},
		{"/slow.m3u8", nil, HealthTimeout, "timeout", "", "", ""},
	}
	for _, c := range cases {
		r := Check(ctx, hc, srv.URL+c.path, c.headers)
		if r.Health != c.health || r.Cause != c.cause || r.Format != c.format || r.Video != c.video || r.Audio != c.audio {
			t.Errorf("%s: got %+v", c.path, r)
		}
	}
	if r := Check(ctx, hc, "http://no-such-host.invalid/x.m3u8", nil); r.Health != HealthDead || r.Cause != "dns" {
		t.Errorf("dns: %+v", r)
	}
	if r := Check(ctx, hc, "http://127.0.0.1:1/x.m3u8", nil); r.Health != HealthDead || r.Cause != "connect" {
		t.Errorf("refused: %+v", r)
	}
}

func TestFailedHealth(t *testing.T) {
	for cause, want := range map[string]string{
		"http_403": HealthGeo, "http_451": HealthGeo, "variant_http_403": HealthGeo, "timeout": HealthTimeout,
		"segment_timeout": HealthTimeout, "dns": HealthDead, "http_404": HealthDead, "http_5xx": HealthDead,
	} {
		if got := Failed(cause).Health; got != want {
			t.Errorf("%s: %s, want %s", cause, got, want)
		}
	}
	if !strings.HasPrefix(HTTPCause(410), "http_404") || HTTPCause(503) != "http_5xx" || HTTPCause(429) != "http_429" {
		t.Fatal("HTTPCause")
	}
}
