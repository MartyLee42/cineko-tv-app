// Package family implements «Семья советует»: profiles that opted in to
// sharing («Делиться с семьёй», settings share_with_family, default off)
// expose their finished titles, ratings and favorites to every other
// profile on the server. Profiles that show the family (show_family,
// default on) get a ranked row of titles the family liked and they have
// not seen, each with who liked it and how, plus per-member taste match.
//
// Privacy: never in-progress positions, the watchlist, notes or the diary;
// nothing at all from a profile with sharing off. There is no admin
// override. Not to be confused with internal/reco (explicit «Посоветовать»)
// or internal/foryou (personal recommendations; it embeds this row).
package family

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"martytv/api/internal/catalog"
	"martytv/api/internal/profiles"
)

// DefaultLimit is the number of titles in the block.
const DefaultLimit = 20

// Person identifies a sharing profile.
type Person struct {
	ProfileID string `json:"profile_id"`
	Name      string `json:"name"`
	Avatar    string `json:"avatar"`
	Color     string `json:"color"`
	// UserName is the account's display name (profiles of different
	// accounts may share a name, e.g. «Мама»).
	UserName string `json:"user_name"`
}

// Member is a sharing profile with its taste match to the viewer.
type Member struct {
	Person
	// Match is «совпадение вкусов» in percent (0…100); nil when there is
	// nothing to compare yet.
	Match   *int `json:"match"`
	CoRated int  `json:"co_rated"`
}

// Endorsement is what one family member did with a title.
type Endorsement struct {
	Person
	Rating      *int       `json:"rating"`
	Completed   bool       `json:"completed"`
	CompletedAt *time.Time `json:"completed_at"`
	Favorite    bool       `json:"favorite"`
	// Liked: ★8+, a favorite, or finished recently without a low rating.
	Liked bool `json:"liked"`
}

// Why explains a suggested title.
type Why struct {
	People  []Endorsement `json:"people"`
	LikedBy int           `json:"liked_by"`
	Text    string        `json:"text"`
}

// Item is one suggested title.
type Item struct {
	Media catalog.MediaSummary `json:"media"`
	Why   Why                  `json:"why"`
	Score float64              `json:"score"`
}

// Block is GET /profiles/{id}/family.
type Block struct {
	ProfileID string `json:"profile_id"`
	// Enabled: the profile shows the family (show_family).
	Enabled bool `json:"enabled"`
	// Sharing: the profile itself shares (share_with_family).
	Sharing bool     `json:"sharing"`
	Members []Member `json:"members"`
	Items   []Item   `json:"items"`
}

// MediaFamily is GET /profiles/{id}/family/media/{mediaId}.
type MediaFamily struct {
	Enabled bool          `json:"enabled"`
	People  []Endorsement `json:"people"`
}

// Summaries is the catalog service.
type Summaries interface {
	SummariesByID(ctx context.Context, ids []string, lang string) (map[string]catalog.MediaSummary, error)
}

type Deps struct {
	Pool     *pgxpool.Pool
	Catalog  Summaries
	Personal catalog.Personalizer
	Profiles *profiles.Store
	Ratings  catalog.RatingsSource // optional
	Log      *slog.Logger
}

type Service struct {
	pool     *pgxpool.Pool
	cat      Summaries
	personal catalog.Personalizer
	profiles *profiles.Store
	ratings  catalog.RatingsSource
	log      *slog.Logger
	now      func() time.Time
}

func NewService(d Deps) *Service {
	log := d.Log
	if log == nil {
		log = slog.Default()
	}
	return &Service{pool: d.Pool, cat: d.Catalog, personal: d.Personal, profiles: d.Profiles, ratings: d.Ratings, log: log, now: time.Now}
}

