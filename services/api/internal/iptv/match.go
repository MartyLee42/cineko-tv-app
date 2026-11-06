package iptv

import (
	"regexp"
	"strings"
	"unicode"
)

// ---------------------------------------------------------------- names

var (
	reBrackets  = regexp.MustCompile(`[\(\[\{][^\)\]\}]*[\)\]\}]`)
	qualityWord = map[string]bool{
		"hd": true, "sd": true, "fhd": true, "uhd": true, "4k": true, "8k": true, "hevc": true, "h265": true,
		"orig": true, "original": true, "tv": false, "50fps": true, "1080p": true, "720p": true, "576p": true,
		"480p": true, "1080i": true, "576i": true,
	}
)

// NormalizeName folds a channel name for matching: lower case, ё→е,
// bracketed parts and quality words (HD, FHD, 4K…) removed, only letters
// and digits kept. "Матч! HD" and "МАТЧ!" both become "матч".
func NormalizeName(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, "ё", "е")
	s = reBrackets.ReplaceAllString(s, " ")
	words := strings.FieldsFunc(s, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '+' })
	var b strings.Builder
	for _, w := range words {
		if qualityWord[w] {
			continue
		}
		b.WriteString(strings.ReplaceAll(w, "+", "plus"))
	}
	return b.String()
}

// baseTvgID drops iptv-org's feed suffix: "2x2.ru@SD" → "2x2.ru".
func baseTvgID(id string) string {
	id = strings.ToLower(strings.TrimSpace(id))
	if i := strings.IndexByte(id, '@'); i > 0 {
		id = id[:i]
	}
	return id
}

// dedupeKey identifies a channel inside and across playlists: the tvg-id
// when present, else the normalized name plus the stream URL.
func dedupeKey(e Entry) string {
	if id := strings.ToLower(strings.TrimSpace(e.TvgID)); id != "" {
		return "id:" + id
	}
	return "nu:" + NormalizeName(e.Name) + "|" + e.URL
}

// ---------------------------------------------------------------- EPG matching

// epgIndex maps XMLTV channels for matching playlist channels.
type epgIndex struct {
	byID   map[string]string // lower-case xmltv id → id
	byBase map[string]string // baseTvgID(xmltv id) → id (first wins)
	byName map[string]string // NormalizeName(display-name) → id (ambiguous names dropped)
	dup    map[string]bool
}

func newEPGIndex() *epgIndex {
	return &epgIndex{byID: map[string]string{}, byBase: map[string]string{}, byName: map[string]string{}, dup: map[string]bool{}}
}

func (x *epgIndex) add(id string, names []string) {
	l := strings.ToLower(id)
	if _, ok := x.byID[l]; !ok {
		x.byID[l] = id
	}
	if b := baseTvgID(id); b != "" {
		if _, ok := x.byBase[b]; !ok {
			x.byBase[b] = id
		}
	}
	for _, n := range names {
		k := NormalizeName(n)
		if k == "" || x.dup[k] {
			continue
		}
		if prev, ok := x.byName[k]; ok && prev != id {
			delete(x.byName, k) // two different channels share the name: don't guess
			x.dup[k] = true
			continue
		}
		x.byName[k] = id
	}
}

// matchChannel is what the matcher knows about a playlist channel.
type matchChannel struct {
	TvgID    string
	Names    []string // name, tvg-name, iptv-org alt names
	Previous string   // xmltv id matched last time (kept when still present)
}

// match returns the XMLTV channel id for a playlist channel, or "".
// Order: exact tvg-id (case-insensitive) → tvg-id without the @feed
// suffix → normalized names (unambiguous only).
func (x *epgIndex) match(c matchChannel) string {
	if c.TvgID != "" {
		if id, ok := x.byID[strings.ToLower(c.TvgID)]; ok {
			return id
		}
		if id, ok := x.byBase[baseTvgID(c.TvgID)]; ok {
			return id
		}
	}
	for _, n := range c.Names {
		if id, ok := x.byName[NormalizeName(n)]; ok {
			return id
		}
	}
	return ""
}

// ---------------------------------------------------------------- groups

