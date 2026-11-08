package releases

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"

	"martytv/api/internal/catalog"
	"martytv/api/internal/config"
	"martytv/api/internal/db"
	"martytv/api/internal/integrations/prowlarr"
	"martytv/api/internal/integrations/tmdb"
	"martytv/api/internal/sources"
)

const (
	// listTTL is how long a search is served from release_search_cache.
	listTTL = 30 * time.Minute
	// staleTTL keeps expired lists as a fallback while Prowlarr is down.
	staleTTL = 24 * time.Hour
	// resolveTTL is how long a shown release id stays resolvable.
	resolveTTL = 24 * time.Hour
	// searchTimeout bounds one search (all queries run in parallel).
	searchTimeout = 25 * time.Second
	// maxStored caps accepted candidates kept per search; maxItems caps the
	// list returned to clients.
	maxStored = 150
	maxItems  = 100
	// liveSearches bounds concurrent Prowlarr searches across all users.
	liveSearches = 3
)

var (
	// ErrUnavailable means no torrent provider is configured/enabled (503).
	ErrUnavailable = errors.New("releases: no torrent provider configured")
	// ErrUpstream means every torrent provider failed and nothing is cached (502).
	ErrUpstream = errors.New("releases: torrent providers unreachable")
	// ErrNotFound is an unknown media id (404).
	ErrNotFound = errors.New("releases: media not found")
	// ErrCatalog means the title's metadata couldn't be loaded from TMDB (502).
	ErrCatalog = errors.New("releases: catalog unavailable")
)

// FieldError is a request that doesn't fit the media (422).
type FieldError struct{ Field, Message string }

func (e *FieldError) Error() string { return e.Field + ": " + e.Message }

// IndexerError is one entry of ReleaseList.indexer_errors.
type IndexerError struct {
	Indexer string `json:"indexer"`
	Message string `json:"message"`
}

// ReleaseList is the contract's ReleaseList.
type ReleaseList struct {
	Items         []Release      `json:"items"`
	SearchedAt    time.Time      `json:"searched_at"`
	Cached        bool           `json:"cached"`
	IndexerErrors []IndexerError `json:"indexer_errors"`
	// Device is the playback profile applied to the ranking (nil = none).
	Device *DeviceFit `json:"device"`
}

// ListParams selects what to search and how to rank it.
type ListParams struct {
	MediaID string
	Season  *int
	Episode *int
	Refresh bool
	Prefs   Prefs
	// Query replaces the automatic queries («Уточнить»: the user's own text).
	Query string
	// Loose also accepts results rejected only as uncertain (low confidence,
	// year/version differences; with Query, also title mismatches). Hard
	// rejects (not video, IMDb/sequel/season/episode mismatch) stay out.
	Loose bool
	// Sources restricts the torrent providers (profile setting); nil = all.
	Sources *sources.Selection
}

// Service searches, matches, caches and ranks releases.
type Service struct {
	pool     *pgxpool.Pool
	cfg      *config.Config
	catalog  *catalog.Service
	log      *slog.Logger
	prowlarr *ProwlarrProvider
	src      *sources.Registry
	tmdb     *tmdb.Client
	group    singleflight.Group
	sem      chan struct{}
	now      func() time.Time

	mu  sync.Mutex
	alt map[string]altEntry
}

type altEntry struct {
	titles []string
	at     time.Time
}

func NewService(pool *pgxpool.Pool, cfg *config.Config, cat *catalog.Service, log *slog.Logger) *Service {
	return &Service{
		pool: pool, cfg: cfg, catalog: cat, log: log,
		prowlarr: NewProwlarrProvider(cfg.Prowlarr),
		tmdb:     tmdb.New(cfg.TMDB),
		sem:      make(chan struct{}, liveSearches),
		now:      time.Now,
		alt:      map[string]altEntry{},
	}
}

// SetSources makes the service search the registry's torrent providers
// (without it, only its own Prowlarr provider is used).
func (s *Service) SetSources(r *sources.Registry) {
	s.src = r
	if p, ok := r.Provider(prowlarrRef.ID); ok {
		if pp, ok := p.(*ProwlarrProvider); ok {
			s.prowlarr = pp
		}
	}
}

// providers returns the usable torrent providers a selection allows.
func (s *Service) providers(ctx context.Context, sel sources.Selection) []sources.TorrentProvider {
	if s.src != nil {
		return s.src.TorrentProviders(ctx, sel)
	}
	if s.prowlarr.Info().Configured && sel.Allows(prowlarrRef.ID) {
		return []sources.TorrentProvider{s.prowlarr}
	}
	return nil
}

