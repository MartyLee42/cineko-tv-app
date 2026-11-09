package keepsakes

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/auth"
	"martytv/api/internal/catalog"
	"martytv/api/internal/httpx"
	"martytv/api/internal/profiles"
)

// Cinema is the name printed on every stub.
const Cinema = "Cineko"

type Options struct {
	Pool     *pgxpool.Pool
	Profiles *profiles.Store
	Catalog  *catalog.Service
	// Location: the household's wall clock (config.Household).
	Location *time.Location
}

type Service struct {
	pool     *pgxpool.Pool
	profiles *profiles.Store
	catalog  *catalog.Service
	loc      *time.Location
}

func New(o Options) *Service {
	if o.Location == nil {
		o.Location = time.UTC
	}
	return &Service{pool: o.Pool, profiles: o.Profiles, catalog: o.Catalog, loc: o.Location}
}

// ---- tickets ----

// Ticket is the contract's TicketStub.
type Ticket struct {
	Number     int                  `json:"number"`
	Media      catalog.MediaSummary `json:"media"`
	FinishedAt time.Time            `json:"finished_at"`
	// Date / Time: FinishedAt on the household's clock (yyyy-mm-dd, HH:MM).
	Date   string `json:"date"`
	Time   string `json:"time"`
	Hall   int    `json:"hall"`
	Row    int    `json:"row"`
	Seat   int    `json:"seat"`
	Rating *int   `json:"rating"`
}

type TicketPage struct {
	Items      []Ticket `json:"items"`
	NextCursor *string  `json:"next_cursor"`
	Total      int      `json:"total"`
	Cinema     string   `json:"cinema"`
	Timezone   string   `json:"timezone"`
}

// lockProfile serializes stub/sticker issuing for one profile (two TVs
// opening «Моё» at once must not hand out the same number).
const lockProfile = `SELECT pg_advisory_xact_lock(hashtextextended('martytv/keepsakes/' || $1::text, 0))`

