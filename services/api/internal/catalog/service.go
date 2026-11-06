// Package catalog serves the TMDB-backed media catalog: home rows, curated
// lists, discover, search, details, seasons and watch providers.
//
// Every title returned to a client is first materialized into the media
// table, so it carries a stable Cineko UUID (the same TMDB title always gets
// the same id, whatever the language, endpoint or device). TMDB list/search
// responses are cached verbatim in tmdb_cache; full details, seasons and
// episodes are normalized into tables and refreshed in the background when
// they get old.
package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"

	"martytv/api/internal/config"
	"martytv/api/internal/integrations/tmdb"
)

// Cache lifetimes. Lists change daily at most; search results are volatile
// enough to expire sooner; genre names practically never change.
const (
	ttlList     = 6 * time.Hour
	ttlSearch   = 1 * time.Hour
	ttlGenres   = 7 * 24 * time.Hour
	ttlRelated  = 24 * time.Hour
	ttlProvider = 24 * time.Hour
	// Details, seasons and episodes older than this are served immediately
	// and refreshed in the background.
	detailMaxAge = 7 * 24 * time.Hour
	// Expired cache rows are kept this long as a fallback while TMDB is down.
	staleKeep = 7 * 24 * time.Hour

	maxPage = 500 // TMDB rejects page > 500
	// Ratings from fewer votes are noise; the contract says null.
	minVotesForRating = 3
)

var (
	// ErrNotFound is an unknown media id/season (maps to 404).
	ErrNotFound = errors.New("catalog: not found")
	// ErrUpstream wraps TMDB failures (maps to 502).
	ErrUpstream = errors.New("catalog: TMDB request failed")
)

// Attribution is required by the TMDB API terms wherever TMDB data is shown.
const Attribution = "This product uses the TMDB API but is not endorsed or certified by TMDB."

type Service struct {
	pool    *pgxpool.Pool
	tmdb    *tmdb.Client
	cfg     config.CatalogConfig
	tmdbCfg config.TMDBConfig
	log     *slog.Logger
	// refresh dedupes detail/season loads (first loads and background refreshes).
	refresh singleflight.Group
	// bg tracks background refreshes so tests and shutdown can wait for them.
	bg sync.WaitGroup
}

func NewService(pool *pgxpool.Pool, client *tmdb.Client, tmdbCfg config.TMDBConfig, cfg config.CatalogConfig, log *slog.Logger) *Service {
	return &Service{pool: pool, tmdb: client, cfg: cfg, tmdbCfg: tmdbCfg, log: log}
}

// Available reports whether TMDB is configured.
func (s *Service) Available() bool { return s.tmdb.Configured() }

// Config is GET /catalog/config.
func (s *Service) Config() Config {
	base := s.tmdbCfg.ImageBaseURL
	if s.cfg.ImageProxy {
		base = "/api/v1/images"
	}
	// Only sizes the image proxy accepts (see imageSizes), so URLs built from
	// this config work in both direct and proxy mode.
	return Config{
		ImageBaseURL:  base,
		PosterSizes:   []string{"w92", "w154", "w185", "w342", "w500", "w780", "original"},
		BackdropSizes: []string{"w300", "w780", "w1280", "original"},
		ProfileSizes:  []string{"w185", "h632", "original"},
		StillSizes:    []string{"w92", "w185", "w300", "original"},
		Attribution:   Attribution,
		Region:        s.cfg.Region,
		Available:     s.Available(),
	}
}

// fetch returns a TMDB response through tmdb_cache. fresh reports whether
// the body came from TMDB just now (callers then refresh stored rows). With
// force the cache is bypassed (background warming). When TMDB fails, an
// expired-but-kept cache row is served instead of an error.
func (s *Service) fetch(ctx context.Context, path string, q url.Values, ttl time.Duration, force bool) (body []byte, fresh bool, err error) {
	key := path + "?" + q.Encode() // Encode sorts keys: a stable cache key
	var cached []byte
	var valid bool
	err = s.pool.QueryRow(ctx, `SELECT body, expires_at > now() FROM tmdb_cache WHERE key = $1`, key).Scan(&cached, &valid)
	if err != nil && !isNoRows(err) {
		return nil, false, err
	}
	if valid && !force {
		return cached, false, nil
	}
	body, err = s.tmdb.Get(ctx, path, q)
	if err != nil {
		if errors.Is(err, tmdb.ErrNotFound) || ctx.Err() != nil {
			return nil, false, err
		}
		if cached != nil {
			s.log.WarnContext(ctx, "tmdb failed; serving stale cache", "path", path, "err", err)
			return cached, false, nil
		}
		return nil, false, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO tmdb_cache (key, body, fetched_at, expires_at) VALUES ($1, $2, now(), now() + $3::interval)
		ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
		key, json.RawMessage(body), ttl)
	if err != nil {
		return nil, false, err
	}
	return body, true, nil
}

