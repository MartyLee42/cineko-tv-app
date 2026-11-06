package curated

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/time/rate"

	"martytv/api/internal/auth"
	"martytv/api/internal/catalog"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
)

// ErrNotFound is an unknown list id.
var ErrNotFound = errors.New("curated: not found")

// Catalog is what curated needs from the catalog service.
type Catalog interface {
	Available() bool
	EnsureByTMDB(ctx context.Context, kind string, tmdbID int, lang string) (*catalog.MediaSummary, error)
	SearchYear(ctx context.Context, query, kind, lang string, year int) (*catalog.MediaPage, error)
	SummariesByID(ctx context.Context, ids []string, lang string) (map[string]catalog.MediaSummary, error)
}

// Deps wires the service.
type Deps struct {
	Pool     *pgxpool.Pool
	Catalog  Catalog
	Personal catalog.Personalizer
	Profiles *profiles.Store
	Ratings  catalog.RatingsSource // optional
	Log      *slog.Logger
}

type Service struct {
	pool     *pgxpool.Pool
	cat      Catalog
	personal catalog.Personalizer
	profiles *profiles.Store
	ratings  catalog.RatingsSource
	log      *slog.Logger
	now      func() time.Time
	// pace limits the resolver's TMDB calls (on top of the client's limiter).
	pace      *rate.Limiter
	resolveMu sync.Mutex

	mu    sync.RWMutex
	lists []List
	byID  map[string]*List
}

func NewService(d Deps) *Service {
	s := &Service{pool: d.Pool, cat: d.Catalog, personal: d.Personal, profiles: d.Profiles, ratings: d.Ratings, log: d.Log,
		now: time.Now, pace: rate.NewLimiter(rate.Limit(3), 3)}
	lists, err := Embedded()
	if err != nil {
		// Validated by tests; never take the server down for a bad file.
		d.Log.Error("curated: bad list files; «Подборки» disabled", "err", err)
	}
	s.SetLists(lists)
	return s
}

// SetLists replaces the lists (tests).
func (s *Service) SetLists(lists []List) {
	by := make(map[string]*List, len(lists))
	for i := range lists {
		by[lists[i].ID] = &lists[i]
	}
	s.mu.Lock()
	s.lists, s.byID = lists, by
	s.mu.Unlock()
}

// SetPace changes the resolver pace (tests).
func (s *Service) SetPace(perSecond float64) {
	s.pace = rate.NewLimiter(rate.Limit(perSecond), max(1, int(perSecond)))
}

// Lists returns all lists in group order.
func (s *Service) Lists() []List {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lists
}

// Get returns one list (nil = unknown).
func (s *Service) Get(id string) *List {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byID[id]
}

// ---- reading ----

// Entry is a resolved list position.
type Entry struct {
	Position int
	MediaID  string
	Watched  bool
}

// Progress is one list with its resolved titles and the profile's progress.
type Progress struct {
	List    *List
	Entries []Entry // resolved positions, in list order
	Watched int
}

// Watched is the «просмотрено» rule: finished or rated.
func Watched(st catalog.MediaUserState) bool { return st.Completed || st.Rating != nil }

// resolved returns list id → resolved positions (in order).
func (s *Service) resolved(ctx context.Context, listIDs []string) (map[string][]Entry, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT list_id, position, media_id::text FROM curated_items
		WHERE media_id IS NOT NULL AND list_id = ANY($1::text[]) ORDER BY list_id, position`, listIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]Entry{}
	for rows.Next() {
		var list string
		var e Entry
		if err := rows.Scan(&list, &e.Position, &e.MediaID); err != nil {
			return nil, err
		}
		out[list] = append(out[list], e)
	}
	return out, rows.Err()
}

// states returns the profile's state per id ({} without a profile).
func (s *Service) states(ctx context.Context, profileID string, ids []string) (map[string]catalog.MediaUserState, error) {
	if profileID == "" || len(ids) == 0 {
		return map[string]catalog.MediaUserState{}, nil
	}
	return s.personal.UserStates(ctx, profileID, uniqIDs(ids))
}

// Progress returns every list with resolved titles and the profile's
// watched counts (profileID "" = nothing watched).
func (s *Service) Progress(ctx context.Context, profileID string) ([]Progress, error) {
	lists := s.Lists()
	ids := make([]string, len(lists))
	for i, l := range lists {
		ids[i] = l.ID
	}
	res, err := s.resolved(ctx, ids)
	if err != nil {
		return nil, err
	}
	var all []string
	for _, es := range res {
		for _, e := range es {
			all = append(all, e.MediaID)
		}
	}
	states, err := s.states(ctx, profileID, all)
	if err != nil {
		return nil, err
	}
	out := make([]Progress, len(lists))
	for i := range lists {
		p := Progress{List: &lists[i], Entries: res[lists[i].ID]}
		for j := range p.Entries {
			if Watched(states[p.Entries[j].MediaID]) {
				p.Entries[j].Watched = true
				p.Watched++
			}
		}
		out[i] = p
	}
	return out, nil
}

// ListSummary is the contract's CuratedListSummary.
type ListSummary struct {
	ID          string   `json:"id"`
	Group       string   `json:"group"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Author      string   `json:"author"`
	Source      string   `json:"source"`
	SourceURL   *string  `json:"source_url"`
	Ordered     bool     `json:"ordered"`
	Count       int      `json:"count"`
	Resolved    int      `json:"resolved"`
	Watched     int      `json:"watched"`
	Covers      []string `json:"covers"`
}

