package imports

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestParseCSVFixture(t *testing.T) {
	f, err := os.Open("testdata/kinopoisk_sample.csv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rows, err := ParseCSV(f)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 10 {
		t.Fatalf("rows %d", len(rows))
	}
	// BOM stripped: the first column is found by name.
	a := rows[0]
	if a.KPID != 1001 || a.TitleRU != "Альфа" || a.TitleOriginal != "Alpha" || a.Year != 1999 || a.MyRating != 9 ||
		a.KPRating == nil || *a.KPRating != 8.123 || a.KPVotes == nil || *a.KPVotes != 1500 || a.Invalid != "" || a.Line != 2 {
		t.Fatalf("row 0 %+v", a)
	}
	// Moscow time → UTC.
	if want := time.Date(2026, 1, 2, 18, 30, 0, 0, time.UTC); a.RatedAt == nil || !a.RatedAt.Equal(want) {
		t.Fatalf("rated_at %v", a.RatedAt)
	}
	// Quoted fields with commas.
	if b := rows[1]; b.TitleRU != "Браво, Чарли" || b.TitleOriginal != "Bravo, Charlie" || b.Year != 2005 {
		t.Fatalf("row 1 %+v", b)
	}
	// Empty original title: the Russian one is the title.
	if d := rows[2]; d.TitleOriginal != "" || d.Title() != "Дельта" || d.Invalid != "" {
		t.Fatalf("row 2 %+v", d)
	}
	// Series year ranges use the first year.
	if e := rows[3]; e.Year != 2013 || e.Kinds()[0] != "series" {
		t.Fatalf("row 3 %+v", e)
	}
	if i := rows[8]; i.Year != 2024 {
		t.Fatalf("row 8 %+v", i)
	}
	// Missing KP rating/votes are nil, not zero.
	if fx := rows[4]; fx.KPRating != nil || fx.KPVotes != nil || len(fx.Kinds()) != 1 || fx.Kinds()[0] != "series" {
		t.Fatalf("row 4 %+v", fx)
	}
	// Bad rows are kept, flagged.
	if rows[5].Invalid != "bad kp_id" || rows[6].Invalid != "bad rating" {
		t.Fatalf("invalid %q %q", rows[5].Invalid, rows[6].Invalid)
	}
	// Escaped quotes.
	if h := rows[7]; h.TitleOriginal != `Hotel "Grand"` {
		t.Fatalf("row 7 %q", h.TitleOriginal)
	}
	if k := rows[9].Kinds(); len(k) != 1 || k[0] != "movie" {
		t.Fatalf("cartoon kinds %v", k)
	}
}

func TestParseCSVErrors(t *testing.T) {
	if _, err := ParseCSV(strings.NewReader("")); !errors.Is(err, ErrBadHeader) {
		t.Fatalf("empty: %v", err)
	}
	if _, err := ParseCSV(strings.NewReader("a,b,c\n1,2,3\n")); !errors.Is(err, ErrBadHeader) {
		t.Fatalf("wrong header: %v", err)
	}
	// Column order does not matter; unknown types search both kinds; blank
	// lines are skipped; short lines are invalid, not fatal.
	rows, err := ParseCSV(strings.NewReader("my_rating,year,title_original,title_ru,type,kp_id\n" +
		"8,2000,Kilo,Кило,anime,77\n\n" +
		"5,2001\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].KPID != 77 || rows[0].MyRating != 8 || len(rows[0].Kinds()) != 2 || rows[0].RatedAt != nil {
		t.Fatalf("%+v", rows)
	}
	if rows[1].Invalid == "" {
		t.Fatalf("short line must be invalid: %+v", rows[1])
	}
	if y := parseYear("19x5"); y != 0 {
		t.Fatal(y)
	}
}
