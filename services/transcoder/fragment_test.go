package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"testing"
	"testing/iotest"
	"time"
)

func box(typ string, payload int) []byte {
	b := make([]byte, 8+payload)
	binary.BigEndian.PutUint32(b, uint32(8+payload))
	copy(b[4:], typ)
	for i := 8; i < len(b); i++ {
		b[i] = byte(i)
	}
	return b
}

func cat(parts ...[]byte) []byte { return bytes.Join(parts, nil) }

// chunked feeds data in small pieces, then ends with err.
type chunked struct {
	data []byte
	step int
	err  error
}

func (c *chunked) Read(p []byte) (int, error) {
	if len(c.data) == 0 {
		return 0, c.err
	}
	n := min(len(p), c.step, len(c.data))
	copy(p, c.data[:n])
	c.data = c.data[n:]
	return n, nil
}

// readFrags collects every Read result, so tests see what a client would get
// before the stream ends.
func readFrags(t *testing.T, r io.Reader) ([]byte, error) {
	t.Helper()
	var out []byte
	buf := make([]byte, 7)
	for {
		n, err := r.Read(buf)
		out = append(out, buf[:n]...)
		if err != nil {
			return out, err
		}
	}
}

func TestFragReaderCutDropsHalfFragment(t *testing.T) {
	head := cat(box("ftyp", 12), box("moov", 40))
	frag1 := cat(box("moof", 20), box("mdat", 300))
	frag2 := cat(box("moof", 20), box("mdat", 300))
	partial := frag2[:len(frag2)-50] // ffmpeg killed mid-mdat
	src := &chunked{data: cat(head, frag1, partial), step: 13, err: io.EOF}
	got, err := readFrags(t, newFragReader(src, func() bool { return true }))
	if !errors.Is(err, io.EOF) {
		t.Fatalf("err %v", err)
	}
	if want := cat(head, frag1); !bytes.Equal(got, want) {
		t.Fatalf("got %d bytes, want %d (whole fragments only)", len(got), len(want))
	}
}

func TestFragReaderHoldsMoofUntilItsMdat(t *testing.T) {
	head := box("ftyp", 4)
	moof := box("moof", 20)
	pr, pw := io.Pipe()
	f := newFragReader(pr, func() bool { return true })
	go func() {
		_, _ = pw.Write(cat(head, moof))
		time.Sleep(50 * time.Millisecond)
		_ = pw.CloseWithError(context.Canceled)
	}()
	got, err := readFrags(t, f)
	if !errors.Is(err, context.Canceled) || !bytes.Equal(got, head) {
		t.Fatalf("got %q, %v: a lone moof must not go out", got, err)
	}
}

func TestFragReaderNormalEndKeepsEverything(t *testing.T) {
	data := cat(box("ftyp", 4), box("moof", 10), box("mdat", 100), []byte("tail"))
	got, err := readFrags(t, newFragReader(&chunked{data: data, step: 9, err: io.EOF}, func() bool { return false }))
	if !errors.Is(err, io.EOF) || !bytes.Equal(got, data) {
		t.Fatalf("got %d bytes (%v), want %d", len(got), err, len(data))
	}
}

func TestFragReaderPassesNonMP4Through(t *testing.T) {
	data := bytes.Repeat([]byte("x"), 1000)
	got, err := io.ReadAll(newFragReader(&chunked{data: data, step: 100, err: io.EOF}, func() bool { return true }))
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("got %d bytes, %v", len(got), err)
	}
	// Streams as it comes: the first read doesn't wait for the end.
	f := newFragReader(iotest.OneByteReader(bytes.NewReader(data)), func() bool { return true })
	if n, err := f.Read(make([]byte, 10)); n == 0 || err != nil {
		t.Fatalf("first read %d, %v", n, err)
	}
}

func TestFragReaderLargeSizeAndHugeBox(t *testing.T) {
	big := make([]byte, 16+100)
	binary.BigEndian.PutUint32(big, 1)
	copy(big[4:], "mdat")
	binary.BigEndian.PutUint64(big[8:], uint64(len(big)))
	data := cat(box("ftyp", 4), box("moof", 10), big)
	got, _ := readFrags(t, newFragReader(&chunked{data: data[:len(data)-1], step: 5, err: io.EOF}, func() bool { return true }))
	if want := box("ftyp", 4); !bytes.Equal(got, want) {
		t.Fatalf("64-bit box cut: got %d bytes, want %d", len(got), len(want))
	}
	// A box over the hold limit streams unaligned instead of piling up.
	f := newFragReader(&chunked{data: cat(box("ftyp", 4), box("mdat", 500)), step: 50, err: io.EOF}, func() bool { return true })
	f.max = 100
	got, _ = readFrags(t, f)
	if len(got) != 12+508 {
		t.Fatalf("huge box: got %d bytes", len(got))
	}
}