// Available reports whether any torrent provider is configured and enabled.
func (s *Service) Available() bool {
	return len(s.providers(context.Background(), sources.AllSources)) > 0
}

// ---------------------------------------------------------------- target

type targetInfo struct {
	target       *Target
	ru, en, orig string
	kind         string
	runtime      int // minutes per movie/episode (0 = unknown)
}

func (s *Service) loadTarget(ctx context.Context, mediaID string, season, episode *int) (*targetInfo, error) {
	ru, errRU := s.catalog.Detail(ctx, mediaID, "ru")
	en, errEN := s.catalog.Detail(ctx, mediaID, "en")
	if errRU != nil && errEN != nil {
		if errors.Is(errRU, catalog.ErrNotFound) || errors.Is(errEN, catalog.ErrNotFound) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("%w: %v", ErrCatalog, errRU)
	}
	d := ru
	if d == nil {
		d = en
	}
	info := &targetInfo{kind: d.Kind, orig: d.OriginalTitle}
	if d.Runtime != nil && *d.Runtime > 0 {
		info.runtime = *d.Runtime
	}
	if ru != nil {
		info.ru = ru.Title
	}
	if en != nil {
		info.en = en.Title
	}
	if info.ru == "" {
		info.ru = info.en
	}
	if info.en == "" {
		info.en = info.orig
	}
	if d.Kind == "movie" && season != nil {
		return nil, &FieldError{"season", "only series have seasons"}
	}
	t := &Target{
		Kind:             d.Kind,
		Titles:           nonEmpty(info.orig, info.ru, info.en),
		OriginalLanguage: d.OriginalLanguage,
		Countries:        d.Countries,
		Season:           season,
		Episode:          episode,
	}
	if d.Year != nil {
		t.Year = *d.Year
	}
	if d.ExternalIDs.IMDb != nil {
		t.IMDbID = *d.ExternalIDs.IMDb
	}
	if d.LastAirDate != nil && len(*d.LastAirDate) >= 4 {
		t.LastYear, _ = strconv.Atoi((*d.LastAirDate)[:4])
	}
	known := false
	for _, se := range d.Seasons {
		if se.SeasonNumber > 0 {
			t.SeasonCount++
		}
		if season != nil && se.SeasonNumber == *season {
			known = true
			t.SeasonEpisodes = se.EpisodeCount
			if se.AirDate != nil && len(*se.AirDate) >= 4 {
				t.SeasonYear, _ = strconv.Atoi((*se.AirDate)[:4])
			}
		}
	}
	if season != nil && len(d.Seasons) > 0 && !known {
		return nil, &FieldError{"season", "this series has no such season"}
	}
	t.AltTitles = s.altTitles(ctx, d.Kind, d.TMDBID)
	info.target = t
	return info, nil
}

func nonEmpty(vals ...string) []string {
	var out []string
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			out = append(out, v)
		}
	}
	return out
}

