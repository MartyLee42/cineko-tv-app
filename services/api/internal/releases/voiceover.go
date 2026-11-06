package releases

import (
	"regexp"
	"strings"
)

// Voiceover is one dub / voice-over / original track advertised in a release
// title (contract: Release.voiceovers), e.g. "MVO (LostFilm)".
type Voiceover struct {
	// Kind: dub (full dub), mvo (multi-voice), dvo (two-voice), avo (author /
	// single famous translator), vo (single-voice / amateur), original; nil
	// when only the studio is known.
	Kind     *string `json:"kind"`
	Studio   *string `json:"studio"`
	Language string  `json:"language"`
}

// knownStudios are dubbing/voice-over studios and translators that appear in
// RU tracker titles. Matching is case-insensitive on whole words; the value is
// the display spelling.
var knownStudios = []string{
	"LostFilm", "NewStudio", "AlexFilm", "Кубик в Кубе", "HDRezka Studio", "HDRezka", "Jaskier", "TVShows",
	"Novamedia", "NovaFilm", "Amedia", "ColdFilm", "BaibaKo", "Кравец", "Пифагор", "Red Head Sound", "RHS",
	"SDI Media", "Невафильм", "Мосфильм-Мастер", "Мосфильм", "Гоблин", "Goblin", "Гаврилов", "Михалёв",
	"Михалев", "Володарский", "Живов", "Сербин", "Яроцкий", "Карцев", "Сыендук", "AniLibria", "AniDub",
	"SHIZA Project", "SHIZA", "Studio Band", "LE-Production", "Ultradox", "Flarrow Films", "Ozz", "GoldTeam",
	"IdeaFilm", "Kerob", "Videofilm", "Superbit", "Ivi", "Okko", "Kinopoisk", "Кинопоиск", "Netflix",
	"Dragon Money Studio", "Дубляж Red Head Sound", "SoftBox", "Лексикон", "Paradox", "Ozz.tv", "Wink",
	"Premier", "START", "More.tv", "Двухголосый Ruscico", "Ruscico", "CP Digital", "Мьюзик-трейд",
	"Хабар", "VSI Moscow", "Hamster Studio", "AlphaProject", "Дубляж Пифагор",
}

var (
	studioRes = func() []struct {
		re   *regexp.Regexp
		name string
	} {
		out := make([]struct {
			re   *regexp.Regexp
			name string
		}, 0, len(knownStudios))
		for _, s := range knownStudios {
			// (?:^|[^\pL\pN]) … (?:$|[^\pL\pN]) = word boundaries that work for Cyrillic.
			out = append(out, struct {
				re   *regexp.Regexp
				name string
			}{regexp.MustCompile(`(?i)(?:^|[^\pL\pN])` + regexp.QuoteMeta(s) + `(?:$|[^\pL\pN])`), s})
		}
		return out
	}()

	// A kind optionally followed by "(Studio, Studio)".
	voKindRe = regexp.MustCompile(`(?i)(?:^|[^\pL])(dub(?:bing)?|дубляж|дублированный|mvo|многоголос\pL*|dvo|двухголос\pL*|avo|авторск\pL*|vo|одноголос\pL*|закадров\pL*|original|оригинал\pL*)(?:\s+\pL+)?\s*(?:\(([^)]{2,120})\))?`)
	// RuTor codes after "|": D, P, P2, L, L1, A.
	rutorVoRe = regexp.MustCompile(`\|\s*((?:[DPLA]\d?)(?:\s*,\s*[DPLA]\d?)*)\s*(?:$|[|\[])`)
	// "[LostFilm]" / "| LostFilm" style brackets holding a single studio.
	bracketRe = regexp.MustCompile(`[\[|]\s*([^\[\]|]{2,40}?)\s*(?:\]|$)`)
)

