package foryou

import (
	"fmt"
	"strconv"
	"strings"
)

// Server-side texts (ru/en). Clients may build their own from the typed
// reason fields instead.

func tr(lang, ru, en string) string {
	if lang == "ru" {
		return ru
	}
	return en
}

func quote(lang, s string) string {
	if lang == "ru" {
		return "«" + s + "»"
	}
	return "“" + s + "”"
}

// rowTitle localizes a row title.
func rowTitle(lang, kind string, r ReasonOut) string {
	switch kind {
	case RowTopPicks:
		return tr(lang, "Подобрано для вас", "Picked for you")
	case RowBecause:
		return tr(lang, "Потому что вам понравился ", "Because you liked ") + quote(lang, deref(r.MediaTitle))
	case RowDirector:
		return tr(lang, "Больше от режиссёра ", "More from director ") + deref(r.PersonName)
	case RowActor:
		return tr(lang, "С участием: ", "Starring ") + deref(r.PersonName)
	case RowGenre:
		return tr(lang, "Популярное в ваших жанрах", "Popular in your genres")
	case RowHiddenGems:
		return tr(lang, "Скрытые жемчужины", "Hidden gems")
	case RowDifferent:
		return tr(lang, "Что-то новенькое", "Something different")
	case RowTrending:
		return tr(lang, "В тренде для вас", "Trending for you")
	case RowRewatch:
		return tr(lang, "Пересмотреть любимое", "Rewatch your favorites")
	case RowAI:
		return deref(r.CollectionTitle)
	case RowTheme:
		return themeText(lang, r)
	case RowPopular:
		return tr(lang, "Популярное сейчас", "Popular right now")
	}
	return ""
}

// reasonText localizes an item/row reason.
func reasonText(lang string, r ReasonOut) string {
	switch r.Type {
	case ReasonBecause:
		return tr(lang, "Потому что вам понравился ", "Because you liked ") + quote(lang, deref(r.MediaTitle))
	case ReasonDirector:
		return tr(lang, "Режиссёр — ", "Directed by ") + deref(r.PersonName)
	case ReasonActor:
		return tr(lang, "В ролях — ", "Starring ") + deref(r.PersonName)
	case ReasonGenre:
		if len(r.GenreNames) == 0 {
			return tr(lang, "В вашем вкусе", "Up your alley")
		}
		return tr(lang, "Ваши жанры: ", "Your genres: ") + strings.Join(r.GenreNames, ", ")
	case ReasonHiddenGem:
		return tr(lang, "Скрытая жемчужина: высокий рейтинг, мало кто видел", "A hidden gem: highly rated, rarely seen")
	case ReasonDifferent:
		if len(r.GenreNames) == 0 {
			return tr(lang, "Что-то новенькое для вас", "Something different for you")
		}
		return tr(lang, "Что-то новенькое: ", "Something different: ") + strings.Join(r.GenreNames, ", ")
	case ReasonTrending:
		return tr(lang, "Сейчас в тренде и в вашем вкусе", "Trending and up your alley")
	case ReasonAI:
		return tr(lang, "Из подборки ", "From the collection ") + quote(lang, deref(r.CollectionTitle))
	case ReasonTheme:
		if r.KeywordName == nil {
			if len(r.GenreNames) == 0 {
				return tr(lang, "В вашем вкусе", "Up your alley")
			}
			return tr(lang, "Ваши жанры: ", "Your genres: ") + strings.Join(r.GenreNames, ", ")
		}
		return themeText(lang, r)
	case ReasonRewatch:
		return tr(lang, "Одно из ваших любимых", "One of your favorites")
	case ReasonPopular:
		return tr(lang, "Популярно сейчас", "Popular right now")
	case ReasonMood:
		if m := moodByKey(deref(r.Mood)); m != nil {
			return tr(lang, "Под настроение: ", "For the mood: ") + strings.ToLower(tr(lang, m.RU, m.EN))
		}
		return tr(lang, "Под настроение", "For the mood")
	}
	return ""
}

