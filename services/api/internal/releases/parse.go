package releases

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// Parsed is what Parse extracts from a release title. It is pure data: the
// title is never trusted, only scored against the requested media.
type Parsed struct {
	// Titles are the title candidates ("Матрица / The Matrix" → both).
	Titles []string
	// Parts are comma-separated sub-titles of multi-title candidates
	// ("Матрица, Матрица: Перезагрузка, …"); only used to detect packs.
	Parts []string
	// Years are all years in the metadata part (ranges contribute both ends).
	Years        []int
	YearRange    bool
	Resolution   string
	VideoCodec   string
	HDR          string
	DolbyVision  bool
	HDR10        bool
	TenBit       bool
	AudioCodecs  []string
	Languages    []string // ISO 639-1; "orig" = the media's original language
	ReleaseGroup string
	Source       string
	DiscImage    bool
	CamAudio     bool
	ThreeD       bool
	Upscale      bool
	Seasons      []int
	Episodes     []int
	EpisodeTotal int
	Collection   bool
	Movie        bool // "Фильм первый", "The Movie": a film within a series franchise
	Complete     bool // "Все сезоны", "Complete Series": every season
	NonVideo     bool
	Extras       bool
	NoRussian    bool
	Country      string // explicit version marker: "us" or "gb"
}

// IsPack reports whether the release holds more than one episode.
func (p *Parsed) IsPack() bool {
	return len(p.Seasons) > 0 && (len(p.Episodes) != 1 || len(p.Seasons) > 1)
}

var (
	spaceRe = regexp.MustCompile(`\s+`)
	// Cyrillic look-alikes inside technical tokens: 1080р, 08х01.
	cyrPRe = regexp.MustCompile(`(\d)р`)
	cyrXRe = regexp.MustCompile(`(\d)[хХ](\d)`)

	yearParenRe = regexp.MustCompile(`\((?:19|20)\d{2}`)
	yearSlashRe = regexp.MustCompile(`/\s*(?:19|20)\d{2}(?:\s*[-–]\s*(?:19|20)\d{2})?\s*(?:/|$)`)
	parenRe     = regexp.MustCompile(`\([^()]*\)`)
	year4Re     = regexp.MustCompile(`(?:19|20)\d{2}`)
	yearRe      = regexp.MustCompile(`(?:^|[^\d.xх])((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?(?:$|[^\dpрixх])`)

	// Season/episode notations seen on RuTracker, RuTor, NNM, BigFANGroup,
	// ExKinoRay and in scene names.
	seRangeRe   = regexp.MustCompile(`(?i)\bS(\d{1,2})\s*-\s*S?(\d{1,2})\s*E(\d{1,4})(?:\s*-\s*E?(\d{1,4}))?`)
	seRe        = regexp.MustCompile(`(?i)\bS(\d{1,3})\s*E(\d{1,4})(?:\s*-\s*(?:S\d{1,3})?E?(\d{1,4}))?`)
	sOnlyRe     = regexp.MustCompile(`(?i)\bS(\d{1,2})(?:\s*-\s*S?(\d{1,2}))?\b`)
	seasonWord  = regexp.MustCompile(`(?i)(?:сезон[ыау]?|seasons?)\s*[:№#]?\s*(\d{1,2})(?:\s*(?:-|–|по)\s*(\d{1,2}))?`)
	seasonWord2 = regexp.MustCompile(`(?i)(?:^|[^\d])(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*(?:-?(?:й|ый|ой|ий))?\s*(?:сезон|season)`)
	xRe         = regexp.MustCompile(`(?i)(?:^|[\s\[(])(\d{1,2})x(\d{2,3})(?:\s*-\s*(?:\d{1,2}x)?(\d{2,3}))?(?:$|[\s\])])`)
	tvSeasonRe  = regexp.MustCompile(`(?:^|[\s\[(])(?:TV|ТВ)-(\d{1,2})(?:$|[\s\]),])`)
	specialRe   = regexp.MustCompile(`(?i)\b(?:OVA|OAD|ONA)\b|спешл|спецвыпуск|\bspecials?\b`)
	epCountRe   = regexp.MustCompile(`(?i)(?:^|[\s\[(,])(\d{1,4})\s*(?:эп\.|эп\b|эпизод(?:ов|а)?\b|episodes\b)`)
	epOfOnlyRe  = regexp.MustCompile(`(?i)(?:^|[\s\[(,])(\d{1,4})\s*из\s*(\d{1,4})(?:$|[\s\]),])`)
	epBracketRe = regexp.MustCompile(`\[(\d{1,3})\s*-\s*(\d{1,3})\]`)
	movieRe     = regexp.MustCompile(`(?i)\bthe movie\b|\bфильм (?:первый|второй|третий|\d)|полнометражн|\bmovie\b|\bфильм\s*$`)
	epOfRe      = regexp.MustCompile(`(?i)\bE(\d{1,4})(?:\s*-\s*(\d{1,4}))?\s*(?:of|из)\s*(\d{1,4}|\?)`)
	epWordRe    = regexp.MustCompile(`(?i)(?:серии|серия|серий|эпизоды|эпизод|episodes?)\s*:?\s*(\d{1,4})(?:\s*-\s*(\d{1,4}))?(?:\s*(?:из|of)\s*(\d{1,4}|\?))?`)
	epRangeOfRe = regexp.MustCompile(`(?i)(?:^|[\s\[(,/])(\d{1,4})\s*-\s*(\d{1,4})\s*(?:из|of)\s*(\d{1,4}|\?)`)
	totalRe     = regexp.MustCompile(`(?i)(?:из|of)\s*(\d{1,4})`)

	// Cut points for title candidates: the first season/quality token.
	cutRe = regexp.MustCompile(`(?i)(?:^|[\s,.\-–(\[/])(?:S\d{1,2}(?:\s*-\s*S?\d{1,2})?(?:E\d{1,4})?\b|E\d{1,4}(?:\s*-\s*\d{1,4})?\s*(?:of|из)\b|сезон|season\b|\d{1,2}\s*сезон|серии\b|(?:BD|UHD\s*BD|HD)?Remux\b|BDRip|BRRip|WEB-?DL|WEB-?Rip|HDTV|HDRip|DVDRip|DVD\d|Blu-?Ray|BR-?DISK|CAMRip|TS-?Rip|SATRip|\d{3,4}[pр]\b|4K\b|UHD\b|HEVC\b|[xh]\.?26[45]\b)`)
)

