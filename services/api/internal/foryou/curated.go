package foryou

import (
	"context"
	"errors"
	"hash/fnv"
	"strconv"

	"martytv/api/internal/catalog"
	"martytv/api/internal/curated"
)

// «Подборки» (internal/curated) in «Для вас»: one curated list per profile
// per day as a Home row, and a section of tiles in Explore.

// CuratedSource is internal/curated.
type CuratedSource interface {
	Progress(ctx context.Context, profileID string) ([]curated.Progress, error)
	List(ctx context.Context, id, profileID, lang string) (*curated.ListOut, error)
}

const (
	// curatedRowLimit is the number of titles in the Home row.
	curatedRowLimit = 20
	// curatedRowAt is the Home row's index (after «Подобрано» and the family).
	curatedRowAt = 2
)

// CuratedRowInfo is the contract's ForYouCuratedRow.
type CuratedRowInfo struct {
	ListID  string `json:"list_id"`
	Title   string `json:"title"`
	Author  string `json:"author"`
	Count   int    `json:"count"`
	Watched int    `json:"watched"`
}

// curatedEligible: enough titles to render and something left to watch.
func curatedEligible(p *curated.Progress) bool {
	return len(p.Entries) >= minRenderItems && p.Watched < len(p.Entries)
}

// curatedCand is one list for the daily pick.
type curatedCand struct {
	id      string
	partial bool    // started but not finished
	taste   float64 // mean taste affinity of its titles (about -1..1)
}

// dayRand is a stable pseudo-random number in [0,1) per profile, day and list.
func dayRand(profileID, day, id string) float64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(profileID + "|" + day + "|" + id))
	return float64(h.Sum64()%1_000_000) / 1_000_000
}

// pickCurated chooses the day's list: partly watched lists first, then the
// best taste match, with a daily rotation among close ones.
func pickCurated(cands []curatedCand, profileID, day string) string {
	best, bestScore := "", -1e9
	for _, c := range cands {
		score := 2*c.taste + dayRand(profileID, day, c.id)
		if c.partial {
			score += 10
		}
		if score > bestScore {
			best, bestScore = c.id, score
		}
	}
	return best
}

// curatedTaste scores each list by the profile's decade and genre
// affinities over its titles.
func (s *Service) curatedTaste(ctx context.Context, profileID string, progress []curated.Progress) map[string]float64 {
	out := map[string]float64{}
	t, _, err := s.loadTaste(ctx, profileID)
	if err != nil || t == nil {
		return out
	}
	var ids []string
	for _, p := range progress {
		for _, e := range p.Entries {
			ids = append(ids, e.MediaID)
		}
	}
	sums, err := s.cat.SummariesByID(ctx, slicesUniq(ids), "en")
	if err != nil {
		return out
	}
	for _, p := range progress {
		var total float64
		n := 0
		for _, e := range p.Entries {
			m, ok := sums[e.MediaID]
			if !ok {
				continue
			}
			var sc float64
			if m.Year != nil {
				sc += t.decadeScore(*m.Year)
			}
			if len(m.GenreIDs) > 0 {
				var g float64
				for _, id := range m.GenreIDs {
					g += t.genreScore(id)
				}
				sc += g / float64(len(m.GenreIDs))
			}
			total += sc / 2
			n++
		}
		if n > 0 {
			out[p.List.ID] = total / float64(n)
		}
	}
	return out
}

// curatedChoice is a profile's list of the day (Service.curatedDay).
type curatedChoice struct{ day, list string }

// curatedPick returns the day's list for the profile (cached per day).
func (s *Service) curatedPick(ctx context.Context, profileID string, progress []curated.Progress) *curated.Progress {
	day := s.now().In(msk).Format("2006-01-02")
	if v, ok := s.curatedDay.Load(profileID); ok && v.(curatedChoice).day == day {
		for i := range progress {
			if progress[i].List.ID == v.(curatedChoice).list && curatedEligible(&progress[i]) {
				return &progress[i]
			}
		}
	}
	var taste map[string]float64
	var cands []curatedCand
	for i := range progress {
		p := &progress[i]
		if !curatedEligible(p) {
			continue
		}
		if taste == nil {
			taste = s.curatedTaste(ctx, profileID, progress)
		}
		cands = append(cands, curatedCand{id: p.List.ID, partial: p.Watched > 0, taste: taste[p.List.ID]})
	}
	id := pickCurated(cands, profileID, day)
	if id == "" {
		return nil
	}
	s.curatedDay.Store(profileID, curatedChoice{day: day, list: id})
	for i := range progress {
		if progress[i].List.ID == id {
			return &progress[i]
		}
	}
	return nil
}

