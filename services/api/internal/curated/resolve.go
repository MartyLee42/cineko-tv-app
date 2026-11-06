package curated

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"martytv/api/internal/catalog"
)

const (
	// retryAfter: an item not found is looked up again after this long.
	retryAfter = 7 * 24 * time.Hour
	// resolveEvery: the resolver's period (plus once at startup).
	resolveEvery = 24 * time.Hour
)

// Stats is one resolver pass.
type Stats struct {
	Checked    int // items looked up this pass
	Resolved   int // of those, found
	Unresolved int // of those, not found
	Errors     int // transient failures (retried next pass)
}

// Run resolves at startup (after a short delay) and then daily, until ctx
// ends. No-op without TMDB credentials.
func (s *Service) Run(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(20 * time.Second):
	}
	for {
		if s.cat.Available() {
			st, err := s.Resolve(ctx)
			if err != nil && ctx.Err() == nil {
				s.log.Warn("curated: resolve failed", "err", err)
			} else if st.Checked > 0 {
				s.log.Info("curated: resolved", "checked", st.Checked, "resolved", st.Resolved, "unresolved", st.Unresolved, "errors", st.Errors)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(resolveEvery):
		}
	}
}

type storedRow struct {
	key       string
	mediaID   *string
	checkedAt time.Time
}

// Resolve maps list items to catalog titles: new or changed entries, and
// unresolved ones older than retryAfter. Rows of removed lists/positions
// are deleted. Calls are paced (s.pace).
func (s *Service) Resolve(ctx context.Context) (Stats, error) {
	s.resolveMu.Lock()
	defer s.resolveMu.Unlock()
	var st Stats
	lists := s.Lists()
	ids := make([]string, len(lists))
	lens := make([]int32, len(lists))
	for i, l := range lists {
		ids[i], lens[i] = l.ID, int32(len(l.Items))
	}
	if _, err := s.pool.Exec(ctx, `
		DELETE FROM curated_items c WHERE NOT EXISTS (
			SELECT 1 FROM unnest($1::text[], $2::int[]) AS l(id, n) WHERE l.id = c.list_id AND c.position <= l.n)`, ids, lens); err != nil {
		return st, err
	}
	rows, err := s.pool.Query(ctx, `SELECT list_id, position, item_key, media_id::text, checked_at FROM curated_items`)
	if err != nil {
		return st, err
	}
	stored := map[string]storedRow{}
	for rows.Next() {
		var list string
		var pos int
		var r storedRow
		if err := rows.Scan(&list, &pos, &r.key, &r.mediaID, &r.checkedAt); err != nil {
			rows.Close()
			return st, err
		}
		stored[posKey(list, pos)] = r
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return st, err
	}
	now := s.now()
	for _, l := range lists {
		for i := range l.Items {
			it := &l.Items[i]
			pos := i + 1
			if r, ok := stored[posKey(l.ID, pos)]; ok && r.key == it.key() && (r.mediaID != nil || now.Sub(r.checkedAt) < retryAfter) {
				continue
			}
			if err := ctx.Err(); err != nil {
				return st, err
			}
			st.Checked++
			id, err := s.resolveItem(ctx, it)
			if err != nil {
				if ctx.Err() != nil {
					return st, ctx.Err()
				}
				st.Errors++
				s.log.Warn("curated: lookup failed", "list", l.ID, "position", pos, "title", it.Title, "err", err)
				continue
			}
			var mid *string
			if id != "" {
				mid = &id
				st.Resolved++
			} else {
				st.Unresolved++
				s.log.Info("curated: not found", "list", l.ID, "position", pos, "title", it.Title, "year", it.Year)
			}
			if _, err := s.pool.Exec(ctx, `
				INSERT INTO curated_items (list_id, position, item_key, media_id, checked_at) VALUES ($1, $2, $3, $4, $5)
				ON CONFLICT (list_id, position) DO UPDATE SET item_key = EXCLUDED.item_key, media_id = EXCLUDED.media_id, checked_at = EXCLUDED.checked_at`,
				l.ID, pos, it.key(), mid, now); err != nil {
				return st, err
			}
		}
	}
	return st, nil
}