// knownGroups maps playlist group titles (iptv-org categories in English,
// common Russian provider groups) to fixed ids the clients localize.
var knownGroups = map[string]string{
	"news": "news", "новости": "news", "информационные": "news",
	"movies": "movies", "movie": "movies", "кино": "movies", "фильмы": "movies", "кинозал": "movies",
	"series": "series", "сериалы": "series",
	"sports": "sports", "sport": "sports", "спорт": "sports", "спортивные": "sports",
	"kids": "kids", "детские": "kids", "детям": "kids", "для детей": "kids",
	"animation": "animation", "мультфильмы": "animation", "мульт": "animation",
	"music": "music", "музыка": "music", "музыкальные": "music",
	"entertainment": "entertainment", "развлекательные": "entertainment", "развлечения": "entertainment",
	"documentary": "documentary", "познавательные": "documentary", "документальные": "documentary", "познавательное": "documentary",
	"general": "general", "общие": "general", "эфирные": "general", "общероссийские": "general", "федеральные": "general",
	"education": "education", "образование": "education", "обучающие": "education",
	"science": "science", "наука": "science",
	"culture": "culture", "культура": "culture",
	"lifestyle": "lifestyle", "стиль жизни": "lifestyle",
	"travel": "travel", "путешествия": "travel",
	"religious": "religious", "религия": "religious", "религиозные": "religious",
	"business": "business", "бизнес": "business",
	"comedy": "comedy", "юмор": "comedy", "юмористические": "comedy",
	"cooking": "cooking", "кулинария": "cooking",
	"auto": "auto", "авто": "auto",
	"outdoor": "outdoor", "охота и рыбалка": "outdoor",
	"shop": "shop", "магазины": "shop", "телемагазины": "shop",
	"classic": "classic", "family": "family", "семейные": "family",
	"legislative": "legislative", "weather": "weather", "погода": "weather", "relax": "relax",
	"undefined": "other", "other": "other", "другое": "other", "разное": "other", "": "other",
}

// GroupID maps a group title to a stable id: a known category (first of
// "Movies;Series"), else "g:<slug>".
func GroupID(title string) string {
	first, _, _ := strings.Cut(title, ";")
	t := strings.ToLower(strings.Join(strings.Fields(first), " "))
	t = strings.ReplaceAll(t, "ё", "е")
	if id, ok := knownGroups[t]; ok {
		return id
	}
	var b strings.Builder
	dash := false
	for _, r := range t {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	slug := strings.TrimRight(b.String(), "-")
	if slug == "" {
		return "other"
	}
	return "g:" + clip(slug, 60)
}

// groupName is the display title of a group (first category).
func groupName(title string) string {
	first, _, _ := strings.Cut(title, ";")
	first = strings.TrimSpace(first)
	if first == "" || strings.EqualFold(first, "undefined") {
		return "Other"
	}
	return first
}

var rePlusFeed = regexp.MustCompile(`(?i)^plus(\d{1,2})$`)

// matchNames orders the names a channel is matched by: Cyrillic names
// first (Russian guides; "NTV" would otherwise hit the German "n-tv"),
// then the rest. iptv-org alt names describe the base channel, so for a
// timeshift feed ("NTV.ru@Plus2") they get the feed's "+2" appended and
// only match the guide's "НТВ +2", never the main feed.
func matchNames(name, tvgID string, alt []string) []string {
	if _, feed, ok := strings.Cut(tvgID, "@"); ok {
		if m := rePlusFeed.FindStringSubmatch(feed); m != nil {
			shifted := make([]string, 0, len(alt))
			for _, a := range alt {
				shifted = append(shifted, a+" +"+m[1])
			}
			alt = shifted
		}
	}
	all := append([]string{name}, alt...)
	var cyr, rest []string
	for _, n := range all {
		if n == "" {
			continue
		}
		if hasCyrillic(n) {
			cyr = append(cyr, n)
		} else {
			rest = append(rest, n)
		}
	}
	return append(cyr, rest...)
}

func hasCyrillic(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Cyrillic, r) {
			return true
		}
	}
	return false
}
