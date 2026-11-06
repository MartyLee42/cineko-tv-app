package releases

import (
	"strings"
	"unicode"
)

// normTokens lowercases a title, folds ё→е, drops punctuation, apostrophes,
// the article "the" (and a leading "a"/"an"), edition noise words, and maps
// Roman numerals and "&" so that "The Matrix" ≡ "Matrix", "Rocky II" ≡
// "Rocky 2" and "Spider-Man" ≡ "Spider Man".
func normTokens(s string) []string {
	s = strings.ToLower(s)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == 'ё':
			b.WriteRune('е')
		case r == '\'' || r == '’' || r == '`' || r == 'ʼ' || r == '´':
			// "Herbert's" → "herberts"
		case r == '&' || r == '+':
			b.WriteString(" & ")
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		default:
			b.WriteRune(' ')
		}
	}
	raw := strings.Fields(b.String())
	out := make([]string, 0, len(raw))
	for i, t := range raw {
		if t == "and" || t == "и" {
			t = "&"
		}
		if t == "the" || (i == 0 && (t == "a" || t == "an") && len(raw) > 1) {
			continue
		}
		if editionNoise[t] {
			continue
		}
		if r, ok := romans[t]; ok {
			t = r
		}
		out = append(out, t)
	}
	return out
}

func normTitle(s string) string { return strings.Join(normTokens(s), " ") }

var romans = map[string]string{"ii": "2", "iii": "3", "iv": "4", "vi": "6", "vii": "7", "viii": "8", "ix": "9"}

// editionNoise words don't distinguish titles ("Director's Cut",
// "Режиссёрская версия", "Remastered").
var editionNoise = map[string]bool{
	"remastered": true, "remaster": true, "extended": true, "unrated": true, "uncut": true,
	"theatrical": true, "directors": true, "cut": true, "edition": true, "imax": true,
	"режиссерская": true, "расширенная": true, "театральная": true, "версия": true,
	"полная": true, "open": true, "matte": true,
}

// numberWords mark sequels ("Part Two", "Часть вторая").
var numberWords = map[string]bool{
	"part": true, "часть": true, "chapter": true, "глава": true, "vol": true, "volume": true, "том": true,
	"one": true, "two": true, "three": true, "four": true, "five": true, "six": true,
	"first": true, "second": true, "third": true, "fourth": true, "fifth": true,
	"первая": true, "первый": true, "вторая": true, "второй": true, "третья": true, "третий": true,
	"четвертая": true, "четвертый": true, "пятая": true, "пятый": true, "шестая": true, "шестой": true,
}

func isNumberToken(t string) bool {
	if numberWords[t] {
		return true
	}
	for _, r := range t {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return t != ""
}

// collectionWords mark multi-film packs.
var collectionWords = map[string]bool{
	"трилогия": true, "дилогия": true, "тетралогия": true, "квадрилогия": true, "квадрология": true,
	"пенталогия": true, "гексалогия": true, "антология": true, "коллекция": true, "сборник": true,
	"trilogy": true, "duology": true, "dilogy": true, "quadrilogy": true, "anthology": true,
	"collection": true, "boxset": true, "triple": true, "double": true, "feature": true, "ultimate": true, "complete": true,
}

func hasCyrillic(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Cyrillic, r) {
			return true
		}
	}
	return false
}

func hasLatin(s string) bool {
	for _, r := range s {
		if r < unicode.MaxASCII && unicode.IsLetter(r) {
			return true
		}
	}
	return false
}

// script reports "cyr", "lat", or "" for titles of other scripts.
func script(s string) string {
	switch {
	case hasCyrillic(s):
		return "cyr"
	case hasLatin(s):
		return "lat"
	}
	return ""
}

// levRatio is 1 - normalized Levenshtein distance over runes.
func levRatio(a, b string) float64 {
	ra, rb := []rune(a), []rune(b)
	if len(ra) == 0 && len(rb) == 0 {
		return 1
	}
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return 1 - float64(prev[len(rb)])/float64(max(len(ra), len(rb)))
}