// themeText: «Вам нравятся фильмы про ограбления» when the keyword has a
// Russian name, else «Ваша тема: heist».
func themeText(lang string, r ReasonOut) string {
	name := deref(r.KeywordName)
	if lang == "ru" && r.KeywordLocalized {
		return "Вам нравятся фильмы про " + name
	}
	return tr(lang, "Ваша тема: ", "A theme you love: ") + name
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// genreNames are TMDB's movie + tv genres (fallback when the genres table
// has no name for the language yet).
var genreNames = map[int][2]string{
	28: {"боевик", "Action"}, 12: {"приключения", "Adventure"}, 16: {"мультфильм", "Animation"},
	35: {"комедия", "Comedy"}, 80: {"криминал", "Crime"}, 99: {"документальный", "Documentary"},
	18: {"драма", "Drama"}, 10751: {"семейный", "Family"}, 14: {"фэнтези", "Fantasy"},
	36: {"история", "History"}, 27: {"ужасы", "Horror"}, 10402: {"музыка", "Music"},
	9648: {"детектив", "Mystery"}, 10749: {"мелодрама", "Romance"}, 878: {"фантастика", "Science Fiction"},
	10770: {"телевизионный фильм", "TV Movie"}, 53: {"триллер", "Thriller"}, 10752: {"военный", "War"},
	37: {"вестерн", "Western"}, 10759: {"боевик и приключения", "Action & Adventure"},
	10762: {"детский", "Kids"}, 10763: {"новости", "News"}, 10764: {"реалити-шоу", "Reality"},
	10765: {"НФ и фэнтези", "Sci-Fi & Fantasy"}, 10766: {"мыльная опера", "Soap"},
	10767: {"ток-шоу", "Talk"}, 10768: {"война и политика", "War & Politics"},
}

func staticGenreName(lang string, id int) string {
	n, ok := genreNames[id]
	if !ok {
		return strconv.Itoa(id)
	}
	if lang == "ru" {
		return n[0]
	}
	return n[1]
}

var languageNames = map[string][2]string{
	"en": {"английский", "English"}, "ru": {"русский", "Russian"}, "fr": {"французский", "French"},
	"de": {"немецкий", "German"}, "it": {"итальянский", "Italian"}, "es": {"испанский", "Spanish"},
	"ja": {"японский", "Japanese"}, "ko": {"корейский", "Korean"}, "zh": {"китайский", "Chinese"},
	"cn": {"кантонский", "Cantonese"}, "hi": {"хинди", "Hindi"}, "sv": {"шведский", "Swedish"},
	"da": {"датский", "Danish"}, "no": {"норвежский", "Norwegian"}, "fi": {"финский", "Finnish"},
	"pl": {"польский", "Polish"}, "tr": {"турецкий", "Turkish"}, "pt": {"португальский", "Portuguese"},
	"uk": {"украинский", "Ukrainian"}, "fa": {"персидский", "Persian"}, "th": {"тайский", "Thai"},
	"nl": {"нидерландский", "Dutch"}, "cs": {"чешский", "Czech"}, "hu": {"венгерский", "Hungarian"},
	"el": {"греческий", "Greek"}, "he": {"иврит", "Hebrew"}, "ar": {"арабский", "Arabic"},
}

func languageName(lang, code string) string {
	if n, ok := languageNames[code]; ok {
		return tr(lang, n[0], n[1])
	}
	return code
}

// exploreLanguageTitle is the Explore tile title for a language.
var exploreLanguageTitles = map[string][2]string{
	"ko": {"Корейское кино", "Korean cinema"}, "ja": {"Японское кино", "Japanese cinema"},
	"fr": {"Французское кино", "French cinema"}, "it": {"Итальянское кино", "Italian cinema"},
	"es": {"Испаноязычное кино", "Spanish-language cinema"}, "de": {"Немецкое кино", "German cinema"},
	"ru": {"Русское кино", "Russian cinema"}, "en": {"Англоязычное кино", "English-language cinema"},
	"hi": {"Индийское кино", "Indian cinema"}, "zh": {"Китайское кино", "Chinese cinema"},
	"sv": {"Шведское кино", "Swedish cinema"}, "da": {"Датское кино", "Danish cinema"},
	"tr": {"Турецкое кино", "Turkish cinema"},
}

func exploreLanguageTitle(lang, code string) string {
	if n, ok := exploreLanguageTitles[code]; ok {
		return tr(lang, n[0], n[1])
	}
	return languageName(lang, code)
}

var countryNames = map[string][2]string{
	"US": {"США", "United States"}, "GB": {"Великобритания", "United Kingdom"}, "RU": {"Россия", "Russia"},
	"SU": {"СССР", "Soviet Union"}, "FR": {"Франция", "France"}, "DE": {"Германия", "Germany"},
	"IT": {"Италия", "Italy"}, "ES": {"Испания", "Spain"}, "JP": {"Япония", "Japan"},
	"KR": {"Южная Корея", "South Korea"}, "CN": {"Китай", "China"}, "HK": {"Гонконг", "Hong Kong"},
	"IN": {"Индия", "India"}, "CA": {"Канада", "Canada"}, "AU": {"Австралия", "Australia"},
	"SE": {"Швеция", "Sweden"}, "DK": {"Дания", "Denmark"}, "NO": {"Норвегия", "Norway"},
	"FI": {"Финляндия", "Finland"}, "PL": {"Польша", "Poland"}, "TR": {"Турция", "Turkey"},
	"MX": {"Мексика", "Mexico"}, "BR": {"Бразилия", "Brazil"}, "AR": {"Аргентина", "Argentina"},
	"NZ": {"Новая Зеландия", "New Zealand"}, "IE": {"Ирландия", "Ireland"}, "BE": {"Бельгия", "Belgium"},
	"NL": {"Нидерланды", "Netherlands"}, "UA": {"Украина", "Ukraine"}, "BY": {"Беларусь", "Belarus"},
	"KZ": {"Казахстан", "Kazakhstan"}, "IR": {"Иран", "Iran"}, "TH": {"Таиланд", "Thailand"},
	"CZ": {"Чехия", "Czechia"}, "HU": {"Венгрия", "Hungary"}, "AT": {"Австрия", "Austria"},
	"CH": {"Швейцария", "Switzerland"}, "IL": {"Израиль", "Israel"},
}

func countryName(lang, code string) string {
	if n, ok := countryNames[code]; ok {
		return tr(lang, n[0], n[1])
	}
	return code
}

func decadeName(lang string, decade int) string {
	if lang == "ru" {
		if decade >= 2000 {
			return strconv.Itoa(decade) + "-е"
		}
		return fmt.Sprintf("%02d-е", decade%100)
	}
	return strconv.Itoa(decade) + "s"
}
