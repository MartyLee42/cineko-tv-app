// Package companion is the watch companion on a title's Details: two
// on-demand DeepSeek features (the model side is internal/foryou).
//
// «Ранее в сериале» (POST /media/{id}/recap): when a profile returns to a
// series it has not touched for RecapBreak (7 days), a ≤5-line recap built
// ONLY from the TMDB synopses of the episodes this profile has completed
// (the furthest 12, specials skipped) — nothing past the last watched
// episode is ever sent, so it can't spoil.
//
// «После титров» (POST /media/{id}/after-credits, GET|POST …/chat): once
// the title is finished — a completed movie, or a series season whose last
// episode is completed (afterScope) — «Объяснение финала» and «Почему это
// важно» (spoilers allowed, careful about facts), plus a short chat
// (ChatMaxUser messages) limited to what was finished.
//
// Answers are cached in companion_answers (recaps keyed by the exact
// episodes used, so a repeat press is free); uncached answers and chat
// messages count against a per-profile daily limit; AI off → the status
// says so and clients hide the buttons.
package companion

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"

	"martytv/api/internal/auth"
	"martytv/api/internal/catalog"
	"martytv/api/internal/foryou"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
)

const (
	ttlRecap = 180 * 24 * time.Hour
	ttlAfter = 60 * 24 * time.Hour
	// callTimeout bounds one uncached answer; it runs detached from the
	// request so an abandoned press still fills the cache.
	callTimeout = 90 * time.Second
)

// msk: the daily limit resets at Moscow midnight, like the other AI limits.
var msk = time.FixedZone("MSK", 3*60*60)

// AI is the DeepSeek side (foryou.Service).
type AI interface {
	CompanionAvailable(ctx context.Context) bool
	SeriesRecap(ctx context.Context, t foryou.CompanionTitle, eps []foryou.RecapEpisode, lang string) ([]string, error)
	AfterCredits(ctx context.Context, t foryou.CompanionTitle, sc foryou.CompanionScope, topic, lang string) (*foryou.AfterText, error)
	AfterCreditsChat(ctx context.Context, t foryou.CompanionTitle, sc foryou.CompanionScope, history []foryou.ChatTurn, question, lang string) (*foryou.ChatReply, error)
}

// Seasons loads a season's episodes (catalog.Service) so missing synopses
// can be fetched once.
type Seasons interface {
	Season(ctx context.Context, id string, number int, lang string) (*catalog.Season, error)
}

type Options struct {
	Pool     *pgxpool.Pool
	Profiles *profiles.Store
	AI       AI      // optional: nil = AI off
	Seasons  Seasons // optional
	// DailyLimit: uncached answers + chat messages per profile per day.
	DailyLimit int
	Log        *slog.Logger
}

type Service struct {
	pool     *pgxpool.Pool
	profiles *profiles.Store
	ai       AI
	seasons  Seasons
	limit    int
	log      *slog.Logger
	now      func() time.Time
	sf       singleflight.Group
}

func New(o Options) *Service {
	if o.Log == nil {
		o.Log = slog.Default()
	}
	return &Service{pool: o.Pool, profiles: o.Profiles, ai: o.AI, seasons: o.Seasons, limit: o.DailyLimit, log: o.Log, now: time.Now}
}

// SetNow replaces the clock (tests).
func (s *Service) SetNow(f func() time.Time) { s.now = f }

// Routes mounts the profile-scoped endpoints.
func (s *Service) Routes(r fiber.Router) {
	caller := profiles.RequireProfileCaller()
	r.Get("/media/:id/companion", caller, s.hStatus)
	r.Post("/media/:id/recap", caller, s.hRecap)
	r.Post("/media/:id/after-credits", caller, s.hAfter)
	r.Get("/media/:id/after-credits/chat", caller, s.hChat)
	r.Post("/media/:id/after-credits/chat", caller, s.hChatSend)
}

var (
	errNotFound    = errors.New("media not found")
	errNotEligible = errors.New("not eligible")
	errNoSynopses  = errors.New("no synopses")
	errLimit       = errors.New("companion limit reached")
	errChatFull    = errors.New("chat full")
)