type pattern struct {
	re  *regexp.Regexp
	val string
}

func pat(expr, val string) pattern { return pattern{regexp.MustCompile(expr), val} }

var (
	camPatterns = []pattern{
		pat(`(?i)\b(?:CAMRip|HDCAM|CAM)\b`, "cam"),
		pat(`(?i)\b(?:TS-?Rip|HDTS|TS|TeleSync|PDVD|TC|TeleCine|HDTC)\b`, "telesync"),
		pat(`(?i)\b(?:DVDScr|BDScr|Screener|SCR)\b`, "screener"),
	}
	camAudioRe     = regexp.MustCompile(`(?i)звук\s+с\s+(?:TS|CAM|CAMRip|экрана)`)
	remuxRe        = regexp.MustCompile(`(?i)remux`)
	discRe         = regexp.MustCompile(`(?i)\b(?:BR-?DISK|BDMV|BD(?:25|50|66|100)|Blu-?ray\s*Disc|ISO)\b`)
	blurayRe       = regexp.MustCompile(`(?i)\bBlu-?Ray\b`)
	dvdDiscRe      = regexp.MustCompile(`(?i)(?:\b|\d\s*x\s*)DVD-?(?:5|9|10|R)\b|\bVIDEO_TS\b|\bDVD\b`)
	sourcePatterns = []pattern{
		pat(`(?i)\b(?:BDRip|BRRip|BD-?Rip|HD-?DVDRip|HDRip|HybridRip|Hybrid|UHD-?Rip|35mm)`, "bdrip"),
		pat(`(?i)\bWEB-?DL|\bWEB\b|\biTunes\b|\bAMZN\b|\bNF\b`, "web-dl"),
		pat(`(?i)\bWEB-?Rip`, "webrip"),
		pat(`(?i)\b(?:HDTV|HDTVRip|SATRip|DVB|TVRip|IPTV|PDTV|DTV|SAT)`, "hdtv"),
		pat(`(?i)\b(?:DVDRip|DVD-Rip|VHSRip|VHS|LDRip)`, "dvd"),
	}
	resPatterns = []pattern{
		pat(`(?i)(?:\b2160[pi]|\b4K\b|\bUHD\b|3840x2160)`, "2160p"),
		pat(`(?i)(?:\b1080[pi]|\bFHD\b|1920x\d{3,4})`, "1080p"),
		pat(`(?i)(?:\b720p|1280x\d{3})`, "720p"),
		pat(`(?i)\b576[pi]\b`, "576p"),
		pat(`(?i)(?:\b(?:480|400|360)p\b|\bSD\b)`, "480p"),
	}
	codecPatterns = []pattern{
		pat(`(?i)(?:\bHEVC\b|\b[xh]\.?265\b|-HEVC)`, "hevc"),
		pat(`(?i)\bAV1\b`, "av1"),
		pat(`(?i)(?:\bAVC\b|\b[xh]\.?264\b|-AVC)`, "h264"),
		pat(`(?i)\b(?:XviD|DivX)\b`, "xvid"),
		pat(`(?i)\bMPEG-?2\b`, "mpeg2"),
	}
	audioPatterns = []pattern{
		pat(`(?i)\bTrue-?HD\b`, "truehd"),
		pat(`(?i)\bDTS(?:-?HD|-?X|:X)?\b`, "dts"),
		pat(`(?i)(?:\bE-?AC-?3\b|\bDD\+|\bDDP(?:\d|\b)|Dolby\s*Digital\s*Plus)`, "eac3"),
		pat(`(?i)(?:\bAC-?3\b|\bDD\s?[257]\.[01]\b|Dolby\s*Digital\b)`, "ac3"),
		pat(`(?i)\bAAC\b`, "aac"),
		pat(`(?i)\bFLAC\b`, "flac"),
		pat(`(?i)\bMP3\b`, "mp3"),
		pat(`(?i)\bOpus\b`, "opus"),
		pat(`(?i)\bL?PCM\b`, "pcm"),
	}
	dvRe       = regexp.MustCompile(`(?i)(?:Dolby\s*Vision|\bDoVi\b|\bDV\b)`)
	hdr10pRe   = regexp.MustCompile(`(?i)HDR10\s*(?:\+|Plus)`)
	hdr10Re    = regexp.MustCompile(`(?i)\bHDR(?:10)?\b`)
	hlgRe      = regexp.MustCompile(`(?i)\bHLG\b`)
	tenBitRe   = regexp.MustCompile(`(?i)(?:10[- ]?bit|\bHi10P?\b)`)
	threeDRe   = regexp.MustCompile(`(?i)\b3D\b|Half[- ]?(?:OU|SBS)|\bSBS\b`)
	upscaleRe  = regexp.MustCompile(`(?i)upscale|\bAI\b`)
	groupOtRe  = regexp.MustCompile(`\sот\s+([^|\[\](),]+?)\s*(?:$|\||-\s*[А-ЯЁ]|\[|\()`)
	groupDash  = regexp.MustCompile(`\s-\s([A-Za-z0-9][A-Za-z0-9 .&_-]{1,30})$`)
	sceneGroup = regexp.MustCompile(`-([A-Za-z0-9]{2,20})$`)

	langPatterns = []pattern{
		pat(`(?i)(?:\bDub\b|\bMVO\b|\bDVO\b|\bAVO\b|\bVO\b|\bRus\b|Дубляж|Дублир|Многоголос|Двухголос|Одноголос|Авторск|Профессиональн|Любительск|Лицензи|Гоблин|Гаврилов|Пучков|Володарск|Михал[её]в|Живов|Кравец|Kravec|LostFilm|Amedia|AlexFilm|NewStudio|HDrezka|Кубик в кубе|Kubik|Novamedia|Jaskier|TVShows|Пифагор|Первый канал|РенТВ|Рен ТВ|ОРТ|НТВ|СТС|Netflix\s*\(Rus|Red Head Sound|Невафильм|Пирамида|Мосфильм|iTunes\)|Яроцкий|Сербин|Карцев|Есарев)`, "ru"),
		pat(`(?i)(?:\bEng\b|\bEnglish\b|Английск)`, "en"),
		pat(`(?i)(?:\bUkr\b|\bUA\b|Укр|Ukrainian)`, "uk"),
		pat(`(?i)(?:\bJap\b|\bJpn\b|Японск)`, "ja"),
		pat(`(?i)(?:\bKor\b|Корейск)`, "ko"),
		pat(`(?i)(?:\bOriginal\b|Оригинал)`, "orig"),
	}
	rutorCodes = regexp.MustCompile(`(?:^|[|,\s])(?:D|P|P1|P2|L|L1|L2|A)(?:$|[|,\s-])`)
	noRusRe    = regexp.MustCompile(`(?i)без перевода|no\s*rus|\[Original\]`)

	extrasRe    = regexp.MustCompile(`(?i)фильм о фильме|дополнительные материалы|доп\.?\s*материалы|бонус|\bextras?\b|making[- ]of|behind the scenes|featurette|трейлер|\btrailer\b|викторина|квизиум|пародия|смешной перевод`)
	nonVideoRe  = regexp.MustCompile(`(?i)\bEPUB\b|\bFB2\b|\bPDF\b|\bDJVU\b|аудиокниг|audiobook|публицистика|\bPC\b|\bРС\b|re-?pack|steam-?rip|\bGOG\b|\[DLC?\]|nintendo|\bPS[2345]\b|xbox|\bNSZ\b|русификатор|\bAEP\b|videohive|\bportable\b|\bx86\b|\bx64\b`)
	audioOnlyRe = regexp.MustCompile(`(?i)\bOST\b|soundtrack|саундтрек|\bFLAC\b|\bMP3\b|\bAPE\b|lossless|\bkbps\b|\bVA\s*-|music inspired|\bсборник\b`)
	countryRe   = []pattern{
		pat(`(?i)\(UK\)|британская версия|\bUK version`, "gb"),
		pat(`(?i)\(US\)|американская версия|/\s*US\b|\bUS version`, "us"),
	}
	dvdRipRe      = regexp.MustCompile(`(?i)DVDRip|DVD-Rip|DVDScr`)
	toDVDRe       = regexp.MustCompile(`(?i)>\s*\d?\s*x?\s*DVD`)
	completeRe    = regexp.MustCompile(`(?i)все сезоны|полный сериал|complete series|all seasons`)
	strongAudioRe = regexp.MustCompile(`(?i)\blossless\b|tracks\s*\+?\s*\.?cue|\bkbps\b|^\((?:OST|Score|Soundtrack|ambient)\)`)
	leadNoiseRe   = regexp.MustCompile(`(?i)^(?:OST|VA|V\.A\.)\s*-`)
	sceneTechRe   = regexp.MustCompile(`(?i)^(S\d{1,2}(E\d+)?|\d{1,2}x\d{2,3})$`)
	yearTokRe     = regexp.MustCompile(`^(19|20)\d{2}$`)
	technicalRe   = regexp.MustCompile(`(?i)^(?:AVC|HEVC|DL|Rip|LQ|HDR|SDR|\d+p|x26[45]|h26[45]|DTS|AC3|AAC|WEB|4K)$`)
	listSepRe     = regexp.MustCompile(`,\s+|\s+(?:и|&|\+|and)\s+`)
	threeDTitleRe = regexp.MustCompile(`(?i)\s+(?:в\s+)?3[DД](?:\s|$)`)
	collectionRe  = regexp.MustCompile(`(?i)трилоги|дилоги|тетралоги|квадрилоги|квадрологи|пенталоги|гексалоги|антологи|коллекци|\btrilogy\b|\bduology\b|\bquadrilogy\b|\banthology\b|\bcollection\b|все части|\bчасти\s*\d+\s*-\s*\d+`)
)

