package playback

import "testing"

func TestVideoScalable(t *testing.T) {
	size := func(w, h int) *MediaInfo { return &MediaInfo{Width: &w, Height: &h} }
	for _, tc := range []struct {
		info *MediaInfo
		want bool
	}{
		{size(1920, 1080), true},
		{size(1024, 428), true},
		{size(3840, 2160), false}, // 4K: too heavy to decode on the server
		{&MediaInfo{}, false},
		{nil, false},
	} {
		if got := VideoScalable(tc.info); got != tc.want {
			t.Errorf("VideoScalable(%+v) = %v, want %v", tc.info, got, tc.want)
		}
	}
	for h, want := range map[string]bool{"720": true, "480": true, "360": true, "1080": false, "0": false} {
		if _, ok := scaleHeights[h]; ok != want {
			t.Errorf("scaleHeights[%q] = %v", h, ok)
		}
	}
}