// GroupOut is the contract's CuratedGroup.
type GroupOut struct {
	ID    string        `json:"id"`
	Title string        `json:"title"`
	Lists []ListSummary `json:"lists"`
}

// ItemOut is the contract's CuratedItem.
type ItemOut struct {
	Position      int                   `json:"position"`
	Rank          *int                  `json:"rank"`
	Title         string                `json:"title"`
	OriginalTitle string                `json:"original_title"`
	Year          int                   `json:"year"`
	Kind          string                `json:"kind"`
	Note          *string               `json:"note"`
	Watched       bool                  `json:"watched"`
	Media         *catalog.MediaSummary `json:"media"`
}

// ListOut is the contract's CuratedList.
type ListOut struct {
	ListSummary
	Items []ItemOut `json:"items"`
}

// GroupTitle is the localized group title.
func GroupTitle(lang, group string) string {
	switch group {
	case "thinkers":
		return pick(lang, "Мыслители и критики", "Thinkers & critics")
	case "directors":
		return pick(lang, "Списки режиссёров", "Directors' lists")
	case "polls":
		return pick(lang, "Опросы и каноны", "Polls & canons")
	case "modern":
		return pick(lang, "Современное кино", "Modern cinema")
	case "ru":
		return pick(lang, "Русское и советское кино", "Russian & Soviet cinema")
	}
	return group
}

func summary(l *List, lang string, p Progress) ListSummary {
	out := ListSummary{ID: l.ID, Group: l.Group, Title: l.Title(lang), Description: l.Description(lang),
		Author: l.Author, Source: l.Source, Ordered: l.Ordered, Count: len(l.Items),
		Resolved: len(p.Entries), Watched: p.Watched, Covers: []string{}}
	if l.SourceURL != "" {
		u := l.SourceURL
		out.SourceURL = &u
	}
	return out
}

// Overview is GET /curated: the lists by group with 4 cover posters each.
func (s *Service) Overview(ctx context.Context, profileID, lang string) ([]GroupOut, error) {
	progress, err := s.Progress(ctx, profileID)
	if err != nil {
		return nil, err
	}
	var coverIDs []string
	for _, p := range progress {
		for i, e := range p.Entries {
			if i >= 8 { // a few spares for titles without a poster
				break
			}
			coverIDs = append(coverIDs, e.MediaID)
		}
	}
	sums, err := s.cat.SummariesByID(ctx, uniqIDs(coverIDs), lang)
	if err != nil {
		return nil, err
	}
	out := []GroupOut{}
	for _, g := range Groups {
		grp := GroupOut{ID: g, Title: GroupTitle(lang, g), Lists: []ListSummary{}}
		for _, p := range progress {
			if p.List.Group != g {
				continue
			}
			ls := summary(p.List, lang, p)
			for _, e := range p.Entries {
				if m, ok := sums[e.MediaID]; ok && m.PosterPath != nil && len(ls.Covers) < 4 {
					ls.Covers = append(ls.Covers, *m.PosterPath)
				}
			}
			grp.Lists = append(grp.Lists, ls)
		}
		if len(grp.Lists) > 0 {
			out = append(out, grp)
		}
	}
	return out, nil
}

