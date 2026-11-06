package iptv

import "testing"

func TestNormalizeName(t *testing.T) {
	cases := map[string]string{
		"Матч! HD":            "матч",
		"МАТЧ!":               "матч",
		"Первый канал (+2)":   "первыйканал",
		"Ёлки FHD":            "елки",
		"360° News (1080p)":   "360news",
		"Channel+ [Not 24/7]": "channelplus",
		"НТВ":                 "нтв",
	}
	for in, want := range cases {
		if got := NormalizeName(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

func TestGroupID(t *testing.T) {
	cases := map[string]string{
		"News": "news", "Новости": "news", "Movies;Series": "movies", "Undefined": "other", "": "other",
		"Спорт": "sports", "Детские": "kids", "Познавательные": "documentary", "Мои каналы!": "g:мои-каналы",
	}
	for in, want := range cases {
		if got := GroupID(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
	if groupName("Movies;Series") != "Movies" || groupName("Undefined") != "Other" {
		t.Fatal("groupName")
	}
}

func TestEPGMatching(t *testing.T) {
	x := newEPGIndex()
	x.add("2x2.ru", []string{"2x2", "Дважды два"})
	x.add("5755", []string{"Матч! HD"})
	x.add("100", []string{"Россия 1"})
	x.add("101", []string{"Россия-1"}) // same normalized name → ambiguous
	x.add("NTV.ru@SD", []string{"NTV"})

	cases := []struct {
		c    matchChannel
		want string
	}{
		{matchChannel{TvgID: "2X2.RU"}, "2x2.ru"},                                        // exact, case-insensitive
		{matchChannel{TvgID: "2x2.ru@HD"}, "2x2.ru"},                                     // feed suffix dropped
		{matchChannel{TvgID: "ntv.ru@HD"}, "NTV.ru@SD"},                                  // base id match
		{matchChannel{TvgID: "Match.ru", Names: []string{"Match! TV", "Матч!"}}, "5755"}, // alt name
		{matchChannel{Names: []string{"Россия 1"}}, ""},                                  // ambiguous
		{matchChannel{Names: []string{"Unknown"}}, ""},
	}
	for _, c := range cases {
		if got := x.match(c.c); got != c.want {
			t.Errorf("%+v → %q, want %q", c.c, got, c.want)
		}
	}
}

func TestDecodeOrgChannels(t *testing.T) {
	src := `[{"id":"2x2.ru","name":"2x2","alt_names":["Дважды два"],"country":"RU"},
	{"id":"Other.us","name":"Other","alt_names":[]},{"id":"NTV.ru","name":"NTV","alt_names":["НТВ"]}]`
	m, err := decodeOrgChannels(stringsReader(src), map[string]bool{"2x2.ru": true, "ntv.ru": true, "gone.ru": true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(m["2x2.ru"]) != 2 || m["ntv.ru"][1] != "НТВ" || m["gone.ru"] == nil || len(m["gone.ru"]) != 0 {
		t.Fatalf("%v", m)
	}
	if _, ok := m["other.us"]; ok {
		t.Fatal("unwanted id kept")
	}
}

func TestMatchNames(t *testing.T) {
	got := matchNames("NTV (Russia)", "NTV.ru@SD", []string{"NTV", "НТВ"})
	if got[0] != "НТВ" || len(got) != 3 {
		t.Fatalf("%v", got)
	}
	got = matchNames("NTV (Russia) +2", "NTV.ru@Plus2", []string{"NTV", "НТВ"})
	if got[0] != "НТВ +2" || got[2] != "NTV +2" {
		t.Fatalf("%v", got)
	}
	x := newEPGIndex()
	x.add("de", []string{"n-tv HD"})
	x.add("ru", []string{"НТВ"})
	x.add("ru2", []string{"НТВ +2"})
	if m := x.match(matchChannel{Names: matchNames("NTV (Russia)", "", []string{"NTV", "НТВ"})}); m != "ru" {
		t.Fatalf("NTV → %s", m)
	}
	if m := x.match(matchChannel{Names: matchNames("NTV (Russia) +2", "NTV.ru@Plus2", []string{"NTV", "НТВ"})}); m != "ru2" {
		t.Fatalf("NTV +2 → %s", m)
	}
	if m := x.match(matchChannel{Names: matchNames("NTV (Russia) +4", "NTV.ru@Plus4", []string{"NTV", "НТВ"})}); m != "" {
		t.Fatalf("NTV +4 → %s", m)
	}
}
