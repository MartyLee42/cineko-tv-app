package foryou

import "time"

// Weights is the single place every taste and ranking constant lives
// (docs/architecture.md "Recommendations (Phase 6)"). Scoring is
// deterministic for fixed inputs; change behaviour here, not in the code.
type Weights struct {
	// ---- taste: per-title signal weight ----

	// Rating: (rating − center) / RatingSpread, clamped to ±RatingClamp,
	// times Rating. center = clamp(profile mean − 0.5, RatingCenterMin, RatingCenterMax).
	Rating          float64
	RatingSpread    float64
	RatingClamp     float64
	RatingCenterMin float64
	RatingCenterMax float64
	// Completed without a rating.
	Completed float64
	Favorite  float64
	// Watchlist intent (only for titles not yet watched or rated).
	Watchlist float64
	// Each rewatch (capped at MaxRewatches).
	Rewatch      float64
	MaxRewatches int
	// Started but stopped before AbandonPercent and idle for AbandonIdle.
	Abandon        float64
	AbandonPercent float64
	AbandonIdle    time.Duration
	// «Не интересно».
	Dismiss float64
	// A note with a dislike reason («Почему?») on the title.
	NoteDislike float64
	// Recency: weight × (RecencyFloor + (1 − RecencyFloor) · 0.5^(age/RecencyHalfLife)).
	RecencyFloor    float64
	RecencyHalfLife time.Duration

	// ---- taste: affinities ----

	// Shrinkage: affinity = Σweight / (n + AffinityPrior), so one title
	// can't define a taste.
	AffinityPrior float64
	// A person needs at least this many signal titles to count.
	MinPersonTitles int
	// Actors count with this factor (directors 1); only the top ActorBilling billed.
	ActorFactor  float64
	ActorBilling int
	// Seeds: the titles "because you liked X" rows are built from.
	Seeds       int
	RecentSeeds int
	RecentDays  int

	// ---- ranking ----

	Quality    float64 // Bayesian TMDB/Kinopoisk rating
	Genre      float64 // genre affinity of the candidate's genres
	Decade     float64
	Language   float64
	Country    float64
	Source     float64 // how strongly the candidate sources vouch for it
	Popularity float64
	// Novelty: bonus for titles never shown to the profile.
	Novelty float64
	// Fatigue: penalty per impression without an open (last 14 days), up to 5.
	Fatigue float64
	// Watchlisted titles get this bonus in the Surprise pool.
	WatchlistBoost float64
	// Bayesian quality prior: (v·R + m·C) / (v + m).
	QualityPriorVotes float64
	QualityPriorMean  float64

	// Source strengths (0..1) per candidate source type.
	SrcGenre, SrcTrending, SrcHiddenGem, SrcDifferent, SrcAI float64

	// Diversity (MMR): score·λ − (1−λ)·max similarity to already picked.
	MMRLambda float64

	// Rows.
	TopPicks                int
	RowSize                 int
	MinRowItems             int
	BecauseRows             int
	DirectorRows, ActorRows int
	// Cold start below this many positive signals.
	MinSignals int
	// Pool kept for Surprise Me.
	PoolSize int

	// ---- note reasons across titles (taste.go reasonAdjustments) ----

	// A rule applies from ReasonMinTitles notes; full strength at ReasonFullTitles.
	ReasonMinTitles, ReasonFullTitles int
	// Score penalty × strength for a matching genre / a runtime over ReasonLongRuntime.
	ReasonGenrePenalty, ReasonRuntimePenalty float64
	ReasonLongRuntime                        int
}

// DefaultWeights are the production weights.
func DefaultWeights() Weights {
	return Weights{
		Rating: 1, RatingSpread: 3, RatingClamp: 1.5, RatingCenterMin: 5, RatingCenterMax: 7,
		Completed: 0.3, Favorite: 1, Watchlist: 0.25, Rewatch: 0.35, MaxRewatches: 3,
		Abandon: -0.6, AbandonPercent: 0.15, AbandonIdle: 7 * 24 * time.Hour,
		Dismiss: -0.8, NoteDislike: -0.4,
		RecencyFloor: 0.4, RecencyHalfLife: 2 * 365 * 24 * time.Hour,

		AffinityPrior: 3, MinPersonTitles: 2, ActorFactor: 0.6, ActorBilling: 5,
		Seeds: 10, RecentSeeds: 4, RecentDays: 45,

		Quality: 1, Genre: 1.2, Decade: 0.3, Language: 0.3, Country: 0.2, Source: 1.5,
		Popularity: 0.2, Novelty: 0.1, Fatigue: 0.15, WatchlistBoost: 0.3,
		QualityPriorVotes: 300, QualityPriorMean: 6.3,

		SrcGenre: 0.25, SrcTrending: 0.35, SrcHiddenGem: 0.45, SrcDifferent: 0.4, SrcAI: 0.6,

		MMRLambda: 0.75,

		TopPicks: 15, RowSize: 15, MinRowItems: 5, BecauseRows: 3, DirectorRows: 2, ActorRows: 1,
		MinSignals: 3, PoolSize: 400,

		ReasonMinTitles: 2, ReasonFullTitles: 4, ReasonGenrePenalty: 0.4, ReasonRuntimePenalty: 0.3, ReasonLongRuntime: 130,
	}
}

