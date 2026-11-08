// Package trivia answers a title's «Цитаты» (GET /media/{id}/quotes) and
// «Факты» (GET /media/{id}/facts).
//
// Quotes come from Wikiquote (wikiquote.go): the ru or en page per the
// requested language, falling back to the other; none when Wikiquote has
// no page. Facts come from Kinopoisk's «Знаете ли вы» (internal/ratings,
// keyed API, budgeted); when a title has none — or no Kinopoisk id yet, or
// no key — DeepSeek writes them (internal/foryou, source "ai"). Made-up
// quotes would look real, so quotes never come from AI.
//
// Every finished answer is cached per title and language in media_trivia:
// found data for 30 days; misses for 7; AI stand-ins for a day when
// Kinopoisk might still answer later (id not resolved yet, budget or
// outage), 30 days otherwise. Failures are not cached.
package trivia

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"

	"martytv/api/internal/auth"
	"martytv/api/internal/foryou"
	"martytv/api/internal/httpx"
	"martytv/api/internal/ratings"
	"martytv/api/internal/uilang"
)

const (
	ttlFound = 30 * 24 * time.Hour
	ttlMiss  = 7 * 24 * time.Hour
	ttlRetry = 24 * time.Hour
	maxFacts = 15
	// fetchTimeout bounds one uncached answer (Wikidata + Wikiquote, or
	// Kinopoisk + DeepSeek); it runs detached from the request so a
	// prefetch that the client abandons still fills the cache.
	fetchTimeout = 90 * time.Second
)

// Quotes is MediaQuotes.
type Quotes struct {
	Items     []Quote `json:"items"`
	Source    *string `json:"source"`
	SourceURL *string `json:"source_url"`
	Lang      string  `json:"lang"`
}

// Fact is one fact or blooper.
type Fact struct {
	Text    string `json:"text"`
	Kind    string `json:"kind"` // fact | blooper
	Spoiler bool   `json:"spoiler"`
}

// Facts is MediaFacts.
type Facts struct {
	Items     []Fact  `json:"items"`
	Source    *string `json:"source"` // kinopoisk | ai
	SourceURL *string `json:"source_url"`
	Lang      string  `json:"lang"`
}

// KPFacts is the Kinopoisk side (ratings.Service.Facts).
type KPFacts interface {
	FactsAvailable() bool
	Facts(ctx context.Context, kpID int) ([]ratings.KPFact, error)
}

// AIFacts is the DeepSeek side (foryou.Service).
type AIFacts interface {
	AIAvailable(ctx context.Context) bool
	TitleFacts(ctx context.Context, t foryou.FactsTitle, lang string) ([]foryou.AIFact, error)
}

type Options struct {
	Pool *pgxpool.Pool
	KP   KPFacts // optional
	AI   AIFacts // optional
	Log  *slog.Logger
	// Endpoints (tests); defaults are the public Wikimedia services.
	WikidataURL  string
	WikiquoteURL func(lang string) string
	HTTP         *http.Client
}

type Service struct {
	pool *pgxpool.Pool
	kp   KPFacts
	ai   AIFacts
	wm   *wikimedia
	log  *slog.Logger
	now  func() time.Time
	sf   singleflight.Group
}

