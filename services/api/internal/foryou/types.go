package foryou

import (
	"time"

	"martytv/api/internal/catalog"
	"martytv/api/internal/family"
)

// Row kinds (contract ForYouRowKind).
const (
	RowTopPicks   = "top_picks"
	RowBecause    = "because_you_rated"
	RowDirector   = "director"
	RowActor      = "actor"
	RowGenre      = "genre"
	RowHiddenGems = "hidden_gems"
	RowDifferent  = "something_different"
	RowTrending   = "trending"
	RowRewatch    = "rewatch"
	RowAI         = "ai_collection"
	// RowTheme «Вам нравятся фильмы про …»: discover by a liked TMDB keyword.
	RowTheme   = "theme"
	RowPopular = "popular"
	// RowFamily «Семья советует» (internal/family; computed per request).
	RowFamily = "family"
	// RowCurated «Подборка: …» (internal/curated; one list per day, per request).
	RowCurated = "curated"
)

// Reason types (contract ForYouReasonType).
const (
	ReasonBecause   = "because_you_rated"
	ReasonDirector  = "director"
	ReasonActor     = "actor"
	ReasonGenre     = "genre"
	ReasonHiddenGem = "hidden_gem"
	ReasonDifferent = "something_different"
	ReasonTrending  = "trending_for_you"
	ReasonAI        = "ai_collection"
	ReasonRewatch   = "rewatch"
	ReasonPopular   = "popular"
	ReasonMood      = "mood"
	ReasonFamily    = "family"
	ReasonCurated   = "curated"
	// ReasonTheme: the title has a TMDB keyword the profile likes.
	ReasonTheme = "theme"
)

// Reason is the stored, language-agnostic reason (ids only).
type Reason struct {
	Type         string `json:"t"`
	MediaID      string `json:"m,omitempty"`
	PersonID     int    `json:"p,omitempty"`
	GenreIDs     []int  `json:"g,omitempty"`
	CollectionID string `json:"c,omitempty"`
	Mood         string `json:"mo,omitempty"`
	KeywordID    int    `json:"k,omitempty"`
}

// ReasonOut is the contract's ForYouReason.
type ReasonOut struct {
	Type            string   `json:"type"`
	Text            string   `json:"text"`
	MediaID         *string  `json:"media_id"`
	MediaTitle      *string  `json:"media_title"`
	PersonTMDBID    *int     `json:"person_tmdb_id"`
	PersonName      *string  `json:"person_name"`
	GenreIDs        []int    `json:"genre_ids"`
	GenreNames      []string `json:"genre_names"`
	CollectionID    *string  `json:"collection_id"`
	CollectionTitle *string  `json:"collection_title"`
	Mood            *string  `json:"mood"`
	// Theme (type theme): the liked TMDB keyword, its name in the response
	// language when known (else English).
	KeywordID   *int    `json:"keyword_id,omitempty"`
	KeywordName *string `json:"keyword_name,omitempty"`
	// KeywordLocalized: KeywordName is in the response language (Russian
	// names come from the AI themes call; until then it is TMDB's English).
	KeywordLocalized bool `json:"keyword_localized,omitempty"`
	// AIText: the model's one-line personal reason (AI re-ranking of
	// «Подобрано для вас»), in the response language; clients show it
	// instead of the typed reason.
	AIText *string `json:"ai_text,omitempty"`
	// Family (type family): who in the family liked the title and how.
	Family *family.Why `json:"family,omitempty"`
}

// cachedItem / cachedRow are recs_cache.rows (and pool) entries.
type cachedItem struct {
	MediaID string  `json:"m"`
	Score   float64 `json:"s"`
	Reason  Reason  `json:"r"`
	// Watchlist marks pool-only entries (the profile's own watchlist).
	Watchlist bool `json:"w,omitempty"`
	// Src: the item's credit per learn key (row items only; learn.go).
	Src map[string]float64 `json:"x,omitempty"`
}

type cachedRow struct {
	ID     string       `json:"id"`
	Kind   string       `json:"k"`
	Reason Reason       `json:"r"`
	Items  []cachedItem `json:"i"`
}

// Item is the contract's ForYouItem.
type Item struct {
	Media  catalog.MediaSummary `json:"media"`
	Reason ReasonOut            `json:"reason"`
	Score  float64              `json:"score"`
}

// Row is the contract's ForYouRow.
type Row struct {
	ID     string    `json:"id"`
	Kind   string    `json:"kind"`
	Title  string    `json:"title"`
	Reason ReasonOut `json:"reason"`
	Items  []Item    `json:"items"`
	// Family (kind family): the sharing members with their taste match.
	Family *FamilyRowInfo `json:"family,omitempty"`
	// Curated (kind curated): the list and the profile's progress.
	Curated *CuratedRowInfo `json:"curated,omitempty"`
}

// FamilyRowInfo is the contract's ForYouFamilyRow.
type FamilyRowInfo struct {
	Members []family.Member `json:"members"`
}

// Rows is the contract's ForYouRows.
type Rows struct {
	ProfileID   string     `json:"profile_id"`
	GeneratedAt *time.Time `json:"generated_at"`
	Stale       bool       `json:"stale"`
	ColdStart   bool       `json:"cold_start"`
	Rows        []Row      `json:"rows"`
}
