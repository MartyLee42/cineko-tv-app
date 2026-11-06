package awards

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// store is the PostgreSQL side (media_awards, media.awards_checked_at).
type store struct{ pool *pgxpool.Pool }

// checkedAt reports whether the title exists and when its awards were last
// checked (nil = never).
func (s *store) checkedAt(ctx context.Context, id string) (bool, *time.Time, error) {
	var at *time.Time
	err := s.pool.QueryRow(ctx, `SELECT awards_checked_at FROM media WHERE id = $1`, id).Scan(&at)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil, nil
	}
	return err == nil, at, err
}

// rows reads a title's stored awards.
func (s *store) rows(ctx context.Context, id string) ([]Award, error) {
	rs, err := s.pool.Query(ctx, `
		SELECT award_qid, group_key, tier, label_ru, label_en, year, won
		FROM media_awards WHERE media_id = $1 ORDER BY won DESC, year, award_qid`, id)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	var out []Award
	for rs.Next() {
		var a Award
		var tier, year int16
		if err := rs.Scan(&a.QID, &a.Group, &tier, &a.LabelRU, &a.LabelEN, &year, &a.Won); err != nil {
			return nil, err
		}
		a.Tier, a.Year = int(tier), int(year)
		out = append(out, a)
	}
	return out, rs.Err()
}

// tier1Wins counts tier-1 wins per title and group in one query.
func (s *store) tier1Wins(ctx context.Context, ids []string) (map[string]map[string]int, error) {
	rs, err := s.pool.Query(ctx, `
		SELECT media_id::text, group_key, count(*)
		FROM media_awards WHERE media_id = ANY($1::uuid[]) AND won AND tier = 1
		GROUP BY 1, 2`, ids)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	out := map[string]map[string]int{}
	for rs.Next() {
		var id, g string
		var n int
		if err := rs.Scan(&id, &g, &n); err != nil {
			return nil, err
		}
		if out[id] == nil {
			out[id] = map[string]int{}
		}
		out[id][g] = n
	}
	return out, rs.Err()
}

// save replaces the awards of every checked title and marks them checked.
func (s *store) save(ctx context.Context, checked []string, found map[string][]Award) error {
	if len(checked) == 0 {
		return nil
	}
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM media_awards WHERE media_id = ANY($1::uuid[])`, checked); err != nil {
			return err
		}
		var rows [][]any
		for _, id := range checked {
			for _, a := range found[id] {
				rows = append(rows, []any{id, a.QID, a.Group, a.LabelRU, a.LabelEN, int16(a.Year), a.Won, int16(a.Tier)})
			}
		}
		if len(rows) > 0 {
			if _, err := tx.CopyFrom(ctx, pgx.Identifier{"media_awards"},
				[]string{"media_id", "award_qid", "group_key", "label_ru", "label_en", "year", "won", "tier"},
				pgx.CopyFromRows(rows)); err != nil {
				return err
			}
		}
		_, err := tx.Exec(ctx, `UPDATE media SET awards_checked_at = now() WHERE id = ANY($1::uuid[])`, checked)
		return err
	})
}

// backlog lists titles never checked or checked before `retry`: titles
// someone watched, saved or rated first, then the most recently updated.
func (s *store) backlog(ctx context.Context, retry time.Duration, limit int) ([]string, error) {
	rs, err := s.pool.Query(ctx, `
		SELECT m.id FROM media m
		WHERE m.awards_checked_at IS NULL OR m.awards_checked_at < now() - make_interval(secs => $1)
		ORDER BY m.awards_checked_at IS NOT NULL,
		         (EXISTS (SELECT 1 FROM watch_progress w WHERE w.media_id = m.id)
		       OR EXISTS (SELECT 1 FROM watchlist_items w WHERE w.media_id = m.id)
		       OR EXISTS (SELECT 1 FROM favorites f WHERE f.media_id = m.id)
		       OR EXISTS (SELECT 1 FROM ratings r WHERE r.media_id = m.id)) DESC,
		         m.updated_at DESC, m.id
		LIMIT $2`, retry.Seconds(), limit)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	var out []string
	for rs.Next() {
		var id string
		if err := rs.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rs.Err()
}