func New(o Options) *Service {
	if o.WikidataURL == "" {
		o.WikidataURL = "https://query.wikidata.org/sparql"
	}
	if o.WikiquoteURL == nil {
		o.WikiquoteURL = func(lang string) string { return "https://" + lang + ".wikiquote.org/w/api.php" }
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return &Service{pool: o.Pool, kp: o.KP, ai: o.AI, wm: newWikimedia(o.WikidataURL, o.WikiquoteURL, o.HTTP), log: o.Log, now: time.Now}
}

// SetWikimedia points the service at other Wikidata / Wikiquote endpoints
// with no spacing between requests (tests).
func (s *Service) SetWikimedia(wikidata string, wikiquote func(lang string) string) {
	s.wm.sparql, s.wm.quote, s.wm.gap = wikidata, wikiquote, 0
}

// Routes mounts GET /media/:id/quotes and /media/:id/facts.
func (s *Service) Routes(r fiber.Router) {
	m := r.Group("/media", auth.RequireReader())
	m.Get("/:id/quotes", s.hQuotes)
	m.Get("/:id/facts", s.hFacts)
}

// ---------------------------------------------------------------- media

type title struct {
	id, kind, name, original string
	tmdbID, year             int
	kpID                     *int
}

var errNotFound = errors.New("media not found")

func (s *Service) title(ctx context.Context, id, lang string) (*title, error) {
	var t title
	var year *int
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, kind, tmdb_id, original_title, year, kp_id,
		       COALESCE(NULLIF(translations -> $2::text ->> 'title', ''), NULLIF(translations -> 'en' ->> 'title', ''), original_title)
		FROM media WHERE id = $1::uuid`, id, lang).Scan(&t.id, &t.kind, &t.tmdbID, &t.original, &year, &t.kpID, &t.name)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if year != nil {
		t.year = *year
	}
	return &t, nil
}

// ---------------------------------------------------------------- cache

func (s *Service) cached(ctx context.Context, id, kind, lang string, out any) bool {
	var raw []byte
	err := s.pool.QueryRow(ctx, `SELECT data FROM media_trivia WHERE media_id = $1 AND kind = $2 AND lang = $3 AND expires_at > now()`,
		id, kind, lang).Scan(&raw)
	return err == nil && json.Unmarshal(raw, out) == nil
}

func (s *Service) store(ctx context.Context, id, kind, lang string, v any, ttl time.Duration) {
	b, _ := json.Marshal(v)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO media_trivia (media_id, kind, lang, data, fetched_at, expires_at) VALUES ($1, $2, $3, $4::jsonb, now(), $5)
		ON CONFLICT (media_id, kind, lang) DO UPDATE SET data = EXCLUDED.data, fetched_at = now(), expires_at = EXCLUDED.expires_at`,
		id, kind, lang, string(b), s.now().Add(ttl)); err != nil {
		s.log.Warn("trivia: cache write failed", "err", err)
	}
}

// once runs f once per key at a time, detached from the caller's context.
func (s *Service) once(ctx context.Context, key string, f func(ctx context.Context) (any, error)) (any, error) {
	ch := s.sf.DoChan(key, func() (any, error) {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), fetchTimeout)
		defer cancel()
		return f(ctx)
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case r := <-ch:
		return r.Val, r.Err
	}
}

func other(lang string) string {
	if lang == "ru" {
		return "en"
	}
	return "ru"
}

func ptr(s string) *string { return &s }

// ---------------------------------------------------------------- quotes

