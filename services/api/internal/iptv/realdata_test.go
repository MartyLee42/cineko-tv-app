package iptv

import (
	"context"
	"io"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"martytv/api/internal/livecheck"
)

// TestRealData is a manual check against the public iptv-org Russia
// playlist and its default guide (read-only GETs). Run with
//
//	IPTV_REAL_CHECK=1 go test -run TestRealData -v ./internal/iptv/
//
// (optionally IPTV_REAL_PROXY=socks5h://host:port).
func TestRealData(t *testing.T) {
	if os.Getenv("IPTV_REAL_CHECK") == "" {
		t.Skip("set IPTV_REAL_CHECK=1")
	}
	var proxy *url.URL
	if p := os.Getenv("IPTV_REAL_PROXY"); p != "" {
		proxy, _ = url.Parse(p)
	}
	viaProxy := proxy != nil
	f := newFetcher(proxy, false, 10*time.Minute)
	ctx := context.Background()

	start := time.Now()
	body, via, err := f.open(ctx, "https://iptv-org.github.io/iptv/countries/ru.m3u", viaProxy, nil)
	if err != nil {
		t.Fatal(err)
	}
	pl, err := ParseM3U(body)
	body.Close()
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	var uniq []Entry
	for _, e := range pl.Entries {
		if k := dedupeKey(e); !keys[k] {
			keys[k] = true
			uniq = append(uniq, e)
		}
	}
	t.Logf("playlist: %d entries, %d unique channels, %d skipped, via %s, %s", len(pl.Entries), len(uniq), pl.Skipped, via, time.Since(start).Round(time.Millisecond))

	want := map[string]bool{}
	for _, e := range uniq {
		if b := baseTvgID(e.TvgID); b != "" {
			want[b] = true
		}
	}
	start = time.Now()
	body, _, err = f.open(ctx, "https://iptv-org.github.io/api/channels.json", viaProxy, nil)
	if err != nil {
		t.Fatal(err)
	}
	alt, err := decodeOrgChannels(body, want, nil)
	body.Close()
	if err != nil {
		t.Fatal(err)
	}
	withAlt := 0
	for _, v := range alt {
		if len(v) > 1 {
			withAlt++
		}
	}
	t.Logf("channels.json: %d/%d ids with alt names, %s", withAlt, len(want), time.Since(start).Round(time.Millisecond))

	epgURL := "https://epg.pw/xmltv/epg_RU.xml.gz"
	start = time.Now()
	body, _, err = f.open(ctx, epgURL, viaProxy, nil)
	if err != nil {
		t.Fatal(err)
	}
	idx := newEPGIndex()
	var cands []matchChannel
	for _, e := range uniq {
		cands = append(cands, matchChannel{TvgID: e.TvgID, Names: matchNames(e.Name, e.TvgID, alt[baseTvgID(e.TvgID)])})
	}
	var matched map[int]string
	wanted := map[string]bool{}
	xch, progs := 0, 0
	withProg := map[string]bool{}
	now := time.Now()
	from, to := now.Add(-epgPast), now.Add(epgFuture)
	err = ParseXMLTV(body, func(c XChannel) error { xch++; idx.add(c.ID, c.Names); return nil }, func(p XProgramme) error {
		if matched == nil {
			matched = map[int]string{}
			for i, c := range cands {
				if x := idx.match(c); x != "" {
					matched[i] = x
					wanted[x] = true
				}
			}
		}
		if wanted[p.Channel] && p.Start.Before(to) && (p.Stop.IsZero() || p.Stop.After(from)) {
			progs++
			if p.Stop.IsZero() || p.Stop.After(now) {
				withProg[p.Channel] = true
			}
		}
		return nil
	})
	body.Close()
	if err != nil {
		t.Fatal(err)
	}
	covered := 0
	for _, x := range matched {
		if withProg[x] {
			covered++
		}
	}
	t.Logf("EPG %s: %d XMLTV channels; matched %d/%d channels, %d with programmes now/later (%.0f%%), %d programmes kept (−1…+2 d), %s",
		epgURL, xch, len(matched), len(uniq), covered, 100*float64(covered)/float64(len(uniq)), progs, time.Since(start).Round(time.Millisecond))
	var sample []string
	xnames := map[string]string{}
	for k, v := range idx.byName {
		xnames[v] = k
	}
	for i, x := range matched {
		if len(sample) < 40 {
			sample = append(sample, uniq[i].Name+"→"+xnames[x])
		}
	}
	t.Logf("sample matches: %s", strings.Join(sample, ", "))

	// Sample 10 channels spread over the list and probe their stream.
	s := &Service{short: newFetcher(nil, false, 15*time.Second)}
	ok := 0
	step := len(uniq) / 10
	for i := 0; i < 10; i++ {
		e := uniq[i*step]
		h := map[string]string{}
		if e.UserAgent != "" {
			h["User-Agent"] = e.UserAgent
		}
		if e.Referrer != "" {
			h["Referer"] = e.Referrer
		}
		res := livecheck.Check(ctx, s.short.direct, e.URL, h)
		state := "ok " + res.Format + " " + res.Video + "/" + res.Audio
		if res.Health != livecheck.HealthOK {
			state = res.Health + " " + res.Cause
		} else {
			ok++
		}
		t.Logf("  %-32s %s", e.Name, state)
	}
	t.Logf("streams: %d/10 sampled channels reachable (HLS master / TS head)", ok)
	_ = io.Discard
}