// IssueTickets gives every finished film without a stub one, numbered after
// the profile's last stub in finish order. Returns how many were issued.
func (s *Service) IssueTickets(ctx context.Context, profileID string) (int, error) {
	var n int64
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, lockProfile, profileID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO ticket_stubs (profile_id, media_id, number, finished_at)
			SELECT wp.profile_id, wp.media_id,
			       (SELECT COALESCE(max(number), 0) FROM ticket_stubs WHERE profile_id = $1)
			         + row_number() OVER (ORDER BY COALESCE(wp.completed_at, wp.updated_at), wp.media_id),
			       COALESCE(wp.completed_at, wp.updated_at)
			FROM watch_progress wp JOIN media m ON m.id = wp.media_id
			WHERE wp.profile_id = $1 AND wp.completed AND wp.episode_id IS NULL AND m.kind = 'movie'
			  AND NOT EXISTS (SELECT 1 FROM ticket_stubs t WHERE t.profile_id = $1 AND t.media_id = wp.media_id)`, profileID)
		n = tag.RowsAffected()
		return err
	})
	return int(n), err
}

// Tickets returns one page of stubs, newest (highest number) first. cursor
// is the number to continue below.
func (s *Service) Tickets(ctx context.Context, profileID string, cursor, limit int, lang string) (*TicketPage, error) {
	if _, err := s.IssueTickets(ctx, profileID); err != nil {
		return nil, err
	}
	out := &TicketPage{Items: []Ticket{}, Cinema: Cinema, Timezone: s.loc.String()}
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM ticket_stubs WHERE profile_id = $1`, profileID).Scan(&out.Total); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT t.number, t.media_id, t.finished_at, r.rating::int
		FROM ticket_stubs t LEFT JOIN ratings r ON r.profile_id = t.profile_id AND r.media_id = t.media_id
		WHERE t.profile_id = $1 AND ($2 = 0 OR t.number < $2)
		ORDER BY t.number DESC LIMIT $3`, profileID, cursor, limit+1)
	if err != nil {
		return nil, err
	}
	var list []Ticket
	var ids []string
	for rows.Next() {
		var t Ticket
		if err := rows.Scan(&t.Number, &t.Media.ID, &t.FinishedAt, &t.Rating); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, t)
		ids = append(ids, t.Media.ID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(list) > limit {
		list = list[:limit]
		next := strconv.Itoa(list[limit-1].Number)
		out.NextCursor = &next
	}
	media, err := s.catalog.SummariesByID(ctx, ids, lang)
	if err != nil {
		return nil, err
	}
	for _, t := range list {
		m, ok := media[t.Media.ID]
		if !ok {
			continue
		}
		seat := SeatFor(profileID, t.Media.ID)
		local := t.FinishedAt.In(s.loc)
		t.Media, t.Hall, t.Row, t.Seat = m, seat.Hall, seat.Row, seat.Seat
		t.Date, t.Time = local.Format(time.DateOnly), local.Format("15:04")
		out.Items = append(out.Items, t)
	}
	return out, nil
}

// ---- achievements ----

// Achievement is the contract's Achievement (only unlocked ones are listed).
type Achievement struct {
	ID         string    `json:"id"`
	UnlockedAt time.Time `json:"unlocked_at"`
	Date       string    `json:"date"`
	MediaID    *string   `json:"media_id"`
	MediaTitle *string   `json:"media_title"`
}

// AchievementProgress: a locked counter sticker on its way (have of need).
type AchievementProgress struct {
	ID   string `json:"id"`
	Have int    `json:"have"`
	Need int    `json:"need"`
}

type AchievementList struct {
	Items []Achievement `json:"items"`
	// Progress: the next locked goal of each counter ladder already started.
	Progress []AchievementProgress `json:"progress"`
	// Secret: how many stickers are still hidden (neither earned nor in progress).
	Secret int `json:"secret"`
	Total  int `json:"total"`
}

// LoadHistory reads the facts the rules need for one profile (Earned is
// left to the caller).
func (s *Service) LoadHistory(ctx context.Context, profileID string) (History, error) {
	h := History{Seasons: map[SeasonKey][]Episode{}}
	rows, err := s.pool.Query(ctx, `
		SELECT wp.media_id, m.kind, wp.episode_id, COALESCE(e.season_number, 0), COALESCE(e.episode_number, 0),
		       COALESCE(to_char(e.air_date, 'YYYY-MM-DD'), ''), COALESCE(wp.completed_at, wp.updated_at), wp.manual,
		       m.original_language, m.release_date,
		       CASE WHEN wp.episode_id IS NULL THEN COALESCE(m.runtime, 0) ELSE COALESCE(e.runtime, m.runtime, 0) END
		FROM watch_progress wp JOIN media m ON m.id = wp.media_id LEFT JOIN episodes e ON e.id = wp.episode_id
		WHERE wp.profile_id = $1 AND wp.completed`, profileID)
	if err != nil {
		return h, err
	}
	var series, media []string
	seen := map[string]bool{}
	seenMedia := map[string]bool{}
	for rows.Next() {
		var c Completion
		var ep *string
		if err := rows.Scan(&c.MediaID, &c.Kind, &ep, &c.Season, &c.EpisodeNumber, &c.AirDate, &c.At, &c.Manual,
			&c.Lang, &c.Released, &c.Runtime); err != nil {
			rows.Close()
			return h, err
		}
		if ep != nil {
			c.EpisodeID = *ep
			if c.Season > 0 && !seen[c.MediaID] {
				seen[c.MediaID] = true
				series = append(series, c.MediaID)
			}
		}
		if !seenMedia[c.MediaID] {
			seenMedia[c.MediaID] = true
			media = append(media, c.MediaID)
		}
		h.Completions = append(h.Completions, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return h, err
	}
	if err := s.loadTitleFacts(ctx, &h, media); err != nil {
		return h, err
	}
	if err := s.loadRewatchesAndRatings(ctx, &h, profileID); err != nil {
		return h, err
	}
	if len(series) == 0 {
		return h, nil
	}
	rows, err = s.pool.Query(ctx, `
		SELECT media_id, season_number, id, COALESCE(to_char(air_date, 'YYYY-MM-DD'), '')
		FROM episodes WHERE media_id = ANY($1::uuid[]) AND season_number > 0`, series)
	if err != nil {
		return h, err
	}
	defer rows.Close()
	for rows.Next() {
		var k SeasonKey
		var e Episode
		if err := rows.Scan(&k.MediaID, &k.Season, &e.ID, &e.AirDate); err != nil {
			return h, err
		}
		h.Seasons[k] = append(h.Seasons[k], e)
	}
	return h, rows.Err()
}

// titleFacts: what a title is (shared by all its completions).
type titleFacts struct {
	genres    []int
	countries []string
	vote      float64
	votes     int
	oscar     bool
	status    string
	episodes  int
}

// loadTitleFacts fills genres, countries, TMDB votes, Oscars and series
// status in one query for every finished title.
func (s *Service) loadTitleFacts(ctx context.Context, h *History, media []string) error {
	if len(media) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.countries, m.vote_average, m.vote_count, m.status, COALESCE(m.number_of_episodes, 0),
		       COALESCE((SELECT array_agg(g.genre_id ORDER BY g.genre_id) FROM media_genres g WHERE g.media_id = m.id), '{}'),
		       EXISTS (SELECT 1 FROM media_awards a WHERE a.media_id = m.id AND a.group_key = 'oscar' AND a.won)
		FROM media m WHERE m.id = ANY($1::uuid[])`, media)
	if err != nil {
		return err
	}
	defer rows.Close()
	byID := map[string]*titleFacts{}
	for rows.Next() {
		var id string
		var t titleFacts
		var genres []int32
		if err := rows.Scan(&id, &t.countries, &t.vote, &t.votes, &t.status, &t.episodes, &genres, &t.oscar); err != nil {
			return err
		}
		for _, g := range genres {
			t.genres = append(t.genres, int(g))
		}
		byID[id] = &t
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range h.Completions {
		c := &h.Completions[i]
		if t := byID[c.MediaID]; t != nil {
			c.Genres, c.Countries, c.Vote, c.Votes, c.Oscar, c.Status, c.TotalEpisodes =
				t.genres, t.countries, t.vote, t.votes, t.oscar, t.status, t.episodes
		}
	}
	return nil
}

