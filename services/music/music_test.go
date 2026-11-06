package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"golang.org/x/text/encoding/charmap"
)

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"Звезда по имени Солнце":    "звезда по имени солнце",
		"  Ёлка — Прованс (Remix) ": "елка прованс remix",
		"AC/DC - Back In Black":     "ac dc back in black",
		"Beyoncé":                   "beyoncé",
	}
	for in, want := range cases {
		if got := normalize(in); got != want {
			t.Errorf("normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseFileTitle(t *testing.T) {
	cases := []struct {
		name, artist string
		num          int
		title        string
	}{
		{"03 - Кино - Звезда по имени Солнце.flac", "Кино", 3, "Звезда по имени Солнце"},
		{"01. Hello.mp3", "", 1, "Hello"},
		{"1-07 Track_Name.flac", "", 7, "Track Name"},
		{"12 Song.m4a", "", 12, "Song"},
		{"Intro.flac", "", 0, "Intro"},
	}
	for _, c := range cases {
		n, title := parseFileTitle(c.name, c.artist)
		if n != c.num || title != c.title {
			t.Errorf("parseFileTitle(%q) = %d %q, want %d %q", c.name, n, title, c.num, c.title)
		}
	}
}

func TestReleaseArtistAlbum(t *testing.T) {
	a, al := releaseArtistAlbum("(Rock) [CD] Кино - Группа крови - 1988, FLAC (tracks+.cue), lossless")
	if a != "Кино" || al != "Группа крови" {
		t.Errorf("got %q %q", a, al)
	}
	a, al = releaseArtistAlbum("Daft Punk - Random Access Memories (2013) [FLAC]")
	if a != "Daft Punk" || al != "Random Access Memories" {
		t.Errorf("got %q %q", a, al)
	}
}

func TestDetectFormat(t *testing.T) {
	cases := map[string]string{
		"Кино - Группа крови - 1988, FLAC (tracks+.cue), lossless": "FLAC",
		"Artist - Album (2020) [24bit Hi-Res] FLAC":                "FLAC 24bit",
		"Artist - Album, MP3, 320 kbps":                            "MP3 320",
		"Artist - Album, APE (image+.cue)":                         "APE",
	}
	for in, want := range cases {
		if got, _ := detectFormat(in); got != want {
			t.Errorf("detectFormat(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseCueCP1251(t *testing.T) {
	cue := "PERFORMER \"Кино\"\r\nTITLE \"Группа крови\"\r\nFILE \"Кино - Группа крови.flac\" WAVE\r\n" +
		"  TRACK 01 AUDIO\r\n    TITLE \"Группа крови\"\r\n    INDEX 01 00:00:00\r\n" +
		"  TRACK 02 AUDIO\r\n    TITLE \"Закрой за мной дверь\"\r\n    INDEX 00 04:44:50\r\n    INDEX 01 04:45:00\r\n" +
		"  TRACK 03 AUDIO\r\n    TITLE \"Война\"\r\n    INDEX 01 08:59:37\r\n"
	raw, err := charmap.Windows1251.NewEncoder().Bytes([]byte(cue))
	if err != nil {
		t.Fatal(err)
	}
	file, tracks := parseCue(raw)
	if file != "Кино - Группа крови.flac" {
		t.Fatalf("file = %q", file)
	}
	if len(tracks) != 3 {
		t.Fatalf("tracks = %d", len(tracks))
	}
	if tracks[1].Title != "Закрой за мной дверь" || tracks[1].Start != 285000 || tracks[0].End != 285000 {
		t.Errorf("track 2 = %+v, track 1 = %+v", tracks[1], tracks[0])
	}
	if tracks[2].Start != 8*60000+59000+37*1000/75 || tracks[2].End != 0 {
		t.Errorf("track 3 = %+v", tracks[2])
	}
}

func TestParseRange(t *testing.T) {
	cases := []struct {
		h           string
		from, to    int64
		partial, ok bool
	}{
		{"", 0, 999, false, true},
		{"bytes=0-", 0, 999, true, true},
		{"bytes=100-199", 100, 199, true, true},
		{"bytes=900-5000", 900, 999, true, true},
		{"bytes=-100", 900, 999, true, true},
		{"bytes=1000-", 0, 0, true, false},
	}
	for _, c := range cases {
		f, to, p, ok := parseRange(c.h, 1000)
		if f != c.from || to != c.to || p != c.partial || ok != c.ok {
			t.Errorf("parseRange(%q) = %d %d %v %v", c.h, f, to, p, ok)
		}
	}
}

func TestScoreCandidatePrefersStudioTopic(t *testing.T) {
	tr := &Track{Title: "Группа крови", Artist: "Кино", Album: "Группа крови", Duration: 285}
	studio := ytItem{Title: "Группа крови", Author: "Кино - Topic", LengthSeconds: 286, ViewCount: 2_000_000}
	clip := ytItem{Title: "Кино - Группа крови (Official Video)", Author: "Группа КИНО", LengthSeconds: 300, ViewCount: 40_000_000}
	live := ytItem{Title: "Кино - Группа крови (live 1988)", Author: "Archive", LengthSeconds: 290, ViewCount: 900_000}
	cover := ytItem{Title: "Группа крови - кавер на гитаре", Author: "Guitar Guy", LengthSeconds: 280, ViewCount: 100_000}
	s := scoreCandidate(tr, studio)
	for _, other := range []ytItem{clip, live, cover} {
		if o := scoreCandidate(tr, other); o >= s {
			t.Errorf("%q scored %.1f ≥ studio %.1f", other.Title, o, s)
		}
	}
}

func TestMatchAlbum(t *testing.T) {
	album := &Album{Title: "Группа крови", Tracks: []Track{
		{ID: "dz:1", Title: "Группа крови", Position: 1},
		{ID: "dz:2", Title: "Закрой за мной дверь", Position: 2},
		{ID: "dz:3", Title: "Война", Position: 3},
	}}
	files := []TorrentTrack{
		{Track: Track{ID: "t:a:1", Title: "Война", Src: &TorrentSrc{File: 1}}, Dir: "Кино/1988 - Группа крови", Number: 3},
		{Track: Track{ID: "t:a:2", Title: "Группа крови", Src: &TorrentSrc{File: 2}}, Dir: "Кино/1988 - Группа крови", Number: 1},
		{Track: Track{ID: "t:a:3", Title: "Zakroy", Src: &TorrentSrc{File: 3}}, Dir: "Кино/1988 - Группа крови", Number: 2},
		{Track: Track{ID: "t:a:4", Title: "Кукушка", Src: &TorrentSrc{File: 4}}, Dir: "Кино/1990 - Черный альбом", Number: 1},
	}
	m := MatchAlbum(album, files)
	if m[0] == nil || m[0].ID != "t:a:2" || m[2] == nil || m[2].ID != "t:a:1" || m[1] == nil || m[1].ID != "t:a:3" {
		t.Fatalf("matched = %+v %+v %+v", m[0], m[1], m[2])
	}
	if m[0].Title != "Группа крови" || m[0].Src == nil {
		t.Errorf("metadata not merged: %+v", m[0])
	}
}

func TestStoreLibrary(t *testing.T) {
	st, err := openStore(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	tr, _ := json.Marshal(Track{ID: "dz:1", Title: "A", Cover: "c1"})
	if err := st.Like(ctx, "u1", "dz:1", tr); err != nil {
		t.Fatal(err)
	}
	ids, _ := st.LikedIDs(ctx, "u1")
	if len(ids) != 1 {
		t.Fatalf("likes = %v", ids)
	}
	if ids, _ := st.LikedIDs(ctx, "u2"); len(ids) != 0 {
		t.Fatal("likes leak between accounts")
	}
	id, err := st.CreatePlaylist(ctx, "u1", "Mix", "")
	if err != nil {
		t.Fatal(err)
	}
	tr2, _ := json.Marshal(Track{ID: "dz:2", Title: "B", Cover: "c2"})
	if err := st.AddToPlaylist(ctx, "u1", id, []trackRow{{"dz:1", tr}, {"dz:2", tr2}}); err != nil {
		t.Fatal(err)
	}
	if err := st.AddToPlaylist(ctx, "u2", id, []trackRow{{"dz:1", tr}}); err != errNotFound {
		t.Fatalf("other account could add: %v", err)
	}
	p, entries, err := st.Playlist(ctx, "u1", id)
	if err != nil || p.Count != 2 {
		t.Fatalf("playlist %v %v", p, err)
	}
	if err := st.ReorderPlaylist(ctx, "u1", id, []int64{entries[1].EntryID, entries[0].EntryID}); err != nil {
		t.Fatal(err)
	}
	_, entries, _ = st.Playlist(ctx, "u1", id)
	var first Track
	_ = json.Unmarshal(entries[0].Track, &first)
	if first.ID != "dz:2" {
		t.Errorf("reorder: first = %s", first.ID)
	}
	pls, _ := st.Playlists(ctx, "u1")
	if len(pls) != 1 || len(pls[0].Covers) != 2 {
		t.Errorf("playlists = %+v", pls)
	}
	// history: consecutive repeats collapse
	for _, x := range []string{"dz:1", "dz:1", "dz:2"} {
		b, _ := json.Marshal(Track{ID: x, Title: x})
		_ = st.AddHistory(ctx, "u1", x, b)
	}
	raw, _ := st.HistoryRaw(ctx, "u1", 10)
	if len(raw) != 2 {
		t.Errorf("history raw = %d", len(raw))
	}
	// manual match wins over automatic
	_ = st.SetMatch(ctx, "dz:1", "manualVid01", true)
	_ = st.SetMatch(ctx, "dz:1", "autoVideo01", false)
	if v, _ := st.Match(ctx, "dz:1"); v != "manualVid01" {
		t.Errorf("match = %s", v)
	}
}

func TestValidTrackID(t *testing.T) {
	ok := []string{"dz:123", "t:0123456789abcdef0123456789abcdef01234567:3", "t:0123456789abcdef0123456789abcdef01234567:3:285000", "yt:dQw4w9WgXcQ", "zv:7029188"}
	bad := []string{"", "dz:", "dz:abc", "t:zz:1", "x:1", "yt:short", "zv:abc"}
	for _, s := range ok {
		if !validTrackID(s) {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range bad {
		if validTrackID(s) {
			t.Errorf("%q should be invalid", s)
		}
	}
}

func TestScoreImport(t *testing.T) {
	it := ImportItem{Title: "No More Tears - 2021 Remaster", Artists: []string{"Ozzy Osbourne"}, Duration: 442}
	good := Track{Title: "No More Tears", Artist: "Ozzy Osbourne", Duration: 443}
	wrong := Track{Title: "No More Tears", Artist: "Someone Else", Duration: 200}
	if s := scoreImport(it, good); s < 70 {
		t.Errorf("good = %.0f", s)
	}
	if s := scoreImport(it, wrong); s >= 70 {
		t.Errorf("wrong = %.0f", s)
	}
	if id := yqID("Ozzy Osbourne", "No More Tears"); !validTrackID(id) || id != yqID("ozzy  osbourne", "No more tears!") {
		t.Errorf("yq id %q unstable", id)
	}
}

func TestPickTorrentTrack(t *testing.T) {
	tr := &Track{Title: "Группа крови", Album: "Группа крови", Position: 1}
	files := []TorrentTrack{
		{Track: Track{Title: "Группа крови", Src: &TorrentSrc{File: 9}}, Dir: "Кино/1990 - Последний герой"},
		{Track: Track{Title: "Группа крови", Src: &TorrentSrc{File: 2, Lossless: true}}, Dir: "Кино/1988 - Группа крови", Number: 1},
		{Track: Track{Title: "Война", Src: &TorrentSrc{File: 3}}, Dir: "Кино/1988 - Группа крови", Number: 3},
	}
	got := pickTorrentTrack(tr, files)
	if got == nil || got.Src.File != 2 {
		t.Fatalf("picked %+v", got)
	}
	if pickTorrentTrack(&Track{Title: "Нет такой"}, files) != nil {
		t.Error("matched a missing title")
	}
}

func TestHasCyrillic(t *testing.T) {
	if !hasCyrillic("Кино") || hasCyrillic("Nirvana") || !hasCyrillic("Noize MC — Вселенная") {
		t.Error("hasCyrillic")
	}
}

func TestAICache(t *testing.T) {
	st, err := openStore(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	k := aiKey("u1", "Вечер под дождём!")
	if _, _, ok := st.AICached(ctx, k); ok {
		t.Fatal("empty cache hit")
	}
	st.SetAICache(ctx, k, []byte(`{"title":"x"}`))
	if _, _, ok := st.AICached(ctx, aiKey("u1", "вечер под дождём")); !ok {
		t.Error("same prompt (case/punctuation) should hit")
	}
	if _, _, ok := st.AICached(ctx, aiKey("u2", "вечер под дождём")); ok {
		t.Error("cache leaks between accounts")
	}
	_, _ = st.db.Exec(`UPDATE ai_cache SET created_at=created_at-4*86400`)
	if _, _, ok := st.AICached(ctx, k); ok {
		t.Error("older than 3 days should miss")
	}
}

func TestParseMMSS(t *testing.T) {
	if parseMMSS("04:21") != 261 || parseMMSS("1:02:03") != 3723 {
		t.Error("parseMMSS")
	}
}

// The router panics at startup on conflicting patterns: build it in tests.
func TestRoutesBuild(t *testing.T) {
	st, err := openStore(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	a := newApp(config{DataDir: t.TempDir()}, st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if a.routes() == nil {
		t.Fatal("no handler")
	}
}
