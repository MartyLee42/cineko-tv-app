package iptv

import (
	"strings"
	"testing"
)

func TestParseM3UAttributes(t *testing.T) {
	src := "\ufeff#EXTM3U x-tvg-url=\"https://epg.example/a.xml.gz,https://epg.example/b.xml\" catchup=\"shift\"\r\n" +
		"#EXTINF:-1 tvg-id=\"2x2.ru@SD\" tvg-name=\"2x2\" tvg-logo=\"https://i.imgur.com/fhQFLEl.png\" group-title=\"Entertainment\" catchup-days=\"3\",2x2 (576i)\r\n" +
		"https://bl.rutube.ru/livestream/392b/index.m3u8?e=1&s=x\r\n" +
		"#EXTINF:-1 tvg-id=\"6TV.ru@SD\" group-title=\"General;Religious\",6 TV Gorlovka (720p) [Geo-blocked]\n" +
		"#EXTVLCOPT:http-user-agent=Mozilla/5.0 (Smart TV)\n" +
		"#EXTVLCOPT:http-referrer=https://ref.example/\n" +
		"http://91.214.48.158:4022/live/index.m3u8\n" +
		"#EXTINF:0 tvg-name=\"Канал, с запятой\" tvg-logo=javascript:alert(1),Канал, с запятой\n" +
		"#EXTGRP:Новости\n" +
		"http://cdn.example/news.ts|User-Agent=Kodi%2F21&Referer=https://kodi.example/\n"
	pl, err := ParseM3U(strings.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	if len(pl.EPGURLs) != 2 || pl.EPGURLs[0] != "https://epg.example/a.xml.gz" {
		t.Fatalf("epg urls %v", pl.EPGURLs)
	}
	if len(pl.Entries) != 3 || pl.Skipped != 0 {
		t.Fatalf("entries %d skipped %d", len(pl.Entries), pl.Skipped)
	}
	a := pl.Entries[0]
	if a.TvgID != "2x2.ru@SD" || a.TvgName != "2x2" || a.Name != "2x2" || a.Group != "Entertainment" ||
		a.Logo != "https://i.imgur.com/fhQFLEl.png" || a.URL != "https://bl.rutube.ru/livestream/392b/index.m3u8?e=1&s=x" {
		t.Fatalf("entry 0 %+v", a)
	}
	b := pl.Entries[1]
	if b.Name != "6 TV Gorlovka" || b.UserAgent != "Mozilla/5.0 (Smart TV)" || b.Referrer != "https://ref.example/" || b.Group != "General;Religious" {
		t.Fatalf("entry 1 %+v", b)
	}
	c := pl.Entries[2]
	if c.Name != "Канал, с запятой" || c.TvgName != "Канал, с запятой" || c.Group != "Новости" || c.Logo != "" ||
		c.URL != "http://cdn.example/news.ts" || c.UserAgent != "Kodi/21" || c.Referrer != "https://kodi.example/" {
		t.Fatalf("entry 2 %+v", c)
	}
	// EXTVLCOPT applies to one entry only.
	if c.UserAgent == b.UserAgent {
		t.Fatal("user agent leaked to the next entry")
	}
}

func TestParseM3UBrokenLines(t *testing.T) {
	src := strings.Join([]string{
		"#EXTINF:-1,No URL follows", // dropped: the next line is another EXTINF
		"#EXTINF:-1 tvg-id=\"ok.ru\",OK",
		"",
		"# a comment",
		"#KODIPROP:inputstream=adaptive",
		"http://ok.example/ok.m3u8",
		"http://orphan.example/x.m3u8", // URL without EXTINF
		"#EXTINF:-1,UDP",
		"udp://@239.0.0.1:1234", // not http
		"#EXTINF:-1 tvg-id=\"q\" group-title=\"unterminated,Broken quote",
		"http://q.example/q.m3u8",
		"#EXTINF:-1,Trailing without url",
	}, "\n")
	pl, err := ParseM3U(strings.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	if len(pl.Entries) != 2 {
		t.Fatalf("entries %+v", pl.Entries)
	}
	if pl.Entries[0].Name != "OK" || pl.Entries[0].URL != "http://ok.example/ok.m3u8" {
		t.Fatalf("ok entry %+v", pl.Entries[0])
	}
	if pl.Entries[1].TvgID != "q" || pl.Entries[1].URL != "http://q.example/q.m3u8" || pl.Entries[1].Name == "" {
		t.Fatalf("broken quote entry %+v", pl.Entries[1])
	}
	if pl.Skipped != 4 {
		t.Fatalf("skipped %d", pl.Skipped)
	}
}

func TestParseM3UNameFallbacks(t *testing.T) {
	pl, _ := ParseM3U(strings.NewReader("#EXTM3U\n#EXTINF:-1 tvg-id=\"x.ru\" tvg-name=\"Икс\"\nhttp://a.example/x.m3u8\n#EXTINF:-1\nhttp://b.example/y.m3u8\n"))
	if len(pl.Entries) != 2 || pl.Entries[0].Name != "Икс" || pl.Entries[1].Name != "b.example" {
		t.Fatalf("%+v", pl.Entries)
	}
}

func TestDedupeKey(t *testing.T) {
	if k := dedupeKey(Entry{TvgID: "NTV.ru@HD", Name: "x", URL: "u"}); k != "id:ntv.ru@hd" {
		t.Fatal(k)
	}
	a := dedupeKey(Entry{Name: "Матч! HD", URL: "http://a/1.m3u8"})
	b := dedupeKey(Entry{Name: "МАТЧ!", URL: "http://a/1.m3u8"})
	c := dedupeKey(Entry{Name: "Матч!", URL: "http://a/2.m3u8"})
	if a != b || a == c {
		t.Fatalf("%s %s %s", a, b, c)
	}
}
