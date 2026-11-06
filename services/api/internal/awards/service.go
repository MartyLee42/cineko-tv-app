// Package awards adds film awards and nominations from Wikidata.
//
// Per title the Wikidata item (found by TMDB id P4947/P4983 or IMDb id
// P345, like the Kinopoisk lookup in internal/ratings) gives P166 (award
// received) and P1411 (nominated for) statements with their year (P585, or
// the P805 event's date) and the award's ru/en labels. Awards are grouped by
// a small curated map of major awards (groups.go): tier 1 = Oscars and the
// main prizes of Cannes/Venice/Berlin, tier 2 = other major awards, tier 3 =
// everything else.
//
// Rows live in media_awards and are refreshed by a background backfill
// (batches of 40 titles, one query per batch, a gentle pace; re-checked after
// 60 days); a title opened in Details that was never checked is fetched in
// the background (the page shows what is stored). Queries go through the
// ratings module's Wikidata client, which serializes and spaces all
// Wikidata traffic and backs off after 429/5xx.
package awards

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"

	"martytv/api/internal/catalog"
	"martytv/api/internal/ratings"
)

const (
	batchSize     = 40 // titles per SPARQL query (≈ 100 rows each at most)
	recheckAfter  = 60 * 24 * time.Hour
	backfillGap   = 15 * time.Second // between backfill batches
	backfillIdle  = 6 * time.Hour    // once the backlog is empty
	backfillStart = 90 * time.Second // after startup (the Kinopoisk backfill starts at 45 s)
	fetchTimeout  = 45 * time.Second
)

// Options configure the service. Wikidata nil = awards are never fetched
// (stored rows are still shown).
type Options struct {
	Pool     *pgxpool.Pool
	Wikidata *ratings.WikidataClient
	Log      *slog.Logger
	// Gap spaces backfill batches (default 15 s).
	Gap time.Duration
}

type Service struct {
	store  *store
	titles *ratings.PGStore
	wd     *ratings.WikidataClient
	log    *slog.Logger
	gap    time.Duration
	sf     singleflight.Group
	bg     sync.WaitGroup
}

func New(o Options) *Service {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Gap == 0 {
		o.Gap = backfillGap
	}
	return &Service{store: &store{pool: o.Pool}, titles: ratings.NewPGStore(o.Pool), wd: o.Wikidata, log: o.Log, gap: o.Gap}
}

// DetailAwards implements catalog.AwardsSource: stored rows, grouped; a
// never-checked title is fetched in the background (shown next time).
func (s *Service) DetailAwards(ctx context.Context, id, lang string) ([]catalog.AwardGroup, error) {
	ok, at, err := s.store.checkedAt(ctx, id)
	if err != nil || !ok {
		return nil, err
	}
	if at == nil && s.wd != nil && s.wd.BackoffRemaining() == 0 {
		s.bg.Add(1)
		go func() {
			defer s.bg.Done()
			_, err, _ := s.sf.Do(id, func() (any, error) {
				ctx, cancel := context.WithTimeout(context.Background(), fetchTimeout)
				defer cancel()
				return nil, s.Fetch(ctx, []string{id})
			})
			if err != nil {
				s.log.Debug("awards: detail fetch failed", "media_id", id, "err", err)
			}
		}()
	}
	rows, err := s.store.rows(ctx, id)
	if err != nil {
		return nil, err
	}
	return Grouped(rows, lang), nil
}

// Badges returns the poster badge of every title with tier-1 wins (one
// query).
func (s *Service) Badges(ctx context.Context, ids []string) (map[string]*catalog.AwardBadge, error) {
	out := map[string]*catalog.AwardBadge{}
	if len(ids) == 0 {
		return out, nil
	}
	counts, err := s.store.tier1Wins(ctx, ids)
	if err != nil {
		return nil, err
	}
	for id, c := range counts {
		if b := pickBadge(c); b != nil {
			out[id] = b
		}
	}
	return out, nil
}