// loadRewatchesAndRatings: films played to the end again (sessions started
// after the first finish that reached 90 %; sessions are kept 30 days) and
// the profile's own ratings.
func (s *Service) loadRewatchesAndRatings(ctx context.Context, h *History, profileID string) error {
	rows, err := s.pool.Query(ctx, `
		SELECT ps.media_id, ps.updated_at FROM playback_sessions ps
		JOIN watch_progress wp ON wp.profile_id = ps.profile_id AND wp.media_id = ps.media_id AND wp.episode_id IS NULL
		WHERE ps.profile_id = $1 AND ps.episode_id IS NULL AND wp.completed AND wp.completed_at IS NOT NULL
		  AND ps.started_at > wp.completed_at AND ps.last_duration > 0 AND ps.last_position >= 0.9 * ps.last_duration`, profileID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var r Rewatch
		if err := rows.Scan(&r.MediaID, &r.At); err != nil {
			rows.Close()
			return err
		}
		h.Rewatches = append(h.Rewatches, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	rows, err = s.pool.Query(ctx, `SELECT media_id, rating, created_at, updated_at FROM ratings WHERE profile_id = $1`, profileID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var r Rating
		if err := rows.Scan(&r.MediaID, &r.Value, &r.Created, &r.Updated); err != nil {
			return err
		}
		h.Ratings = append(h.Ratings, r)
	}
	return rows.Err()
}

// Achievements records newly earned stickers (silently: no events) and
// lists the profile's unlocked ones, plus the progress of the next counter
// goals.
func (s *Service) Achievements(ctx context.Context, profileID, lang string) (*AchievementList, error) {
	have := map[string]time.Time{}
	if err := s.scanUnlocked(ctx, profileID, func(id string, at time.Time) { have[id] = at }); err != nil {
		return nil, err
	}
	var next []Progress
	if len(have) < len(Rules) {
		h, err := s.LoadHistory(ctx, profileID)
		if err != nil {
			return nil, err
		}
		h.Earned = have
		unlocks, progress := Assess(h, s.loc)
		next = progress
		var fresh []Unlock
		for _, u := range unlocks {
			if _, ok := have[u.ID]; !ok {
				fresh = append(fresh, u)
			}
		}
		if len(fresh) > 0 {
			err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
				if _, err := tx.Exec(ctx, lockProfile, profileID); err != nil {
					return err
				}
				for _, u := range fresh {
					var mid *string
					if u.MediaID != "" {
						mid = &u.MediaID
					}
					if _, err := tx.Exec(ctx, `
						INSERT INTO profile_achievements (profile_id, achievement_id, unlocked_at, media_id)
						VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, profileID, u.ID, u.At, mid); err != nil {
						return err
					}
				}
				return nil
			})
			if err != nil {
				return nil, err
			}
		}
	}

	known := map[string]bool{}
	for _, r := range Rules {
		known[r.ID] = true
	}
	rows, err := s.pool.Query(ctx, `
		SELECT achievement_id, unlocked_at, media_id FROM profile_achievements
		WHERE profile_id = $1 ORDER BY unlocked_at, achievement_id`, profileID)
	if err != nil {
		return nil, err
	}
	out := &AchievementList{Items: []Achievement{}, Progress: []AchievementProgress{}, Total: len(Rules)}
	var ids []string
	for rows.Next() {
		var a Achievement
		if err := rows.Scan(&a.ID, &a.UnlockedAt, &a.MediaID); err != nil {
			rows.Close()
			return nil, err
		}
		if !known[a.ID] {
			continue // a sticker retired from the list
		}
		a.Date = a.UnlockedAt.In(s.loc).Format(time.DateOnly)
		out.Items = append(out.Items, a)
		if a.MediaID != nil {
			ids = append(ids, *a.MediaID)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, p := range next {
		out.Progress = append(out.Progress, AchievementProgress{ID: p.ID, Have: p.Have, Need: p.Need})
	}
	out.Secret = max(0, len(Rules)-len(out.Items)-len(out.Progress))
	media, err := s.catalog.SummariesByID(ctx, ids, lang)
	if err != nil {
		return nil, err
	}
	for i, a := range out.Items {
		if a.MediaID == nil {
			continue
		}
		if m, ok := media[*a.MediaID]; ok {
			title := m.Title
			out.Items[i].MediaTitle = &title
		}
	}
	return out, nil
}

func (s *Service) scanUnlocked(ctx context.Context, profileID string, f func(id string, at time.Time)) error {
	rows, err := s.pool.Query(ctx, `SELECT achievement_id, unlocked_at FROM profile_achievements WHERE profile_id = $1`, profileID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var at time.Time
		if err := rows.Scan(&id, &at); err != nil {
			return err
		}
		f(id, at)
	}
	return rows.Err()
}

// ---- HTTP ----

// Routes: GET /profiles/:id/tickets and /profiles/:id/achievements.
func (s *Service) Routes(r fiber.Router) {
	caller := profiles.RequireProfileCaller()
	r.Get("/profiles/:id/tickets", caller, s.handleTickets)
	r.Get("/profiles/:id/achievements", caller, s.handleAchievements)
}

// profileParam: the profile's own account (or a TV it is on), or an admin
// (a browser session or an admin-scoped token). Anyone else gets 404.
func (s *Service) profileParam(c fiber.Ctx) (string, error) {
	id, err := httpx.ParamUUID(c, "id")
	if err != nil {
		return "", err
	}
	p := auth.PrincipalFrom(c)
	ok, err := s.profiles.CanUse(c.Context(), p, id)
	if err != nil {
		return "", err
	}
	if !ok && p != nil && p.Kind != auth.KindDevice && p.HasScope(auth.ScopeAdmin) {
		if err := s.pool.QueryRow(c.Context(), `SELECT EXISTS (SELECT 1 FROM profiles WHERE id = $1)`, id).Scan(&ok); err != nil {
			return "", err
		}
	}
	if !ok {
		return "", httpx.NotFound()
	}
	return id, nil
}

func langParam(c fiber.Ctx) (string, error) {
	switch l := c.Query("lang"); l {
	case "", "en":
		return "en", nil
	case "ru":
		return "ru", nil
	}
	return "", httpx.Validation(map[string]string{"lang": "must be one of en, ru"})
}

func (s *Service) handleTickets(c fiber.Ctx) error {
	id, err := s.profileParam(c)
	if err != nil {
		return err
	}
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	limit := 24
	if v := c.Query("limit"); v != "" {
		if limit, err = strconv.Atoi(v); err != nil || limit < 1 || limit > 100 {
			return httpx.Validation(map[string]string{"limit": "must be an integer from 1 to 100"})
		}
	}
	cursor := 0
	if v := strings.TrimSpace(c.Query("cursor")); v != "" {
		if cursor, err = strconv.Atoi(v); err != nil || cursor < 1 {
			return httpx.Validation(map[string]string{"cursor": "must be a ticket number"})
		}
	}
	page, err := s.Tickets(c.Context(), id, cursor, limit, lang)
	if err != nil {
		return err
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(page)
}

func (s *Service) handleAchievements(c fiber.Ctx) error {
	id, err := s.profileParam(c)
	if err != nil {
		return err
	}
	lang, err := langParam(c)
	if err != nil {
		return err
	}
	out, err := s.Achievements(c.Context(), id, lang)
	if err != nil {
		return err
	}
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.JSON(out)
}