// page decodes a TMDB page and materializes its titles. defKind is used for
// endpoints whose results carry no media_type.
func (s *Service) page(ctx context.Context, body []byte, fresh bool, lang, defKind string) (*MediaPage, error) {
	var p tmdb.Page
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrUpstream, err)
	}
	items, err := s.summaries(ctx, lang, p.Results, defKind, fresh)
	if err != nil {
		return nil, err
	}
	return &MediaPage{
		Items:        items,
		Page:         max(p.Page, 1),
		TotalPages:   min(p.TotalPages, maxPage),
		TotalResults: p.TotalResults,
	}, nil
}

// summaries materializes list items (people dropped) and returns them in
// order with their internal ids.
func (s *Service) summaries(ctx context.Context, lang string, results []tmdb.ListItem, defKind string, fresh bool) ([]MediaSummary, error) {
	rows := make([]listRow, 0, len(results))
	for _, it := range results {
		kind := defKind
		if it.MediaType != "" {
			kind = tmdb.Kind(it.MediaType)
		}
		if kind == "" || it.ID <= 0 {
			continue // people in multi search / trending
		}
		rows = append(rows, toListRow(kind, it))
	}
	ids, err := s.materialize(ctx, lang, rows, fresh)
	if err != nil {
		return nil, err
	}
	out := make([]MediaSummary, 0, len(rows))
	for _, r := range rows {
		id, ok := ids[mediaKey{r.kind, r.tmdbID}]
		if !ok {
			return nil, fmt.Errorf("catalog: media %s/%d not materialized", r.kind, r.tmdbID)
		}
		out = append(out, MediaSummary{
			ID: id, Kind: r.kind, TMDBID: r.tmdbID,
			Title: r.title, OriginalTitle: r.originalTitle,
			Year: r.year, ReleaseDate: r.date, Overview: r.overview,
			PosterPath: r.poster, BackdropPath: r.backdrop,
			Rating: rating(r.voteAverage, r.voteCount), VoteCount: r.voteCount,
			GenreIDs: nonNil(r.genreIDs), origLang: r.originalLanguage,
		})
	}
	return out, nil
}

type listRow struct {
	kind                    string
	tmdbID                  int
	title, originalTitle    string
	originalLanguage        string
	overview                string
	date                    *string
	year                    *int
	poster, backdrop        *string
	voteAverage, popularity float64
	voteCount               int
	genreIDs                []int
}

func toListRow(kind string, it tmdb.ListItem) listRow {
	r := listRow{
		kind: kind, tmdbID: it.ID, overview: it.Overview, originalLanguage: it.OriginalLanguage,
		poster: emptyNil(it.PosterPath), backdrop: emptyNil(it.BackdropPath),
		voteAverage: it.VoteAverage, voteCount: it.VoteCount, popularity: it.Popularity, genreIDs: it.GenreIDs,
	}
	date := it.ReleaseDate
	r.title, r.originalTitle = it.Title, it.OriginalTitle
	if kind == "series" {
		r.title, r.originalTitle, date = it.Name, it.OriginalName, it.FirstAirDate
	}
	if r.title == "" {
		r.title = r.originalTitle
	}
	r.date, r.year = parseDate(date)
	return r
}

// ---- lists ----

// listSpec maps a contract list key to its TMDB endpoint and allowed kinds.
var listKinds = map[string][]string{
	"trending":     {"all", "movie", "series"},
	"popular":      {"movie", "series"},
	"top_rated":    {"movie", "series"},
	"upcoming":     {"movie"},
	"now_playing":  {"movie"},
	"on_the_air":   {"series"},
	"airing_today": {"series"},
}

func listPath(list, kind string) string {
	if list == "trending" {
		t := "all"
		if kind != "all" {
			t = tmdb.MediaType(kind)
		}
		return "/trending/" + t + "/week"
	}
	return "/" + tmdb.MediaType(kind) + "/" + list
}

// List returns one page of a curated list. Callers validate list/kind.
func (s *Service) List(ctx context.Context, list, kind, lang string, page int, force bool) (*MediaPage, error) {
	q := url.Values{"language": {tmdb.Language(lang)}, "page": {strconv.Itoa(page)}}
	body, fresh, err := s.fetch(ctx, listPath(list, kind), q, ttlList, force)
	if err != nil {
		return nil, err
	}
	defKind := kind
	if kind == "all" {
		defKind = ""
	}
	return s.page(ctx, body, fresh, lang, defKind)
}