// List is GET /curated/{id}: every item in list order; resolved ones carry
// the title (with `me` for a profile and ratings).
func (s *Service) List(ctx context.Context, id, profileID, lang string) (*ListOut, error) {
	l := s.Get(id)
	if l == nil {
		return nil, ErrNotFound
	}
	res, err := s.resolved(ctx, []string{id})
	if err != nil {
		return nil, err
	}
	byPos := map[int]string{}
	ids := make([]string, 0, len(res[id]))
	for _, e := range res[id] {
		byPos[e.Position] = e.MediaID
		ids = append(ids, e.MediaID)
	}
	sums, err := s.cat.SummariesByID(ctx, uniqIDs(ids), lang)
	if err != nil {
		return nil, err
	}
	s.annotateRatings(ctx, sums)
	states, err := s.states(ctx, profileID, ids)
	if err != nil {
		return nil, err
	}
	p := Progress{List: l}
	out := &ListOut{Items: make([]ItemOut, 0, len(l.Items))}
	for i := range l.Items {
		it := &l.Items[i]
		pos := i + 1
		o := ItemOut{Position: pos, Title: it.Title, OriginalTitle: it.OriginalTitle, Year: it.Year, Kind: it.Kind}
		switch {
		case it.Rank != nil: // published rank (ties share one)
			r := *it.Rank
			o.Rank = &r
		case l.Ordered:
			r := pos
			o.Rank = &r
		}
		if n := it.Note(lang); n != "" {
			o.Note = &n
		}
		if mid, ok := byPos[pos]; ok {
			if m, ok := sums[mid]; ok {
				if profileID != "" {
					st := states[mid]
					m.Me = &st
					o.Watched = Watched(st)
				}
				o.Media = &m
				p.Entries = append(p.Entries, Entry{Position: pos, MediaID: mid, Watched: o.Watched})
				if o.Watched {
					p.Watched++
				}
			}
		}
		out.Items = append(out.Items, o)
	}
	out.ListSummary = summary(l, lang, p)
	for _, o := range out.Items {
		if o.Media != nil && o.Media.PosterPath != nil && len(out.Covers) < 4 {
			out.Covers = append(out.Covers, *o.Media.PosterPath)
		}
	}
	return out, nil
}

func (s *Service) annotateRatings(ctx context.Context, sums map[string]catalog.MediaSummary) {
	if s.ratings == nil || len(sums) == 0 {
		return
	}
	ids := make([]string, 0, len(sums))
	for id := range sums {
		ids = append(ids, id)
	}
	rs, err := s.ratings.Ratings(ctx, ids)
	if err != nil {
		s.log.WarnContext(ctx, "curated: ratings lookup failed", "err", err)
		return
	}
	for id, m := range sums {
		if r, ok := rs[id]; ok {
			m.KPRating, m.IMDbRating, m.AwardBadge = r.KP, r.IMDb, r.Award
			sums[id] = m
		}
	}
}

func uniqIDs(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// ---- HTTP ----

// Routes mounts GET /curated and GET /curated/:list_id.
func (s *Service) Routes(r fiber.Router) {
	caller := profiles.RequireProfileCaller()
	r.Get("/curated", caller, s.hOverview)
	r.Get("/curated/:list_id", caller, s.hList)
}

func (s *Service) params(c fiber.Ctx) (profileID, lang string, err error) {
	switch c.Query("lang") {
	case "", "en":
		lang = "en"
	case "ru":
		lang = "ru"
	default:
		return "", "", httpx.Validation(map[string]string{"lang": "must be one of en, ru"})
	}
	pid := c.Query("profile_id")
	if pid == "" {
		return "", lang, nil
	}
	if _, err := uuid.Parse(pid); err != nil || len(pid) != 36 {
		return "", "", httpx.Validation(map[string]string{"profile_id": "must be a UUID"})
	}
	pid = strings.Clone(pid)
	ok, err := s.profiles.CanUse(c.Context(), auth.PrincipalFrom(c), pid)
	if err != nil {
		return "", "", err
	}
	if !ok {
		return "", "", httpx.NotFound()
	}
	return pid, lang, nil
}

func (s *Service) hOverview(c fiber.Ctx) error {
	pid, lang, err := s.params(c)
	if err != nil {
		return err
	}
	groups, err := s.Overview(c.Context(), pid, lang)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"groups": groups})
}

func (s *Service) hList(c fiber.Ctx) error {
	pid, lang, err := s.params(c)
	if err != nil {
		return err
	}
	id := c.Params("list_id")
	if !idRe.MatchString(id) {
		return httpx.NotFound()
	}
	l, err := s.List(c.Context(), strings.Clone(id), pid, lang)
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound()
	}
	if err != nil {
		return err
	}
	return c.JSON(l)
}
