package catalog

// JSON shapes from packages/contracts/openapi.yaml (catalog, Phase 2).
// Nullable contract fields are pointers; arrays are never nil.

type MediaSummary struct {
	ID            string   `json:"id"`
	Kind          string   `json:"kind"`
	TMDBID        int      `json:"tmdb_id"`
	Title         string   `json:"title"`
	OriginalTitle string   `json:"original_title"`
	Year          *int     `json:"year"`
	ReleaseDate   *string  `json:"release_date"`
	Overview      string   `json:"overview"`
	PosterPath    *string  `json:"poster_path"`
	BackdropPath  *string  `json:"backdrop_path"`
	Rating        *float64 `json:"rating"`
	VoteCount     int      `json:"vote_count"`
	// KPRating/IMDbRating come from Kinopoisk (internal/ratings), filled
	// after the TMDB cache; null until known.
	KPRating   *float64 `json:"kp_rating"`
	IMDbRating *float64 `json:"imdb_rating"`
	GenreIDs   []int    `json:"genre_ids"`
	// AwardBadge is set for titles with tier-1 award wins (Oscars, the main
	// prizes of Cannes/Venice/Berlin; internal/awards), annotated with the
	// ratings; omitted otherwise.
	AwardBadge *AwardBadge `json:"award_badge,omitempty"`
	// Me is the requesting profile's state; only set with ?profile_id.
	Me *MediaUserState `json:"me,omitempty"`
	// origLang is the TMDB original language (used by the hide_anime filter).
	origLang string
}

// MediaUserState is a profile's relation to a title (Phase 5).
type MediaUserState struct {
	ProgressPercent *float64 `json:"progress_percent"`
	Completed       bool     `json:"completed"`
	InWatchlist     bool     `json:"in_watchlist"`
	Favorite        bool     `json:"favorite"`
	Rating          *int     `json:"rating"`
	// Note is the profile's private note on the title («Моя заметка»).
	Note *MediaNote `json:"note"`
}

// MediaNote is a profile's note: free text and quick reason codes.
type MediaNote struct {
	Text    string   `json:"text"`
	Reasons []string `json:"reasons"`
}

type MediaPage struct {
	Items        []MediaSummary `json:"items"`
	Page         int            `json:"page"`
	TotalPages   int            `json:"total_pages"`
	TotalResults int            `json:"total_results"`
}

type HomeRow struct {
	Key   string         `json:"key"`
	Kind  string         `json:"kind"`
	List  string         `json:"list"`
	Items []MediaSummary `json:"items"`
}

type Genre struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type CastMember struct {
	PersonTMDBID int     `json:"person_tmdb_id"`
	Name         string  `json:"name"`
	Character    string  `json:"character"`
	ProfilePath  *string `json:"profile_path"`
	Order        int     `json:"order"`
}

type CrewMember struct {
	PersonTMDBID int     `json:"person_tmdb_id"`
	Name         string  `json:"name"`
	Job          string  `json:"job"`
	Department   string  `json:"department"`
	ProfilePath  *string `json:"profile_path"`
}

type SeasonSummary struct {
	SeasonNumber int     `json:"season_number"`
	Name         string  `json:"name"`
	Overview     string  `json:"overview"`
	AirDate      *string `json:"air_date"`
	EpisodeCount int     `json:"episode_count"`
	PosterPath   *string `json:"poster_path"`
}

type Episode struct {
	ID            string   `json:"id"`
	SeasonNumber  int      `json:"season_number"`
	EpisodeNumber int      `json:"episode_number"`
	Name          string   `json:"name"`
	Overview      string   `json:"overview"`
	AirDate       *string  `json:"air_date"`
	Runtime       *int     `json:"runtime"`
	StillPath     *string  `json:"still_path"`
	Rating        *float64 `json:"rating"`
}

type Season struct {
	SeasonSummary
	MediaID  string    `json:"media_id"`
	Episodes []Episode `json:"episodes"`
}

type Video struct {
	Site string `json:"site"`
	Key  string `json:"key"`
	Name string `json:"name"`
	Type string `json:"type"`
}

type ExternalIDs struct {
	TMDB int     `json:"tmdb"`
	IMDb *string `json:"imdb"`
	TVDB *int    `json:"tvdb"`
	// Kinopoisk is the Kinopoisk film id once resolved.
	Kinopoisk *int `json:"kinopoisk"`
}

type MediaDetail struct {
	MediaSummary
	Tagline          string          `json:"tagline"`
	Runtime          *int            `json:"runtime"`
	Status           string          `json:"status"`
	OriginalLanguage string          `json:"original_language"`
	Genres           []Genre         `json:"genres"`
	Countries        []string        `json:"countries"`
	Cast             []CastMember    `json:"cast"`
	Crew             []CrewMember    `json:"crew"`
	Seasons          []SeasonSummary `json:"seasons"`
	NumberOfSeasons  *int            `json:"number_of_seasons"`
	NumberOfEpisodes *int            `json:"number_of_episodes"`
	LastAirDate      *string         `json:"last_air_date"`
	ExternalIDs      ExternalIDs     `json:"external_ids"`
	Trailer          *Video          `json:"trailer"`
	// Awards are the title's awards and nominations (Wikidata, internal/
	// awards), grouped per award; never null.
	Awards []AwardGroup `json:"awards"`
}

// AwardBadge is the compact poster badge: the award group with the most
// tier-1 wins and their number (clients localize the group key).
type AwardBadge struct {
	Group string `json:"group"`
	Count int    `json:"count"`
}

// AwardGroup is one award (Oscars, Cannes, …; "other" for the rest) with
// the title's wins and nominations, labels in the request language.
type AwardGroup struct {
	Group       string       `json:"group"`
	GroupLabel  string       `json:"group_label"`
	Tier        int          `json:"tier"`
	Wins        []AwardEntry `json:"wins"`
	Nominations []AwardEntry `json:"nominations"`
}

// AwardEntry is one category (short label within its group) and year.
type AwardEntry struct {
	Label string `json:"label"`
	Year  *int   `json:"year"`
}

type Provider struct {
	ProviderID int     `json:"provider_id"`
	Name       string  `json:"name"`
	LogoPath   *string `json:"logo_path"`
}

type Providers struct {
	Region   string     `json:"region"`
	Link     *string    `json:"link"`
	Flatrate []Provider `json:"flatrate"`
	Rent     []Provider `json:"rent"`
	Buy      []Provider `json:"buy"`
}

type Config struct {
	ImageBaseURL  string   `json:"image_base_url"`
	PosterSizes   []string `json:"poster_sizes"`
	BackdropSizes []string `json:"backdrop_sizes"`
	ProfileSizes  []string `json:"profile_sizes"`
	StillSizes    []string `json:"still_sizes"`
	Attribution   string   `json:"attribution"`
	Region        string   `json:"region"`
	Available     bool     `json:"available"`
}

// translation is one language's entry in media.translations. Fields are
// omitted when empty so merging a list result ({title, overview, posters})
// over stored details never erases the tagline or trailer.
type translation struct {
	Title        string  `json:"title,omitempty"`
	Overview     string  `json:"overview,omitempty"`
	Tagline      string  `json:"tagline,omitempty"`
	PosterPath   *string `json:"poster_path,omitempty"`
	BackdropPath *string `json:"backdrop_path,omitempty"`
	Trailer      *Video  `json:"trailer,omitempty"`
}

// nameTranslation is the per-language entry for seasons and episodes.
type nameTranslation struct {
	Name       string  `json:"name,omitempty"`
	Overview   string  `json:"overview,omitempty"`
	PosterPath *string `json:"poster_path,omitempty"`
}