func (s *Service) aiOn(ctx context.Context) bool { return s.ai != nil && s.ai.CompanionAvailable(ctx) }

// ---------------------------------------------------------------- data

type title struct {
	foryou.CompanionTitle
	id, status string
}

func (s *Service) title(ctx context.Context, id, lang string) (*title, error) {
	t := &title{id: id}
	var year *int
	err := s.pool.QueryRow(ctx, `
		SELECT kind, original_title, year, status,
		       COALESCE(NULLIF(translations -> $2::text ->> 'title', ''), NULLIF(translations -> 'en' ->> 'title', ''), original_title)
		FROM media WHERE id = $1::uuid`, id, lang).Scan(&t.Kind, &t.OriginalTitle, &year, &t.status, &t.Title)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if year != nil {
		t.Year = *year
	}
	if t.OriginalTitle == t.Title {
		t.OriginalTitle = ""
	}
	return t, nil
}

// watched: the profile's completed episodes in story order, with the
// synopsis in lang (else English, else any), plus the last activity on
// the title and, for a movie, whether it is completed.
func (s *Service) watched(ctx context.Context, pid, mediaID, lang string) (eps []watchedEpisode, last *time.Time, movieDone bool, err error) {
	if err = s.pool.QueryRow(ctx, `
		SELECT max(updated_at), COALESCE(bool_or(completed) FILTER (WHERE episode_id IS NULL), false)
		FROM watch_progress WHERE profile_id = $1 AND media_id = $2`, pid, mediaID).Scan(&last, &movieDone); err != nil {
		return
	}
	rows, err := s.pool.Query(ctx, `
		SELECT e.id::text, e.season_number, e.episode_number,
		       COALESCE(NULLIF(e.translations -> $3::text ->> 'name', ''), NULLIF(e.translations -> 'en' ->> 'name', ''), ''),
		       COALESCE(NULLIF(e.translations -> $3::text ->> 'overview', ''), NULLIF(e.translations -> 'en' ->> 'overview', ''),
		                (SELECT v ->> 'overview' FROM jsonb_each(e.translations) AS t(k, v) WHERE COALESCE(v ->> 'overview', '') <> '' ORDER BY k LIMIT 1), '')
		FROM watch_progress wp JOIN episodes e ON e.id = wp.episode_id
		WHERE wp.profile_id = $1 AND wp.media_id = $2 AND wp.completed
		ORDER BY e.season_number, e.episode_number`, pid, mediaID, lang)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var e watchedEpisode
		if err = rows.Scan(&e.ID, &e.Season, &e.Episode, &e.Name, &e.Overview); err != nil {
			return
		}
		eps = append(eps, e)
	}
	err = rows.Err()
	return
}

// finales: each season's last known episode and whether the profile completed it.
func (s *Service) finales(ctx context.Context, pid, mediaID string) ([]seasonFinale, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (e.season_number) e.season_number, COALESCE(wp.completed, false)
		FROM episodes e LEFT JOIN watch_progress wp ON wp.episode_id = e.id AND wp.profile_id = $1
		WHERE e.media_id = $2 AND e.season_number > 0
		ORDER BY e.season_number, e.episode_number DESC`, pid, mediaID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []seasonFinale
	for rows.Next() {
		var f seasonFinale
		if err := rows.Scan(&f.Season, &f.Completed); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Service) scope(ctx context.Context, pid string, t *title, movieDone bool) (foryou.CompanionScope, bool, error) {
	if t.Kind == "movie" {
		sc, ok := afterScope("movie", movieDone, nil, "")
		return sc, ok, nil
	}
	f, err := s.finales(ctx, pid, t.id)
	if err != nil {
		return foryou.CompanionScope{}, false, err
	}
	sc, ok := afterScope("series", false, f, t.status)
	return sc, ok, nil
}

// ---------------------------------------------------------------- cache, limits

func (s *Service) cached(ctx context.Context, mediaID, kind, scope, lang string, out any) (time.Time, bool) {
	var raw []byte
	var at time.Time
	err := s.pool.QueryRow(ctx, `SELECT data, created_at FROM companion_answers
		WHERE media_id = $1 AND kind = $2 AND scope = $3 AND lang = $4 AND expires_at > now()`, mediaID, kind, scope, lang).Scan(&raw, &at)
	return at, err == nil && json.Unmarshal(raw, out) == nil
}

func (s *Service) store(ctx context.Context, mediaID, kind, scope, lang string, v any, ttl time.Duration) {
	b, _ := json.Marshal(v)
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO companion_answers (media_id, kind, scope, lang, data, created_at, expires_at) VALUES ($1, $2, $3, $4, $5::jsonb, now(), $6)
		ON CONFLICT (media_id, kind, scope, lang) DO UPDATE SET data = EXCLUDED.data, created_at = now(), expires_at = EXCLUDED.expires_at`,
		mediaID, kind, scope, lang, string(b), s.now().Add(ttl)); err != nil {
		s.log.Warn("companion: cache write failed", "err", err)
	}
}