// Parse extracts structured data from a release title.
func Parse(title string) Parsed {
	var p Parsed
	s := cleanTitle(title)
	tech := cyrXRe.ReplaceAllString(cyrPRe.ReplaceAllString(s, "${1}p"), "${1}x${2}")

	var head, tail string
	if isScene(s) {
		head, tail = splitScene(tech)
		tech = strings.NewReplacer(".", " ", "_", " ").Replace(tech)
		if m := sceneGroup.FindStringSubmatch(strings.TrimSpace(s)); m != nil && !looksTechnical(m[1]) {
			p.ReleaseGroup = m[1]
		}
		p.Titles = []string{head}
	} else {
		head, tail = splitHead(s)
		p.Titles, p.Parts = titleCandidates(head, s)
	}
	p.Years, p.YearRange = parseYears(tail)
	p.Collection = collectionRe.MatchString(strings.ToLower(s))
	if !p.Collection && !p.YearRange {
		p.Parts = nil // "О, где же ты, брат?" is one title, not a list
	}

	parseEpisodes(&p, tech)
	parseQuality(&p, tech, isScene(s))
	parseLanguages(&p, tail, s)
	if p.ReleaseGroup == "" {
		p.ReleaseGroup = parseGroup(s)
	}

	p.Extras = extrasRe.MatchString(s)
	p.Movie = movieRe.MatchString(s)
	p.Complete = completeRe.MatchString(s)
	hasVideo := p.Source != "" || p.Resolution != "" || p.VideoCodec != ""
	// "Аватар / Avatar (2009) AC3 5.1 [Solod]" is a separate audio track.
	audioTrack := !hasVideo && len(p.AudioCodecs) > 0
	p.NonVideo = audioTrack || strongAudioRe.MatchString(s) || nonVideoRe.MatchString(tail) || nonVideoRe.MatchString(head) && !hasVideo ||
		(!hasVideo && audioOnlyRe.MatchString(s)) || leadNoiseRe.MatchString(s)
	for _, c := range countryRe {
		if c.re.MatchString(s) {
			p.Country = c.val
			break
		}
	}
	return p
}

