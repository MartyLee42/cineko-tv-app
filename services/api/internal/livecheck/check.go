// Package livecheck classifies live (IPTV) streams: it walks a channel the
// way a player does — entry URL → (master → first variant) → media playlist
// → a segment near the live edge — and says why it would not play (dead,
// geo-blocked, timeout, a codec browsers can't decode). Shared by the IPTV
// health check (internal/iptv) and the live proxy's error causes
// (internal/playback).
package livecheck

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Check statuses (iptv_channels.health).
const (
	HealthOK      = "ok"      // plays
	HealthCodec   = "codec"   // reachable, but browsers may not decode it (HEVC, AC-3, MPEG-2)
	HealthGeo     = "geo"     // 403 / 451: blocked for this server's region (or needs a token)
	HealthDead    = "dead"    // 404, DNS, refused, 5xx, not a stream
	HealthTimeout = "timeout" // no answer in time
)

// Result is the checker's verdict.
type Result struct {
	Health string // one of the Health* constants
	// Cause is the fine-grained reason: ok, dns, connect, tls, timeout,
	// blocked, http_403, http_404, http_5xx, http_<n>, not_stream, dash,
	// empty_playlist, segment_<cause>, key_<cause>, codec_<name>.
	Cause  string
	Format string // hls | ts | dash | ""
	Video  string // h264, hevc, mpeg2, ""
	Audio  string // aac, mp3, mp2, ac3, eac3, ""
	// Encrypted: AES-128 segments (key reachable); codecs not sniffed.
	Encrypted bool
}

// checkTimeout bounds one whole walk.
const checkTimeout = 20 * time.Second

// sniffBytes: enough of a segment to find the PAT/PMT (or the fMP4 boxes).
const sniffBytes = 64 << 10