// altTitles returns TMDB alternative titles in Latin or Cyrillic script
// (the only scripts RU trackers use), cached in memory for a day.
func (s *Service) altTitles(ctx context.Context, kind string, tmdbID int) []string {
	if !s.tmdb.Configured() || tmdbID == 0 {
		return nil
	}
	key := kind + ":" + strconv.Itoa(tmdbID)
	s.mu.Lock()
	e, ok := s.alt[key]
	s.mu.Unlock()
	if ok && s.now().Sub(e.at) < 24*time.Hour {
		return e.titles
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	alts, err := s.tmdb.AlternativeTitles(ctx, kind, tmdbID)
	if err != nil {
		s.log.Warn("tmdb alternative titles failed", "tmdb_id", tmdbID, "err", err)
		return nil
	}
	var out []string
	for _, a := range alts {
		if sc := script(a.Title); sc != "" && !slices.Contains(out, a.Title) && len(out) < 60 {
			out = append(out, a.Title)
		}
	}
	s.mu.Lock()
	if len(s.alt) > 2000 {
		s.alt = map[string]altEntry{}
	}
	s.alt[key] = altEntry{titles: out, at: s.now()}
	s.mu.Unlock()
	return out
}

// ---------------------------------------------------------------- list

type cacheBody struct {
	Candidates    []candidate    `json:"candidates"`
	IndexerErrors []IndexerError `json:"indexer_errors"`
}

func cacheKey(mediaID string, season, episode *int) string {
	k := mediaID
	if season != nil {
		k += ":s" + strconv.Itoa(*season)
	}
	if episode != nil {
		k += ":e" + strconv.Itoa(*episode)
	}
	return k
}

// List returns ranked releases for a title.
func (s *Service) List(ctx context.Context, p ListParams) (*ReleaseList, error) {
	if !s.Available() {
		return nil, ErrUnavailable
	}
	if p.Episode != nil && p.Season == nil {
		return nil, &FieldError{"episode", "requires season"}
	}
	info, err := s.loadTarget(ctx, p.MediaID, p.Season, p.Episode)
	if err != nil {
		return nil, err
	}
	if p.Prefs.RuntimeSeconds == 0 {
		p.Prefs.RuntimeSeconds = info.runtime * 60
	}
	sel := sources.AllSources
	if p.Sources != nil {
		sel = *p.Sources
	}
	provs := s.providers(ctx, sel)
	if len(provs) == 0 {
		// The profile switched every torrent provider off.
		return &ReleaseList{Items: []Release{}, SearchedAt: s.now().UTC(), IndexerErrors: []IndexerError{}}, nil
	}
	key := cacheKey(p.MediaID, p.Season, p.Episode)
	for i, pr := range provs {
		sep := ","
		if i == 0 {
			sep = ":src="
		}
		key += sep + pr.Info().ID
	}
	if p.Query != "" || p.Loose {
		sum := sha256.Sum256([]byte(strings.ToLower(p.Query)))
		key += ":q" + hex.EncodeToString(sum[:6])
		if p.Loose {
			key += ":loose"
		}
	}
	if !p.Refresh {
		if body, at, ok := s.readCache(ctx, key, false); ok {
			return s.respond(body, at, true, p.Prefs), nil
		}
	}
	ch := s.group.DoChan(key, func() (any, error) {
		// Shared by concurrent callers: not tied to one request's lifetime.
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), searchTimeout+5*time.Second)
		defer cancel()
		return s.search(sctx, key, p, info, provs)
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case r := <-ch:
		if r.Err != nil {
			if errors.Is(r.Err, ErrUpstream) {
				if body, at, ok := s.readCache(ctx, key, true); ok {
					for _, pr := range provs {
						body.IndexerErrors = append(body.IndexerErrors, IndexerError{pr.Info().Title, "search failed; showing cached results"})
					}
					return s.respond(body, at, true, p.Prefs), nil
				}
			}
			return nil, r.Err
		}
		res := r.Val.(*searchResult)
		return s.respond(res.body, res.at, false, p.Prefs), nil
	}
}

func (s *Service) respond(body *cacheBody, at time.Time, cached bool, prefs Prefs) *ReleaseList {
	for i := range body.Candidates {
		if body.Candidates[i].Release.Provider.ID == "" { // cached before sources existed
			body.Candidates[i].Release.Provider = prowlarrRef
		}
	}
	items := Rank(body.Candidates, prefs)
	if len(items) > maxItems {
		items = items[:maxItems]
	}
	errs := body.IndexerErrors
	if errs == nil {
		errs = []IndexerError{}
	}
	return &ReleaseList{Items: items, SearchedAt: at.UTC(), Cached: cached, IndexerErrors: errs}
}

func (s *Service) readCache(ctx context.Context, key string, stale bool) (*cacheBody, time.Time, bool) {
	limit := s.now()
	if stale {
		limit = limit.Add(-staleTTL)
	}
	var raw []byte
	var at time.Time
	err := s.pool.QueryRow(ctx, `SELECT body, fetched_at FROM release_search_cache WHERE key = $1 AND expires_at > $2`,
		key, limit).Scan(&raw, &at)
	if err != nil {
		if !db.IsNoRows(err) {
			s.log.Warn("release cache read failed", "err", err)
		}
		return nil, time.Time{}, false
	}
	var body cacheBody
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, time.Time{}, false
	}
	return &body, at, true
}

// ---------------------------------------------------------------- search

type searchResult struct {
	body *cacheBody
	at   time.Time
}

type queryOutcome struct {
	results []prowlarr.Release
	err     error
}

// tagged is a raw torrent plus the provider that returned it.
type tagged struct {
	sources.Torrent
	ref ProviderRef
}