func cleanTitle(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r == ' ':
			return ' '
		case unicode.IsControl(r):
			return ' '
		case r > 0xFFFF || unicode.Is(unicode.So, r):
			return -1 // emoji such as 📌
		}
		return r
	}, s)
	s = strings.TrimSpace(spaceRe.ReplaceAllString(s, " "))
	return s
}

// isScene detects dotted scene names: The.Matrix.1999.2160p.UHD.BluRay…
func isScene(s string) bool {
	return !strings.Contains(s, " ") && (strings.Count(s, ".") >= 2 || strings.Count(s, "_") >= 2)
}

// splitScene returns the title words (before the year/season/quality
// token) and the rest. The year that ends the title is the last year-like
// token before the first quality token, so "Blade.Runner.2049.2017…" keeps
// 2049 in the title.
func splitScene(s string) (string, string) {
	toks := strings.FieldsFunc(s, func(r rune) bool { return r == '.' || r == '_' || r == ' ' })
	firstTech := len(toks)
	for i, t := range toks {
		if i > 0 && (cutRe.MatchString(" "+t) || sceneTechRe.MatchString(t)) {
			firstTech = i
			break
		}
	}
	cut := firstTech
	for i := firstTech - 1; i > 0; i-- {
		if yearTokRe.MatchString(toks[i]) {
			cut = i
			break
		}
	}
	return strings.Join(toks[:cut], " "), strings.Join(toks[cut:], " ")
}