// Check classifies a channel's stream. hc must be an SSRF-guarded client.
func Check(ctx context.Context, hc *http.Client, u string, headers map[string]string) Result {
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	body, final, ct, cause := checkGet(ctx, hc, u, headers, maxPlaylistCheck)
	if cause != "" {
		return Failed(cause)
	}
	head := bytes.TrimLeft(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf")), " \t\r\n")
	switch {
	case bytes.HasPrefix(head, []byte("#EXTM3U")):
		return checkHLS(ctx, hc, body, final, headers)
	case len(body) > 0 && body[0] == 0x47:
		v, a := sniffTS(body)
		return codecVerdict(Result{Format: "ts", Video: v, Audio: a})
	case bytes.Contains(head[:min(len(head), 512)], []byte("<MPD")):
		return Result{Health: HealthDead, Cause: "dash", Format: "dash"}
	case strings.HasPrefix(ct, "video/") && len(body) > 0:
		return Result{Health: HealthOK, Cause: "ok", Format: "ts"}
	}
	return Failed("not_stream")
}

const maxPlaylistCheck = 2 << 20

// Failed is the verdict for a failure cause.
func Failed(cause string) Result {
	h := HealthDead
	switch {
	case strings.HasSuffix(cause, "timeout"):
		h = HealthTimeout
	case strings.HasSuffix(cause, "http_403"), strings.HasSuffix(cause, "http_451"), strings.HasSuffix(cause, "http_401"):
		h = HealthGeo
	}
	return Result{Health: h, Cause: cause}
}

func checkHLS(ctx context.Context, hc *http.Client, body []byte, base *url.URL, headers map[string]string) Result {
	res := Result{Format: "hls"}
	pl := parseM3U8(body, base)
	if len(pl.variants) > 0 {
		v := pl.variants[0]
		res.Video, res.Audio = codecsAttr(v.codecs)
		b, final, _, cause := checkGet(ctx, hc, v.uri, headers, maxPlaylistCheck)
		if cause != "" {
			r := Failed("variant_" + cause)
			r.Format = "hls"
			return r
		}
		if !bytes.HasPrefix(bytes.TrimSpace(b), []byte("#EXTM3U")) {
			return Result{Health: HealthDead, Cause: "variant_not_playlist", Format: "hls"}
		}
		pl = parseM3U8(b, final)
	}
	if len(pl.segments) == 0 {
		return Result{Health: HealthDead, Cause: "empty_playlist", Format: "hls"}
	}
	// hls.js starts ~3 segments before the live edge.
	seg := pl.segments[max(0, len(pl.segments)-3)]
	if pl.keyURI != "" {
		if _, _, _, cause := checkGet(ctx, hc, pl.keyURI, headers, 64); cause != "" {
			r := Failed("key_" + cause)
			r.Format = "hls"
			return r
		}
		res.Encrypted = true
	}
	var init []byte
	if pl.mapURI != "" && !res.Encrypted {
		b, _, _, cause := checkGet(ctx, hc, pl.mapURI, headers, sniffBytes)
		if cause != "" {
			r := Failed("segment_" + cause)
			r.Format = "hls"
			return r
		}
		init = b
	}
	b, _, ct, cause := checkGet(ctx, hc, seg, headers, sniffBytes)
	if cause != "" {
		r := Failed("segment_" + cause)
		r.Format = "hls"
		return r
	}
	if res.Encrypted {
		res.Health, res.Cause = HealthOK, "ok"
		return res
	}
	var v, a string
	switch {
	case len(b) > 0 && b[0] == 0x47:
		v, a = sniffTS(b)
	case init != nil || isMP4(b):
		v, a = sniffMP4(append(init, b...))
	case isADTS(b):
		a = "aac"
	case bytes.HasPrefix(b, []byte("ID3")):
		a = "aac" // packed audio (AAC/MP3 with an ID3 timestamp)
	case strings.HasPrefix(ct, "text/html"), bytes.HasPrefix(bytes.TrimSpace(b), []byte("<")):
		return Result{Health: HealthDead, Cause: "segment_not_media", Format: "hls"}
	}
	if v != "" {
		res.Video = v
	}
	if a != "" {
		res.Audio = a
	}
	return codecVerdict(res)
}

// codecVerdict: browsers (MSE via hls.js, desktop Chrome/Firefox) can't
// decode MPEG-2 video and usually not HEVC / AC-3 / E-AC-3; TV engines with
// native HLS mostly can.
func codecVerdict(r Result) Result {
	r.Health, r.Cause = HealthOK, "ok"
	switch {
	case r.Video == "mpeg2" || r.Video == "hevc":
		r.Health, r.Cause = HealthCodec, "codec_"+r.Video
	case r.Audio == "ac3" || r.Audio == "eac3":
		r.Health, r.Cause = HealthCodec, "codec_"+r.Audio
	}
	return r
}

// checkGet GETs u (≤ limit bytes read) and returns the body, the final URL,
// the content type, or a cause.
func checkGet(ctx context.Context, hc *http.Client, u string, headers map[string]string, limit int64) ([]byte, *url.URL, string, string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, nil, "", "bad_url"
	}
	req.Header.Set("User-Agent", DefaultUA)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, nil, "", NetCause(ctx, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		return nil, nil, "", HTTPCause(resp.StatusCode)
	}
	// A playlist is read up to limit; anything else (a TS stream never
	// ends) only up to sniffBytes.
	br := bufio.NewReaderSize(resp.Body, 512)
	peek, _ := br.Peek(512)
	if !bytes.HasPrefix(bytes.TrimLeft(bytes.TrimPrefix(peek, []byte("\xef\xbb\xbf")), " \t\r\n"), []byte("#EXTM3U")) {
		limit = min(limit, sniffBytes)
	}
	b, err := io.ReadAll(io.LimitReader(br, limit))
	if err != nil && len(b) == 0 {
		return nil, nil, "", NetCause(ctx, err)
	}
	if len(b) == 0 {
		return nil, nil, "", "empty"
	}
	return b, resp.Request.URL, strings.ToLower(resp.Header.Get("Content-Type")), ""
}

// DefaultUA is what the proxy and the checker send unless the channel says otherwise.
const DefaultUA = "Mozilla/5.0 (Cineko)"

