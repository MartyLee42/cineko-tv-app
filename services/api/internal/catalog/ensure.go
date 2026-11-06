package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"

	"martytv/api/internal/integrations/tmdb"
)

// EnsureByTMDB stores one title by its TMDB id (GET /movie/{id} or /tv/{id}
// through tmdb_cache) and returns it as a summary with its Cineko id. Used
// by internal/curated to resolve hand-made lists. An unknown id (or a kind
// that does not match it) is ErrNotFound.
func (s *Service) EnsureByTMDB(ctx context.Context, kind string, tmdbID int, lang string) (*MediaSummary, error) {
	if kind != "movie" && kind != "series" || tmdbID <= 0 {
		return nil, ErrNotFound
	}
	body, fresh, err := s.fetch(ctx, fmt.Sprintf("/%s/%d", tmdb.MediaType(kind), tmdbID),
		url.Values{"language": {tmdb.Language(lang)}}, ttlRelated, false)
	if err != nil {
		if errors.Is(err, tmdb.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	// Details carry genres as objects; the list shape wants genre_ids.
	var it tmdb.ListItem
	var extra struct {
		Genres []tmdb.Genre `json:"genres"`
	}
	if err := json.Unmarshal(body, &it); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrUpstream, err)
	}
	if err := json.Unmarshal(body, &extra); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrUpstream, err)
	}
	if it.ID != tmdbID {
		return nil, ErrNotFound
	}
	it.GenreIDs = nil
	for _, g := range extra.Genres {
		it.GenreIDs = append(it.GenreIDs, g.ID)
	}
	out, err := s.summaries(ctx, lang, []tmdb.ListItem{it}, kind, fresh)
	if err != nil {
		return nil, err
	}
	if len(out) != 1 {
		return nil, ErrNotFound
	}
	return &out[0], nil
}
