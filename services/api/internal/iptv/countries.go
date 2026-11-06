package iptv

// Country is an iptv-org playlist preset (<base>/countries/<code>.m3u).
type Country struct {
	Code      string `json:"code"`
	NameEn    string `json:"name_en"`
	NameRu    string `json:"name_ru"`
	Suggested bool   `json:"suggested"`
	// Guides are the default XMLTV guides, in merge priority (presetGuides).
	Guides []string `json:"guides"`
}

// Countries are the presets offered in the admin picker: the household's
// region first (suggested), then neighbours and large broadcasters.
var Countries = []Country{
	{"ru", "Russia", "Россия", true, nil},
	{"kz", "Kazakhstan", "Казахстан", true, nil},
	{"ua", "Ukraine", "Украина", true, nil},
	{"by", "Belarus", "Беларусь", true, nil},
	{"int", "International", "Международные", true, nil},
	{"am", "Armenia", "Армения", false, nil},
	{"az", "Azerbaijan", "Азербайджан", false, nil},
	{"ge", "Georgia", "Грузия", false, nil},
	{"kg", "Kyrgyzstan", "Киргизия", false, nil},
	{"uz", "Uzbekistan", "Узбекистан", false, nil},
	{"tj", "Tajikistan", "Таджикистан", false, nil},
	{"md", "Moldova", "Молдова", false, nil},
	{"lv", "Latvia", "Латвия", false, nil},
	{"lt", "Lithuania", "Литва", false, nil},
	{"ee", "Estonia", "Эстония", false, nil},
	{"il", "Israel", "Израиль", false, nil},
	{"tr", "Turkey", "Турция", false, nil},
	{"de", "Germany", "Германия", false, nil},
	{"fr", "France", "Франция", false, nil},
	{"it", "Italy", "Италия", false, nil},
	{"es", "Spain", "Испания", false, nil},
	{"pl", "Poland", "Польша", false, nil},
	{"rs", "Serbia", "Сербия", false, nil},
	{"cz", "Czechia", "Чехия", false, nil},
	{"uk", "United Kingdom", "Великобритания", false, nil},
	{"us", "United States", "США", false, nil},
	{"cn", "China", "Китай", false, nil},
	{"jp", "Japan", "Япония", false, nil},
	{"kr", "South Korea", "Южная Корея", false, nil},
	{"in", "India", "Индия", false, nil},
}

func countryByCode(code string) (Country, bool) {
	for _, c := range Countries {
		if c.Code == code {
			c.Guides = presetGuides(code)
			return c, true
		}
	}
	return Country{}, false
}

// Free XMLTV guides reachable from the server (checked 2026-10-29 from the
// production host, see docs/architecture.md "IPTV"). Ranked for Russian /
// Kazakh / international iptv-org lists by measured coverage:
//   - iptvx.one lite: 18 MB, 4 345 channels (same channels as the 85 MB full
//     file, same dates), ru 61 % · kz 67 % · int 12 %
//   - epg.pw RU: 7.7 MB, 4 089 channels, adds +10 % ru (no KZ file exists)
//   - epg.it999.ru (→ ru.epg.one): 47 MB, slow (1.5 MB/s), adds +6 % ru
//   - epgshare01 ALL_SOURCES: 203 MB, 28 500 channels worldwide, int 17 %
//     (27 % merged with iptvx + epg.pw lite); per-country files for the rest.
const (
	guideIPTVX    = "https://iptvx.one/epg/epg_lite.xml.gz"
	guideEPGPWRU  = "https://epg.pw/xmltv/epg_RU.xml.gz"
	guideIT999    = "http://epg.it999.ru/epg.xml.gz"
	guideEPGShare = "https://epgshare01.online/epgshare01/epg_ripper_"
	guideEPGPW    = "https://epg.pw/xmltv/epg_"
)

// epg.pw / epgshare01 per-country files that exist (checked 2026-10-29).
var (
	epgpwCountries    = map[string]string{"de": "DE", "fr": "FR", "es": "ES", "uk": "GB", "us": "US", "cn": "CN", "jp": "JP", "kr": "KR", "in": "IN"}
	epgshareCountries = map[string]string{"ua": "UA1", "lv": "LV1", "lt": "LT1", "il": "IL1", "tr": "TR1", "de": "DE1", "fr": "FR1",
		"it": "IT1", "es": "ES1", "pl": "PL1", "rs": "RS1", "cz": "CZ1", "uk": "UK1", "us": "US2", "jp": "JP1", "kr": "KR1", "in": "IN1"}
	russianSpeaking = map[string]bool{"ru": true, "kz": true, "by": true, "ua": true, "am": true, "az": true, "ge": true, "kg": true,
		"uz": true, "tj": true, "md": true, "ee": true, "lv": true, "lt": true, "il": true}
)

// presetGuides is the default guide list of an iptv-org country preset,
// first match wins per channel.
func presetGuides(code string) []string {
	var out []string
	if f, ok := epgshareCountries[code]; ok {
		out = append(out, guideEPGShare+f+".xml.gz")
	}
	switch {
	case code == "int":
		out = append(out, guideEPGShare+"ALL_SOURCES1.xml.gz", guideIPTVX, "https://epg.pw/xmltv/epg_lite.xml.gz")
	case code == "ru" || code == "kz" || code == "by":
		out = append(out, guideIPTVX, guideEPGPWRU, guideIT999)
	case russianSpeaking[code]:
		out = append(out, guideIPTVX, guideEPGPWRU)
	}
	if c, ok := epgpwCountries[code]; ok {
		out = append(out, guideEPGPW+c+".xml.gz")
	}
	if len(out) == 0 {
		out = append(out, guideIPTVX)
	}
	return out
}
