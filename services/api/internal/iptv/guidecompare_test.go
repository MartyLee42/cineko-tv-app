package iptv

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestGuideCoverage compares downloaded XMLTV guides against downloaded
// playlists (local files only). IPTV_GUIDE_DIR holds <cc>.m3u, channels.json
// and the guides; IPTV_GUIDES="a.xml.gz,b.xml.gz" (order = merge priority).
func TestGuideCoverage(t *testing.T) {
	dir := os.Getenv("IPTV_GUIDE_DIR")
	if dir == "" {
		t.Skip("set IPTV_GUIDE_DIR")
	}
	guides := strings.Split(os.Getenv("IPTV_GUIDES"), ",")
	type pl struct {
		cc    string
		cands []matchChannel
	}
	var pls []pl
	want := map[string]bool{}
	var entries = map[string][]Entry{}
	for _, cc := range strings.Split(os.Getenv("IPTV_COUNTRIES"), ",") {
		f, err := os.Open(filepath.Join(dir, cc+".m3u"))
		if err != nil {
			t.Fatal(err)
		}
		p, _ := ParseM3U(f)
		f.Close()
		entries[cc] = p.Entries
		for _, e := range p.Entries {
			if b := baseTvgID(e.TvgID); b != "" {
				want[b] = true
			}
		}
	}
	jf, _ := os.Open(filepath.Join(dir, "channels.json"))
	alt, err := decodeOrgChannels(jf, want, nil)
	jf.Close()
	if err != nil {
		t.Fatal(err)
	}
	for _, cc := range strings.Split(os.Getenv("IPTV_COUNTRIES"), ",") {
		var cs []matchChannel
		for _, e := range entries[cc] {
			cs = append(cs, matchChannel{TvgID: e.TvgID, Names: matchNames(e.Name, e.TvgID, alt[baseTvgID(e.TvgID)])})
		}
		pls = append(pls, pl{cc, cs})
	}
	now := time.Now()
	covered := map[string]map[int]bool{} // cc → channel idx covered by any earlier guide
	for _, p := range pls {
		covered[p.cc] = map[int]bool{}
	}
	for _, g := range guides {
		start := time.Now()
		f, err := os.Open(filepath.Join(dir, g))
		if err != nil {
			t.Fatal(err)
		}
		st, _ := f.Stat()
		idx := newEPGIndex()
		future := map[string]bool{}
		var minT, maxT time.Time
		xch, progs := 0, 0
		err = ParseXMLTV(f, func(c XChannel) error { xch++; idx.add(c.ID, c.Names); return nil }, func(p XProgramme) error {
			progs++
			if minT.IsZero() || p.Start.Before(minT) {
				minT = p.Start
			}
			if p.Start.After(maxT) {
				maxT = p.Start
			}
			if (p.Stop.IsZero() || p.Stop.After(now)) && p.Start.Before(now.Add(epgFuture)) {
				future[p.Channel] = true
			}
			return nil
		})
		f.Close()
		if err != nil {
			t.Fatalf("%s: %v", g, err)
		}
		t.Logf("%s: %.1f MB, %d channels, %d programmes, %s … %s, parsed in %s", g, float64(st.Size())/1e6, xch, progs,
			minT.Format("01-02 15:04"), maxT.Format("01-02 15:04"), time.Since(start).Round(time.Millisecond))
		for _, p := range pls {
			m, live, added := 0, 0, 0
			for i, c := range p.cands {
				if x := idx.match(c); x != "" {
					m++
					if future[x] {
						live++
						if !covered[p.cc][i] {
							covered[p.cc][i] = true
							added++
						}
					}
				}
			}
			t.Logf("   %-3s %4d channels: matched %4d, with programmes %4d (+%d new, merged total %d = %.0f%%)", p.cc, len(p.cands), m, live, added,
				len(covered[p.cc]), 100*float64(len(covered[p.cc]))/float64(len(p.cands)))
		}
	}
}