// splitHead separates the title part from the metadata of tracker-style
// names: the title ends at the first "[" or "|" or "(year".
func splitHead(s string) (string, string) {
	end := len(s)
	if i := strings.IndexAny(s, "[|"); i >= 0 {
		end = i
	}
	for _, re := range []*regexp.Regexp{yearParenRe, yearSlashRe} {
		if loc := re.FindStringIndex(s); loc != nil && loc[0] < end {
			end = loc[0]
		}
	}
	// "Матрица / The Matrix HDRip 1080p" (no brackets): cut at the first
	// quality token, unless a "/" follows (then candidates are cut one by one,
	// e.g. "Офис - S4 (полный) / The Office - Season 4").
	if loc := cutRe.FindStringIndex(s[:end]); loc != nil && loc[0] > 0 && !strings.Contains(s[loc[0]:end], "/") {
		end = loc[0]
	}
	if end == 0 { // "[DL] Game …", "[S01] …"
		if j := strings.IndexAny(s, "]"); j > 0 && j+1 < len(s) {
			return splitHead(strings.TrimSpace(s[j+1:]))
		}
	}
	return s[:end], s[end:]
}

var langCodeTok = map[string]bool{"ru": true, "en": true, "eng": true, "rus": true, "ukr": true, "multi": true, "sub": true}

