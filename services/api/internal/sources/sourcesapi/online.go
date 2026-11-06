// Package sourcesapi serves the sources HTTP API: the provider catalog
// (GET /sources), admin settings (/admin/sources*), and the online search
// (GET /media/{id}/online) that fans out to online/anime providers.
//
// It lives apart from package sources because it depends on catalog,
// profiles and releases (voice-over parsing, preferences), which depend on
// sources themselves.
package sourcesapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/catalog"
	"martytv/api/internal/db"
	"martytv/api/internal/releases"
	"martytv/api/internal/sources"
)

const (
	okTTL      = 6 * time.Hour
	emptyTTL   = time.Hour
	errorTTL   = 10 * time.Minute
	variantTTL = 24 * time.Hour
	// providerTimeout bounds one provider's lookup; the response never
	// waits longer than this for a slow provider.
	providerTimeout = 15 * time.Second
)

var (
	// ErrNotFound is an unknown media id.
	ErrNotFound = errors.New("online: media not found")
	// ErrCatalog means TMDB metadata couldn't be loaded.
	ErrCatalog = errors.New("online: catalog unavailable")
)

// FieldError is a request that doesn't fit the media (422).
type FieldError struct{ Field, Message string }

func (e *FieldError) Error() string { return e.Field + ": " + e.Message }

// Service runs online lookups and remembers shown variants for playback.
type Service struct {
	pool    *pgxpool.Pool
	reg     *sources.Registry
	catalog *catalog.Service
	log     *slog.Logger
	now     func() time.Time
	timeout time.Duration
}

func NewService(pool *pgxpool.Pool, reg *sources.Registry, cat *catalog.Service, log *slog.Logger) *Service {
	return &Service{pool: pool, reg: reg, catalog: cat, log: log, now: time.Now, timeout: providerTimeout}
}

// SetProviderTimeout overrides the per-provider timeout (tests).
func (s *Service) SetProviderTimeout(d time.Duration) { s.timeout = d }

// OnlineItem is one variant as clients see it (contract: OnlineVariant).
type OnlineItem struct {
	ID            string               `json:"id"`
	Provider      releases.ProviderRef `json:"provider"`
	Voice         string               `json:"voice"`
	Voiceover     releases.Voiceover   `json:"voiceover"`
	Title         *string              `json:"title"`
	MaxQuality    *int                 `json:"max_quality"`
	Qualities     []int                `json:"qualities"`
	Format        string               `json:"format"`
	SubtitleLangs []string             `json:"subtitle_langs"`
	Season        *int                 `json:"season"`
	Episode       *int                 `json:"episode"`
	Episodes      []int                `json:"episodes"`
	Preferred     bool                 `json:"preferred"`
	Score         float64              `json:"score"`
}

// ProviderStatus is one provider's outcome in an online search.
type ProviderStatus struct {
	ID     string       `json:"id"`
	Name   string       `json:"name"`
	Kind   sources.Kind `json:"kind"`
	Status string       `json:"status"` // ok | empty | error | timeout
	Count  int          `json:"count"`
	Error  *string      `json:"error"`
	Cached bool         `json:"cached"`
}

// OnlineList is the contract's OnlineList.
type OnlineList struct {
	Items      []OnlineItem     `json:"items"`
	Providers  []ProviderStatus `json:"providers"`
	SearchedAt time.Time        `json:"searched_at"`
	Cached     bool             `json:"cached"`
}

// SearchParams selects what to look up.
type SearchParams struct {
	MediaID string
	Season  *int
	Episode *int
	Refresh bool
	Prefs   releases.Prefs
	Sources sources.Selection
}

// storedVariant is a variant with its provider-private ref (server-only).
type storedVariant struct {
	sources.Variant
	Ref json.RawMessage `json:"ref,omitempty"`
}

type cacheRow struct {
	status   string
	errMsg   string
	variants []storedVariant
	at       time.Time
}

