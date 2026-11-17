package torrserver

import (
	"math"
	"testing"
)

func TestSanitizeDropsImpossibleSpeeds(t *testing.T) {
	for _, c := range []struct{ in, want float64 }{
		{0, 0},
		{12.5 * (1 << 20), 12.5 * (1 << 20)},
		{MaxPlausibleSpeed, MaxPlausibleSpeed},
		{17000 * (1 << 20), 0}, // «17000 МБ/с» after TorrServer reopened a torrent
		{-5, 0},
		{math.NaN(), 0},
	} {
		tr := Torrent{DownloadSpeed: c.in, UploadSpeed: c.in}
		tr.sanitize()
		if tr.DownloadSpeed != c.want || tr.UploadSpeed != c.want {
			t.Errorf("speed %v → %v / %v, want %v", c.in, tr.DownloadSpeed, tr.UploadSpeed, c.want)
		}
	}
}

func TestSanitizeFillsPreloadFromCache(t *testing.T) {
	// Working with the film's bytes on hand but no preload of its own: the cache counts.
	tr := Torrent{Stat: StatWorking, LoadedSize: 33_926_453}
	tr.sanitize()
	if tr.PreloadedBytes != 33_926_453 {
		t.Fatalf("preloaded = %d", tr.PreloadedBytes)
	}
	// TorrServer's own counter wins when it has one.
	tr = Torrent{Stat: StatPreload, PreloadedBytes: 7_880_704, LoadedSize: 15_286_272}
	tr.sanitize()
	if tr.PreloadedBytes != 7_880_704 {
		t.Fatalf("preloaded = %d", tr.PreloadedBytes)
	}
	// Only stored in the DB: nothing is loaded, whatever the old number says.
	tr = Torrent{Stat: StatInDB, LoadedSize: 1 << 20}
	tr.sanitize()
	if tr.PreloadedBytes != 0 {
		t.Fatalf("preloaded = %d", tr.PreloadedBytes)
	}
}
