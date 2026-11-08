package foryou

import (
	"context"

	"martytv/api/internal/family"
)

// familyRowLimit is the number of titles in the «Семья советует» row.
const familyRowLimit = 20

// withFamily inserts the «Семья советует» row (internal/family) as the
// second row (first when there is no other; later when its learned weight
// is low: pos), computed per request. Its
// titles leave the other rows (items stay unique across rows); rows left
// too short are dropped. Errors only drop the family row.
func (s *Service) withFamily(ctx context.Context, profileID, lang string, rows []Row, pos int) []Row {
	if s.family == nil {
		return rows
	}
	b, err := s.family.Block(ctx, profileID, lang, familyRowLimit)
	if err != nil {
		s.log.WarnContext(ctx, "foryou: family row failed", "err", err)
		return rows
	}
	if b == nil || !b.Enabled || len(b.Items) == 0 {
		return rows
	}
	row := FamilyRow(lang, b)
	in := map[string]bool{}
	for _, it := range row.Items {
		in[it.Media.ID] = true
	}
	out := make([]Row, 0, len(rows)+1)
	for _, r := range rows {
		items := r.Items[:0:0]
		for _, it := range r.Items {
			if !in[it.Media.ID] {
				items = append(items, it)
			}
		}
		if len(items) < len(r.Items) && len(items) < minRenderItems {
			continue
		}
		r.Items = items
		out = append(out, r)
	}
	at := min(pos, len(out))
	return append(out[:at], append([]Row{row}, out[at:]...)...)
}

// FamilyRow turns a family block into a «Для вас» row (kind family).
func FamilyRow(lang string, b *family.Block) Row {
	title := pick(lang, "Семья советует", "Family picks")
	row := Row{ID: RowFamily, Kind: RowFamily, Title: title, Items: make([]Item, 0, len(b.Items)),
		Reason: ReasonOut{Type: ReasonFamily, Text: title, GenreIDs: []int{}, GenreNames: []string{}},
		Family: &FamilyRowInfo{Members: b.Members}}
	for _, it := range b.Items {
		why := it.Why
		row.Items = append(row.Items, Item{Media: it.Media, Score: it.Score,
			Reason: ReasonOut{Type: ReasonFamily, Text: why.Text, GenreIDs: []int{}, GenreNames: []string{}, Family: &why}})
	}
	return row
}
