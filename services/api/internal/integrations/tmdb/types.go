package tmdb

// Response shapes, checked against the live v3 API on 2026-10-28. Only the
// fields Cineko reads are declared.

// Page is a paginated list (trending, popular, discover, search, similar…).
type Page struct {
	Page         int        `json:"page"`
	TotalPages   int        `json:"total_pages"`
	TotalResults int        `json:"total_results"`
	Results      []ListItem `json:"results"`
}

// ListItem is a movie, tv show or (in multi search/trending) a person.
// Movies use title/original_title/release_date; tv uses name/original_name/first_air_date.
type ListItem struct {
	ID               int      `json:"id"`
	MediaType        string   `json:"media_type"` // only in trending/all, multi search, recommendations
	Title            string   `json:"title"`
	Name             string   `json:"name"`
	OriginalTitle    string   `json:"original_title"`
	OriginalName     string   `json:"original_name"`
	OriginalLanguage string   `json:"original_language"`
	Overview         string   `json:"overview"`
	PosterPath       *string  `json:"poster_path"`
	BackdropPath     *string  `json:"backdrop_path"`
	ReleaseDate      string   `json:"release_date"`
	FirstAirDate     string   `json:"first_air_date"`
	VoteAverage      float64  `json:"vote_average"`
	VoteCount        int      `json:"vote_count"`
	Popularity       float64  `json:"popularity"`
	GenreIDs         []int    `json:"genre_ids"`
	OriginCountry    []string `json:"origin_country"`
}

type Genre struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type GenreList struct {
	Genres []Genre `json:"genres"`
}

type Video struct {
	Lang     string `json:"iso_639_1"`
	Key      string `json:"key"`
	Name     string `json:"name"`
	Site     string `json:"site"`
	Type     string `json:"type"`
	Official bool   `json:"official"`
}

type Videos struct {
	Results []Video `json:"results"`
}

type ExternalIDs struct {
	IMDbID *string `json:"imdb_id"`
	TVDBID *int    `json:"tvdb_id"`
}

type CastCredit struct {
	ID           int     `json:"id"`
	Name         string  `json:"name"`
	OriginalName string  `json:"original_name"`
	ProfilePath  *string `json:"profile_path"`
	Character    string  `json:"character"`
	Order        int     `json:"order"`
}

type CrewCredit struct {
	ID           int     `json:"id"`
	Name         string  `json:"name"`
	OriginalName string  `json:"original_name"`
	ProfilePath  *string `json:"profile_path"`
	Job          string  `json:"job"`
	Department   string  `json:"department"`
}

// Keyword is a TMDB keyword ("heist", "time loop"); names are English only.
type Keyword struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// Keywords is /movie/{id}/keywords ("keywords") or /tv/{id}/keywords
// ("results"); also appended to details with append_to_response=keywords.
type Keywords struct {
	Keywords []Keyword `json:"keywords"`
	Results  []Keyword `json:"results"`
}

// All returns the list whichever key TMDB used.
func (k Keywords) All() []Keyword {
	if len(k.Keywords) > 0 {
		return k.Keywords
	}
	return k.Results
}

type Credits struct {
	Cast []CastCredit `json:"cast"`
	Crew []CrewCredit `json:"crew"`
}

// AggregateCredits is the series-wide cast/crew of a tv show (all seasons),
// which is more useful than /tv/{id}/credits (latest season only).
type AggregateCredits struct {
	Cast []AggregateCast `json:"cast"`
	Crew []AggregateCrew `json:"crew"`
}

type AggregateCast struct {
	ID           int     `json:"id"`
	Name         string  `json:"name"`
	OriginalName string  `json:"original_name"`
	ProfilePath  *string `json:"profile_path"`
	Order        int     `json:"order"`
	Roles        []struct {
		Character    string `json:"character"`
		EpisodeCount int    `json:"episode_count"`
	} `json:"roles"`
}

type AggregateCrew struct {
	ID           int     `json:"id"`
	Name         string  `json:"name"`
	OriginalName string  `json:"original_name"`
	ProfilePath  *string `json:"profile_path"`
	Department   string  `json:"department"`
	Jobs         []struct {
		Job          string `json:"job"`
		EpisodeCount int    `json:"episode_count"`
	} `json:"jobs"`
	TotalEpisodeCount int `json:"total_episode_count"`
}