// titleCandidates splits the head on "/" and adds ExKinoRay-style pipe
// segments ("Игра престолов (S8E1-6 of 6) | Game of Thrones | 2019 | …").
func titleCandidates(head, full string) (titles, parts []string) {
	add := func(t string) {
		t = cleanCandidate(t)
		if len([]rune(t)) < 2 || langCodeTok[strings.ToLower(t)] {
			return
		}
		for _, x := range titles {
			if strings.EqualFold(x, t) {
				return
			}
		}
		titles = append(titles, t)
		if listSepRe.MatchString(t) {
			for _, part := range listSepRe.Split(t, -1) {
				if part = cleanCandidate(part); len([]rune(part)) >= 2 {
					parts = append(parts, part)
				}
			}
		}
	}
	for _, seg := range splitOutsideParens(head, '/') {
		// Parenthesized alternatives: "Эксперимент «Офис» (Эксперимент Белко)".
		for _, m := range parenRe.FindAllString(seg, -1) {
			inner := strings.Trim(m, "()")
			// Two+ words, no digits or slashes: an alternative title, not
			// "(полный)" or "(Дэвид Наттер / David Nutter)".
			if !strings.ContainsAny(inner, "0123456789/") && hasLetters(inner) && len(strings.Fields(inner)) >= 2 {
				add(inner)
			}
		}
		add(parenRe.ReplaceAllString(seg, " "))
	}
	if strings.Contains(full, "|") {
		segs := strings.Split(full, "|")
		if !yearRe.MatchString(segs[0]) && !strings.Contains(segs[0], "[") {
			for _, seg := range segs[1:] {
				seg = strings.TrimSpace(seg)
				if yearRe.MatchString(seg) || cutRe.MatchString(" "+seg) || !hasLetters(seg) {
					break
				}
				add(seg)
			}
		}
	}
	return titles, parts
}

// splitOutsideParens splits on sep except inside (...) and «...».
func splitOutsideParens(s string, sep rune) []string {
	var out []string
	depth, start := 0, 0
	for i, r := range s {
		switch {
		case r == '(' || r == '«':
			depth++
		case (r == ')' || r == '»') && depth > 0:
			depth--
		case r == sep && depth == 0:
			out = append(out, s[start:i])
			start = i + len(string(r))
		}
	}
	return append(out, s[start:])
}

func hasLetters(s string) bool {
	return strings.IndexFunc(s, unicode.IsLetter) >= 0
}

func cleanCandidate(t string) string {
	t = parenRe.ReplaceAllString(t, " ")
	t = threeDTitleRe.ReplaceAllString(t, " ")
	if loc := cutRe.FindStringIndex(t); loc != nil {
		if strings.TrimSpace(t[:loc[0]]) == "" {
			return "" // "Сезон 8, серии 1-6 из 6", "S1E1-6 of 6"
		}
		t = t[:loc[0]]
	}
	t = strings.TrimSpace(spaceRe.ReplaceAllString(t, " "))
	t = strings.TrimRight(t, " ,.-–—:;(")
	t = strings.TrimLeft(t, " ,.-–—:;)")
	// "OST - Игра престолов" keeps the title for matching; NonVideo rejects it.
	return strings.TrimSpace(t)
}

func parseYears(tail string) ([]int, bool) {
	maxYear := time.Now().Year() + 2
	var years []int
	isRange := false
	locs := year4Re.FindAllStringIndex(tail, -1)
	ok := func(loc []int) bool {
		if loc[0] > 0 {
			if c := tail[loc[0]-1]; c >= '0' && c <= '9' || c == '.' || c == 'x' {
				return false
			}
		}
		if loc[1] < len(tail) {
			r := []rune(tail[loc[1]:])[0]
			if unicode.IsDigit(r) || unicode.IsLetter(r) {
				return false // 2160p, 1080i, 1920x1080, 2000s
			}
		}
		return true
	}
	prevEnd, prevYear := -1, 0
	for _, loc := range locs {
		if !ok(loc) {
			continue
		}
		y := atoi(tail[loc[0]:loc[1]])
		if y < 1900 || y > maxYear {
			continue
		}
		if prevEnd >= 0 && y > prevYear && strings.TrimSpace(tail[prevEnd:loc[0]]) != "" &&
			strings.Trim(tail[prevEnd:loc[0]], " -–—") == "" {
			isRange = true
		}
		years = append(years, y)
		prevEnd, prevYear = loc[1], y
	}
	slices.Sort(years)
	years = slices.Compact(years)
	if len(years) > 1 {
		isRange = true
	}
	return years, isRange
}

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

