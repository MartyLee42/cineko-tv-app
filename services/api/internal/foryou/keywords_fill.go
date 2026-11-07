package foryou

import (
	"context"
	"errors"

	"martytv/api/internal/catalog"
)

// keywordFillPerProfile: TMDB keyword requests per profile per run (signal
// titles first, then the best cached candidates). Stored keywords are
// shared by every profile, so later runs need few.
const keywordFillPerProfile = 150

// fillKeywords backfills TMDB keywords for titles stored before keywords
// came with the details: the profile's signal titles (favorites, then
// highest rated), then the best candidates of its cached pool. Paced like
// the credits fill; 5 failures pause it.
func (s *Service) fillKeywords(ctx context.Context, profileID string) error {
	if !s.cat.Available() || s.cfg.CreditsPerProfile <= 0 {
		return nil
	}
	var ids []string
	if err := s.pool.QueryRow(ctx, `
		WITH sig AS (
			SELECT m.id, row_number() OVER (ORDER BY (f.media_id IS NOT NULL) DESC, r.rating DESC NULLS LAST,
			                                   r.updated_at DESC NULLS LAST, m.id) AS ord
			FROM media m
			LEFT JOIN ratings r ON r.profile_id = $1 AND r.media_id = m.id
			LEFT JOIN favorites f ON f.profile_id = $1 AND f.media_id = m.id
			WHERE m.keywords_fetched_at IS NULL
			  AND (r.media_id IS NOT NULL OR f.media_id IS NOT NULL
			       OR EXISTS (SELECT 1 FROM watch_progress wp WHERE wp.profile_id = $1 AND wp.media_id = m.id AND wp.completed))
			ORDER BY ord LIMIT $2),
		cand AS (
			SELECT m.id, p.ord FROM recs_cache c
			CROSS JOIN LATERAL jsonb_array_elements(c.pool) WITH ORDINALITY AS p(e, ord)
			JOIN media m ON m.id = (p.e ->> 'm')::uuid
			WHERE c.profile_id = $1 AND m.keywords_fetched_at IS NULL AND p.ord <= 200)
		SELECT COALESCE(array_agg(id::text ORDER BY grp, ord), '{}') FROM (
			(SELECT id, 0 AS grp, ord FROM sig)
			UNION ALL
			(SELECT id, 1, ord FROM cand WHERE id NOT IN (SELECT id FROM sig))
			ORDER BY grp, ord LIMIT $2) x`, profileID, keywordFillPerProfile).Scan(&ids); err != nil {
		return err
	}
	failures := 0
	for _, id := range ids {
		if err := s.pace.Wait(ctx); err != nil {
			return err
		}
		if err := s.cat.FetchKeywords(ctx, id); err != nil && !errors.Is(err, catalog.ErrNotFound) {
			failures++
			if failures >= 5 {
				return errors.New("tmdb keywords failing; keywords fill paused")
			}
		}
	}
	return nil
}
