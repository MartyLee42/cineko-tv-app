package playback

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// YouTube serves VOD as DASH: separate fMP4 video and audio files, each with
// an init range (ftyp+moov) and a sidx box listing its fragments. Invidious
// gives no HLS for VOD, so Cineko builds HLS from the sidx: one media
// playlist per file whose segments are EXT-X-BYTERANGEs of that single file
// (init via EXT-X-MAP). hls.js, Safari and TV engines with fMP4 HLS play it;
// the progressive MP4 (itag 18) is the fallback for older engines.

// sidxSegment is one fragment of a DASH representation.
type sidxSegment struct {
	Offset   int64
	Size     int64
	Duration float64 // seconds
}

var errBadSidx = errors.New("invalid sidx box")

// parseSidx reads a sidx box that starts at file offset boxStart.
// Fragment offsets are absolute file offsets. Hierarchical sidx (references
// to other sidx boxes) is not supported.
func parseSidx(b []byte, boxStart int64) ([]sidxSegment, error) {
	if len(b) < 12 {
		return nil, errBadSidx
	}
	size := int64(binary.BigEndian.Uint32(b[0:4]))
	if string(b[4:8]) != "sidx" || size < 32 || size > int64(len(b)) {
		return nil, errBadSidx
	}
	b = b[:size]
	version := b[8]
	p := 12
	need := func(n int) bool { return p+n <= len(b) }
	if !need(8) {
		return nil, errBadSidx
	}
	timescale := binary.BigEndian.Uint32(b[p+4 : p+8])
	p += 8
	var firstOffset uint64
	if version == 0 {
		if !need(8) {
			return nil, errBadSidx
		}
		firstOffset = uint64(binary.BigEndian.Uint32(b[p+4 : p+8]))
		p += 8
	} else {
		if !need(16) {
			return nil, errBadSidx
		}
		firstOffset = binary.BigEndian.Uint64(b[p+8 : p+16])
		p += 16
	}
	if !need(4) || timescale == 0 {
		return nil, errBadSidx
	}
	count := int(binary.BigEndian.Uint16(b[p+2 : p+4]))
	p += 4
	if count == 0 || !need(count*12) || firstOffset > math.MaxInt32 {
		return nil, errBadSidx
	}
	off := boxStart + size + int64(firstOffset)
	out := make([]sidxSegment, 0, count)
	for i := 0; i < count; i++ {
		ref := binary.BigEndian.Uint32(b[p : p+4])
		dur := binary.BigEndian.Uint32(b[p+4 : p+8])
		p += 12
		if ref>>31 == 1 {
			return nil, errors.New("hierarchical sidx not supported")
		}
		n := int64(ref & 0x7fffffff)
		if n == 0 {
			return nil, errBadSidx
		}
		out = append(out, sidxSegment{Offset: off, Size: n, Duration: float64(dur) / float64(timescale)})
		off += n
	}
	return out, nil
}

// mediaPlaylist renders a VOD media playlist for one fMP4 file (uri) with
// its init segment at bytes [0, initLen) and the given fragments.
func mediaPlaylist(uri string, initLen int64, segs []sidxSegment) []byte {
	target := 1
	for _, s := range segs {
		if d := int(math.Ceil(s.Duration - 0.001)); d > target {
			target = d
		}
	}
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:7\n")
	fmt.Fprintf(&b, "#EXT-X-TARGETDURATION:%d\n", target)
	b.WriteString("#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n")
	fmt.Fprintf(&b, "#EXT-X-MAP:URI=\"%s\",BYTERANGE=\"%d@0\"\n", uri, initLen)
	for _, s := range segs {
		fmt.Fprintf(&b, "#EXTINF:%s,\n#EXT-X-BYTERANGE:%d@%d\n%s\n", strconv.FormatFloat(s.Duration, 'f', 3, 64), s.Size, s.Offset, uri)
	}
	b.WriteString("#EXT-X-ENDLIST\n")
	return []byte(b.String())
}

// masterPlaylist renders the master for one video variant (+ one audio
// rendition when audio is non-nil, i.e. separate DASH audio).
func masterPlaylist(v *VideoTrack, audio *VideoTrack) []byte {
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n")
	bw := v.Bandwidth
	codecs := v.Codecs
	audioAttr := ""
	if audio != nil {
		fmt.Fprintf(&b, "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"Audio\",DEFAULT=YES,AUTOSELECT=YES,URI=\"a%d.m3u8\"\n", audio.Itag)
		bw += audio.Bandwidth
		if audio.Codecs != "" {
			codecs += "," + audio.Codecs
		}
		audioAttr = `,AUDIO="aud"`
	}
	if bw <= 0 {
		bw = 1_000_000
	}
	fmt.Fprintf(&b, "#EXT-X-STREAM-INF:BANDWIDTH=%d", bw)
	if v.Width > 0 && v.Height > 0 {
		fmt.Fprintf(&b, ",RESOLUTION=%dx%d", v.Width, v.Height)
	}
	if codecs != "" {
		fmt.Fprintf(&b, ",CODECS=\"%s\"", codecs)
	}
	if v.FPS > 0 {
		fmt.Fprintf(&b, ",FRAME-RATE=%d.000", v.FPS)
	}
	b.WriteString(audioAttr)
	fmt.Fprintf(&b, "\nv%d.m3u8\n", v.Itag)
	return []byte(b.String())
}

// pickVideoTrack returns the best track whose height ≤ maxHeight, or the
// smallest one when none fits (tracks: any order). nil when empty.
func pickVideoTrack(tracks []VideoTrack, maxHeight int) *VideoTrack {
	var best, smallest *VideoTrack
	for i := range tracks {
		t := &tracks[i]
		if smallest == nil || t.Height < smallest.Height {
			smallest = t
		}
		if t.Height <= maxHeight && (best == nil || t.Height > best.Height || (t.Height == best.Height && t.Bandwidth > best.Bandwidth)) {
			best = t
		}
	}
	if best == nil {
		return smallest
	}
	return best
}