// HTTPCause names an upstream HTTP status.
func HTTPCause(code int) string {
	switch {
	case code == 404 || code == 410:
		return "http_404"
	case code >= 500:
		return "http_5xx"
	}
	return "http_" + strconv.Itoa(code)
}

// NetCause names a transport error (never includes the URL).
func NetCause(ctx context.Context, err error) string {
	var dns *net.DNSError
	var ne net.Error
	var cert *tls.CertificateVerificationError
	switch {
	case strings.Contains(err.Error(), "address not allowed"):
		return "blocked"
	case errors.As(err, &dns):
		if dns.IsTimeout {
			return "timeout"
		}
		return "dns"
	case errors.As(err, &cert), strings.Contains(err.Error(), "tls:"), strings.Contains(err.Error(), "x509"):
		return "tls"
	case ctx.Err() != nil, errors.Is(err, context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return "timeout"
	case strings.Contains(err.Error(), "redirect"):
		return "redirect"
	}
	return "connect"
}

// ---------------------------------------------------------------- M3U8

type m3u8Info struct {
	variants []variant
	segments []string
	keyURI   string // first AES-128 key
	mapURI   string // EXT-X-MAP init segment
}

type variant struct {
	uri    string
	codecs string
}

func codecsOf(line string) string { return quotedAttr(line, `CODECS="`) }

func attrURI(line string) string { return quotedAttr(line, `URI="`) }

func quotedAttr(line, key string) string {
	i := strings.Index(line, key)
	if i < 0 {
		return ""
	}
	rest := line[i+len(key):]
	if j := strings.IndexByte(rest, '"'); j >= 0 {
		return rest[:j]
	}
	return ""
}

func resolveRef(base *url.URL, ref string) string {
	r, err := url.Parse(strings.TrimSpace(ref))
	if err != nil || base == nil {
		return ""
	}
	abs := base.ResolveReference(r)
	if abs.Scheme != "http" && abs.Scheme != "https" {
		return ""
	}
	abs.Fragment = ""
	return abs.String()
}

// parseM3U8 lists the variants (with CODECS) or the segments of a playlist.
func parseM3U8(body []byte, base *url.URL) m3u8Info {
	var p m3u8Info
	sc := bufio.NewScanner(bytes.NewReader(body))
	sc.Buffer(make([]byte, 64<<10), maxPlaylistCheck)
	pendingVariant, codecs := false, ""
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		switch {
		case line == "":
		case strings.HasPrefix(line, "#EXT-X-STREAM-INF"):
			pendingVariant, codecs = true, codecsOf(line)
		case strings.HasPrefix(line, "#EXT-X-KEY"):
			if p.keyURI == "" && strings.Contains(line, "METHOD=AES-128") {
				p.keyURI = resolveRef(base, attrURI(line))
			}
		case strings.HasPrefix(line, "#EXT-X-MAP"):
			if p.mapURI == "" {
				p.mapURI = resolveRef(base, attrURI(line))
			}
		case strings.HasPrefix(line, "#"):
		default:
			abs := resolveRef(base, line)
			if abs == "" {
				continue
			}
			if pendingVariant {
				p.variants = append(p.variants, variant{uri: abs, codecs: codecs})
				pendingVariant = false
			} else {
				p.segments = append(p.segments, abs)
			}
		}
	}
	return p
}

// codecsAttr maps an HLS CODECS attribute to coarse names.
func codecsAttr(s string) (video, audio string) {
	for _, c := range strings.Split(strings.ToLower(s), ",") {
		c = strings.TrimSpace(c)
		switch {
		case strings.HasPrefix(c, "avc"):
			video = "h264"
		case strings.HasPrefix(c, "hvc1"), strings.HasPrefix(c, "hev1"):
			video = "hevc"
		case strings.HasPrefix(c, "mp4a.40.34"), c == "mp4a.6b":
			audio = "mp3"
		case strings.HasPrefix(c, "mp4a"):
			audio = "aac"
		case c == "ac-3":
			audio = "ac3"
		case c == "ec-3":
			audio = "eac3"
		}
	}
	return video, audio
}

// ---------------------------------------------------------------- sniffing

