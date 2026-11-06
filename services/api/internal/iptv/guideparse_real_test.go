package iptv

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestParseGuideReal runs the production parse path (filtered decoding)
// over downloaded guides: IPTV_GUIDE_DIR, IPTV_COUNTRIES, IPTV_GUIDES as in
// TestGuideCoverage. Reports time and peak heap.
func TestParseGuideReal(t *testing.T) {
	dir := os.Getenv("IPTV_GUIDE_DIR")
	if dir == "" {
		t.Skip("set IPTV_GUIDE_DIR")
	}
	var cands []candidate
	want := map[string]bool{}
	var entries []Entry
	for _, cc := range strings.Split(os.Getenv("IPTV_COUNTRIES"), ",") {
		f, _ := os.Open(filepath.Join(dir, cc+".m3u"))
		p, _ := ParseM3U(f)
		f.Close()
		entries = append(entries, p.Entries...)
	}
	for _, e := range entries {
		want[baseTvgID(e.TvgID)] = true
	}
	jf, _ := os.Open(filepath.Join(dir, "channels.json"))
	alt, _ := decodeOrgChannels(jf, want, nil)
	jf.Close()
	for i, e := range entries {
		cands = append(cands, candidate{ID: string(rune(i)), mc: matchChannel{TvgID: e.TvgID, Names: matchNames(e.Name, e.TvgID, alt[baseTvgID(e.TvgID)])}})
	}
	s := &Service{now: time.Now}
	for _, g := range strings.Split(os.Getenv("IPTV_GUIDES"), ",") {
		runtime.GC()
		var peak uint64
		stop := make(chan struct{})
		go func() {
			var m runtime.MemStats
			for {
				select {
				case <-stop:
					return
				case <-time.After(50 * time.Millisecond):
					runtime.ReadMemStats(&m)
					if m.HeapInuse > peak {
						peak = m.HeapInuse
					}
				}
			}
		}()
		start := time.Now()
		res, err := s.parseGuide(context.Background(), filepath.Join(dir, g), "x", cands)
		close(stop)
		if err != nil {
			t.Fatalf("%s: %v", g, err)
		}
		t.Logf("%s: %s, %d xmltv channels, %d matched with programmes, %d programmes kept, peak heap %d MB",
			g, time.Since(start).Round(time.Millisecond), res.xmlChannels, len(res.matches), len(res.progs), peak>>20)
	}
}