// Mood maps a «Удиви меня!» mood onto TMDB movie genres.
type Mood struct {
	Key, Emoji, RU, EN string
	Genres             []int // any of
	Without            []int
}

// Moods in display order.
var Moods = []Mood{
	{Key: "cozy", Emoji: "☕", RU: "Уютное", EN: "Cozy", Genres: []int{35, 10751, 10749, 16}, Without: []int{27, 53, 80, 10752}},
	{Key: "tense", Emoji: "😰", RU: "Напряжённое", EN: "Tense", Genres: []int{53, 80, 9648, 28}, Without: []int{10751, 16}},
	{Key: "funny", Emoji: "😂", RU: "Смешное", EN: "Funny", Genres: []int{35}, Without: []int{27, 10752}},
	{Key: "thoughtful", Emoji: "🤔", RU: "Задуматься", EN: "Thought-provoking", Genres: []int{18, 878, 36, 99}, Without: []int{10751, 16, 28}},
	{Key: "scary", Emoji: "👻", RU: "Страшное", EN: "Scary", Genres: []int{27}},
	{Key: "romantic", Emoji: "💕", RU: "Романтика", EN: "Romance", Genres: []int{10749}, Without: []int{27}},
	{Key: "family", Emoji: "👨‍👩‍👧", RU: "Для всей семьи", EN: "For the whole family", Genres: []int{10751, 16}, Without: []int{27, 53, 80}},
}

func moodByKey(k string) *Mood {
	for i := range Moods {
		if Moods[i].Key == k {
			return &Moods[i]
		}
	}
	return nil
}

// tvGenre maps TMDB movie genres to their tv equivalents (tv has merged
// genres and no horror/thriller/romance). 0 = no equivalent.
var tvGenre = map[int]int{
	28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768,
	53: 9648, 9648: 9648, 80: 80, 18: 18, 35: 35, 10751: 10751, 16: 16, 99: 99, 37: 37, 36: 0, 10749: 0, 27: 0, 10402: 0,
}

// genresFor maps movie genre ids for a kind (series drop unmappable ones).
func genresFor(kind string, ids []int) []int {
	if kind != "series" {
		return ids
	}
	var out []int
	seen := map[int]bool{}
	for _, g := range ids {
		if t, ok := tvGenre[g]; ok && t != 0 && !seen[t] {
			seen[t] = true
			out = append(out, t)
		} else if !ok && !seen[g] {
			seen[g] = true
			out = append(out, g) // already a tv genre
		}
	}
	return out
}

// Keyword collections for Explore: TMDB keyword ids (checked against the
// live API 2026-10-29).
type keywordTile struct {
	ID     int
	RU, EN string
	Emoji  string
}

// keywordExtra widens a theme tile whose own TMDB keyword is on too few
// well-known films: related keywords OR-ed with it, and an optional any-of
// genre filter.
var keywordExtra = map[int]struct{ Also, Genres []int }{
	// "mind-bending": + surrealism, nonlinear timeline, time loop,
	// alternative reality, plot twist, "mind fuck".
	362567: {Also: []int{9887, 157171, 10854, 175629, 275311, 374835}},
	// "feel good": + feelgood, heartwarming, uplifting, inspirational —
	// within comedy / family / animation.
	383896: {Also: []int{275276, 319357, 334465, 281585}, Genres: []int{35, 10751, 16}},
}

var keywordTiles = []keywordTile{
	{4379, "Путешествия во времени", "Time travel", "⏳"},
	{10051, "Ограбления", "Heists", "💰"},
	{4565, "Антиутопии", "Dystopias", "🏙️"},
	{9882, "Космос", "Space", "🚀"},
	{12190, "Киберпанк", "Cyberpunk", "🤖"},
	{4458, "Постапокалипсис", "Post-apocalypse", "☢️"},
	{12565, "Психологические триллеры", "Psychological thrillers", "🧠"},
	{362567, "Взрыв мозга", "Mind-bending", "🌀"},
	{9672, "Основано на реальных событиях", "Based on a true story", "📰"},
	{10714, "Серийные убийцы", "Serial killers", "🔪"},
	{12570, "Детективы «кто убийца»", "Whodunits", "🕵️"},
	{9807, "Нуар", "Film noir", "🎩"},
	{10123, "Чёрные комедии", "Dark comedies", "🖤"},
	{10683, "Взросление", "Coming of age", "🎒"},
	{7312, "Роуд-муви", "Road trips", "🚗"},
	{10349, "Выживание", "Survival", "🏕️"},
	{383896, "Фильмы для хорошего настроения", "Feel-good", "🌈"},
	{207317, "Рождество", "Christmas", "🎄"},
	{12377, "Зомби", "Zombies", "🧟"},
	{9715, "Супергерои", "Superheroes", "🦸"},
}

// Languages offered in Explore («Страны и языки») when the taste has none.
var exploreLanguages = []string{"ko", "ja", "fr", "it", "es", "de", "ru", "en", "hi", "zh", "sv", "da", "tr"}

// Genres offered in «Лучшее по жанрам» (movie genres).
var exploreGenres = []int{18, 35, 53, 878, 28, 80, 9648, 12, 14, 27, 10749, 16, 10751, 99, 36, 10752, 37, 10402}
