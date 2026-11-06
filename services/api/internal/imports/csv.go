package imports

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// Kinopoisk ratings export (CSV, UTF-8, usually with a BOM):
//
//	kp_id,type,title_ru,title_original,year,my_rating,kp_rating,kp_votes,duration_min,date_rated,url
//	571,film,Схватка,Heat,1995,7,8.066,208697,171,2026-10-23 23:56,https://www.kinopoisk.ru/film/571/
//
// Columns are found by name (order does not matter; unknown ones are
// ignored). type is film | series | miniseries in practice; other values
// Kinopoisk has used (cartoon, anime, tv-show, …) are mapped below, and an
// unknown type is searched as both a movie and a series. year is "1995" for
// films and "2013–2014" / "2024–..." for series (the first year is used).

// MaxRows bounds one import (the owner's export has ~2 200 rows).
const MaxRows = 20000

// requiredColumns must be present in the header.
var requiredColumns = []string{"kp_id", "type", "title_ru", "title_original", "year", "my_rating"}

// ErrBadHeader means the file is not a Kinopoisk ratings export.
var ErrBadHeader = errors.New("imports: not a Kinopoisk ratings export (missing columns)")

// Row is one parsed CSV line.
type Row struct {
	Line          int        `json:"line"` // 1-based line in the file (header = 1)
	KPID          int        `json:"kp_id"`
	Type          string     `json:"type"`
	TitleRU       string     `json:"title_ru"`
	TitleOriginal string     `json:"title_original"`
	Year          int        `json:"year"` // 0 = unknown
	MyRating      int        `json:"my_rating"`
	KPRating      *float64   `json:"kp_rating,omitempty"`
	KPVotes       *int       `json:"kp_votes,omitempty"`
	RatedAt       *time.Time `json:"rated_at,omitempty"`
	// Invalid is set (with the reason) for a line that cannot be imported;
	// it is still kept so the summary can list it.
	Invalid string `json:"invalid,omitempty"`
}

// Title is the display title (Russian, else original).
func (r Row) Title() string {
	if r.TitleRU != "" {
		return r.TitleRU
	}
	return r.TitleOriginal
}

// Kinds returns the catalog kinds to search for the row's type.
func (r Row) Kinds() []string {
	switch strings.ToLower(strings.TrimSpace(r.Type)) {
	case "film", "movie", "cartoon", "video", "short", "short-film", "animated-film", "tv-movie":
		return []string{"movie"}
	case "series", "miniseries", "mini-series", "tv-series", "tv-show", "animated-series", "anime-series", "series-anime":
		return []string{"series"}
	}
	return []string{"movie", "series"} // anime and anything new: either
}

// moscow is Kinopoisk's clock (UTC+3, no DST since 2014).
var moscow = time.FixedZone("MSK", 3*3600)

// ParseCSV reads a Kinopoisk export. A broken header is an error; broken
// lines come back as rows with Invalid set (kp_id may then be 0).
func ParseCSV(r io.Reader) ([]Row, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	data = bytes.TrimPrefix(data, []byte("\xEF\xBB\xBF"))
	cr := csv.NewReader(bytes.NewReader(data))
	cr.FieldsPerRecord = -1 // checked per line
	cr.LazyQuotes = true
	cr.ReuseRecord = false
	header, err := cr.Read()
	if err != nil {
		return nil, ErrBadHeader
	}
	col := map[string]int{}
	for i, h := range header {
		col[strings.ToLower(strings.TrimSpace(h))] = i
	}
	for _, c := range requiredColumns {
		if _, ok := col[c]; !ok {
			return nil, ErrBadHeader
		}
	}
	get := func(rec []string, name string) string {
		i, ok := col[name]
		if !ok || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}

	var rows []Row
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				rows = append(rows, Row{Line: pe.Line, Invalid: "malformed line"})
				if len(rows) > MaxRows {
					return nil, fmt.Errorf("imports: more than %d rows", MaxRows)
				}
				continue
			}
			return nil, err
		}
		if len(rec) == 1 && strings.TrimSpace(rec[0]) == "" {
			continue // blank line
		}
		line, _ := cr.FieldPos(0)
		row := Row{
			Line:          line,
			Type:          get(rec, "type"),
			TitleRU:       get(rec, "title_ru"),
			TitleOriginal: get(rec, "title_original"),
			Year:          parseYear(get(rec, "year")),
		}
		row.KPID, _ = strconv.Atoi(get(rec, "kp_id"))
		row.MyRating, _ = strconv.Atoi(get(rec, "my_rating"))
		if v, err := strconv.ParseFloat(get(rec, "kp_rating"), 64); err == nil && v > 0 && v <= 10 {
			row.KPRating = &v
		}
		if v, err := strconv.Atoi(get(rec, "kp_votes")); err == nil && v >= 0 {
			row.KPVotes = &v
		}
		if t, err := time.ParseInLocation("2006-01-02 15:04", get(rec, "date_rated"), moscow); err == nil {
			t = t.UTC()
			row.RatedAt = &t
		} else if t, err := time.ParseInLocation("2006-01-02", get(rec, "date_rated"), moscow); err == nil {
			t = t.UTC()
			row.RatedAt = &t
		}
		switch {
		case row.KPID <= 0:
			row.Invalid = "bad kp_id"
		case row.MyRating < 1 || row.MyRating > 10:
			row.Invalid = "bad rating"
		case row.TitleRU == "" && row.TitleOriginal == "":
			row.Invalid = "no title"
		}
		rows = append(rows, row)
		if len(rows) > MaxRows {
			return nil, fmt.Errorf("imports: more than %d rows", MaxRows)
		}
	}
	return rows, nil
}

// parseYear takes the first 4-digit year of "1995", "2013–2014", "2024–...".
func parseYear(s string) int {
	if len(s) < 4 {
		return 0
	}
	y, err := strconv.Atoi(s[:4])
	if err != nil || y < 1870 || y > 2100 {
		return 0
	}
	return y
}