// Fetch looks titles up on Wikidata (one query per batch) and replaces
// their stored awards; titles without usable ids are marked checked
// without a request. On an error the batches done so far are stored.
func (s *Service) Fetch(ctx context.Context, ids []string) error {
	if s.wd == nil || len(ids) == 0 {
		return nil
	}
	titles, err := s.titles.WDTitles(ctx, ids)
	if err != nil {
		return err
	}
	var none []string
	var ask []ratings.WDTitle
	for _, t := range titles {
		if (t.TMDBID > 0 && (t.Kind == "movie" || t.Kind == "series")) || imdbRe.MatchString(t.IMDbID) {
			ask = append(ask, t)
		} else {
			none = append(none, t.ID)
		}
	}
	if err := s.store.save(ctx, none, nil); err != nil {
		return err
	}
	for start := 0; start < len(ask); start += batchSize {
		chunk := ask[start:min(start+batchSize, len(ask))]
		rows, err := s.wd.Select(ctx, buildQuery(chunk))
		if err != nil {
			return err
		}
		found := parse(chunk, rows)
		checked := make([]string, len(chunk))
		n := 0
		for i, t := range chunk {
			checked[i] = t.ID
			n += len(found[t.ID])
		}
		if err := s.store.save(ctx, checked, found); err != nil {
			return err
		}
		lvl := slog.LevelInfo
		if len(chunk) == 1 {
			lvl = slog.LevelDebug
		}
		s.log.Log(ctx, lvl, "awards: wikidata lookup", "titles", len(chunk), "with_awards", len(found), "rows", n)
	}
	return nil
}

// BackfillOnce fetches one batch of titles never checked or checked over
// 60 days ago; it returns how many were looked up (0 = backlog empty).
func (s *Service) BackfillOnce(ctx context.Context) (int, error) {
	if s.wd == nil {
		return 0, nil
	}
	ids, err := s.store.backlog(ctx, recheckAfter, batchSize)
	if err != nil || len(ids) == 0 {
		return 0, err
	}
	return len(ids), s.Fetch(ctx, ids)
}

// Run is the background backfill: one batch per gap, idle once done, and
// longer pauses while Wikidata backs off.
func (s *Service) Run(ctx context.Context) {
	if s.wd == nil || sleep(ctx, backfillStart) != nil {
		return
	}
	for {
		n, err := s.BackfillOnce(ctx)
		wait := s.gap
		switch {
		case ctx.Err() != nil:
			return
		case errors.Is(err, ratings.ErrWikidataBackoff) || s.wd.BackoffRemaining() > 0:
			wait = max(s.wd.BackoffRemaining(), s.gap)
		case err != nil:
			s.log.Warn("awards: backfill failed", "err", err)
			wait = 5 * time.Minute
		case n == 0:
			wait = backfillIdle
		}
		if sleep(ctx, wait) != nil {
			return
		}
	}
}

// Wait blocks until background Details fetches are done (tests).
func (s *Service) Wait() { s.bg.Wait() }

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// WithBadges wraps a ratings source so every annotated summary also gets
// its award badge (TitleRatings.Award) from one extra batched read.
func (s *Service) WithBadges(inner catalog.RatingsSource) catalog.RatingsSource {
	return badged{inner: inner, s: s}
}

type badged struct {
	inner catalog.RatingsSource
	s     *Service
}

func (b badged) Ratings(ctx context.Context, ids []string) (map[string]catalog.TitleRatings, error) {
	rs, err := b.inner.Ratings(ctx, ids)
	if err != nil {
		return nil, err
	}
	if rs == nil {
		rs = map[string]catalog.TitleRatings{}
	}
	badges, err := b.s.Badges(ctx, ids)
	if err != nil {
		b.s.log.WarnContext(ctx, "awards: badges failed", "err", err)
		return rs, nil
	}
	for id, badge := range badges {
		r := rs[id]
		r.Award = badge
		rs[id] = r
	}
	return rs, nil
}

func (b badged) DetailRatings(ctx context.Context, id string) (catalog.TitleRatings, error) {
	r, err := b.inner.DetailRatings(ctx, id)
	if err != nil {
		return r, err
	}
	if badges, err := b.s.Badges(ctx, []string{id}); err == nil {
		r.Award = badges[id]
	}
	return r, nil
}