var homeRows = []struct{ key, kind, list string }{
	{"trending", "all", "trending"},
	{"popular_movies", "movie", "popular"},
	{"popular_series", "series", "popular"},
	{"top_rated_movies", "movie", "top_rated"},
	{"top_rated_series", "series", "top_rated"},
	{"upcoming_movies", "movie", "upcoming"},
	{"on_the_air_series", "series", "on_the_air"},
}

// Home returns the home rows in a fixed order. A row whose list fails is
// left out so one TMDB hiccup doesn't blank the whole screen; if every row
// fails the error is returned.
func (s *Service) Home(ctx context.Context, lang string, force bool) ([]HomeRow, error) {
	results := make([]*MediaPage, len(homeRows))
	errs := make([]error, len(homeRows))
	var wg sync.WaitGroup
	for i, r := range homeRows {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = s.List(ctx, r.list, r.kind, lang, 1, force)
		}()
	}
	wg.Wait()
	rows := make([]HomeRow, 0, len(homeRows))
	var firstErr error
	for i, r := range homeRows {
		if errs[i] != nil {
			if firstErr == nil {
				firstErr = errs[i]
			}
			s.log.WarnContext(ctx, "home row failed", "row", r.key, "err", errs[i])
			continue
		}
		rows = append(rows, HomeRow{Key: r.key, Kind: r.kind, List: r.list, Items: results[i].Items})
	}
	if len(rows) == 0 && firstErr != nil {
		return nil, firstErr
	}
	return rows, nil
}

// ---- discover ----

type DiscoverParams struct {
	Kind                   string
	Genres                 []int
	YearFrom, YearTo       *int
	RuntimeMin, RuntimeMax *int
	OriginalLanguage       string
	RatingMin              *float64
	Sort                   string
	Page                   int
	Lang                   string
	// Internal-only filters (used by internal/foryou; /catalog/discover
	// does not expose them). AnyGenres/WithKeywords are OR lists.
	AnyGenres, WithoutGenres, WithKeywords []int
	VoteCountMin, VoteCountMax             *int
}

// Rating sorts and filters need a vote floor, or 10.0 titles with two votes
// float to the top.
const (
	ratingSortMinVotes   = 50
	ratingFilterMinVotes = 10
)

// discoverQuery maps contract params to TMDB /discover parameters.
func discoverQuery(p DiscoverParams, today time.Time) url.Values {
	q := url.Values{
		"language":      {tmdb.Language(p.Lang)},
		"page":          {strconv.Itoa(p.Page)},
		"include_adult": {"false"},
	}
	dateField := "primary_release_date"
	if p.Kind == "series" {
		dateField = "first_air_date"
	}
	if len(p.Genres) > 0 {
		s := ""
		for i, g := range p.Genres {
			if i > 0 {
				s += "," // comma = AND in TMDB (pipe would be OR)
			}
			s += strconv.Itoa(g)
		}
		q.Set("with_genres", s)
	}
	if p.YearFrom != nil {
		q.Set(dateField+".gte", fmt.Sprintf("%04d-01-01", *p.YearFrom))
	}
	if p.YearTo != nil {
		q.Set(dateField+".lte", fmt.Sprintf("%04d-12-31", *p.YearTo))
	}
	if p.RuntimeMin != nil {
		q.Set("with_runtime.gte", strconv.Itoa(*p.RuntimeMin))
	}
	if p.RuntimeMax != nil {
		q.Set("with_runtime.lte", strconv.Itoa(*p.RuntimeMax))
	}
	if p.OriginalLanguage != "" {
		q.Set("with_original_language", p.OriginalLanguage)
	}
	if p.RatingMin != nil {
		q.Set("vote_average.gte", strconv.FormatFloat(*p.RatingMin, 'f', -1, 64))
		q.Set("vote_count.gte", strconv.Itoa(ratingFilterMinVotes))
	}
	switch p.Sort {
	case "rating":
		q.Set("sort_by", "vote_average.desc")
		q.Set("vote_count.gte", strconv.Itoa(ratingSortMinVotes))
	case "release_date":
		q.Set("sort_by", dateField+".desc")
		// Newest first would otherwise start with announced titles years away.
		if p.YearTo == nil {
			q.Set(dateField+".lte", today.Format("2006-01-02"))
		}
	case "title":
		if p.Kind == "series" {
			q.Set("sort_by", "name.asc")
		} else {
			q.Set("sort_by", "original_title.asc")
		}
	default:
		q.Set("sort_by", "popularity.desc")
	}
	ids := func(list []int, sep string) string {
		parts := make([]string, len(list))
		for i, v := range list {
			parts[i] = strconv.Itoa(v)
		}
		return strings.Join(parts, sep)
	}
	if len(p.AnyGenres) > 0 {
		q.Set("with_genres", ids(p.AnyGenres, "|"))
	}
	if len(p.WithoutGenres) > 0 {
		q.Set("without_genres", ids(p.WithoutGenres, ","))
	}
	if len(p.WithKeywords) > 0 {
		q.Set("with_keywords", ids(p.WithKeywords, "|"))
	}
	if p.VoteCountMin != nil {
		q.Set("vote_count.gte", strconv.Itoa(*p.VoteCountMin))
	}
	if p.VoteCountMax != nil {
		q.Set("vote_count.lte", strconv.Itoa(*p.VoteCountMax))
	}
	return q
}

