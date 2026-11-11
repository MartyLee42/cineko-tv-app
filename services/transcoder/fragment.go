package main

import (
	"encoding/binary"
	"io"
)

// fragMaxHold: a single top-level box larger than this (or a stream that
// isn't MP4 boxes at all) is passed through as it comes, unaligned.
const fragMaxHold = 64 << 20

// fragReader passes fragmented MP4 through only in whole top-level boxes,
// holding a moof back until its mdat is complete. When the stream is cut
// (watchdog, max duration, client gone), the partial fragment at the end is
// dropped, so the player sees a clean early end — which it recovers from —
// instead of a half-written audio/video packet (MEDIA_ERR_DECODE). At a
// normal end (ffmpeg exited by itself) the remainder is passed through as is.
type fragReader struct {
	r    io.Reader
	cut  func() bool // the job was stopped early: drop an incomplete tail
	max  int
	buf  []byte // bytes not yet returned
	safe int    // buf[:safe] ends on a box boundary (not inside a moof+mdat pair)
	scan int    // offset in buf of the next box header to parse
	pass bool   // not MP4 boxes / a box too large: pass everything through
	err  error
	tmp  []byte
}

func newFragReader(r io.Reader, cut func() bool) *fragReader {
	return &fragReader{r: r, cut: cut, max: fragMaxHold, tmp: make([]byte, 64<<10)}
}

func (f *fragReader) Read(p []byte) (int, error) {
	for {
		ready := f.safe
		if f.pass {
			ready = len(f.buf)
		}
		if ready > 0 {
			n := copy(p, f.buf[:ready])
			f.buf = f.buf[n:]
			if len(f.buf) == 0 {
				f.buf = f.buf[:0:0]
			}
			f.safe = max(0, f.safe-n)
			f.scan = max(0, f.scan-n)
			return n, nil
		}
		if f.err != nil {
			if len(f.buf) > 0 && !f.cut() {
				f.pass = true // finished normally: the rest is whatever ffmpeg wrote
				continue
			}
			f.buf = nil
			return 0, f.err
		}
		n, err := f.r.Read(f.tmp)
		f.buf = append(f.buf, f.tmp[:n]...)
		if err != nil {
			f.err = err
		}
		if !f.pass {
			f.advance()
		}
	}
}

// advance parses the complete boxes buffered after scan.
func (f *fragReader) advance() {
	for {
		rest := f.buf[f.scan:]
		if len(rest) < 8 {
			break
		}
		size := uint64(binary.BigEndian.Uint32(rest))
		typ := rest[4:8]
		hdr := uint64(8)
		if size == 1 { // 64-bit size follows
			if len(rest) < 16 {
				break
			}
			size, hdr = binary.BigEndian.Uint64(rest[8:]), 16
		}
		if size < hdr || size > uint64(f.max) || !boxType(typ) {
			f.pass = true // size 0 ("to the end"), garbage or huge: don't align
			return
		}
		if uint64(len(rest)) < size {
			break
		}
		f.scan += int(size)
		if string(typ) != "moof" {
			f.safe = f.scan
		}
	}
	if len(f.buf)-f.safe > f.max {
		f.pass = true
	}
}

// boxType: four printable ASCII bytes (MP4 box types are, e.g. "ftyp", "moof").
func boxType(b []byte) bool {
	for _, c := range b {
		if c < 0x20 || c > 0x7e {
			return false
		}
	}
	return true
}