func span(a, b int, limit int) []int {
	if b < a {
		b = a
	}
	if b-a >= limit {
		b = a + limit - 1
	}
	out := make([]int, 0, b-a+1)
	for i := a; i <= b; i++ {
		out = append(out, i)
	}
	return out
}

func parseEpisodes(p *Parsed, s string) {
	const maxEp = 2000
	setSeasons := func(a, b string) {
		if len(p.Seasons) > 0 {
			return
		}
		x := atoi(a)
		y := x
		if b != "" {
			y = atoi(b)
		}
		if x > 100 || y > 100 || y < x {
			return
		}
		p.Seasons = span(x, y, 100)
	}
	setEpisodes := func(a, b, total string) {
		if len(p.Episodes) == 0 && a != "" {
			x := atoi(a)
			y := x
			if b != "" {
				y = atoi(b)
			}
			if x > 0 && y >= x && y <= 5000 {
				p.Episodes = span(x, y, maxEp)
			}
		}
		if total != "" && total != "?" && p.EpisodeTotal == 0 {
			p.EpisodeTotal = atoi(total)
		}
	}
	if m := seRangeRe.FindStringSubmatch(s); m != nil {
		setSeasons(m[1], m[2])
		setEpisodes(m[3], m[4], "")
	}
	if m := seRe.FindStringSubmatch(s); m != nil {
		setSeasons(m[1], "")
		setEpisodes(m[2], m[3], "")
	}
	if m := xRe.FindStringSubmatch(s); m != nil {
		setSeasons(m[1], "")
		setEpisodes(m[2], m[3], "")
	}
	if m := seasonWord.FindStringSubmatch(s); m != nil {
		setSeasons(m[1], m[2])
	}
	if m := seasonWord2.FindStringSubmatch(s); m != nil {
		setSeasons(m[1], m[2])
	}
	if m := sOnlyRe.FindStringSubmatch(s); m != nil {
		setSeasons(m[1], m[2])
	}
	if m := tvSeasonRe.FindStringSubmatch(s); m != nil {
		setSeasons(m[1], "")
	}
	if m := epOfRe.FindStringSubmatch(s); m != nil {
		setEpisodes(m[1], m[2], m[3])
	}
	if m := epWordRe.FindStringSubmatch(s); m != nil {
		setEpisodes(m[1], m[2], m[3])
	}
	if m := epRangeOfRe.FindStringSubmatch(s); m != nil {
		setEpisodes(m[1], m[2], m[3])
	}
	if m := epOfOnlyRe.FindStringSubmatch(s); m != nil && len(p.Episodes) == 0 {
		if a, b := atoi(m[1]), atoi(m[2]); a > 0 && a <= b {
			setEpisodes("1", m[1], m[2]) // "[2013, TV, 25 из 25]"
		}
	}
	if m := epCountRe.FindStringSubmatch(s); m != nil && len(p.Episodes) == 0 {
		setEpisodes("1", m[1], m[1]) // "25 эп."
	}
	if m := epBracketRe.FindStringSubmatch(s); m != nil && len(p.Episodes) == 0 {
		setEpisodes(m[1], m[2], "") // "[1-10]"
	}
	if len(p.Seasons) == 0 && specialRe.MatchString(s) {
		p.Seasons = []int{0} // OVA / specials
	}
	if p.EpisodeTotal == 0 && len(p.Episodes) > 0 {
		if m := totalRe.FindStringSubmatch(s); m != nil {
			p.EpisodeTotal = atoi(m[1])
		}
	}
}