// withCurated inserts the day's «Подборка» row (show_curated, default on).
// Errors only drop the row.
func (s *Service) withCurated(ctx context.Context, profileID, lang string, rows []Row) []Row {
	if s.curated == nil {
		return rows
	}
	st, err := s.profiles.GetSettings(ctx, profileID)
	if err != nil || st.ShowCurated != nil && !*st.ShowCurated {
		return rows
	}
	progress, err := s.curated.Progress(ctx, profileID)
	if err != nil {
		s.log.WarnContext(ctx, "foryou: curated row failed", "err", err)
		return rows
	}
	p := s.curatedPick(ctx, profileID, progress)
	if p == nil {
		return rows
	}
	row, err := s.curatedRow(ctx, profileID, lang, p)
	if err != nil {
		s.log.WarnContext(ctx, "foryou: curated row failed", "err", err)
		return rows
	}
	if row == nil {
		return rows
	}
	at := min(curatedRowAt, len(rows))
	return append(rows[:at:at], append([]Row{*row}, rows[at:]...)...)
}

// curatedRowTitle is «Подборка: <list> · 7 из 48».
func curatedRowTitle(lang, list string, watched, count int) string {
	return tr(lang, "Подборка: ", "Collection: ") + list + " · " +
		strconv.Itoa(watched) + tr(lang, " из ", " of ") + strconv.Itoa(count)
}

func (s *Service) curatedRow(ctx context.Context, profileID, lang string, p *curated.Progress) (*Row, error) {
	l := p.List
	var ids []string
	notes := map[string]string{}
	for pass := 0; pass < 2; pass++ { // unwatched first, then watched
		for _, e := range p.Entries {
			if e.Watched == (pass == 1) && len(ids) < curatedRowLimit {
				ids = append(ids, e.MediaID)
				notes[e.MediaID] = l.Items[e.Position-1].Note(lang)
			}
		}
	}
	sums, err := s.summaries(ctx, profileID, lang, ids)
	if err != nil {
		return nil, err
	}
	if len(sums) < minRenderItems {
		return nil, nil
	}
	title := l.Title(lang)
	row := &Row{ID: "curated:" + l.ID, Kind: RowCurated, Title: curatedRowTitle(lang, title, p.Watched, len(l.Items)),
		Reason:  ReasonOut{Type: ReasonCurated, Text: title, GenreIDs: []int{}, GenreNames: []string{}},
		Items:   make([]Item, 0, len(sums)),
		Curated: &CuratedRowInfo{ListID: l.ID, Title: title, Author: l.Author, Count: len(l.Items), Watched: p.Watched}}
	for i, m := range sums {
		text := notes[m.ID]
		if text == "" {
			text = title
		}
		row.Items = append(row.Items, Item{Media: m, Score: float64(len(sums) - i),
			Reason: ReasonOut{Type: ReasonCurated, Text: text, GenreIDs: []int{}, GenreNames: []string{}}})
	}
	return row, nil
}

// curatedSection is Explore's «Подборки» section (nil = no lists).
func (s *Service) curatedSection(ctx context.Context, profileID, lang string) (*ExploreSection, error) {
	if s.curated == nil {
		return nil, nil
	}
	progress, err := s.curated.Progress(ctx, profileID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, p := range progress {
		for i, e := range p.Entries {
			if i < 6 {
				ids = append(ids, e.MediaID)
			}
		}
	}
	sums, err := s.cat.SummariesByID(ctx, slicesUniq(ids), lang)
	if err != nil {
		return nil, err
	}
	sec := &ExploreSection{ID: "curated", Kind: "curated", Title: tr(lang, "Подборки", "Curated lists")}
	for _, p := range progress {
		if len(p.Entries) == 0 {
			continue
		}
		l := p.List
		tile := ExploreTile{ID: "curated:" + l.ID, Kind: "curated", Title: l.Title(lang), Subtitle: strp(l.Author),
			CuratedID: strp(l.ID), Progress: strp(strconv.Itoa(p.Watched) + " / " + strconv.Itoa(len(l.Items)))}
		for _, e := range p.Entries {
			if m, ok := sums[e.MediaID]; ok && m.BackdropPath != nil {
				tile.ImagePath = m.BackdropPath
				break
			}
		}
		sec.Tiles = append(sec.Tiles, tile)
	}
	if len(sec.Tiles) == 0 {
		return nil, nil
	}
	return sec, nil
}

// browseCurated is GET /foryou/browse?tile=curated:<id>: the list's
// catalog titles in order, with `me`.
func (s *Service) browseCurated(ctx context.Context, profileID, tile, id, lang string) (*BrowsePage, error) {
	if s.curated == nil {
		return nil, errNotFound
	}
	l, err := s.curated.List(ctx, id, profileID, lang)
	if err != nil {
		if errors.Is(err, curated.ErrNotFound) {
			return nil, errNotFound
		}
		return nil, err
	}
	items := []catalog.MediaSummary{}
	for _, it := range l.Items {
		if it.Media != nil {
			items = append(items, *it.Media)
		}
	}
	return &BrowsePage{MediaPage: catalog.MediaPage{Items: items, Page: 1, TotalPages: 1, TotalResults: len(items)}, Tile: tile, Title: l.Title}, nil
}