// Quotes returns the title's quotes in lang (or the other language).
func (s *Service) Quotes(ctx context.Context, id, lang string) (*Quotes, error) {
	var q Quotes
	if s.cached(ctx, id, "quotes", lang, &q) {
		return &q, nil
	}
	t, err := s.title(ctx, id, lang)
	if err != nil {
		return nil, err
	}
	v, err := s.once(ctx, "q|"+id+"|"+lang, func(ctx context.Context) (any, error) {
		res, err := s.fetchQuotes(ctx, t, lang)
		if err != nil {
			return nil, err
		}
		ttl := ttlFound
		if len(res.Items) == 0 {
			ttl = ttlMiss
		}
		s.store(ctx, id, "quotes", lang, res, ttl)
		return res, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*Quotes), nil
}

func (s *Service) fetchQuotes(ctx context.Context, t *title, lang string) (*Quotes, error) {
	res := &Quotes{Items: []Quote{}, Lang: lang}
	if t.tmdbID <= 0 {
		return res, nil
	}
	pg, err := s.wm.find(ctx, t.kind, t.tmdbID)
	if err != nil {
		return nil, err
	}
	for _, l := range []string{lang, other(lang)} {
		if pg[l] == "" {
			continue
		}
		text, err := s.wm.wikitext(ctx, l, pg[l])
		if err != nil {
			return nil, err
		}
		// A page with only one or two usable lines reads like a miss; try the other language.
		if items := parseQuotes(text); len(items) >= 3 || (len(items) > 0 && l == other(lang)) {
			res.Items, res.Lang = items, l
			res.Source, res.SourceURL = ptr("wikiquote"), ptr(pageURL(l, pg[l]))
			return res, nil
		}
	}
	return res, nil
}

// ---------------------------------------------------------------- facts

// Facts returns the title's facts: Kinopoisk's, else DeepSeek's.
func (s *Service) Facts(ctx context.Context, id, lang string) (*Facts, error) {
	// AI facts follow the interface language (Kazakh for a Kazakh app):
	// cached under it; the title is read in the catalog language lang.
	text := uilang.Text(ctx, lang)
	var f Facts
	if s.cached(ctx, id, "facts", text, &f) {
		if f.Source != nil && *f.Source == "ai" && (s.ai == nil || !s.ai.AIAvailable(ctx)) {
			// AI «Факты» switched off: hide the stored ones (kept for when it's back on).
			return &Facts{Items: []Fact{}, Lang: lang}, nil
		}
		return &f, nil
	}
	t, err := s.title(ctx, id, lang)
	if err != nil {
		return nil, err
	}
	v, err := s.once(ctx, "f|"+id+"|"+text, func(ctx context.Context) (any, error) {
		res, ttl, err := s.fetchFacts(ctx, t, lang, text)
		if err != nil {
			return nil, err
		}
		if ttl > 0 {
			s.store(ctx, id, "facts", text, res, ttl)
		}
		return res, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*Facts), nil
}

// fetchFacts returns the answer and how long to cache it (0 = not at all).
// text is the AI facts' language (lang, or kk when lang is ru).
func (s *Service) fetchFacts(ctx context.Context, t *title, lang, text string) (*Facts, time.Duration, error) {
	res := &Facts{Items: []Fact{}, Lang: lang}
	// kpLater: Kinopoisk may have facts later (no id yet, budget, outage).
	kpLater := false
	kpOK := s.kp != nil && s.kp.FactsAvailable()
	if kpOK {
		switch {
		case t.kpID == nil:
			kpLater = true
		default:
			kp, err := s.kp.Facts(ctx, *t.kpID)
			switch {
			case errors.Is(err, ratings.ErrNoFacts):
			case err != nil:
				s.log.Info("trivia: kinopoisk facts unavailable", "err", err)
				kpLater = true
			case len(kp) > 0:
				// Facts first, bloopers after; the list is Kinopoisk's own (Russian).
				for _, blooper := range []bool{false, true} {
					for _, f := range kp {
						if f.Blooper == blooper && len(res.Items) < maxFacts {
							kind := "fact"
							if blooper {
								kind = "blooper"
							}
							res.Items = append(res.Items, Fact{Text: f.Text, Kind: kind, Spoiler: f.Spoiler})
						}
					}
				}
				path := "film"
				if t.kind == "series" {
					path = "series"
				}
				res.Source, res.SourceURL, res.Lang = ptr("kinopoisk"), ptr(fmt.Sprintf("https://www.kinopoisk.ru/%s/%d/facts/", path, *t.kpID)), "ru"
				return res, ttlFound, nil
			}
		}
	}
	if s.ai == nil || !s.ai.AIAvailable(ctx) {
		if kpLater || !kpOK {
			return res, 0, nil // nothing to ask (yet): don't remember the miss
		}
		// A short miss: the admin may switch AI «Факты» back on.
		return res, ttlRetry, nil
	}
	ai, err := s.ai.TitleFacts(ctx, foryou.FactsTitle{Title: t.name, OriginalTitle: t.original, Year: t.year, Kind: t.kind}, text)
	switch {
	case foryou.IsAIUnavailable(err):
		return res, 0, nil
	case err != nil:
		return nil, 0, err
	}
	for _, f := range ai {
		if len(res.Items) < maxFacts {
			res.Items = append(res.Items, Fact{Text: strings.TrimSpace(f.Text), Kind: "fact", Spoiler: f.Spoiler})
		}
	}
	if len(res.Items) > 0 {
		res.Source = ptr("ai")
	}
	switch {
	case kpLater:
		return res, ttlRetry, nil
	case len(res.Items) == 0:
		return res, ttlMiss, nil
	}
	return res, ttlFound, nil
}

// ---------------------------------------------------------------- handlers

func langOf(c fiber.Ctx) (string, error) {
	switch l := c.Query("lang"); l {
	case "", "en":
		return "en", nil
	case "ru":
		return "ru", nil
	}
	return "", httpx.Validation(map[string]string{"lang": "must be one of en, ru"})
}

func (s *Service) params(c fiber.Ctx) (string, string, error) {
	id := c.Params("id")
	if _, err := uuid.Parse(id); err != nil || len(id) != 36 {
		return "", "", httpx.NotFound()
	}
	lang, err := langOf(c)
	return strings.Clone(id), lang, err
}

func (s *Service) fail(err error) error {
	switch {
	case errors.Is(err, errNotFound):
		return httpx.NotFound()
	case errors.Is(err, context.Canceled):
		return err
	}
	s.log.Warn("trivia: fetch failed", "err", err)
	return httpx.NewError(fiber.StatusBadGateway, "trivia_failed", "Could not load this right now. Try again.")
}

func (s *Service) hQuotes(c fiber.Ctx) error {
	id, lang, err := s.params(c)
	if err != nil {
		return err
	}
	q, err := s.Quotes(c.Context(), id, lang)
	if err != nil {
		return s.fail(err)
	}
	return c.JSON(q)
}

func (s *Service) hFacts(c fiber.Ctx) error {
	id, lang, err := s.params(c)
	if err != nil {
		return err
	}
	f, err := s.Facts(c.Context(), id, lang)
	if err != nil {
		return s.fail(err)
	}
	return c.JSON(f)
}