func (s *Service) Discover(ctx context.Context, p DiscoverParams) (*MediaPage, error) {
	body, fresh, err := s.fetch(ctx, "/discover/"+tmdb.MediaType(p.Kind), discoverQuery(p, time.Now().UTC()), ttlList, false)
	if err != nil {
		return nil, err
	}
	return s.page(ctx, body, fresh, p.Lang, p.Kind)
}

// ---- search ----

// Search matches original, translated and alternative titles (TMDB does this
// for any language, so Cyrillic queries work with lang=en too). kind=all uses
// /search/multi and drops people, so a page may hold fewer than 20 items.
func (s *Service) Search(ctx context.Context, query, kind, lang string, page int) (*MediaPage, error) {
	q := url.Values{
		"query":         {query},
		"language":      {tmdb.Language(lang)},
		"page":          {strconv.Itoa(page)},
		"include_adult": {"false"},
	}
	path, defKind := "/search/multi", ""
	if kind != "all" {
		path, defKind = "/search/"+tmdb.MediaType(kind), kind
	}
	body, fresh, err := s.fetch(ctx, path, q, ttlSearch, false)
	if err != nil {
		return nil, err
	}
	return s.page(ctx, body, fresh, lang, defKind)
}

// SearchYear is a single-kind title search narrowed to a release year
// (movies: any release that year; series: first air year). Used to resolve
// AI-suggested titles (internal/foryou). year <= 0 searches without a year.
func (s *Service) SearchYear(ctx context.Context, query, kind, lang string, year int) (*MediaPage, error) {
	q := url.Values{
		"query":         {query},
		"language":      {tmdb.Language(lang)},
		"page":          {"1"},
		"include_adult": {"false"},
	}
	if year > 0 {
		if kind == "series" {
			q.Set("first_air_date_year", strconv.Itoa(year))
		} else {
			q.Set("year", strconv.Itoa(year))
		}
	}
	body, fresh, err := s.fetch(ctx, "/search/"+tmdb.MediaType(kind), q, ttlList, false)
	if err != nil {
		return nil, err
	}
	return s.page(ctx, body, fresh, lang, kind)
}

// PersonMovies is a person's released movies from /person/{id}/movie_credits
// (internal/foryou filmography rows): directed ones for job "Director",
// else leading roles (cast order < 8). Sorted by popularity, at most 40,
// with at least minVotes votes.
func (s *Service) PersonMovies(ctx context.Context, personTMDBID int, job, lang string, minVotes int) ([]MediaSummary, error) {
	body, fresh, err := s.fetch(ctx, fmt.Sprintf("/person/%d/movie_credits", personTMDBID),
		url.Values{"language": {tmdb.Language(lang)}}, ttlRelated, false)
	if errors.Is(err, tmdb.ErrNotFound) {
		return []MediaSummary{}, nil
	}
	if err != nil {
		return nil, err
	}
	var credits struct {
		Cast []struct {
			tmdb.ListItem
			Order int `json:"order"`
		} `json:"cast"`
		Crew []struct {
			tmdb.ListItem
			Job string `json:"job"`
		} `json:"crew"`
	}
	if err := json.Unmarshal(body, &credits); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrUpstream, err)
	}
	today := time.Now().UTC().Format("2006-01-02")
	var items []tmdb.ListItem
	seen := map[int]bool{}
	keep := func(it tmdb.ListItem) {
		if seen[it.ID] || it.ReleaseDate == "" || it.ReleaseDate > today || it.VoteCount < minVotes {
			return
		}
		seen[it.ID] = true
		items = append(items, it)
	}
	if job == "Director" {
		for _, c := range credits.Crew {
			if c.Job == "Director" {
				keep(c.ListItem)
			}
		}
	} else {
		for _, c := range credits.Cast {
			if c.Order < 8 {
				keep(c.ListItem)
			}
		}
	}
	slices.SortStableFunc(items, func(a, b tmdb.ListItem) int {
		switch {
		case a.Popularity > b.Popularity:
			return -1
		case a.Popularity < b.Popularity:
			return 1
		}
		return a.ID - b.ID
	})
	if len(items) > 40 {
		items = items[:40]
	}
	return s.summaries(ctx, lang, items, "movie", fresh)
}

