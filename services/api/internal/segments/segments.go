// Package segments finds where the intro, the "previously on" recap and the
// end credits are in a film or an episode, so players can offer «Пропустить
// заставку» and «Следующая серия» (and skip them automatically).
//
// Sources, best first (per kind, the first one that knows it wins):
//   - the file's own chapters (playback reads them from ffprobe; exact for
//     that file, see FromChapters);
//   - the online provider's markers (Anilibria);
//   - TheIntroDB (api.theintrodb.org, by TMDB id; films and series);
//   - IntroDB (api.introdb.app, by IMDb id; series only).
//
// The community databases time the original release. A rip with a dub
// studio's logo in front can be a few seconds off, so players keep a
// «Вернуть» (undo) after an automatic skip.
package segments

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"
)

// Kinds, as the contract's SkipMarker names them.
const (
	Opening = "opening" // the intro / title sequence
	Recap   = "recap"   // «Ранее в сериале»
	Ending  = "ending"  // the end credits (and a next-episode preview)
)

// Segment is one range in seconds. End 0 means "to the end of the file".
type Segment struct {
	Kind   string
	Start  float64
	End    float64
	Source string // chapters | provider | theintrodb | introdb
}

// Query names a film or an episode for the databases.
type Query struct {
	Movie           bool
	TMDBID          int
	IMDbID          string
	Season, Episode int
}

func (q Query) key() string {
	k := "tv:"
	if q.Movie {
		k = "movie:"
	}
	return k + strconv.Itoa(q.TMDBID) + ":" + q.IMDbID + ":" + strconv.Itoa(q.Season) + ":" + strconv.Itoa(q.Episode)
}

// ErrNotFound: the database has nothing for this title.
var ErrNotFound = errors.New("segments: not found")

// Provider is one database.
type Provider interface {
	Name() string
	// Fetch returns the known segments, ErrNotFound, or another error.
	Fetch(ctx context.Context, q Query) ([]Segment, error)
}

const (
	foundTTL   = 24 * time.Hour
	missingTTL = 12 * time.Hour
	failedTTL  = 10 * time.Minute
	fetchLimit = 12 * time.Second
	maxCached  = 5000
)

type entry struct {
	segs []Segment
	exp  time.Time
}

// Service looks titles up and caches the answers in memory.
type Service struct {
	pool      *pgxpool.Pool
	providers []Provider
	log       *slog.Logger
	now       func() time.Time

	mu    sync.Mutex
	cache map[string]entry
	group singleflight.Group
}

// New returns a service over the providers (in priority order). A nil pool
// limits it to Lookup (no media ids).
func New(pool *pgxpool.Pool, log *slog.Logger, providers ...Provider) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{pool: pool, providers: providers, log: log, now: time.Now, cache: map[string]entry{}}
}

// Lookup asks every provider (at once) and merges the answers: per kind the
// first provider in priority order that knows it. It waits at most until ctx
// is done; the fetch itself goes on in the background and lands in the cache.
func (s *Service) Lookup(ctx context.Context, q Query) []Segment {
	if s == nil || (q.TMDBID == 0 && q.IMDbID == "") {
		return nil
	}
	k := q.key()
	if segs, ok := s.cached(k); ok {
		return segs
	}
	ch := s.group.DoChan(k, func() (any, error) {
		fctx, cancel := context.WithTimeout(context.Background(), fetchLimit)
		defer cancel()
		segs, ttl := s.fetchAll(fctx, q)
		s.store(k, segs, ttl)
		return segs, nil
	})
	select {
	case r := <-ch:
		segs, _ := r.Val.([]Segment)
		return segs
	case <-ctx.Done():
		return nil
	}
}

func (s *Service) fetchAll(ctx context.Context, q Query) ([]Segment, time.Duration) {
	type res struct {
		segs []Segment
		err  error
	}
	out := make([]res, len(s.providers))
	var wg sync.WaitGroup
	for i, p := range s.providers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			segs, err := p.Fetch(ctx, q)
			out[i] = res{segs, err}
		}()
	}
	wg.Wait()
	var lists [][]Segment
	failed := false
	for i, r := range out {
		switch {
		case r.err == nil:
			lists = append(lists, r.segs)
		case !errors.Is(r.err, ErrNotFound):
			failed = true
			s.log.Info("segments lookup failed", "provider", s.providers[i].Name(), "err", r.err)
		}
	}
	segs := Merge(lists...)
	switch {
	case len(segs) > 0:
		return segs, foundTTL
	case failed:
		return nil, failedTTL
	}
	return nil, missingTTL
}

