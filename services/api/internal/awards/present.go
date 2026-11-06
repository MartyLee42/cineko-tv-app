package awards

import (
	"regexp"
	"sort"

	"martytv/api/internal/catalog"
)

// bestFilm categories lead their group/year (Best Picture before editing).
var bestFilm = regexp.MustCompile(`(?i)^(?:best picture|best film|best motion picture.*|лучший фильм)$`)

// label picks the award name in lang, falling back to the other language.
func (a Award) label(lang string) string {
	if lang == "ru" && a.LabelRU != "" || a.LabelEN == "" {
		return a.LabelRU
	}
	return a.LabelEN
}

// Grouped turns a title's rows into the API shape: one entry per group,
// wins and nominations ordered by year then category (the best-film
// category first), groups by tier, then wins, then nominations, then the
// curated order ("other" last).
func Grouped(rows []Award, lang string) []catalog.AwardGroup {
	type acc struct {
		g    catalog.AwardGroup
		wins []Award
		noms []Award
	}
	by := map[string]*acc{}
	var keys []string
	for _, a := range rows {
		x := by[a.Group]
		if x == nil {
			x = &acc{}
			by[a.Group] = x
			keys = append(keys, a.Group)
		}
		if a.Won {
			x.wins = append(x.wins, a)
		} else {
			x.noms = append(x.noms, a)
		}
	}
	entries := func(list []Award) []catalog.AwardEntry {
		out := make([]catalog.AwardEntry, len(list))
		for i, a := range list {
			out[i] = catalog.AwardEntry{Label: ShortLabel(a.Group, a.label(lang))}
			if a.Year > 0 {
				y := a.Year
				out[i].Year = &y
			}
		}
		sort.SliceStable(out, func(i, j int) bool {
			yi, yj := yearKey(out[i].Year), yearKey(out[j].Year)
			if yi != yj {
				return yi < yj
			}
			bi, bj := bestFilm.MatchString(out[i].Label), bestFilm.MatchString(out[j].Label)
			if bi != bj {
				return bi
			}
			return out[i].Label < out[j].Label
		})
		return out
	}
	minTier := func(list []Award) int {
		t := 4
		for _, a := range list {
			t = min(t, a.Tier)
		}
		return t
	}
	out := make([]catalog.AwardGroup, 0, len(keys))
	for _, k := range keys {
		x := by[k]
		tier := minTier(x.wins)
		if tier == 4 {
			tier = minTier(x.noms)
		}
		out = append(out, catalog.AwardGroup{
			Group: k, GroupLabel: GroupLabel(k, lang), Tier: tier,
			Wins: entries(x.wins), Nominations: entries(x.noms),
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		switch {
		case a.Tier != b.Tier:
			return a.Tier < b.Tier
		case len(a.Wins) != len(b.Wins):
			return len(a.Wins) > len(b.Wins)
		case len(a.Nominations) != len(b.Nominations):
			return len(a.Nominations) > len(b.Nominations)
		}
		return groupRank[a.Group] < groupRank[b.Group]
	})
	return out
}

func yearKey(y *int) int {
	if y == nil {
		return 1 << 30 // unknown years last
	}
	return *y
}

// pickBadge chooses the badge among a title's tier-1 win counts per group:
// the most wins, ties by the curated order (Oscars first).
func pickBadge(counts map[string]int) *catalog.AwardBadge {
	var best *catalog.AwardBadge
	for g, n := range counts {
		if n <= 0 {
			continue
		}
		if best == nil || n > best.Count || (n == best.Count && groupRank[g] < groupRank[best.Group]) {
			best = &catalog.AwardBadge{Group: g, Count: n}
		}
	}
	return best
}
