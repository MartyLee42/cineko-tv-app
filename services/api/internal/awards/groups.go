package awards

import (
	"regexp"
	"strings"
)

// The curated map of major awards. Every Q-id was checked against Wikidata
// labels (see docs/architecture.md "Awards"). An award item belongs to a
// group when one of the group's anchors is reachable from it through
// instance of / part of / conferred by, optionally followed by one more
// part of (P31|P361|P1027 then P361?), e.g.
//
//	Q102427 Academy Award for Best Picture —P361→ Q19020 Academy Awards
//	Q2089918 Volpi Cup for Best Actress —P31→ Q108773780 Venice Film Festival Awards
//	Q664212 Silver Bear Grand Jury Prize —P1027→ Q130871 Berlinale
//
// Items reaching no anchor go to "other" (tier 3).

// Group is one award family shown as a block in the UI.
type Group struct {
	Key     string
	RU, EN  string
	Tier    int      // 1 = Oscars (every category), 2 = other major awards
	Anchors []string // Wikidata items the group's awards point to
}

// groups in display priority (ties in sorting and badges).
var groups = []Group{
	{"oscar", "Оскар", "Oscar", 1, []string{"Q19020"}},                   // Academy Awards
	{"cannes", "Канны", "Cannes", 2, []string{"Q28444913", "Q42369"}},    // Cannes Film Festival Awards, Cannes Film Festival
	{"venice", "Венеция", "Venice", 2, []string{"Q108773780", "Q49024"}}, // Venice Film Festival Awards, Venice Film Festival
	{"berlin", "Берлинале", "Berlinale", 2, []string{"Q130871"}},         // Berlin International Film Festival
	{"golden_globe", "Золотой глобус", "Golden Globe", 2, []string{"Q1011547"}},
	{"bafta", "BAFTA", "BAFTA", 2, []string{"Q732997"}},          // British Academy Film Awards
	{"emmy", "Эмми", "Emmy", 2, []string{"Q1044427", "Q123737"}}, // Primetime Emmy Award, Emmy Award
	{"cesar", "Сезар", "César", 2, []string{"Q174389"}},          // César Award
	{"goya", "Гойя", "Goya", 2, []string{"Q212828"}},             // Goya Awards
	{"efa", "Европейская киноакадемия", "European Film Awards", 2, []string{"Q223740"}},
	{"spirit", "Независимый дух", "Independent Spirit", 2, []string{"Q311836"}}, // Film Independent Spirit Awards
	{"nika", "Ника", "Nika", 2, []string{"Q431668"}},                            // Nika Award
	{"golden_eagle", "Золотой орёл", "Golden Eagle", 2, []string{"Q580231"}},    // Golden Eagle Awards (Russia)
	{"kinotavr", "Кинотавр", "Kinotavr", 2, []string{"Q2278467"}},
}

// Other is the group of every award outside the curated map.
var Other = Group{Key: "other", RU: "Другие награды", EN: "Other awards", Tier: 3}

// mainPrizes are tier-1 awards of tier-2 groups: the festivals' top prizes.
var mainPrizes = map[string]string{
	"Q179808": "cannes", // Palme d'Or
	"Q209459": "venice", // Golden Lion
	"Q154590": "berlin", // Golden Bear
}

// ignored awards are not awards of the film: a country's submission to the
// Oscars (Wikidata records it as "nominated for").
var ignored = map[string]bool{
	"Q125506406": true, // International Submission to the Academy Awards
}

var (
	groupByKey    = map[string]Group{}
	groupByAnchor = map[string]Group{}
	groupRank     = map[string]int{}
)

func init() {
	for i, g := range groups {
		groupByKey[g.Key] = g
		groupRank[g.Key] = i
		for _, a := range g.Anchors {
			groupByAnchor[a] = g
		}
	}
	groupByKey[Other.Key] = Other
	groupRank[Other.Key] = len(groups)
}

// anchors lists every anchor Q-id (for the SPARQL VALUES clause).
func anchors() []string {
	var out []string
	for _, g := range groups {
		out = append(out, g.Anchors...)
	}
	return out
}

// classify picks the group and tier of an award item from the anchors it
// reaches or is (several: the highest-priority group wins).
func classify(qid string, reached []string) (string, int) {
	if g, ok := mainPrizes[qid]; ok {
		return g, 1
	}
	best, rank := Other, len(groups)
	// The award may be the anchor itself ("Nika Award", "Kinotavr").
	for _, a := range append([]string{qid}, reached...) {
		if g, ok := groupByAnchor[a]; ok && groupRank[g.Key] < rank {
			best, rank = g, groupRank[g.Key]
		}
	}
	return best.Key, best.Tier
}

// GroupLabel is the short group name in lang ("ru" or "en").
func GroupLabel(key, lang string) string {
	g, ok := groupByKey[key]
	if !ok {
		g = Other
	}
	if lang == "ru" {
		return g.RU
	}
	return g.EN
}

// Category prefixes dropped inside a group: "премия «Оскар» за лучший
// фильм" → "лучший фильм", "Academy Award for Best Picture" → "Best
// Picture". Only for curated groups ("other" keeps full names). Both
// patterns apply in either language: a missing ru label falls back to en.
var (
	ruPrefix  = regexp.MustCompile(`^(?:Прайм-тайм\s+)?(?:[Пп]ремия|[Пп]риз)\s+(?:«[^»]*»|BAFTA|Европейской киноакадемии|Каннского кинофестиваля|Венецианского кинофестиваля|Берлинского кинофестиваля)\s+(?:за\s+|в категории\s+)?`)
	enPrefix  = regexp.MustCompile(`^(?:Academy|Golden Globe|BAFTA|César|Goya|Nika|Golden Eagle|European Film|(?:Film )?Independent Spirit|Primetime Emmy|Emmy|Cannes Film Festival|Kinotavr)\s+Award\s*(?:for|–|-)\s+(?:the\s+)?`)
	enWriting = regexp.MustCompile(`^Best Writing, `)
	quoted    = regexp.MustCompile(`^«([^»]*)»$`)
	// ruNominative turns the case after «за»/dative into the nominative:
	// «за лучшую мужскую роль» → «лучшая мужская роль», «лучшему режиссёру»
	// → «лучший режиссёр».
	ruNominative = strings.NewReplacer(
		"лучшую ", "лучшая ", "лучшему ", "лучший ", "лучшей актрисе", "лучшая актриса",
		"мужскую ", "мужская ", "женскую ", "женская ", "режиссёрскую ", "режиссёрская ", "операторскую ", "операторская ",
		"работу", "работа", "режиссуру", "режиссура", "музыку", "музыка", "песню", "песня",
		"режиссёру", "режиссёр", "актёру", "актёр", "актрисе", "актриса", "сценаристу", "сценарист",
		"оператору", "оператор", "композитору", "композитор", "телеактёру", "телеактёр", "художнику", "художник",
	)
)

// ShortLabel is the category name of an award within its group.
func ShortLabel(group, label string) string {
	if group == Other.Key {
		return label
	}
	s := ruPrefix.ReplaceAllString(label, "")
	if s != label {
		s = ruNominative.Replace(s)
	} else {
		s = enWriting.ReplaceAllString(enPrefix.ReplaceAllString(label, ""), "Best ")
	}
	s = quoted.ReplaceAllString(strings.TrimSpace(s), "$1")
	if s == "" {
		return label
	}
	return s
}