func posKey(list string, pos int) string { return list + "#" + strconv.Itoa(pos) }

// transient reports errors worth a retry next pass (TMDB down, timeouts).
func transient(err error) bool {
	return err != nil && !errors.Is(err, catalog.ErrNotFound)
}

// resolveItem returns the item's media id ("" = not found / ambiguous).
// The TMDB id is used when it exists and its year is within ±1 of the
// file's; otherwise a title + year search (exact title match, ambiguity =
// no match). Both languages are stored so titles are localized.
func (s *Service) resolveItem(ctx context.Context, it *Item) (string, error) {
	if it.TMDBID != nil {
		if err := s.pace.Wait(ctx); err != nil {
			return "", err
		}
		m, err := s.cat.EnsureByTMDB(ctx, it.Kind, *it.TMDBID, "en")
		if transient(err) {
			return "", err
		}
		if err == nil && yearOK(m.Year, it.Year) {
			s.otherLang(ctx, it.Kind, *it.TMDBID)
			return m.ID, nil
		}
	}
	for _, year := range []int{it.Year, 0} {
		for _, q := range uniq(it.OriginalTitle, it.Title) {
			if err := s.pace.Wait(ctx); err != nil {
				return "", err
			}
			p, err := s.cat.SearchYear(ctx, q, it.Kind, "en", year)
			if err != nil {
				if transient(err) {
					return "", err
				}
				continue
			}
			if m := MatchResult(it.Title, it.OriginalTitle, it.Year, p.Items); m != nil {
				s.otherLang(ctx, m.Kind, m.TMDBID)
				return m.ID, nil
			}
		}
	}
	return "", nil
}

// otherLang stores the Russian translation too (best effort).
func (s *Service) otherLang(ctx context.Context, kind string, tmdbID int) {
	if err := s.pace.Wait(ctx); err != nil {
		return
	}
	if _, err := s.cat.EnsureByTMDB(ctx, kind, tmdbID, "ru"); err != nil && ctx.Err() == nil {
		s.log.Debug("curated: ru translation failed", "tmdb_id", tmdbID, "err", err)
	}
}

func yearOK(got *int, want int) bool {
	if got == nil {
		return true // TMDB has no date: trust the verified id
	}
	d := *got - want
	return d >= -1 && d <= 1
}

func uniq(vals ...string) []string {
	var out []string
	for _, v := range vals {
		v = strings.TrimSpace(v)
		dup := v == ""
		for _, o := range out {
			dup = dup || o == v
		}
		if !dup {
			out = append(out, v)
		}
	}
	return out
}

var nonWord = regexp.MustCompile(`[^\p{L}\p{N}]+`)

// normTitle folds case, ё, punctuation, "&" and a leading article.
func normTitle(s string) string {
	s = strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(s, "ё", "е"), "&", " and "))
	s = strings.TrimSpace(nonWord.ReplaceAllString(s, " "))
	for _, a := range []string{"the ", "a ", "an "} {
		s = strings.TrimPrefix(s, a)
	}
	return s
}

// MatchResult picks the search result for a list item: normalized title
// equal to its title or original title, year within ±1 (exact preferred).
// Several different titles at the best level → ambiguous (nil): a wrong
// film is never shown.
func MatchResult(title, originalTitle string, year int, results []catalog.MediaSummary) *catalog.MediaSummary {
	want := map[string]bool{}
	for _, t := range []string{title, originalTitle} {
		if n := normTitle(t); n != "" {
			want[n] = true
		}
	}
	var best *catalog.MediaSummary
	bestScore, ambiguous := 0, false
	for i := range results {
		r := &results[i]
		if r.Year == nil || !(want[normTitle(r.Title)] || want[normTitle(r.OriginalTitle)]) {
			continue
		}
		score := 0
		switch d := *r.Year - year; {
		case d == 0:
			score = 2
		case d == 1 || d == -1:
			score = 1
		default:
			continue
		}
		switch {
		case score > bestScore:
			best, bestScore, ambiguous = r, score, false
		case score == bestScore && r.ID != best.ID:
			ambiguous = true
		}
	}
	if ambiguous {
		return nil
	}
	return best
}