// Search fans out to the selected online/anime providers concurrently.
// One provider failing never fails the response.
func (s *Service) Search(ctx context.Context, p SearchParams) (*OnlineList, error) {
	if p.Episode != nil && p.Season == nil {
		return nil, &FieldError{"episode", "requires season"}
	}
	title, err := s.title(ctx, p.MediaID, p.Season, p.Episode)
	if err != nil {
		return nil, err
	}
	provs := s.reg.OnlineProviders(ctx, p.Sources)
	out := &OnlineList{Items: []OnlineItem{}, Providers: []ProviderStatus{}, SearchedAt: s.now().UTC(), Cached: len(provs) > 0}
	statuses := make([]ProviderStatus, len(provs))
	found := make([][]storedVariant, len(provs))
	oldest := s.now()
	var wg sync.WaitGroup
	var mu sync.Mutex
	for i, pr := range provs {
		in := pr.Info()
		key := s.cacheKey(p.MediaID, title.Season, title.Episode, in.ID)
		st := ProviderStatus{ID: in.ID, Name: in.Title, Kind: in.Kind}
		if !p.Refresh {
			if row, ok := s.readCache(ctx, key); ok {
				st.Status, st.Cached, st.Count = row.status, true, len(row.variants)
				if row.errMsg != "" {
					m := row.errMsg
					st.Error = &m
				}
				statuses[i], found[i] = st, row.variants
				if row.at.Before(oldest) {
					oldest = row.at
				}
				continue
			}
		}
		mu.Lock()
		out.Cached = false
		mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.timeout)
			defer cancel()
			vs, err := pr.Variants(pctx, title)
			s.reg.Report(in.ID, err)
			var stored []storedVariant
			switch {
			case err != nil && errors.Is(pctx.Err(), context.DeadlineExceeded):
				st.Status = "timeout"
				m := "timed out"
				st.Error = &m
			case err != nil:
				st.Status = "error"
				m := err.Error()
				st.Error = &m
				s.log.Warn("online provider failed", "source", in.ID, "media_id", p.MediaID, "err", err)
			default:
				for _, v := range vs {
					v.Provider = in.ID
					stored = append(stored, storedVariant{Variant: v, Ref: v.Ref})
				}
				assignIDs(stored)
				st.Status, st.Count = "ok", len(stored)
				if len(stored) == 0 {
					st.Status = "empty"
				}
			}
			s.writeCache(context.WithoutCancel(ctx), key, p.MediaID, in.ID, st, stored)
			statuses[i], found[i] = st, stored
		}()
	}
	wg.Wait()
	if out.Cached {
		out.SearchedAt = oldest.UTC()
	}

	var all []storedVariant
	for i, st := range statuses {
		out.Providers = append(out.Providers, st)
		all = append(all, found[i]...)
	}
	if err := s.remember(ctx, p.MediaID, all); err != nil {
		s.log.Error("online variants write failed", "err", err)
	}
	refs := map[string]releases.ProviderRef{}
	for _, pr := range provs {
		in := pr.Info()
		refs[in.ID] = releases.ProviderRef{ID: in.ID, Name: in.Title, Kind: in.Kind}
	}
	for _, v := range all {
		out.Items = append(out.Items, present(v.Variant, refs[v.Provider], p.Prefs))
	}
	rank(out.Items)
	return out, nil
}

// assignIDs gives every variant a stable opaque id: "o" + hash of
// provider, ref and the visible identity (voice, season, episode).
func assignIDs(vs []storedVariant) {
	for i := range vs {
		v := &vs[i]
		h := sha256.Sum256([]byte(strings.Join([]string{v.Provider, string(v.Ref), v.Voice,
			strconv.Itoa(v.Season), strconv.Itoa(v.Episode), v.Format}, "\x00")))
		v.ID = "o" + hex.EncodeToString(h[:12])
	}
}

func (s *Service) cacheKey(mediaID string, season, episode int, provider string) string {
	return fmt.Sprintf("%s:s%d:e%d:%s", mediaID, season, episode, provider)
}

