package playback

import "testing"

func TestWarmOffset(t *testing.T) {
	size := int64(4 << 30)
	dur := 7200.0
	src := &source{FileSize: &size, MediaInfo: &MediaInfo{DurationSeconds: &dur}}
	for _, c := range []struct {
		at   float64
		want int64
	}{
		{0, 0},
		{-5, 0},
		{3600, 2<<30 - 4<<20}, // half-way, a 4 MiB margin before
		{1, 0},                // the margin reaches the start
		{9000, 0},             // past the end: from the start
	} {
		if got := warmOffset(src, c.at); got != c.want {
			t.Errorf("at %v: %d, want %d", c.at, got, c.want)
		}
	}
	if got := warmOffset(&source{FileSize: &size}, 3600); got != 0 {
		t.Errorf("unknown length: %d", got)
	}
}