func (s *Service) search(ctx context.Context, key string, p ListParams, info *targetInfo, provs []sources.TorrentProvider) (*searchResult, error) {
	select {
	case s.sem <- struct{}{}:
		defer func() { <-s.sem }()
	case <-ctx.Done():
		return nil, ErrUpstream
	}
	start := s.now()
	queries := buildQueries(info.target, info.ru, info.en, info.orig)
	if p.Query != "" {
		queries = []string{p.Query}
	}
	title := sources.Title{
		MediaID: p.MediaID, IMDbID: info.target.IMDbID, Kind: info.kind, TitleRU: info.ru, TitleEN: info.en,
		Original: info.orig, OriginalLanguage: info.target.OriginalLanguage, Year: info.target.Year,
		Queries: queries, UserQuery: p.Query,
	}
	if p.Season != nil {
		title.Season = *p.Season
	}
	if p.Episode != nil {
		title.Episode = *p.Episode
	}
	type outcome struct {
		res *sources.TorrentResult
		err error
	}
	outcomes := make([]outcome, len(provs))
	qctx, cancel := context.WithTimeout(ctx, searchTimeout)
	var wg sync.WaitGroup
	for i, pr := range provs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := pr.SearchTorrents(qctx, title)
			if err == nil && res == nil {
				res = &sources.TorrentResult{}
			}
			outcomes[i] = outcome{res, err}
			if s.src != nil {
				s.src.Report(pr.Info().ID, err)
			}
		}()
	}
	wg.Wait()
	cancel()

	var failed []error
	var all []tagged
	idxErrs := []IndexerError{}
	for i, o := range outcomes {
		in := provs[i].Info()
		if o.err != nil {
			failed = append(failed, o.err)
			idxErrs = append(idxErrs, IndexerError{in.Title, "search failed: " + o.err.Error()})
			continue
		}
		ref := ProviderRef{ID: in.ID, Name: in.Title, Kind: in.Kind}
		for _, t := range o.res.Torrents {
			all = append(all, tagged{t, ref})
		}
		for _, w := range o.res.Warnings {
			idxErrs = append(idxErrs, IndexerError{w.Indexer, w.Message})
		}
	}
	if len(failed) == len(provs) {
		s.log.Warn("release search failed", "media_id", p.MediaID, "providers", len(provs), "err", failed[0])
		return nil, fmt.Errorf("%w: %v", ErrUpstream, failed[0])
	}

	cands := s.match(info, all, p.Loose, p.Query != "")
	now := s.now()
	body := &cacheBody{Candidates: cands, IndexerErrors: idxErrs}
	if err := s.store(ctx, key, p, body, all, now); err != nil {
		s.log.Error("release cache write failed", "err", err)
	}
	s.log.Info("release search", "media_id", p.MediaID, "providers", len(provs), "queries", len(queries), "results", len(all),
		"accepted", len(cands), "failed_providers", len(failed), "ms", now.Sub(start).Milliseconds())
	return &searchResult{body: body, at: now}, nil
}

var hashRe = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

func releaseID(r *tagged) string {
	if hashRe.MatchString(r.InfoHash) {
		return strings.ToLower(r.InfoHash)
	}
	sum := sha256.Sum256([]byte(strconv.Itoa(r.IndexerID) + "\x00" + r.GUID + "\x00" + r.Title))
	return "p" + hex.EncodeToString(sum[:16])
}

// dedupe drops non-torrents and repeated releases (same info hash from
// several queries or providers). The first copy wins (providers are in
// registration order: Prowlarr before Jacred); later copies only add
// voice names and a missing magnet.
func dedupe(all []tagged) []*tagged {
	byID := map[string]*tagged{}
	var out []*tagged
	for i := range all {
		r := &all[i]
		if r.Protocol != "" && r.Protocol != "torrent" {
			continue
		}
		id := releaseID(r)
		if first, ok := byID[id]; ok {
			if first.ref.ID != r.ref.ID {
				first.Voices = append(slices.Clip(first.Voices), r.Voices...)
				if first.MagnetURI == "" && first.DownloadURL == "" {
					first.MagnetURI = r.MagnetURI
				}
			}
			continue
		}
		byID[id] = r
		out = append(out, r)
	}
	return out
}