func (s *Service) cached(k string) ([]Segment, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.cache[k]
	if !ok || s.now().After(e.exp) {
		return nil, false
	}
	return e.segs, true
}

func (s *Service) store(k string, segs []Segment, ttl time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.cache) >= maxCached {
		s.cache = map[string]entry{}
	}
	s.cache[k] = entry{segs, s.now().Add(ttl)}
}

// ForMedia looks up a catalog title (media id) and, for series, the episode
// (episode id, else the season/episode numbers of the file).
func (s *Service) ForMedia(ctx context.Context, mediaID string, episodeID *string, season, episode *int) []Segment {
	if s == nil || s.pool == nil {
		return nil
	}
	q, ok := s.query(ctx, mediaID, episodeID, season, episode)
	if !ok {
		return nil
	}
	return s.Lookup(ctx, q)
}

// Prefetch warms the cache in the background (playback calls it when a
// source is created, so the answer is there when the player starts).
func (s *Service) Prefetch(mediaID string, episodeID *string, season, episode *int) {
	if s == nil || s.pool == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), fetchLimit+3*time.Second)
		defer cancel()
		s.ForMedia(ctx, mediaID, episodeID, season, episode)
	}()
}

func (s *Service) query(ctx context.Context, mediaID string, episodeID *string, season, episode *int) (Query, bool) {
	var (
		kind string
		q    Query
		imdb *string
	)
	err := s.pool.QueryRow(ctx, `
		SELECT m.kind, m.tmdb_id,
		       (SELECT external_id FROM media_external_ids e WHERE e.media_id = m.id AND e.provider = 'imdb')
		FROM media m WHERE m.id = $1`, mediaID).Scan(&kind, &q.TMDBID, &imdb)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) && ctx.Err() == nil {
			s.log.Info("segments: media lookup", "err", err)
		}
		return q, false
	}
	if imdb != nil {
		q.IMDbID = *imdb
	}
	q.Movie = kind == "movie"
	if q.Movie {
		return q, true
	}
	if episodeID != nil && *episodeID != "" {
		if err := s.pool.QueryRow(ctx, `SELECT season_number, episode_number FROM episodes WHERE id = $1 AND media_id = $2`,
			*episodeID, mediaID).Scan(&q.Season, &q.Episode); err == nil {
			return q, true
		}
	}
	if season != nil && episode != nil && *season >= 0 && *episode > 0 {
		q.Season, q.Episode = *season, *episode
		return q, true
	}
	return q, false
}

// Merge combines lists in priority order: per kind, the first list that has
// it wins. Junk (negative, empty or under 3 s) is dropped.
func Merge(lists ...[]Segment) []Segment {
	var out []Segment
	have := map[string]bool{}
	for _, l := range lists {
		got := map[string]bool{}
		for _, sg := range l {
			if have[sg.Kind] || !valid(sg) {
				continue
			}
			out = append(out, sg)
			got[sg.Kind] = true
		}
		for k := range got {
			have[k] = true
		}
	}
	return out
}

func valid(sg Segment) bool {
	switch sg.Kind {
	case Opening, Recap, Ending:
	default:
		return false
	}
	if sg.Start < 0 || sg.End < 0 {
		return false
	}
	return sg.End == 0 || sg.End-sg.Start >= 3
}

// Fit clamps the segments to a file of the given length (seconds; 0 =
// unknown): an open end becomes the length, and a segment that starts past
// the end (another cut of the title) is dropped. With an unknown length an
// open end stays 0.
func Fit(segs []Segment, length float64) []Segment {
	var out []Segment
	for _, sg := range segs {
		if length > 0 {
			if sg.Start >= length-3 {
				continue
			}
			if sg.End == 0 || sg.End > length {
				sg.End = length
			}
			if sg.End-sg.Start < 3 {
				continue
			}
		}
		out = append(out, sg)
	}
	return out
}