func (s *Service) readCache(ctx context.Context, key string) (*cacheRow, bool) {
	var row cacheRow
	var raw []byte
	var errMsg *string
	err := s.pool.QueryRow(ctx, `SELECT status, error, variants, fetched_at FROM online_search_cache
		WHERE key = $1 AND expires_at > $2`, key, s.now()).Scan(&row.status, &errMsg, &raw, &row.at)
	if err != nil {
		if !db.IsNoRows(err) {
			s.log.Warn("online cache read failed", "err", err)
		}
		return nil, false
	}
	if errMsg != nil {
		row.errMsg = *errMsg
	}
	if json.Unmarshal(raw, &row.variants) != nil {
		return nil, false
	}
	return &row, true
}

func (s *Service) writeCache(ctx context.Context, key, mediaID, provider string, st ProviderStatus, vs []storedVariant) {
	ttl := okTTL
	status := st.Status
	switch status {
	case "empty":
		ttl = emptyTTL
	case "error", "timeout":
		ttl, status = errorTTL, "error"
	}
	if vs == nil {
		vs = []storedVariant{}
	}
	raw, _ := json.Marshal(vs)
	now := s.now()
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO online_search_cache (key, media_id, provider, status, error, variants, fetched_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, variants = EXCLUDED.variants,
			fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
		key, mediaID, provider, status, st.Error, raw, now, now.Add(ttl)); err != nil {
		s.log.Warn("online cache write failed", "err", err)
	}
}

// remember stores shown variants (with refs) so playback can resolve them.
func (s *Service) remember(ctx context.Context, mediaID string, vs []storedVariant) error {
	if len(vs) == 0 {
		return nil
	}
	now := s.now()
	batch := &pgx.Batch{}
	for _, v := range vs {
		pub, _ := json.Marshal(v.Variant)
		var ref any
		if len(v.Ref) > 0 {
			ref = []byte(v.Ref)
		}
		batch.Queue(`
			INSERT INTO online_variants (media_id, variant_id, provider, variant, ref, created_at, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (media_id, variant_id) DO UPDATE SET variant = EXCLUDED.variant, ref = EXCLUDED.ref,
				expires_at = EXCLUDED.expires_at`,
			mediaID, v.ID, v.Provider, pub, ref, now, now.Add(variantTTL))
	}
	batch.Queue(`DELETE FROM online_variants WHERE expires_at < $1`, now)
	batch.Queue(`DELETE FROM online_search_cache WHERE expires_at < $1`, now.Add(-time.Hour))
	return s.pool.SendBatch(ctx, batch).Close()
}

