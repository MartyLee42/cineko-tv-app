package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"

	"martytv/api/internal/db"
	"martytv/api/internal/integrations/tmdb"
)

// TMDB keywords ("heist", "time loop", "small town") per title: the taste
// themes of internal/foryou. They arrive with the details
// (append_to_response=keywords); FetchKeywords backfills titles stored
// before that, one cheap request each.

// maxKeywords per title (TMDB has up to ~50 on popular films).
const maxKeywords = 25

// FetchKeywords loads and stores a title's TMDB keywords.
func (s *Service) FetchKeywords(ctx context.Context, id string) error {
	ref, err := s.ref(ctx, id)
	if err != nil {
		return err
	}
	body, err := s.tmdb.Get(ctx, fmt.Sprintf("/%s/%d/keywords", tmdb.MediaType(ref.kind), ref.tmdbID), nil)
	if err != nil {
		if errors.Is(err, tmdb.ErrNotFound) {
			// Nothing to learn; mark it so it isn't asked again.
			_, err := s.pool.Exec(ctx, `UPDATE media SET keywords_fetched_at = now() WHERE id = $1`, id)
			return err
		}
		return fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	var k tmdb.Keywords
	if err := json.Unmarshal(body, &k); err != nil {
		return fmt.Errorf("%w: decode: %v", ErrUpstream, err)
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		return saveKeywords(ctx, tx, id, nonNil(k.All()))
	})
}

// saveKeywords replaces a title's keywords and marks them fetched.
func saveKeywords(ctx context.Context, q db.Querier, mediaID string, kws []tmdb.Keyword) error {
	seen := map[int]bool{}
	var ids []int32
	var names []string
	for _, k := range kws {
		if k.ID <= 0 || k.Name == "" || seen[k.ID] || len(ids) == maxKeywords {
			continue
		}
		seen[k.ID] = true
		ids, names = append(ids, int32(k.ID)), append(names, k.Name)
	}
	if _, err := q.Exec(ctx, `UPDATE media SET keywords_fetched_at = now() WHERE id = $1`, mediaID); err != nil {
		return err
	}
	if _, err := q.Exec(ctx, `DELETE FROM media_keywords WHERE media_id = $1`, mediaID); err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	// Sorted upsert keeps a consistent lock order across concurrent saves.
	order := make([]int, len(ids))
	for i := range order {
		order[i] = i
	}
	slices.SortFunc(order, func(a, b int) int { return int(ids[a]) - int(ids[b]) })
	sIDs, sNames := make([]int32, len(ids)), make([]string, len(ids))
	for i, o := range order {
		sIDs[i], sNames[i] = ids[o], names[o]
	}
	if _, err := q.Exec(ctx, `
		INSERT INTO keywords (id, name) SELECT * FROM unnest($1::int[], $2::text[])
		ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
		WHERE keywords.name IS DISTINCT FROM EXCLUDED.name`, sIDs, sNames); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `
		INSERT INTO media_keywords (media_id, keyword_id, position)
		SELECT $1, k, (ord - 1)::smallint FROM unnest($2::int[]) WITH ORDINALITY AS t(k, ord)
		ON CONFLICT DO NOTHING`, mediaID, ids)
	return err
}