// match parses, dedupes and scores raw results, keeping accepted ones.
func (s *Service) match(info *targetInfo, all []tagged, loose, custom bool) []candidate {
	var out []candidate
	for _, r := range dedupe(all) {
		id := releaseID(r)
		p := Parse(r.Title)
		m := info.target.Match(&p, r.IMDbID, r.Categories)
		uncertain := false
		if m.Rejected {
			if !loose || !softReject(m.Reasons, custom) || franchiseExtension(p.Titles, info.target) {
				continue
			}
			uncertain = true
			m = Match{Confidence: 0.3, Reasons: append(slices.Clip(m.Reasons), "loose_match"), IsPack: p.IsPack()}
		}
		c := toCandidate(id, r, &p, m, info.target)
		c.Uncertain = uncertain
		out = append(out, c)
	}
	// Keep the most relevant if a title has hundreds of releases.
	slices.SortStableFunc(out, func(a, b candidate) int {
		if a.Release.Confidence != b.Release.Confidence {
			return cmpDesc(a.Release.Confidence, b.Release.Confidence)
		}
		return b.Release.Seeders - a.Release.Seeders
	})
	if len(out) > maxStored {
		out = out[:maxStored]
	}
	return out
}

func cmpDesc(a, b float64) int {
	if a > b {
		return -1
	}
	return 1
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func toCandidate(id string, r *tagged, p *Parsed, m Match, t *Target) candidate {
	rel := Release{
		ID:            id,
		Title:         r.Title,
		Indexer:       r.Indexer,
		SizeBytes:     r.Size,
		Leechers:      r.Leechers,
		PublishedAt:   r.PublishDate,
		Provider:      r.ref,
		Resolution:    strPtr(p.Resolution),
		VideoCodec:    strPtr(p.VideoCodec),
		HDR:           strPtr(p.HDR),
		AudioCodecs:   nonNilStrings(p.AudioCodecs),
		Languages:     []string{},
		Voiceovers:    mergeVoices(parseVoiceovers(r.Title), r.Voices),
		ReleaseGroup:  strPtr(p.ReleaseGroup),
		SourceQuality: strPtr(p.Source),
		Seasons:       nonNilInts(p.Seasons),
		Episodes:      nonNilInts(p.Episodes),
		IsSeasonPack:  m.IsPack,
		Confidence:    m.Confidence,
		Reasons:       m.Reasons,
		Warnings:      []string{},
	}
	if r.Seeders != nil {
		rel.Seeders = *r.Seeders
	}
	if hashRe.MatchString(r.InfoHash) {
		h := strings.ToLower(r.InfoHash)
		rel.InfoHash = &h
	}
	if len(p.Years) > 0 {
		y := p.Years[0]
		rel.Year = &y
	}
	for _, l := range p.Languages {
		if l == "orig" {
			l = t.OriginalLanguage
		}
		if l != "" && !slices.Contains(rel.Languages, l) {
			rel.Languages = append(rel.Languages, l)
		}
	}
	n := len(p.Episodes)
	if n <= 1 && m.IsPack && len(p.Seasons) == 1 && t.SeasonEpisodes > 1 {
		n = t.SeasonEpisodes
	}
	return candidate{
		Release: rel, TenBit: p.TenBit, DolbyVision: p.DolbyVision, HDR10: p.HDR10,
		DiscImage: p.DiscImage, CamAudio: p.CamAudio, ThreeD: p.ThreeD, Upscale: p.Upscale,
		EpisodeCount: n,
	}
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func nonNilInts(s []int) []int {
	if s == nil {
		return []int{}
	}
	return s
}

// store writes the list cache and the resolvable releases in one transaction.
func (s *Service) store(ctx context.Context, key string, p ListParams, body *cacheBody, all []tagged, now time.Time) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	byID := map[string]*tagged{}
	for _, r := range dedupe(all) {
		byID[releaseID(r)] = r
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `
		INSERT INTO release_search_cache (key, media_id, season, episode, body, fetched_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
		key, p.MediaID, p.Season, p.Episode, raw, now, now.Add(listTTL)); err != nil {
		return err
	}
	batch := &pgx.Batch{}
	for _, c := range body.Candidates {
		r := byID[c.Release.ID]
		if r == nil {
			continue
		}
		magnet, download := s.retrieval(r)
		if magnet == "" && download == "" {
			continue
		}
		// Stored with a default-preference score so playback has one to show.
		rel, _ := json.Marshal(Rank([]candidate{c}, Prefs{Languages: []string{"ru", "en"}})[0])
		batch.Queue(`
			INSERT INTO release_sources (media_id, release_id, release, info_hash, magnet_uri, download_url, indexer, provider, created_at, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (media_id, release_id) DO UPDATE SET release = EXCLUDED.release, info_hash = EXCLUDED.info_hash,
				magnet_uri = EXCLUDED.magnet_uri, download_url = EXCLUDED.download_url, provider = EXCLUDED.provider,
				expires_at = EXCLUDED.expires_at`,
			p.MediaID, c.Release.ID, rel, c.Release.InfoHash, nullable(magnet), nullable(download), c.Release.Indexer,
			r.ref.ID, now, now.Add(resolveTTL))
	}
	if batch.Len() > 0 {
		if err := tx.SendBatch(ctx, batch).Close(); err != nil {
			return err
		}
	}
	// Opportunistic cleanup (cheap: both are indexed on expires_at).
	if _, err := tx.Exec(ctx, `DELETE FROM release_search_cache WHERE expires_at < $1`, now.Add(-staleTTL)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM release_sources WHERE expires_at < $1`, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// retrieval picks how playback will fetch a release. A download link (a
// .torrent with the tracker list; Prowlarr's is stored without the API key)
// is preferred. A bare magnet is built from the info hash only when there
// is no link at all.
func (s *Service) retrieval(r *tagged) (magnet, download string) {
	switch {
	case r.DownloadURL != "":
		download = r.DownloadURL
	case strings.HasPrefix(strings.ToLower(r.MagnetURI), "magnet:"):
		magnet = r.MagnetURI
	}
	if magnet == "" && download == "" && hashRe.MatchString(r.InfoHash) {
		magnet = "magnet:?xt=urn:btih:" + strings.ToLower(r.InfoHash) + "&dn=" + url.QueryEscape(r.Title)
	}
	return magnet, download
}

// ---------------------------------------------------------------- resolve

// Resolve returns retrieval data for a release shown in the last 24 hours.
func (s *Service) Resolve(ctx context.Context, mediaID, releaseID string) (*Resolved, error) {
	if _, err := uuid.Parse(mediaID); err != nil || releaseID == "" || len(releaseID) > 128 {
		return nil, ErrReleaseNotFound
	}
	var raw []byte
	var magnet, download *string
	var provider string
	err := s.pool.QueryRow(ctx, `
		SELECT release, magnet_uri, download_url, provider FROM release_sources
		WHERE media_id = $1 AND release_id = $2 AND expires_at > $3`, mediaID, releaseID, s.now()).
		Scan(&raw, &magnet, &download, &provider)
	if db.IsNoRows(err) {
		return nil, ErrReleaseNotFound
	}
	if err != nil {
		return nil, err
	}
	out := &Resolved{MediaID: mediaID}
	if err := json.Unmarshal(raw, &out.Release); err != nil {
		return nil, err
	}
	if magnet != nil {
		out.MagnetURI = *magnet
	}
	if download != nil {
		out.DownloadURL = s.withKey(provider, *download)
	}
	return out, nil
}

// withKey restores a provider's secret in a stored download link (Prowlarr's
// and Jackett's proxy links are stored without their API key).
func (s *Service) withKey(provider, link string) string {
	type keyed interface{ WithKey(string) string }
	if s.src != nil {
		if p, ok := s.src.Provider(provider); ok {
			if k, ok := p.(keyed); ok {
				return k.WithKey(link)
			}
			return link
		}
	}
	if provider == prowlarrRef.ID {
		return s.prowlarr.WithKey(link)
	}
	return link
}

// softReject reports whether a rejection only reflects uncertainty, so the
// release may be shown (flagged) when the user asks to loosen matching.
func softReject(reasons []string, custom bool) bool {
	if len(reasons) == 0 {
		return false
	}
	last := reasons[len(reasons)-1]
	switch {
	case last == "low_confidence", last == "version_mismatch", last == "other_title_mismatch", last == "kind_mismatch",
		strings.HasPrefix(last, "year"):
		return true
	case last == "title_mismatch":
		return custom // only when the user typed the query themselves
	}
	return false
}

// franchiseExtension reports whether a release title contains one of the
// target's titles plus more words — another film of the same franchise
// («Матрица: Перезагрузка» for «Матрица»). Never shown, even when loosened.
func franchiseExtension(cands []string, t *Target) bool {
	for _, c := range cands {
		ct := normTokens(c)
		for _, title := range t.Titles {
			tt := normTokens(title)
			if len(tt) == 0 || len(ct) <= len(tt) {
				continue
			}
			all := true
			for _, w := range tt {
				if !slices.Contains(ct, w) {
					all = false
					break
				}
			}
			if all {
				return true
			}
		}
	}
	return false
}