func (s *Service) day() string { return s.now().In(msk).Format("2006-01-02") }

// take counts one use for the profile today; errLimit over the cap.
func (s *Service) take(ctx context.Context, pid string) error {
	if s.limit <= 0 {
		return errLimit
	}
	var n int
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO companion_usage (profile_id, day, uses) VALUES ($1, $2::date, 1)
		ON CONFLICT (profile_id, day) DO UPDATE SET uses = companion_usage.uses + 1 RETURNING uses`, pid, s.day()).Scan(&n); err != nil {
		return err
	}
	if n > s.limit {
		s.refund(ctx, pid)
		return errLimit
	}
	return nil
}

// refund gives a use back (the model failed).
func (s *Service) refund(ctx context.Context, pid string) {
	if _, err := s.pool.Exec(context.WithoutCancel(ctx), `
		UPDATE companion_usage SET uses = greatest(uses - 1, 0) WHERE profile_id = $1 AND day = $2::date`, pid, s.day()); err != nil {
		s.log.Warn("companion: refund failed", "err", err)
	}
}

func (s *Service) usedToday(ctx context.Context, pid string) int {
	var n int
	_ = s.pool.QueryRow(ctx, `SELECT uses FROM companion_usage WHERE profile_id = $1 AND day = $2::date`, pid, s.day()).Scan(&n)
	return n
}

// once runs f once per key at a time, detached from the caller's context.
func (s *Service) once(ctx context.Context, key string, f func(ctx context.Context) (any, error)) (any, error) {
	ch := s.sf.DoChan(key, func() (any, error) {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), callTimeout)
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

// ---------------------------------------------------------------- status

// EpisodeRef is a season/episode pair.
type EpisodeRef struct {
	Season  int `json:"season"`
	Episode int `json:"episode"`
}

// Status is MediaCompanion.
type Status struct {
	AIEnabled    bool        `json:"ai_enabled"`
	DailyLimit   int         `json:"daily_limit"`
	UsedToday    int         `json:"used_today"`
	Recap        RecapStatus `json:"recap"`
	AfterCredits AfterStatus `json:"after_credits"`
}

type RecapStatus struct {
	Available     bool        `json:"available"`
	LastWatchedAt *time.Time  `json:"last_watched_at"`
	Through       *EpisodeRef `json:"through"`
	Cached        bool        `json:"cached"`
}

type AfterStatus struct {
	Available bool   `json:"available"`
	Scope     string `json:"scope"` // movie | season | series ("" when not available)
	Season    *int   `json:"season"`
}

func scopeOut(sc foryou.CompanionScope) (string, *int) {
	if sc.Kind == "movie" || sc.Kind == "" {
		return sc.Kind, nil
	}
	n := sc.Season
	return sc.Kind, &n
}

// Status says which companion buttons a profile gets on a title.
func (s *Service) Status(ctx context.Context, pid, id, lang string) (*Status, error) {
	t, err := s.title(ctx, id, lang)
	if err != nil {
		return nil, err
	}
	st := &Status{AIEnabled: s.aiOn(ctx), DailyLimit: s.limit}
	eps, last, movieDone, err := s.watched(ctx, pid, id, lang)
	if err != nil {
		return nil, err
	}
	st.Recap.LastWatchedAt = last
	if t.Kind == "series" {
		sel, through := selectRecap(eps)
		if through != nil {
			st.Recap.Through = &EpisodeRef{through.Season, through.Episode}
		}
		st.Recap.Available = st.AIEnabled && recapEligible(len(eps), last, s.now())
		if st.Recap.Available && len(sel) > 0 {
			var r Recap
			_, st.Recap.Cached = s.cached(ctx, id, "recap", recapScope(sel), lang, &r)
		}
	}
	sc, ok, err := s.scope(ctx, pid, t, movieDone)
	if err != nil {
		return nil, err
	}
	if ok && st.AIEnabled {
		st.AfterCredits.Available = true
		st.AfterCredits.Scope, st.AfterCredits.Season = scopeOut(sc)
	}
	if st.AIEnabled {
		st.UsedToday = s.usedToday(ctx, pid)
	}
	return st, nil
}

// ---------------------------------------------------------------- recap

// Recap is SeriesRecap.
type Recap struct {
	Lines       []string   `json:"lines"`
	Through     EpisodeRef `json:"through"`
	Episodes    int        `json:"episodes"`
	Cached      bool       `json:"cached"`
	GeneratedAt time.Time  `json:"generated_at"`
}

// Recap builds (or returns the cached) «Ранее в сериале».
func (s *Service) Recap(ctx context.Context, pid, id, lang string) (*Recap, error) {
	if !s.aiOn(ctx) {
		return nil, aiOff
	}
	t, err := s.title(ctx, id, lang)
	if err != nil {
		return nil, err
	}
	if t.Kind != "series" {
		return nil, errNotEligible
	}
	eps, last, _, err := s.watched(ctx, pid, id, lang)
	if err != nil {
		return nil, err
	}
	if !recapEligible(len(eps), last, s.now()) {
		return nil, errNotEligible
	}
	if miss := missingSynopses(eps); len(miss) > 0 && s.seasons != nil {
		// Best effort: load those seasons in lang once, then read again.
		for _, n := range miss {
			if _, err := s.seasons.Season(ctx, id, n, lang); err != nil {
				s.log.Info("companion: season load failed", "season", n, "err", err)
			}
		}
		if eps, _, _, err = s.watched(ctx, pid, id, lang); err != nil {
			return nil, err
		}
	}
	sel, through := selectRecap(eps)
	if len(sel) == 0 || through == nil {
		return nil, errNoSynopses
	}
	scope := recapScope(sel)
	var r Recap
	if at, ok := s.cached(ctx, id, "recap", scope, lang, &r); ok {
		r.Cached, r.GeneratedAt = true, at
		return &r, nil
	}
	if err := s.take(ctx, pid); err != nil {
		return nil, err
	}
	v, err := s.once(ctx, "recap|"+id+"|"+scope+"|"+lang, func(ctx context.Context) (any, error) {
		lines, err := s.ai.SeriesRecap(ctx, t.CompanionTitle, recapInput(sel), lang)
		if err != nil {
			return nil, err
		}
		res := &Recap{Lines: lines, Through: EpisodeRef{through.Season, through.Episode}, Episodes: len(sel), GeneratedAt: s.now()}
		s.store(ctx, id, "recap", scope, lang, res, ttlRecap)
		return res, nil
	})
	if err != nil {
		s.refund(ctx, pid)
		return nil, err
	}
	return v.(*Recap), nil
}

// ---------------------------------------------------------------- after the credits

// After is AfterCredits.
type After struct {
	Topic       string    `json:"topic"`
	Known       bool      `json:"known"`
	Paragraphs  []string  `json:"paragraphs"`
	Scope       string    `json:"scope"`
	Season      *int      `json:"season"`
	Cached      bool      `json:"cached"`
	GeneratedAt time.Time `json:"generated_at"`
}

// eligible returns the title and finished scope, or errNotEligible.
func (s *Service) eligible(ctx context.Context, pid, id, lang string) (*title, foryou.CompanionScope, error) {
	t, err := s.title(ctx, id, lang)
	if err != nil {
		return nil, foryou.CompanionScope{}, err
	}
	_, _, movieDone, err := s.watched(ctx, pid, id, lang)
	if err != nil {
		return nil, foryou.CompanionScope{}, err
	}
	sc, ok, err := s.scope(ctx, pid, t, movieDone)
	if err != nil {
		return nil, sc, err
	}
	if !ok {
		return nil, sc, errNotEligible
	}
	return t, sc, nil
}

// AfterCredits writes (or returns the cached) «Объяснение финала» /
// «Почему это важно».
func (s *Service) AfterCredits(ctx context.Context, pid, id, topic, lang string) (*After, error) {
	if !s.aiOn(ctx) {
		return nil, aiOff
	}
	t, sc, err := s.eligible(ctx, pid, id, lang)
	if err != nil {
		return nil, err
	}
	key := scopeKey(sc)
	var a After
	if at, ok := s.cached(ctx, id, topic, key, lang, &a); ok {
		a.Cached, a.GeneratedAt = true, at
		return &a, nil
	}
	if err := s.take(ctx, pid); err != nil {
		return nil, err
	}
	v, err := s.once(ctx, topic+"|"+id+"|"+key+"|"+lang, func(ctx context.Context) (any, error) {
		txt, err := s.ai.AfterCredits(ctx, t.CompanionTitle, sc, topic, lang)
		if err != nil {
			return nil, err
		}
		res := &After{Topic: topic, Known: txt.Known, Paragraphs: txt.Paragraphs, GeneratedAt: s.now()}
		res.Scope, res.Season = scopeOut(sc)
		s.store(ctx, id, topic, key, lang, res, ttlAfter)
		return res, nil
	})
	if err != nil {
		s.refund(ctx, pid)
		return nil, err
	}
	return v.(*After), nil
}

// ---------------------------------------------------------------- chat

// Chat is AfterCreditsChat.
type Chat struct {
	Messages  []foryou.ChatTurn `json:"messages"`
	Followups []string          `json:"followups"`
	Limit     int               `json:"limit"`
	Remaining int               `json:"remaining"`
	Scope     string            `json:"scope"`
	Season    *int              `json:"season"`
	// Refused: the last answer declined an off-topic message.
	Refused bool `json:"refused"`
}

func (s *Service) loadChat(ctx context.Context, pid, id, key string) ([]foryou.ChatTurn, []string, error) {
	var scope string
	var mb, fb []byte
	err := s.pool.QueryRow(ctx, `SELECT scope, messages, followups FROM companion_chats WHERE profile_id = $1 AND media_id = $2`, pid, id).Scan(&scope, &mb, &fb)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && scope != key) {
		return []foryou.ChatTurn{}, []string{}, nil // none, or about an earlier season: start fresh
	}
	if err != nil {
		return nil, nil, err
	}
	msgs, fus := []foryou.ChatTurn{}, []string{}
	_ = json.Unmarshal(mb, &msgs)
	_ = json.Unmarshal(fb, &fus)
	return msgs, fus, nil
}

func (s *Service) saveChat(ctx context.Context, pid, id, key, lang string, msgs []foryou.ChatTurn, fus []string) error {
	mb, _ := json.Marshal(msgs)
	fb, _ := json.Marshal(fus)
	_, err := s.pool.Exec(context.WithoutCancel(ctx), `
		INSERT INTO companion_chats (profile_id, media_id, scope, lang, messages, followups, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
		ON CONFLICT (profile_id, media_id) DO UPDATE SET scope = EXCLUDED.scope, lang = EXCLUDED.lang, messages = EXCLUDED.messages,
			followups = EXCLUDED.followups, updated_at = now()`, pid, id, key, lang, mb, fb)
	return err
}

func chatOut(msgs []foryou.ChatTurn, fus []string, sc foryou.CompanionScope) *Chat {
	c := &Chat{Messages: msgs, Followups: fus, Limit: ChatMaxUser, Remaining: chatRemaining(msgs)}
	c.Scope, c.Season = scopeOut(sc)
	return c
}

// GetChat returns the profile's chat about what it finished.
func (s *Service) GetChat(ctx context.Context, pid, id, lang string) (*Chat, error) {
	if !s.aiOn(ctx) {
		return nil, aiOff
	}
	_, sc, err := s.eligible(ctx, pid, id, lang)
	if err != nil {
		return nil, err
	}
	msgs, fus, err := s.loadChat(ctx, pid, id, scopeKey(sc))
	if err != nil {
		return nil, err
	}
	return chatOut(msgs, fus, sc), nil
}

// SendChat optionally restarts the chat, then answers message (if any).
func (s *Service) SendChat(ctx context.Context, pid, id, lang, message string, reset bool) (*Chat, error) {
	if !s.aiOn(ctx) {
		return nil, aiOff
	}
	t, sc, err := s.eligible(ctx, pid, id, lang)
	if err != nil {
		return nil, err
	}
	key := scopeKey(sc)
	msgs, fus, err := s.loadChat(ctx, pid, id, key)
	if err != nil {
		return nil, err
	}
	if reset {
		msgs, fus = []foryou.ChatTurn{}, []string{}
		if message == "" {
			if err := s.saveChat(ctx, pid, id, key, lang, msgs, fus); err != nil {
				return nil, err
			}
			return chatOut(msgs, fus, sc), nil
		}
	}
	if chatRemaining(msgs) == 0 {
		return nil, errChatFull
	}
	if err := s.take(ctx, pid); err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), callTimeout)
	defer cancel()
	reply, err := s.ai.AfterCreditsChat(cctx, t.CompanionTitle, sc, chatContext(msgs), message, lang)
	if err != nil {
		s.refund(ctx, pid)
		return nil, err
	}
	msgs = append(msgs, foryou.ChatTurn{Role: "user", Text: message}, foryou.ChatTurn{Role: "assistant", Text: reply.Answer})
	if err := s.saveChat(ctx, pid, id, key, lang, msgs, reply.Followups); err != nil {
		return nil, err
	}
	c := chatOut(msgs, reply.Followups, sc)
	c.Refused = reply.Refused
	return c, nil
}

// ---------------------------------------------------------------- handlers

// aiOff is returned when DeepSeek is not configured or switched off.
var aiOff = errors.New("companion ai off")

func langOf(v string) (string, error) {
	switch v {
	case "", "en":
		return "en", nil
	case "ru":
		return "ru", nil
	}
	return "", httpx.Validation(map[string]string{"lang": "must be one of en, ru"})
}

// access validates the profile id and the caller's right to it (404).
func (s *Service) access(c fiber.Ctx, pid string) (string, error) {
	if pid == "" {
		return "", httpx.Validation(map[string]string{"profile_id": "is required"})
	}
	if _, err := uuid.Parse(pid); err != nil || len(pid) != 36 {
		return "", httpx.Validation(map[string]string{"profile_id": "must be a UUID"})
	}
	pid = strings.Clone(pid)
	ok, err := s.profiles.CanUse(c.Context(), auth.PrincipalFrom(c), pid)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", httpx.NotFound()
	}
	return pid, nil
}

type body struct {
	ProfileID string `json:"profile_id"`
	Lang      string `json:"lang"`
	Topic     string `json:"topic"`
	Message   string `json:"message"`
	Reset     bool   `json:"reset"`
}

// params reads the media id, profile and language (query for GET, body for POST).
func (s *Service) params(c fiber.Ctx) (id, pid, lang string, b body, err error) {
	if id, err = httpx.ParamUUID(c, "id"); err != nil {
		return
	}
	if c.Method() == fiber.MethodGet {
		b.ProfileID, b.Lang = c.Query("profile_id"), c.Query("lang")
	} else if err = httpx.BindJSON(c, &b); err != nil {
		return
	}
	if b.Lang == "" {
		b.Lang = c.Query("lang")
	}
	if lang, err = langOf(b.Lang); err != nil {
		return
	}
	pid, err = s.access(c, b.ProfileID)
	return
}

func (s *Service) untilMidnight() time.Duration {
	now := s.now().In(msk)
	y, m, d := now.Date()
	return time.Date(y, m, d+1, 0, 0, 0, 0, msk).Sub(now)
}

func (s *Service) fail(err error) error {
	switch {
	case errors.Is(err, errNotFound):
		return httpx.NotFound()
	case errors.Is(err, aiOff), foryou.IsAIDisabled(err):
		return httpx.NewError(fiber.StatusServiceUnavailable, "ai_disabled", "AI is not configured or switched off.")
	case errors.Is(err, errNotEligible):
		return httpx.NewError(fiber.StatusConflict, "not_eligible", "Not available for this title yet.")
	case errors.Is(err, errNoSynopses):
		return httpx.NewError(fiber.StatusUnprocessableEntity, "no_synopses", "The watched episodes have no descriptions to build a recap from.")
	case errors.Is(err, errChatFull):
		return httpx.NewError(fiber.StatusConflict, "chat_full", fmt.Sprintf("This chat has used all %d questions. Start a new one.", ChatMaxUser))
	case errors.Is(err, errLimit):
		e := httpx.NewError(fiber.StatusTooManyRequests, "companion_limit", fmt.Sprintf("This profile has used all %d AI answers for today. Try again tomorrow.", s.limit))
		e.RetryAfter = s.untilMidnight()
		return e
	case foryou.IsAIBudget(err):
		e := httpx.NewError(fiber.StatusTooManyRequests, "ai_budget", "The AI has used up today's budget. Try again tomorrow.")
		e.RetryAfter = s.untilMidnight()
		return e
	case foryou.IsAIFailure(err):
		return httpx.NewError(fiber.StatusBadGateway, "ai_failed", "The AI could not answer right now. Try again.")
	case errors.Is(err, context.Canceled):
		return err
	}
	return err
}

func (s *Service) hStatus(c fiber.Ctx) error {
	id, pid, lang, _, err := s.params(c)
	if err != nil {
		return err
	}
	st, err := s.Status(c.Context(), pid, id, lang)
	if err != nil {
		return s.fail(err)
	}
	return c.JSON(st)
}

func (s *Service) hRecap(c fiber.Ctx) error {
	id, pid, lang, _, err := s.params(c)
	if err != nil {
		return err
	}
	r, err := s.Recap(c.Context(), pid, id, lang)
	if err != nil {
		return s.fail(err)
	}
	return c.JSON(r)
}

func (s *Service) hAfter(c fiber.Ctx) error {
	id, pid, lang, b, err := s.params(c)
	if err != nil {
		return err
	}
	if b.Topic != "ending" && b.Topic != "significance" {
		return httpx.Validation(map[string]string{"topic": "must be ending or significance"})
	}
	a, err := s.AfterCredits(c.Context(), pid, id, b.Topic, lang)
	if err != nil {
		return s.fail(err)
	}
	return c.JSON(a)
}

func (s *Service) hChat(c fiber.Ctx) error {
	id, pid, lang, _, err := s.params(c)
	if err != nil {
		return err
	}
	ch, err := s.GetChat(c.Context(), pid, id, lang)
	if err != nil {
		return s.fail(err)
	}
	return c.JSON(ch)
}

// cleanMessage: one line, no control characters.
func cleanMessage(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

func (s *Service) hChatSend(c fiber.Ctx) error {
	id, pid, lang, b, err := s.params(c)
	if err != nil {
		return err
	}
	msg := cleanMessage(b.Message)
	if n := utf8.RuneCountInString(msg); (n > 0 || !b.Reset) && (n < chatMinPrompt || n > chatMaxPrompt) {
		return httpx.Validation(map[string]string{"message": fmt.Sprintf("must be %d–%d characters", chatMinPrompt, chatMaxPrompt)})
	}
	ch, err := s.SendChat(c.Context(), pid, id, lang, msg, b.Reset)
	if err != nil {
		return s.fail(err)
	}
	return c.JSON(ch)
}