func kindOf(tok string) string {
	t := strings.ToLower(tok)
	switch {
	case strings.HasPrefix(t, "dub"), strings.HasPrefix(t, "дубл"):
		return "dub"
	case t == "mvo", strings.HasPrefix(t, "многоголос"):
		return "mvo"
	case t == "dvo", strings.HasPrefix(t, "двухголос"):
		return "dvo"
	case t == "avo", strings.HasPrefix(t, "авторск"):
		return "avo"
	case t == "vo", strings.HasPrefix(t, "одноголос"), strings.HasPrefix(t, "закадров"):
		return "vo"
	case strings.HasPrefix(t, "original"), strings.HasPrefix(t, "оригинал"):
		return "original"
	}
	return ""
}

func rutorKind(code string) string {
	switch code[0] {
	case 'D':
		return "dub"
	case 'P':
		return "mvo"
	case 'L':
		return "vo"
	case 'A':
		return "avo"
	}
	return ""
}

// parseVoiceovers extracts voice-over tracks from a release title. Studios
// named in "Kind (A, B)" get that kind; other known studios found anywhere
// get a nil kind; kinds without studios are listed on their own.
func parseVoiceovers(title string) []Voiceover {
	var out []Voiceover
	seen := map[string]bool{}
	add := func(kind, studio, lang string) {
		key := kind + "|" + strings.ToLower(studio)
		if studio != "" {
			key = strings.ToLower(studio)
		}
		if seen[key] || len(out) >= 8 {
			return
		}
		seen[key] = true
		v := Voiceover{Language: lang}
		if kind != "" {
			k := kind
			v.Kind = &k
		}
		if studio != "" {
			st := studio
			v.Studio = &st
		}
		out = append(out, v)
	}
	canonical := func(name string) string {
		for _, s := range studioRes {
			if s.re.MatchString(" " + name + " ") {
				return s.name
			}
		}
		return ""
	}

	kindsSeen := map[string]bool{}
	for _, m := range voKindRe.FindAllStringSubmatch(title, -1) {
		kind := kindOf(m[1])
		if kind == "" {
			continue
		}
		lang := "ru"
		if kind == "original" {
			lang = "orig"
			if strings.Contains(strings.ToLower(m[0]), "eng") {
				lang = "en"
			}
		}
		if m[2] == "" {
			kindsSeen[kind+"|"+lang] = true
			continue
		}
		for _, name := range regexp.MustCompile(`\s*(?:,|/|&|\s+и\s+|\s+and\s+)\s*`).Split(m[2], -1) {
			name = strings.TrimSpace(name)
			if c := canonical(name); c != "" {
				name = c
			}
			if name != "" && len([]rune(name)) <= 40 && hasLetters(name) {
				add(kind, name, lang)
			}
		}
	}
	// Known studios anywhere else in the title ("[LostFilm]", "| NewStudio").
	for _, s := range studioRes {
		if s.re.MatchString(title) {
			add("", s.name, "ru")
		}
	}
	// Kinds that had no studio attached.
	for k := range kindsSeen {
		parts := strings.SplitN(k, "|", 2)
		has := false
		for _, v := range out {
			if v.Kind != nil && *v.Kind == parts[0] {
				has = true
			}
		}
		if !has {
			add(parts[0], "", parts[1])
		}
	}
	if m := rutorVoRe.FindStringSubmatch(title); m != nil {
		for _, code := range regexp.MustCompile(`[DPLA]\d?`).FindAllString(m[1], -1) {
			k := rutorKind(code)
			has := false
			for _, v := range out {
				if v.Kind != nil && *v.Kind == k {
					has = true
				}
			}
			if !has {
				add(k, "", "ru")
			}
		}
	}
	return orderVoiceovers(out)
}

// orderVoiceovers lists dubs first, then multi/two/author/single voice, then
// unknown-kind studios, then original tracks.
func orderVoiceovers(v []Voiceover) []Voiceover {
	rank := map[string]int{"dub": 0, "mvo": 1, "dvo": 2, "avo": 3, "vo": 4, "": 5, "original": 6}
	k := func(x Voiceover) int {
		if x.Kind == nil {
			return rank[""]
		}
		return rank[*x.Kind]
	}
	for i := 1; i < len(v); i++ {
		for j := i; j > 0 && k(v[j]) < k(v[j-1]); j-- {
			v[j], v[j-1] = v[j-1], v[j]
		}
	}
	if v == nil {
		v = []Voiceover{}
	}
	return v
}
