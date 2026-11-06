package catalog

import (
	"context"
	"encoding/json"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"

	"martytv/api/internal/db"
	"martytv/api/internal/integrations/tmdb"
)

type mediaKey struct {
	kind   string
	tmdbID int
}

func isNoRows(err error) bool { return db.IsNoRows(err) }

// materialize upserts list rows into media and returns their internal ids.
//
// The key is (kind, tmdb_id), so the same title always resolves to the same
// row. When fresh (the data just came from TMDB) the row's facts and this
// language's translation are updated; otherwise rows are only inserted if
// missing, so serving a cached page costs no writes. Rows are sorted to take
// row locks in a consistent order (concurrent upserts can't deadlock).
func (s *Service) materialize(ctx context.Context, lang string, rows []listRow, fresh bool) (map[mediaKey]string, error) {
	out := make(map[mediaKey]string, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	uniq := make([]listRow, 0, len(rows))
	seen := map[mediaKey]bool{}
	for _, r := range rows {
		k := mediaKey{r.kind, r.tmdbID}
		if !seen[k] {
			seen[k] = true
			uniq = append(uniq, r)
		}
	}
	slices.SortFunc(uniq, func(a, b listRow) int {
		if a.kind != b.kind {
			if a.kind < b.kind {
				return -1
			}
			return 1
		}
		return a.tmdbID - b.tmdbID
	})

	n := len(uniq)
	var (
		kinds, origTitles, origLangs, trs = make([]string, n), make([]string, n), make([]string, n), make([]string, n)
		dates, posters, backdrops         = make([]*string, n), make([]*string, n), make([]*string, n)
		tmdbIDs, years, voteCounts        = make([]int32, n), make([]*int32, n), make([]int32, n)
		voteAvgs, pops                    = make([]float64, n), make([]float64, n)
		gKinds                            []string
		gTMDB, gIDs, gPos                 []int32
	)
	for i, r := range uniq {
		kinds[i], tmdbIDs[i], origTitles[i], origLangs[i] = r.kind, int32(r.tmdbID), r.originalTitle, r.originalLanguage
		dates[i], posters[i], backdrops[i] = r.date, r.poster, r.backdrop
		if r.year != nil {
			y := int32(*r.year)
			years[i] = &y
		}
		voteAvgs[i], voteCounts[i], pops[i] = r.voteAverage, int32(r.voteCount), r.popularity
		b, _ := json.Marshal(translation{Title: r.title, Overview: r.overview, PosterPath: r.poster, BackdropPath: r.backdrop})
		trs[i] = string(b)
		for p, g := range r.genreIDs {
			gKinds, gTMDB, gIDs, gPos = append(gKinds, r.kind), append(gTMDB, int32(r.tmdbID)), append(gIDs, int32(g)), append(gPos, int32(p))
		}
	}

	batch := &pgx.Batch{}
	batch.Queue(`
		INSERT INTO media AS m (kind, tmdb_id, original_title, original_language, release_date, year,
		                        poster_path, backdrop_path, vote_average, vote_count, popularity, translations)
		SELECT t.kind, t.tmdb_id, t.ot, t.ol, t.rd::date, t.y, t.pp, t.bp, t.va, t.vc, t.pop,
		       jsonb_build_object($12::text, t.tr::jsonb)
		FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::text[],
		            $9::float8[], $10::int[], $11::float8[], $13::text[])
		     AS t(kind, tmdb_id, ot, ol, rd, y, pp, bp, va, vc, pop, tr)
		ON CONFLICT (kind, tmdb_id) DO UPDATE SET
			original_title    = EXCLUDED.original_title,
			original_language = EXCLUDED.original_language,
			release_date      = EXCLUDED.release_date,
			year              = EXCLUDED.year,
			-- Top-level artwork is the English (default) one; localized posters
			-- live in translations.
			poster_path   = CASE WHEN $12::text = 'en' OR m.poster_path IS NULL THEN EXCLUDED.poster_path ELSE m.poster_path END,
			backdrop_path = CASE WHEN $12::text = 'en' OR m.backdrop_path IS NULL THEN EXCLUDED.backdrop_path ELSE m.backdrop_path END,
			vote_average  = EXCLUDED.vote_average,
			vote_count    = EXCLUDED.vote_count,
			popularity    = EXCLUDED.popularity,
			translations  = m.translations || jsonb_build_object($12::text,
			                  COALESCE(m.translations -> $12::text, '{}'::jsonb) || (EXCLUDED.translations -> $12::text)),
			updated_at    = now()
		WHERE $14::bool OR NOT (m.translations ? $12::text)`,
		kinds, tmdbIDs, origTitles, origLangs, dates, years, posters, backdrops, voteAvgs, voteCounts, pops, lang, trs, fresh)
	if fresh && len(gIDs) > 0 {
		batch.Queue(`
			INSERT INTO media_genres (media_id, genre_id, position)
			SELECT m.id, g.genre_id, g.pos
			FROM unnest($1::text[], $2::int[], $3::int[], $4::int[]) AS g(kind, tmdb_id, genre_id, pos)
			JOIN media m ON m.kind = g.kind AND m.tmdb_id = g.tmdb_id
			ON CONFLICT DO NOTHING`, gKinds, gTMDB, gIDs, gPos)
	}
	// Mirror the TMDB id into media_external_ids (the generic external-id
	// lookup used by later phases) and read back every id.
	batch.Queue(`
		WITH ids AS (
			SELECT m.id, m.kind, m.tmdb_id FROM media m
			JOIN unnest($1::text[], $2::int[]) AS t(kind, tmdb_id) ON m.kind = t.kind AND m.tmdb_id = t.tmdb_id
		), ext AS (
			INSERT INTO media_external_ids (media_id, provider, external_id)
			SELECT id, CASE kind WHEN 'movie' THEN 'tmdb_movie' ELSE 'tmdb_tv' END, tmdb_id::text FROM ids
			ON CONFLICT DO NOTHING
		)
		SELECT id, kind, tmdb_id FROM ids`, kinds, tmdbIDs)

	br := s.pool.SendBatch(ctx, batch)
	defer br.Close()
	if _, err := br.Exec(); err != nil {
		return nil, err
	}
	if fresh && len(gIDs) > 0 {
		if _, err := br.Exec(); err != nil {
			return nil, err
		}
	}
	res, err := br.Query()
	if err != nil {
		return nil, err
	}
	defer res.Close()
	for res.Next() {
		var id, kind string
		var tid int
		if err := res.Scan(&id, &kind, &tid); err != nil {
			return nil, err
		}
		out[mediaKey{kind, tid}] = id
	}
	return out, res.Err()
}

// upsertGenres stores genre names for one language.
func (s *Service) upsertGenres(ctx context.Context, q db.Querier, lang string, genres []tmdb.Genre) error {
	if len(genres) == 0 {
		return nil
	}
	ids, names := make([]int32, len(genres)), make([]string, len(genres))
	for i, g := range genres {
		ids[i], names[i] = int32(g.ID), g.Name
	}
	_, err := q.Exec(ctx, `
		INSERT INTO genres (id, translations)
		SELECT DISTINCT ON (id) id, jsonb_build_object($3::text, name)
		FROM unnest($1::int[], $2::text[]) AS t(id, name) ORDER BY id
		ON CONFLICT (id) DO UPDATE SET translations = genres.translations || EXCLUDED.translations, updated_at = now()`,
		ids, names, lang)
	return err
}

// mediaRef is the minimum needed to call TMDB for a stored title.
type mediaRef struct {
	id        string
	kind      string
	tmdbID    int
	fetchedAt *time.Time // details for the requested language
}

func (s *Service) ref(ctx context.Context, id string) (*mediaRef, error) {
	return s.refLang(ctx, id, "")
}

func (s *Service) refLang(ctx context.Context, id, lang string) (*mediaRef, error) {
	r := mediaRef{id: id}
	err := s.pool.QueryRow(ctx, `
		SELECT kind, tmdb_id, (details_fetched_at ->> $2::text)::timestamptz FROM media WHERE id = $1`,
		id, lang).Scan(&r.kind, &r.tmdbID, &r.fetchedAt)
	if isNoRows(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// CleanupCache drops cache rows that have been expired for a while (they
// are kept meanwhile as a fallback when TMDB is unreachable).
func (s *Service) CleanupCache(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM tmdb_cache WHERE expires_at < now() - $1::interval`, staleKeep)
	return err
}
