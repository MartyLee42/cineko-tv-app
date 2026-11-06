// Package curated serves «Подборки»: hand-made film lists from books
// (Deleuze's «Кино», Bazin…), directors' own lists, polls and canons, and
// the Russian/Soviet canon.
//
// Each list is a JSON file in lists/ embedded into the binary (add a list:
// drop a file there and deploy; see docs/architecture.md "Curated lists").
// A background resolver maps every item to a catalog title (by TMDB id,
// falling back to a title + year search) into curated_items; the API reads
// that table plus the profile's watch state.
package curated

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"regexp"
	"slices"
	"sort"
	"strings"
)

//go:embed lists/*.json
var listFiles embed.FS

// Groups in display order.
var Groups = []string{"thinkers", "directors", "polls", "modern", "ru"}

// Item is one film of a list file.
type Item struct {
	TMDBID        *int   `json:"tmdb_id"`
	Kind          string `json:"kind"`
	Title         string `json:"title"`
	OriginalTitle string `json:"original_title"`
	Year          int    `json:"year"`
	// Rank is the published rank (polls; ties share one). Empty: an
	// ordered list ranks by position.
	Rank   *int   `json:"rank,omitempty"`
	NoteRU string `json:"note_ru,omitempty"`
	NoteEN string `json:"note_en,omitempty"`
}

// List is one list file.
type List struct {
	ID            string `json:"id"`
	Group         string `json:"group"`
	TitleRU       string `json:"title_ru"`
	TitleEN       string `json:"title_en"`
	Author        string `json:"author"`
	Source        string `json:"source"`
	SourceURL     string `json:"source_url,omitempty"`
	DescriptionRU string `json:"description_ru"`
	DescriptionEN string `json:"description_en"`
	Ordered       bool   `json:"ordered"`
	Items         []Item `json:"items"`
}

// Title is the localized title.
func (l *List) Title(lang string) string { return pick(lang, l.TitleRU, l.TitleEN) }

// Description is the localized description.
func (l *List) Description(lang string) string { return pick(lang, l.DescriptionRU, l.DescriptionEN) }

// Note is the item's localized note ("" = none).
func (it *Item) Note(lang string) string { return pick(lang, it.NoteRU, it.NoteEN) }

func pick(lang, ru, en string) string {
	if lang == "ru" && ru != "" || en == "" {
		return ru
	}
	return en
}

// key identifies a file entry; a changed key is resolved again.
func (it *Item) key() string {
	id := 0
	if it.TMDBID != nil {
		id = *it.TMDBID
	}
	return fmt.Sprintf("%s|%d|%s|%d", it.Kind, id, it.OriginalTitle, it.Year)
}

var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// Validate checks one list: id, group, titles, items (kind, title, year,
// no duplicate TMDB id).
func (l *List) Validate() error {
	if !idRe.MatchString(l.ID) {
		return fmt.Errorf("bad id %q", l.ID)
	}
	if !slices.Contains(Groups, l.Group) {
		return fmt.Errorf("%s: bad group %q", l.ID, l.Group)
	}
	if strings.TrimSpace(l.TitleRU) == "" || strings.TrimSpace(l.TitleEN) == "" {
		return fmt.Errorf("%s: title_ru and title_en are required", l.ID)
	}
	if strings.TrimSpace(l.Author) == "" || strings.TrimSpace(l.Source) == "" {
		return fmt.Errorf("%s: author and source are required", l.ID)
	}
	if len(l.Items) == 0 {
		return fmt.Errorf("%s: no items", l.ID)
	}
	seen := map[string]bool{}
	for i, it := range l.Items {
		at := fmt.Sprintf("%s item %d (%s)", l.ID, i+1, it.Title)
		if it.Kind != "movie" && it.Kind != "series" {
			return fmt.Errorf("%s: bad kind %q", at, it.Kind)
		}
		if strings.TrimSpace(it.Title) == "" || strings.TrimSpace(it.OriginalTitle) == "" {
			return fmt.Errorf("%s: title and original_title are required", at)
		}
		if it.Year < 1880 || it.Year > 2100 {
			return fmt.Errorf("%s: bad year %d", at, it.Year)
		}
		if it.Rank != nil && (*it.Rank < 1 || *it.Rank > 10000) {
			return fmt.Errorf("%s: bad rank %d", at, *it.Rank)
		}
		if it.TMDBID != nil {
			if *it.TMDBID <= 0 {
				return fmt.Errorf("%s: bad tmdb_id", at)
			}
			k := fmt.Sprintf("%s/%d", it.Kind, *it.TMDBID)
			if seen[k] {
				return fmt.Errorf("%s: duplicate tmdb_id %d", at, *it.TMDBID)
			}
			seen[k] = true
		}
	}
	return nil
}

// Parse decodes and validates list files (any fs with *.json at its root),
// sorted by group order then file order of ids.
func Parse(fsys fs.FS) ([]List, error) {
	names, err := fs.Glob(fsys, "*.json")
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	var out []List
	ids := map[string]bool{}
	for _, n := range names {
		b, err := fs.ReadFile(fsys, n)
		if err != nil {
			return nil, err
		}
		var l List
		dec := json.NewDecoder(strings.NewReader(string(b)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&l); err != nil {
			return nil, fmt.Errorf("%s: %w", n, err)
		}
		if err := l.Validate(); err != nil {
			return nil, fmt.Errorf("%s: %w", n, err)
		}
		if n != l.ID+".json" {
			return nil, fmt.Errorf("%s: file name must be %s.json", n, l.ID)
		}
		if ids[l.ID] {
			return nil, fmt.Errorf("%s: duplicate list id", n)
		}
		ids[l.ID] = true
		out = append(out, l)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return slices.Index(Groups, out[i].Group) < slices.Index(Groups, out[j].Group)
	})
	return out, nil
}

// Embedded returns the lists built into the binary.
func Embedded() ([]List, error) {
	sub, err := fs.Sub(listFiles, "lists")
	if err != nil {
		return nil, err
	}
	return Parse(sub)
}