// Movie is /movie/{id}?append_to_response=credits,external_ids,videos,keywords.
type Movie struct {
	ID                  int      `json:"id"`
	Title               string   `json:"title"`
	OriginalTitle       string   `json:"original_title"`
	OriginalLanguage    string   `json:"original_language"`
	Overview            string   `json:"overview"`
	Tagline             string   `json:"tagline"`
	Status              string   `json:"status"`
	ReleaseDate         string   `json:"release_date"`
	Runtime             *int     `json:"runtime"`
	PosterPath          *string  `json:"poster_path"`
	BackdropPath        *string  `json:"backdrop_path"`
	VoteAverage         float64  `json:"vote_average"`
	VoteCount           int      `json:"vote_count"`
	Popularity          float64  `json:"popularity"`
	Genres              []Genre  `json:"genres"`
	OriginCountry       []string `json:"origin_country"`
	ProductionCountries []struct {
		ISO string `json:"iso_3166_1"`
	} `json:"production_countries"`
	Credits     Credits     `json:"credits"`
	ExternalIDs ExternalIDs `json:"external_ids"`
	Videos      Videos      `json:"videos"`
	Keywords    *Keywords   `json:"keywords"`
}

type SeasonSummary struct {
	ID           int     `json:"id"`
	SeasonNumber int     `json:"season_number"`
	Name         string  `json:"name"`
	Overview     string  `json:"overview"`
	AirDate      *string `json:"air_date"`
	EpisodeCount int     `json:"episode_count"`
	PosterPath   *string `json:"poster_path"`
}

// TV is /tv/{id}?append_to_response=aggregate_credits,external_ids,videos,keywords.
type TV struct {
	ID               int      `json:"id"`
	Name             string   `json:"name"`
	OriginalName     string   `json:"original_name"`
	OriginalLanguage string   `json:"original_language"`
	Overview         string   `json:"overview"`
	Tagline          string   `json:"tagline"`
	Status           string   `json:"status"`
	FirstAirDate     string   `json:"first_air_date"`
	LastAirDate      *string  `json:"last_air_date"`
	EpisodeRunTime   []int    `json:"episode_run_time"`
	PosterPath       *string  `json:"poster_path"`
	BackdropPath     *string  `json:"backdrop_path"`
	VoteAverage      float64  `json:"vote_average"`
	VoteCount        int      `json:"vote_count"`
	Popularity       float64  `json:"popularity"`
	Genres           []Genre  `json:"genres"`
	OriginCountry    []string `json:"origin_country"`
	NumberOfSeasons  *int     `json:"number_of_seasons"`
	NumberOfEpisodes *int     `json:"number_of_episodes"`
	LastEpisodeToAir *struct {
		Runtime *int `json:"runtime"`
	} `json:"last_episode_to_air"`
	CreatedBy []struct {
		ID           int     `json:"id"`
		Name         string  `json:"name"`
		OriginalName string  `json:"original_name"`
		ProfilePath  *string `json:"profile_path"`
	} `json:"created_by"`
	Seasons          []SeasonSummary  `json:"seasons"`
	AggregateCredits AggregateCredits `json:"aggregate_credits"`
	ExternalIDs      ExternalIDs      `json:"external_ids"`
	Videos           Videos           `json:"videos"`
	Keywords         *Keywords        `json:"keywords"`
}

type Episode struct {
	ID            int     `json:"id"`
	SeasonNumber  int     `json:"season_number"`
	EpisodeNumber int     `json:"episode_number"`
	Name          string  `json:"name"`
	Overview      string  `json:"overview"`
	AirDate       *string `json:"air_date"`
	Runtime       *int    `json:"runtime"`
	StillPath     *string `json:"still_path"`
	VoteAverage   float64 `json:"vote_average"`
	VoteCount     int     `json:"vote_count"`
}

// Season is /tv/{id}/season/{n}.
type Season struct {
	SeasonSummary
	Episodes []Episode `json:"episodes"`
}

type Provider struct {
	ProviderID      int     `json:"provider_id"`
	ProviderName    string  `json:"provider_name"`
	LogoPath        *string `json:"logo_path"`
	DisplayPriority int     `json:"display_priority"`
}

type RegionProviders struct {
	Link     *string    `json:"link"`
	Flatrate []Provider `json:"flatrate"`
	Rent     []Provider `json:"rent"`
	Buy      []Provider `json:"buy"`
}

// WatchProviders is /{movie|tv}/{id}/watch/providers (JustWatch data).
type WatchProviders struct {
	Results map[string]RegionProviders `json:"results"`
}