func firstMatch(s string, ps []pattern) string {
	best, at := "", -1
	for _, pt := range ps {
		if loc := pt.re.FindStringIndex(s); loc != nil && (at < 0 || loc[0] < at) {
			best, at = pt.val, loc[0]
		}
	}
	return best
}

func parseQuality(p *Parsed, s string, scene bool) {
	for _, c := range camPatterns {
		if c.re.MatchString(s) {
			p.Source = c.val
			break
		}
	}
	p.CamAudio = camAudioRe.MatchString(s)
	if p.Source == "" {
		switch {
		case remuxRe.MatchString(s):
			p.Source = "remux"
		case discRe.MatchString(s):
			p.Source, p.DiscImage = "bluray", true
		}
	}
	if p.Source == "" {
		p.Source = firstMatch(s, sourcePatterns)
	}
	if p.Source == "" && blurayRe.MatchString(s) {
		// Scene "BluRay.x264" is an encode; a tracker "Blu-Ray CEE 1080p" is a disc.
		if scene {
			p.Source = "bdrip"
		} else {
			p.Source, p.DiscImage = "bluray", true
		}
	}
	if dvdDiscRe.MatchString(s) && !dvdRipRe.MatchString(s) {
		if p.Source == "" || p.Source == "bluray" || p.Source == "dvd" || toDVDRe.MatchString(s) {
			p.Source, p.DiscImage = "dvd", true
		}
	}

	p.Resolution = firstMatch(s, resPatterns)
	p.VideoCodec = firstMatch(s, codecPatterns)
	p.TenBit = tenBitRe.MatchString(s)
	p.DolbyVision = dvRe.MatchString(s)
	p.HDR10 = hdr10Re.MatchString(s) || hdr10pRe.MatchString(s)
	switch {
	case p.DolbyVision:
		p.HDR = "dolby_vision"
	case hdr10pRe.MatchString(s):
		p.HDR = "hdr10plus"
	case p.HDR10:
		p.HDR = "hdr10"
	case hlgRe.MatchString(s):
		p.HDR = "hlg"
	}
	p.AudioCodecs = []string{}
	for _, a := range audioPatterns {
		if a.re.MatchString(s) && !slices.Contains(p.AudioCodecs, a.val) {
			p.AudioCodecs = append(p.AudioCodecs, a.val)
		}
	}
	p.ThreeD = threeDRe.MatchString(s)
	p.Upscale = upscaleRe.MatchString(s)
}

func parseLanguages(p *Parsed, tail, full string) {
	p.Languages = []string{}
	add := func(l string) {
		if !slices.Contains(p.Languages, l) {
			p.Languages = append(p.Languages, l)
		}
	}
	for _, l := range langPatterns {
		if l.re.MatchString(tail) {
			add(l.val)
		}
	}
	// RuTor translation codes after "|": D (dub), P (multi-voice), L (amateur), A (author).
	if i := strings.Index(tail, "|"); i >= 0 && rutorCodes.MatchString(tail[i:]) {
		add("ru")
	}
	p.NoRussian = noRusRe.MatchString(full)
	// Russian trackers' Cyrillic-titled releases carry Russian audio unless
	// marked otherwise (Prowlarr's RuTracker definition often strips the
	// "Dub"/"MVO" part, leaving "+ Original Eng").
	if !p.NoRussian && !slices.Contains(p.Languages, "ru") {
		for _, t := range p.Titles {
			if hasCyrillic(t) {
				add("ru")
				break
			}
		}
	}
	if p.NoRussian {
		p.Languages = slices.DeleteFunc(p.Languages, func(l string) bool { return l == "ru" })
	}
	if len(p.Languages) == 0 && !hasCyrillic(full) {
		add("orig") // scene release: original audio
	}
}

func parseGroup(s string) string {
	if m := groupOtRe.FindStringSubmatch(s + " "); m != nil {
		return strings.TrimSpace(m[1])
	}
	if strings.Contains(s, "|") {
		if m := groupDash.FindStringSubmatch(s); m != nil && !looksTechnical(m[1]) {
			return strings.TrimSpace(m[1])
		}
	}
	return ""
}

func looksTechnical(t string) bool {
	return technicalRe.MatchString(t)
}
