package iptv

import (
	"bytes"
	"compress/gzip"
	"io"
	"strings"
	"testing"
	"time"

	"golang.org/x/text/encoding/charmap"
)

func stringsReader(s string) io.Reader { return strings.NewReader(s) }

func TestParseXMLTVTime(t *testing.T) {
	want := time.Date(2026, 10, 29, 5, 0, 0, 0, time.UTC)
	for _, s := range []string{"20261029080000 +0300", "20261029080000+0300", "20261029080000 +03:00", "20261029000000 -0500",
		"20261029050000", "20261029050000 Z", "202610290500 +0000"} {
		got, err := ParseXMLTVTime(s)
		if err != nil || !got.Equal(want) {
			t.Errorf("%q → %v %v", s, got, err)
		}
	}
	for _, s := range []string{"", "2026", "20261029080000 +3", "20261029080000 +2500"} {
		if _, err := ParseXMLTVTime(s); err == nil {
			t.Errorf("%q accepted", s)
		}
	}
}

const sampleXMLTV = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="test">
  <channel id="2x2.ru"><display-name lang="ru">2x2</display-name><display-name>Дважды два</display-name><icon src="https://x/2x2.png"/></channel>
  <channel id="5755"><display-name lang="RU">Матч! HD</display-name></channel>
  <programme start="20261029080000 +0300" stop="20261029090000 +0300" channel="2x2.ru">
    <title lang="en">Cartoons</title><title lang="ru">Мультфильмы</title>
    <desc lang="ru">Утренний блок &amp; новости</desc><category lang="ru">Детям</category>
  </programme>
  <programme start="20261029090000 +0300" channel="2x2.ru"><title>No stop</title></programme>
  <programme start="garbage" stop="20261029090000 +0300" channel="2x2.ru"><title>Bad time</title></programme>
  <programme start="20261029100000 +0300" stop="20261029110000 +0300" channel="5755"><title></title></programme>
</tv>`

func collect(t *testing.T, r io.Reader) ([]XChannel, []XProgramme) {
	t.Helper()
	var cs []XChannel
	var ps []XProgramme
	err := ParseXMLTV(r, func(c XChannel) error { cs = append(cs, c); return nil },
		func(p XProgramme) error { ps = append(ps, p); return nil })
	if err != nil {
		t.Fatal(err)
	}
	return cs, ps
}

func TestParseXMLTV(t *testing.T) {
	cs, ps := collect(t, strings.NewReader(sampleXMLTV))
	if len(cs) != 2 || cs[0].ID != "2x2.ru" || len(cs[0].Names) != 2 || cs[0].Icon != "https://x/2x2.png" {
		t.Fatalf("channels %+v", cs)
	}
	if len(ps) != 2 {
		t.Fatalf("programmes %+v", ps)
	}
	p := ps[0]
	if p.Title != "Мультфильмы" || p.Description != "Утренний блок & новости" || p.Category != "Детям" ||
		!p.Start.Equal(time.Date(2026, 10, 29, 5, 0, 0, 0, time.UTC)) || !p.Stop.Equal(time.Date(2026, 10, 29, 6, 0, 0, 0, time.UTC)) {
		t.Fatalf("programme %+v", p)
	}
	if !ps[1].Stop.IsZero() || ps[1].Title != "No stop" {
		t.Fatalf("no-stop programme %+v", ps[1])
	}
}

func TestParseXMLTVGzipAndCharset(t *testing.T) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write([]byte(sampleXMLTV))
	_ = zw.Close()
	cs, ps := collect(t, &buf)
	if len(cs) != 2 || len(ps) != 2 {
		t.Fatalf("gzip: %d channels %d programmes", len(cs), len(ps))
	}

	cp, _ := charmap.Windows1251.NewEncoder().String(strings.Replace(sampleXMLTV, `encoding="UTF-8"`, `encoding="windows-1251"`, 1))
	cs, ps = collect(t, strings.NewReader(cp))
	if cs[0].Names[1] != "Дважды два" || ps[0].Title != "Мультфильмы" {
		t.Fatalf("cp1251: %+v %+v", cs[0], ps[0])
	}
}

func TestParseXMLTVStops(t *testing.T) {
	n := 0
	err := ParseXMLTV(strings.NewReader(sampleXMLTV), nil, func(XProgramme) error { n++; return errStop })
	if err != nil || n != 1 {
		t.Fatalf("stop: n=%d err=%v", n, err)
	}
	if err := ParseXMLTV(strings.NewReader("<tv><programme"), nil, nil); err == nil {
		t.Fatal("truncated document accepted")
	}
}