// sharers lists the profiles (other than viewer) that share with the
// family, of enabled accounts.
func (s *Service) sharers(ctx context.Context, viewer string) ([]Person, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.name, p.avatar, p.color, COALESCE(NULLIF(u.display_name, ''), u.username)
		FROM profiles p
		JOIN profile_settings ps ON ps.profile_id = p.id
		JOIN users u ON u.id = p.user_id
		WHERE p.id <> $1 AND u.disabled_at IS NULL
		  AND ps.settings -> 'share_with_family' = 'true'::jsonb
		ORDER BY p.created_at`, viewer)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Person
	for rows.Next() {
		var p Person
		if err := rows.Scan(&p.ProfileID, &p.Name, &p.Avatar, &p.Color, &p.UserName); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// signals loads the shared signals of the given profiles, for all titles
// or (mediaID != "") one title. A series counts as finished when marked
// watched as a whole or after 3 completed episodes (as in For You).
// Started-but-unfinished titles without a rating or favorite are left out.
func (s *Service) signals(ctx context.Context, ids []string, mediaID string) (map[string]map[string]Signal, error) {
	out := map[string]map[string]Signal{}
	if len(ids) == 0 {
		return out, nil
	}
	var media any
	if mediaID != "" {
		media = mediaID
	}
	rows, err := s.pool.Query(ctx, `
		WITH r AS (SELECT profile_id, media_id, rating, updated_at FROM ratings
		           WHERE profile_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR media_id = $2)),
		p AS (SELECT profile_id, media_id,
		             bool_or(completed AND episode_id IS NULL) AS whole,
		             count(*) FILTER (WHERE completed AND episode_id IS NOT NULL)::int AS eps,
		             max(completed_at) FILTER (WHERE completed) AS done_at
		      FROM watch_progress WHERE profile_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR media_id = $2)
		      GROUP BY profile_id, media_id),
		f AS (SELECT profile_id, media_id, created_at FROM favorites
		      WHERE profile_id = ANY($1::uuid[]) AND ($2::uuid IS NULL OR media_id = $2)),
		k AS (SELECT profile_id, media_id FROM r UNION SELECT profile_id, media_id FROM p
		      UNION SELECT profile_id, media_id FROM f)
		SELECT k.profile_id, k.media_id, COALESCE(r.rating, 0)::int, r.updated_at,
		       COALESCE(p.whole, false), COALESCE(p.eps, 0), p.done_at, f.created_at
		FROM k
		LEFT JOIN r ON r.profile_id = k.profile_id AND r.media_id = k.media_id
		LEFT JOIN p ON p.profile_id = k.profile_id AND p.media_id = k.media_id
		LEFT JOIN f ON f.profile_id = k.profile_id AND f.media_id = k.media_id`, ids, media)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			pid, mid             string
			sg                   Signal
			ratedAt, doneAt, fav *time.Time
			whole                bool
			eps                  int
		)
		if err := rows.Scan(&pid, &mid, &sg.Rating, &ratedAt, &whole, &eps, &doneAt, &fav); err != nil {
			return nil, err
		}
		sg.Completed = whole || eps >= 3
		if ratedAt != nil {
			sg.RatedAt = *ratedAt
		}
		if sg.Completed && doneAt != nil {
			sg.CompletedAt = *doneAt
		}
		if fav != nil {
			sg.Favorite, sg.FavoriteAt = true, *fav
		}
		if sg.Rating == 0 && !sg.Completed && !sg.Favorite {
			continue // in progress only: never shared
		}
		if out[pid] == nil {
			out[pid] = map[string]Signal{}
		}
		out[pid][mid] = sg
	}
	return out, rows.Err()
}

// genres loads taste genre affinities (profile_taste) for profiles.
func (s *Service) genres(ctx context.Context, ids []string) (map[string]map[string]float64, error) {
	out := map[string]map[string]float64{}
	rows, err := s.pool.Query(ctx, `SELECT profile_id, COALESCE(data -> 'genres', '[]'::jsonb) FROM profile_taste WHERE profile_id = ANY($1::uuid[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var pid string
		var raw []byte
		if err := rows.Scan(&pid, &raw); err != nil {
			return nil, err
		}
		var list []struct {
			K string  `json:"k"`
			S float64 `json:"s"`
		}
		if json.Unmarshal(raw, &list) != nil {
			continue
		}
		m := make(map[string]float64, len(list))
		for _, a := range list {
			m[a.K] = a.S
		}
		out[pid] = m
	}
	return out, rows.Err()
}

// viewer loads what the viewer rated and what to exclude.
func (s *Service) viewer(ctx context.Context, pid string) (Viewer, error) {
	v := Viewer{Ratings: map[string]int{}, Excluded: map[string]bool{}}
	rows, err := s.pool.Query(ctx, `
		SELECT media_id, rating::int FROM ratings WHERE profile_id = $1
		UNION ALL SELECT DISTINCT media_id, 0 FROM watch_progress WHERE profile_id = $1
		UNION ALL SELECT media_id, 0 FROM foryou_dismissals WHERE profile_id = $1`, pid)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var r int
		if err := rows.Scan(&id, &r); err != nil {
			return v, err
		}
		v.Excluded[id] = true
		if r > 0 {
			v.Ratings[id] = r
		}
	}
	return v, rows.Err()
}