// ---- genres ----

func (s *Service) Genres(ctx context.Context, kind, lang string) ([]Genre, error) {
	body, fresh, err := s.fetch(ctx, "/genre/"+tmdb.MediaType(kind)+"/list", url.Values{"language": {tmdb.Language(lang)}}, ttlGenres, false)
	if err != nil {
		return nil, err
	}
	var gl tmdb.GenreList
	if err := json.Unmarshal(body, &gl); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrUpstream, err)
	}
	if fresh {
		if err := s.upsertGenres(ctx, s.pool, lang, gl.Genres); err != nil {
			return nil, err
		}
	}
	out := make([]Genre, 0, len(gl.Genres))
	for _, g := range gl.Genres {
		out = append(out, Genre{ID: g.ID, Name: g.Name})
	}
	return out, nil
}

// ---- related ----

// Related is /media/{id}/similar or /recommendations.
func (s *Service) Related(ctx context.Context, id, which, lang string, page int) (*MediaPage, error) {
	ref, err := s.ref(ctx, id)
	if err != nil {
		return nil, err
	}
	q := url.Values{"language": {tmdb.Language(lang)}, "page": {strconv.Itoa(page)}}
	body, fresh, err := s.fetch(ctx, fmt.Sprintf("/%s/%d/%s", tmdb.MediaType(ref.kind), ref.tmdbID, which), q, ttlRelated, false)
	if errors.Is(err, tmdb.ErrNotFound) {
		return &MediaPage{Items: []MediaSummary{}, Page: page}, nil
	}
	if err != nil {
		return nil, err
	}
	return s.page(ctx, body, fresh, lang, ref.kind)
}

// ---- providers ----

func (s *Service) Providers(ctx context.Context, id, region string) (*Providers, error) {
	ref, err := s.ref(ctx, id)
	if err != nil {
		return nil, err
	}
	out := &Providers{Region: region, Flatrate: []Provider{}, Rent: []Provider{}, Buy: []Provider{}}
	body, _, err := s.fetch(ctx, fmt.Sprintf("/%s/%d/watch/providers", tmdb.MediaType(ref.kind), ref.tmdbID), url.Values{}, ttlProvider, false)
	if errors.Is(err, tmdb.ErrNotFound) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	var wp tmdb.WatchProviders
	if err := json.Unmarshal(body, &wp); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrUpstream, err)
	}
	rp, ok := wp.Results[region]
	if !ok {
		return out, nil
	}
	out.Link = emptyNil(rp.Link)
	out.Flatrate, out.Rent, out.Buy = providers(rp.Flatrate), providers(rp.Rent), providers(rp.Buy)
	return out, nil
}

func providers(in []tmdb.Provider) []Provider {
	sorted := append([]tmdb.Provider(nil), in...)
	// Stable insertion sort by display priority (lists are short).
	for i := 1; i < len(sorted); i++ {
		for j := i; j > 0 && sorted[j].DisplayPriority < sorted[j-1].DisplayPriority; j-- {
			sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
		}
	}
	out := make([]Provider, 0, len(sorted))
	for _, p := range sorted {
		out = append(out, Provider{ProviderID: p.ProviderID, Name: p.ProviderName, LogoPath: emptyNil(p.LogoPath)})
	}
	return out
}

// ---- helpers ----

func rating(avg float64, votes int) *float64 {
	if votes < minVotesForRating {
		return nil
	}
	r := math.Round(avg*100) / 100
	return &r
}

// parseDate turns TMDB's "YYYY-MM-DD" (or "") into a nullable date and year.
func parseDate(s string) (*string, *int) {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return nil, nil
	}
	y := t.Year()
	return &s, &y
}

func emptyNil(s *string) *string {
	if s == nil || *s == "" {
		return nil
	}
	return s
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