// sniffTS reads the PAT and the first PMT of an MPEG-TS chunk and names the
// video and audio codecs.
func sniffTS(b []byte) (video, audio string) {
	pmtPID := -1
	for off := 0; off+188 <= len(b); off += 188 {
		pkt := b[off : off+188]
		if pkt[0] != 0x47 {
			// Resync once (a chunk may not start at a packet boundary).
			i := bytes.IndexByte(b[off+1:], 0x47)
			if i < 0 {
				return
			}
			off += i + 1 - 188
			continue
		}
		pid := int(pkt[1]&0x1f)<<8 | int(pkt[2])
		if pkt[1]&0x40 == 0 { // payload_unit_start
			continue
		}
		payload := pkt[4:]
		switch (pkt[3] >> 4) & 3 {
		case 2:
			continue
		case 3:
			if int(payload[0])+1 >= len(payload) {
				continue
			}
			payload = payload[1+int(payload[0]):]
		}
		if len(payload) < 1 || int(payload[0])+1 >= len(payload) {
			continue
		}
		sec := payload[1+int(payload[0]):] // skip pointer_field
		switch {
		case pid == 0 && pmtPID < 0 && len(sec) >= 12 && sec[0] == 0x00:
			n := min(len(sec)-4, 3+(int(sec[1]&0x0f)<<8|int(sec[2]))-4)
			for i := 8; i+4 <= n; i += 4 {
				prog := int(sec[i])<<8 | int(sec[i+1])
				if prog != 0 {
					pmtPID = int(sec[i+2]&0x1f)<<8 | int(sec[i+3])
					break
				}
			}
		case pid == pmtPID && len(sec) >= 12 && sec[0] == 0x02:
			end := min(len(sec)-4, 3+(int(sec[1]&0x0f)<<8|int(sec[2]))-4)
			i := 12 + (int(sec[10]&0x0f)<<8 | int(sec[11]))
			for i+5 <= end {
				st := sec[i]
				esLen := int(sec[i+3]&0x0f)<<8 | int(sec[i+4])
				desc := sec[i+5 : min(end, i+5+esLen)]
				v, a := tsStreamType(st, desc)
				if video == "" && v != "" {
					video = v
				}
				if audio == "" && a != "" {
					audio = a
				}
				i += 5 + esLen
			}
			return
		}
	}
	return
}

func tsStreamType(st byte, desc []byte) (video, audio string) {
	switch st {
	case 0x01, 0x02:
		return "mpeg2", ""
	case 0x1b:
		return "h264", ""
	case 0x24:
		return "hevc", ""
	case 0x0f, 0x11:
		return "", "aac"
	case 0x03, 0x04:
		return "", "mp2" // MPEG-1/2 audio (layer II mostly; III = mp3)
	case 0x81:
		return "", "ac3"
	case 0x87:
		return "", "eac3"
	case 0x06: // private data: descriptors say what
		for i := 0; i+2 <= len(desc); i += 2 + int(desc[i+1]) {
			switch desc[i] {
			case 0x6a:
				return "", "ac3"
			case 0x7a:
				return "", "eac3"
			}
		}
	}
	return "", ""
}

func isMP4(b []byte) bool {
	if len(b) < 8 {
		return false
	}
	t := string(b[4:8])
	return t == "ftyp" || t == "styp" || t == "moof" || t == "moov" || t == "sidx"
}

func isADTS(b []byte) bool { return len(b) > 2 && b[0] == 0xff && b[1]&0xf6 == 0xf0 }

// sniffMP4 looks for sample entry fourccs in an init segment / fragment.
func sniffMP4(b []byte) (video, audio string) {
	has := func(s string) bool { return bytes.Contains(b, []byte(s)) }
	switch {
	case has("avc1"), has("avc3"):
		video = "h264"
	case has("hvc1"), has("hev1"):
		video = "hevc"
	}
	switch {
	case has("mp4a"):
		audio = "aac"
	case has("ac-3"):
		audio = "ac3"
	case has("ec-3"):
		audio = "eac3"
	}
	return video, audio
}