// anime returns the ids among ids that are Japanese animation.
func (s *Service) anime(ctx context.Context, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT m.id FROM media m WHERE m.id = ANY($1::uuid[]) AND m.original_language = 'ja'
		  AND EXISTS (SELECT 1 FROM media_genres g WHERE g.media_id = m.id AND g.genre_id = $2)`, ids, catalog.GenreAnimation)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// Block computes the family block for a profile (already access-checked).
func (s *Service) Block(ctx context.Context, profileID, lang string, limit int) (*Block, error) {
	st, err := s.profiles.GetSettings(ctx, profileID)
	if err != nil {
		return nil, err
	}
	b := &Block{ProfileID: profileID, Enabled: *st.ShowFamily, Sharing: *st.ShareWithFamily, Members: []Member{}, Items: []Item{}}
	if !b.Enabled {
		return b, nil
	}
	people, err := s.sharers(ctx, profileID)
	if err != nil || len(people) == 0 {
		return b, err
	}
	ids := make([]string, len(people))
	for i, p := range people {
		ids[i] = p.ProfileID
	}
	sig, err := s.signals(ctx, ids, "")
	if err != nil {
		return nil, err
	}
	v, err := s.viewer(ctx, profileID)
	if err != nil {
		return nil, err
	}
	tastes, err := s.genres(ctx, append([]string{profileID}, ids...))
	if err != nil {
		return nil, err
	}
	v.Genres = tastes[profileID]
	sharers := make([]Sharer, len(people))
	var candidates []string
	seen := map[string]bool{}
	for i, p := range people {
		sharers[i] = Sharer{Person: p, Signals: sig[p.ProfileID], Genres: tastes[p.ProfileID]}
		for id := range sig[p.ProfileID] {
			if !seen[id] && !v.Excluded[id] {
				seen[id] = true
				candidates = append(candidates, id)
			}
		}
	}
	if *st.HideAnime {
		hidden, err := s.anime(ctx, candidates)
		if err != nil {
			return nil, err
		}
		for id := range hidden {
			v.Excluded[id] = true
		}
	}
	if limit <= 0 {
		limit = DefaultLimit
	}
	members, ranked := Rank(v, sharers, s.now(), limit)
	b.Members = members
	if len(ranked) == 0 {
		return b, nil
	}
	mids := make([]string, len(ranked))
	for i, r := range ranked {
		mids[i] = r.MediaID
	}
	sums, err := s.cat.SummariesByID(ctx, mids, lang)
	if err != nil {
		return nil, err
	}
	s.annotateRatings(ctx, sums)
	states, err := s.personal.UserStates(ctx, profileID, mids)
	if err != nil {
		return nil, err
	}
	now := s.now()
	for _, r := range ranked {
		m, ok := sums[r.MediaID]
		if !ok {
			continue
		}
		st := states[r.MediaID]
		m.Me = &st
		b.Items = append(b.Items, Item{Media: m, Score: r.Score,
			Why: Why{People: r.People, LikedBy: r.LikedBy, Text: WhyText(lang, r.People, now)}})
	}
	return b, nil
}

// ForMedia lists what sharing family members did with one title.
func (s *Service) ForMedia(ctx context.Context, profileID, mediaID string) (*MediaFamily, error) {
	st, err := s.profiles.GetSettings(ctx, profileID)
	if err != nil {
		return nil, err
	}
	out := &MediaFamily{Enabled: *st.ShowFamily, People: []Endorsement{}}
	if !out.Enabled {
		return out, nil
	}
	people, err := s.sharers(ctx, profileID)
	if err != nil || len(people) == 0 {
		return out, err
	}
	ids := make([]string, len(people))
	for i, p := range people {
		ids[i] = p.ProfileID
	}
	sig, err := s.signals(ctx, ids, mediaID)
	if err != nil {
		return nil, err
	}
	now := s.now()
	var liked, other []Endorsement
	for _, p := range people {
		sg, ok := sig[p.ProfileID][mediaID]
		if !ok {
			continue
		}
		_, endorse := contribution(sg, now)
		e := endorsementOf(p, sg, endorse)
		if endorse {
			liked = append(liked, e)
		} else {
			other = append(other, e)
		}
	}
	out.People = append(append(out.People, liked...), other...)
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
		s.log.WarnContext(ctx, "family: ratings lookup failed", "err", err)
		return
	}
	for id, m := range sums {
		if r, ok := rs[id]; ok {
			m.KPRating, m.IMDbRating, m.AwardBadge = r.KP, r.IMDb, r.Award
			sums[id] = m
		}
	}
}

// WhyText is the server-side «why» line, e.g. "Анна ★9 · Олег:
// посмотрено вчера" (clients may build their own from the typed fields).
func WhyText(lang string, people []Endorsement, now time.Time) string {
	parts := make([]string, 0, 3)
	for _, p := range people {
		if len(parts) == 3 {
			break
		}
		switch {
		case p.Rating != nil:
			parts = append(parts, fmt.Sprintf("%s ★%d", p.Name, *p.Rating))
		case p.Completed:
			parts = append(parts, p.Name+": "+ago(lang, p.CompletedAt, now))
		case p.Favorite:
			parts = append(parts, p.Name+" ♥")
		}
	}
	return strings.Join(parts, " · ")
}

func ago(lang string, t *time.Time, now time.Time) string {
	ru := lang == "ru"
	if t == nil {
		if ru {
			return "посмотрено"
		}
		return "watched"
	}
	d := int(now.Sub(*t).Hours() / 24)
	switch {
	case d <= 0 && ru:
		return "посмотрено сегодня"
	case d <= 0:
		return "watched today"
	case d == 1 && ru:
		return "посмотрено вчера"
	case d == 1:
		return "watched yesterday"
	case d < 30 && ru:
		return fmt.Sprintf("посмотрено %d дн. назад", d)
	case d < 30:
		return fmt.Sprintf("watched %d days ago", d)
	case ru:
		return "посмотрено"
	}
	return "watched"
}