// LookupVariant implements sources.VariantLookup (for playback): a variant
// shown in the last 24 h, Ref included.
func (s *Service) LookupVariant(ctx context.Context, mediaID, variantID string) (*sources.Variant, error) {
	if variantID == "" || len(variantID) > 128 || !strings.HasPrefix(variantID, "o") {
		return nil, sources.ErrNotFound
	}
	var pub, ref []byte
	err := s.pool.QueryRow(ctx, `SELECT variant, ref FROM online_variants
		WHERE media_id = $1 AND variant_id = $2 AND expires_at > $3`, mediaID, variantID, s.now()).Scan(&pub, &ref)
	if db.IsNoRows(err) {
		return nil, sources.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var v sources.Variant
	if err := json.Unmarshal(pub, &v); err != nil {
		return nil, err
	}
	v.Ref = ref
	return &v, nil
}

// ---------------------------------------------------------------- title

func (s *Service) title(ctx context.Context, mediaID string, season, episode *int) (sources.Title, error) {
	ru, errRU := s.catalog.Detail(ctx, mediaID, "ru")
	en, errEN := s.catalog.Detail(ctx, mediaID, "en")
	if errRU != nil && errEN != nil {
		if errors.Is(errRU, catalog.ErrNotFound) || errors.Is(errEN, catalog.ErrNotFound) {
			return sources.Title{}, ErrNotFound
		}
		return sources.Title{}, fmt.Errorf("%w: %v", ErrCatalog, errRU)
	}
	d := ru
	if d == nil {
		d = en
	}
	if d.Kind == "movie" && season != nil {
		return sources.Title{}, &FieldError{"season", "only series have seasons"}
	}
	t := sources.Title{MediaID: mediaID, TMDBID: d.TMDBID, Kind: d.Kind, Original: d.OriginalTitle,
		OriginalLanguage: d.OriginalLanguage}
	if ru != nil {
		t.TitleRU = ru.Title
	}
	if en != nil {
		t.TitleEN = en.Title
	}
	for _, g := range d.Genres {
		t.Genres = append(t.Genres, g.ID)
	}
	if d.Year != nil {
		t.Year = *d.Year
	}
	if d.ExternalIDs.IMDb != nil {
		t.IMDbID = *d.ExternalIDs.IMDb
	}
	if d.ExternalIDs.Kinopoisk != nil {
		t.KPID = *d.ExternalIDs.Kinopoisk
	} else {
		var kp *int
		if err := s.pool.QueryRow(ctx, `SELECT kp_id FROM media WHERE id = $1`, mediaID).Scan(&kp); err == nil && kp != nil {
			t.KPID = *kp
		}
	}
	if season != nil {
		t.Season = *season
	}
	if episode != nil {
		t.Episode = *episode
	}
	return t, nil
}

// ---------------------------------------------------------------- ranking

func present(v sources.Variant, ref releases.ProviderRef, prefs releases.Prefs) OnlineItem {
	it := OnlineItem{
		ID: v.ID, Provider: ref, Voice: v.Voice, Voiceover: releases.VoiceoverFromName(v.Voice, v.Language),
		Qualities: nonNil(v.Qualities), Format: v.Format, SubtitleLangs: nonNilS(v.SubtitleLangs),
		Episodes: nonNil(v.Episodes),
	}
	if v.VoiceKind != "" && it.Voiceover.Kind == nil {
		k := v.VoiceKind
		it.Voiceover.Kind = &k
	}
	if v.Title != "" {
		t := v.Title
		it.Title = &t
	}
	if v.MaxQuality > 0 {
		q := v.MaxQuality
		it.MaxQuality = &q
	}
	if v.Season > 0 {
		n := v.Season
		it.Season = &n
	}
	if v.Episode > 0 {
		n := v.Episode
		it.Episode = &n
	}
	it.Score = score(it, v.Language, prefs)
	return it
}

// score: preferred voice-over studio, then preferred audio language, then
// quality closeness to the preferred resolution, mp4 slightly over hls.
func score(it OnlineItem, lang string, prefs releases.Prefs) float64 {
	if lang == "" {
		lang = "ru"
	}
	sc := 0.0
	if i := releases.VoiceoverPreference([]releases.Voiceover{it.Voiceover}, prefs.Voiceovers); i >= 0 {
		sc += 0.5 * math.Max(0.5, 1-0.1*float64(i))
	}
	if i := slices.IndexFunc(prefs.Languages, func(l string) bool { return strings.EqualFold(l, lang) }); i >= 0 {
		sc += 0.3 / float64(i+1)
	}
	pref := 1080
	if n, err := strconv.Atoi(strings.TrimSuffix(prefs.Resolution, "p")); err == nil && n > 0 {
		pref = n
	}
	q := 0
	if it.MaxQuality != nil {
		q = *it.MaxQuality
	}
	switch {
	case q == 0:
		sc += 0.05
	case q >= pref:
		sc += 0.15
	default:
		sc += 0.15 * float64(q) / float64(pref)
	}
	if it.Format == "mp4" {
		sc += 0.02
	}
	return math.Round(sc*10000) / 10000
}

// rank sorts best first and marks the top item as the auto-pick.
func rank(items []OnlineItem) {
	slices.SortStableFunc(items, func(a, b OnlineItem) int {
		switch {
		case a.Score > b.Score:
			return -1
		case a.Score < b.Score:
			return 1
		}
		return 0
	})
	if len(items) > 0 {
		items[0].Preferred = true
	}
}

func nonNil(s []int) []int {
	if s == nil {
		return []int{}
	}
	return s
}

func nonNilS(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
